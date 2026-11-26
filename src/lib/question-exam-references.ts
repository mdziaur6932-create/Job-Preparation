import type { Book } from '../types/system';
import {
  analyzeBookOrSeriesQuestions,
  type AnalyzedQuestionItem,
  type ExtractedExamMetadata,
} from './book-series-and-topic-analyzer';

export interface QuestionExamReference {
  id: string;
  examTitle: string;
  postName: string | null;
  examDate: string | null;
  bookId: number;
  bookTitle: string;
  pageNumber: number;
  pageLabel: string;
  examId: string | null;
  numberLabel: string | null;
  originalQuestionText: string | null;
  originalOptions: Array<{ marker: string; text: string }>;
  originalAnswerText: string | null;
  originalExplanation: string | null;
  sourcePageExcerpt: string | null;
  matchType: 'exact_question' | 'similar_question' | 'source_page_exam';
}

export interface QuestionExamReferenceIndex {
  booksById: Map<number, Book>;
  booksByTitle: Map<string, Book>;
  examsByBookId: Map<number, ExtractedExamMetadata[]>;
  itemsByNormStem: Map<string, AnalyzedQuestionItem[]>;
  indexedItems: Array<{
    item: AnalyzedQuestionItem;
    normStem: string;
    contentTokens: Set<string>;
  }>;
}

const REFERENCE_STOP_WORDS = new Set([
  // Bengali MCQ boilerplate words
  'নিচের',
  'নিম্নের',
  'কোনটি',
  'কোন',
  'সঠিক',
  'সঠিকটি',
  'উত্তর',
  'এর',
  'হয়',
  'হলো',
  'হবে',
  'কত',
  'কবে',
  'কোথায়',
  'কে',
  'কি',
  'কী',
  'নয়',
  'বলা',
  'একটি',
  'এবং',
  'বা',
  'ও',
  'থেকে',
  'জন্য',
  'সাথে',
  'সঙ্গে',
  'দ্বারা',
  'করে',
  'করা',
  'যায়',
  'থাকে',
  'আছে',
  'হিসেবে',
  'সাল',
  'সালে',
  'তারিখে',
  'শব্দটির',
  'শব্দের',
  'বাক্যের',
  'কোনটিই',
  'প্রশ্ন',
  // English MCQ boilerplate words
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'of',
  'in',
  'to',
  'for',
  'on',
  'at',
  'by',
  'from',
  'with',
  'and',
  'or',
  'an',
  'which',
  'what',
  'who',
  'where',
  'when',
  'how',
  'choose',
  'select',
  'correct',
  'right',
  'following',
  'sentence',
  'word',
  'means',
  'meaning',
  'opposite',
  'synonym',
  'antonym',
  'one',
  'not',
]);

export function normalizeReferenceStem(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/^\s*(?:প্রশ্ন\s*)?[০-৯0-9]+[.)ঃ:\-–—]\s*/u, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[‘’'"“”`.,?!;ঃ:()[\]{}।\-–—/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractReferenceContentTokens(text: string): Set<string> {
  const norm = normalizeReferenceStem(text);
  const tokens = norm
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !REFERENCE_STOP_WORDS.has(t));
  return new Set(tokens);
}

function splitExamAndPost(rawLabel: string): {
  examTitle: string;
  postName: string | null;
} {
  const cleaned = rawLabel
    .replace(/·\s*সেট[\-–—\s]*[০-৯0-9]+/gi, '')
    .replace(/^প্রশ্ন\s+সমাধান\s*[।:|–—-]+\s*/i, '')
    .trim();
  if (!cleaned) {
    return { examTitle: '', postName: null };
  }

  const postInline = cleaned.match(/^(.+?)\s*[—–\-|·]\s*(?:পদের\s+নাম\s*[:ঃ]\s*)?(.+)$/);
  if (postInline) {
    const left = postInline[1].trim();
    const right = postInline[2].trim();
    if (left.length >= 3 && right.length >= 2) {
      return { examTitle: left, postName: right };
    }
  }
  return { examTitle: cleaned, postName: null };
}

function findChunkExcerpt(
  book: Book | undefined,
  pageNumber: number
): string | null {
  if (!book || book.chunks.length === 0) return null;
  const exact = book.chunks.find((c) => c.pageNumber === pageNumber);
  const target =
    exact ??
    book.chunks.find(
      (c) => Math.abs(c.pageNumber - pageNumber) <= 1
    ) ??
    book.chunks[0];
  return target ? target.content.slice(0, 1400).trim() : null;
}

