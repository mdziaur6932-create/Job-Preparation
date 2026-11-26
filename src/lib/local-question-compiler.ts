import type {
  Book,
  DifficultyLevel,
  CurrentGkItem,
  Question,
  QuestionType,
} from '../types/system';
import {
  analyzeBookOrSeriesQuestions,
  type AnalyzedQuestionItem,
} from './book-series-and-topic-analyzer';
import {
  allocateQuestionsByPercentage,
  encodeExplanationWithSource,
  type DemoTopicWeight,
} from './demo-paper-blueprint';
import {
  orderQuestionsForExam,
  type QuestionOrderingMode,
} from './job-exam-paper';
import { classifyQuestionSyllabusTopic } from './syllabus-topic-tagger';

export type CompiledQuestionDraft = Omit<Question, 'id' | 'createdAt'>;

export interface CompiledQuestionSet {
  setNumber: number;
  questions: CompiledQuestionDraft[];
}

export interface LocalCompileExamOptions {
  books: Book[];
  gkItems?: CurrentGkItem[];
  includeCurrentGk?: boolean;
  questionMode: 'Mixed' | QuestionType;
  mcqCount: number;
  writtenCount: number;
  setCount: number;
  difficulty: DifficultyLevel;
  subject: string;
  jobExamPreset?: string;
  topicDistribution?: DemoTopicWeight[];
  focusTopics?: string[];
  existingStems?: string[];
  orderingMode?: QuestionOrderingMode;
}

export interface LocalCompileExamResult {
  sets: CompiledQuestionSet[];
  totalPoolMcq: number;
  totalPoolWritten: number;
  totalCompiledQuestions: number;
  unfulfilledCount: number;
}

const OPTION_MARKER_INDEX: Record<string, number> = {
  ক: 0,
  খ: 1,
  গ: 2,
  ঘ: 3,
  a: 0,
  b: 1,
  c: 2,
  d: 3,
  '1': 0,
  '2': 1,
  '3': 2,
  '4': 3,
  '১': 0,
  '২': 1,
  '৩': 2,
  '৪': 3,
};

function normalizeKey(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function clamp(text: string, maxLen: number): string {
  const cleaned = (text || '').trim();
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen).trim();
}

/**
 * Resolves the 0-based MCQ correct option index from parsed Bengali/English
 * answer keys such as "ক", "উ. খ", "উত্তর: গ", "ans. B", "b) সফট লোন", or full option text.
 */
export function resolveMcqCorrectIndex(
  answerText: string,
  options: Array<{ marker: string; text: string }>
): number {
  const raw = (answerText || '').trim();
  if (!raw || options.length === 0) return 0;

  // 1. Strip leading answer prefixes ("উ.", "উত্তর:", "ans.", "Answer:")
  const stripped = raw
    .replace(/^(?:সঠিক\s*উত্তর|উত্তর|উ|answer|ans)\s*[.:ঃ\-–—]*\s*/i, '')
    .trim();

  // 2. Match leading single letter/marker ("ক", "খ.", "B)", "c")
  const markerMatch = stripped.match(/^([কখগঘa-dA-D১-৪1-4])(?:[\s.)ঃ:\-]|$)/);
  if (markerMatch) {
    const token = markerMatch[1].toLowerCase();
    // Try matching option.marker first if present
    const byMarker = options.findIndex(
      (opt) => opt.marker.trim().toLowerCase().replace(/[.)ঃ:\s]/g, '') === token
    );
    if (byMarker >= 0) return byMarker;
    const mapped = OPTION_MARKER_INDEX[token];
    if (typeof mapped === 'number' && mapped < options.length) {
      return mapped;
    }
  }

  // 3. Match option text directly (exact or substring)
  const normAns = normalizeKey(stripped);
  if (normAns.length >= 2) {
    const exactIdx = options.findIndex(
      (opt) => normalizeKey(opt.text) === normAns
    );
    if (exactIdx >= 0) return exactIdx;

    const partialIdx = options.findIndex((opt) => {
      const normOpt = normalizeKey(opt.text);
      return (
        normOpt.length >= 2 &&
        (normAns.includes(normOpt) || normOpt.includes(normAns))
      );
    });
    if (partialIdx >= 0) return partialIdx;
  }

  return 0;
}

