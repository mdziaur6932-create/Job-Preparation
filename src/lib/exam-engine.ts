import type {
  Exam,
  ExamAnswerDraft,
  ExamAttempt,
  MistakeItem,
  Question,
  QuestionEvaluation,
} from '../types/system';

export interface WrittenGradeOverride {
  questionId: number;
  awardedMarks: number;
  mistakeExplanation: string;
  improvementTip: string;
  modelAnswer?: string;
}

export interface ScoredExamResult {
  totalMarks: number;
  obtainedMarks: number;
  negativeDeduction: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  mcqAccuracy: number;
  writtenScore: number;
  evaluations: QuestionEvaluation[];
  weakTopics: string[];
}

export interface SubjectPerformance {
  subject: string;
  attempts: number;
  avgScorePercent: number;
  mcqAccuracy: number;
  totalQuestions: number;
}

export interface ChapterStrength {
  chapter: string;
  subject: string;
  accuracyPercent: number;
  totalAnswered: number;
  status: 'strong' | 'moderate' | 'weak';
}

export interface PerformanceAnalytics {
  totalExams: number;
  averagePercentage: number;
  overallMcqAccuracy: number;
  overallWrittenAverage: number;
  avgSecondsPerQuestion: number;
  subjectBreakdown: SubjectPerformance[];
  weakChapters: ChapterStrength[];
  strongChapters: ChapterStrength[];
}

export interface PreviousYearPattern {
  subject: string;
  chapter: string;
  frequency: number;
  avgImportance: number;
  years: string[];
  questionTypes: Record<string, number>;
}

/**
 * Deterministic scoring engine for MCQ, Short, and Written exams with exact negative marking.
 * Negative marking applies ONLY to wrong MCQ answers, never to skipped questions or Written questions.
 */
