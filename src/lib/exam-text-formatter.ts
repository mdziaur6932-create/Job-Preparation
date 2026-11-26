/**
 * Exam Document & Two-Column PDF Text Reconstructor + Formatter
 *
 * Solves two root causes of broken Bengali/English Job Solution OCR & PDF text output:
 * 1. Acrobat-OCR'd / 2-column PDFs emit every word as a separate PDF text run with `hasEOL: true`,
 *    causing naive `extractText()` to output one word per line and mix left/right columns.
 *    `reconstructPdfPageTextFromTextItems()` reconstructs true horizontal lines by Y-coordinate
 *    and reads two-column pages in strict reading order (top banner -> left column -> right column).
 * 2. Already-extracted vertically fragmented text (1 word per line) or side-by-side inline options
 *    (`a) ... b) ...`) are cleanly reflowed by `normalizeExamDocumentFormatting()` into structured
 *    exam headers, numbered questions (`01.`, `02.`), indented sub-items (`a)`–`e)` / `ক)`–`ঘ)`),
 *    and crisp `Solution:` / math steps — without disturbing ordinary textbook prose.
 */

import { cleanDeterministicMathSymbols } from './exam-math-and-answer-guard';
import {
  isMarkdownTableLine,
  isMarkdownTableSeparatorLine,
  normalizeBrokenMarkdownTables,
  parseMarkdownTableBlock,
  type TableAlignment,
} from './rich-text-and-table-parser';

export interface PdfPositionedTextItem {
  str: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontSize?: number;
  dir?: string;
  hasEOL?: boolean;
}

interface PositionedLine {
  anchorY: number;
  avgHeight: number;
  minX: number;
  maxX: number;
  text: string;
}

