import {
  classifyQuestionSyllabusTopic,
  SYLLABUS_SUBJECT_GROUPS,
  type SyllabusSubjectGroup,
} from './syllabus-topic-tagger';
import type { DemoTopicWeight } from './demo-paper-blueprint';
import type { BookChunk, CurrentGkItem, Question } from '../types/system';

export type QuestionOrderingMode = 'subject_serial' | 'shuffled';
export type QuestionLanguageMode = 'mixed_bd_job' | 'bn_only' | 'en_only';
export type WrittenItemStyle =
  | 'step_math'
  | 'sub_questions'
  | 'choice_essay'
  | 'short_gk'
  | 'office_descriptive';

export interface WrittenSectionBlueprint {
  id: string;
  subjectGroup: SyllabusSubjectGroup;
  title: string;
  questionCount: number;
  subQuestionsPerItem: number;
  marksPerQuestion: number;
  isChoiceOne: boolean;
  itemStyle: WrittenItemStyle;
}

export interface SubjectWeight {
  subjectGroup: SyllabusSubjectGroup;
  questionCountInDemo: number;
  percentage: number;
}

export interface ParsedWrittenSubItem {
  label: string;
  prompt: string;
}

export interface ParsedWrittenQuestionStructure {
  displayStem: string;
  marks: number;
  hasExplicitMarks: boolean;
  isChoiceOne: boolean;
  subItems: ParsedWrittenSubItem[];
}

export interface StructuredWrittenAnswer {
  selectedChoiceLabel: string;
  subAnswers: Record<string, string>;
  freeText: string;
}

export const SUBJECT_SERIAL_ORDER: readonly SyllabusSubjectGroup[] = [
  'বাংলা',
  'ইংরেজি',
  'সাধারণ জ্ঞান ও বিজ্ঞান',
  'কম্পিউটার ও ICT',
  'গণিত ও মানসিক দক্ষতা',
] as const;

export const QUESTION_LANGUAGE_LABELS: Record<QuestionLanguageMode, string> = {
  mixed_bd_job: 'বাংলা + ইংরেজি মিশ্রিত (সরকারি চাকরির আদর্শ)',
  bn_only: 'শুধু বাংলা',
  en_only: 'শুধু ইংরেজি (English Version)',
};

export const QUESTION_ORDERING_LABELS: Record<QuestionOrderingMode, string> = {
  subject_serial: 'বিষয়ভিত্তিক সিরিয়াল (বাংলা → ইংরেজি → সা.জ্ঞান → গণিত)',
  shuffled: 'এলোমেলো (Shuffled)',
};

export const WRITTEN_ITEM_STYLE_LABELS: Record<WrittenItemStyle, string> = {
  step_math: 'বিস্তারিত ধাপসহ অঙ্ক',
  sub_questions: 'উপ-প্রশ্ন সেট (ক–ঙ / a–e)',
  choice_essay: 'অথবা বিকল্পসহ রচনা/Paragraph',
  short_gk: 'অতিসংক্ষিপ্ত এক-লাইনের প্রশ্ন',
  office_descriptive: 'ব্যাখ্যামূলক / দাপ্তরিক / ব্যবহারিক',
};

/**
 * Default 100-mark / 20-question Written Blueprint modeled after real BD Ministry/DC Office
 * written job exams (e.g., Office Assistant cum Computer Typist, 90 min, 100 marks).
 */
