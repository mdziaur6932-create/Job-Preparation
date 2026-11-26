import {
  FALLBACK_SYLLABUS_TOPIC,
  resolveCanonicalSyllabusTopic,
  type SyllabusSubjectGroup,
} from './syllabus-topic-tagger';
import type {
  SubjectWeight,
  WrittenSectionBlueprint,
} from './job-exam-paper';

export interface DemoTopicWeight {
  topicId: string;
  topicLabel: string;
  subjectGroup: SyllabusSubjectGroup;
  questionCountInDemo: number;
  percentage: number;
  questionTypes: Array<'MCQ' | 'Written' | 'Short'>;
}

export interface DemoPaperAnalysis {
  fileName: string;
  fileType: 'image' | 'pdf';
  examTitleDetected: string;
  examPatternDetected: string;
  organizationDetected?: string;
  postNameDetected?: string;
  totalMarksDetected?: number;
  durationMinutesDetected?: number;
  totalQuestionsDetected: number;
  mcqCountDetected: number;
  writtenCountDetected: number;
  recommendedFormat: 'MCQ' | 'Written' | 'Mixed';
  subjectDistribution?: SubjectWeight[];
  writtenSections?: WrittenSectionBlueprint[];
  topicDistribution: DemoTopicWeight[];
  summaryNote: string;
}

export interface TopicQuestionAllocation {
  topicId: string;
  topicLabel: string;
  subjectGroup: SyllabusSubjectGroup;
  percentage: number;
  targetCount: number;
}

export type ExplanationSourceType = 'book' | 'ai';

export const BOOK_EXPLANATION_PREFIX = '[বইয়ের ব্যাখ্যা]';
export const AI_EXPLANATION_PREFIX = '[AI ব্যাখ্যা]';

export interface ParsedExplanation {
  source: ExplanationSourceType;
  text: string;
  badgeLabel: string;
  sourceNote: string;
  hasExplanation: boolean;
}

/**
 * Merges duplicate syllabus topics and normalizes percentages using largest-remainder
 * apportionment so the returned distribution sums to exactly 100%.
 */
export function normalizeTopicPercentages(
  rawTopics: ReadonlyArray<{
    topicLabel: string;
    subjectGroup?: string;
    questionCountInDemo?: number;
    percentage?: number;
    questionTypes?: ReadonlyArray<string>;
  }>
): DemoTopicWeight[] {
  const merged = new Map<
    string,
    {
      topicId: string;
      topicLabel: string;
      subjectGroup: SyllabusSubjectGroup;
      questionCountInDemo: number;
      rawWeight: number;
      questionTypes: Set<'MCQ' | 'Written' | 'Short'>;
    }
  >();

  for (const row of rawTopics) {
    const rawLabel = (row.topicLabel || '').trim();
    if (!rawLabel) continue;

    const canonical = resolveCanonicalSyllabusTopic(rawLabel);
    const topicId =
      canonical?.id ??
      rawLabel
        .toLowerCase()
        .replace(/[^a-z0-9\u0980-\u09ff]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    const topicLabel = canonical?.label ?? rawLabel.slice(0, 90);
    const subjectGroup: SyllabusSubjectGroup =
      canonical?.subjectGroup ?? FALLBACK_SYLLABUS_TOPIC.subjectGroup;

    const qCount = Math.max(0, Math.round(Number(row.questionCountInDemo || 0)));
    const pct = Math.max(0, Number(row.percentage || 0));
    const weight = qCount > 0 ? qCount : pct > 0 ? pct : 1;

    const types = new Set<'MCQ' | 'Written' | 'Short'>();
    if (Array.isArray(row.questionTypes)) {
      for (const t of row.questionTypes) {
        if (t === 'MCQ' || t === 'Written' || t === 'Short') {
          types.add(t);
        }
      }
    }
    if (types.size === 0) types.add('MCQ');

    const existing = merged.get(topicLabel);
    if (existing) {
      existing.questionCountInDemo += qCount;
      existing.rawWeight += weight;
      for (const t of types) existing.questionTypes.add(t);
    } else {
      merged.set(topicLabel, {
        topicId: topicId || 'general-mixed',
        topicLabel,
        subjectGroup,
        questionCountInDemo: qCount,
        rawWeight: weight,
        questionTypes: types,
      });
    }
  }

  const list = Array.from(merged.values());
  if (list.length === 0) return [];

  const totalWeight = list.reduce((sum, item) => sum + item.rawWeight, 0);
  if (totalWeight <= 0) {
    const equal = Math.floor(100 / list.length);
    let rem = 100 - equal * list.length;
    return list.map((item) => {
      const bonus = rem > 0 ? 1 : 0;
      if (rem > 0) rem -= 1;
      return {
        topicId: item.topicId,
        topicLabel: item.topicLabel,
        subjectGroup: item.subjectGroup,
        questionCountInDemo: item.questionCountInDemo,
        percentage: equal + bonus,
        questionTypes: Array.from(item.questionTypes),
      };
    });
  }

  // Largest-remainder apportionment to guarantee exact 100% sum
  const exact = list.map((item, idx) => {
    const share = (item.rawWeight / totalWeight) * 100;
    const floored = Math.floor(share);
    return {
      idx,
      item,
      floored,
      remainder: share - floored,
    };
  });

  let remaining = 100 - exact.reduce((sum, e) => sum + e.floored, 0);
  const byRem = [...exact].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < byRem.length && remaining > 0; i += 1) {
    byRem[i].floored += 1;
    remaining -= 1;
  }

  return exact
    .map((e) => ({
      topicId: e.item.topicId,
      topicLabel: e.item.topicLabel,
      subjectGroup: e.item.subjectGroup,
      questionCountInDemo: e.item.questionCountInDemo,
      percentage: e.floored,
      questionTypes: Array.from(e.item.questionTypes),
    }))
    .sort((a, b) => b.percentage - a.percentage || b.questionCountInDemo - a.questionCountInDemo);
}