export function scoreExamAttempt(
  exam: Pick<Exam, 'marksPerQuestion' | 'negativeMark'>,
  examQuestions: Question[],
  answers: Record<string, ExamAnswerDraft>,
  writtenOverrides: WrittenGradeOverride[] = []
): ScoredExamResult {
  const overrideMap = new Map<number, WrittenGradeOverride>();
  for (const ov of writtenOverrides) {
    overrideMap.set(ov.questionId, ov);
  }

  let totalMarks = 0;
  let obtainedMarks = 0;
  let negativeDeduction = 0;
  let correctCount = 0;
  let wrongCount = 0;
  let skippedCount = 0;
  let mcqAttempted = 0;
  let mcqCorrect = 0;
  let writtenMaxTotal = 0;
  let writtenObtainedTotal = 0;

  const evaluations: QuestionEvaluation[] = [];
  const chapterErrorCount = new Map<string, number>();

  for (const q of examQuestions) {
    const draft = answers[String(q.id)] ?? {};
    const isMcq = q.questionType === 'MCQ';
    const maxMarks = isMcq
      ? exam.marksPerQuestion
      : q.questionType === 'Short'
        ? Math.max(2, exam.marksPerQuestion * 2)
        : Math.max(5, exam.marksPerQuestion * 5);

    totalMarks += maxMarks;

    if (isMcq) {
      const selected = draft.selectedOption;
      const correctIdx = q.correctOptionIndex ?? 0;
      const correctText = q.options[correctIdx] ?? q.modelAnswer;

      if (selected === undefined || selected === null) {
        skippedCount += 1;
        evaluations.push({
          questionId: q.id,
          questionType: q.questionType,
          stem: q.stem,
          subject: q.subject,
          chapter: q.chapter,
          bookTitle: q.bookTitle,
          pageNumber: q.pageNumber,
          maxMarks,
          awardedMarks: 0,
          negativeApplied: 0,
          status: 'skipped',
          userAnswer: 'উত্তর দেওয়া হয়নি',
          correctAnswer: correctText,
          modelAnswer: q.explanation || correctText,
          mistakeExplanation: 'প্রশ্নটি অনুত্তরিত রাখা হয়েছে।',
          improvementTip: `${q.chapter} অধ্যায়টি পুনরাবৃত্তি করুন (${q.bookTitle}, পৃষ্ঠা ${q.pageNumber})।`,
        });
        continue;
      }

      mcqAttempted += 1;
      const userAnswerText = q.options[selected] ?? `বিকল্প ${selected + 1}`;

      if (selected === correctIdx) {
        correctCount += 1;
        mcqCorrect += 1;
        obtainedMarks += maxMarks;
        evaluations.push({
          questionId: q.id,
          questionType: q.questionType,
          stem: q.stem,
          subject: q.subject,
          chapter: q.chapter,
          bookTitle: q.bookTitle,
          pageNumber: q.pageNumber,
          maxMarks,
          awardedMarks: maxMarks,
          negativeApplied: 0,
          status: 'correct',
          userAnswer: userAnswerText,
          correctAnswer: correctText,
          modelAnswer: q.explanation || correctText,
          mistakeExplanation: 'সঠিক উত্তর প্রদান করা হয়েছে।',
          improvementTip: 'এই অধ্যায়ে আপনার ধারণা স্পষ্ট রয়েছে।',
        });
      } else {
        wrongCount += 1;
        const penalty = Math.max(0, exam.negativeMark);
        negativeDeduction += penalty;
        obtainedMarks -= penalty;
        chapterErrorCount.set(
          q.chapter,
          (chapterErrorCount.get(q.chapter) ?? 0) + 1
        );
        evaluations.push({
          questionId: q.id,
          questionType: q.questionType,
          stem: q.stem,
          subject: q.subject,
          chapter: q.chapter,
          bookTitle: q.bookTitle,
          pageNumber: q.pageNumber,
          maxMarks,
          awardedMarks: -penalty,
          negativeApplied: penalty,
          status: 'wrong',
          userAnswer: userAnswerText,
          correctAnswer: correctText,
          modelAnswer: q.explanation || correctText,
          mistakeExplanation: `আপনি "${userAnswerText}" নির্বাচন করেছেন, কিন্তু সঠিক উত্তর "${correctText}"। নেগেটিভ মার্কিং বাবদ -${penalty} কাটা হয়েছে।`,
          improvementTip: `${q.bookTitle} (পৃষ্ঠা ${q.pageNumber})-এর "${q.chapter}" অংশটি আবার পড়ুন।`,
        });
      }
    } else {
      writtenMaxTotal += maxMarks;
      const text = (draft.writtenText ?? '').trim();
      const override = overrideMap.get(q.id);

      if (!text) {
        skippedCount += 1;
        chapterErrorCount.set(
          q.chapter,
          (chapterErrorCount.get(q.chapter) ?? 0) + 1
        );
        evaluations.push({
          questionId: q.id,
          questionType: q.questionType,
          stem: q.stem,
          subject: q.subject,
          chapter: q.chapter,
          bookTitle: q.bookTitle,
          pageNumber: q.pageNumber,
          maxMarks,
          awardedMarks: 0,
          negativeApplied: 0,
          status: 'skipped',
          userAnswer: 'লিখিত উত্তর জমা দেওয়া হয়নি',
          correctAnswer: q.modelAnswer,
          modelAnswer: q.modelAnswer,
          mistakeExplanation: 'লিখিত প্রশ্নের উত্তর ফাঁকা রাখা হয়েছে।',
          improvementTip: 'মডেল উত্তরের মূল পয়েন্টগুলো মুখস্থ না করে কাঠামোবদ্ধভাবে লেখার অনুশীলন করুন।',
        });
        continue;
      }

      let awarded = 0;
      let mistakeExplanation = '';
      let improvementTip = '';

      if (override) {
        awarded = Math.max(0, Math.min(maxMarks, Number(override.awardedMarks.toFixed(2))));
        mistakeExplanation = override.mistakeExplanation;
        improvementTip = override.improvementTip;
      } else {
        // Fallback deterministic lexical overlap estimate when AI override is not supplied
        const modelWords = new Set(
          q.modelAnswer
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length >= 3)
        );
        const answerWords = new Set(
          text
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length >= 3)
        );
        let overlap = 0;
        for (const w of answerWords) {
          if (modelWords.has(w)) overlap += 1;
        }
        const ratio =
          modelWords.size > 0
            ? Math.min(1, overlap / Math.max(4, modelWords.size * 0.35))
            : text.length >= 40
              ? 0.65
              : 0.35;
        awarded = Number((maxMarks * Math.max(0.2, ratio)).toFixed(1));
        mistakeExplanation =
          awarded >= maxMarks * 0.7
            ? 'উত্তরে মূল তথ্যগুলো এসেছে, তবে আরও সুনির্দিষ্ট ধারা ও তারিখ যুক্ত করলে পূর্ণ নম্বর পাওয়া যাবে।'
            : 'উত্তরে গুরুত্বপূর্ণ তথ্য ও উদাহরণের ঘাটতি রয়েছে। মডেল উত্তরের সাথে মিলিয়ে দেখুন।';
        improvementTip = `পয়েন্ট আকারে মূল সংজ্ঞা, সাল ও রেফারেন্স যুক্ত করুন (${q.bookTitle}, পৃষ্ঠা ${q.pageNumber})।`;
      }

      obtainedMarks += awarded;
      writtenObtainedTotal += awarded;
      const ratio = maxMarks > 0 ? awarded / maxMarks : 0;

      if (ratio >= 0.75) {
        correctCount += 1;
      } else {
        wrongCount += 1;
        chapterErrorCount.set(
          q.chapter,
          (chapterErrorCount.get(q.chapter) ?? 0) + 1
        );
      }

      evaluations.push({
        questionId: q.id,
        questionType: q.questionType,
        stem: q.stem,
        subject: q.subject,
        chapter: q.chapter,
        bookTitle: q.bookTitle,
        pageNumber: q.pageNumber,
        maxMarks,
        awardedMarks: awarded,
        negativeApplied: 0,
        status: ratio >= 0.75 ? 'correct' : ratio >= 0.4 ? 'partial' : 'wrong',
        userAnswer: text,
        correctAnswer: override?.modelAnswer || q.modelAnswer,
        modelAnswer: override?.modelAnswer || q.modelAnswer,
        mistakeExplanation,
        improvementTip,
      });
    }
  }

  const weakTopics = Array.from(chapterErrorCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([chapter]) => chapter);

  const mcqAccuracy =
    mcqAttempted > 0 ? Number(((mcqCorrect / mcqAttempted) * 100).toFixed(1)) : 0;
  const writtenScore =
    writtenMaxTotal > 0
      ? Number(((writtenObtainedTotal / writtenMaxTotal) * 100).toFixed(1))
      : 0;

  return {
    totalMarks: Number(totalMarks.toFixed(2)),
    obtainedMarks: Number(obtainedMarks.toFixed(2)),
    negativeDeduction: Number(negativeDeduction.toFixed(2)),
    correctCount,
    wrongCount,
    skippedCount,
    mcqAccuracy,
    writtenScore,
    evaluations,
    weakTopics,
  };
}

