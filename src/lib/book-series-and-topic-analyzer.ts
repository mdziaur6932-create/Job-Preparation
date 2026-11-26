import type { Book, BookChunk } from '../types/system';
import {
  extractExamTitleFromText,
  normalizeExamDocumentFormatting,
  parseExamDocumentForDisplay,
} from './exam-text-formatter';
import {
  buildSmartReaderViews,
  type SmartReaderViewUnit,
} from './reader-page-grouper';

export type QuestionFormatType = 'MCQ' | 'Written';
export type ExamPaperFormatType = 'MCQ' | 'Written' | 'Mixed';
export type RepeatPriorityTier = 'very_high' | 'high';

export interface BookSeriesIdentity {
  seriesKey: string;
  seriesTitle: string;
  partNumber: number | null;
  partLabel: string | null;
}

export interface BookSeriesPartRange {
  bookId: number;
  bookTitle: string;
  partNumber: number | null;
  partLabel: string;
  originalPages: number;
  startOffsetPage: number;
  endOffsetPage: number;
}

export interface BookSeriesGroup {
  seriesKey: string;
  seriesTitle: string;
  books: Book[];
  isMultiPart: boolean;
  primaryBookId: number;
  totalPages: number;
  subject: string;
  category: Book['category'];
  partRanges: BookSeriesPartRange[];
  combinedChunks: BookChunk[];
}

export interface ExtractedExamMetadata {
  examId: string;
  examTitle: string;
  institution: string;
  postName: string | null;
  examDate: string | null;
  partLabel: string | null;
  bookId: number;
  bookTitle: string;
  pageLabel: string;
  startPage: number;
  endPage: number;
  format: ExamPaperFormatType;
  mcqCount: number;
  writtenCount: number;
  questionCount: number;
}

export interface AnalyzedQuestionItem {
  id: string;
  examId: string;
  examTitle: string;
  institution: string;
  postName: string | null;
  examDate: string | null;
  partLabel: string | null;
  bookId: number;
  bookTitle: string;
  pageLabel: string;
  pageNumber: number;
  numberLabel: string;
  questionNumber: number;
  questionText: string;
  options: Array<{ marker: string; text: string }>;
  answerLabel: string;
  answerText: string;
  explanation?: string;
  solutionSteps: string[];
  format: QuestionFormatType;
  topic: string;
  subjectGroup: string;
  isAiGenerated: boolean;
  references: string[];
  highlights: string[];
}

export interface TopicBucketSummary {
  topic: string;
  subjectGroup: string;
  totalCount: number;
  mcqCount: number;
  writtenCount: number;
  examCount: number;
  items: AnalyzedQuestionItem[];
}

export interface RepeatedQuestionOccurrence {
  examId: string;
  examTitle: string;
  institution: string;
  postName: string | null;
  examDate: string | null;
  partLabel: string | null;
  bookTitle: string;
  pageLabel: string;
  numberLabel: string;
}

export interface RepeatedQuestionGroup {
  id: string;
  canonicalQuestion: string;
  options: Array<{ marker: string; text: string }>;
  answerLabel: string;
  answerText: string;
  format: QuestionFormatType;
  topic: string;
  subjectGroup: string;
  repeatCount: number;
  distinctExamCount: number;
  importanceScore: number;
  priorityTier: RepeatPriorityTier;
  priorityLabel: string;
  isSubItem: boolean;
  occurrences: RepeatedQuestionOccurrence[];
}

export interface BookIntelligenceReport {
  seriesTitle: string;
  isMultiPart: boolean;
  partCount: number;
  totalExams: number;
  totalQuestions: number;
  mcqQuestionCount: number;
  writtenQuestionCount: number;
  mcqExamCount: number;
  writtenExamCount: number;
  mixedExamCount: number;
  exams: ExtractedExamMetadata[];
  examFormatByViewId: Record<
    string,
    {
      format: ExamPaperFormatType;
      mcqCount: number;
      writtenCount: number;
      institution: string;
      postName: string | null;
      examDate: string | null;
      partLabel: string | null;
    }
  >;
  questions: AnalyzedQuestionItem[];
  topicBuckets: TopicBucketSummary[];
  repeatedQuestions: RepeatedQuestionGroup[];
}

function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (ch) => String('০১২৩৪৫৬৭৮৯'.indexOf(ch)));
}

const BENGALI_ORDINAL_MAP: Record<string, number> = {
  প্রথম: 1,
  দ্বিতীয়: 2,
  দ্বিতীয়: 2,
  তৃতীয়: 3,
  তৃতীয়: 3,
  চতুর্থ: 4,
  পঞ্চম: 5,
  ষষ্ঠ: 6,
  সপ্তম: 7,
  অষ্টম: 8,
  নবম: 9,
  দশম: 10,
};

/**
 * Parses a book title to detect multi-part series identity (e.g.,
 * "Recent Job SOLUTION Part 01", "Recent Job SOLUTION Part-2",
 * "বাংলা ব্যাকরণ খণ্ড ১", "অগ্রদূত জব সলিউশন পর্ব ২").
 */