const BENGALI_COMBINING_START_RE = /^[\u0981-\u0983\u09BC\u09BE-\u09CD\u09D7\u09E2\u09E3]/;
const NO_SPACE_BEFORE_RE = /^[।,;?!\)\]\}\u0964\u0965]/;
const NO_SPACE_AFTER_RE = /[\(\[\{]$/;

const BENGALI_LABEL_VISARGA_WORDS = [
  'পদের নাম',
  'বাক্যের অর্থ',
  'পরীক্ষার তারিখ',
  'তারিখ',
  'সময়',
  'সময়',
  'পূর্ণমান',
  'মান',
  'বিষয়',
  'বিষয়',
  'অর্থ',
  'উত্তর',
  'সমাধান',
  'ব্যাখ্যা',
  'মন্ত্রণালয়',
  'মন্ত্রণালয়',
  'অধিদপ্তর',
  'দপ্তর',
  'বি.দ্র.',
  'বিঃদ্রঃ',
  'নোট',
  'দ্রষ্টব্য',
  'শ্রেণি',
  'পদ',
  'নাম',
];

const WATERMARK_LINE_PATTERNS = [
  /^\s*(?:https?:\/\/)?(?:www\.)?prebd\.com\s*$/i,
  /^\s*Recent\s+Publication(?:\s+[0-9০-৯]{1,4})?\s*$/i,
  /^\s*Recent\s+(?:Written\s+|Preliminary\s+|BCS\s+|Bank\s+)*Job\s+Solution(?:\s+[0-9০-৯]{1,4})?\s*$/i,
];

/**
 * Standalone book-title / publisher running headers & footers that frequently appear
 * in Bangladeshi Job Solution PDFs (e.g. "অগ্রদূত রিসেন্ট লিখিত জব সলিউশন",
 * "অগ্রদূত Recent Job Solution", "‘অগ্রদূত বাংলাদেশ বিষয়াবলি’").
 */
const STANDALONE_BOOK_BRAND_RE =
  /^[\s"'‘’“”•\-–—|]*((?:অগ্রদূত|রিসেন্ট|প্রফেসর['’]?স|প্রফেসরস|ওরাকল|এমপিথ্রি|MP3|খায়রুল['’]?স|খায়রুলস|অ্যাসিওরেন্স|জর্জ|সেল্ফ\s*প্রিপারেশন|বিসিএস\s+ডাইজেস্ট)\s*(?:(?:রিসেন্ট\s*)?(?:লিখিত\s+|প্রিলি\s+|প্রিলিমিনারি\s+|বিসিএস\s+|ব্যাংক\s+)*(?:জব\s*সলি?উশন|জব\s*সমাধান|পাবলিকেশন[স্স]?|প্রকাশনী)|Recent\s+(?:Written\s+|Preliminary\s+|BCS\s+|Bank\s+)*Job\s+Solution|(?:বাংলাদেশ\s+বিষয়াবলি|আন্তর্জাতিক\s+বিষয়াবলি|কম্পিউটার\s+ও\s+তথ্য\s+প্রযুক্তি|Basic\s+Math|Competitive\s+English|মাসিক\s+পরিক্রমা))|(?:রিসেন্ট\s+)?(?:লিখিত\s+)?জব\s*সলি?উশন)(?:\s*[-–—|]?\s*(?:পৃষ্ঠা\s*)?[0-9০-৯]{0,4})?[\s"'‘’“”।.,\-–—|]*$/i;

/**
 * Publisher guide-book cross-reference lines printed beneath questions that point readers
 * to the publisher's own guide book & page number instead of giving an answer, e.g.:
 * - "[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫০"
 * - "[সেল্ফ প্রিপারেশন ইংরেজি (নতুন সংস্করণ); পৃষ্ঠা-13/rule"
 * - "পৃষ্ঠা: ৬৬২ এর ৯৪৬ নম্বর (অগ্রদূত Basic Math, 2nd Edition, January-2024)"
 * - "পৃষ্ঠা: ২১১ (অগ্রদূত কম্পিউটার ও তথ্য প্রযুক্তি)"
 * - "পৃষ্ঠা: ৮৪ (অগ্রদূত বাংলা; ১৩তম সংস্করণ)"
 *
 * These are strictly NOT answers and must never be kept during OCR or display.
 */
const PUBLISHER_BOOK_CROSS_REF_LINE_PATTERNS: RegExp[] = [
  // Bracketed or unbracketed guide cross-ref with publisher/edition + পৃষ্ঠা/পৃ./page (closing `]` optional!)
  /^[\s"'‘’“”]*[\[(]?[^\n\]()]{1,100}(?:সেল্ফ\s*প্রিপারেশন|অগ্রদূত|ক্রিম|প্রফেসর['’]?স|প্রফেসরস|ওরাকল|এমপিথ্রি|MP3|অ্যাসিওরেন্স|খায়রুল['’]?স|খায়রুলস|জর্জ|রিসেন্ট|নতুন\s+সংস্করণ|\d+(?:st|nd|rd|th)\s+Edition|[০-৯0-9]+(?:ম|য়|র্থ|তম)\s+সংস্করণ)[^\n\]]*?(?:পৃষ্ঠা|পৃ\.|page)\s*[-:ঃ.]?\s*[0-9০-৯]+[^\n]*$/i,
  // Generic bracketed `[Book Name (Edition); পৃষ্ঠা-123` cross-reference (closing `]` optional)
  /^[\s"'‘’“”]*\[[^\n\]]{2,100}[;,:ঃ\s\-–—]+(?:পৃষ্ঠা|পৃ\.|page)\s*[-:ঃ.]?\s*[0-9০-৯]+[^\n]*\]?\s*$/i,
  // Publisher page-citation line starting with `পৃষ্ঠা: ৫৮ (ক্রিম; জানুয়ারি- ২০২৫)` or `পৃষ্ঠা: ৩৪৭ (অগ্রদূত আন্তর্জাতিক বিষয়াবলি; ৮ম সংস্করণ)` (closing `)` optional if OCR clipped)
  /^[\s"'‘’“”\[]*(?:পৃষ্ঠা|পৃ\.)\s*[:ঃ.\-]?\s*[0-9০-৯]+[^\n]*\([^)\n]{2,160}\)?[\s"'‘’“”\]।.]*$/i,
];

/**
 * Full promotional / book-release / library availability sentences & inline publisher
 * cross-reference tags printed as publisher ads in job solution books.
 */
const PROMOTIONAL_SENTENCE_PATTERNS: RegExp[] = [
  // Bengali book availability / release announcements mentioning বইটি + লাইব্রেরিতে/বাজারে/সংগ্রহ/অর্ডার
  /[^।\n]*?বই(?:টি|সমূহ)?[^।\n]{0,90}?(?:লাইব্রেরি(?:তে|তেও)?|লাইব্রেরী(?:তে|তেও)?|বাজারে)\s*(?:পাওয়া\s*(?:যাবে|যাচ্ছে)|এসেছে|মিলবে)[^।\n]*[।.]?/gi,
  /[^।\n]*?(?:আগামী\s+সপ্তাহ|শীঘ্রই|খুব\s+শীঘ্রই|এখন|বর্তমানে)\s*(?:থেকে\s*)?(?:সকল\s+|নিকটস্থ\s+)?(?:লাইব্রেরি(?:তে)?|লাইব্রেরী(?:তে)?|বাজারে)\s*পাওয়া\s*(?:যাবে|যাচ্ছে)[^।\n]*[।.]?/gi,
  /[^।\n]*?(?:লাইব্রেরি(?:তে|তেও)?|লাইব্রেরী(?:তে|তেও)?)\s*পাওয়া\s*(?:যাবে|যাচ্ছে)[^।\n]*[।.]?/gi,
  /[^।\n]*?(?:সমাধান\s+সম্বলিত|প্রশ্নের\s+নির্ভুল\s+সমাধান\s+সম্বলিত)[^।\n]*?বইটি[^।\n]*[।.]?/gi,
  /[^।\n]*?(?:নতুন|হালনাগাদ|সর্বশেষ)\s+সংস্করণ\s*(?:বাজারে|লাইব্রেরিতে|লাইব্রেরীতে)\s*(?:এসেছে|পাওয়া\s*(?:যাবে|যাচ্ছে))[^।\n]*[।.]?/gi,
  /[^।\n]*?(?:বই(?:টি)?\s*(?:সংগ্রহ|অর্ডার|কিনতে)\s*(?:করুন|করতে|যোগাযোগ)|হোম\s*ডেলিভারি(?:র\s+জন্য)?|অনলাইনে\s+অর্ডার\s+করতে)[^।\n]*[।.]?/gi,
  // Promotional "শতভাগ কমনের জন্য পড়ুন ..." book recommendation banner
  /[^।\n]*?শতভাগ\s+কমনের\s+জন্য\s+পড়ুন[^।\n]*[।.]?/gi,
  // Inline quoted or unquoted publisher brand banner like ‘অগ্রদূত রিসেন্ট লিখিত জব সলিউশন’ or `অগ্রদূত Recent Job Solution`
  /[\s"'‘’“”]*অগ্রদূত\s+(?:রিসেন্ট\s+)?(?:লিখিত\s+|প্রিলি\s+|বিসিএস\s+|ব্যাংক\s+)*জব\s*সলি?উশন[\s"'‘’“”।.]*/gi,
  /[\s"'‘’“”]*(?:অগ্রদূত|রিসেন্ট|প্রফেসর['’]?স|প্রফেসরস|ওরাকল|এমপিথ্রি|MP3|খায়রুল['’]?স|অ্যাসিওরেন্স)\s+Recent\s+(?:Written\s+|Preliminary\s+|BCS\s+|Bank\s+)*Job\s+Solution(?:\s+[0-9০-৯]{1,4})?[\s"'‘’“”।.]*/gi,
  // Inline bracketed publisher cross-reference tag (e.g. `[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫০`, closing `]` optional)
  /\s*\[[^\n\]]*(?:সেল্ফ\s*প্রিপারেশন|অগ্রদূত|ক্রিম|প্রফেসর['’]?স|প্রফেসরস|ওরাকল|এমপিথ্রি|MP3|অ্যাসিওরেন্স|খায়রুল['’]?স|জর্জ|নতুন\s+সংস্করণ|সংস্করণ|Edition)[^\n\]]*(?:পৃষ্ঠা|পৃ\.|page)\s*[-:ঃ.]?\s*[0-9০-৯]+[^\n\]]*\]?/gi,
  // Inline publisher page citation tag (e.g. `পৃষ্ঠা: ৫৮ (ক্রিম; জানুয়ারি- ২০২৫)`, `পৃষ্ঠা: ৩৪৭ (অগ্রদূত আন্তর্জাতিক বিষয়াবলি; ৮ম সংস্করণ)`)
  /\s*\[?(?:পৃষ্ঠা|পৃ\.)\s*[:ঃ.\-]?\s*[0-9০-৯]+[^\n()]{0,45}\([^)\n]{2,160}\)?\]?/gi,
];

const PROMOTIONAL_LINE_PATTERNS: RegExp[] = [
  STANDALONE_BOOK_BRAND_RE,
  ...PUBLISHER_BOOK_CROSS_REF_LINE_PATTERNS,
  /^(?:প্রকাশনায়|পরিবেশনায়|প্রকাশক|সৌজন্যে|যোগাযোগ|হটলাইন)\s*[:ঃ]/i,
  /(?:লাইব্রেরিতে|লাইব্রেরীতে|বাজারে)\s*পাওয়া\s*(?:যাবে|যাচ্ছে)/i,
  /বই(?:টি)?\s+(?:আগামী\s+সপ্তাহ|নিকটস্থ|সকল)\s+.*?(?:লাইব্রেরি|লাইব্রেরী|পাওয়া\s+যাবে)/i,
  /শতভাগ\s+কমনের\s+জন্য\s+পড়ুন/i,
  /অগ্রদূত\s+(?:রিসেন্ট\s+)?(?:লিখিত\s+)?জব\s*সলি?উশন/i,
  /অগ্রদূত\s+Recent\s+(?:Written\s+|Preliminary\s+|BCS\s+|Bank\s+)*Job\s+Solution/i,
];

const PROTECTED_SYSTEM_ANNOTATION_LINE_RE =
  /^(?:\[AI দ্বারা তৈরি উত্তর\]|(?:রেফারেন্স|Reference)\s*[:ঃ]|\[হাইলাইট\s*[:ঃ]|\[চিত্র\s*[:ঃ]|!\[[^\]]*\]\(data:image\/|<\/?center>)/i;

const DANGLING_EMPTY_ANSWER_LABEL_RE =
  /^(?:Solution|Answer|Ans|উত্তর|সমাধান|ব্যাখ্যা)\s*[:ঃ.]?\s*$/i;

/**
 * Returns true if a single line is purely a publisher advertisement, book-release notice,
 * publisher guide-book page cross-reference (NOT an answer), or standalone Job Solution
 * running header/footer.
 * Protects numbered exam questions (`01. ...`, `১২। ...`), options, and genuine AI references.
 */
export function isPromotionalBookAdLine(line: string): boolean {
  const trimmed = (line ?? '').trim();
  if (!trimmed) return false;

  // NEVER drop genuine AI-generated answer markers, verified references, or red-lined highlights
  if (PROTECTED_SYSTEM_ANNOTATION_LINE_RE.test(trimmed)) {
    return false;
  }

  if (WATERMARK_LINE_PATTERNS.some((re) => re.test(trimmed))) return true;
  if (STANDALONE_BOOK_BRAND_RE.test(trimmed)) return true;

  // Never drop an entire numbered question line or option line (only strip inline ad/citation tail instead)
  if (
    /^(?:0?[1-9]|[1-9]\d{1,2}|[০-৯]{1,3})[.\u0964]\s+/.test(trimmed) ||
    /^(?:[a-h]\)|[ক-ঙ]\)|\([ক-ঙ]\)|[ক-ঙ]\.)\s+/.test(trimmed)
  ) {
    return false;
  }

  return PROMOTIONAL_LINE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Deterministically strips publisher book advertisements, library-availability promo banners,
 * publisher guide-book page cross-references (e.g. `[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫০`,
 * `পৃষ্ঠা: ৬৬২ এর ৯৪৬ নম্বর (অগ্রদূত Basic Math, 2nd Edition, January-2024)`), and repeated
 * book-title running headers/footers (e.g. "অগ্রদূত Recent Job Solution", "অগ্রদূত রিসেন্ট লিখিত জব সলিউশন")
 * both as standalone lines and when accidentally merged inline into another line.
 */
export function stripPromotionalBookAds(text: string): {
  cleaned: string;
  removedCount: number;
  removedLines: string[];
} {
  if (!text) {
    return { cleaned: '', removedCount: 0, removedLines: [] };
  }

  const removedLines: string[] = [];
  const keptLines: string[] = [];

  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      keptLines.push('');
      continue;
    }

    // Never strip genuine AI-generated answer badges, verified AI references, or red-lined highlights
    if (PROTECTED_SYSTEM_ANNOTATION_LINE_RE.test(trimmed)) {
      keptLines.push(rawLine);
      continue;
    }

    if (isPromotionalBookAdLine(trimmed)) {
      removedLines.push(trimmed);
      continue;
    }

    // Check for inline promotional sentences or publisher page cross-references merged onto an exam/answer line
    let nextLine = rawLine;
    let lineMutated = false;
    for (const pattern of PROMOTIONAL_SENTENCE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(nextLine)) {
        pattern.lastIndex = 0;
        const matches = nextLine.match(pattern) ?? [];
        for (const m of matches) {
          const cleanMatch = m.trim();
          if (cleanMatch) removedLines.push(cleanMatch);
        }
        nextLine = nextLine.replace(pattern, ' ');
        lineMutated = true;
      }
    }

    if (lineMutated) {
      const cleanedInline = nextLine.replace(/[ \t]{2,}/g, ' ').trim();
      // If removing a publisher cross-reference leaves only a bare dangling `উত্তর:` / `Solution:` label, drop it!
      if (
        cleanedInline &&
        !DANGLING_EMPTY_ANSWER_LABEL_RE.test(cleanedInline) &&
        !isPromotionalBookAdLine(cleanedInline)
      ) {
        keptLines.push(cleanedInline);
      }
    } else {
      keptLines.push(rawLine);
    }
  }

  return {
    cleaned: keptLines.join('\n').replace(/\n{3,}/g, '\n\n'),
    removedCount: removedLines.length,
    removedLines,
  };
}

function computeMedian(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizeItemSize(item: PdfPositionedTextItem): number {
  const f = typeof item.fontSize === 'number' && item.fontSize > 0 ? item.fontSize : 0;
  const h = typeof item.height === 'number' && item.height > 0 ? item.height : 0;
  return f || h || 11;
}

function joinLineItems(sortedItems: PdfPositionedTextItem[]): string {
  if (sortedItems.length === 0) return '';

  let result = '';
  let prev: PdfPositionedTextItem | null = null;

  for (const item of sortedItems) {
    const piece = item.str;
    if (!piece) continue;

    if (!prev) {
      result = piece;
      prev = item;
      continue;
    }

    const prevEndsWs = /\s$/.test(result);
    const nextStartsWs = /^\s/.test(piece);
    const trimmedNext = piece.trimStart();

    if (!trimmedNext) {
      if (!prevEndsWs) result += ' ';
      prev = item;
      continue;
    }

    if (prevEndsWs || nextStartsWs) {
      result += piece;
    } else if (
      BENGALI_COMBINING_START_RE.test(trimmedNext) ||
      NO_SPACE_BEFORE_RE.test(trimmedNext) ||
      NO_SPACE_AFTER_RE.test(result)
    ) {
      result += trimmedNext;
    } else {
      const prevWidth = typeof prev.width === 'number' && prev.width > 0 ? prev.width : 0;
      const fontSize = Math.max(normalizeItemSize(prev), normalizeItemSize(item));
      if (prevWidth > 0) {
        const gap = item.x - (prev.x + prevWidth);
        if (gap > Math.max(1.2, fontSize * 0.14)) {
          result += ' ' + trimmedNext;
        } else {
          result += trimmedNext;
        }
      } else {
        // Fallback when PDF generator omitted glyph widths: separate distinct runs with a space
        result += ' ' + trimmedNext;
      }
    }

    prev = item;
  }

  return result.replace(/[ \t]{2,}/g, ' ').trim();
}

function buildPositionedLines(items: PdfPositionedTextItem[]): PositionedLine[] {
  const usable = items.filter((it) => typeof it.str === 'string' && it.str.trim().length > 0);
  if (usable.length === 0) return [];

  // PDF coordinate Y increases bottom-to-top, so descending Y = top-to-bottom reading order
  const sortedByY = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const clusters: Array<{
    anchorY: number;
    avgHeight: number;
    items: PdfPositionedTextItem[];
  }> = [];

  for (const item of sortedByY) {
    const h = normalizeItemSize(item);
    let matchedCluster: (typeof clusters)[number] | null = null;
    let bestDy = Infinity;

    // Check recent clusters (within a small lookback window) for the closest baseline match
    for (let i = clusters.length - 1; i >= Math.max(0, clusters.length - 8); i -= 1) {
      const c = clusters[i];
      const tol = Math.max(3.5, Math.max(c.avgHeight, h) * 0.48);
      const dy = Math.abs(c.anchorY - item.y);
      if (dy <= tol && dy < bestDy) {
        bestDy = dy;
        matchedCluster = c;
      }
    }

    if (matchedCluster) {
      const n = matchedCluster.items.length;
      matchedCluster.items.push(item);
      matchedCluster.anchorY = (matchedCluster.anchorY * n + item.y) / (n + 1);
      matchedCluster.avgHeight = (matchedCluster.avgHeight * n + h) / (n + 1);
    } else {
      clusters.push({
        anchorY: item.y,
        avgHeight: h,
        items: [item],
      });
    }
  }

  clusters.sort((a, b) => b.anchorY - a.anchorY);

  const lines: PositionedLine[] = [];
  for (const cluster of clusters) {
    cluster.items.sort((a, b) => a.x - b.x);
    const text = joinLineItems(cluster.items);
    if (!text) continue;
    const minX = cluster.items[0].x;
    const last = cluster.items[cluster.items.length - 1];
    const maxX = last.x + Math.max(0, last.width ?? 0);
    lines.push({
      anchorY: cluster.anchorY,
      avgHeight: cluster.avgHeight,
      minX,
      maxX,
      text,
    });
  }

  return lines;
}

function serializeLinesWithParagraphGaps(lines: PositionedLine[]): string {
  if (lines.length === 0) return '';

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const dy = lines[i - 1].anchorY - lines[i].anchorY;
    if (dy > 2) gaps.push(dy);
  }
  const typicalLineStep = computeMedian(gaps, 14);
  const paraThreshold = Math.max(typicalLineStep * 1.65, 22);

  const out: string[] = [lines[0].text];
  for (let i = 1; i < lines.length; i += 1) {
    const dy = lines[i - 1].anchorY - lines[i].anchorY;
    if (dy >= paraThreshold) {
      out.push('');
    }
    out.push(lines[i].text);
  }

  return out.join('\n');
}

function countDistinctRows(items: PdfPositionedTextItem[], tol: number): number {
  if (items.length === 0) return 0;
  const ys = items.map((i) => i.y).sort((a, b) => b - a);
  let rows = 1;
  let lastY = ys[0];
  for (let i = 1; i < ys.length; i += 1) {
    if (Math.abs(lastY - ys[i]) > tol) {
      rows += 1;
      lastY = ys[i];
    }
  }
  return rows;
}

/**
 * Reconstructs clean, properly ordered horizontal text lines from positioned PDF text items
 * (from `unpdf`'s `extractTextItems`).
 * - Groups words sharing the same visual baseline (Y coordinate) onto the SAME horizontal line
 *   so Acrobat-OCR'd PDFs never break into 1 word per line.
 * - Automatically detects 2-column Bangladeshi Job Solution layouts and reads:
 *   Top Full-Width Banner -> Complete Left Column (top-to-bottom) -> Complete Right Column -> Footer.
 */
export function reconstructPdfPageTextFromTextItems(
  items: PdfPositionedTextItem[]
): string {
  const usable = items.filter((it) => typeof it.str === 'string' && it.str.trim().length > 0);
  if (usable.length === 0) return '';

  const fontSizes = usable.map(normalizeItemSize);
  const medianFont = computeMedian(fontSizes, 11);
  const rowTol = Math.max(4, medianFont * 0.55);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const it of usable) {
    if (it.x < minX) minX = it.x;
    const right = it.x + Math.max(0, it.width ?? 0);
    if (right > maxX) maxX = right;
    if (it.y < minY) minY = it.y;
    if (it.y > maxY) maxY = it.y;
  }

  const pageSpan = maxX - minX;
  const pageHeight = Math.max(1, maxY - minY);

  // Attempt 2-column gutter detection when page is wide enough and dense enough
  if (pageSpan >= 240 && usable.length >= 16) {
    const pad = Math.max(3, medianFont * 0.3);
    const center = minX + pageSpan * 0.5;
    let bestGutter: number | null = null;
    let bestScore = Infinity;

    for (let ratio = 0.42; ratio <= 0.581; ratio += 0.02) {
      const gutter = minX + pageSpan * ratio;
      const left: PdfPositionedTextItem[] = [];
      const right: PdfPositionedTextItem[] = [];
      const spanning: PdfPositionedTextItem[] = [];

      for (const it of usable) {
        const w = Math.max(0, it.width ?? 0);
        const rightEdge = it.x + w;
        if (w > 0 && it.x < gutter - pad && rightEdge > gutter + pad) {
          spanning.push(it);
        } else if (rightEdge <= gutter + pad) {
          left.push(it);
        } else {
          right.push(it);
        }
      }

      const leftRows = countDistinctRows(left, rowTol);
      const rightRows = countDistinctRows(right, rowTol);
      if (leftRows < 5 || rightRows < 5) continue;

      const spanningRows = countDistinctRows(spanning, rowTol);
      const maxAllowedSpanning = Math.max(4, Math.floor((leftRows + rightRows) * 0.14));
      if (spanningRows > maxAllowedSpanning) continue;

      // Ensure both columns genuinely overlap vertically (not stacked top/bottom blocks)
      const leftMinY = Math.min(...left.map((i) => i.y));
      const leftMaxY = Math.max(...left.map((i) => i.y));
      const rightMinY = Math.min(...right.map((i) => i.y));
      const rightMaxY = Math.max(...right.map((i) => i.y));
      const overlap = Math.min(leftMaxY, rightMaxY) - Math.max(leftMinY, rightMinY);
      const shorterColHeight = Math.max(1, Math.min(leftMaxY - leftMinY, rightMaxY - rightMinY));
      if (overlap / shorterColHeight < 0.35) continue;

      // Prefer minimal spanning rows and closeness to page horizontal center
      const centerPenalty = Math.abs(gutter - center) / pageSpan;
      const score = spanningRows * 10 + centerPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestGutter = gutter;
      }
    }

    if (bestGutter !== null) {
      const topThresholdY = maxY - pageHeight * 0.22;
      const bottomThresholdY = minY + pageHeight * 0.08;

      const topBannerItems: PdfPositionedTextItem[] = [];
      const leftColItems: PdfPositionedTextItem[] = [];
      const rightColItems: PdfPositionedTextItem[] = [];
      const footerItems: PdfPositionedTextItem[] = [];

      for (const it of usable) {
        const w = Math.max(0, it.width ?? 0);
        const rightEdge = it.x + w;
        const crossesGutter = w > 0 && it.x < bestGutter - pad && rightEdge > bestGutter + pad;

        if (crossesGutter) {
          if (it.y >= topThresholdY) {
            topBannerItems.push(it);
          } else if (it.y <= bottomThresholdY) {
            footerItems.push(it);
          } else if (it.x < bestGutter) {
            leftColItems.push(it);
          } else {
            rightColItems.push(it);
          }
        } else if (rightEdge <= bestGutter + pad) {
          leftColItems.push(it);
        } else {
          rightColItems.push(it);
        }
      }

      // If a top banner exists, any non-spanning items sitting strictly ABOVE the columns
      // (higher Y than the lowest topBanner item) also belong to the top banner.
      if (topBannerItems.length > 0) {
        const bannerBottomY = Math.min(...topBannerItems.map((i) => i.y)) - rowTol;
        const hoistToBanner = (col: PdfPositionedTextItem[]) => {
          const remaining: PdfPositionedTextItem[] = [];
          for (const it of col) {
            if (it.y >= bannerBottomY) {
              topBannerItems.push(it);
            } else {
              remaining.push(it);
            }
          }
          return remaining;
        };
        const nextLeft = hoistToBanner(leftColItems);
        const nextRight = hoistToBanner(rightColItems);
        leftColItems.length = 0;
        leftColItems.push(...nextLeft);
        rightColItems.length = 0;
        rightColItems.push(...nextRight);
      }

      const sections = [
        serializeLinesWithParagraphGaps(buildPositionedLines(topBannerItems)),
        serializeLinesWithParagraphGaps(buildPositionedLines(leftColItems)),
        serializeLinesWithParagraphGaps(buildPositionedLines(rightColItems)),
        serializeLinesWithParagraphGaps(buildPositionedLines(footerItems)),
      ].filter(Boolean);

      return sections.join('\n\n').trim();
    }
  }

  return serializeLinesWithParagraphGaps(buildPositionedLines(usable)).trim();
}

/**
 * Detects Acrobat-OCR / broken PDF text where nearly every single word was placed on
 * its own separate line (e.g. "মৎস্য\nঅধিদপ্তর\nপদের\nনামঃ\nহ্যাচারি\nএটেন্ডেন্ট").
 */
export function isVerticallyFragmentedText(text: string): boolean {
  if (!text) return false;
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 6) return false;

  let singleWordLines = 0;
  let shortLines = 0;
  let totalChars = 0;

  for (const line of lines) {
    const tokens = line.split(/\s+/).filter(Boolean);
    totalChars += line.length;
    if (tokens.length === 1) {
      singleWordLines += 1;
    }
    if (tokens.length <= 2 && line.length <= 22) {
      shortLines += 1;
    }
  }

  const avgChars = totalChars / lines.length;
  const singleWordRatio = singleWordLines / lines.length;
  const shortLineRatio = shortLines / lines.length;

  return (
    (singleWordRatio >= 0.52 && avgChars < 19) ||
    (shortLineRatio >= 0.75 && avgChars < 16)
  );
}

