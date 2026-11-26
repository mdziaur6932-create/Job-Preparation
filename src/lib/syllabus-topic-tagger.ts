import {
  analyzeBookOrSeriesQuestions,
  type AnalyzedQuestionItem,
} from './book-series-and-topic-analyzer';
import { rankChunksHybrid } from './rag-engine';
import type { Book, BookChunk, Question } from '../types/system';

export type SyllabusSubjectGroup =
  | 'বাংলা'
  | 'ইংরেজি'
  | 'গণিত ও মানসিক দক্ষতা'
  | 'সাধারণ জ্ঞান ও বিজ্ঞান'
  | 'কম্পিউটার ও ICT';

export interface SyllabusTopicDefinition {
  id: string;
  label: string;
  subjectGroup: SyllabusSubjectGroup;
  keywords: string[];
  patterns: RegExp[];
}

export const SYLLABUS_SUBJECT_GROUPS: readonly SyllabusSubjectGroup[] = [
  'বাংলা',
  'ইংরেজি',
  'গণিত ও মানসিক দক্ষতা',
  'সাধারণ জ্ঞান ও বিজ্ঞান',
  'কম্পিউটার ও ICT',
] as const;

export const SYLLABUS_TOPICS: readonly SyllabusTopicDefinition[] = [
  // বাংলা
  {
    id: 'sandhi-bicched',
    label: 'সন্ধি বিচ্ছেদ (Sandhi Bicched)',
    subjectGroup: 'বাংলা',
    keywords: ['সন্ধি', 'সন্ধি বিচ্ছেদ', 'sandhi', 'বিচ্ছেদ'],
    patterns: [/সন্ধি\s*বিচ্ছেদ|সন্ধি|sandhi/i, /=\s*[^\n=]+\+\s*[^\n]+/],
  },
  {
    id: 'samas',
    label: 'সমাস (Samas)',
    subjectGroup: 'বাংলা',
    keywords: ['সমাস', 'ব্যাসবাক্য', 'বহুব্রীহি', 'কর্মধারয়', 'দ্বন্দ্ব', 'তৎপুরুষ'],
    patterns: [/ব্যাসবাক্য|সমাস|বহুব্রীহি|কর্মধারয়|তৎপুরুষ|দ্বিগু|অব্যয়ীভাব/i],
  },
  {
    id: 'karok-bibhokti',
    label: 'কারক ও বিভক্তি',
    subjectGroup: 'বাংলা',
    keywords: ['কারক', 'বিভক্তি', 'অপাদান', 'অধিকরণ', 'করণ কারক'],
    patterns: [/কারক|বিভক্তি|অপাদান|অধিকরণ|সম্প্রদান/i],
  },
  {
    id: 'ek-kothay-prokash',
    label: 'এক কথায় প্রকাশ',
    subjectGroup: 'বাংলা',
    keywords: ['এক কথায় প্রকাশ', 'বাক্য সংকোচন'],
    patterns: [/এক\s*কথায়\s*প্রকাশ|বাক্য\s*সংকোচন/i],
  },
  {
    id: 'bagdhara',
    label: 'বাগধারা ও প্রবাদ',
    subjectGroup: 'বাংলা',
    keywords: ['বাগধারা', 'প্রবাদ', 'অর্থসহ বাক্য'],
    patterns: [/বাগধারা|প্রবাদ|অর্থসহ\s*বাক্য/i],
  },
  {
    id: 'biporit-somarthok',
    label: 'বিপরীত ও সমার্থক শব্দ',
    subjectGroup: 'বাংলা',
    keywords: ['বিপরীত শব্দ', 'সমার্থক শব্দ', 'প্রতিশব্দ'],
    patterns: [/বিপরীত\s*শব্দ|সমার্থক\s*শব্দ|প্রতিশব্দ/i],
  },
  {
    id: 'banan-shuddhi',
    label: 'বানান ও বাক্য শুদ্ধি',
    subjectGroup: 'বাংলা',
    keywords: ['শুদ্ধ বানান', 'বাক্য শুদ্ধি', 'যুক্তব্যঞ্জন', 'ধ্বনি', 'প্রত্যয়'],
    patterns: [/বানান|বাক্য\s*শুদ্ধি|শুদ্ধরূপ|যুক্তব্যঞ্জন|প্রত্যয়|উপসর্গ/i],
  },
  {
    id: 'bangla-sahitya',
    label: 'বাংলা সাহিত্য ও লেখক',
    subjectGroup: 'বাংলা',
    keywords: ['উপন্যাস', 'কবিতা', 'ছদ্মনাম', 'রবীন্দ্রনাথ', 'নজরুল', 'মুক্তিযুদ্ধভিত্তিক'],
    patterns: [/উপন্যাস|কাব্যগ্রন্থ|ছদ্মনাম|কবিতার\s*চরণ|সাহিত্যিক|রচনা\s*করেন|কাজী\s*নজরুল|রবীন্দ্রনাথ/i],
  },

  // ইংরেজি
  {
    id: 'right-form-of-verbs',
    label: 'Right Form of Verbs',
    subjectGroup: 'ইংরেজি',
    keywords: ['right form of verbs', 'right form of verb', 'verb form', 'subject verb agreement'],
    patterns: [
      /right\s*form\s*of\s*verbs?/i,
      /subject[\s-]*verb\s*agreement/i,
      /use\s+the\s+correct\s+(?:form\s+of\s+)?verb/i,
      /\b(?:tense|verb\s+form|conditional|had\s+better|would\s+rather|lest\s+.+should)\b/i,
    ],
  },
  {
    id: 'preposition-articles',
    label: 'Preposition & Articles',
    subjectGroup: 'ইংরেজি',
    keywords: ['preposition', 'article', 'fill in the gap', 'fill in the blank'],
    patterns: [/appropriate\s*(?:article|preposition)|preposition|fill\s*in\s*the\s*(?:gap|blank)/i],
  },
  {
    id: 'voice-narration',
    label: 'Voice, Narration & Transformation',
    subjectGroup: 'ইংরেজি',
    keywords: ['voice', 'passive', 'active', 'narration', 'indirect', 'transformation'],
    patterns: [/\b(?:passive|active)\s*voice|narration|indirect\s*speech|transformation|complex|compound|simple\s*sentence/i],
  },
  {
    id: 'translation',
    label: 'Translation (বাংলা ↔ ইংরেজি)',
    subjectGroup: 'ইংরেজি',
    keywords: ['translate', 'translation', 'অনুবাদ', 'ইংরেজিতে অনুবাদ'],
    patterns: [/translate\s*into|translation|অনুবাদ\s*করুন|ইংরেজিতে\s*অনুবাদ|বাংলায়\s*অনুবাদ/i],
  },
  {
    id: 'vocabulary-idioms',
    label: 'Synonym, Antonym & Idioms',
    subjectGroup: 'ইংরেজি',
    keywords: ['synonym', 'antonym', 'idiom', 'phrase', 'one word substitution', 'spelling'],
    patterns: [/\b(?:synonym|antonym|idiom|phrase|meaning\s+of\s+the\s+word|spelling|singular|plural)\b/i],
  },
  {
    id: 'english-grammar-correction',
    label: 'Sentence Correction & Parts of Speech',
    subjectGroup: 'ইংরেজি',
    keywords: ['parts of speech', 'correct sentence', 'which sentence is correct', 'noun', 'adjective', 'adverb'],
    patterns: [/which\s*sentence\s*is\s*correct|sentence\s*correction|parts\s*of\s*speech|is\s+a\/an\s*-|noun|adjective|adverb|pronoun/i],
  },

  // গণিত ও মানসিক দক্ষতা
  {
    id: 'math-geometry',
    label: 'Math Geometry (জ্যামিতি)',
    subjectGroup: 'গণিত ও মানসিক দক্ষতা',
    keywords: ['geometry', 'জ্যামিতি', 'ত্রিভুজ', 'বৃত্ত', 'চতুর্ভুজ', 'কোণ', 'ক্ষেত্রফল', 'পরিসীমা', 'আয়তক্ষেত্র', 'বর্গক্ষেত্র'],
    patterns: [
      /\bgeometry\b|জ্যামিতি|ত্রিভুজ|চতুর্ভুজ|বৃত্ত|সমকোণী|সমবাহু|রম্বস|ট্রাপিজিয়াম|আয়তক্ষেত্র|বর্গক্ষেত্র|ক্ষেত্রফল|পরিসীমা|কর্ণ|ব্যাসার্ধ|ব্যাস|কোণ|\b(?:triangle|circle|angle|rectangle|square|perimeter|area|radius|diameter)\b/i,
    ],
  },
  {
    id: 'math-arithmetic',
    label: 'Math Arithmetic (পাটিগণিত ও শতকরা)',
    subjectGroup: 'গণিত ও মানসিক দক্ষতা',
    keywords: ['শতকরা', 'লাভ-ক্ষতি', 'সুদ', 'মুনাফা', 'অনুপাত', 'গড়', 'মিশ্রণ', 'শতকরা', 'percentage', 'profit', 'interest'],
    patterns: [
      /শতকরা|লাভ[\s-]*ক্ষতি|চক্রবৃদ্ধি|সরল\s*মুনাফা|সুদ|অনুপাত|মিশ্রণ|গড়|ভগ্নাংশ|ল\.?\s*সা\.?\s*গু|গ\.?\s*সা\.?\s*গু|কাজ|নল|চৌবাচ্চা|নৌকা|স্রোত|ট্রেন|\b(?:percentage|profit|loss|ratio|interest|average)\b/i,
    ],
  },
  {
    id: 'math-algebra',
    label: 'Math Algebra (বীজগণিত ও সমীকরণ)',
    subjectGroup: 'গণিত ও মানসিক দক্ষতা',
    keywords: ['বীজগণিত', 'উৎপাদক', 'মান নির্ণয়', 'সমীকরণ', 'লগারিদম', 'সূচক', 'ধারা', 'algebra'],
    patterns: [
      /\balgebra\b|বীজগণিত|উৎপাদক|মান\s*নির্ণয়|সমীকরণ|লগারিদম|সূচক|সমান্তর\s*ধারা|গুণোত্তর\s*ধারা|বিন্যাস|সমাবেশ|সম্ভাব্যতা|x\^2|x²|\blog\b/i,
    ],
  },
  {
    id: 'mental-ability',
    label: 'মানসিক দক্ষতা (Mental Ability)',
    subjectGroup: 'গণিত ও মানসিক দক্ষতা',
    keywords: ['মানসিক দক্ষতা', 'কোন সংখ্যাটি পরে আসবে', 'দিক নির্ণয়', 'রক্তের সম্পর্ক', 'ঘড়ি', 'ক্যালেন্ডার'],
    patterns: [/মানসিক\s*দক্ষতা|কোন\s*সংখ্যাটি\s*পরে\s*আসবে|লুপ্ত\s*সংখ্যা|দিক\s*নির্ণয়|রক্তের\s*সম্পর্ক|মিরর|দর্পণ/i],
  },

  // সাধারণ জ্ঞান ও বিজ্ঞান
  {
    id: 'bangladesh-constitution',
    label: 'বাংলাদেশ বিষয়াবলি ও সংবিধান',
    subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
    keywords: ['সংবিধান', 'মুক্তিযুদ্ধ', 'অনুচ্ছেদ', 'বাংলাদেশ', 'নদী', 'সংসদ', 'জেলা'],
    patterns: [/সংবিধান|অনুচ্ছেদ|মুক্তিযুদ্ধ|জাতীয়\s*সংসদ|বঙ্গবন্ধু|ভাষা\s*আন্দোলন|নদী|পদ্মা|মেঘনা|হালদা|বাংলাদেশের/i],
  },
  {
    id: 'economy-banking',
    label: 'অর্থনীতি ও ব্যাংকিং',
    subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
    keywords: ['অর্থনীতি', 'বাংলাদেশ ব্যাংক', 'মুদ্রানীতি', 'বাজেট', 'জিডিপি', 'এলডিসি', 'বাণিজ্যিক ব্যাংক'],
    patterns: [/মুদ্রানীতি|বাংলাদেশ\s*ব্যাংক|বাণিজ্যিক\s*ব্যাংক|বাজেট|জিডিপি|GDP|LDC|মুদ্রাস্ফীতি|রেমিট্যান্স|রপ্তানি|ব্যাংকিং|অর্থনীতি/i],
  },
  {
    id: 'international-affairs',
    label: 'আন্তর্জাতিক বিষয়াবলি',
    subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
    keywords: ['জাতিসংঘ', 'সদর দপ্তর', 'মুদ্রা', 'রাজধানী', 'চুক্তি', 'সম্মেলন', 'নিরাপত্তা পরিষদ'],
    patterns: [/জাতিসংঘ|সদর\s*দপ্তর|রাজধানী|মুদ্রা|নিরাপত্তা\s*পরিষদ|প্যারিস\s*চুক্তি|জলবায়ু|UNEP|UNESCO|WHO|IMF|BRICS|আন্তর্জাতিক/i],
  },
  {
    id: 'general-science',
    label: 'সাধারণ বিজ্ঞান',
    subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
    keywords: ['ভিটামিন', 'রক্ত', 'বিজ্ঞান', 'কোষ', 'অম্ল', 'ক্ষার', 'রাসায়নিক', 'হরমোন'],
    patterns: [/ভিটামিন|রক্তদান|হরমোন|পিটুইটারি|Pituitary|জেনেটিক|ন্যানোটেকনোলজি|ফটোসিন্থেসিস|রাসায়নিক|তাপমাত্রা|বিজ্ঞান|ভৌত/i],
  },
  {
    id: 'current-gk',
    label: 'সাম্প্রতিক সাধারণ জ্ঞান (Current GK)',
    subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
    keywords: ['সাম্প্রতিক', 'পেপার কাটিং', '২০২৫', '২০২৬', 'পুরস্কার', 'মেগা প্রকল্প', 'MRT'],
    patterns: [/সাম্প্রতিক|পেপার\s*কাটিং|মেগা\s*প্রকল্প|মেট্রোরেল|MRT|মাতারবাড়ী|নোবেল|২০২[৪-৭]/i],
  },

  // কম্পিউটার ও ICT
  {
    id: 'computer-ict',
    label: 'কম্পিউটার ও তথ্যপ্রযুক্তি (ICT)',
    subjectGroup: 'কম্পিউটার ও ICT',
    keywords: ['কম্পিউটার', 'protocol', 'TCP/IP', 'internet', 'database', 'CPU', 'RAM', 'ICT', 'software'],
    patterns: [/\b(?:TCP\/IP|HTTP|DNS|URL|CPU|RAM|ROM|SQL|HTML|OS|Linux|IP|LAN|WAN|protocol|internet|software|hardware|database|malware|phishing)\b|কম্পিউটার|তথ্যপ্রযুক্তি|ইন্টারনেট|নেটওয়ার্ক|প্রোগ্রামিং/i],
  },
] as const;

