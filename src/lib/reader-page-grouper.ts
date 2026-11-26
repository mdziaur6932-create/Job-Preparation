import type { Book, BookChunk } from '../types/system';
import type { CombinedExtractionResult } from './pdf-rules';
import { chunkBookText } from './rag-engine';
import {
  extractExamTitleFromText,
  hasExamDocumentStructure,
  normalizeExamDocumentFormatting,
} from './exam-text-formatter';

export type SmartReaderViewMode = 'exam' | 'page';

export interface ReassembledBookPage {
  id: string;
  pageNumber: number;
  chapter: string;
  bookTitle: string;
  content: string;
  sourceChunks: BookChunk[];
  examTitle: string | null;
  hasExamStructure: boolean;
  questionNumbers: number[];
}

export interface SmartReaderViewUnit {
  id: string;
  kind: 'exam' | 'page';
  title: string;
  chapter: string;
  bookTitle: string;
  startPage: number;
  endPage: number;
  pageLabel: string;
  content: string;
  sourceChunks: BookChunk[];
  questionCount: number;
}

function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (ch) => String('০১২৩৪৫৬৭৮৯'.indexOf(ch)));
}

function extractQuestionNumbersFromPage(formattedText: string): number[] {
  const nums: number[] = [];
  const lines = formattedText.split('\n');
  for (const line of lines) {
    const match = line
      .trim()
      .match(
        /^((?:0?[1-9]|[1-9]\d{1,2}|[০-৯]{1,3}))[.\u0964]\s+['"‘’“”(\[\u0980-\u09FFA-Za-z0-9০-৯$]/
      );
    if (match) {
      const parsed = Number.parseInt(toAsciiDigits(match[1]), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 250) {
        nums.push(parsed);
      }
    }
  }
  return nums;
}

export function isGenericChapterLabel(chapter: string): boolean {
  const trimmed = chapter.trim();
  return (
    !trimmed ||
    /^অধ্যায়\s*[০-৯0-9]+(?:\s*[:：-]\s*মূল\s*আলোচনা)?$/.test(trimmed) ||
    /^Chapter\s*[0-9]+$/i.test(trimmed)
  );
}

/**
 * Reassembles RAG micro-chunks belonging to the same `pageNumber` back into
 * ONE complete, cleanly formatted page (preventing Page 1 from appearing as
 * 5 fragmented sub-chunks in Smart Reader).
 */
export function mergeBookChunksByPage(chunks: BookChunk[]): ReassembledBookPage[] {
  if (!chunks || chunks.length === 0) return [];

  const sorted = [...chunks].sort(
    (a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex || a.id - b.id
  );

  const byPage = new Map<number, BookChunk[]>();
  for (const chunk of sorted) {
    const list = byPage.get(chunk.pageNumber);
    if (list) {
      list.push(chunk);
    } else {
      byPage.set(chunk.pageNumber, [chunk]);
    }
  }

  const pages: ReassembledBookPage[] = [];
  for (const [pageNumber, pageChunks] of byPage.entries()) {
    let combinedRaw = '';
    for (const chunk of pageChunks) {
      const piece = chunk.content.trim();
      if (!piece) continue;
      if (!combinedRaw) {
        combinedRaw = piece;
      } else {
        const endsMidSentence = !/[।?!:.\n]$/.test(combinedRaw);
        const startsStructural =
          /^(?:(?:0?[1-9]|[1-9]\d{1,2}|[০-৯]{1,3})[.\u0964]\s*|(?:[a-h]\)|[ক-ঙ]\)|\([ক-ঙ]\))\s*|(?:Solution|উত্তর|সমাধান|ব্যাখ্যা|পদের\s+নাম|পরীক্ষার\s+তারিখ|তারিখ|প্রশ্ন\s+সমাধান)\s*[:ঃ।]?)/i.test(
            piece
          );
        combinedRaw += endsMidSentence && !startsStructural ? `\n${piece}` : `\n\n${piece}`;
      }
    }

    const formatted = normalizeExamDocumentFormatting(combinedRaw);
    const examTitle = extractExamTitleFromText(formatted);
    const isExam = hasExamDocumentStructure(formatted);
    const questionNumbers = isExam ? extractQuestionNumbersFromPage(formatted) : [];

    const firstNonGenericChapter =
      pageChunks.find((c) => !isGenericChapterLabel(c.chapter))?.chapter ??
      pageChunks[0].chapter;

    const resolvedChapter =
      examTitle && isGenericChapterLabel(firstNonGenericChapter)
        ? examTitle
        : firstNonGenericChapter;

    pages.push({
      id: `page-${pageNumber}`,
      pageNumber,
      chapter: resolvedChapter,
      bookTitle: pageChunks[0].bookTitle,
      content: formatted,
      sourceChunks: pageChunks,
      examTitle,
      hasExamStructure: isExam,
      questionNumbers,
    });
  }

  return pages;
}