/**
 * Normalizes Bengali visarga (`ঃ`) mistakenly used as a colon (`:`) on common exam labels
 * without touching authentic Bengali visarga words like `দুঃখ`, `অন্তঃপুর`, or `নিঃশেষ`.
 */
function normalizeBengaliLabelColons(text: string): string {
  let out = text;
  for (const label of BENGALI_LABEL_VISARGA_WORDS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(${escaped})\\s*ঃ`, 'g'), '$1:');
  }
  return out;
}

function stripInlineWatermarks(text: string): string {
  const withoutPrebd = text.replace(/\b(?:https?:\/\/)?(?:www\.)?prebd\.com\b/gi, '');
  return stripPromotionalBookAds(withoutPrebd).cleaned;
}

const QUESTION_NUM_ATOM =
  '(?:0[1-9]|[1-9]\\d?|1\\d{2}|2[0-4]\\d|250|[০-৯]{1,2}|[১২][০-৯]{2})';

// Matches `01. Text`, `১. ২০২৫ সালে...`, `৫. 'ট্রায়োন্ডা'-কী?`, `১০.মার্কিন...`, `১। সন্ধি...`
// without ever false-matching decimal numbers like `৩.৫` or dates like `০৯.০১.২০২৬`.
const START_QUESTION_LINE_RE = new RegExp(
  `^(${QUESTION_NUM_ATOM}[.\\u0964])(?:\\s*(?=['‘’"“”(\\u0980-\\u09FFA-Za-z])|\\s+(?=[0-9০-৯]))`
);

const EXAM_DIRECTIVE_LOOKAHEAD =
  '(?:Fill\\s+in\\s+the|Translate\\s+into|Make\\s+sentence|Correct\\s+the|Change\\s+the|Use\\s+(?:the\\s+)?right\\s+form|Write\\s+(?:a|an|the|down|short)|Answer\\s+the|Identify\\s+the|Transform\\s+the|Choose\\s+the|সন্ধি\\s+বিচ্ছেদ|এক\\s+কথায়\\s+প্রকাশ|এক\\s+কথায়\\s+প্রকাশ|বিপরীত\\s+শব্দ|বাগধারা|সমার্থক\\s+শব্দ|কারক\\s+ও\\s+বিভক্তি|সমাস\\s+নির্ণয়|সমাস\\s+নির্ণয়|শুদ্ধ\\s+বানান|বাক্য\\s+সংকোচন|অনুবাদ\\s+করুন|পূর্ণরূপ\\s+লিখুন|টীকা\\s+লিখুন)';

const BENGALI_OPTION_MARKERS = ['ক)', 'খ)', 'গ)', 'ঘ)', 'ঙ)', 'চ)', 'ছ)', 'জ)'];
const LATIN_OPTION_MARKERS = ['a)', 'b)', 'c)', 'd)', 'e)', 'f)', 'g)', 'h)'];

function toAsciiDigitsLocal(input: string): string {
  return input.replace(/[০-৯]/g, (ch) => String('০১২৩৪৫৬৭৮৯'.indexOf(ch)));
}

function toBengaliDigitsLocal(num: number): string {
  return String(num).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)] ?? d);
}

/**
 * Formats flattened 2-column antonym / synonym word-pair tables emitted by OCR on a single line, e.g.:
 * `৩। বিপরীত শব্দ লিখুন: প্রদত্ত শব্দ বিপরীতশব্দ সাকার নিরাকার উৎকর্ষ অপকর্ষ ...`
 */
function expandInlineWordPairTables(text: string, preferBengaliMarkers: boolean): string {
  return text
    .split('\n')
    .map((line) => {
      const tableMatch = line.match(
        /^(.*?(?:বিপরীত\s+শব্দ|সমার্থক\s+শব্দ)[^:\n]*:)?\s*(?:প্রদত্ত\s+শব্দ|মূল\s+শব্দ|শব্দ)\s+(?:বিপরীত\s*শব্দ|সমার্থক\s*শব্দ)\s+(.+)$/
      );
      if (!tableMatch) return line;

      const prefix = (tableMatch[1] ?? '').trim();
      const rest = tableMatch[2].trim();
      // Only expand when pairs are clean single-word tokens without existing `=` or option markers
      if (/[=:\)\(]/.test(rest)) return line;

      const tokens = rest.split(/\s+/).filter(Boolean);
      if (tokens.length < 4 || tokens.length > 24 || tokens.length % 2 !== 0) {
        return line;
      }

      const markers = preferBengaliMarkers ? BENGALI_OPTION_MARKERS : LATIN_OPTION_MARKERS;
      const pairs: string[] = [];
      for (let i = 0; i < tokens.length; i += 2) {
        const pairIdx = i / 2;
        const marker = pairIdx < markers.length ? markers[pairIdx] : '•';
        pairs.push(`    ${marker} ${tokens[i]} = ${tokens[i + 1]}`);
      }

      return prefix ? `${prefix}\n${pairs.join('\n')}` : pairs.join('\n');
    })
    .join('\n');
}

/**
 * Checks whether a text block represents a structured exam / Job Solution sheet
 * (numbered questions with `.` or Bengali `।`, sub-options `a)`–`h)` / `ক)`–`ঙ)`, `Solution:`, or exam metadata header).
 */
export function hasExamDocumentStructure(text: string): boolean {
  if (!text) return false;

  const numberedQuestionHits =
    text.match(
      new RegExp(
        `(?:^|[\\s।?!;])${QUESTION_NUM_ATOM}[.\\u0964]\\s*['‘’"“”\\u0980-\\u09FFA-Za-z0-9০-৯]`,
        'g'
      )
    ) ?? [];
  const latinOptionHits = text.match(/(?:^|\s)[a-f]\)\s*[^\s]/g) ?? [];
  const bengaliOptionHits =
    text.match(/(?:^|\s)(?:[ক-ঙ]\)|\([ক-ঙ]\)|[ক-ঙ]\.\s+)[^\s]/g) ?? [];
  const hasSolutionLabel =
    /(?:^|\s)(?:Solution\s*:|উত্তর\s*[:ঃ.]|সমাধান\s*[:ঃ]|Answer\s*:|উ\.\s*[ক-ঙ]|উ[:ঃ]\s*[ক-ঙ])/i.test(
      text
    );
  const hasExamHeader =
    /(?:পদের\s+নাম\s*[:ঃ]|পরীক্ষার\s+তারিখ\s*[:ঃ]|তারিখ\s*[:ঃ][\s\S]{0,40}সময়\s*[:ঃ]|পূর্ণমান\s*[:ঃ]|প্রশ্ন\s+সমাধান)/.test(
      text
    );

  return (
    numberedQuestionHits.length >= 2 ||
    latinOptionHits.length >= 2 ||
    bengaliOptionHits.length >= 2 ||
    (numberedQuestionHits.length >= 1 && (hasSolutionLabel || hasExamHeader)) ||
    hasExamHeader
  );
}