/**
 * Extracts Mistake Notebook entries from wrong/low-scoring exam evaluations.
 */
export function extractMistakesFromAttempt(
  attempt: Pick<ExamAttempt, 'id' | 'evaluations'>,
  startId: number,
  todayIso: string
): MistakeItem[] {
  const nextDate = new Date(todayIso);
  nextDate.setDate(nextDate.getDate() + 2);
  const nextReviewDate = nextDate.toISOString().slice(0, 10);

  let nextId = startId;
  return attempt.evaluations
    .filter((ev) => ev.status === 'wrong' || ev.status === 'partial')
    .map((ev) => ({
      id: nextId++,
      questionId: ev.questionId,
      attemptId: attempt.id,
      questionStem: ev.stem,
      subject: ev.subject,
      chapter: ev.chapter,
      userAnswer: ev.userAnswer,
      correctAnswer: ev.correctAnswer,
      reason: ev.mistakeExplanation,
      mastered: false,
      reviewCount: 0,
      nextReviewDate,
      createdAt: todayIso,
    }));
}

/**
 * Aggregates all exam attempts into actionable Performance Dashboard metrics.
 */
export function computePerformanceAnalytics(
  attempts: ExamAttempt[]
): PerformanceAnalytics {
  if (attempts.length === 0) {
    return {
      totalExams: 0,
      averagePercentage: 0,
      overallMcqAccuracy: 0,
      overallWrittenAverage: 0,
      avgSecondsPerQuestion: 0,
      subjectBreakdown: [],
      weakChapters: [],
      strongChapters: [],
    };
  }

  let pctSum = 0;
  let mcqAccSum = 0;
  let mcqExams = 0;
  let writtenSum = 0;
  let writtenExams = 0;
  let totalDurationSec = 0;
  let totalQuestions = 0;

  const subjectMap = new Map<
    string,
    { attempts: number; pctSum: number; mcqSum: number; questions: number }
  >();
  const chapterMap = new Map<
    string,
    { subject: string; total: number; scoreSum: number }
  >();

  for (const att of attempts) {
    const pct =
      att.totalMarks > 0
        ? Math.max(0, (att.obtainedMarks / att.totalMarks) * 100)
        : 0;
    pctSum += pct;
    if (att.mcqAccuracy > 0 || att.evaluations.some((e) => e.questionType === 'MCQ')) {
      mcqAccSum += att.mcqAccuracy;
      mcqExams += 1;
    }
    if (
      att.writtenScore > 0 ||
      att.evaluations.some((e) => e.questionType !== 'MCQ')
    ) {
      writtenSum += att.writtenScore;
      writtenExams += 1;
    }

    totalDurationSec += att.durationSeconds;
    totalQuestions += Math.max(1, att.evaluations.length);

    const subjEntry = subjectMap.get(att.subject) ?? {
      attempts: 0,
      pctSum: 0,
      mcqSum: 0,
      questions: 0,
    };
    subjEntry.attempts += 1;
    subjEntry.pctSum += pct;
    subjEntry.mcqSum += att.mcqAccuracy;
    subjEntry.questions += att.evaluations.length;
    subjectMap.set(att.subject, subjEntry);

    for (const ev of att.evaluations) {
      const key = `${ev.subject}::${ev.chapter}`;
      const ch = chapterMap.get(key) ?? {
        subject: ev.subject,
        total: 0,
        scoreSum: 0,
      };
      ch.total += 1;
      ch.scoreSum +=
        ev.maxMarks > 0
          ? Math.max(0, Math.min(1, ev.awardedMarks / ev.maxMarks))
          : 0;
      chapterMap.set(key, ch);
    }
  }

  const subjectBreakdown: SubjectPerformance[] = Array.from(
    subjectMap.entries()
  )
    .map(([subject, data]) => ({
      subject,
      attempts: data.attempts,
      avgScorePercent: Number((data.pctSum / data.attempts).toFixed(1)),
      mcqAccuracy: Number((data.mcqSum / data.attempts).toFixed(1)),
      totalQuestions: data.questions,
    }))
    .sort((a, b) => b.avgScorePercent - a.avgScorePercent);

  const chapterStats: ChapterStrength[] = Array.from(chapterMap.entries()).map(
    ([key, data]) => {
      const chapter = key.split('::')[1] ?? key;
      const accuracyPercent = Number(
        ((data.scoreSum / Math.max(1, data.total)) * 100).toFixed(1)
      );
      return {
        chapter,
        subject: data.subject,
        accuracyPercent,
        totalAnswered: data.total,
        status:
          accuracyPercent >= 75
            ? 'strong'
            : accuracyPercent >= 50
              ? 'moderate'
              : 'weak',
      };
    }
  );

  const weakChapters = chapterStats
    .filter((c) => c.accuracyPercent < 70)
    .sort((a, b) => a.accuracyPercent - b.accuracyPercent)
    .slice(0, 6);

  const strongChapters = chapterStats
    .filter((c) => c.accuracyPercent >= 70)
    .sort((a, b) => b.accuracyPercent - a.accuracyPercent)
    .slice(0, 6);

  return {
    totalExams: attempts.length,
    averagePercentage: Number((pctSum / attempts.length).toFixed(1)),
    overallMcqAccuracy:
      mcqExams > 0 ? Number((mcqAccSum / mcqExams).toFixed(1)) : 0,
    overallWrittenAverage:
      writtenExams > 0 ? Number((writtenSum / writtenExams).toFixed(1)) : 0,
    avgSecondsPerQuestion:
      totalQuestions > 0 ? Math.round(totalDurationSec / totalQuestions) : 0,
    subjectBreakdown,
    weakChapters,
    strongChapters,
  };
}