export const FALLBACK_SYLLABUS_TOPIC: {
  id: string;
  label: string;
  subjectGroup: SyllabusSubjectGroup;
} = {
  id: 'general-mixed',
  label: 'অন্যান্য / সাধারণ টপিক',
  subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
};

const TOPIC_BY_LABEL = new Map<string, SyllabusTopicDefinition>(
  SYLLABUS_TOPICS.map((t) => [t.label.toLowerCase(), t])
);

const TOPIC_BY_ID = new Map<string, SyllabusTopicDefinition>(
  SYLLABUS_TOPICS.map((t) => [t.id, t])
);

export function resolveCanonicalSyllabusTopic(
  rawTopicLabel: string | null | undefined
): { id: string; label: string; subjectGroup: SyllabusSubjectGroup } | null {
  if (!rawTopicLabel) return null;
  const cleaned = rawTopicLabel.trim();
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();

  const exactByLabel = TOPIC_BY_LABEL.get(lower);
  if (exactByLabel) {
    return {
      id: exactByLabel.id,
      label: exactByLabel.label,
      subjectGroup: exactByLabel.subjectGroup,
    };
  }
  const exactById = TOPIC_BY_ID.get(lower);
  if (exactById) {
    return {
      id: exactById.id,
      label: exactById.label,
      subjectGroup: exactById.subjectGroup,
    };
  }

  for (const def of SYLLABUS_TOPICS) {
    if (
      def.keywords.some((kw) => lower.includes(kw.toLowerCase())) ||
      def.patterns.some((re) => re.test(cleaned))
    ) {
      return { id: def.id, label: def.label, subjectGroup: def.subjectGroup };
    }
  }
  return null;
}

