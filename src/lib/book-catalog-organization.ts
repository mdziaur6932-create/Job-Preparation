import type { Book, BookCategory } from '../types/system';
import {
  groupBooksIntoSeries,
  parseBookSeriesIdentity,
  type BookSeriesGroup,
} from './book-series-and-topic-analyzer';

export type BookContentFormat = 'MCQ' | 'Written' | 'Combined' | 'Textbook';

export interface BookCatalogOverrides {
  /** Custom Virtual Master Book name assigned by user (`bookId -> masterBookTitle`) */
  customMasterByBookId: Record<string, string>;
  /** Explicit user-chosen format override (`bookId -> BookContentFormat`) */
  customFormatByBookId: Record<string, BookContentFormat>;
}

export interface VirtualMasterBookEntry {
  /** Stable key for UI accordion/selection */
  masterKey: string;
  /** Clean display title of the Virtual Master Book (e.g. "Job Solution 2026 (MCQ)") */
  title: string;
  category: BookCategory;
  subject: string;
  format: BookContentFormat;
  isVirtualSeries: boolean;
  /** Whether the grouping came from user's explicit virtual folder assignment */
  isCustomGrouped: boolean;
  books: Book[];
  primaryBookId: number;
  totalPages: number;
  totalChunks: number;
  partLabelsByBookId: Record<number, string>;
}

export const EMPTY_CATALOG_OVERRIDES: BookCatalogOverrides = {
  customMasterByBookId: {},
  customFormatByBookId: {},
};

export const BOOK_FORMAT_LABELS: Record<BookContentFormat, string> = {
  MCQ: 'MCQ',
  Written: 'Written (লিখিত)',
  Combined: 'MCQ + Written',
  Textbook: 'মূল বই / নোট',
};

const MONTH_NAME_RE =
  /(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|জানুয়ারি|জানুয়ারি|ফেব্রুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর)/i;

const MONTH_ORDER_MAP: Record<string, number> = {
  january: 1,
  jan: 1,
  জানুয়ারি: 1,
  জানুয়ারি: 1,
  february: 2,
  feb: 2,
  ফেব্রুয়ারি: 2,
  ফেব্রুয়ারি: 2,
  march: 3,
  mar: 3,
  মার্চ: 3,
  april: 4,
  apr: 4,
  এপ্রিল: 4,
  may: 5,
  মে: 5,
  june: 6,
  jun: 6,
  জুন: 6,
  july: 7,
  jul: 7,
  জুলাই: 7,
  august: 8,
  aug: 8,
  আগস্ট: 8,
  september: 9,
  sep: 9,
  sept: 9,
  সেপ্টেম্বর: 9,
  october: 10,
  oct: 10,
  অক্টোবর: 10,
  november: 11,
  nov: 11,
  নভেম্বর: 11,
  december: 12,
  dec: 12,
  ডিসেম্বর: 12,
};

function toAsciiDigits(s: string): string {
  return (s || '').replace(/[০-৯]/g, (ch) => String('০১২৩৪৫৬৭৮৯'.indexOf(ch)));
}

/**
 * Automatically classifies a book's content format (`MCQ`, `Written`, `Combined`, or `Textbook`)
 * from explicit override, title keywords, or sampled chunk structure.
 */
export function detectBookContentFormat(
  book: Pick<Book, 'id' | 'title' | 'category' | 'chunks'>,
  override?: BookContentFormat | null
): BookContentFormat {
  if (override) return override;

  const title = (book.title || '').trim();
  const hasMcqInTitle = /\bMCQ\b|বহুনির্বাচনি|প্রিলিমিনারি|preliminary/i.test(title);
  const hasWrittenInTitle = /\bWritten\b|লিখিত/i.test(title);

  if (hasMcqInTitle && hasWrittenInTitle) return 'Combined';
  if (hasMcqInTitle) return 'MCQ';
  if (hasWrittenInTitle) return 'Written';

  // Inspect first few chunks to distinguish MCQ vs Written vs Textbook
  const sampleText = book.chunks
    .slice(0, 6)
    .map((c) => c.content)
    .join('\n');

  const mcqOptionMatches =
    sampleText.match(/(?:^|\s)(?:[কখগঘ][.)]|[a-dA-D][.)])\s+\S/gm)?.length ?? 0;
  const answerMatches =
    sampleText.match(/(?:^|\s)(?:উত্তর|উ\.|Answer|Ans)\s*[:ঃ.]/gim)?.length ?? 0;
  const writtenMarkerMatches =
    sampleText.match(/(?:টীকা\s*লিখুন|অনুবাদ\s*করুন|রচনা\s*লিখুন|সমাধান\s*করুন|মান\s*[:ঃ]|\[\s*[০-৯0-9]{1,2}\s*\])/gi)
      ?.length ?? 0;

  if (mcqOptionMatches >= 4 && writtenMarkerMatches >= 3) {
    return 'Combined';
  }
  if (mcqOptionMatches >= 4 || (answerMatches >= 3 && mcqOptionMatches >= 2)) {
    return 'MCQ';
  }
  if (writtenMarkerMatches >= 2) {
    return 'Written';
  }

  if (
    book.category === 'রিসেন্ট জব সলুশন' ||
    book.category === 'Previous Year'
  ) {
    return 'Combined';
  }

  return 'Textbook';
}