interface CandidateEntry {
  draft: CompiledQuestionDraft;
  canonicalTopicLabel: string;
  subjectGroup: string;
  normStem: string;
  importanceScore: number;
  hasExplicitAnswer: boolean;
  hasBookExplanation: boolean;
}

function buildCandidatesFromBooks(
  books: Book[],
  difficulty: DifficultyLevel,
  subjectFallback: string,
  jobExamPreset: string | undefined
): { mcqPool: CandidateEntry[]; writtenPool: CandidateEntry[] } {
  const report = analyzeBookOrSeriesQuestions(books);

  // Compute repeat bonus per canonical stem so frequently repeated exam questions rank higher
  const repeatBoostByStem = new Map<string, number>();
  for (const grp of report.repeatedQuestions) {
    const key = normalizeKey(grp.canonicalQuestion);
    if (key) {
      repeatBoostByStem.set(key, Math.min(99, grp.importanceScore));
    }
  }

  const seenStems = new Set<string>();
  const mcqPool: CandidateEntry[] = [];
  const writtenPool: CandidateEntry[] = [];

  for (const item of report.questions) {
    const stem = clamp(item.questionText, 3800);
    if (stem.length < 6) continue;

    const normStem = normalizeKey(stem);
    if (!normStem || seenStems.has(normStem)) continue;

    const canonicalTopic = classifyQuestionSyllabusTopic(stem, {
      chapter: item.topic,
      subject: item.subjectGroup || subjectFallback,
    });

    const repeatScore = repeatBoostByStem.get(normStem);
    const hasExplicitAnswer = Boolean(item.answerText?.trim());
    const hasBookExplanation = Boolean(
      item.explanation?.trim() || item.solutionSteps.length > 0
    );

    const importanceScore =
      repeatScore ??
      Math.min(
        96,
        74 + (hasExplicitAnswer ? 8 : 0) + (hasBookExplanation ? 8 : 0)
      );

    const chapterLabel = clamp(
      item.topic &&
        item.topic.toLowerCase().includes(canonicalTopic.label.toLowerCase())
        ? item.topic
        : `${canonicalTopic.label} · ${item.examTitle || item.topic || 'অধ্যায় ১'}`,
      235
    );

    const explanationRaw =
      item.explanation?.trim() ||
      (item.solutionSteps.length > 0
        ? item.solutionSteps.join('\n')
        : `মূল বই: ${item.bookTitle} (${item.examTitle || 'প্রশ্নপত্র'}, পৃষ্ঠা ${item.pageLabel}) থেকে সংকলিত।`);

    const encodedExplanation = encodeExplanationWithSource(
      explanationRaw,
      'book',
      7500
    );

    const formattedExamAndPost =
      item.institution && item.postName
        ? `${item.institution} — ${item.postName}`
        : item.examTitle || item.institution || jobExamPreset || item.bookTitle;

    const examSource = clamp(formattedExamAndPost, 155);

    if (item.format === 'MCQ') {
      const cleanOptions = item.options
        .map((o) => ({
          marker: o.marker,
          text: clamp(o.text, 300),
        }))
        .filter((o) => o.text.length > 0);

      // Accept validated MCQ items with 2–4 clean options (classifyQuestionFormat already verified MCQ)
      if (cleanOptions.length < 2) continue;

      const paddedOptions = cleanOptions.slice(0, 4);
      const correctIdx = resolveMcqCorrectIndex(item.answerText, paddedOptions);
      const optionTexts = paddedOptions.map((o) => o.text);
      const modelAnswer = clamp(
        optionTexts[correctIdx] || item.answerText || optionTexts[0] || '',
        7500
      );

      seenStems.add(normStem);
      mcqPool.push({
        draft: {
          bookId: item.bookId,
          bookTitle: clamp(item.bookTitle, 235),
          chapter: chapterLabel,
          pageNumber: Math.max(1, item.pageNumber || 1),
          subject: clamp(item.subjectGroup || subjectFallback, 150),
          questionType: 'MCQ',
          difficulty,
          stem,
          options: optionTexts,
          correctOptionIndex: correctIdx,
          modelAnswer,
          explanation: encodedExplanation,
          isPreviousYear: true,
          examYear: null,
          examSource,
          importanceScore,
        },
        canonicalTopicLabel: canonicalTopic.label,
        subjectGroup: canonicalTopic.subjectGroup,
        normStem,
        importanceScore,
        hasExplicitAnswer,
        hasBookExplanation,
      });
    } else {
      const modelAnswer = clamp(
        item.answerText?.trim() ||
          item.solutionSteps.join('\n') ||
          item.explanation?.trim() ||
          'নির্বাচিত উৎস বইয়ের সংশ্লিষ্ট অধ্যায় ও ব্যাখ্যা অনুসরণ করুন।',
        7500
      );

      seenStems.add(normStem);
      writtenPool.push({
        draft: {
          bookId: item.bookId,
          bookTitle: clamp(item.bookTitle, 235),
          chapter: chapterLabel,
          pageNumber: Math.max(1, item.pageNumber || 1),
          subject: clamp(item.subjectGroup || subjectFallback, 150),
          questionType: 'Written',
          difficulty,
          stem,
          options: [],
          correctOptionIndex: null,
          modelAnswer,
          explanation: encodedExplanation,
          isPreviousYear: true,
          examYear: null,
          examSource,
          importanceScore,
        },
        canonicalTopicLabel: canonicalTopic.label,
        subjectGroup: canonicalTopic.subjectGroup,
        normStem,
        importanceScore,
        hasExplicitAnswer,
        hasBookExplanation,
      });
    }
  }

  // Sort pools: prioritize questions that have explicit answers, book explanations, and higher importance
  const rankCandidates = (a: CandidateEntry, b: CandidateEntry) => {
    const scoreA =
      a.importanceScore +
      (a.hasExplicitAnswer ? 12 : 0) +
      (a.hasBookExplanation ? 6 : 0);
    const scoreB =
      b.importanceScore +
      (b.hasExplicitAnswer ? 12 : 0) +
      (b.hasBookExplanation ? 6 : 0);
    return scoreB - scoreA;
  };

  mcqPool.sort(rankCandidates);
  writtenPool.sort(rankCandidates);

  return { mcqPool, writtenPool };
}