/**
 * Deterministic academic syllabus topic classifier for any question stem/chapter/subject.
 */
export function classifyQuestionSyllabusTopic(
  text: string,
  hint?: { chapter?: string; subject?: string; existingTopic?: string }
): { id: string; label: string; subjectGroup: SyllabusSubjectGroup } {
  const stem = (text || '').trim();
  const chapter = (hint?.chapter || '').trim();
  const existingTopic = (hint?.existingTopic || '').trim();

  // 1. Check explicit tag already embedded in chapter (e.g. "সন্ধি বিচ্ছেদ (Sandhi Bicched) · অধ্যায় ১")
  if (chapter) {
    const firstPart = chapter.split('·')[0]?.trim() || chapter;
    const fromChapter = resolveCanonicalSyllabusTopic(firstPart);
    if (fromChapter) return fromChapter;
  }

  // 2. Check stem patterns with priority ordering
  for (const def of SYLLABUS_TOPICS) {
    if (def.patterns.some((re) => re.test(stem))) {
      return { id: def.id, label: def.label, subjectGroup: def.subjectGroup };
    }
  }

  // 3. Check existing analyzer topic or combined hint text
  const combinedHint = [existingTopic, chapter, hint?.subject || '']
    .filter(Boolean)
    .join(' ');
  if (combinedHint) {
    const fromHint = resolveCanonicalSyllabusTopic(combinedHint);
    if (fromHint) return fromHint;
  }

  return FALLBACK_SYLLABUS_TOPIC;
}