/**
 * Reflows vertically fragmented lines into clean sentences and applies Bangladeshi
 * Job Solution exam formatting:
 * - Clean exam header lines (`মৎস্য অধিদপ্তর` / `পদের নাম: ...` / `তারিখ: ...; সময়: ...; পূর্ণমান: ...`)
 * - Numbered questions (`01.`, `02.`, ... OR Bengali `১।`, `২।`, `৩।`, ...) cleanly separated
 * - Repairs OCR-dropped delimiters before exam directives (`৪ Fill in the gap...` -> `৪। Fill in the gap...`,
 *   `| Translate into English:` -> next sequential number `৫। Translate into English:`)
 * - Sub-items (`a)`–`h)`, `ক)`–`ঙ)`) each on its own cleanly indented line (`    a) ...`),
 *   handling dotted fill-in-the-blank stems (`a)....... rich`) and zero-space OCR (`d)একচ্ছত্র`)
 *   while preserving parenthesized English articles like `(a)`, `(an)`, `(the)` inline!
 * - Flattened antonym/synonym word-pair tables (`প্রদত্ত শব্দ বিপরীতশব্দ সাকার নিরাকার ...`)
 * - `Solution:` / `উত্তর:` / `সমাধান:` cleanly on their own line
 * - Math step arrows (`⇒`, `∴`, `অতএব,`) cleanly structured
 * - Ordinary non-exam textbook prose is preserved completely intact!
 */