function buildGkWrittenCandidates(
  gkItems: CurrentGkItem[],
  difficulty: DifficultyLevel
): CandidateEntry[] {
  const active = gkItems.filter((g) => !g.isArchived);
  return active.map((item) => {
    const stem = clamp(
      `${item.title} — সাম্প্রতিক প্রেক্ষাপট ও চাকরির পরীক্ষার গুরুত্বপূর্ণ তথ্য সংক্ষেপে লিখুন।`,
      3800
    );
    const topic = classifyQuestionSyllabusTopic(
      `${item.title} ${item.summary}`,
      { subject: item.category }
    );
    return {
      draft: {
        bookId: 0,
        bookTitle: `Current GK · ${item.source || 'সাম্প্রতিক তথ্য'}`,
        chapter: `${topic.label} · সাম্প্রতিক (${item.eventDate || 'নতুন'})`,
        pageNumber: 1,
        subject: 'সাধারণ জ্ঞান ও সাম্প্রতিক',
        questionType: 'Short',
        difficulty,
        stem,
        options: [],
        correctOptionIndex: null,
        modelAnswer: clamp(item.summary || item.title, 7500),
        explanation: encodeExplanationWithSource(
          `উৎস: ${item.source || 'Current GK'} (${item.eventDate || 'সাম্প্রতিক'})। ${item.summary}`,
          'book',
          7500
        ),
        isPreviousYear: false,
        examYear: null,
        examSource: 'Current GK',
        importanceScore: 86,
      },
      canonicalTopicLabel: topic.label,
      subjectGroup: topic.subjectGroup,
      normStem: normalizeKey(stem),
      importanceScore: 86,
      hasExplicitAnswer: true,
      hasBookExplanation: true,
    };
  });
}