export const DEFAULT_WRITTEN_BLUEPRINT: readonly WrittenSectionBlueprint[] = [
  {
    id: 'sec-math',
    subjectGroup: 'গণিত ও মানসিক দক্ষতা',
    title: 'গাণিতিক সমস্যা ও বিস্তারিত সমাধান',
    questionCount: 5,
    subQuestionsPerItem: 0,
    marksPerQuestion: 5,
    isChoiceOne: false,
    itemStyle: 'step_math',
  },
  {
    id: 'sec-computer',
    subjectGroup: 'কম্পিউটার ও ICT',
    title: 'কম্পিউটার, MS Office ও ব্যবহারিক ICT',
    questionCount: 4,
    subQuestionsPerItem: 0,
    marksPerQuestion: 4,
    isChoiceOne: false,
    itemStyle: 'office_descriptive',
  },
  {
    id: 'sec-english-grammar',
    subjectGroup: 'ইংরেজি',
    title: 'English Grammar, Preposition ও Translation',
    questionCount: 4,
    subQuestionsPerItem: 5,
    marksPerQuestion: 5,
    isChoiceOne: false,
    itemStyle: 'sub_questions',
  },
  {
    id: 'sec-english-paragraph',
    subjectGroup: 'ইংরেজি',
    title: 'Paragraph Writing (২টির মধ্যে ১টি)',
    questionCount: 1,
    subQuestionsPerItem: 2,
    marksPerQuestion: 5,
    isChoiceOne: true,
    itemStyle: 'choice_essay',
  },
  {
    id: 'sec-bangla',
    subjectGroup: 'বাংলা',
    title: 'বাংলা ব্যাকরণ ও সাহিত্য (সন্ধি, সমাস, বাগধারা, এক কথায় প্রকাশ)',
    questionCount: 4,
    subQuestionsPerItem: 5,
    marksPerQuestion: 5,
    isChoiceOne: false,
    itemStyle: 'sub_questions',
  },
  {
    id: 'sec-gk-office',
    subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
    title: 'সাধারণ জ্ঞান (অতিসংক্ষিপ্ত) ও দাপ্তরিক রচনামূলক',
    questionCount: 2,
    subQuestionsPerItem: 5,
    marksPerQuestion: 7,
    isChoiceOne: false,
    itemStyle: 'short_gk',
  },
] as const;

export function cloneDefaultWrittenBlueprint(): WrittenSectionBlueprint[] {
  return DEFAULT_WRITTEN_BLUEPRINT.map((s) => ({ ...s }));
}

export function summarizeWrittenBlueprint(
  sections: ReadonlyArray<WrittenSectionBlueprint>
): { totalQuestions: number; totalMarks: number } {
  let totalQuestions = 0;
  let totalMarks = 0;
  for (const sec of sections) {
    const qCount = Math.max(0, Math.round(sec.questionCount || 0));
    const marks = Math.max(0, Number(sec.marksPerQuestion || 0));
    totalQuestions += qCount;
    totalMarks += qCount * marks;
  }
  return {
    totalQuestions,
    totalMarks: Number(totalMarks.toFixed(2)),
  };
}

export function normalizeSubjectGroup(
  raw: string | null | undefined
): SyllabusSubjectGroup {
  const cleaned = (raw || '').trim().toLowerCase();
  for (const group of SYLLABUS_SUBJECT_GROUPS) {
    if (group.toLowerCase() === cleaned) return group;
  }
  if (/বাংলা|bangla/i.test(cleaned)) return 'বাংলা';
  if (/ইংরেজি|english/i.test(cleaned)) return 'ইংরেজি';
  if (/গণিত|math|মানসিক|mental/i.test(cleaned)) return 'গণিত ও মানসিক দক্ষতা';
  if (/কম্পিউটার|ict|computer/i.test(cleaned)) return 'কম্পিউটার ও ICT';
  return 'সাধারণ জ্ঞান ও বিজ্ঞান';
}

export function normalizeWrittenSections(
  rawSections: ReadonlyArray<Record<string, unknown>>
): WrittenSectionBlueprint[] {
  const allowedStyles = new Set<WrittenItemStyle>([
    'step_math',
    'sub_questions',
    'choice_essay',
    'short_gk',
    'office_descriptive',
  ]);
  const out: WrittenSectionBlueprint[] = [];

  for (let i = 0; i < rawSections.length && out.length < 10; i += 1) {
    const row = rawSections[i];
    if (!row || typeof row !== 'object') continue;
    const title = String(row.title ?? '').trim().slice(0, 120);
    const questionCount = Math.min(
      15,
      Math.max(1, Math.round(Number(row.questionCount || 1)))
    );
    const subQuestionsPerItem = Math.min(
      10,
      Math.max(0, Math.round(Number(row.subQuestionsPerItem || 0)))
    );
    const marksPerQuestion = Math.min(
      30,
      Math.max(1, Number(row.marksPerQuestion || 5))
    );
    const isChoiceOne = Boolean(row.isChoiceOne);
    const rawStyle = String(row.itemStyle || 'office_descriptive') as WrittenItemStyle;
    const itemStyle: WrittenItemStyle = allowedStyles.has(rawStyle)
      ? rawStyle
      : isChoiceOne
        ? 'choice_essay'
        : subQuestionsPerItem >= 2
          ? 'sub_questions'
          : 'office_descriptive';

    out.push({
      id: `sec-ai-${i + 1}`,
      subjectGroup: normalizeSubjectGroup(String(row.subjectGroup || '')),
      title: title || `লিখিত অংশ ${i + 1}`,
      questionCount,
      subQuestionsPerItem,
      marksPerQuestion: Number(marksPerQuestion.toFixed(1)),
      isChoiceOne,
      itemStyle,
    });
  }

  return out;
}