export function parseBookSeriesIdentity(rawTitle: string): BookSeriesIdentity {
  const cleaned = (rawTitle ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return {
      seriesKey: 'untitled',
      seriesTitle: 'শিরোনামহীন বই',
      partNumber: null,
      partLabel: null,
    };
  }

  // Pattern 1: English Part / Pt / Vol / Volume / Book / Set / Segment with number
  const englishPartRe =
    /^(.*?)(?:[\s\-–—_:([]+(?:part|pt\.?|vol\.?|volume|book|set|segment)[\s\-–—_.:#]*([0-9০-৯]{1,3})[\)\]]*)$/i;
  const engMatch = cleaned.match(englishPartRe);
  if (engMatch && engMatch[1].trim().length >= 2) {
    const base = engMatch[1].replace(/[\s\-–—_:([]+$/, '').trim();
    const num = Number.parseInt(toAsciiDigits(engMatch[2]), 10);
    const matchedTail = cleaned.slice(engMatch[1].length).replace(/^[\s\-–—_:([]+|[\)\]]+$/g, '').trim();
    return {
      seriesKey: base.toLowerCase().replace(/[^a-z0-9\u0980-\u09FF]+/g, ' ').trim(),
      seriesTitle: base,
      partNumber: Number.isFinite(num) ? num : null,
      partLabel: matchedTail || `Part ${String(num).padStart(2, '0')}`,
    };
  }

  // Pattern 2: Bengali পার্ট / পর্ব / খণ্ড / ভাগ / অংশ + number
  const bengaliNumPartRe =
    /^(.*?)(?:[\s\-–—_:([]+(?:পার্ট|পর্ব|খণ্ড|খন্ড|ভাগ|অংশ)[\s\-–—_.:#]*([0-9০-৯]{1,3})[\)\]]*)$/;
  const bnMatch = cleaned.match(bengaliNumPartRe);
  if (bnMatch && bnMatch[1].trim().length >= 2) {
    const base = bnMatch[1].replace(/[\s\-–—_:([]+$/, '').trim();
    const num = Number.parseInt(toAsciiDigits(bnMatch[2]), 10);
    const matchedTail = cleaned.slice(bnMatch[1].length).replace(/^[\s\-–—_:([]+|[\)\]]+$/g, '').trim();
    return {
      seriesKey: base.toLowerCase().replace(/[^a-z0-9\u0980-\u09FF]+/g, ' ').trim(),
      seriesTitle: base,
      partNumber: Number.isFinite(num) ? num : null,
      partLabel: matchedTail || `পর্ব ${num}`,
    };
  }

  // Pattern 3: Bengali ordinal + খণ্ড / পর্ব / ভাগ (e.g. "প্রথম খণ্ড")
  const bengaliOrdinalRe =
    /^(.*?)(?:[\s\-–—_:([]+(প্রথম|দ্বিতীয়|দ্বিতীয়|তৃতীয়|তৃতীয়|চতুর্থ|পঞ্চম|ষষ্ঠ|সপ্তম|অষ্টম|নবম|দশম)\s+(?:খণ্ড|খন্ড|পর্ব|ভাগ|অংশ)[\)\]]*)$/;
  const ordMatch = cleaned.match(bengaliOrdinalRe);
  if (ordMatch && ordMatch[1].trim().length >= 2) {
    const base = ordMatch[1].replace(/[\s\-–—_:([]+$/, '').trim();
    const num = BENGALI_ORDINAL_MAP[ordMatch[2]] ?? null;
    const matchedTail = cleaned.slice(ordMatch[1].length).replace(/^[\s\-–—_:([]+|[\)\]]+$/g, '').trim();
    return {
      seriesKey: base.toLowerCase().replace(/[^a-z0-9\u0980-\u09FF]+/g, ' ').trim(),
      seriesTitle: base,
      partNumber: num,
      partLabel: matchedTail || null,
    };
  }

  // Pattern 4: Trailing parenthesized/bracketed small part number, e.g. "Recent Job Solution (2)"
  const parenNumRe = /^(.*?)\s*[\(\[]\s*([0-9০-৯]{1,2})\s*[\)\]]$/;
  const parenMatch = cleaned.match(parenNumRe);
  if (parenMatch && parenMatch[1].trim().length >= 3) {
    const base = parenMatch[1].replace(/[\s\-–—_]+$/, '').trim();
    const num = Number.parseInt(toAsciiDigits(parenMatch[2]), 10);
    if (Number.isFinite(num) && num >= 1 && num <= 50) {
      return {
        seriesKey: base.toLowerCase().replace(/[^a-z0-9\u0980-\u09FF]+/g, ' ').trim(),
        seriesTitle: base,
        partNumber: num,
        partLabel: `Part ${String(num).padStart(2, '0')}`,
      };
    }
  }

  return {
    seriesKey: cleaned.toLowerCase().replace(/[^a-z0-9\u0980-\u09FF]+/g, ' ').trim(),
    seriesTitle: cleaned,
    partNumber: null,
    partLabel: null,
  };
}

/**
 * Groups multi-part books (e.g. "Recent Job SOLUTION Part 01" + "Part 02",
 * or duplicate-named split uploads of the same book) into unified logical Book Series
 * with continuous, collision-free page numbers.
 */
export function groupBooksIntoSeries(books: Book[]): BookSeriesGroup[] {
  if (!books || books.length === 0) return [];

  const grouped = new Map<string, { seriesTitle: string; items: Array<{ book: Book; identity: BookSeriesIdentity }> }>();

  for (const book of books) {
    const identity = parseBookSeriesIdentity(book.title);
    const existing = grouped.get(identity.seriesKey);
    if (existing) {
      existing.items.push({ book, identity });
    } else {
      grouped.set(identity.seriesKey, {
        seriesTitle: identity.seriesTitle,
        items: [{ book, identity }],
      });
    }
  }

  const seriesList: BookSeriesGroup[] = [];

  for (const [seriesKey, entry] of grouped.entries()) {
    // Sort parts logically: partNumber ASC -> createdAt ASC -> id ASC
    const sorted = [...entry.items].sort((a, b) => {
      const pa = a.identity.partNumber ?? Number.MAX_SAFE_INTEGER;
      const pb = b.identity.partNumber ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      if (a.book.createdAt !== b.book.createdAt) {
        return a.book.createdAt.localeCompare(b.book.createdAt);
      }
      return a.book.id - b.book.id;
    });

    const partRanges: BookSeriesPartRange[] = [];
    const combinedChunks: BookChunk[] = [];
    let pageOffset = 0;
    let runningChunkIndex = 0;

    sorted.forEach(({ book, identity }, partIdx) => {
      const partLabel =
        identity.partLabel ||
        (sorted.length > 1 ? `Part ${String(partIdx + 1).padStart(2, '0')}` : 'মূল বই');
      const sortedChunks = [...book.chunks].sort(
        (a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex || a.id - b.id
      );
      const maxChunkPage =
        sortedChunks.length > 0
          ? Math.max(...sortedChunks.map((c) => c.pageNumber))
          : 0;
      const span = Math.max(book.totalPages || 0, maxChunkPage, 1);

      const startOffsetPage = pageOffset + 1;
      const endOffsetPage = pageOffset + span;

      partRanges.push({
        bookId: book.id,
        bookTitle: book.title,
        partNumber: identity.partNumber ?? partIdx + 1,
        partLabel,
        originalPages: span,
        startOffsetPage,
        endOffsetPage,
      });

      for (const chunk of sortedChunks) {
        combinedChunks.push({
          ...chunk,
          bookTitle: sorted.length > 1 ? `${entry.seriesTitle} (${partLabel})` : book.title,
          pageNumber: pageOffset + Math.max(1, chunk.pageNumber),
          chunkIndex: runningChunkIndex++,
        });
      }

      pageOffset += span;
    });

    const primaryBook = sorted[0].book;
    seriesList.push({
      seriesKey,
      seriesTitle: entry.seriesTitle,
      books: sorted.map((s) => s.book),
      isMultiPart: sorted.length > 1,
      primaryBookId: primaryBook.id,
      totalPages: Math.min(10000, Math.max(1, pageOffset)),
      subject: primaryBook.subject,
      category: primaryBook.category,
      partRanges,
      combinedChunks,
    });
  }

  return seriesList;
}

/**
 * Builds a single consolidated book payload from multiple split book parts
 * (or appends a new part's chunks onto an existing book) with continuous page numbers.
 */
export function buildMergedBookChunks(
  parts: Array<{
    title: string;
    totalPages: number;
    chunks: Array<Omit<BookChunk, 'id' | 'bookId' | 'bookTitle'>>;
  }>
): {
  totalPages: number;
  chunks: Array<Omit<BookChunk, 'id' | 'bookId' | 'bookTitle'>>;
} {
  let pageOffset = 0;
  let runningChunkIndex = 0;
  const mergedChunks: Array<Omit<BookChunk, 'id' | 'bookId' | 'bookTitle'>> = [];

  for (const part of parts) {
    const sorted = [...part.chunks].sort(
      (a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex
    );
    const maxChunkPage =
      sorted.length > 0 ? Math.max(...sorted.map((c) => c.pageNumber)) : 0;
    const span = Math.max(part.totalPages || 0, maxChunkPage, 1);

    for (const ch of sorted) {
      mergedChunks.push({
        chapter: ch.chapter,
        pageNumber: pageOffset + Math.max(1, ch.pageNumber),
        chunkIndex: runningChunkIndex++,
        content: ch.content,
      });
    }

    pageOffset += span;
  }

  return {
    totalPages: Math.min(10000, Math.max(1, pageOffset)),
    chunks: mergedChunks,
  };
}

/**
 * Parses institution name, post name, and exam date from exam header lines or view title.
 */
function parseExamHeaderFields(
  headerLines: string[],
  fallbackTitle: string
): {
  institution: string;
  postName: string | null;
  examDate: string | null;
} {
  let institution = '';
  let postName: string | null = null;
  let examDate: string | null = null;

  for (const rawLine of headerLines) {
    const line = rawLine.trim();
    if (!line) continue;

    const postMatch = line.match(/পদের\s+নাম\s*[:ঃ]\s*(.+)$/i);
    if (postMatch) {
      postName = postMatch[1].replace(/[;।]+$/, '').trim();
      continue;
    }

    const dateMatch = line.match(/(?:পরীক্ষার\s+)?তারিখ\s*[:ঃ]\s*([^;\n]+)/i);
    if (dateMatch) {
      examDate = dateMatch[1].replace(/[।]+$/, '').trim();
      continue;
    }

    if (!institution && !/^(?:সময়|সময়|পূর্ণমান|বিষয়|বিষয়)\s*[:ঃ]/i.test(line)) {
      institution = line
        .replace(/^প্রশ্ন\s+সমাধান\s*[।:|–—-]+\s*/i, '')
        .trim();
    }
  }

  if (!institution) {
    const cleanedFallback = fallbackTitle
      .replace(/^প্রশ্ন\s+সমাধান\s*[।:|–—-]+\s*/i, '')
      .trim();
    const parts = cleanedFallback.split(/\s*[—–-]\s*/);
    institution = parts[0]?.trim() || cleanedFallback || 'অজানা পরীক্ষা';
    if (!postName && parts.length > 1) {
      postName = parts.slice(1).join(' — ').trim();
    }
  }

  return { institution, postName, examDate };
}

const WRITTEN_DIRECTIVE_STEM_RE =
  /(?:সন্ধি\s+বিচ্ছেদ|এক\s+কথায়\s+প্রকাশ|এক\s+কথায়\s+প্রকাশ|বাক্য\s+সংকোচন|বিপরীত\s+শব্দ|সমার্থক\s+শব্দ|বাগধারা|সমাস\s+নির্ণয়|সমাস\s+নির্ণয়|ব্যাসবাক্য|কারক\s+ও\s+বিভক্তি|কারক\s+নির্ণয়|কারক\s+নির্ণয়|শুদ্ধ\s+বানান|বানান\s+শুদ্ধ|বাক্য\s+শুদ্ধ|অর্থসহ\s+বাক্য|বাক্য\s+রচনা|টীকা\s+লিখুন|পূর্ণরূপ\s+লিখুন|সংক্ষেপে\s+উত্তর|উত্তর\s+লিখুন|উত্তর\s+দিন|সমাধান\s+করুন|উৎপাদকে\s*বিশ্লেষণ|মান\s+নির্ণয়|মান\s+নির্ণয়|অনুবাদ\s+করুন|নির্ণয়\s+করুন|নির্ণয়\s+করুন|পরিবর্তন\s+করুন|ব্যাখ্যা\s+করুন|প্রকাশ\s+করুন|অর্থ\s+লিখুন|লিখুন\s*[:ঃ-]|করুন\s*[:ঃ-]|fill\s+in\s+the\s+(?:gap|blank)|translate\s+into|make\s+sentence|correct\s+the\s+following|right\s+form\s+of\s+verb|change\s+the\s+(?:voice|narration|gender|number|degree)|transform\s+the|rewrite\s+the|rearrange\s+the|write\s+(?:a|an|the|down|short)|identify\s+the\s+following)/i;

const MCQ_INTERROGATIVE_STEM_RE =
  /(?:কোনটি|নিচের\s+কোন|কোন\s+(?:লেখক|কবি|নদী|ব্যাংক|সাল|প্রযুক্তি|শ্রেণি|কবিতা|উপন্যাস|প্রত্যঙ্গ|দেশ|শহর|রাজধানী|ধ্বনি)|কত\s*\?|সঠিক\s+(?:উত্তর|অনুবাদ|বানান)|(?:choose|select|pick|identify)\s+the\s+(?:correct|right|appropriate|best|exact|odd)|which\s+(?:one|sentence|of\s+the|has|is)|what\s+is\s+the|who\s+(?:is|was|wrote)|here\s+['‘"].+['’"]\s+is\s+a\/an)/i;

/**
 * Classifies a single structured question strictly as `'MCQ'` or `'Written'`.
 *
 * Strict evidence-based distinction matching Bangladeshi Job Solution papers:
 * - REAL MCQ (e.g. PSC Senior Staff Nurse):
 *   Has 2–4 selectable choices (`ক.`–`ঘ.` / `ক)`–`ঘ)` / `a)`–`d)`) AND either:
 *     (a) an explicit single-option answer key (`উ. ক/খ/গ/ঘ`, `উত্তর: গ`, `Answer: A/B/C/D`), OR
 *     (b) exactly 4 concise non-drill choices with NO written directive stem, NO `Solution:`/`সমাধান:` steps,
 *         and NO written `prompt = answer` / fill-in-the-blank sub-items.
 * - REAL Written (e.g. মৎস্য অধিদপ্তর, বাণিজ্য মন্ত্রণালয়):
 *   Descriptive questions with `Solution:`, math problems, OR multi-item written drills
 *   (`01. সন্ধি বিচ্ছেদ করুন: a)–e)`, `02. কারক ও বিভক্তি নির্ণয় করুন`, `04. Fill in the gap`,
 *   `05. translate into English`, or 5+ sub-items `a)–e)`).
 */
export function classifyQuestionFormat(params: {
  questionText: string;
  options: Array<{ marker: string; text: string }>;
  answerText: string;
  solutionSteps: string[];
  hasExplanation?: boolean;
}): QuestionFormatType {
  const { questionText, options, answerText, solutionSteps, hasExplanation } = params;

  // 1. Real Bangladeshi competitive MCQs have 2–4 choices (almost always 4: ক–ঘ or a–d).
  //    Questions with 0–1 options OR 5+ sub-items (a–e, a–h) are ALWAYS Written drills!
  if (options.length < 2 || options.length > 4) {
    return 'Written';
  }

  // Reject bullet lists or sub-items beyond d / ঘ (e.g. e), f), ঙ))
  const hasOnlyMcqOptionMarkers = options.every((o) =>
    /^(?:[a-d]\)|[ক-ঘ]\)|\([ক-ঘ]\)|[ক-ঘ]\.)$/i.test(o.marker.trim())
  );
  if (!hasOnlyMcqOptionMarkers) {
    return 'Written';
  }

  // 2. Written multi-item drill checks:
  //    - `word = answer` pairs (সন্ধি বিচ্ছেদ, এক কথায় প্রকাশ, বিপরীত শব্দ, অনুবাদ)
  //    - `word → answer` / `word : answer` definitions
  //    - Fill-in-the-blank sentences (`___`, `...`, `(the)`, `বাক্যের অর্থ`)
  const eqPairCount = options.filter((o) => /\s*(?:=|→|=>)\s*/.test(o.text)).length;
  if (eqPairCount >= Math.max(1, Math.ceil(options.length * 0.4))) {
    return 'Written';
  }

  const blankSentenceCount = options.filter((o) =>
    /(?:___|(?:\.{3,})|\((?:a|an|the)\)|বাক্যের\s+অর্থ)/i.test(o.text)
  ).length;
  if (blankSentenceCount >= 1) {
    return 'Written';
  }

  // Sub-items that are themselves written questions (ending with `?`)
  const questionSubItemCount = options.filter((o) => /\?\s*$/.test(o.text.trim())).length;
  if (questionSubItemCount >= 2) {
    return 'Written';
  }

  const trimmedAnswer = answerText.trim();
  const isSingleOptionKey = /^(?:[A-Da-d]|[ক-ঘ])(?:\s*[\.\)\-–—:]|\s*$)/.test(
    trimmedAnswer
  );

  // 3. Long descriptive answer or multi-step math derivation without a single-choice key => Written
  //    (Note: MCQ `ব্যাখ্যা:` explanations are stored in `explanation`, NOT `answerText`, so genuine MCQs never fail here.)
  if (!isSingleOptionKey && trimmedAnswer.length > 10) {
    return 'Written';
  }
  if (solutionSteps.length >= 2 && !isSingleOptionKey && !hasExplanation) {
    return 'Written';
  }

  // 4. Written directive stem (`সন্ধি বিচ্ছেদ করুন`, `কারক ও বিভক্তি নির্ণয় করুন`, etc.)
  //    NEVER classify as MCQ unless it explicitly asks an MCQ choice AND carries a single-option key!
  const isWrittenDirective = WRITTEN_DIRECTIVE_STEM_RE.test(questionText);
  const isMcqInterrogative = MCQ_INTERROGATIVE_STEM_RE.test(questionText);
  if (isWrittenDirective && !(isSingleOptionKey && isMcqInterrogative)) {
    return 'Written';
  }

  // 5. POSITIVE MCQ EVIDENCE REQUIREMENT:
  //    (a) Explicit single-option MCQ answer key (`উ. খ`, `উত্তর: গ`, `Answer: A`) — ALWAYS MCQ even with long ব্যাখ্যা:!
  if (isSingleOptionKey) {
    return 'MCQ';
  }

  //    (b) Clean 4-option MCQ with short selectable choices (even when OCR omitted side answer key or included ব্যাখ্যা:)
  if (
    options.length === 4 &&
    !trimmedAnswer &&
    (solutionSteps.length === 0 || Boolean(hasExplanation)) &&
    !isWrittenDirective
  ) {
    const avgOptionLen =
      options.reduce((sum, o) => sum + o.text.trim().length, 0) / options.length;
    const hasLongProseOption = options.some((o) => o.text.trim().length > 90);
    if (avgOptionLen <= 55 && !hasLongProseOption) {
      return 'MCQ';
    }
  }

  return 'Written';
}

interface TopicRule {
  topic: string;
  subjectGroup: string;
  pattern: RegExp;
}

const TOPIC_RULES: TopicRule[] = [
  // Bengali Grammar & Literature
  {
    topic: 'সন্ধি বিচ্ছেদ',
    subjectGroup: 'বাংলা',
    pattern: /সন্ধি\s*বিচ্ছেদ|সন্ধিজাত|সন্ধি\s+কোনটি|নবান্ন\s*=\s*নব|হিমালয়\s*=\s*হিম|সজ্জন\s*=\s*সৎ/i,
  },
  {
    topic: 'এক কথায় প্রকাশ',
    subjectGroup: 'বাংলা',
    pattern: /এক\s*কথা[য়য]\s*প্রকাশ|বাক্য\s*সংকোচন|এক\s*পদে\s*প্রকাশ|সর্বসহা|শাপদসঙ্কুল|সহোদর|অনিবার্য/i,
  },
  {
    topic: 'বিপরীত শব্দ',
    subjectGroup: 'বাংলা',
    pattern: /বিপরীত\s*শব্দ|বিপরীতার্থক|সাকার\s*=\s*নিরাকার|উৎকর্ষ\s*=\s*অপকর্ষ/i,
  },
  {
    topic: 'বাগধারা ও প্রবাদ',
    subjectGroup: 'বাংলা',
    pattern: /বাগধারা|প্রবাদ|প্রবচন|অর্থসহ\s*বাক্য\s*রচনা/i,
  },
  {
    topic: 'সমাস',
    subjectGroup: 'বাংলা',
    pattern: /সমাস|ব্যাসবাক্য|বহুব্রীহি|কর্মধারয়|তৎপুরুষ|দ্বন্দ্ব\s*সমাস|দ্বিগু/i,
  },
  {
    topic: 'শুদ্ধ বানান ও বাক্যশুদ্ধি',
    subjectGroup: 'বাংলা',
    pattern: /শুদ্ধ\s*বানান|বানান\s*শুদ্ধ|অশুদ্ধ\s*বানান|বাক্য\s*শুদ্ধি|শুদ্ধ\s*বাক্য/i,
  },
  {
    topic: 'কারক ও বিভক্তি',
    subjectGroup: 'বাংলা',
    pattern: /কারক|বিভক্তি|অপাদান|অধিকরণ|সম্প্রদান|করণ\s*কারক/i,
  },
  {
    topic: 'সমার্থক শব্দ',
    subjectGroup: 'বাংলা',
    pattern: /সমার্থক\s*শব্দ|প্রতিশব্দ/i,
  },
  {
    topic: 'ধ্বনি, বর্ণ ও বাংলা ব্যাকরণ',
    subjectGroup: 'বাংলা',
    pattern:
      /বাগ্যন্ত্র|বাঘময়|প্রত্যঙ্গ|জিহ্বা|ধ্বনি|বর্ণমালা|স্বরধ্বনি|ব্যঞ্জনধ্বনি|উপসর্গ|প্রত্যয়|প্রকৃতি|পদ\s*প্রকরণ|বিশেষ্য|বিশেষণ|অব্যয়|ক্রিয়া|বাংলা\s*ব্যাকরণ/i,
  },
  {
    topic: 'বাংলা সাহিত্য',
    subjectGroup: 'বাংলা',
    pattern:
      /উপন্যাস|নাটক|কাব্যগ্রন্থ|রচয়িতা|কবি\s|রবীন্দ্রনাথ|নজরুল|বঙ্কিমচন্দ্র|শরৎচন্দ্র|মাইকেল\s*মধুসূদন|জীবনানন্দ|জসীমউদ্দীন|বাংলা\s*সাহিত্য|চর্যাপদ/i,
  },

  // English
  {
    topic: 'Translation (অনুবাদ)',
    subjectGroup: 'ইংরেজি',
    pattern:
      /translate\s+into|ইংরেজি\s*অনুবাদ|বাংলা\s*অনুবাদ|অনুবাদ\s*করুন|to\s+err\s+is\s+human/i,
  },
  {
    topic: 'Article & Fill in the Gap',
    subjectGroup: 'ইংরেজি',
    pattern:
      /fill\s+in\s+the\s+(?:gap|blank)|appropriate\s+(?:article|preposition)|using\s+article|preposition\s+বসান/i,
  },
  {
    topic: 'Phrase, Idiom & Vocabulary',
    subjectGroup: 'ইংরেজি',
    pattern:
      /phrase|idiom|synonym|antonym|spelling|correctly\s+spelt|meaning\s+of|make\s+sentence|one\s+word\s+substitution/i,
  },
  {
    topic: 'English Grammar',
    subjectGroup: 'ইংরেজি',
    pattern:
      /voice|passive|active|narration|indirect\s+speech|right\s+form\s+of\s+verb|tense|parts\s+of\s+speech|noun|adjective|adverb|pronoun|clause|transformation|correct\s+the\s+(?:sentence|following)/i,
  },

  // Mathematics
  {
    topic: 'ভগ্নাংশ ও বীজগণিত',
    subjectGroup: 'গণিত',
    pattern:
      /উৎপাদকে\s*বিশ্লেষণ|সমাধান\s*করুন|\\frac|ভগ্নাংশ|লগারিদম|সূচক|সমান্তর\s*ধারা|গুণোত্তর\s*ধারা|[xyz]\s*\^|\b[0-9]*x\s*[+\-=]/i,
  },
  {
    topic: 'জ্যামিতি ও পরিমিতি',
    subjectGroup: 'গণিত',
    pattern:
      /ক্ষেত্রফল|পরিসীমা|দৈর্ঘ্য|প্রস্থ|পুকুর|পাড়|বর্গমিটার|ত্রিভুজ|চতুর্ভুজ|বৃত্ত|ব্যাসার্ধ|আয়তক্ষেত্র|বর্গক্ষেত্র|কোণ|সমকোণী|আয়তন|ঘনক/i,
  },
  {
    topic: 'পাটিগণিত (অনুপাত, সুদ, গ.সা.গু ও শতকরা)',
    subjectGroup: 'গণিত',
    pattern:
      /অনুপাত|মিশ্রণ|সরল\s*সুদ|চক্রবৃদ্ধি|সুদে\s*আসলে|গ\.?সা\.?গু|ল\.?সা\.?গু|শতকরা|লাভ|ক্ষতি|ক্রয়মূল্য|বিক্রয়মূল্য|লিটার|মি\.\s*লি\.|অবশিষ্ট|ঝুড়ি|গড়|ঐকিক|নৌকা|স্রোত|ট্রেন|কাজটি\s+কত\s+দিনে/i,
  },

  // General Knowledge & Science
  {
    topic: 'বাংলাদেশ বিষয়াবলি ও সংবিধান',
    subjectGroup: 'সাধারণ জ্ঞান',
    pattern:
      /বঙ্গবন্ধু|মুজিবুর\s*রহমান|মুক্তিযুদ্ধ|সংবিধান|সংসদ|মন্ত্রী\s*পরিষদ|প্রধানমন্ত্রী|রাষ্ট্রপতি|পদ্মা\s*সেতু|মেট্রোরেল|বাংলাদেশ|ঢাকা|জাতীয়\s*সঙ্গীত|ভাষা\s*আন্দোলন|অর্থবিল|রেপো\s*রেট/i,
  },
  {
    topic: 'আন্তর্জাতিক বিষয়াবলি',
    subjectGroup: 'সাধারণ জ্ঞান',
    pattern:
      /জাতিসংঘ|সদর\s*দপ্তর|রাজধানী|মুদ্রা|আন্তর্জাতিক|বিশ্বব্যাংক|ব্রিকস|সার্ক|ওআইসি|ন্যাটো|নোবেল|ইউরোপীয়|এশিয়া|আফ্রিকা/i,
  },
  {
    topic: 'বিজ্ঞান, কৃষি ও কম্পিউটার',
    subjectGroup: 'বিজ্ঞান ও প্রযুক্তি',
    pattern:
      /হ্যাচারি|মাছ|তাপমাত্রা|সেন্টিগ্রেড|pituitary|সার্কুলার\s*ট্যাংক|পূর্ণরূপ|mrt|কম্পিউটার|ইন্টারনেট|সফটওয়্যার|হার্ডওয়্যার|ভাইরাস|ভিটামিন|রক্ত|অক্সিজেন|হাইড্রোজেন|বিদ্যুৎ|cpu|ram|http|html/i,
  },
];

/**
 * Classifies an exam question into a clean competitive-exam topic and parent subject group.
 */
export function classifyExamQuestionTopic(
  questionText: string,
  optionsText = '',
  answerText = ''
): { topic: string; subjectGroup: string } {
  const combined = `${questionText} ${optionsText} ${answerText}`.trim();

  // First check question stem directly (highest precision!)
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(questionText)) {
      return { topic: rule.topic, subjectGroup: rule.subjectGroup };
    }
  }

  // Fallback to combined text (options + answer)
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(combined)) {
      return { topic: rule.topic, subjectGroup: rule.subjectGroup };
    }
  }

  // Heuristic for English-only questions not matched above
  const asciiLetters = (questionText.match(/[A-Za-z]/g) ?? []).length;
  const bengaliLetters = (questionText.match(/[\u0980-\u09FF]/g) ?? []).length;
  if (asciiLetters >= 12 && asciiLetters > bengaliLetters * 2) {
    return { topic: 'English Grammar', subjectGroup: 'ইংরেজি' };
  }

  return { topic: 'সাধারণ জ্ঞান ও অন্যান্য', subjectGroup: 'সাধারণ জ্ঞান' };
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/^(?:0?[1-9]|[1-9]\d{1,2}|[০-৯]{1,3})[.\u0964]\s*/, '')
    .replace(/^[a-hক-ঙ]\)\s*/i, '')
    .replace(/\$+/g, ' ')
    .replace(/[।.,?!:;'"‘’“”()\[\]{}\-–—_/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeNormalized(normalized: string): string[] {
  return normalized
    .split(/\s+/)
    .filter((tok) => tok.length >= 2);
}

function computeTokenJaccard(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let intersection = 0;
  for (const tok of aSet) {
    if (bSet.has(tok)) intersection += 1;
  }
  const union = aSet.size + bSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface RepeatCandidate {
  canonicalQuestion: string;
  normalizedKey: string;
  tokens: string[];
  options: Array<{ marker: string; text: string }>;
  answerLabel: string;
  answerText: string;
  format: QuestionFormatType;
  topic: string;
  subjectGroup: string;
  isSubItem: boolean;
  occurrence: RepeatedQuestionOccurrence;
}

/**
 * Extracts individual repeat-trackable atomic items from a written multi-item list
 * (e.g., `01. সন্ধি বিচ্ছেদ করুন:` -> `নবান্ন = নব + অন্ন`, `হিমালয় = হিম + আলয়`).
 */
function extractAtomicSubItemsForRepeat(
  item: AnalyzedQuestionItem
): RepeatCandidate[] {
  if (item.format !== 'Written' || item.options.length < 2) {
    return [];
  }

  const candidates: RepeatCandidate[] = [];

  for (const opt of item.options) {
    const raw = opt.text.trim();
    if (!raw) continue;

    // Pattern A: `prompt = answer` (সন্ধি বিচ্ছেদ, এক কথায় প্রকাশ, বিপরীত শব্দ, অনুবাদ)
    const eqIdx = raw.indexOf('=');
    if (eqIdx > 1 && eqIdx < raw.length - 1) {
      const leftPrompt = raw.slice(0, eqIdx).replace(/[।.]+$/, '').trim();
      const rightAnswer = raw.slice(eqIdx + 1).trim();
      const norm = normalizeForComparison(`${item.topic} ${leftPrompt}`);
      if (leftPrompt.length >= 2 && rightAnswer.length >= 1) {
        candidates.push({
          canonicalQuestion: `${item.topic}: ${leftPrompt}`,
          normalizedKey: norm,
          tokens: tokenizeNormalized(norm),
          options: [],
          answerLabel: 'উত্তর:',
          answerText: rightAnswer,
          format: 'Written',
          topic: item.topic,
          subjectGroup: item.subjectGroup,
          isSubItem: true,
          occurrence: {
            examId: item.examId,
            examTitle: item.examTitle,
            institution: item.institution,
            postName: item.postName,
            examDate: item.examDate,
            partLabel: item.partLabel,
            bookTitle: item.bookTitle,
            pageLabel: item.pageLabel,
            numberLabel: `${item.numberLabel} ${opt.marker}`,
          },
        });
      }
      continue;
    }

    // Pattern B: Fill-in-the-gap item with inline answer `___ rich are not always happy. (the)` or `Answer: the`
    const inlineAnsMatch = raw.match(
      /^(.*?)(?:\s+Answer\s*:\s*([^।\n]+)|\s*\((a|an|the|in|on|at|to|of|for|by|with|from)\))/i
    );
    if (inlineAnsMatch && inlineAnsMatch[1].trim().length >= 6) {
      const promptPart = inlineAnsMatch[1].trim();
      const ansPart = (inlineAnsMatch[2] || inlineAnsMatch[3] || '').trim();
      const norm = normalizeForComparison(promptPart);
      if (norm.length >= 6) {
        candidates.push({
          canonicalQuestion: promptPart,
          normalizedKey: norm,
          tokens: tokenizeNormalized(norm),
          options: [],
          answerLabel: 'Answer:',
          answerText: ansPart,
          format: 'Written',
          topic: item.topic,
          subjectGroup: item.subjectGroup,
          isSubItem: true,
          occurrence: {
            examId: item.examId,
            examTitle: item.examTitle,
            institution: item.institution,
            postName: item.postName,
            examDate: item.examDate,
            partLabel: item.partLabel,
            bookTitle: item.bookTitle,
            pageLabel: item.pageLabel,
            numberLabel: `${item.numberLabel} ${opt.marker}`,
          },
        });
      }
    }
  }

  return candidates;
}

function findPartLabelForPage(
  pageNumber: number,
  partRanges: BookSeriesPartRange[]
): { partLabel: string | null; bookId: number; bookTitle: string; originalPage: number } {
  for (const range of partRanges) {
    if (pageNumber >= range.startOffsetPage && pageNumber <= range.endOffsetPage) {
      return {
        partLabel: partRanges.length > 1 ? range.partLabel : null,
        bookId: range.bookId,
        bookTitle: range.bookTitle,
        originalPage: pageNumber - range.startOffsetPage + 1,
      };
    }
  }
  const first = partRanges[0];
  return {
    partLabel: null,
    bookId: first?.bookId ?? 0,
    bookTitle: first?.bookTitle ?? '',
    originalPage: pageNumber,
  };
}

function parseQuestionsFromExamView(params: {
  view: SmartReaderViewUnit;
  partRanges: BookSeriesPartRange[];
}): {
  examMeta: ExtractedExamMetadata;
  questions: AnalyzedQuestionItem[];
} {
  const { view, partRanges } = params;
  const parsedDoc = parseExamDocumentForDisplay(view.content);
  const { institution, postName, examDate } = parseExamHeaderFields(
    parsedDoc.headerLines,
    view.title
  );

  const partInfo = findPartLabelForPage(view.startPage, partRanges);
  const displayPageLabel = partInfo.partLabel
    ? `${partInfo.partLabel} · পৃষ্ঠা ${partInfo.originalPage}${
        view.endPage > view.startPage
          ? `–${partInfo.originalPage + (view.endPage - view.startPage)}`
          : ''
      }`
    : view.pageLabel;

  const questions: AnalyzedQuestionItem[] = [];

  type DraftQ = {
    numberLabel: string;
    questionNumber: number;
    stemLines: string[];
    options: Array<{ marker: string; text: string }>;
    answerLabel: string;
    answerLines: string[];
    explanationLines: string[];
    solutionSteps: string[];
    isAiGenerated: boolean;
    references: string[];
    highlights: string[];
  };

  let current: DraftQ | null = null;

  const flushCurrent = () => {
    if (!current) return;
    const questionText = current.stemLines.join(' ').trim();
    if (!questionText) {
      current = null;
      return;
    }

    const answerText = current.answerLines.join('\n').trim();
    const explanation = current.explanationLines.join(' ').trim();
    const format = classifyQuestionFormat({
      questionText,
      options: current.options,
      answerText,
      solutionSteps: current.solutionSteps,
      hasExplanation: explanation.length > 0,
    });

    const optionsJoined = current.options.map((o) => o.text).join(' ');
    const { topic, subjectGroup } = classifyExamQuestionTopic(
      questionText,
      optionsJoined,
      answerText
    );

    questions.push({
      id: `${view.id}-q${current.questionNumber}-${questions.length + 1}`,
      examId: view.id,
      examTitle:
        postName && !institution.includes(postName)
          ? `${institution} — ${postName}`
          : institution || view.title,
      institution,
      postName,
      examDate,
      partLabel: partInfo.partLabel,
      bookId: partInfo.bookId,
      bookTitle: partInfo.bookTitle || view.bookTitle,
      pageLabel: displayPageLabel,
      pageNumber: view.startPage,
      numberLabel: current.numberLabel,
      questionNumber: current.questionNumber,
      questionText,
      options: current.options,
      answerLabel: current.answerLabel || (format === 'MCQ' ? 'Answer:' : 'সমাধান:'),
      answerText,
      explanation: explanation || undefined,
      solutionSteps: current.solutionSteps,
      format,
      topic,
      subjectGroup,
      isAiGenerated: current.isAiGenerated,
      references: current.references,
      highlights: current.highlights,
    });

    current = null;
  };

  for (const item of parsedDoc.bodyItems) {
    if (item.kind === 'question') {
      flushCurrent();
      current = {
        numberLabel: item.numberLabel,
        questionNumber: item.questionNumber,
        stemLines: [item.text],
        options: [],
        answerLabel: '',
        answerLines: [],
        explanationLines: [],
        solutionSteps: [],
        isAiGenerated: false,
        references: [],
        highlights: [],
      };
      continue;
    }

    if (!current) continue;

    if (item.kind === 'option') {
      current.options.push({ marker: item.marker, text: item.text });
    } else if (item.kind === 'explanation') {
      if (item.text) {
        current.explanationLines.push(item.text);
      }
    } else if (item.kind === 'solution') {
      const existingAns = current.answerLines.join(' ').trim();
      const alreadyHasSingleMcqKey =
        /^(?:[A-Da-d]|[ক-ঘ])(?:\s*[\.\)]|\s*$)/.test(existingAns);
      if (alreadyHasSingleMcqKey && item.text) {
        current.explanationLines.push(item.text);
      } else {
        if (!current.answerLabel) {
          current.answerLabel = item.label;
        }
        if (item.text) {
          current.answerLines.push(item.text);
        }
      }
    } else if (item.kind === 'math') {
      current.solutionSteps.push(item.text);
    } else if (item.kind === 'ai_badge') {
      current.isAiGenerated = true;
      if (item.text) current.answerLines.push(item.text);
    } else if (item.kind === 'reference') {
      current.references.push(`${item.label} ${item.text}`.trim());
    } else if (item.kind === 'highlight') {
      current.highlights.push(item.text);
    } else if (item.kind === 'text') {
      if (current.explanationLines.length > 0) {
        current.explanationLines.push(item.text);
      } else if (current.answerLines.length > 0 || current.answerLabel) {
        current.solutionSteps.push(item.text);
      } else if (current.options.length === 0) {
        current.stemLines.push(item.text);
      } else {
        current.solutionSteps.push(item.text);
      }
    }
  }

  flushCurrent();

  let mcqCount = questions.filter((q) => q.format === 'MCQ').length;
  let writtenCount = questions.filter((q) => q.format === 'Written').length;
  const totalQ = mcqCount + writtenCount;

  // Exam-level dominance rule:
  // Eliminates false `'Mixed'` classification caused by 1–2 OCR-noisy questions
  // (e.g. a 34-question Written exam with 1 ambiguous sub-list NEVER becomes MCQ/Mixed,
  // and a 100-question MCQ exam with 1 OCR-dropped option NEVER becomes Written/Mixed!).
  let format: ExamPaperFormatType = 'Written';
  if (totalQ === 0) {
    format = 'Written';
  } else if (mcqCount > 0 && writtenCount === 0) {
    format = 'MCQ';
  } else if (writtenCount > 0 && mcqCount === 0) {
    format = 'Written';
  } else if (mcqCount / totalQ >= 0.65) {
    format = 'MCQ';
  } else if (writtenCount / totalQ >= 0.65) {
    format = 'Written';
  } else if (mcqCount >= 2 && writtenCount >= 2) {
    format = 'Mixed';
  } else {
    format = mcqCount > writtenCount ? 'MCQ' : 'Written';
  }

  // When an exam is overwhelmingly pure Written (>= 85% Written) or pure MCQ (>= 85% MCQ),
  // align outlier OCR-artifact questions to the exam's true paper format so topic/repeat filters stay clean.
  if (format === 'Written' && totalQ >= 4 && writtenCount / totalQ >= 0.85 && mcqCount > 0) {
    for (const q of questions) {
      q.format = 'Written';
    }
    mcqCount = 0;
    writtenCount = questions.length;
  } else if (format === 'MCQ' && totalQ >= 4 && mcqCount / totalQ >= 0.85 && writtenCount > 0) {
    for (const q of questions) {
      q.format = 'MCQ';
    }
    mcqCount = questions.length;
    writtenCount = 0;
  }

  const cleanExamTitle =
    postName && !institution.includes(postName)
      ? `${institution} — ${postName}`
      : extractExamTitleFromText(view.content) || view.title;

  return {
    examMeta: {
      examId: view.id,
      examTitle: cleanExamTitle,
      institution,
      postName,
      examDate,
      partLabel: partInfo.partLabel,
      bookId: partInfo.bookId,
      bookTitle: partInfo.bookTitle || view.bookTitle,
      pageLabel: displayPageLabel,
      startPage: view.startPage,
      endPage: view.endPage,
      format,
      mcqCount,
      writtenCount,
      questionCount: questions.length,
    },
    questions,
  };
}

/**
 * Runs complete multi-part intelligence over a single Book OR an entire Multi-Part Book Series:
 * 1. Combines all parts cleanly with continuous page offsets & part attribution.
 * 2. Separates MCQ vs Written questions & exam papers.
 * 3. Categorizes EVERY question into Bangladeshi competitive-exam topics with Institution, Post & Date.
 * 4. Detects Repeated Questions (both full questions AND atomic written sub-items like `সন্ধি বিচ্ছেদ`)
 *    and ranks them by repeat frequency & importance priority.
 */
export function analyzeBookOrSeriesQuestions(
  booksInput: Book[],
  seriesTitleOverride?: string
): BookIntelligenceReport {
  if (!booksInput || booksInput.length === 0) {
    return {
      seriesTitle: seriesTitleOverride || '',
      isMultiPart: false,
      partCount: 0,
      totalExams: 0,
      totalQuestions: 0,
      mcqQuestionCount: 0,
      writtenQuestionCount: 0,
      mcqExamCount: 0,
      writtenExamCount: 0,
      mixedExamCount: 0,
      exams: [],
      examFormatByViewId: {},
      questions: [],
      topicBuckets: [],
      repeatedQuestions: [],
    };
  }

  // Build unified series chunks (with continuous page numbers across all parts)
  const sortedBooks = [...booksInput].sort((a, b) => {
    const ia = parseBookSeriesIdentity(a.title);
    const ib = parseBookSeriesIdentity(b.title);
    const pa = ia.partNumber ?? Number.MAX_SAFE_INTEGER;
    const pb = ib.partNumber ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.id - b.id;
  });

  const seriesTitle =
    seriesTitleOverride || parseBookSeriesIdentity(sortedBooks[0].title).seriesTitle;

  const partRanges: BookSeriesPartRange[] = [];
  const combinedChunks: BookChunk[] = [];
  let pageOffset = 0;
  let runningChunkIndex = 0;

  sortedBooks.forEach((book, idx) => {
    const idn = parseBookSeriesIdentity(book.title);
    const partLabel =
      idn.partLabel ||
      (sortedBooks.length > 1 ? `Part ${String(idx + 1).padStart(2, '0')}` : 'মূল বই');
    const sortedChunks = [...book.chunks].sort(
      (a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex || a.id - b.id
    );
    const maxChunkPage =
      sortedChunks.length > 0 ? Math.max(...sortedChunks.map((c) => c.pageNumber)) : 0;
    const span = Math.max(book.totalPages || 0, maxChunkPage, 1);

    partRanges.push({
      bookId: book.id,
      bookTitle: book.title,
      partNumber: idn.partNumber ?? idx + 1,
      partLabel,
      originalPages: span,
      startOffsetPage: pageOffset + 1,
      endOffsetPage: pageOffset + span,
    });

    for (const ch of sortedChunks) {
      combinedChunks.push({
        ...ch,
        bookTitle: sortedBooks.length > 1 ? `${seriesTitle} (${partLabel})` : book.title,
        pageNumber: pageOffset + Math.max(1, ch.pageNumber),
        chunkIndex: runningChunkIndex++,
      });
    }

    pageOffset += span;
  });

  const { views } = buildSmartReaderViews(combinedChunks, 'exam');

  const exams: ExtractedExamMetadata[] = [];
  const allQuestions: AnalyzedQuestionItem[] = [];
  const examFormatByViewId: BookIntelligenceReport['examFormatByViewId'] = {};

  for (const view of views) {
    const normalizedView: SmartReaderViewUnit = {
      ...view,
      content: normalizeExamDocumentFormatting(view.content),
    };
    const { examMeta, questions } = parseQuestionsFromExamView({
      view: normalizedView,
      partRanges,
    });
    exams.push(examMeta);
    allQuestions.push(...questions);
    examFormatByViewId[view.id] = {
      format: examMeta.format,
      mcqCount: examMeta.mcqCount,
      writtenCount: examMeta.writtenCount,
      institution: examMeta.institution,
      postName: examMeta.postName,
      examDate: examMeta.examDate,
      partLabel: examMeta.partLabel,
    };
  }

  // Build Topic Buckets
  const topicMap = new Map<string, TopicBucketSummary>();
  for (const q of allQuestions) {
    let bucket = topicMap.get(q.topic);
    if (!bucket) {
      bucket = {
        topic: q.topic,
        subjectGroup: q.subjectGroup,
        totalCount: 0,
        mcqCount: 0,
        writtenCount: 0,
        examCount: 0,
        items: [],
      };
      topicMap.set(q.topic, bucket);
    }
    bucket.items.push(q);
    bucket.totalCount += 1;
    if (q.format === 'MCQ') bucket.mcqCount += 1;
    else bucket.writtenCount += 1;
  }

  const topicBuckets = Array.from(topicMap.values())
    .map((bucket) => ({
      ...bucket,
      examCount: new Set(bucket.items.map((it) => it.examId)).size,
    }))
    .sort((a, b) => b.totalCount - a.totalCount || a.topic.localeCompare(b.topic, 'bn'));

  // Build Repeat Candidates (full questions + granular written sub-items)
  const repeatCandidates: RepeatCandidate[] = [];
  for (const q of allQuestions) {
    const atomicSubItems = extractAtomicSubItemsForRepeat(q);
    if (atomicSubItems.length > 0) {
      repeatCandidates.push(...atomicSubItems);
      continue;
    }

    const norm = normalizeForComparison(q.questionText);
    if (norm.length < 6) continue;
    repeatCandidates.push({
      canonicalQuestion: q.questionText,
      normalizedKey: norm,
      tokens: tokenizeNormalized(norm),
      options: q.options,
      answerLabel: q.answerLabel,
      answerText:
        q.answerText ||
        (q.solutionSteps.length > 0 ? q.solutionSteps.join('\n') : ''),
      format: q.format,
      topic: q.topic,
      subjectGroup: q.subjectGroup,
      isSubItem: false,
      occurrence: {
        examId: q.examId,
        examTitle: q.examTitle,
        institution: q.institution,
        postName: q.postName,
        examDate: q.examDate,
        partLabel: q.partLabel,
        bookTitle: q.bookTitle,
        pageLabel: q.pageLabel,
        numberLabel: q.numberLabel,
      },
    });
  }

  // Cluster candidates by exact normalized key OR high token Jaccard similarity (>= 0.76)
  interface Cluster {
    representative: RepeatCandidate;
    members: RepeatCandidate[];
  }
  const exactMap = new Map<string, Cluster>();
  const clusters: Cluster[] = [];

  for (const cand of repeatCandidates) {
    const exactCluster = exactMap.get(cand.normalizedKey);
    if (exactCluster) {
      exactCluster.members.push(cand);
      continue;
    }

    // Try fuzzy match against existing clusters of same format & topic (for OCR typo tolerance)
    let matchedCluster: Cluster | null = null;
    if (cand.tokens.length >= 4) {
      for (const cl of clusters) {
        if (cl.representative.isSubItem !== cand.isSubItem) continue;
        if (cl.representative.tokens.length < 4) continue;
        const sim = computeTokenJaccard(cl.representative.tokens, cand.tokens);
        if (sim >= 0.76) {
          matchedCluster = cl;
          break;
        }
      }
    }

    if (matchedCluster) {
      matchedCluster.members.push(cand);
      exactMap.set(cand.normalizedKey, matchedCluster);
    } else {
      const fresh: Cluster = { representative: cand, members: [cand] };
      clusters.push(fresh);
      exactMap.set(cand.normalizedKey, fresh);
    }
  }

  const repeatedQuestions: RepeatedQuestionGroup[] = [];

  for (let i = 0; i < clusters.length; i += 1) {
    const cl = clusters[i];
    if (cl.members.length < 2) continue;

    // Deduplicate identical (examId + numberLabel) occurrences
    const uniqueOccurrences: RepeatedQuestionOccurrence[] = [];
    const seenOccKeys = new Set<string>();
    for (const m of cl.members) {
      const key = `${m.occurrence.examId}::${m.occurrence.numberLabel}`;
      if (!seenOccKeys.has(key)) {
        seenOccKeys.add(key);
        uniqueOccurrences.push(m.occurrence);
      }
    }

    if (uniqueOccurrences.length < 2) continue;

    const distinctExamCount = new Set(uniqueOccurrences.map((o) => o.examId)).size;
    const repeatCount = uniqueOccurrences.length;
    const priorityTier: RepeatPriorityTier = repeatCount >= 3 ? 'very_high' : 'high';
    const priorityLabel =
      priorityTier === 'very_high' ? 'অতি গুরুত্বপূর্ণ' : 'গুরুত্বপূর্ণ';
    const importanceScore = Math.min(
      99,
      62 + repeatCount * 11 + (distinctExamCount >= 3 ? 5 : 0)
    );

    // Prefer the member with the richest non-empty answer and options as display representative
    const bestRep =
      cl.members.find((m) => m.answerText.trim().length > 0 && m.options.length > 0) ??
      cl.members.find((m) => m.answerText.trim().length > 0) ??
      cl.representative;

    repeatedQuestions.push({
      id: `repeat-${i + 1}-${repeatCount}x`,
      canonicalQuestion: bestRep.canonicalQuestion,
      options: bestRep.options,
      answerLabel: bestRep.answerLabel,
      answerText: bestRep.answerText,
      format: bestRep.format,
      topic: bestRep.topic,
      subjectGroup: bestRep.subjectGroup,
      repeatCount,
      distinctExamCount,
      importanceScore,
      priorityTier,
      priorityLabel,
      isSubItem: bestRep.isSubItem,
      occurrences: uniqueOccurrences,
    });
  }

  repeatedQuestions.sort(
    (a, b) =>
      b.repeatCount - a.repeatCount ||
      b.distinctExamCount - a.distinctExamCount ||
      b.importanceScore - a.importanceScore
  );

  const mcqQuestionCount = allQuestions.filter((q) => q.format === 'MCQ').length;
  const writtenQuestionCount = allQuestions.filter((q) => q.format === 'Written').length;

  return {
    seriesTitle,
    isMultiPart: sortedBooks.length > 1,
    partCount: sortedBooks.length,
    totalExams: exams.length,
    totalQuestions: allQuestions.length,
    mcqQuestionCount,
    writtenQuestionCount,
    mcqExamCount: exams.filter((e) => e.format === 'MCQ').length,
    writtenExamCount: exams.filter((e) => e.format === 'Written').length,
    mixedExamCount: exams.filter((e) => e.format === 'Mixed').length,
    exams,
    examFormatByViewId,
    questions: allQuestions,
    topicBuckets,
    repeatedQuestions,
  };
}

export const SUBJECT_DISPLAY_ORDER: readonly string[] = [
  'বাংলা',
  'ইংরেজি',
  'গণিত',
  'সাধারণ জ্ঞান',
  'বিজ্ঞান ও প্রযুক্তি',
];

export interface SubjectOptionSummary {
  subject: string;
  count: number;
  topicCount: number;
}

export interface TopicOptionSummary {
  topic: string;
  subjectGroup: string;
  count: number;
}

/**
 * Returns the available subject groups (বাংলা, ইংরেজি, গণিত, সাধারণ জ্ঞান, বিজ্ঞান ও প্রযুক্তি)
 * with matching question counts for the selected MCQ / Written / ALL filter,
 * sorted in canonical competitive-exam order.
 */
export function getAvailableSubjects(
  report: BookIntelligenceReport,
  formatFilter: 'all' | QuestionFormatType
): SubjectOptionSummary[] {
  const countsBySubject = new Map<string, { count: number; topics: Set<string> }>();

  for (const q of report.questions) {
    if (formatFilter !== 'all' && q.format !== formatFilter) continue;
    const entry = countsBySubject.get(q.subjectGroup) ?? {
      count: 0,
      topics: new Set<string>(),
    };
    entry.count += 1;
    entry.topics.add(q.topic);
    countsBySubject.set(q.subjectGroup, entry);
  }

  return Array.from(countsBySubject.entries())
    .map(([subject, data]) => ({
      subject,
      count: data.count,
      topicCount: data.topics.size,
    }))
    .sort((a, b) => {
      const ia = SUBJECT_DISPLAY_ORDER.indexOf(a.subject);
      const ib = SUBJECT_DISPLAY_ORDER.indexOf(b.subject);
      const oa = ia >= 0 ? ia : SUBJECT_DISPLAY_ORDER.length;
      const ob = ib >= 0 ? ib : SUBJECT_DISPLAY_ORDER.length;
      if (oa !== ob) return oa - ob;
      return b.count - a.count || a.subject.localeCompare(b.subject, 'bn');
    });
}

/**
 * Returns cascading topics strictly scoped to `selectedSubject` (or all topics if `'ALL'`),
 * filtered by `formatFilter` (`'all' | 'MCQ' | 'Written'`).
 */
export function getAvailableTopicsForSubject(
  report: BookIntelligenceReport,
  selectedSubject: string,
  formatFilter: 'all' | QuestionFormatType
): TopicOptionSummary[] {
  const results: TopicOptionSummary[] = [];

  for (const bucket of report.topicBuckets) {
    if (selectedSubject !== 'ALL' && bucket.subjectGroup !== selectedSubject) {
      continue;
    }
    const matchingCount =
      formatFilter === 'all'
        ? bucket.totalCount
        : formatFilter === 'MCQ'
          ? bucket.mcqCount
          : bucket.writtenCount;

    if (matchingCount > 0) {
      results.push({
        topic: bucket.topic,
        subjectGroup: bucket.subjectGroup,
        count: matchingCount,
      });
    }
  }

  return results.sort(
    (a, b) => b.count - a.count || a.topic.localeCompare(b.topic, 'bn')
  );
}

/**
 * Filters Smart Reader exam views strictly by exam-paper format while preserving
 * serial page order (`startPage ASC`):
 * - `'all'`: returns every exam serially in page order.
 * - `'MCQ'`: returns ONLY exams conducted in MCQ format (`format === 'MCQ'` or genuinely `'Mixed'`).
 * - `'Written'`: returns ONLY exams conducted in Written format (`format === 'Written'` or genuinely `'Mixed'`).
 */
export function filterExamViewsByFormat(
  views: SmartReaderViewUnit[],
  examFormatByViewId: BookIntelligenceReport['examFormatByViewId'],
  formatFilter: 'all' | QuestionFormatType
): SmartReaderViewUnit[] {
  const ordered = [...views].sort(
    (a, b) => a.startPage - b.startPage || a.endPage - b.endPage
  );
  if (formatFilter === 'all') {
    return ordered;
  }
  return ordered.filter((view) => {
    const meta = examFormatByViewId[view.id];
    if (!meta) return false;
    if (formatFilter === 'MCQ') {
      return meta.format === 'MCQ' || meta.format === 'Mixed';
    }
    return meta.format === 'Written' || meta.format === 'Mixed';
  });
}