function selectFromPoolForSet(params: {
  pool: CandidateEntry[];
  count: number;
  usedStems: Set<string>;
  topicDistribution?: DemoTopicWeight[];
  focusTopics?: string[];
  setIndex: number;
}): CompiledQuestionDraft[] {
  const { pool, count, usedStems, topicDistribution, focusTopics, setIndex } =
    params;
  if (count <= 0 || pool.length === 0) return [];

  const chosen: CandidateEntry[] = [];
  const chosenLocal = new Set<string>();

  const takeCandidate = (cand: CandidateEntry): boolean => {
    if (chosen.length >= count) return false;
    if (chosenLocal.has(cand.normStem) || usedStems.has(cand.normStem)) {
      return false;
    }
    chosen.push(cand);
    chosenLocal.add(cand.normStem);
    usedStems.add(cand.normStem);
    return true;
  };

  // Rotate starting offset subtly per set so sets stay varied across books
  const rotatedPool =
    setIndex > 0 && pool.length > 4
      ? [
          ...pool.slice((setIndex * 3) % pool.length),
          ...pool.slice(0, (setIndex * 3) % pool.length),
        ]
      : pool;

  // 1. Honor Demo Paper topic percentage allocations first
  if (topicDistribution && topicDistribution.length > 0) {
    const allocations = allocateQuestionsByPercentage(topicDistribution, count);
    for (const alloc of allocations) {
      let pickedForTopic = 0;
      // Pass A: exact canonical topic match
      for (const cand of rotatedPool) {
        if (pickedForTopic >= alloc.targetCount) break;
        if (cand.canonicalTopicLabel === alloc.topicLabel) {
          if (takeCandidate(cand)) pickedForTopic += 1;
        }
      }
      // Pass B: same subjectGroup match if exact topic ran short
      if (pickedForTopic < alloc.targetCount) {
        for (const cand of rotatedPool) {
          if (pickedForTopic >= alloc.targetCount) break;
          if (cand.subjectGroup === alloc.subjectGroup) {
            if (takeCandidate(cand)) pickedForTopic += 1;
          }
        }
      }
    }
  } else if (focusTopics && focusTopics.length > 0) {
    const focusSet = new Set(focusTopics.map((t) => t.toLowerCase()));
    for (const cand of rotatedPool) {
      if (chosen.length >= count) break;
      if (
        focusSet.has(cand.canonicalTopicLabel.toLowerCase()) ||
        focusSet.has(cand.subjectGroup.toLowerCase())
      ) {
        takeCandidate(cand);
      }
    }
  }

  // 2. Fill remaining slots balanced across subjects (round-robin by subjectGroup)
  if (chosen.length < count) {
    const bySubject = new Map<string, CandidateEntry[]>();
    for (const cand of rotatedPool) {
      if (chosenLocal.has(cand.normStem) || usedStems.has(cand.normStem)) {
        continue;
      }
      const list = bySubject.get(cand.subjectGroup) ?? [];
      list.push(cand);
      bySubject.set(cand.subjectGroup, list);
    }

    const buckets = Array.from(bySubject.values());
    let progressed = true;
    while (chosen.length < count && progressed) {
      progressed = false;
      for (const bucket of buckets) {
        if (chosen.length >= count) break;
        const next = bucket.shift();
        if (next && takeCandidate(next)) {
          progressed = true;
        }
      }
    }
  }

  return chosen.map((c) => c.draft);
}