/**
 * Aggregates fine-grained topic weights into 2-level Subject % weights summing to exactly 100%.
 */
export function computeSubjectDistribution(
  topicDistribution: ReadonlyArray<DemoTopicWeight>
): SubjectWeight[] {
  if (topicDistribution.length === 0) return [];

  const buckets = new Map<
    SyllabusSubjectGroup,
    { count: number; rawWeight: number }
  >();

  for (const t of topicDistribution) {
    const group = normalizeSubjectGroup(t.subjectGroup);
    const prev = buckets.get(group) ?? { count: 0, rawWeight: 0 };
    const weight =
      t.questionCountInDemo > 0
        ? t.questionCountInDemo
        : Math.max(0, t.percentage);
    buckets.set(group, {
      count: prev.count + Math.max(0, t.questionCountInDemo),
      rawWeight: prev.rawWeight + weight,
    });
  }

  const entries = Array.from(buckets.entries()).sort(
    (a, b) =>
      SUBJECT_SERIAL_ORDER.indexOf(a[0]) - SUBJECT_SERIAL_ORDER.indexOf(b[0])
  );
  const totalWeight = entries.reduce((sum, [, v]) => sum + v.rawWeight, 0);
  if (totalWeight <= 0) return [];

  const exact = entries.map(([subjectGroup, val]) => {
    const share = (val.rawWeight / totalWeight) * 100;
    const floored = Math.floor(share);
    return {
      subjectGroup,
      count: val.count,
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

  return exact.map((e) => ({
    subjectGroup: e.subjectGroup,
    questionCountInDemo: e.count,
    percentage: e.floored,
  }));
}

export function detectQuestionSubjectGroup(
  q: Pick<Question, 'stem' | 'chapter' | 'subject'>
): SyllabusSubjectGroup {
  return classifyQuestionSyllabusTopic(q.stem, {
    chapter: q.chapter,
    subject: q.subject,
  }).subjectGroup;
}

/**
 * Orders a set of exam questions either by standard BD job exam subject sequence
 * (বাংলা → ইংরেজি → সাধারণ জ্ঞান → ICT → গণিত) or deterministically shuffled.
 */
export function orderQuestionsForExam<
  T extends Pick<Question, 'stem' | 'chapter' | 'subject' | 'questionType'>,
>(questions: ReadonlyArray<T>, mode: QuestionOrderingMode, seed = 13): T[] {
  if (questions.length <= 1) return [...questions];

  const mcq = questions.filter((q) => q.questionType === 'MCQ');
  const written = questions.filter((q) => q.questionType !== 'MCQ');

  if (mode === 'subject_serial') {
    const sortBySubject = (arr: T[]) =>
      arr
        .map((item, idx) => ({
          item,
          idx,
          rank: SUBJECT_SERIAL_ORDER.indexOf(detectQuestionSubjectGroup(item)),
        }))
        .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
        .map((x) => x.item);

    return [...sortBySubject(mcq), ...sortBySubject(written)];
  }

  // Deterministic Mulberry32-style shuffle so tests and set orders are reproducible
  const shuffleGroup = (arr: T[], groupSeed: number): T[] => {
    const copy = [...arr];
    let state = (groupSeed + copy.length * 31) >>> 0;
    const nextRand = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(nextRand() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  return [...shuffleGroup(mcq, seed), ...shuffleGroup(written, seed + 97)];
}

const BN_TO_EN_DIGITS: Record<string, string> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
};

function toAsciiDigits(str: string): string {
  return str.replace(/[০-৯]/g, (d) => BN_TO_EN_DIGITS[d] ?? d);
}

/**
 * Parses a Written question stem to extract:
 * - explicit variable marks tag (e.g. "[নম্বর: ৫]", "[নম্বর: ১×৫ = ৫]", "[Marks: 4]")
 * - OR-choice flag (e.g. "[যেকোনো ১টি উত্তর দিন]" or "যেকোনো ১টি")
 * - individual sub-questions on separate lines (ক. ..., খ. ..., a) ..., b) ...)
 *
 * Works purely on stem text so Firestore schema rules stay 100% unchanged!
 */
export function parseWrittenQuestionStructure(
  stem: string,
  fallbackMarks: number
): ParsedWrittenQuestionStructure {
  const raw = (stem || '').trim();
  if (!raw) {
    return {
      displayStem: '',
      marks: fallbackMarks,
      hasExplicitMarks: false,
      isChoiceOne: false,
      subItems: [],
    };
  }

  let marks = fallbackMarks;
  let hasExplicitMarks = false;

  // Match [নম্বর: 5], [নম্বর: ১×৫ = ৫], [মান: ৪], [Marks: 5]
  const marksTagRegex =
    /\[(?:নম্বর|মান|marks?)\s*[:：]\s*([^\]]+)\]/i;
  const marksMatch = raw.match(marksTagRegex);
  if (marksMatch) {
    const innerAscii = toAsciiDigits(marksMatch[1]);
    // If there is "= X", use X; otherwise parse the last number
    const eqMatch = innerAscii.match(/=\s*(\d+(?:\.\d+)?)/);
    const numMatch = eqMatch
      ? eqMatch[1]
      : innerAscii.match(/(\d+(?:\.\d+)?)/)?.[1];
    if (numMatch) {
      const parsed = Number(numMatch);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 50) {
        marks = Number(parsed.toFixed(2));
        hasExplicitMarks = true;
      }
    }
  }

  const choiceTagRegex =
    /\[(?:যেকোনো\s*(?:১|1|এক)টি\s*(?:উত্তর\s*দিন|লিখুন|নির্বাচন\s*করুন)|any\s*one|answer\s*any\s*one)\]/i;
  const isChoiceOne =
    choiceTagRegex.test(raw) ||
    /যেকোনো\s*(?:১|1|এক)টি(?:র)?\s*(?:উত্তর|লিখুন|বিষয়ে|উপর)/i.test(raw) ||
    /\b(?:any\s+one\s+of\s+the\s+following|write\s+a\s+paragraph\s+on\s+any\s+one)\b/i.test(
      raw
    );

  // Clean bracket tags from stem lines before scanning sub-questions
  const cleanedRaw = raw
    .replace(marksTagRegex, '')
    .replace(choiceTagRegex, '')
    .trim();

  const lines = cleanedRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const subItemRegex =
    /^([কখগঘঙচছজঝঞ]|[a-j]|i{1,3}|iv|v|vi{0,3}|ix|x)\s*[.)।:]\s+(.+)$/i;

  const headerLines: string[] = [];
  const subItems: ParsedWrittenSubItem[] = [];

  for (const line of lines) {
    const m = line.match(subItemRegex);
    if (m) {
      subItems.push({
        label: m[1].trim(),
        prompt: m[2].trim(),
      });
    } else if (subItems.length === 0) {
      headerLines.push(line);
    } else {
      // Continuation line of previous sub-item
      const last = subItems[subItems.length - 1];
      last.prompt = `${last.prompt} ${line}`.trim();
    }
  }

  // Only treat as structured sub-items if at least 2 sub-items were detected
  if (subItems.length < 2) {
    return {
      displayStem: cleanedRaw,
      marks,
      hasExplicitMarks,
      isChoiceOne,
      subItems: [],
    };
  }

  return {
    displayStem: headerLines.join('\n').trim() || cleanedRaw,
    marks,
    hasExplicitMarks,
    isChoiceOne,
    subItems,
  };
}

/**
 * Serializes structured Written answers (sub-questions, OR-choice selection, free text)
 * into clean text stored in ExamAnswerDraft.writtenText (Firestore-safe).
 */
export function formatStructuredWrittenAnswer(
  input: StructuredWrittenAnswer,
  subItems: ReadonlyArray<ParsedWrittenSubItem>,
  isChoiceOne: boolean
): string {
  if (isChoiceOne && subItems.length >= 2) {
    const choice = input.selectedChoiceLabel.trim();
    const body = input.freeText.trim();
    if (!choice && !body) return '';
    return choice
      ? `[নির্বাচিত বিকল্প: ${choice}]\n${body}`.trim()
      : body;
  }

  if (subItems.length >= 2) {
    const parts: string[] = [];
    for (const item of subItems) {
      const val = (input.subAnswers[item.label] ?? '').trim();
      if (val) {
        parts.push(`${item.label}) ${val}`);
      }
    }
    return parts.join('\n');
  }

  return input.freeText.trim();
}

/**
 * Parses a saved ExamAnswerDraft.writtenText back into structured sub-answers / OR-choice.
 */
export function parseStructuredWrittenAnswer(
  writtenText: string | undefined,
  subItems: ReadonlyArray<ParsedWrittenSubItem>,
  isChoiceOne: boolean
): StructuredWrittenAnswer {
  const raw = (writtenText ?? '').trim();
  if (!raw) {
    return {
      selectedChoiceLabel: isChoiceOne && subItems[0] ? subItems[0].label : '',
      subAnswers: {},
      freeText: '',
    };
  }

  if (isChoiceOne && subItems.length >= 2) {
    const choiceMatch = raw.match(/^\[নির্বাচিত\s*বিকল্প:\s*([^\]]+)\]\s*/);
    if (choiceMatch) {
      return {
        selectedChoiceLabel: choiceMatch[1].trim(),
        subAnswers: {},
        freeText: raw.slice(choiceMatch[0].length),
      };
    }
    return {
      selectedChoiceLabel: subItems[0]?.label ?? '',
      subAnswers: {},
      freeText: raw,
    };
  }

  if (subItems.length >= 2) {
    const subAnswers: Record<string, string> = {};
    const validLabels = new Set(subItems.map((s) => s.label));
    let currentLabel: string | null = null;

    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([কখগঘঙচছজঝঞa-j]+|i{1,3}|iv|v|vi{0,3}|ix|x)\s*[.)।:]\s*(.*)$/i);
      if (m && validLabels.has(m[1])) {
        currentLabel = m[1];
        subAnswers[currentLabel] = m[2];
      } else if (currentLabel) {
        subAnswers[currentLabel] = `${subAnswers[currentLabel]}\n${line}`.trim();
      }
    }
    return {
      selectedChoiceLabel: '',
      subAnswers,
      freeText: '',
    };
  }

  return {
    selectedChoiceLabel: '',
    subAnswers: {},
    freeText: raw,
  };
}