export function normalizeExamDocumentFormatting(rawText: string): string {
  const base = (rawText ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (!base) return '';

  const fragmented = isVerticallyFragmentedText(base);

  // Step 1: If text is vertically fragmented (1 word per line), rejoin into flowing prose first
  let working = base;
  if (fragmented) {
    working = base
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/[ \t]{2,}/g, ' ')
      // Clean spaces mistakenly introduced before punctuation when words were on separate lines
      .replace(/\s+([।,;?!\)\]])/g, '$1')
      .replace(/([\(\[])\s+/g, '$1')
      // Reattach split question-number dots/daris (e.g. "01 ." -> "01.", "১ ।" -> "১।")
      .replace(/\b([0-9০-৯]{1,3})\s+([.।])(?=\s)/g, '$1$2')
      // Clean stray space before colon (e.g. "করুন :" -> "করুন:")
      .replace(/\s+:/g, ':');
  }

  // Protect embedded base64 figure images BEFORE watermark/math cleaners so `==` or `+` in base64 is NEVER altered!
  const protectedDataImageLines: string[] = [];
  working = working
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (/^!\[[^\]]*\]\(data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+\)$/i.test(t)) {
        const token = `@@DATAIMAGELINE${protectedDataImageLines.length}@@`;
        protectedDataImageLines.push(t);
        return token;
      }
      return line;
    })
    .join('\n');

  const restoreProtectedDataImages = (input: string): string => {
    if (protectedDataImageLines.length === 0) return input;
    return input.replace(/@@DATAIMAGELINE(\d+)@@/g, (_m, idxStr: string) => {
      const idx = Number.parseInt(idxStr, 10);
      return protectedDataImageLines[idx] ?? '';
    });
  };

  // Strip known footer/watermark lines
  working = stripInlineWatermarks(working);

  // Repair flattened single-line tables & blank-line-separated Markdown table rows
  working = normalizeBrokenMarkdownTables(working);

  // Normalize Bengali label visargas (`পদের নামঃ` -> `পদের নাম:`, etc.)
  working = normalizeBengaliLabelColons(working);

  // Clean deterministic OCR math symbols (`... গ.সা.গু` -> `∴ গ.সা.গু`, `==` -> `=`)
  working = cleanDeterministicMathSymbols(working);

  // Check if this page/chunk has exam sheet structure
  const isExam = hasExamDocumentStructure(working);

  if (!isExam) {
    // Ordinary prose: if it was vertically fragmented, return cleanly reflowed prose;
    // otherwise preserve the author's original paragraph breaks untouched.
    return restoreProtectedDataImages(
      working
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }

  // Detect whether this exam paper primarily uses Bengali question numerals (১।, ২।, ৩।) or ASCII (01., 02.)
  const bengaliQCount = (
    working.match(
      /(?:^|\s)[০-৯]{1,2}[.।](?:\s*['‘’"“”(\u0980-\u09FFA-Za-z]|\s+[0-9০-৯])/g
    ) ?? []
  ).length;
  const asciiQCount = (
    working.match(
      /(?:^|\s)(?:0?[1-9]|[1-9]\d?)\.(?:\s+['‘’"“”(\u0980-\u09FFA-Za-z0-9০-৯])/g
    ) ?? []
  ).length;
  const preferBengaliNumbering = bengaliQCount >= asciiQCount && bengaliQCount > 0;

  // Step 2: Enforce clean structural line breaks for Exam / Job Solution documents
  // Protect Markdown table rows & embedded data-URI figure images with placeholders so inline splitters never corrupt them
  const protectedTableLines: string[] = [];
  const rawPreStep2Lines = working.split('\n');
  working = rawPreStep2Lines
    .map((line, idx) => {
      const t = line.trim();
      if (
        /^@@DATAIMAGELINE\d+@@$/.test(t) ||
        /^!\[[^\]]*\]\(data:image\/[^)\s]+\)$/i.test(t) ||
        /^\[চিত্র\s*[:ঃ][^\]]+\]$/i.test(t) ||
        /^<\/?center>$/i.test(t) ||
        /^<center>.*<\/center>$/i.test(t) ||
        isMarkdownTableLine(t) ||
        (t.includes('|') &&
          idx + 1 < rawPreStep2Lines.length &&
          isMarkdownTableSeparatorLine(rawPreStep2Lines[idx + 1]))
      ) {
        const token = `@@MDTABLELINE${protectedTableLines.length}@@`;
        protectedTableLines.push(t);
        return token;
      }
      return line;
    })
    .join('\n');

  // 2a. Header metadata breaks: keep Institution Name -> Post Name -> Date; Time; Marks
  working = working
    .replace(/([^\n])\s+(পদের\s+নাম\s*:)/g, '$1\n$2')
    .split('\n')
    .map((line) => {
      let out = line;
      // Break `সময়:` onto metadata line when attached to Institution/Post line (but NOT when already after `তারিখ:`)
      if (!/(?:পরীক্ষার\s+)?তারিখ\s*:/.test(out)) {
        out = out.replace(/([^\n])\s+((?:সময়|সময়)\s*:)/g, '$1\n$2');
      }
      // Break `তারিখ:` / `পরীক্ষার তারিখ:` onto metadata line unless the line already starts with `সময়:` or `পরীক্ষার তারিখ:` / `তারিখ:`
      if (!/^\s*(?:সময়|সময়|পরীক্ষার\s+তারিখ|তারিখ)\s*:/.test(out)) {
        out = out.replace(/([^\n])\s+((?:পরীক্ষার\s+)?তারিখ\s*:)/g, '$1\n$2');
      }
      return out;
    })
    .join('\n');

  // Ensure a single space after label colons (without breaking ratios like ৪:১ or 4:1)
  working = working.replace(
    /((?:পদের\s+নাম|পরীক্ষার\s+তারিখ|তারিখ|সময়|সময়|পূর্ণমান|বাক্যের\s+অর্থ|অর্থ|উত্তর|সমাধান|ব্যাখ্যা|Solution|Soluation|Explanation|Answer)\s*:)(?!\s|$)/gi,
    '$1 '
  );

  // 2a-ii. Repair OCR-dropped delimiter after a bare question number before a known exam directive
  // e.g. `পরকাল ৪ Fill in the gap using Article:` -> `পরকাল\n\n৪। Fill in the gap using Article:`
  working = working.replace(
    new RegExp(
      `([^\\n])\\s+([০-৯]{1,2}|[1-9]\\d?)\\s+(?=${EXAM_DIRECTIVE_LOOKAHEAD})`,
      'gi'
    ),
    (full, prevChar: string, numToken: string) => {
      if (/[=+×÷\-–—,(]/.test(prevChar)) return full;
      const isBengaliNum = /[০-৯]/.test(numToken);
      const delim = isBengaliNum ? '।' : '.';
      return `${prevChar}\n\n${numToken}${delim} `;
    }
  );

  // Repair start-of-line bare question number before a known exam directive
  working = working.replace(
    new RegExp(
      `(^|\\n)[ \\t]*([০-৯]{1,2}|[1-9]\\d?)\\s+(?=${EXAM_DIRECTIVE_LOOKAHEAD})`,
      'gim'
    ),
    (_full, prefix: string, numToken: string) => {
      const isBengaliNum = /[০-৯]/.test(numToken);
      const delim = isBengaliNum ? '।' : '.';
      return `${prefix}${numToken}${delim} `;
    }
  );

  // 2a-iii. Mark OCR pipe-corrupted question numbers before a known exam directive
  // e.g. `Answer: the | Translate into English:` -> sentinel `\n\n__OCR_MISSING_Q__ Translate into English:`
  working = working.replace(
    new RegExp(
      `([^\\n])\\s*\\|\\s*(?=${EXAM_DIRECTIVE_LOOKAHEAD})`,
      'gi'
    ),
    '$1\n\n__OCR_MISSING_Q__ '
  );

  // 2b. Numbered questions: BOTH ASCII/Bengali dots (`01.`, `12.`, `১.`) AND Bengali dari (`১।`, `২।`, `৩।`)!
  // Match after space/text when followed by Bengali/English letter, quote, or spaced digit (`১. ২০২৫ সালে...`).
  working = working.replace(
    new RegExp(
      `([^\\n])\\s+(${QUESTION_NUM_ATOM}(?:\\.\\s+|\\u0964\\s*)(?=['‘’"“”(\\u0980-\\u09FFA-Za-z0-9০-৯]))`,
      'g'
    ),
    (full, prevChar: string, qStart: string) => {
      if (/[=+×÷\-–—,(]/.test(prevChar)) {
        return full;
      }
      return `${prevChar}\n\n${qStart}`;
    }
  );

  // Also ensure numbered questions already on a new line have clean blank-line separation
  working = working.replace(
    new RegExp(
      `([^\\n])\\n(${QUESTION_NUM_ATOM}(?:\\.\\s*['‘’"“”(\\u0980-\\u09FFA-Za-z]|\\.\\s+[0-9০-৯]|\\u0964\\s*['‘’"“”(\\u0980-\\u09FFA-Za-z0-9০-৯]))`,
      'g'
    ),
    '$1\n\n$2'
  );

  // 2b-ii. Resolve any `__OCR_MISSING_Q__` markers using exact sequential question number inference
  if (working.includes('__OCR_MISSING_Q__')) {
    let lastSeenQNum = 0;
    let useBengali = preferBengaliNumbering;
    let padTwoDigits = false;

    working = working
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        const qMatch = trimmed.match(START_QUESTION_LINE_RE);
        if (qMatch) {
          const rawPrefix = qMatch[1];
          const parsed = Number.parseInt(toAsciiDigitsLocal(rawPrefix.slice(0, -1)), 10);
          if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 250) {
            lastSeenQNum = parsed;
            useBengali = /[০-৯]/.test(rawPrefix);
            padTwoDigits = !useBengali && rawPrefix.startsWith('0');
          }
          return line;
        }

        if (trimmed.startsWith('__OCR_MISSING_Q__')) {
          const body = trimmed.replace(/^__OCR_MISSING_Q__\s*/, '');
          const nextNum = lastSeenQNum + 1;
          lastSeenQNum = nextNum;
          const label = useBengali
            ? `${toBengaliDigitsLocal(nextNum)}।`
            : `${padTwoDigits && nextNum < 10 ? `0${nextNum}` : String(nextNum)}.`;
          return `${label} ${body}`;
        }

        return line;
      })
      .join('\n');
  }

  // 2b-iii. Expand flattened inline antonym/synonym word-pair tables (e.g., `প্রদত্ত শব্দ বিপরীতশব্দ সাকার নিরাকার ...`)
  working = expandInlineWordPairTables(working, preferBengaliNumbering);

  // 2c. Detach `Solution:` / `Soluation:` / `Explanation:` / `উত্তর:` / `সমাধান:` / `ব্যাখ্যা:` / `Ans.` / `Answer:` / `উ. খ`
  // onto their own lines FIRST so subsequent inline sub-option splitting never breaks `উত্তর: ক. ২ জন` or `ব্যাখ্যা: ...`!
  working = working.replace(
    /([^\n])\s+((?:Solution|Soluation|Explanation|উত্তর|সমাধান|ব্যাখ্যা)\s*:)/gi,
    '$1\n$2'
  );

  // Detach inline Bangladeshi MCQ shorthand answer keys (`উ. খ`, `উ. গ`, `উঃ ক`, `উত্তর. ঘ`, `উত্তর: গ`)
  // even when followed by `Solution:`, `Explanation:`, `ব্যাখ্যা:`, `পৃষ্ঠা:`, newline, or end of string
  working = working.replace(
    /([^\n])\s+(?:উ\.|উ[:ঃ]|উত্তর\s*[.:ঃ])\s*([ক-ঙ])(?=\s*(?:\n|$|পৃষ্ঠা\s*[:ঃ.\-]|(?:Solution|Soluation|Explanation|ব্যাখ্যা)\s*:))/gi,
    '$1\nউত্তর: $2'
  );
  working = working.replace(
    /(^|\n)[ \t]*(?:উ\.|উ[:ঃ]|উত্তর\s*[.:ঃ])\s*([ক-ঙ])(?=\s*(?:\n|$))/g,
    '$1উত্তর: $2'
  );

  // 2d. Sub-options: `a)`–`h)` (NEVER matching `(a)` articles!), Bengali `ক)`–`ঙ)`, `(ক)`–`(ঙ)`, AND dotted `ক.`–`ঙ.`!
  // Handles standard spaced (`d) একচ্ছত্র`), zero-space (`d)একচ্ছত্র`), dotted fill-in-the-blank (`a)....... rich`),
  // and Bangladeshi MCQ options (`ক. verb  খ. adverb  গ. adjective  ঘ. preposition`) without breaking `গ.সা.গু`,
  // while strictly preserving `উত্তর: ক. ২ জন`, `Answer: a) Dhaka`, and `ব্যাখ্যা:` lines intact!
  const ANSWER_OR_EXPLANATION_LINE_RE =
    /^[ \t]*(?:উত্তর|Answer|Ans|ব্যাখ্যা|Explanation)\s*[:ঃ.]/i;

  working = working
    .split('\n')
    .map((line) => {
      if (ANSWER_OR_EXPLANATION_LINE_RE.test(line)) {
        return line;
      }
      let nextLine = line.replace(
        /([^\n(])\s+([a-h]\))\s*(?=[\u0980-\u09FFA-Za-z0-9০-৯'‘’"“”_.\u2014\u2013-])/g,
        '$1\n    $2 '
      );
      nextLine = nextLine.replace(
        /([^\n(])\s+((?:[ক-ঙ]\)|\([ক-ঙ]\)))\s*(?=[\u0980-\u09FFA-Za-z0-9০-৯'‘’"“”_.\u2014\u2013-])/g,
        '$1\n    $2 '
      );
      nextLine = nextLine.replace(
        /([^\n(])\s+([ক-ঙ]\.)\s+(?=[\u0980-\u09FFA-Za-z0-9০-৯'‘’"“”_.\u2014\u2013-])/g,
        '$1\n    $2 '
      );
      nextLine = nextLine.replace(
        /(^|\n)[ \t]*([a-h]\)|[ক-ঙ]\)|\([ক-ঙ]\))(?=[\u0980-\u09FFA-Za-z0-9০-৯'‘’"“”_.\u2014\u2013-])/g,
        '$1    $2 '
      );
      return nextLine;
    })
    .join('\n');

  // Detach inline book reference lines like `পৃষ্ঠা: ৮৪ (অগ্রদূত বাংলা; ১৩তম সংস্করণ)` onto their own line
  working = working.replace(
    /([^\n])\s+(পৃষ্ঠা\s*[:ঃ.\-]?\s*[০-৯0-9]+\s*\([^)\n]+\))/g,
    '$1\n$2'
  );

  // Detach inline trailing MCQ answer keys stuck onto any option
  // (e.g., `d) ওষ্ঠ ans. A`, `d) ওষ্ঠans. A`, `d) ওরিয়েন্টাল অঞ্চল ans. C`, `d) সফট লোন ans. B Solution: ...`)
  working = working.replace(
    /([^\n])\s*(?:ans\.|ans:)\s*([A-Ha-h]|[ক-ঙ])(?=\s*(?:\n|$|(?:Solution|Soluation|Explanation|ব্যাখ্যা)\s*:))/gi,
    (_full, prevChar: string, ansVal: string) =>
      `${prevChar}\nAnswer: ${/[a-h]/.test(ansVal) ? ansVal.toUpperCase() : ansVal}`
  );
  // Also detach `Answer: A` / `Answer: ক` when NOT a fill-in-the-blank article stem (`___` / `...`)
  working = working
    .split('\n')
    .map((line) => {
      if (/(?:___|(?:\.{3,}))/.test(line)) return line;
      return line.replace(
        /([^\n])\s+Answer\s*[:.]\s*([A-H]|[ক-ঙ])(?=\s*$)/,
        '$1\nAnswer: $2'
      );
    })
    .join('\n');

  // Also normalize standalone start-of-line `ans. A` / `Ans. ক` into `Answer: A` (uppercasing single a-h keys)
  working = working.replace(
    /(^|\n)[ \t]*(?:ans\.|ans:|answer\.)\s*([^\n]+)/gi,
    (_full, prefix: string, val: string) => {
      const trimmedVal = val.trim();
      const norm = /^[a-h]$/.test(trimmedVal) ? trimmedVal.toUpperCase() : trimmedVal;
      return `${prefix}Answer: ${norm}`;
    }
  );

  // Normalize explicit `Explanation:` / `Soluation:` labels into `ব্যাখ্যা:`
  working = working.replace(
    /(^|\n)[ \t]*(?:Explanation|Soluation)\s*[:.]\s*/gi,
    '$1ব্যাখ্যা: '
  );

  // 2e. Math solution step markers (`⇒`, `∴`, `প্রশ্নমতে,`, `প্রশ্নানুযায়ী,`, `অতএব,`)
  working = working.replace(
    /([^\n])\s+(⇒|∴|প্রশ্নমতে,|প্রশ্নানুযায়ী,|অতএব\s*,|অতএব\s+অবশিষ্ট|অতএব\s+পুকুর)/g,
    '$1\n$2'
  );

  // Restore protected Markdown table rows intact before Step 3 & Step 4
  if (protectedTableLines.length > 0) {
    working = working.replace(/@@MDTABLELINE(\d+)@@/g, (_m, idxStr: string) => {
      const idx = Number.parseInt(idxStr, 10);
      return protectedTableLines[idx] ?? '';
    });
  }

  // Step 3: Per-line cleanup & uniform 4-space indentation for sub-options
  const cleanedLines = working.split('\n').map((rawLine) => {
    const trimmed = rawLine.trim().replace(/[ \t]{2,}/g, ' ');
    if (!trimmed) return '';
    if (isMarkdownTableLine(trimmed)) return trimmed;

    // Normalize indentation for sub-options (`a)`–`h)`, `ক)`–`ঙ)`, `(ক)`–`(ঙ)`, `ক.`–`ঙ.`, `•`)
    if (/^(?:[a-h]\)|[ক-ঙ]\)|\([ক-ঙ]\)|[ক-ঙ]\.|•)\s+/.test(trimmed)) {
      return `    ${trimmed}`;
    }

    // Normalize space after numbered question prefix (e.g. "01.\tসন্ধি" -> "01. সন্ধি", "১।সন্ধি" -> "১। সন্ধি")
    if (START_QUESTION_LINE_RE.test(trimmed)) {
      return trimmed.replace(
        new RegExp(`^(${QUESTION_NUM_ATOM}[.\\u0964])\\s*`),
        '$1 '
      );
    }

    return trimmed;
  });

  // Step 4: Merge soft-wrapped continuation lines inside numbered question stems & sub-options
  // (e.g., 2-column narrow wrap: "12. কাজল ১ লিটার দুধ কিনে তা থেকে ২৫০ মি. লি. পান\nকরল। কাজলের কাছে কতটুকু দুধ অবশিষ্ট থাকল।")
  const isStructuralStart = (line: string): boolean => {
    const t = line.trim();
    if (!t) return true;
    return (
      START_QUESTION_LINE_RE.test(t) ||
      /^(?:[a-h]\)|[ক-ঙ]\)|\([ক-ঙ]\)|[ক-ঙ]\.|•)\s+/.test(t) ||
      /^(?:Solution|Answer|Ans|উত্তর|সমাধান|ব্যাখ্যা)\s*[:.]/i.test(t) ||
      /^উ\.\s*[ক-ঙ]/.test(t) ||
      /^\[AI দ্বারা তৈরি উত্তর\]/i.test(t) ||
      /^\[হাইলাইট\s*[:ঃ]/i.test(t) ||
      /^\[চিত্র\s*[:ঃ]/i.test(t) ||
      /^@@DATAIMAGELINE\d+@@$/.test(t) ||
      /^!\[[^\]]*\]\(data:image\//i.test(t) ||
      /^<\/?center>/i.test(t) ||
      /^(?:রেফারেন্স|Reference|উৎস)\s*:/i.test(t) ||
      /^পৃষ্ঠা\s*[:ঃ]\s*[০-৯0-9]+\s*\([^)]+\)/.test(t) ||
      /^(?:পদের\s+নাম|পরীক্ষার\s+তারিখ|তারিখ|সময়|সময়|পূর্ণমান)\s*:/i.test(t) ||
      /^(?:⇒|∴|অতএব\b|প্রশ্নমতে\b|প্রশ্নানুযায়ী\b|=)/.test(t) ||
      /^\[[^\]]+পৃষ্ঠা/.test(t) ||
      isMarkdownTableLine(t)
    );
  };

  const mergedLines: string[] = [];
  let activeLineKind: 'none' | 'question' | 'option' | 'solution' | 'other' = 'none';

  for (const line of cleanedLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      mergedLines.push('');
      activeLineKind = 'none';
      continue;
    }

    // Deduplicate exact consecutive OCR-repeated bracketed page-reference footer lines
    if (
      /^\[[^\]]+পৃষ্ঠা/.test(trimmed) &&
      mergedLines.length > 0 &&
      mergedLines[mergedLines.length - 1].trim() === trimmed
    ) {
      continue;
    }

    if (START_QUESTION_LINE_RE.test(trimmed)) {
      mergedLines.push(trimmed);
      activeLineKind = 'question';
      continue;
    }

    if (/^(?:[a-h]\)|[ক-ঙ]\)|\([ক-ঙ]\)|[ক-ঙ]\.|•)\s+/.test(trimmed)) {
      mergedLines.push(`    ${trimmed}`);
      activeLineKind = 'option';
      continue;
    }

    if (/^(?:Solution|Answer|Ans|উত্তর|সমাধান|ব্যাখ্যা)\s*[:.]/i.test(trimmed)) {
      mergedLines.push(trimmed);
      activeLineKind = 'solution';
      continue;
    }

    if (
      /^\[AI দ্বারা তৈরি উত্তর\]/i.test(trimmed) ||
      /^\[হাইলাইট\s*[:ঃ]/i.test(trimmed) ||
      /^(?:রেফারেন্স|Reference)\s*:/i.test(trimmed) ||
      /^পৃষ্ঠা\s*[:ঃ]\s*[০-৯0-9]+\s*\([^)]+\)/.test(trimmed)
    ) {
      mergedLines.push(trimmed);
      activeLineKind = 'solution';
      continue;
    }

    if (
      isMarkdownTableLine(trimmed) ||
      /^\[চিত্র\s*[:ঃ]/i.test(trimmed) ||
      /^@@DATAIMAGELINE\d+@@$/.test(trimmed) ||
      /^!\[[^\]]*\]\(data:image\//i.test(trimmed) ||
      /^<\/?center>/i.test(trimmed)
    ) {
      mergedLines.push(trimmed);
      activeLineKind = 'other';
      continue;
    }

    if (
      (activeLineKind === 'question' || activeLineKind === 'option') &&
      !isStructuralStart(trimmed) &&
      mergedLines.length > 0 &&
      mergedLines[mergedLines.length - 1] !== ''
    ) {
      mergedLines[mergedLines.length - 1] = `${mergedLines[mergedLines.length - 1]} ${trimmed}`;
      continue;
    }

    mergedLines.push(trimmed);
    if (activeLineKind !== 'solution') {
      activeLineKind = 'other';
    }
  }

  // Step 4b: Per-question MCQ canonicalization pass:
  // 1. If a margin answer (`উত্তর: ক` / `Answer: B`) landed mid-options (e.g. next to `খ.` or `b)`),
  //    hoist it cleanly AFTER all MCQ options (`ক.`–`ঘ.` / `a)`–`d)`) and BEFORE `ব্যাখ্যা:`.
  // 2. For genuine MCQ questions (2–4 clean MCQ options), rename any `Solution:` / `সমাধান:` /
  //    `Explanation:` explanatory paragraph to `ব্যাখ্যা:` while keeping pure Written `Solution:` intact!
  const canonicalLines = canonicalizeMcqQuestionBlocks(mergedLines);

  // Collapse excessive blank lines while keeping clean 1-line gap between questions
  const finalLines: string[] = [];
  for (const line of canonicalLines) {
    if (line === '') {
      if (finalLines.length > 0 && finalLines[finalLines.length - 1] !== '') {
        finalLines.push('');
      }
    } else {
      finalLines.push(line);
    }
  }

  return restoreProtectedDataImages(finalLines.join('\n').trim());
}

const MCQ_OPTION_LINE_RE = /^(?:[a-d]\)|[ক-ঘ]\)|\([ক-ঘ]\)|[ক-ঘ]\.)\s+(.+)$/i;
const SINGLE_MCQ_ANSWER_LINE_RE =
  /^(Answer|Ans|উত্তর)\s*[:.]\s*([A-Da-d]|[ক-ঘ])(?:\s*[\.\)])?\s*$/i;