export interface EnhancedSeriesIdentity {
  masterKey: string;
  masterTitle: string;
  partNumber: number | null;
  partLabel: string | null;
}

/**
 * Recognizes BOTH classic trailing part markers ("Part 01", "খণ্ড ২") AND
 * numbered/monthly Job Solution splits such as:
 * - "01. Job Solution - January 2026 (MCQ)"
 * - "04. Job Solution - April 2026 (MCQ)"
 * - "05. Job Solution - May 2026 (MCQ)"
 * - "01. রিসেন্ট জব সলুশন - জানুয়ারি ২০২৬ (Written)"
 * while strictly keeping MCQ and Written series separate!
 */
export function parseEnhancedMasterBookIdentity(
  rawTitle: string,
  format: BookContentFormat
): EnhancedSeriesIdentity {
  const cleaned = (rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return {
      masterKey: 'untitled',
      masterTitle: 'শিরোনামহীন বই',
      partNumber: null,
      partLabel: null,
    };
  }

  // Pattern A: Leading numeric serial + optional month name (e.g. "01. Job Solution - January 2026 (MCQ)")
  const leadingNumMatch = cleaned.match(/^([0-9০-৯]{1,3})\s*[.)\-–—]\s*(.+)$/);
  if (leadingNumMatch) {
    const seqNum = Number.parseInt(toAsciiDigits(leadingNumMatch[1]), 10);
    const rest = leadingNumMatch[2].trim();

    // Check if rest contains a month name (e.g. "Job Solution - January 2026 (MCQ)")
    const monthMatch = rest.match(MONTH_NAME_RE);
    if (monthMatch) {
      const monthWord = monthMatch[0];
      const baseWithoutMonth = rest
        .replace(new RegExp(`[\\s\\-–—_:]*${monthWord}[\\s\\-–—_:]*`, 'i'), ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\-–—:\s]+|[\-–—:\s]+$/g, '')
        .trim();

      if (baseWithoutMonth.length >= 3) {
        const formatTag =
          format === 'MCQ' || format === 'Written' ? `|${format.toLowerCase()}` : '';
        return {
          masterKey: `${baseWithoutMonth
            .toLowerCase()
            .replace(/[^a-z0-9\u0980-\u09FF]+/g, ' ')
            .trim()}${formatTag}`,
          masterTitle: baseWithoutMonth,
          partNumber: Number.isFinite(seqNum)
            ? seqNum
            : (MONTH_ORDER_MAP[monthWord.toLowerCase()] ?? null),
          partLabel: `${leadingNumMatch[1]}. ${monthWord}`,
        };
      }
    }

    // Even without a month word, check trailing part or same prefix after leading serial
    const innerSeries = parseBookSeriesIdentity(rest);
    if (innerSeries.partNumber !== null) {
      const formatTag =
        format === 'MCQ' || format === 'Written' ? `|${format.toLowerCase()}` : '';
      return {
        masterKey: `${innerSeries.seriesKey}${formatTag}`,
        masterTitle: innerSeries.seriesTitle,
        partNumber: Number.isFinite(seqNum) ? seqNum : innerSeries.partNumber,
        partLabel: innerSeries.partLabel || `খণ্ড ${seqNum}`,
      };
    }
  }

  // Pattern B: Month-split without leading number (e.g. "Job Solution - January 2026 (MCQ)")
  const directMonthMatch = cleaned.match(MONTH_NAME_RE);
  if (
    directMonthMatch &&
    /job\s*solution|জব\s*সলুশন|জব\s*সলিউশন|current|ডাইজেস্ট|digest/i.test(cleaned)
  ) {
    const monthWord = directMonthMatch[0];
    const baseWithoutMonth = cleaned
      .replace(new RegExp(`[\\s\\-–—_:]*${monthWord}[\\s\\-–—_:]*`, 'i'), ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\-–—:\s]+|[\-–—:\s]+$/g, '')
      .trim();

    if (baseWithoutMonth.length >= 4) {
      const formatTag =
        format === 'MCQ' || format === 'Written' ? `|${format.toLowerCase()}` : '';
      return {
        masterKey: `${baseWithoutMonth
          .toLowerCase()
          .replace(/[^a-z0-9\u0980-\u09FF]+/g, ' ')
          .trim()}${formatTag}`,
        masterTitle: baseWithoutMonth,
        partNumber: MONTH_ORDER_MAP[monthWord.toLowerCase()] ?? null,
        partLabel: monthWord,
      };
    }
  }

  // Pattern C: Standard trailing Part / Vol / খণ্ড / পর্ব detection
  const baseIdentity = parseBookSeriesIdentity(cleaned);
  const formatTag =
    format === 'MCQ' || format === 'Written' ? `|${format.toLowerCase()}` : '';
  return {
    masterKey: `${baseIdentity.seriesKey}${formatTag}`,
    masterTitle: baseIdentity.seriesTitle,
    partNumber: baseIdentity.partNumber,
    partLabel: baseIdentity.partLabel,
  };
}