/**
 * Pre-indexes all imported Library books so Answer Sheet cards can instantly resolve
 * every exam name, post name, date, and original book question with zero API calls.
 */
export function buildQuestionExamReferenceIndex(
  books: Book[]
): QuestionExamReferenceIndex {
  const booksById = new Map<number, Book>();
  const booksByTitle = new Map<string, Book>();
  const examsByBookId = new Map<number, ExtractedExamMetadata[]>();
  const itemsByNormStem = new Map<string, AnalyzedQuestionItem[]>();
  const indexedItems: QuestionExamReferenceIndex['indexedItems'] = [];

  for (const book of books) {
    booksById.set(book.id, book);
    booksByTitle.set(book.title.trim().toLowerCase(), book);
  }

  if (books.length === 0) {
    return {
      booksById,
      booksByTitle,
      examsByBookId,
      itemsByNormStem,
      indexedItems,
    };
  }

  // Analyze each book individually so bookId & pageNumber stay exact per imported book
  for (const book of books) {
    const report = analyzeBookOrSeriesQuestions([book], book.title);

    if (report.exams.length > 0) {
      examsByBookId.set(book.id, report.exams);
    }

    for (const item of report.questions) {
      const normStem = normalizeReferenceStem(item.questionText);
      if (!normStem || normStem.length < 4) continue;

      const list = itemsByNormStem.get(normStem) ?? [];
      list.push(item);
      itemsByNormStem.set(normStem, list);

      indexedItems.push({
        item,
        normStem,
        contentTokens: extractReferenceContentTokens(item.questionText),
      });
    }
  }

  return {
    booksById,
    booksByTitle,
    examsByBookId,
    itemsByNormStem,
    indexedItems,
  };
}

function toReferenceFromAnalyzedItem(
  item: AnalyzedQuestionItem,
  book: Book | undefined,
  matchType: 'exact_question' | 'similar_question'
): QuestionExamReference {
  const parsedPair =
    item.postName || !item.examTitle
      ? {
          examTitle: item.institution || item.examTitle || item.bookTitle,
          postName: item.postName,
        }
      : splitExamAndPost(item.examTitle);

  const explanationText =
    item.explanation?.trim() ||
    (item.solutionSteps.length > 0 ? item.solutionSteps.join('\n') : null);

  return {
    id: `${item.bookId}-${item.examId}-${item.pageNumber}-${item.questionNumber}`,
    examTitle: parsedPair.examTitle || item.bookTitle,
    postName: parsedPair.postName,
    examDate: item.examDate,
    bookId: item.bookId,
    bookTitle: item.bookTitle,
    pageNumber: Math.max(1, item.pageNumber || 1),
    pageLabel: item.pageLabel || String(Math.max(1, item.pageNumber || 1)),
    examId: item.examId || null,
    numberLabel: item.numberLabel || null,
    originalQuestionText: item.questionText,
    originalOptions: item.options,
    originalAnswerText: item.answerText || null,
    originalExplanation: explanationText,
    sourcePageExcerpt: findChunkExcerpt(book, item.pageNumber),
    matchType,
  };
}

/**
 * Resolves all exam + post references where a question appeared across the user's books.
 * Falls back cleanly to the exam header on the question's source book page if the stem was
 * paraphrased by AI, so users can always inspect the original source exam and jump to Smart Reader.
 */