/**
 * Analyzes Previous Year Question frequency and repeat patterns by chapter and subject.
 */
export function analyzePreviousYearPatterns(
  allQuestions: Question[]
): PreviousYearPattern[] {
  const pyq = allQuestions.filter((q) => q.isPreviousYear);
  const grouped = new Map<
    string,
    {
      subject: string;
      chapter: string;
      frequency: number;
      importanceSum: number;
      years: Set<string>;
      questionTypes: Record<string, number>;
    }
  >();

  for (const q of pyq) {
    const key = `${q.subject}::${q.chapter}`;
    const entry = grouped.get(key) ?? {
      subject: q.subject,
      chapter: q.chapter,
      frequency: 0,
      importanceSum: 0,
      years: new Set<string>(),
      questionTypes: {},
    };
    entry.frequency += 1;
    entry.importanceSum += q.importanceScore;
    if (q.examYear) entry.years.add(q.examYear);
    entry.questionTypes[q.questionType] =
      (entry.questionTypes[q.questionType] ?? 0) + 1;
    grouped.set(key, entry);
  }

  return Array.from(grouped.values())
    .map((g) => ({
      subject: g.subject,
      chapter: g.chapter,
      frequency: g.frequency,
      avgImportance: Math.round(g.importanceSum / g.frequency),
      years: Array.from(g.years).sort().reverse(),
      questionTypes: g.questionTypes,
    }))
    .sort((a, b) => b.frequency - a.frequency || b.avgImportance - a.avgImportance);
}