/**
 * Groups consecutive full pages that belong to the SAME exam paper into a single
 * complete exam view (e.g., Page 1 alone for a 1-page exam like মৎস্য অধিদপ্তর,
 * or Pages 2–3 combined when an exam spans multiple pages before the next exam header
 * or question numbering reset back to 01.).
 */
export function groupBookPagesIntoExams(
  pages: ReassembledBookPage[]
): SmartReaderViewUnit[] {
  if (pages.length === 0) return [];

  const groups: ReassembledBookPage[][] = [];
  let currentGroup: ReassembledBookPage[] = [];
  let maxQuestionSeenInCurrent = 0;

  for (const page of pages) {
    const firstQ = page.questionNumbers[0] ?? null;
    const maxQOnPage =
      page.questionNumbers.length > 0 ? Math.max(...page.questionNumbers) : 0;

    const startsNewExam =
      currentGroup.length === 0 ||
      Boolean(page.examTitle) ||
      (firstQ !== null && firstQ <= 2 && maxQuestionSeenInCurrent >= 4) ||
      // Keep non-exam textbook pages separated by page/chapter cleanly
      (!page.hasExamStructure && !currentGroup[currentGroup.length - 1].hasExamStructure);

    if (startsNewExam) {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [page];
      maxQuestionSeenInCurrent = maxQOnPage;
    } else {
      currentGroup.push(page);
      if (maxQOnPage > maxQuestionSeenInCurrent) {
        maxQuestionSeenInCurrent = maxQOnPage;
      }
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups.map((group, idx) => {
    const first = group[0];
    const last = group[group.length - 1];
    const startPage = first.pageNumber;
    const endPage = last.pageNumber;
    const pageLabel =
      startPage === endPage ? `পৃষ্ঠা ${startPage}` : `পৃষ্ঠা ${startPage}–${endPage}`;

    const mergedContent = normalizeExamDocumentFormatting(
      group.map((p) => p.content).join('\n\n')
    );

    const detectedTitle =
      first.examTitle ||
      (!isGenericChapterLabel(first.chapter) ? first.chapter : null) ||
      (first.hasExamStructure ? `পরীক্ষা ${idx + 1}` : first.chapter);

    const uniqueQuestions = new Set<number>();
    for (const p of group) {
      for (const q of p.questionNumbers) uniqueQuestions.add(q);
    }

    return {
      id: `exam-${idx + 1}-p${startPage}-${endPage}`,
      kind: 'exam',
      title: detectedTitle,
      chapter: detectedTitle,
      bookTitle: first.bookTitle,
      startPage,
      endPage,
      pageLabel,
      content: mergedContent,
      sourceChunks: group.flatMap((p) => p.sourceChunks),
      questionCount: uniqueQuestions.size,
    };
  });
}

/**
 * Builds Smart Reader display units for any book:
 * - Always merges fragmented same-page RAG micro-chunks so 1 page is NEVER split into 5 pieces.
 * - For exam/Job Solution books in `'exam'` mode: groups each complete exam paper together into 1 view.
 * - In `'page'` mode (or for regular non-exam textbooks): returns 1 complete page per view.
 */
export function buildSmartReaderViews(
  chunks: BookChunk[],
  requestedMode?: SmartReaderViewMode
): {
  isExamBook: boolean;
  effectiveMode: SmartReaderViewMode;
  views: SmartReaderViewUnit[];
} {
  const mergedPages = mergeBookChunksByPage(chunks);
  const isExamBook = mergedPages.some((p) => p.hasExamStructure || Boolean(p.examTitle));
  const effectiveMode: SmartReaderViewMode = isExamBook
    ? (requestedMode ?? 'exam')
    : 'page';

  if (effectiveMode === 'exam' && isExamBook) {
    return {
      isExamBook,
      effectiveMode,
      views: groupBookPagesIntoExams(mergedPages),
    };
  }

  const pageViews: SmartReaderViewUnit[] = mergedPages.map((p) => ({
    id: p.id,
    kind: 'page',
    title: p.examTitle || p.chapter,
    chapter: p.chapter,
    bookTitle: p.bookTitle,
    startPage: p.pageNumber,
    endPage: p.pageNumber,
    pageLabel: `পৃষ্ঠা ${p.pageNumber}`,
    content: p.content,
    sourceChunks: p.sourceChunks,
    questionCount: p.questionNumbers.length,
  }));

  return {
    isExamBook,
    effectiveMode,
    views: pageViews,
  };
}

export interface FullPageChunkRecord {
  chapter: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
}

/**
 * Parses explicit `--- পৃষ্ঠা N ---` / `--- Page N ---` markers from raw text while
 * keeping EVERY page completely intact (never fragmenting a page mid-question).
 */
function parseExplicitFullPagesFromRawText(
  rawText: string,
  fallbackChapter: string
): FullPageChunkRecord[] | null {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return null;

  const markerRegex =
    /^-{2,}\s*(?:page|পৃষ্ঠা)\s*[:#-]?\s*([0-9০-৯]+)\s*-{2,}$/gim;
  const hits: Array<{ pageNumber: number; start: number; bodyStart: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = markerRegex.exec(normalized)) !== null) {
    const parsedPage = Number.parseInt(toAsciiDigits(match[1]), 10);
    if (Number.isFinite(parsedPage) && parsedPage >= 1) {
      hits.push({
        pageNumber: parsedPage,
        start: match.index,
        bodyStart: match.index + match[0].length,
      });
    }
  }

  if (hits.length === 0) return null;

  const records: FullPageChunkRecord[] = [];
  for (let i = 0; i < hits.length; i += 1) {
    const cur = hits[i];
    const next = hits[i + 1];
    let body = normalized
      .slice(cur.bodyStart, next ? next.start : normalized.length)
      .trim();

    let chapter = fallbackChapter;
    const chapterMatch = body.match(/^\[([^\]]+)\]\s*/);
    if (chapterMatch) {
      const parsedChapter = chapterMatch[1].trim();
      if (parsedChapter) {
        chapter = parsedChapter;
      }
      body = body.slice(chapterMatch[0].length).trim();
    }

    const formatted = normalizeExamDocumentFormatting(body);
    if (!formatted) continue;

    const detectedTitle = isGenericChapterLabel(chapter)
      ? extractExamTitleFromText(formatted)
      : null;

    records.push({
      chapter: detectedTitle || chapter,
      pageNumber: cur.pageNumber,
      chunkIndex: records.length,
      content: formatted,
    });
  }

  return records.length > 0 ? records : null;
}

/**
 * Full-page book chunk builder used by `BookLibraryView` on OCR, PDF, DOCX, TXT,
 * and manual saves:
 * - Preserves 100% full-page context for every extracted section (NEVER fragments
 *   an exam page into 850-character pieces mid-question).
 * - Preserves explicit `--- পৃষ্ঠা N ---` boundaries on raw/edited text without mid-page splits.
 * - Preserves un-marked pasted exam papers intact as a single full-page exam unit.
 * - Auto-labels generic chapters with the detected exam header title.
 */
export function buildFullPageBookChunks(params: {
  bookTitle: string;
  fallbackChapter: string;
  rawText: string;
  extractionResult: CombinedExtractionResult | null;
  rawTextModifiedByUser: boolean;
}): FullPageChunkRecord[] {
  const {
    bookTitle,
    fallbackChapter,
    rawText,
    extractionResult,
    rawTextModifiedByUser,
  } = params;

  const safeFallbackChapter = fallbackChapter.trim() || 'অধ্যায় ১';

  // Path 1: Structured verified sections from PDF/DOCX/OCR extraction — always 1 intact full page per section
  if (
    extractionResult &&
    extractionResult.sections.length > 0 &&
    !rawTextModifiedByUser
  ) {
    const structuredChunks: FullPageChunkRecord[] = [];

    for (const sec of extractionResult.sections) {
      const cleanedContent = normalizeExamDocumentFormatting(sec.content.trim());
      if (!cleanedContent) continue;

      const rawChapter = sec.chapter.trim() || safeFallbackChapter;
      const detectedTitle = isGenericChapterLabel(rawChapter)
        ? extractExamTitleFromText(cleanedContent)
        : null;

      structuredChunks.push({
        chapter: detectedTitle || rawChapter,
        pageNumber: sec.pageNumber,
        chunkIndex: structuredChunks.length,
        content: cleanedContent,
      });
    }

    if (structuredChunks.length > 0) {
      return structuredChunks;
    }
  }

  // Path 2: Raw / edited / TXT / MD text with explicit page markers — keep each page 100% intact
  const explicitPages = parseExplicitFullPagesFromRawText(rawText, safeFallbackChapter);
  if (explicitPages && explicitPages.length > 0) {
    return explicitPages;
  }

  // Path 3: Un-marked raw text — keep exam papers completely intact; use full-page sizing for prose
  const formattedRaw = normalizeExamDocumentFormatting(rawText.trim());
  if (!formattedRaw) return [];

  if (hasExamDocumentStructure(formattedRaw)) {
    const detectedTitle = isGenericChapterLabel(safeFallbackChapter)
      ? extractExamTitleFromText(formattedRaw)
      : null;
    return [
      {
        chapter: detectedTitle || safeFallbackChapter,
        pageNumber: 1,
        chunkIndex: 0,
        content: formattedRaw,
      },
    ];
  }

  return chunkBookText({
    bookId: 0,
    bookTitle,
    chapter: safeFallbackChapter,
    rawText: formattedRaw,
    maxCharsPerChunk: 5000,
  }).map((c, idx) => ({
    chapter: c.chapter,
    pageNumber: c.pageNumber,
    chunkIndex: idx,
    content: c.content,
  }));
}

/**
 * Summarizes a book's chunks for `BookLibraryView` cards using full-page / full-exam grouping
 * so already-saved fragmented books never display duplicate "(পৃ. 1) · (পৃ. 1) · (পৃ. 1)" entries.
 */
export function buildBookCardSummary(chunks: BookChunk[]): {
  isExamBook: boolean;
  unitCount: number;
  unitLabel: string;
  previewLabels: string[];
} {
  const { isExamBook, views } = buildSmartReaderViews(chunks, 'exam');
  return {
    isExamBook,
    unitCount: views.length,
    unitLabel: isExamBook ? `${views.length}টি পরীক্ষা` : `${views.length} অধ্যায়/পৃষ্ঠা`,
    previewLabels: views.map((v) => `${v.title} (${v.pageLabel})`),
  };
}

/**
 * Converts all books' stored chunks into merged full-page searchable `BookChunk` units
 * for `SmartReaderView` Cross-Book RAG Search, eliminating duplicate Page-1 fragment hits.
 */
export function buildFullPageSearchChunks(books: Book[]): BookChunk[] {
  const merged: BookChunk[] = [];
  for (const book of books) {
    const fullPages = mergeBookChunksByPage(book.chunks);
    for (const page of fullPages) {
      const firstSource = page.sourceChunks[0];
      merged.push({
        id: firstSource ? firstSource.id : book.id * 10000 + page.pageNumber,
        bookId: book.id,
        bookTitle: book.title,
        chapter: page.chapter,
        pageNumber: page.pageNumber,
        chunkIndex: firstSource ? firstSource.chunkIndex : page.pageNumber - 1,
        content: page.content,
        embedding: firstSource?.embedding,
      });
    }
  }
  return merged;
}