export function findExamReferencesForQuestion(
  index: QuestionExamReferenceIndex,
  query: {
    stem: string;
    bookId?: number | null;
    bookTitle?: string;
    pageNumber?: number;
    examSource?: string | null;
    chapter?: string;
  }
): QuestionExamReference[] {
  const refs: QuestionExamReference[] = [];
  const seenKeys = new Set<string>();

  const pushUnique = (ref: QuestionExamReference) => {
    const key = [
      ref.bookId,
      ref.pageNumber,
      ref.examTitle.trim().toLowerCase(),
      (ref.postName || '').trim().toLowerCase(),
    ].join('|');
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    refs.push(ref);
  };

  const normQuery = normalizeReferenceStem(query.stem);

  // 1. Exact normalized stem match across all imported books
  if (normQuery.length >= 4) {
    const exactItems = index.itemsByNormStem.get(normQuery) ?? [];
    for (const item of exactItems) {
      pushUnique(
        toReferenceFromAnalyzedItem(
          item,
          index.booksById.get(item.bookId),
          'exact_question'
        )
      );
    }
  }

  // 2. High-overlap content-token match (catches OCR/punctuation or AI slight rephrasing)
  const queryTokens = extractReferenceContentTokens(query.stem);
  if (queryTokens.size >= 2) {
    const scoredMatches: Array<{ item: AnalyzedQuestionItem; score: number }> = [];
    for (const entry of index.indexedItems) {
      if (entry.normStem === normQuery) continue;
      if (entry.contentTokens.size === 0) continue;

      let intersection = 0;
      for (const tok of queryTokens) {
        if (entry.contentTokens.has(tok)) intersection += 1;
      }
      if (intersection === 0) continue;

      const minSize = Math.min(queryTokens.size, entry.contentTokens.size);
      const unionSize = queryTokens.size + entry.contentTokens.size - intersection;
      const jaccard = unionSize > 0 ? intersection / unionSize : 0;
      const containment = minSize > 0 ? intersection / minSize : 0;

      // Require strong semantic overlap so unrelated questions never falsely link
      const isStrongMatch =
        (queryTokens.size >= 3 && (jaccard >= 0.62 || (containment >= 0.8 && intersection >= 3))) ||
        (queryTokens.size === 2 && jaccard >= 0.85);

      if (isStrongMatch) {
        scoredMatches.push({
          item: entry.item,
          score: jaccard * 0.6 + containment * 0.4,
        });
      }
    }

    scoredMatches.sort((a, b) => b.score - a.score);
    for (const match of scoredMatches.slice(0, 6)) {
      pushUnique(
        toReferenceFromAnalyzedItem(
          match.item,
          index.booksById.get(match.item.bookId),
          'similar_question'
        )
      );
    }
  }

  // 3. Fallback: resolve the exact exam covering (bookId/bookTitle + pageNumber)
  if (refs.length === 0) {
    const sourceBook =
      (query.bookId ? index.booksById.get(query.bookId) : undefined) ??
      (query.bookTitle
        ? index.booksByTitle.get(query.bookTitle.trim().toLowerCase())
        : undefined);

    const safePage = Math.max(1, Number(query.pageNumber || 1));

    if (sourceBook) {
      const bookExams = index.examsByBookId.get(sourceBook.id) ?? [];
      const pageExam =
        bookExams.find(
          (ex) => safePage >= ex.startPage && safePage <= ex.endPage
        ) ??
        bookExams.find(
          (ex) =>
            Math.abs(ex.startPage - safePage) <= 1 ||
            Math.abs(ex.endPage - safePage) <= 1
        ) ??
        null;

      if (pageExam) {
        const parsedPair =
          pageExam.postName || !pageExam.examTitle
            ? {
                examTitle: pageExam.institution || pageExam.examTitle,
                postName: pageExam.postName,
              }
            : splitExamAndPost(pageExam.examTitle);

        pushUnique({
          id: `page-exam-${sourceBook.id}-${pageExam.examId}-${safePage}`,
          examTitle: parsedPair.examTitle || sourceBook.title,
          postName: parsedPair.postName,
          examDate: pageExam.examDate,
          bookId: sourceBook.id,
          bookTitle: sourceBook.title,
          pageNumber: safePage,
          pageLabel: pageExam.pageLabel || String(safePage),
          examId: pageExam.examId,
          numberLabel: null,
          originalQuestionText: null,
          originalOptions: [],
          originalAnswerText: null,
          originalExplanation: null,
          sourcePageExcerpt: findChunkExcerpt(sourceBook, safePage),
          matchType: 'source_page_exam',
        });
      } else {
        // Book exists but isn't divided into job-exam papers (e.g. textbook / BCS guide)
        const fallbackMeta = query.examSource
          ? splitExamAndPost(query.examSource)
          : { examTitle: sourceBook.title, postName: null };

        pushUnique({
          id: `book-page-${sourceBook.id}-${safePage}`,
          examTitle: fallbackMeta.examTitle || sourceBook.title,
          postName: fallbackMeta.postName,
          examDate: null,
          bookId: sourceBook.id,
          bookTitle: sourceBook.title,
          pageNumber: safePage,
          pageLabel: String(safePage),
          examId: null,
          numberLabel: null,
          originalQuestionText: null,
          originalOptions: [],
          originalAnswerText: null,
          originalExplanation: null,
          sourcePageExcerpt: findChunkExcerpt(sourceBook, safePage),
          matchType: 'source_page_exam',
        });
      }
    }
  }

  return refs;
}