/**
 * Option (ক) — Virtual Master Book Merge:
 * Collapses split PDF parts (e.g. 18+ Job Solution parts or multi-part BCS/Bank books)
 * into clean Virtual Master Book containers while keeping every underlying part intact,
 * fast, independently replaceable/deletable, and 1-click selectable across the whole app.
 */
export function buildVirtualMasterBookCatalog(
  books: Book[],
  overrides: BookCatalogOverrides = EMPTY_CATALOG_OVERRIDES
): VirtualMasterBookEntry[] {
  if (!books || books.length === 0) return [];

  const buckets = new Map<
    string,
    {
      title: string;
      isCustomGrouped: boolean;
      items: Array<{
        book: Book;
        format: BookContentFormat;
        partNumber: number | null;
        partLabel: string | null;
      }>;
    }
  >();

  for (const book of books) {
    const explicitFormat = overrides.customFormatByBookId[String(book.id)] ?? null;
    const format = detectBookContentFormat(book, explicitFormat);
    const customMaster = (overrides.customMasterByBookId[String(book.id)] || '').trim();

    if (customMaster) {
      const key = `custom:${customMaster.toLowerCase().replace(/\s+/g, ' ')}`;
      const existing = buckets.get(key);
      const idInfo = parseEnhancedMasterBookIdentity(book.title, format);
      if (existing) {
        existing.items.push({
          book,
          format,
          partNumber: idInfo.partNumber,
          partLabel: idInfo.partLabel || book.title,
        });
      } else {
        buckets.set(key, {
          title: customMaster,
          isCustomGrouped: true,
          items: [
            {
              book,
              format,
              partNumber: idInfo.partNumber,
              partLabel: idInfo.partLabel || book.title,
            },
          ],
        });
      }
      continue;
    }

    const identity = parseEnhancedMasterBookIdentity(book.title, format);
    const existing = buckets.get(identity.masterKey);
    if (existing) {
      existing.items.push({
        book,
        format,
        partNumber: identity.partNumber,
        partLabel: identity.partLabel,
      });
    } else {
      buckets.set(identity.masterKey, {
        title: identity.masterTitle,
        isCustomGrouped: false,
        items: [
          {
            book,
            format,
            partNumber: identity.partNumber,
            partLabel: identity.partLabel,
          },
        ],
      });
    }
  }

  const entries: VirtualMasterBookEntry[] = [];

  for (const [masterKey, bucket] of buckets.entries()) {
    const sorted = [...bucket.items].sort((a, b) => {
      const pa = a.partNumber ?? Number.MAX_SAFE_INTEGER;
      const pb = b.partNumber ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      if (a.book.createdAt !== b.book.createdAt) {
        return a.book.createdAt.localeCompare(b.book.createdAt);
      }
      return a.book.id - b.book.id;
    });

    const isVirtualSeries = sorted.length > 1 || bucket.isCustomGrouped;
    const first = sorted[0];

    // Derive combined format if a custom folder mixes MCQ & Written parts
    const distinctFormats = new Set(sorted.map((s) => s.format));
    let aggregatedFormat: BookContentFormat = first.format;
    if (distinctFormats.has('MCQ') && distinctFormats.has('Written')) {
      aggregatedFormat = 'Combined';
    } else if (distinctFormats.size === 1) {
      aggregatedFormat = first.format;
    }

    const partLabelsByBookId: Record<number, string> = {};
    sorted.forEach((item, idx) => {
      partLabelsByBookId[item.book.id] =
        item.partLabel || `খণ্ড ${idx + 1}`;
    });

    entries.push({
      masterKey,
      title: isVirtualSeries ? bucket.title : first.book.title,
      category: first.book.category,
      subject: first.book.subject,
      format: aggregatedFormat,
      isVirtualSeries,
      isCustomGrouped: bucket.isCustomGrouped,
      books: sorted.map((s) => s.book),
      primaryBookId: first.book.id,
      totalPages: sorted.reduce((acc, s) => acc + Math.max(1, s.book.totalPages || 0), 0),
      totalChunks: sorted.reduce((acc, s) => acc + s.book.chunks.length, 0),
      partLabelsByBookId,
    });
  }

  // Sort: multi-part Master Books first (newest first), then standalone books (newest first)
  entries.sort((a, b) => {
    if (a.isVirtualSeries !== b.isVirtualSeries) {
      return a.isVirtualSeries ? -1 : 1;
    }
    const maxIdA = Math.max(...a.books.map((x) => x.id));
    const maxIdB = Math.max(...b.books.map((x) => x.id));
    return maxIdB - maxIdA;
  });

  return entries;
}