const EXPLANATION_OR_SOLUTION_LINE_RE =
  /^(ব্যাখ্যা|Explanation|Solution|Soluation|সমাধান)\s*[:ঃ.]\s*(.*)$/i;

function canonicalizeMcqQuestionBlocks(lines: string[]): string[] {
  const output: string[] = [];
  let block: string[] = [];

  const flushBlock = () => {
    if (block.length === 0) return;

    const firstNonEmpty = block.find((l) => l.trim().length > 0)?.trim() ?? '';
    if (!START_QUESTION_LINE_RE.test(firstNonEmpty)) {
      output.push(...block);
      block = [];
      return;
    }

    // Collect MCQ-shaped options inside this single question block
    const optionLines: string[] = [];
    let hasNonMcqSubItem = false;
    let hasWrittenDrillOption = false;

    for (const raw of block) {
      const t = raw.trim();
      if (/^(?:[e-h]\)|ঙ\)|\(ঙ\)|ঙ\.)\s+/.test(t)) {
        hasNonMcqSubItem = true;
      }
      const optMatch = t.match(MCQ_OPTION_LINE_RE);
      if (optMatch) {
        optionLines.push(raw);
        if (/\s*(?:=|→|=>)\s*/.test(optMatch[1]) || /(?:___|(?:\.{3,}))/.test(optMatch[1])) {
          hasWrittenDrillOption = true;
        }
      }
    }

    const isMcqBlock =
      !hasNonMcqSubItem &&
      !hasWrittenDrillOption &&
      optionLines.length >= 2 &&
      optionLines.length <= 4;

    if (!isMcqBlock) {
      output.push(...block);
      block = [];
      return;
    }

    // Reorder MCQ block cleanly: stem -> options -> single MCQ Answer -> badges/highlights -> ব্যাখ্যা:
    const stemLines: string[] = [];
    const orderedOptions: string[] = [];
    const mcqAnswerLines: string[] = [];
    const metaLines: string[] = [];
    const explanationLines: string[] = [];
    const trailingLines: string[] = [];

    let seenFirstOption = false;
    let insideExplanation = false;

    for (const raw of block) {
      const t = raw.trim();
      if (!t) continue;

      if (START_QUESTION_LINE_RE.test(t) && stemLines.length === 0) {
        stemLines.push(t);
        continue;
      }

      if (MCQ_OPTION_LINE_RE.test(t)) {
        seenFirstOption = true;
        insideExplanation = false;
        orderedOptions.push(`    ${t}`);
        continue;
      }

      const ansMatch = t.match(SINGLE_MCQ_ANSWER_LINE_RE);
      if (ansMatch) {
        const rawLabel = ansMatch[1];
        const normalizedLabel =
          rawLabel === 'উত্তর' ? 'উত্তর' : 'Answer';
        const val = /[a-d]/.test(ansMatch[2])
          ? ansMatch[2].toUpperCase()
          : ansMatch[2];
        mcqAnswerLines.push(`${normalizedLabel}: ${val}`);
        insideExplanation = false;
        continue;
      }

      const fullAnsMatch = t.match(/^(Answer|Ans|উত্তর)\s*[:ঃ.]\s*(.+)$/i);
      if (fullAnsMatch) {
        const rawLabel = fullAnsMatch[1];
        const normalizedLabel =
          rawLabel === 'উত্তর' ? 'উত্তর' : 'Answer';
        const rest = fullAnsMatch[2].trim();
        mcqAnswerLines.push(`${normalizedLabel}: ${rest}`);
        insideExplanation = false;
        continue;
      }

      const expMatch = t.match(EXPLANATION_OR_SOLUTION_LINE_RE);
      if (expMatch) {
        const body = (expMatch[2] ?? '').trim();
        explanationLines.push(body ? `ব্যাখ্যা: ${body}` : 'ব্যাখ্যা:');
        insideExplanation = true;
        continue;
      }

      if (
        /^\[AI দ্বারা তৈরি উত্তর\]/i.test(t) ||
        /^\[হাইলাইট\s*[:ঃ]/i.test(t) ||
        /^(?:রেফারেন্স|Reference)\s*:/i.test(t)
      ) {
        metaLines.push(t);
        insideExplanation = false;
        continue;
      }

      if (insideExplanation) {
        // Keep Markdown table rows on their own lines inside explanations
        if (isMarkdownTableLine(t)) {
          explanationLines.push(t);
          continue;
        }
        // Merge wrapped prose lines cleanly into the active `ব্যাখ্যা:` line
        if (
          explanationLines.length > 0 &&
          !isMarkdownTableLine(explanationLines[explanationLines.length - 1]) &&
          !/^(?:⇒|∴|অতএব\b|প্রশ্নমতে\b|প্রশ্নানুযায়ী\b|=)/.test(t)
        ) {
          explanationLines[explanationLines.length - 1] =
            `${explanationLines[explanationLines.length - 1]} ${t}`.replace(/\s{2,}/g, ' ').trim();
        } else {
          explanationLines.push(t);
        }
        continue;
      }

      if (!seenFirstOption) {
        stemLines.push(t);
      } else {
        trailingLines.push(t);
      }
    }

    output.push(
      ...stemLines,
      ...orderedOptions,
      ...mcqAnswerLines,
      ...metaLines,
      ...explanationLines,
      ...trailingLines,
      ''
    );
    block = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (START_QUESTION_LINE_RE.test(trimmed)) {
      flushBlock();
      block.push(line);
    } else if (block.length > 0) {
      block.push(line);
    } else {
      output.push(line);
    }
  }
  flushBlock();

  return output;
}