/**
 * Compiles 1–5 complete, deduplicated, syllabus-tagged job-exam question sets directly
 * from the user's already-imported Library books (+ optional Current GK) with ZERO API calls.
 */
export function compileExamSetsLocallyFromBooks(
  options: LocalCompileExamOptions
): LocalCompileExamResult {
  const safeSetCount = Math.min(5, Math.max(1, Math.round(options.setCount || 1)));
  const targetMcq =
    options.questionMode === 'MCQ' || options.questionMode === 'Mixed'
      ? Math.min(100, Math.max(1, Math.round(options.mcqCount || 1)))
      : 0;
  const targetWritten =
    options.questionMode === 'Written' ||
    options.questionMode === 'Short' ||
    options.questionMode === 'Mixed'
      ? Math.min(25, Math.max(1, Math.round(options.writtenCount || 1)))
      : 0;

  const { mcqPool, writtenPool } = buildCandidatesFromBooks(
    options.books,
    options.difficulty,
    options.subject,
    options.jobExamPreset
  );

  const combinedWrittenPool =
    options.includeCurrentGk && options.gkItems && options.gkItems.length > 0
      ? [...writtenPool, ...buildGkWrittenCandidates(options.gkItems, options.difficulty)]
      : writtenPool;

  // Exclude already-banked stems first; if pool is smaller than requested, allow recycling book questions
  const usedAcrossSets = new Set<string>(
    (options.existingStems ?? []).map(normalizeKey).filter(Boolean)
  );

  const totalNeededMcq = targetMcq * safeSetCount;
  const availableFreshMcq = mcqPool.filter(
    (c) => !usedAcrossSets.has(c.normStem)
  ).length;
  if (availableFreshMcq < totalNeededMcq) {
    // Keep cross-set uniqueness while allowing reuse of previously banked library questions
    usedAcrossSets.clear();
  }

  const sets: CompiledQuestionSet[] = [];
  let totalCompiledQuestions = 0;

  for (let setNum = 1; setNum <= safeSetCount; setNum += 1) {
    const pickedMcq = selectFromPoolForSet({
      pool: mcqPool,
      count: targetMcq,
      usedStems: usedAcrossSets,
      topicDistribution: options.topicDistribution,
      focusTopics: options.focusTopics,
      setIndex: setNum - 1,
    });

    const pickedWrittenRaw = selectFromPoolForSet({
      pool: combinedWrittenPool,
      count: targetWritten,
      usedStems: usedAcrossSets,
      topicDistribution: options.topicDistribution,
      focusTopics: options.focusTopics,
      setIndex: setNum - 1,
    });

    const pickedWritten = pickedWrittenRaw.map((q) => ({
      ...q,
      questionType: (options.questionMode === 'Short'
        ? 'Short'
        : 'Written') as QuestionType,
    }));

    const combined = [...pickedMcq, ...pickedWritten].map((q) => ({
      ...q,
      examSource:
        safeSetCount > 1
          ? clamp(
              `${q.examSource || options.jobExamPreset || 'বই সংকলন'} · সেট-${setNum}`,
              155
            )
          : q.examSource,
    }));

    if (combined.length > 0) {
      const ordered = orderQuestionsForExam(
        combined,
        options.orderingMode ?? 'subject_serial',
        setNum * 23
      );
      sets.push({
        setNumber: setNum,
        questions: ordered,
      });
      totalCompiledQuestions += ordered.length;
    }
  }

  const totalExpected = (targetMcq + targetWritten) * safeSetCount;
  return {
    sets,
    totalPoolMcq: mcqPool.length,
    totalPoolWritten: combinedWrittenPool.length,
    totalCompiledQuestions,
    unfulfilledCount: Math.max(0, totalExpected - totalCompiledQuestions),
  };
}