/**
 * Builds unified `BookSeriesGroup[]` that respects BOTH enhanced monthly/part auto-detection
 * AND user custom Virtual Master Book folders — so Smart Reader seamlessly combines all
 * 18+ parts of a Virtual Master Book with continuous page offsets!
 */
export function buildUnifiedSeriesGroupsWithOverrides(
  books: Book[],
  overrides: BookCatalogOverrides = EMPTY_CATALOG_OVERRIDES
): BookSeriesGroup[] {
  const catalog = buildVirtualMasterBookCatalog(books, overrides);
  const result: BookSeriesGroup[] = [];

  for (const entry of catalog) {
    // Reuse groupBooksIntoSeries on each virtual master's books with a single forced title
    if (entry.books.length === 1) {
      const single = groupBooksIntoSeries(entry.books)[0];
      if (single) result.push(single);
      continue;
    }

    const partRanges: BookSeriesGroup['partRanges'] = [];
    const combinedChunks: BookSeriesGroup['combinedChunks'] = [];
    let pageOffset = 0;
    let runningChunkIndex = 0;

    entry.books.forEach((book, idx) => {
      const partLabel = entry.partLabelsByBookId[book.id] || `Part ${String(idx + 1).padStart(2, '0')}`;
      const sortedChunks = [...book.chunks].sort(
        (a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex || a.id - b.id
      );
      const maxChunkPage =
        sortedChunks.length > 0 ? Math.max(...sortedChunks.map((c) => c.pageNumber)) : 0;
      const span = Math.max(book.totalPages || 0, maxChunkPage, 1);

      partRanges.push({
        bookId: book.id,
        bookTitle: book.title,
        partNumber: idx + 1,
        partLabel,
        originalPages: span,
        startOffsetPage: pageOffset + 1,
        endOffsetPage: pageOffset + span,
      });

      for (const chunk of sortedChunks) {
        combinedChunks.push({
          ...chunk,
          bookTitle: `${entry.title} (${partLabel})`,
          pageNumber: pageOffset + Math.max(1, chunk.pageNumber),
          chunkIndex: runningChunkIndex++,
        });
      }
      pageOffset += span;
    });

    result.push({
      seriesKey: entry.masterKey,
      seriesTitle: entry.title,
      books: entry.books,
      isMultiPart: entry.books.length > 1,
      primaryBookId: entry.primaryBookId,
      totalPages: Math.max(1, pageOffset),
      subject: entry.subject,
      category: entry.category,
      partRanges,
      combinedChunks,
    });
  }

  return result;
}