export type ParsedExamDisplayLine =
  | { kind: 'spacer' }
  | { kind: 'center_block'; lines: string[] }
  | { kind: 'diagram'; caption: string }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'question'; numberLabel: string; questionNumber: number; text: string }
  | { kind: 'option'; marker: string; text: string }
  | { kind: 'solution'; label: string; text: string }
  | { kind: 'explanation'; label: 'ব্যাখ্যা'; text: string }
  | { kind: 'highlight'; text: string }
  | { kind: 'ai_badge'; text: string }
  | { kind: 'reference'; label: string; text: string }
  | { kind: 'math'; text: string }
  | {
      kind: 'table';
      headers: string[];
      alignments: TableAlignment[];
      rows: string[][];
      indented: boolean;
    }
  | { kind: 'text'; text: string; indented: boolean };

export interface ParsedExamDocument {
  formatted: string;
  isExam: boolean;
  headerLines: string[];
  bodyItems: ParsedExamDisplayLine[];
}

const DISPLAY_NUMBERED_QUESTION_RE = new RegExp(
  `^(${QUESTION_NUM_ATOM}[.\\u0964])\\s+(.+)$`
);
const DISPLAY_SUB_OPTION_RE = /^([a-h]\)|[ক-ঙ]\)|\([ক-ঙ]\)|[ক-ঙ]\.|•)\s+(.+)$/;
const DISPLAY_EXPLANATION_LINE_RE = /^(?:ব্যাখ্যা|Explanation)\s*[:ঃ.]\s*(.*)$/i;
const DISPLAY_SOLUTION_LINE_RE = /^(Solution|Answer|Ans|উত্তর|সমাধান)\s*[:.]\s*(.*)$/i;
const DISPLAY_HIGHLIGHT_LINE_RE = /^\[হাইলাইট\s*[:ঃ]\s*(.+?)\]$/i;
const DISPLAY_DIAGRAM_LINE_RE = /^\[(?:চিত্র|Diagram|Figure)\s*[:ঃ]\s*(.+?)\]$/i;
const DISPLAY_DATA_IMAGE_RE = /^!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\)$/;
const DISPLAY_AI_BADGE_RE = /^\[AI দ্বারা তৈরি উত্তর\]\s*(.*)$/i;
const DISPLAY_REFERENCE_LINE_RE = /^(রেফারেন্স|Reference)\s*[:ঃ]\s*(.+)$/i;
const DISPLAY_MATH_STEP_RE = /^(⇒|∴|অতএব\b|প্রশ্নমতে\b|প্রশ্নানুযায়ী\b|=)/;

const HEADER_META_LINE_RE =
  /^(?:পদের\s+নাম|পদ|Post(?:\s*Name)?|পরীক্ষার\s+তারিখ|তারিখ|Date|সময়|সময়|Time|পূর্ণমান|মোট\s*নম্বর|Full\s*Marks|Total\s*Marks|বিষয়|বিষয়|বিভাগ|সেট|কেন্দ্র)\s*[:ঃ-]/i;
const HEADER_ORG_LINE_RE =
  /(?:পদের\s+নাম\s*:|পরীক্ষার\s+তারিখ\s*:|তারিখ\s*:|সময়\s*:|সময়\s*:|পূর্ণমান\s*:|প্রশ্ন\s+সমাধান|বিশ্ববিদ্যালয়|বিশ্ববিদ্যালয়|কমিশন|অধিদপ্তর|পরিদপ্তর|মন্ত্রণালয়|মন্ত্রণালয়|বোর্ড|কর্পোরেশন|পরিষদ|একাডেমি|কর্তৃপক্ষ|ব্যাংক|বিসিএস|পরীক্ষা)/i;
