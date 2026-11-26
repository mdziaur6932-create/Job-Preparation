import type { Book } from '../types/system';
import { analyzeBookOrSeriesQuestions } from './book-series-and-topic-analyzer';
import {
  normalizeTopicPercentages,
  type DemoPaperAnalysis,
} from './demo-paper-blueprint';
import {
  computeSubjectDistribution,
  type WrittenSectionBlueprint,
} from './job-exam-paper';
import { classifyQuestionSyllabusTopic } from './syllabus-topic-tagger';
import { toBengaliNumber } from './file-validation';

function parseBnOrEnInt(raw: string): number {
  const normalized = raw.replace(/[০-৯]/g, (d) =>
    String('০১২৩৪৫৬৭৮৯'.indexOf(d))
  );
  const parsed = parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Analyzes raw extracted text from a Demo Question Paper PDF/text document completely locally
 * (0 Gemini API calls) to detect exam metadata, MCQ vs Written split, subject weights, and
 * syllabus topic percentage distribution.
 *
 * Returns null if the text does not contain enough readable questions (e.g., pure image-only scan).
 */
export function analyzeDemoPaperTextLocally(
  pages: string[],
  fileName: string
): DemoPaperAnalysis | null {
  const cleanPages = pages.map((p) => (p || '').trim()).filter((p) => p.length > 20);
  if (cleanPages.length === 0) return null;

  const cleanTitle =
    fileName.replace(/\.[^.]+$/, '') || 'আপলোডকৃত ডেমো প্রশ্নপত্র';
  const syntheticBook: Book = {
    id: -1,
    title: cleanTitle,
    author: 'ডেমো প্রশ্নপত্র',
    subject: 'সমন্বিত',
    category: 'রিসেন্ট জব সলুশন',
    totalPages: cleanPages.length,
    extractionMethod: 'text',
    ocrCompleted: true,
    createdAt: new Date().toISOString(),
    chunks: cleanPages.map((content, idx) => ({
      id: -(idx + 1),
      bookId: -1,
      bookTitle: cleanTitle,
      chapter: `পৃষ্ঠা ${idx + 1}`,
      pageNumber: idx + 1,
      chunkIndex: idx,
      content,
    })),
  };

  const report = analyzeBookOrSeriesQuestions([syntheticBook]);
  if (report.questions.length === 0) return null;

  const fullText = cleanPages.join('\n');

  // Extract header metadata (marks, duration, organization, post)
  const marksMatch = fullText.match(
    /(?:পূর্ণমান|মোট\s*নম্বর|Full\s*Marks?|Total\s*Marks?)\s*[:ঃ=\-]?\s*([০-৯\d]{2,3})/i
  );
  const durationMatch = fullText.match(
    /(?:সময়|সময়|Time)\s*[:ঃ=\-]?\s*([০-৯\d]{1,3})\s*(?:মিনিট|ঘণ্টা|ঘন্টা|min|mins|minutes|hour|hours)/i
  );

  const totalMarksDetected = marksMatch ? parseBnOrEnInt(marksMatch[1]) : 0;
  let durationMinutesDetected = durationMatch
    ? parseBnOrEnInt(durationMatch[1])
    : 0;
  if (
    durationMatch &&
    /(?:ঘণ্টা|ঘন্টা|hour)/i.test(durationMatch[0]) &&
    durationMinutesDetected > 0 &&
    durationMinutesDetected <= 5
  ) {
    durationMinutesDetected *= 60;
  }

  const firstExam = report.exams[0];
  const examTitleDetected =
    firstExam?.examTitle && firstExam.examTitle !== 'প্রশ্নপত্র'
      ? firstExam.examTitle
      : syntheticBook.title;
  const organizationDetected =
    firstExam?.institution && firstExam.institution !== 'অন্যান্য পরীক্ষা'
      ? firstExam.institution
      : undefined;
  const postNameDetected = firstExam?.postName || undefined;

  // Tally canonical syllabus topics across every detected question
  const topicTallies = new Map<
    string,
    {
      topicLabel: string;
      subjectGroup: string;
      count: number;
      types: Set<'MCQ' | 'Written'>;
    }
  >();

  for (const q of report.questions) {
    const canonical = classifyQuestionSyllabusTopic(q.questionText, {
      chapter: q.topic,
      subject: q.subjectGroup,
    });
    const entry = topicTallies.get(canonical.label);
    if (entry) {
      entry.count += 1;
      entry.types.add(q.format);
    } else {
      topicTallies.set(canonical.label, {
        topicLabel: canonical.label,
        subjectGroup: canonical.subjectGroup,
        count: 1,
        types: new Set([q.format]),
      });
    }
  }

  const topicDistribution = normalizeTopicPercentages(
    Array.from(topicTallies.values()).map((t) => ({
      topicLabel: t.topicLabel,
      subjectGroup: t.subjectGroup,
      questionCountInDemo: t.count,
      questionTypes: Array.from(t.types),
    }))
  );

  const subjectDistribution = computeSubjectDistribution(topicDistribution);
  const mcqCountDetected = report.mcqQuestionCount;
  const writtenCountDetected = report.writtenQuestionCount;
  const totalQuestionsDetected = report.totalQuestions;

  const recommendedFormat: 'MCQ' | 'Written' | 'Mixed' =
    mcqCountDetected > 0 && writtenCountDetected > 0
      ? 'Mixed'
      : writtenCountDetected > 0
        ? 'Written'
        : 'MCQ';

  const writtenSections: WrittenSectionBlueprint[] =
    writtenCountDetected > 0
      ? subjectDistribution
          .filter((s) => s.questionCountInDemo > 0)
          .slice(0, 5)
          .map((sub, idx) => ({
            id: `local-wsec-${idx + 1}`,
            subjectGroup: sub.subjectGroup,
            title: `${sub.subjectGroup} (লিখিত)`,
            questionCount: Math.max(
              1,
              Math.round((sub.percentage / 100) * writtenCountDetected)
            ),
            subQuestionsPerItem: 1,
            marksPerQuestion: 5,
            isChoiceOne: false,
            itemStyle: 'office_descriptive',
          }))
      : [];

  const topSubjects = subjectDistribution
    .slice(0, 3)
    .map((s) => `${s.subjectGroup} (${toBengaliNumber(s.percentage)}%)`)
    .join(', ');

  return {
    fileName,
    fileType: 'pdf',
    examTitleDetected: examTitleDetected.slice(0, 180),
    examPatternDetected: 'স্থানীয় PDF বিশ্লেষণ (০ API কোটা)',
    ...(organizationDetected ? { organizationDetected } : {}),
    ...(postNameDetected ? { postNameDetected } : {}),
    ...(totalMarksDetected > 0 && totalMarksDetected <= 500
      ? { totalMarksDetected }
      : {}),
    ...(durationMinutesDetected > 0 && durationMinutesDetected <= 300
      ? { durationMinutesDetected }
      : {}),
    totalQuestionsDetected,
    mcqCountDetected,
    writtenCountDetected,
    recommendedFormat,
    subjectDistribution,
    writtenSections,
    topicDistribution,
    summaryNote: `স্থানীয়ভাবে ${toBengaliNumber(totalQuestionsDetected)}টি প্রশ্ন বিশ্লেষণ করা হয়েছে (০ API কোটা)। প্রধান বিষয়সমূহ: ${topSubjects || 'সমন্বিত'}।`,
  };
}