export interface TaggedQuestionEntry {
  uid: string;
  sourceKind: 'book' | 'bank';
  questionId: number | null;
  bookId: number | null;
  bookTitle: string;
  examTitle: string;
  pageNumber: number;
  format: 'MCQ' | 'Written' | 'Short';
  stem: string;
  options: string[];
  answerText: string;
  topicId: string;
  topicLabel: string;
  subjectGroup: SyllabusSubjectGroup;
  taggedBy: 'ai' | 'auto';
  confidence?: number;
}

export interface SyllabusTopicCluster {
  topicId: string;
  topicLabel: string;
  subjectGroup: SyllabusSubjectGroup;
  totalCount: number;
  mcqCount: number;
  writtenCount: number;
  bookTitles: string[];
  items: TaggedQuestionEntry[];
}

export interface AiTopicTagOverride {
  topicLabel: string;
  subjectGroup?: SyllabusSubjectGroup;
  confidence?: number;
}

export const AI_TOPIC_TAGS_STORAGE_KEY = 'prostuti_ai_topic_tags_v1';

export function loadAiTopicTagOverrides(): Record<string, AiTopicTagOverride> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(AI_TOPIC_TAGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, AiTopicTagOverride>;
  } catch {
    return {};
  }
}

export function saveAiTopicTagOverrides(
  overrides: Record<string, AiTopicTagOverride>
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      AI_TOPIC_TAGS_STORAGE_KEY,
      JSON.stringify(overrides)
    );
  } catch {
    // ignore storage quota errors
  }
}