/**
 * Allocates an exact integer number of questions per topic matching the demo paper's
 * percentage weights using largest-remainder apportionment.
 */
export function allocateQuestionsByPercentage(
  topicDistribution: ReadonlyArray<DemoTopicWeight>,
  totalQuestions: number
): TopicQuestionAllocation[] {
  const safeTotal = Math.max(0, Math.round(totalQuestions));
  if (safeTotal === 0 || topicDistribution.length === 0) return [];

  const totalPct = topicDistribution.reduce(
    (sum, t) => sum + Math.max(0, t.percentage),
    0
  );
  if (totalPct <= 0) return [];

  const exact = topicDistribution.map((topic, idx) => {
    const share = (Math.max(0, topic.percentage) / totalPct) * safeTotal;
    const floored = Math.floor(share);
    return {
      idx,
      topic,
      floored,
      remainder: share - floored,
    };
  });

  let remaining = safeTotal - exact.reduce((sum, e) => sum + e.floored, 0);
  const sortedByRem = [...exact].sort(
    (a, b) => b.remainder - a.remainder || b.topic.percentage - a.topic.percentage
  );
  for (let i = 0; i < sortedByRem.length && remaining > 0; i += 1) {
    sortedByRem[i].floored += 1;
    remaining -= 1;
  }

  return exact
    .filter((e) => e.floored > 0)
    .map((e) => ({
      topicId: e.topic.topicId,
      topicLabel: e.topic.topicLabel,
      subjectGroup: e.topic.subjectGroup,
      percentage: e.topic.percentage,
      targetCount: e.floored,
    }))
    .sort((a, b) => b.targetCount - a.targetCount || b.percentage - a.percentage);
}

/**
 * Splits a large per-set generation request (e.g. 70 MCQ) into safe API batch sizes
 * so Gemini JSON responses never truncate while preserving per-topic percentage distribution.
 */