const PASSAGE_OR_BODY_START_RE =
  /^(?:Read\s+the\s+following|Answer\s+the\s+following|Directions?\s*[:ঃ]|Passage\s*[:ঃ]|নিচের\s+(?:অনুচ্ছেদ|প্যাসেজ|ছক|চিত্র|প্রশ্ন)|উদ্দীপক\s*[:ঃ]|\[চিত্র\s*[:ঃ]|!\[)/i;

/**
 * Extracts a leading full-width 1-column exam masthead cleanly EVEN when a reading passage
 * (`Read the following passage...`) appears between the exam header and Question 1, OR when
 * the user explicitly marks lines at the top with `<center>...</center>`.
 */
function extractLeadingExamHeader(
  lines: string[],
  firstQuestionIdx: number
): { headerLines: string[]; bodyStartIdx: number } {
  const limit = firstQuestionIdx > 0 ? firstQuestionIdx : Math.min(lines.length, 8);
  let firstNonEmptyIdx = -1;
  for (let i = 0; i < limit; i += 1) {
    if (lines[i].trim()) {
      firstNonEmptyIdx = i;
      break;
    }
  }
  if (firstNonEmptyIdx === -1) {
    return { headerLines: [], bodyStartIdx: 0 };
  }

  const firstTrimmed = lines[firstNonEmptyIdx].trim();

  // Case 1: Explicit user-centered header block `<center>...</center>` at the top
  if (/^<center>/i.test(firstTrimmed)) {
    const singleLineMatch = firstTrimmed.match(/^<center>([\s\S]+?)<\/center>$/i);
    if (singleLineMatch) {
      const inner = singleLineMatch[1]
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return { headerLines: inner, bodyStartIdx: firstNonEmptyIdx + 1 };
    }

    const collected: string[] = [];
    const openingRemainder = firstTrimmed.replace(/^<center>/i, '').trim();
    if (openingRemainder) collected.push(openingRemainder);

    for (let i = firstNonEmptyIdx + 1; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (/<\/center>$/i.test(t)) {
        const beforeClose = t.replace(/<\/center>$/i, '').trim();
        if (beforeClose) collected.push(beforeClose);
        return { headerLines: collected, bodyStartIdx: i + 1 };
      }
      if (t) collected.push(t);
    }
  }

  // Case 2: Automatic institutional exam header prefix before Passage or Question 1
  if (firstQuestionIdx <= 0) {
    return { headerLines: [], bodyStartIdx: 0 };
  }

  const headerLines: string[] = [];
  let lastHeaderLineIdx = -1;
  let seenMetaLine = false;

  for (let i = firstNonEmptyIdx; i < firstQuestionIdx; i += 1) {
    const t = lines[i].trim();
    if (!t) {
      // Allow a blank gap only before metadata finishes if next non-empty line is metadata
      continue;
    }

    if (
      PASSAGE_OR_BODY_START_RE.test(t) ||
      isMarkdownTableLine(t) ||
      /^<center>/i.test(t) ||
      t.length > 105
    ) {
      break;
    }

    const isMeta = HEADER_META_LINE_RE.test(t);
    if (seenMetaLine && !isMeta) {
      // Exam metadata section (Post/Time/Date/Marks) just ended; next text belongs to body/passage
      break;
    }

    headerLines.push(t);
    lastHeaderLineIdx = i;
    if (isMeta) {
      seenMetaLine = true;
    }

    if (headerLines.length >= 6) {
      break;
    }
  }

  const isValidHeader =
    headerLines.length > 0 &&
    headerLines.some((l) => HEADER_ORG_LINE_RE.test(l));

  if (!isValidHeader || lastHeaderLineIdx < 0) {
    return { headerLines: [], bodyStartIdx: 0 };
  }

  return {
    headerLines,
    bodyStartIdx: lastHeaderLineIdx + 1,
  };
}

/**
 * Shared structured parser used by `FormattedReaderContent` AND the Question Lab
 * PDF / Word / Formatted Text exporter so on-screen rendering and exported files match 100%.
 */
export function parseExamDocumentForDisplay(content: string): ParsedExamDocument {
  const clean = normalizeExamDocumentFormatting(content);
  const examMode = hasExamDocumentStructure(clean);
  if (!examMode) {
    return {
      formatted: clean,
      isExam: false,
      headerLines: [],
      bodyItems: [],
    };
  }

  const lines = clean.split('\n');
  const firstQuestionIdx = lines.findIndex((line) =>
    DISPLAY_NUMBERED_QUESTION_RE.test(line.trim())
  );

  const { headerLines, bodyStartIdx } = extractLeadingExamHeader(
    lines,
    firstQuestionIdx
  );

  const rawBody = lines.slice(bodyStartIdx);
  const bodyItems: ParsedExamDisplayLine[] = [];
  let insideQuestion = false;

  for (let lineIdx = 0; lineIdx < rawBody.length; lineIdx += 1) {
    const rawLine = rawBody[lineIdx];
    const trimmed = rawLine.trim();
    if (!trimmed) {
      bodyItems.push({ kind: 'spacer' });
      continue;
    }

    if (
      isMarkdownTableLine(trimmed) ||
      (trimmed.includes('|') &&
        lineIdx + 1 < rawBody.length &&
        isMarkdownTableSeparatorLine(rawBody[lineIdx + 1]))
    ) {
      const tableLines: string[] = [];
      let j = lineIdx;
      while (
        j < rawBody.length &&
        rawBody[j].trim() &&
        (isMarkdownTableLine(rawBody[j]) ||
          (j === lineIdx &&
            lineIdx + 1 < rawBody.length &&
            isMarkdownTableSeparatorLine(rawBody[lineIdx + 1])))
      ) {
        tableLines.push(rawBody[j]);
        j += 1;
      }
      const parsedTable = parseMarkdownTableBlock(tableLines);
      if (parsedTable) {
        bodyItems.push({
          kind: 'table',
          headers: parsedTable.headers,
          alignments: parsedTable.alignments,
          rows: parsedTable.rows,
          indented: insideQuestion,
        });
        lineIdx = j - 1;
        continue;
      }
    }

    // Explicit centered section banner `<center>...</center>` mid-document
    if (/^<center>/i.test(trimmed)) {
      const singleLineMatch = trimmed.match(/^<center>([\s\S]+?)<\/center>$/i);
      if (singleLineMatch) {
        const innerLines = singleLineMatch[1]
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        if (innerLines.length > 0) {
          bodyItems.push({ kind: 'center_block', lines: innerLines });
        }
        continue;
      }
      const centerLines: string[] = [];
      const firstRem = trimmed.replace(/^<center>/i, '').trim();
      if (firstRem) centerLines.push(firstRem);
      let j = lineIdx + 1;
      while (j < rawBody.length) {
        const t = rawBody[j].trim();
        if (/<\/center>$/i.test(t)) {
          const rem = t.replace(/<\/center>$/i, '').trim();
          if (rem) centerLines.push(rem);
          break;
        }
        if (t) centerLines.push(t);
        j += 1;
      }
      if (centerLines.length > 0) {
        bodyItems.push({ kind: 'center_block', lines: centerLines });
      }
      lineIdx = Math.min(j, rawBody.length - 1);
      continue;
    }

    // Embedded figure / diagram image `![alt](data:image/...)`
    const imgMatch = trimmed.match(DISPLAY_DATA_IMAGE_RE);
    if (imgMatch) {
      bodyItems.push({
        kind: 'image',
        alt: imgMatch[1].trim() || 'প্রশ্নের চিত্র',
        src: imgMatch[2],
      });
      continue;
    }

    // Structured OCR diagram callout `[চিত্র: ...]`
    const diagramMatch = trimmed.match(DISPLAY_DIAGRAM_LINE_RE);
    if (diagramMatch) {
      bodyItems.push({
        kind: 'diagram',
        caption: diagramMatch[1].trim(),
      });
      continue;
    }

    const qMatch = trimmed.match(DISPLAY_NUMBERED_QUESTION_RE);
    if (qMatch) {
      insideQuestion = true;
      const parsedNum = Number.parseInt(
        toAsciiDigitsLocal(qMatch[1].slice(0, -1)),
        10
      );
      bodyItems.push({
        kind: 'question',
        numberLabel: qMatch[1],
        questionNumber: Number.isFinite(parsedNum) ? parsedNum : 0,
        text: qMatch[2],
      });
      continue;
    }

    const optMatch = trimmed.match(DISPLAY_SUB_OPTION_RE);
    if (optMatch) {
      bodyItems.push({
        kind: 'option',
        marker: optMatch[1],
        text: optMatch[2],
      });
      continue;
    }

    const highlightMatch = trimmed.match(DISPLAY_HIGHLIGHT_LINE_RE);
    if (highlightMatch) {
      bodyItems.push({
        kind: 'highlight',
        text: highlightMatch[1].trim(),
      });
      continue;
    }

    const aiBadgeMatch = trimmed.match(DISPLAY_AI_BADGE_RE);
    if (aiBadgeMatch) {
      bodyItems.push({
        kind: 'ai_badge',
        text: aiBadgeMatch[1]?.trim() || 'AI দ্বারা তৈরি উত্তর (মূল বইয়ে উত্তর ছিল না)',
      });
      continue;
    }

    const refMatch = trimmed.match(DISPLAY_REFERENCE_LINE_RE);
    if (refMatch) {
      bodyItems.push({
        kind: 'reference',
        label: refMatch[1],
        text: refMatch[2].trim(),
      });
      continue;
    }

    const expMatch = trimmed.match(DISPLAY_EXPLANATION_LINE_RE);
    if (expMatch) {
      bodyItems.push({
        kind: 'explanation',
        label: 'ব্যাখ্যা',
        text: expMatch[1].trim(),
      });
      continue;
    }

    const solMatch = trimmed.match(DISPLAY_SOLUTION_LINE_RE);
    if (solMatch) {
      const normalizedLabel =
        solMatch[1].toLowerCase() === 'ans' ? 'Answer' : solMatch[1];
      bodyItems.push({
        kind: 'solution',
        label: normalizedLabel,
        text: solMatch[2],
      });
      continue;
    }

    if (DISPLAY_MATH_STEP_RE.test(trimmed)) {
      bodyItems.push({ kind: 'math', text: trimmed });
      continue;
    }

    bodyItems.push({ kind: 'text', text: trimmed, indented: insideQuestion });
  }

  return {
    formatted: clean,
    isExam: true,
    headerLines,
    bodyItems,
  };
}

/**
 * Extracts a concise, human-readable exam title from an exam page header
 * (e.g. "মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট") when present at the top of a page.
 */
export function extractExamTitleFromText(formattedText: string): string | null {
  if (!formattedText) return null;
  const lines = formattedText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);

  if (lines.length === 0) return null;

  const firstQuestionIdx = lines.findIndex((l) =>
    START_QUESTION_LINE_RE.test(l)
  );
  const headerBlock = firstQuestionIdx > 0 ? lines.slice(0, firstQuestionIdx) : lines.slice(0, 3);
  if (headerBlock.length === 0) return null;

  const hasHeaderMeta = headerBlock.some((l) =>
    /(?:পদের\s+নাম\s*:|পরীক্ষার\s+তারিখ\s*:|তারিখ\s*:|সময়\s*:|সময়\s*:|পূর্ণমান\s*:|প্রশ্ন\s+সমাধান)/.test(
      l
    )
  );
  if (!hasHeaderMeta) return null;

  const orgLine = headerBlock.find(
    (l) => !/^(?:পদের\s+নাম|পরীক্ষার\s+তারিখ|তারিখ|সময়|সময়|পূর্ণমান)\s*:/i.test(l)
  );
  const postLine = headerBlock.find((l) => /^পদের\s+নাম\s*:/i.test(l));
  const postName = postLine
    ? postLine.replace(/^পদের\s+নাম\s*:\s*/i, '').trim()
    : '';

  if (orgLine && postName) {
    const combined = `${orgLine} — ${postName}`;
    return combined.length > 72 ? `${combined.slice(0, 71)}…` : combined;
  }
  const single = orgLine || postName;
  if (!single) return null;
  return single.length > 72 ? `${single.slice(0, 71)}…` : single;
}