/**
 * Extracts and clusters all questions across ALL imported books + Question Bank
 * into canonical academic syllabus categories.
 */
export function buildCrossBookTopicClusters(params: {
  books: ReadonlyArray<Book>;
  questions: ReadonlyArray<Question>;
  aiTagOverrides?: Record<string, AiTopicTagOverride>;
}): {
  entries: TaggedQuestionEntry[];
  clusters: SyllabusTopicCluster[];
} {
  const overrides = params.aiTagOverrides ?? {};
  const entries: TaggedQuestionEntry[] = [];
  const seenKeys = new Set<string>();

  // 1. Extract all parsed questions from every imported book
  for (const book of params.books) {
    if (!book.chunks || book.chunks.length === 0) continue;
    const intel = analyzeBookOrSeriesQuestions([book]);
    const analyzedItems: AnalyzedQuestionItem[] = intel.questions;
    for (const q of analyzedItems) {
      const uid = `book:${book.id}:${q.id}`;
      const dedupeKey = `${book.id}:${q.questionText.slice(0, 90).toLowerCase()}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      const override = overrides[uid];
      const resolvedOverride = override
        ? resolveCanonicalSyllabusTopic(override.topicLabel)
        : null;
      const baseTag = classifyQuestionSyllabusTopic(q.questionText, {
        existingTopic: q.topic,
        subject: book.subject,
      });

      const finalTopic = resolvedOverride ?? baseTag;
      entries.push({
        uid,
        sourceKind: 'book',
        questionId: null,
        bookId: book.id,
        bookTitle: book.title,
        examTitle: q.examTitle || book.title,
        pageNumber: q.pageNumber || 1,
        format: q.format,
        stem: q.questionText,
        options: q.options.map((o) => o.text),
        answerText:
          q.answerText ||
          (q.solutionSteps.length > 0 ? q.solutionSteps.join(' ') : ''),
        topicId: finalTopic.id,
        topicLabel:
          override && !resolvedOverride
            ? override.topicLabel
            : finalTopic.label,
        subjectGroup: override?.subjectGroup ?? finalTopic.subjectGroup,
        taggedBy: override ? 'ai' : 'auto',
        confidence: override?.confidence,
      });
    }
  }

  // 2. Include all Question Bank items
  for (const q of params.questions) {
    const uid = `bank:${q.id}`;
    const override = overrides[uid];
    const resolvedOverride = override
      ? resolveCanonicalSyllabusTopic(override.topicLabel)
      : null;
    const baseTag = classifyQuestionSyllabusTopic(q.stem, {
      chapter: q.chapter,
      subject: q.subject,
    });
    const finalTopic = resolvedOverride ?? baseTag;

    entries.push({
      uid,
      sourceKind: 'bank',
      questionId: q.id,
      bookId: q.bookId,
      bookTitle: q.bookTitle,
      examTitle: q.examSource
        ? `${q.examSource}${q.examYear ? ` (${q.examYear})` : ''}`
        : q.chapter,
      pageNumber: q.pageNumber || 1,
      format: q.questionType,
      stem: q.stem,
      options: q.options,
      answerText: q.modelAnswer,
      topicId: finalTopic.id,
      topicLabel:
        override && !resolvedOverride ? override.topicLabel : finalTopic.label,
      subjectGroup: override?.subjectGroup ?? finalTopic.subjectGroup,
      taggedBy: override ? 'ai' : 'auto',
      confidence: override?.confidence,
    });
  }

  // 3. Cluster entries by topicLabel
  const clusterMap = new Map<string, SyllabusTopicCluster>();
  for (const entry of entries) {
    const key = entry.topicLabel;
    let bucket = clusterMap.get(key);
    if (!bucket) {
      bucket = {
        topicId: entry.topicId,
        topicLabel: entry.topicLabel,
        subjectGroup: entry.subjectGroup,
        totalCount: 0,
        mcqCount: 0,
        writtenCount: 0,
        bookTitles: [],
        items: [],
      };
      clusterMap.set(key, bucket);
    }
    bucket.totalCount += 1;
    if (entry.format === 'MCQ') {
      bucket.mcqCount += 1;
    } else {
      bucket.writtenCount += 1;
    }
    if (entry.bookTitle && !bucket.bookTitles.includes(entry.bookTitle)) {
      bucket.bookTitles.push(entry.bookTitle);
    }
    bucket.items.push(entry);
  }

  const clusters = Array.from(clusterMap.values()).sort(
    (a, b) => b.totalCount - a.totalCount || a.topicLabel.localeCompare(b.topicLabel)
  );

  return { entries, clusters };
}

export interface ParsedDemoBlueprint {
  detectedTopics: string[];
  detectedMcqHintCount: number | null;
  detectedWrittenHintCount: number | null;
  hasMcqSection: boolean;
  hasWrittenSection: boolean;
  cleanedText: string;
}

const BENGALI_TO_ASCII_DIGITS: Record<string, string> = {
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

function normalizeDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => BENGALI_TO_ASCII_DIGITS[d] ?? d);
}

/**
 * Parses a user-supplied Demo Question (sample exam paper / syllabus note)
 * to extract target academic syllabus topics and optional MCQ/Written counts.
 */
export function parseDemoQuestionBlueprint(
  demoText: string | null | undefined
): ParsedDemoBlueprint {
  const cleanedText = (demoText ?? '').trim();
  if (!cleanedText) {
    return {
      detectedTopics: [],
      detectedMcqHintCount: null,
      detectedWrittenHintCount: null,
      hasMcqSection: false,
      hasWrittenSection: false,
      cleanedText: '',
    };
  }

  const detectedSet = new Set<string>();
  const lines = cleanedText.split(/\r?\n/);

  for (const def of SYLLABUS_TOPICS) {
    if (
      def.patterns.some((re) => re.test(cleanedText)) ||
      def.keywords.some((kw) =>
        cleanedText.toLowerCase().includes(kw.toLowerCase())
      )
    ) {
      detectedSet.add(def.label);
    }
  }

  const asciiText = normalizeDigits(cleanedText);
  const mcqCountMatch = asciiText.match(
    /(?:mcq|বহুনির্বাচনি|প্রিলি)[^\n\d]{0,18}(\d{1,2})|(\d{1,2})\s*(?:টি\s*)?(?:mcq|বহুনির্বাচনি)/i
  );
  const writtenCountMatch = asciiText.match(
    /(?:written|লিখিত)[^\n\d]{0,18}(\d{1,2})|(\d{1,2})\s*(?:টি\s*)?(?:written|লিখিত)/i
  );

  const detectedMcqHintCount = mcqCountMatch
    ? Math.min(25, Math.max(1, Number(mcqCountMatch[1] || mcqCountMatch[2])))
    : null;
  const detectedWrittenHintCount = writtenCountMatch
    ? Math.min(
        12,
        Math.max(1, Number(writtenCountMatch[1] || writtenCountMatch[2]))
      )
    : null;

  const hasMcqSection =
    /\bMCQ\b|বহুনির্বাচনি|ক\)|খ\)|গ\)|ঘ\)/i.test(cleanedText) ||
    detectedMcqHintCount !== null;
  const hasWrittenSection =
    /\bWritten\b|লিখিত|সন্ধি\s*বিচ্ছেদ\s*করুন|অনুবাদ\s*করুন|টীকা|রচনা|ভাবসম্প্রসারণ|উত্তর\s*লিখুন/i.test(
      cleanedText
    ) ||
    lines.length >= 2 ||
    detectedWrittenHintCount !== null;

  return {
    detectedTopics: Array.from(detectedSet),
    detectedMcqHintCount,
    detectedWrittenHintCount,
    hasMcqSection,
    hasWrittenSection,
    cleanedText,
  };
}

/**
 * Selects high-relevance, balanced source chunks across all chosen books
 * tailored to the user's Demo Question blueprint and selected syllabus topics.
 */
export function selectChunksForExamBlueprint(params: {
  books: ReadonlyArray<Book>;
  selectedBookIds: ReadonlyArray<number>;
  demoText?: string;
  selectedTopics?: ReadonlyArray<string>;
  topicHint?: string;
  topK?: number;
}): BookChunk[] {
  const topK = params.topK ?? 10;
  const chosenBooks = params.books.filter((b) =>
    params.selectedBookIds.includes(b.id)
  );
  if (chosenBooks.length === 0) return [];

  const allChunks = chosenBooks.flatMap((b) => b.chunks);
  if (allChunks.length === 0) return [];

  const blueprint = parseDemoQuestionBlueprint(params.demoText);
  const queryParts = [
    ...(params.selectedTopics ?? []),
    ...blueprint.detectedTopics,
    params.topicHint?.trim() ?? '',
    blueprint.cleanedText.slice(0, 300),
    ...chosenBooks.map((b) => b.subject),
  ].filter(Boolean);

  const combinedQuery = queryParts.join(' ');
  const ranked = rankChunksHybrid(allChunks, combinedQuery, {
    topK: Math.min(allChunks.length, topK * 2),
  });

  // Ensure every selected book gets representation when multiple books are selected
  const picked: BookChunk[] = [];
  const pickedIds = new Set<number>();

  if (chosenBooks.length > 1) {
    for (const book of chosenBooks) {
      const bestForBook =
        ranked.find((c) => c.bookId === book.id && !pickedIds.has(c.id)) ??
        book.chunks[0];
      if (bestForBook && !pickedIds.has(bestForBook.id)) {
        picked.push(bestForBook);
        pickedIds.add(bestForBook.id);
      }
      if (picked.length >= topK) break;
    }
  }

  for (const chunk of ranked) {
    if (picked.length >= topK) break;
    if (!pickedIds.has(chunk.id)) {
      picked.push(chunk);
      pickedIds.add(chunk.id);
    }
  }

  // Fallback if ranking returned fewer than needed
  if (picked.length < Math.min(topK, allChunks.length)) {
    for (const chunk of allChunks) {
      if (picked.length >= topK) break;
      if (!pickedIds.has(chunk.id)) {
        picked.push(chunk);
        pickedIds.add(chunk.id);
      }
    }
  }

  return picked;
}

export const JOB_EXAM_PRESETS = [
  {
    id: 'govt-mixed',
    label: 'সরকারি চাকরি (মন্ত্রণালয় / অধিদপ্তর — MCQ + Written)',
    defaultMcq: 6,
    defaultWritten: 3,
  },
  {
    id: 'bcs-preli-written',
    label: 'বিসিএস প্যাটার্ন (BCS Standard)',
    defaultMcq: 8,
    defaultWritten: 3,
  },
  {
    id: 'bank-job',
    label: 'ব্যাংক নিয়োগ (Bangladesh Bank / Combined Bank)',
    defaultMcq: 6,
    defaultWritten: 4,
  },
  {
    id: 'primary-ntrca',
    label: 'প্রাথমিক শিক্ষক / NTRCA প্যাটার্ন',
    defaultMcq: 8,
    defaultWritten: 2,
  },
] as const;

export const DEMO_QUESTION_TEMPLATES = [
  {
    id: 'ministry-demo',
    label: 'মন্ত্রণালয় Written + MCQ ডেমো',
    text: `অংশ-ক (MCQ): ৬টি প্রশ্ন — বাংলা ব্যাকরণ (সন্ধি বিচ্ছেদ, সমাস), English (Right Form of Verbs, Preposition), গণিত ও সাধারণ জ্ঞান।
অংশ-খ (Written): ৩টি প্রশ্ন —
১. সন্ধি বিচ্ছেদ করুন এবং এক কথায় প্রকাশ লিখুন।
২. Right Form of Verbs ও Translation (বাংলা থেকে ইংরেজি)।
৩. Math Geometry (জ্যামিতি) অথবা পাটিগণিত থেকে ১টি সমাধানমূলক অংক।`,
  },
  {
    id: 'bcs-bank-demo',
    label: 'ব্যাংক / বিসিএস প্যাটার্ন ডেমো',
    text: `MCQ ৮টি প্রশ্ন: সংবিধান, অর্থনীতি ও ব্যাংকিং, কম্পিউটার ও ICT, ইংরেজি Synonym/Antonym ও গণিত।
Written ৩টি প্রশ্ন:
১. বাংলাদেশের অর্থনীতি ও ব্যাংকিং / সংবিধান থেকে বিশ্লেষণধর্মী প্রশ্ন।
২. ইংরেজি থেকে বাংলা ও বাংলা থেকে ইংরেজি অনুবাদ (Translation)।
৩. Math Arithmetic (শতকরা/লাভ-ক্ষতি) বা Math Geometry থেকে সমাধান।`,
  },
] as const;