export function splitGenerationIntoBatches(params: {
  mcqCount: number;
  writtenCount: number;
  maxQuestionsPerBatch?: number;
}): Array<{ mcqCount: number; writtenCount: number }> {
  const maxPerBatch = Math.max(4, params.maxQuestionsPerBatch ?? 15);
  let remMcq = Math.max(0, Math.round(params.mcqCount));
  let remWritten = Math.max(0, Math.round(params.writtenCount));

  if (remMcq + remWritten === 0) return [];

  const batches: Array<{ mcqCount: number; writtenCount: number }> = [];
  while (remMcq > 0 || remWritten > 0) {
    const takeMcq = Math.min(remMcq, maxPerBatch);
    remMcq -= takeMcq;

    const remainingSlot = maxPerBatch - takeMcq;
    const takeWritten =
      remainingSlot > 0 ? Math.min(remWritten, remainingSlot) : 0;
    remWritten -= takeWritten;

    if (takeMcq > 0 || takeWritten > 0) {
      batches.push({ mcqCount: takeMcq, writtenCount: takeWritten });
    }
  }

  return batches;
}

/**
 * Encodes an explanation string with its exact provenance tag ([বইয়ের ব্যাখ্যা] or [AI ব্যাখ্যা])
 * so it persists cleanly inside existing Firestore string fields without breaking schema rules.
 */
export function encodeExplanationWithSource(
  rawExplanation: string,
  source: ExplanationSourceType,
  maxLength = 7500
): string {
  const cleaned = stripExplanationSourcePrefix(rawExplanation).trim();
  if (!cleaned) return '';
  const prefix =
    source === 'ai' ? AI_EXPLANATION_PREFIX : BOOK_EXPLANATION_PREFIX;
  const combined = `${prefix} ${cleaned}`;
  return combined.length <= maxLength
    ? combined
    : combined.slice(0, maxLength).trim();
}

export function stripExplanationSourcePrefix(raw: string): string {
  return (raw || '')
    .trim()
    .replace(/^\[(?:AI\s*ব্যাখ্যা|বইয়ের\s*ব্যাখ্যা|বইয়ের\s*মূল\s*ব্যাখ্যা)\]\s*/i, '')
    .trim();
}

/**
 * Parses a question's explanation string into structured UI provenance metadata.
 */
export function parseExplanationSource(
  rawExplanation: string | null | undefined,
  bookTitle?: string,
  pageNumber?: number
): ParsedExplanation {
  const raw = (rawExplanation || '').trim();
  if (!raw) {
    return {
      source: 'ai',
      text: '',
      badgeLabel: 'ব্যাখ্যা অনুপস্থিত',
      sourceNote: 'মূল বইয়ে ব্যাখ্যা পাওয়া যায়নি—AI দিয়ে ব্যাখ্যা তৈরি করা যাবে।',
      hasExplanation: false,
    };
  }

  const isExplicitAi =
    /^\[AI\s*ব্যাখ্যা\]/i.test(raw) ||
    /AI\s*দিয়ে\s*ব্যাখ্যা\s*লেখা\s*হয়েছে/i.test(raw);
  const isExplicitBook = /^\[বইয়ের\s*(?:মূল\s*)?ব্যাখ্যা\]/i.test(raw);

  const cleanedText = stripExplanationSourcePrefix(raw);
  if (isExplicitAi) {
    return {
      source: 'ai',
      text: cleanedText,
      badgeLabel: 'AI দিয়ে ব্যাখ্যা লেখা হয়েছে',
      sourceNote:
        'নির্বাচিত বইয়ে বিস্তারিত ব্যাখ্যা না থাকায় এই ব্যাখ্যাটি AI দিয়ে লেখা হয়েছে।',
      hasExplanation: cleanedText.length > 0,
    };
  }

  const refLabel = bookTitle
    ? `${bookTitle}${pageNumber ? ` · পৃষ্ঠা ${pageNumber}` : ''}`
    : 'নির্বাচিত উৎস বই';

  return {
    source: 'book',
    text: cleanedText,
    badgeLabel: isExplicitBook ? 'মূল বইয়ের ব্যাখ্যা' : 'বইয়ের ব্যাখ্যা',
    sourceNote: `উৎস বই থেকে সংগৃহীত ব্যাখ্যা (${refLabel})`,
    hasExplanation: cleanedText.length > 0,
  };
}