/**
 * Converts active (non-archived) Current GK & Paper Cutting items into BookChunk-compatible
 * source chunks so AI can seamlessly include recent current-affairs questions in exams.
 */
export function buildCurrentGkChunks(
  gkItems: ReadonlyArray<CurrentGkItem>,
  maxChunks = 4
): BookChunk[] {
  const active = gkItems.filter((item) => !item.isArchived);
  if (active.length === 0) return [];

  // Group into concise chunks (up to 4 items per chunk) so token budget stays clean
  const chunks: BookChunk[] = [];
  const itemsPerChunk = 3;

  for (
    let i = 0;
    i < active.length && chunks.length < maxChunks;
    i += itemsPerChunk
  ) {
    const slice = active.slice(i, i + itemsPerChunk);
    const content = slice
      .map(
        (item, idx) =>
          `[সাম্প্রতিক তথ্য ${idx + 1} | ${item.category} | তারিখ: ${item.eventDate} | উৎস: ${item.source}]\nশিরোনাম: ${item.title}\nবিস্তারিত: ${item.summary}`
      )
      .join('\n\n');

    chunks.push({
      id: -9000 - chunks.length - 1,
      bookId: -9001,
      bookTitle: 'সাম্প্রতিক সাধারণ জ্ঞান ও Paper Cutting',
      chapter: `সাম্প্রতিক সাধারণ জ্ঞান (Current GK) · ${slice[0].category}`,
      pageNumber: chunks.length + 1,
      chunkIndex: chunks.length,
      content,
    });
  }

  return chunks;
}
