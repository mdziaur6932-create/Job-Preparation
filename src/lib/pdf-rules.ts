import { toBengaliNumber } from './file-validation';
import { normalizeExamDocumentFormatting } from './exam-text-formatter';
import { hasCorruptedMathOcr } from './exam-math-and-answer-guard';

export const GEMINI_HARD_PDF_LIMIT_BYTES = 50 * 1024 * 1024; // 50 MB Gemini PDF limit
export const DEFAULT_MAX_BATCH_BYTES = 35 * 1024 * 1024; // 35 MB safety threshold (< 50 MB)
export const MAX_SAFE_BATCH_BYTES = 40 * 1024 * 1024; // 40 MB upper configurable threshold
export const MAX_SINGLE_PAGE_PDF_BYTES = 48 * 1024 * 1024; // Absolute ceiling for 1-page PDF
export const DEFAULT_MAX_PAGES_PER_BATCH = 8; // Standard accuracy batch size
export const FAST_OCR_MAX_PAGES_PER_BATCH = 4; // Optimal dense Bangla/English MCQ OCR batch size (prevents output truncation & timeouts)
export const FAST_OCR_BATCH_CONCURRENCY = 3; // Free-Tier RPM-safe 3x parallel OCR (~3x speedup with lower 429 burst risk)
export const ACCURATE_OCR_BATCH_CONCURRENCY = 2; // Safe concurrency for accurate mode when opted in
export const GEMINI_FILES_API_THRESHOLD_BYTES = 10 * 1024 * 1024; // Use Files API above 10 MB
export const MIN_MEANINGFUL_TEXT_CHARS = 20;
export const MIN_PAGE_SUBSTANTIVE_CHARS = 12;
export const MIN_LOCAL_TEXT_PAGE_CHARS = 25;

export type PdfOcrSpeed = 'fast' | 'accurate';
export type PdfExtractionStatus = 'success' | 'partial' | 'failed';
export type DocumentTextProfile = 'text_based' | 'scanned' | 'mixed';

export interface PageMapping {
  /** 1-based internal page index inside the uploaded PDF file (1..actualPageCount). */
  pdfPageIndex: number;
  /** Printed/original book page number (e.g., 37..44 for an 8-page excerpt). */
  originalPageNumber: number;
}

export interface ParsedPageRangeSyntax {
  ok: true;
  empty: boolean;
  startPage: number | null;
  endPage: number | null;
  normalizedLabel: string | null;
}

export interface ParsedPageRangeError {
  ok: false;
  error: string;
}

export type PageRangeSyntaxResult = ParsedPageRangeSyntax | ParsedPageRangeError;

export type PageMappingBuildResult =
  | {
      ok: true;
      actualPageCount: number;
      startPage: number;
      endPage: number;
      originalPageRangeLabel: string;
      mappings: PageMapping[];
    }
  | {
      ok: false;
      error: string;
    };

export interface RawExtractedPageInput {
  pdfPageIndex?: number | null;
  originalPageNumber?: number | null;
  chapter?: string | null;
  content?: string | null;
  hasReadableText?: boolean | null;
  ocrUsed?: boolean | null;
}

export interface NormalizedExtractedPage {
  pdfPageIndex: number;
  originalPageNumber: number;
  chapter: string;
  content: string;
  charCount: number;
  hasReadableText: boolean;
  ocrUsed: boolean;
  isShortWarning: boolean;
}

export interface BatchExtractionResult {
  batchIndex: number;
  status: PdfExtractionStatus;
  expectedMappings: PageMapping[];
  pages: NormalizedExtractedPage[];
  extractedPageCount: number;
  missingOriginalPages: number[];
  duplicateOriginalPages: number[];
  outOfOrderDetected: boolean;
  ocrUsed: boolean;
  usedFilesApi: boolean;
  warnings: string[];
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface ExtractedSectionItem {
  chapter: string;
  pageNumber: number;
  pdfPageIndex: number;
  content: string;
}

export interface CombinedExtractionResult {
  extractionStatus: PdfExtractionStatus;
  method: 'text' | 'ocr' | 'manual';
  ocrCompleted: boolean;
  actualPageCount: number;
  expectedPageCount: number;
  extractedPageCount: number;
  originalPageRange: string;
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  missingOriginalPages: number[];
  duplicateOriginalPages: number[];
  outOfOrderDetected: boolean;
  sections: ExtractedSectionItem[];
  rawText: string;
  meaningfulCharCount: number;
  warnings: string[];
  error?: string;
}

export interface BookSaveReadinessResult {
  ok: boolean;
  error?: string;
  meaningfulCharCount: number;
  computedTotalPages: number;
}

export function normalizeBengaliDigitsToAscii(input: string): string {
  return input.replace(/[০-৯]/g, (ch) => String('০১২৩৪৫৬৭৮৯'.indexOf(ch)));
}

/**
 * Parses a user-supplied original page range string such as:
 * - "" (blank -> automatic 1..N)
 * - "Page 37-44", "Pages 37-44", "37-44", "37–44", "পৃষ্ঠা ৩৭-৪৪", "37 to 44"
 * - "37" (single page; valid when the PDF has 1 page)
 */
export function parseOriginalPageRangeSyntax(rawInput: string | null | undefined): PageRangeSyntaxResult {
  const trimmed = (rawInput ?? '').trim();
  if (!trimmed) {
    return {
      ok: true,
      empty: true,
      startPage: null,
      endPage: null,
      normalizedLabel: null,
    };
  }

  const ascii = normalizeBengaliDigitsToAscii(trimmed)
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip optional leading words like "Page", "Pages", "P.", "পৃষ্ঠা", "পৃ."
  const stripped = ascii
    .replace(/^(?:pages?|p\.?|পৃষ্ঠা|পৃ\.?)\s*[:#-]?\s*/i, '')
    .trim();

  // Match "37-44" or "37 to 44" or "37 থেকে 44"
  const rangeMatch = stripped.match(/^(\d{1,6})\s*(?:-|to|থেকে)\s*(\d{1,6})$/i);
  if (rangeMatch) {
    const startPage = Number.parseInt(rangeMatch[1], 10);
    const endPage = Number.parseInt(rangeMatch[2], 10);
    if (!Number.isFinite(startPage) || !Number.isFinite(endPage) || startPage < 1 || endPage < 1) {
      return {
        ok: false,
        error: 'মূল বইয়ের পৃষ্ঠা নম্বর ১ বা তার বেশি হতে হবে (যেমন: Page 37-44)।',
      };
    }
    if (endPage < startPage) {
      return {
        ok: false,
        error: `শুরুর পৃষ্ঠা (${toBengaliNumber(startPage)}) শেষের পৃষ্ঠার (${toBengaliNumber(endPage)}) চেয়ে বড় হতে পারে না।`,
      };
    }
    return {
      ok: true,
      empty: false,
      startPage,
      endPage,
      normalizedLabel: `${startPage}-${endPage}`,
    };
  }

  // Match single page number e.g. "37"
  const singleMatch = stripped.match(/^(\d{1,6})$/);
  if (singleMatch) {
    const page = Number.parseInt(singleMatch[1], 10);
    if (!Number.isFinite(page) || page < 1) {
      return {
        ok: false,
        error: 'মূল বইয়ের পৃষ্ঠা নম্বর ১ বা তার বেশি হতে হবে।',
      };
    }
    return {
      ok: true,
      empty: false,
      startPage: page,
      endPage: page,
      normalizedLabel: `${page}`,
    };
  }

  return {
    ok: false,
    error:
      'পৃষ্ঠা রেঞ্জের ফরম্যাট সঠিক নয়। অনুগ্রহ করে "Page 37-44" অথবা "৩৭-৪৪" ফরম্যাটে লিখুন।',
  };
}

/**
 * Validates the user's original page range against the PDF's actual inspected page count
 * and builds the authoritative 1:1 mapping from PDF internal page index (1..N) to
 * original printed book page number (e.g., 37..44).
 */
export function buildPageMappings(
  actualPdfPageCount: number,
  rawRangeInput?: string | null
): PageMappingBuildResult {
  if (!Number.isInteger(actualPdfPageCount) || actualPdfPageCount < 1) {
    return {
      ok: false,
      error: 'PDF ফাইলটিতে কোনো বৈধ পৃষ্ঠা পাওয়া যায়নি।',
    };
  }

  const parsed = parseOriginalPageRangeSyntax(rawRangeInput);
  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.empty || parsed.startPage === null || parsed.endPage === null) {
    const mappings: PageMapping[] = Array.from({ length: actualPdfPageCount }, (_, idx) => ({
      pdfPageIndex: idx + 1,
      originalPageNumber: idx + 1,
    }));
    return {
      ok: true,
      actualPageCount: actualPdfPageCount,
      startPage: 1,
      endPage: actualPdfPageCount,
      originalPageRangeLabel: actualPdfPageCount === 1 ? '1' : `1-${actualPdfPageCount}`,
      mappings,
    };
  }

  const requestedCount = parsed.endPage - parsed.startPage + 1;
  if (requestedCount !== actualPdfPageCount) {
    const suggestedEnd = parsed.startPage + actualPdfPageCount - 1;
    return {
      ok: false,
      error: `এই PDF-এ প্রকৃত পৃষ্ঠা সংখ্যা ${toBengaliNumber(actualPdfPageCount)}টি, কিন্তু আপনার দেওয়া পৃষ্ঠা রেঞ্জ (${toBengaliNumber(parsed.startPage)}–${toBengaliNumber(parsed.endPage)})-এ ${toBengaliNumber(requestedCount)}টি পৃষ্ঠা রয়েছে। অনুগ্রহ করে ${toBengaliNumber(actualPdfPageCount)}টি পৃষ্ঠার সাথে সামঞ্জস্যপূর্ণ রেঞ্জ দিন (যেমন: ${toBengaliNumber(parsed.startPage)}-${toBengaliNumber(suggestedEnd)})।`,
    };
  }

  const mappings: PageMapping[] = Array.from({ length: actualPdfPageCount }, (_, idx) => ({
    pdfPageIndex: idx + 1,
    originalPageNumber: parsed.startPage! + idx,
  }));

  return {
    ok: true,
    actualPageCount: actualPdfPageCount,
    startPage: parsed.startPage,
    endPage: parsed.endPage,
    originalPageRangeLabel:
      parsed.startPage === parsed.endPage
        ? `${parsed.startPage}`
        : `${parsed.startPage}-${parsed.endPage}`,
    mappings,
  };
}

export type PdfPageSubsetResult =
  | {
      ok: true;
      empty: boolean;
      startPage: number | null;
      endPage: number | null;
      normalizedLabel: string | null;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Parses an optional PDF page subset selection (e.g., "1-25", "26-50", "১-৩০")
 * that slices a large PDF BEFORE upload/OCR so users can extract chapters in seconds.
 */
export function parsePdfPageSubsetSyntax(
  rawInput: string | null | undefined,
  totalPdfPages?: number
): PdfPageSubsetResult {
  const parsed = parseOriginalPageRangeSyntax(rawInput);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        'PDF পৃষ্ঠা বাছাইয়ের ফরম্যাট সঠিক নয়। যেমন: "1-25" বা "২৬-৫০" লিখুন, অথবা সব পৃষ্ঠার জন্য খালি রাখুন।',
    };
  }
  if (parsed.empty || parsed.startPage === null || parsed.endPage === null) {
    return {
      ok: true,
      empty: true,
      startPage: null,
      endPage: null,
      normalizedLabel: null,
    };
  }
  if (typeof totalPdfPages === 'number' && totalPdfPages > 0) {
    if (parsed.startPage > totalPdfPages) {
      return {
        ok: false,
        error: `এই PDF-এ মোট ${toBengaliNumber(totalPdfPages)}টি পৃষ্ঠা রয়েছে, কিন্তু শুরুর পৃষ্ঠা দেওয়া হয়েছে ${toBengaliNumber(parsed.startPage)}।`,
      };
    }
    const clampedEnd = Math.min(parsed.endPage, totalPdfPages);
    return {
      ok: true,
      empty: false,
      startPage: parsed.startPage,
      endPage: clampedEnd,
      normalizedLabel:
        parsed.startPage === clampedEnd
          ? `${parsed.startPage}`
          : `${parsed.startPage}-${clampedEnd}`,
    };
  }
  return {
    ok: true,
    empty: false,
    startPage: parsed.startPage,
    endPage: parsed.endPage,
    normalizedLabel: parsed.normalizedLabel,
  };
}

/**
 * Repairs common Gemini JSON formatting glitches inside dense Bengali/English/Math OCR output:
 * - Unescaped newlines, carriage returns, tabs, or control characters inside string literals
 * - Invalid backslash escapes from math formulas (e.g. `\frac`, `\%`, `\(`, `\s`)
 * - Trailing commas before `}` or `]` outside strings
 */
export function repairMalformedJsonString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Remove optional markdown code fences or prose wrapping the outer JSON object
  const fenceStripped = trimmed
    .replace(/^```(?:json|JSON)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .trim();

  const firstBrace = fenceStripped.indexOf('{');
  const firstBracket = fenceStripped.indexOf('[');
  let startIdx = 0;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }

  let endIdx = fenceStripped.length;
  if (fenceStripped[startIdx] === '{') {
    const lastBrace = fenceStripped.lastIndexOf('}');
    if (lastBrace > startIdx) {
      endIdx = lastBrace + 1;
    }
  } else if (fenceStripped[startIdx] === '[') {
    const lastBracket = fenceStripped.lastIndexOf(']');
    if (lastBracket > startIdx) {
      endIdx = lastBracket + 1;
    }
  }

  const candidate = fenceStripped.slice(startIdx, endIdx);

  // Pass 1: Repair invalid escapes and raw control chars inside JSON string literals
  let out = '';
  let inString = false;
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];

    if (inString) {
      if (ch === '\\') {
        const next = candidate[i + 1];
        const rest = candidate.slice(i + 1, i + 12);
        const isLatexEscapeCollision =
          (next === 'f' && /^(?:frac|forall)(?![a-zA-Z])/.test(rest)) ||
          (next === 't' && /^(?:times|theta|tan|tau|text|therefore|triangle|to)(?![a-zA-Z])/.test(rest)) ||
          (next === 'b' && /^(?:beta|binom|bar|begin|big)(?![a-zA-Z])/.test(rest)) ||
          (next === 'r' && /^(?:right|rho|root|rangle)(?![a-zA-Z])/.test(rest)) ||
          (next === 'n' && /^(?:neq|nabla|nu|not)(?![a-zA-Z])/.test(rest));

        if (next === undefined) {
          out += '\\\\';
        } else if (isLatexEscapeCollision) {
          out += '\\\\';
        } else if (
          next === '"' ||
          next === '\\' ||
          next === '/' ||
          next === 'n' ||
          next === 'r' ||
          next === 't' ||
          ((next === 'b' || next === 'f') && !/[a-zA-Z]/.test(candidate[i + 2] ?? ''))
        ) {
          out += '\\' + next;
          i += 1;
        } else if (
          next === 'u' &&
          /^[0-9a-fA-F]{4}$/.test(candidate.slice(i + 2, i + 6))
        ) {
          out += candidate.slice(i, i + 6);
          i += 5;
        } else {
          // Invalid JSON escape or LaTeX command (e.g. \frac, \begin, \%, \sqrt, \a) -> escape backslash
          out += '\\\\';
        }
        continue;
      }

      if (ch === '"') {
        inString = false;
        out += '"';
        continue;
      }

      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        out += ' ';
        continue;
      }

      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }

  // Pass 2: Remove trailing commas before `}` or `]` outside strings
  let cleaned = '';
  inString = false;
  let escaped = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      cleaned += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }

    if (ch === ',') {
      let lookAhead = i + 1;
      while (lookAhead < out.length && /\s/.test(out[lookAhead])) {
        lookAhead += 1;
      }
      if (out[lookAhead] === '}' || out[lookAhead] === ']') {
        continue;
      }
    }

    cleaned += ch;
  }

  return cleaned;
}

function isValidSalvagedPageObject(obj: unknown): obj is RawExtractedPageInput {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const rec = obj as RawExtractedPageInput;
  return (
    typeof rec.content === 'string' &&
    (typeof rec.originalPageNumber === 'number' || typeof rec.pdfPageIndex === 'number')
  );
}

function unescapeLooseJsonString(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Last-resort field extractor for a single `{...}` page object whose `"content"` string
 * contained unescaped double quotes (which breaks strict `JSON.parse`).
 */
function extractPageObjectLoosely(slice: string): RawExtractedPageInput | null {
  const origMatch = slice.match(/"originalPageNumber"\s*:\s*(\d+)/);
  const pdfMatch = slice.match(/"pdfPageIndex"\s*:\s*(\d+)/);
  if (!origMatch && !pdfMatch) return null;

  const contentKeyMatch = slice.match(/"content"\s*:\s*"/);
  if (!contentKeyMatch || contentKeyMatch.index === undefined) return null;

  const contentStart = contentKeyMatch.index + contentKeyMatch[0].length;
  const remainder = slice.slice(contentStart);

  // Locate the closing quote right before the next known JSON key or closing `}`
  const closingBoundary = remainder.match(
    /"\s*(?:,\s*"(?:hasReadableText|ocrUsed|chapter|pdfPageIndex|originalPageNumber)"|\s*\})/
  );
  if (!closingBoundary || closingBoundary.index === undefined) return null;

  const rawContent = remainder.slice(0, closingBoundary.index);
  const chapterMatch = slice.match(/"chapter"\s*:\s*"([^"\n\r]{0,200})"/);
  const ocrMatch = slice.match(/"ocrUsed"\s*:\s*(true|false)/);
  const readableMatch = slice.match(/"hasReadableText"\s*:\s*(true|false)/);

  return {
    pdfPageIndex: pdfMatch ? Number.parseInt(pdfMatch[1], 10) : undefined,
    originalPageNumber: origMatch ? Number.parseInt(origMatch[1], 10) : undefined,
    chapter: chapterMatch ? unescapeLooseJsonString(chapterMatch[1]) : undefined,
    content: unescapeLooseJsonString(rawContent),
    hasReadableText: readableMatch ? readableMatch[1] === 'true' : true,
    ocrUsed: ocrMatch ? ocrMatch[1] === 'true' : true,
  };
}

/**
 * Salvages any complete page objects from a malformed or truncated Gemini JSON response
 * (e.g. unescaped newlines, math backslashes like `\frac`, trailing commas, unescaped quotes,
 * or token-limit truncation right before closing `]}`), preventing an entire batch from
 * being discarded as 0 extracted pages.
 */
export function salvagePagesFromMalformedJson(rawText: string | undefined): RawExtractedPageInput[] {
  if (!rawText) return [];

  // Stage 1: Attempt full-document repair + JSON.parse first (recovers all pages on escape/newline/comma glitches)
  try {
    const repaired = repairMalformedJsonString(rawText);
    if (repaired.startsWith('{')) {
      const parsed = JSON.parse(repaired) as { pages?: unknown };
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.pages)) {
        const validPages = parsed.pages.filter(isValidSalvagedPageObject);
        if (validPages.length > 0) {
          return validPages;
        }
      }
    }
  } catch {
    // Continue to per-object salvage scanner
  }

  const pagesKeyIdx = rawText.indexOf('"pages"');
  const startBracket = rawText.indexOf('[', pagesKeyIdx >= 0 ? pagesKeyIdx : 0);
  if (startBracket === -1) return [];

  const salvaged: RawExtractedPageInput[] = [];
  let inString = false;
  let escaped = false;
  let braceDepth = 0;
  let objStart = -1;

  for (let i = startBracket + 1; i < rawText.length; i += 1) {
    const ch = rawText[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (braceDepth === 0) {
        objStart = i;
      }
      braceDepth += 1;
      continue;
    }

    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
        if (braceDepth === 0 && objStart !== -1) {
          const slice = rawText.slice(objStart, i + 1);
          objStart = -1;
          let parsedObj: RawExtractedPageInput | null = null;
          try {
            const candidate = JSON.parse(repairMalformedJsonString(slice)) as unknown;
            if (isValidSalvagedPageObject(candidate)) {
              parsedObj = candidate;
            }
          } catch {
            parsedObj = extractPageObjectLoosely(slice);
          }
          if (parsedObj) {
            salvaged.push(parsedObj);
          }
        }
      }
    }
  }

  // Stage 3: If unescaped quotes broke brace tracking completely, split by object boundaries
  if (salvaged.length === 0) {
    const roughBlocks = rawText
      .slice(startBracket + 1)
      .split(/(?=\{\s*"(?:pdfPageIndex|originalPageNumber)")/);
    for (const block of roughBlocks) {
      const loose = extractPageObjectLoosely(block);
      if (loose && typeof loose.content === 'string' && loose.content.trim().length > 0) {
        salvaged.push(loose);
      }
    }
  }

  return salvaged;
}

/**
 * Parses Gemini's quote-proof and math-backslash-proof plain-text delimited OCR format:
 *
 *   <<<PAGE_START pdf=37 orig=37 chapter="রিসেন্ট জব সলুশন" ocr=true>>>
 *   ...arbitrary Bengali/English/Math text...
 *   <<<PAGE_END>>>
 *
 * Also tolerates missing final `<<<PAGE_END>>>` and standard `--- পৃষ্ঠা N ---` headers.
 */
export function parseDelimitedPagesOutput(
  rawText: string | undefined,
  expectedMappings: PageMapping[],
  fallbackChapter: string,
  useOcr: boolean
): RawExtractedPageInput[] {
  const text = (rawText ?? '').trim();
  if (!text) return [];

  const results: RawExtractedPageInput[] = [];
  const blockRegex =
    /<<<\s*PAGE_START\b([^>]*)>>>([\s\S]*?)(?:<<<\s*PAGE_END\s*>>>|(?=<<<\s*PAGE_START\b)|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(text)) !== null) {
    const attrs = match[1] ?? '';
    const body = (match[2] ?? '').replace(/^\r?\n/, '').replace(/\r?\n$/, '').trim();

    const pdfMatch = attrs.match(/\bpdf\s*=\s*["']?([0-9০-৯]+)["']?/i);
    const origMatch = attrs.match(/\borig(?:inal)?\s*=\s*["']?([0-9০-৯]+)["']?/i);
    const chapterQuoted = attrs.match(/\bchapter\s*=\s*"([^"]*)"/i);
    const chapterSingle = attrs.match(/\bchapter\s*=\s*'([^']*)'/i);
    const ocrMatch = attrs.match(/\bocr\s*=\s*["']?(true|false)["']?/i);

    const pdfPageIndex = pdfMatch
      ? Number.parseInt(normalizeBengaliDigitsToAscii(pdfMatch[1]), 10)
      : undefined;
    const originalPageNumber = origMatch
      ? Number.parseInt(normalizeBengaliDigitsToAscii(origMatch[1]), 10)
      : undefined;
    const chapter =
      (chapterQuoted?.[1] ?? chapterSingle?.[1] ?? '').trim() || fallbackChapter;
    const ocrUsed = ocrMatch ? ocrMatch[1].toLowerCase() === 'true' : useOcr;

    if (pdfPageIndex !== undefined || originalPageNumber !== undefined) {
      results.push({
        pdfPageIndex,
        originalPageNumber,
        chapter,
        content: body,
        hasReadableText: body.length > 0,
        ocrUsed,
      });
    }
  }

  if (results.length > 0) {
    return results;
  }

  // Fallback: handle plain `--- পৃষ্ঠা 37 ---` / `--- Page 37 ---` section markers
  const markerRegex =
    /^-{2,}\s*(?:page|পৃষ্ঠা)\s*[:#-]?\s*([0-9০-৯]+)\s*-{2,}$/gim;
  const markerHits: Array<{ pageNum: number; headerStart: number; bodyStart: number }> = [];
  while ((match = markerRegex.exec(text)) !== null) {
    const pageNum = Number.parseInt(normalizeBengaliDigitsToAscii(match[1]), 10);
    if (Number.isFinite(pageNum) && pageNum >= 1) {
      markerHits.push({
        pageNum,
        headerStart: match.index,
        bodyStart: match.index + match[0].length,
      });
    }
  }

  if (markerHits.length > 0) {
    for (let i = 0; i < markerHits.length; i += 1) {
      const current = markerHits[i];
      const next = markerHits[i + 1];
      const body = text
        .slice(current.bodyStart, next ? next.headerStart : text.length)
        .trim();
      if (body) {
        results.push({
          originalPageNumber: current.pageNum,
          chapter: fallbackChapter,
          content: body,
          hasReadableText: true,
          ocrUsed: useOcr,
        });
      }
    }
    if (results.length > 0) {
      return results;
    }
  }

  // Single-page plain-text fallback (never wrap raw JSON fragments as content)
  if (expectedMappings.length === 1) {
    const looksLikeJson = /^\s*(?:```json)?\s*\{\s*"pages"\s*:/i.test(text);
    if (!looksLikeJson && isMeaningfulPageContent(text)) {
      return [
        {
          pdfPageIndex: expectedMappings[0].pdfPageIndex,
          originalPageNumber: expectedMappings[0].originalPageNumber,
          chapter: fallbackChapter,
          content: text,
          hasReadableText: true,
          ocrUsed: useOcr,
        },
      ];
    }
  }

  return [];
}

/**
 * Strips structural page headers ("--- পৃষ্ঠা 37 ---"), bracketed chapter labels,
 * and standalone page-range placeholders ("Page 37-44") so we can measure real
 * substantive document prose reliably.
 */
export function stripPageMarkersAndHeaders(text: string): string {
  if (!text) return '';

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const substantiveLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip "--- পৃষ্ঠা 37 ---" or "--- Page 37 ---" markers
    if (/^-{2,}\s*(?:page|পৃষ্ঠা)\s*[:#-]?\s*[0-9০-৯]+(?:\s*[-–—]\s*[0-9০-৯]+)?\s*-{2,}$/i.test(line)) {
      continue;
    }

    // Skip standalone page-range strings like "Page 37-44", "Pages 37 - 44", "পৃষ্ঠা ৩৭-৪৪"
    if (/^(?:pages?|p\.?|পৃষ্ঠা|পৃ\.?)\s*[:#-]?\s*[0-9০-৯]+(?:\s*(?:[-–—]|to|থেকে)\s*[0-9০-৯]+)?$/i.test(line)) {
      continue;
    }

    // Skip standalone bracketed chapter headers generated by formatter like "[অধ্যায় ১]" or "[Page 37-44]"
    if (/^\[[^\]]{1,120}\]$/.test(line)) {
      continue;
    }

    // Skip bare numeric range lines like "37-44" or "৩৭–৪৪"
    if (/^[0-9০-৯]+\s*[-–—]\s*[0-9০-৯]+$/.test(line)) {
      continue;
    }

    substantiveLines.push(line);
  }

  return substantiveLines.join('\n').trim();
}

/**
 * Returns true if the text consists solely of page headers / page-range labels
 * without meaningful document body prose.
 */
export function isPageRangeOnlyText(text: string): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  const substantive = stripPageMarkersAndHeaders(trimmed);
  return substantive.length === 0;
}

/**
 * Checks whether an individual extracted page has genuine readable content
 * (not empty, not just a page number/range placeholder).
 */
export function isMeaningfulPageContent(content: string): boolean {
  const substantive = stripPageMarkersAndHeaders(content ?? '');
  if (!substantive) return false;
  // Require at least 4 alphanumeric/Bengali characters (handles short title/cover pages
  // while rejecting punctuation/whitespace/empty placeholders)
  const wordChars = substantive.match(/[\u0980-\u09FFa-zA-Z0-9]/g) ?? [];
  return wordChars.length >= 4;
}

export interface LocalPageTextEvaluation {
  usable: boolean;
  cleanedText: string;
  substantiveLength: number;
  reason?: 'empty' | 'too_short' | 'garbled_encoding' | 'garbled_math';
}

/**
 * Evaluates text extracted locally from a PDF page's embedded text layer.
 * - Accepts clean Bengali Unicode and/or English prose (>= 25 substantive chars).
 * - Rejects empty/header-only pages and garbled legacy ANSI/Bijoy/PUA encodings so
 *   those pages automatically fall back to visual Gemini OCR instead of saving gibberish.
 */
export function evaluateLocalExtractedPageText(
  rawText: string,
  minChars: number = MIN_LOCAL_TEXT_PAGE_CHARS
): LocalPageTextEvaluation {
  const normalized = (rawText ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    return {
      usable: false,
      cleanedText: '',
      substantiveLength: 0,
      reason: 'empty',
    };
  }

  const substantive = stripPageMarkersAndHeaders(normalized);
  if (substantive.length < minChars) {
    return {
      usable: false,
      cleanedText: normalized,
      substantiveLength: substantive.length,
      reason: 'too_short',
    };
  }

  const nonWsChars = substantive.replace(/\s+/g, '');
  if (nonWsChars.length < minChars) {
    return {
      usable: false,
      cleanedText: normalized,
      substantiveLength: nonWsChars.length,
      reason: 'too_short',
    };
  }

  // Detect replacement chars, control chars, or Private-Use-Area glyphs (broken ToUnicode CMaps)
  const corruptedMatches =
    nonWsChars.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\uE000-\uF8FF]/g) ?? [];
  if (corruptedMatches.length / nonWsChars.length > 0.03) {
    return {
      usable: false,
      cleanedText: normalized,
      substantiveLength: substantive.length,
      reason: 'garbled_encoding',
    };
  }

  // Detect legacy Bijoy / SutonnyMJ / Windows-1252 ANSI mojibake
  // (e.g., ‡, †, „, ¤, ©, Latin-1 Supplement symbols with little/no real Bengali Unicode)
  const bengaliChars = nonWsChars.match(/[\u0980-\u09FF]/g) ?? [];
  const ansiMojibakeChars =
    nonWsChars.match(
      /[\u00A1-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u201A\u201E\u2020\u2021\u2030\u2039\u203A\u2122]/g
    ) ?? [];
  const bijoySignatureMatches =
    substantive.match(/[a-zA-Z][\u2020\u2021\u201E\u00A4\u00A9`^~|]|[†‡„¤©][a-zA-Z`^]/g) ?? [];
  if (
    bengaliChars.length / nonWsChars.length < 0.05 &&
    (ansiMojibakeChars.length / nonWsChars.length > 0.06 || bijoySignatureMatches.length >= 3)
  ) {
    return {
      usable: false,
      cleanedText: normalized,
      substantiveLength: substantive.length,
      reason: 'garbled_encoding',
    };
  }

  // Ensure the page actually contains readable Bengali/English letters or digits (not symbol noise)
  const readableMatches = nonWsChars.match(/[\u0980-\u09FFa-zA-Z0-9]/g) ?? [];
  if (readableMatches.length < Math.max(12, Math.floor(minChars * 0.6))) {
    return {
      usable: false,
      cleanedText: normalized,
      substantiveLength: substantive.length,
      reason: 'garbled_encoding',
    };
  }
  if (readableMatches.length / nonWsChars.length < 0.45) {
    return {
      usable: false,
      cleanedText: normalized,
      substantiveLength: substantive.length,
      reason: 'garbled_encoding',
    };
  }

  // Detect garbled math equations / shattered stacked fractions from Acrobat embedded OCR layers
  // so math pages automatically escalate to high-accuracy Gemini Vision OCR
  if (hasCorruptedMathOcr(normalized)) {
    return {
      usable: false,
      cleanedText: normalized,
      substantiveLength: substantive.length,
      reason: 'garbled_math',
    };
  }

  const formattedText = normalizeExamDocumentFormatting(normalized);
  const finalSubstantiveLength = stripPageMarkersAndHeaders(formattedText).length;

  return {
    usable: true,
    cleanedText: formattedText,
    substantiveLength: finalSubstantiveLength,
  };
}

/**
 * Validates and normalizes Gemini's raw JSON page array against the exact expected
 * page mappings of a single PDF batch.
 * Detects missing pages, duplicate pages, out-of-order pages, and empty/short pages.
 */
export function validateAndNormalizeBatchPages(params: {
  batchIndex: number;
  expectedMappings: PageMapping[];
  rawPages: RawExtractedPageInput[];
  fallbackChapter: string;
  useOcr: boolean;
  batchRequiresOcr: boolean;
  usedFilesApi: boolean;
}): BatchExtractionResult {
  const {
    batchIndex,
    expectedMappings,
    rawPages,
    fallbackChapter,
    useOcr,
    batchRequiresOcr,
    usedFilesApi,
  } = params;

  const expectedByOriginal = new Map<number, PageMapping>();
  const expectedByPdfIndex = new Map<number, PageMapping>();
  for (const m of expectedMappings) {
    expectedByOriginal.set(m.originalPageNumber, m);
    expectedByPdfIndex.set(m.pdfPageIndex, m);
  }

  // Also map 1-based batch-relative index (1..expectedMappings.length) in case the model
  // numbered the split sub-PDF from 1 instead of global pdfPageIndex
  const expectedByRelativeIndex = new Map<number, PageMapping>();
  expectedMappings.forEach((m, idx) => {
    expectedByRelativeIndex.set(idx + 1, m);
  });

  const acceptedByOriginal = new Map<number, NormalizedExtractedPage>();
  const duplicateOriginalPagesSet = new Set<number>();
  const warnings: string[] = [];
  let outOfOrderDetected = false;
  let lastSeenOriginalPage = -Infinity;

  for (const raw of rawPages) {
    const rawOrig =
      typeof raw.originalPageNumber === 'number' && Number.isFinite(raw.originalPageNumber)
        ? Math.round(raw.originalPageNumber)
        : null;
    const rawPdfIdx =
      typeof raw.pdfPageIndex === 'number' && Number.isFinite(raw.pdfPageIndex)
        ? Math.round(raw.pdfPageIndex)
        : null;

    let mapping: PageMapping | undefined;
    if (rawOrig !== null && expectedByOriginal.has(rawOrig)) {
      mapping = expectedByOriginal.get(rawOrig);
    } else if (rawPdfIdx !== null && expectedByPdfIndex.has(rawPdfIdx)) {
      mapping = expectedByPdfIndex.get(rawPdfIdx);
    } else if (rawPdfIdx !== null && expectedByRelativeIndex.has(rawPdfIdx)) {
      mapping = expectedByRelativeIndex.get(rawPdfIdx);
    } else if (rawOrig !== null && expectedByRelativeIndex.has(rawOrig)) {
      mapping = expectedByRelativeIndex.get(rawOrig);
    }

    if (!mapping) {
      warnings.push(
        `Batch ${batchIndex + 1}-এ অপ্রত্যাশিত পৃষ্ঠা নম্বর (${rawOrig ?? rawPdfIdx ?? 'অজানা'}) পাওয়া গেছে এবং বাদ দেওয়া হয়েছে।`
      );
      continue;
    }

    if (mapping.originalPageNumber < lastSeenOriginalPage) {
      outOfOrderDetected = true;
    }
    lastSeenOriginalPage = mapping.originalPageNumber;

    const cleanedContent = normalizeExamDocumentFormatting(
      String(raw.content ?? '').replace(/\r\n/g, '\n').trim()
    );
    const meaningful = isMeaningfulPageContent(cleanedContent);

    if (acceptedByOriginal.has(mapping.originalPageNumber)) {
      duplicateOriginalPagesSet.add(mapping.originalPageNumber);
      // Keep the richer extraction if a duplicate occurred, while still flagging duplicate
      const existing = acceptedByOriginal.get(mapping.originalPageNumber)!;
      if (meaningful && cleanedContent.length > existing.content.length) {
        acceptedByOriginal.set(mapping.originalPageNumber, {
          pdfPageIndex: mapping.pdfPageIndex,
          originalPageNumber: mapping.originalPageNumber,
          chapter: String(raw.chapter ?? '').trim() || existing.chapter || fallbackChapter,
          content: cleanedContent,
          charCount: stripPageMarkersAndHeaders(cleanedContent).length,
          hasReadableText: true,
          ocrUsed: Boolean(useOcr && (raw.ocrUsed || batchRequiresOcr)),
          isShortWarning:
            stripPageMarkersAndHeaders(cleanedContent).length < MIN_PAGE_SUBSTANTIVE_CHARS,
        });
      }
      continue;
    }

    if (!meaningful) {
      warnings.push(
        `পৃষ্ঠা ${toBengaliNumber(mapping.originalPageNumber)}-এ পাঠযোগ্য টেক্সট পাওয়া যায়নি।`
      );
      continue;
    }

    const substantiveLen = stripPageMarkersAndHeaders(cleanedContent).length;
    const isShortWarning = substantiveLen < MIN_PAGE_SUBSTANTIVE_CHARS;
    if (isShortWarning) {
      warnings.push(
        `পৃষ্ঠা ${toBengaliNumber(mapping.originalPageNumber)}-এ খুব কম টেক্সট পাওয়া গেছে (${toBengaliNumber(substantiveLen)} অক্ষর)।`
      );
    }

    acceptedByOriginal.set(mapping.originalPageNumber, {
      pdfPageIndex: mapping.pdfPageIndex,
      originalPageNumber: mapping.originalPageNumber,
      chapter: String(raw.chapter ?? '').trim() || fallbackChapter,
      content: cleanedContent,
      charCount: substantiveLen,
      hasReadableText: true,
      ocrUsed: Boolean(useOcr && (raw.ocrUsed || batchRequiresOcr)),
      isShortWarning,
    });
  }

  const orderedPages = Array.from(acceptedByOriginal.values()).sort(
    (a, b) => a.originalPageNumber - b.originalPageNumber
  );

  const missingOriginalPages = expectedMappings
    .map((m) => m.originalPageNumber)
    .filter((orig) => !acceptedByOriginal.has(orig));

  const duplicateOriginalPages = Array.from(duplicateOriginalPagesSet).sort((a, b) => a - b);

  if (duplicateOriginalPages.length > 0) {
    warnings.push(
      `ডুপ্লিকেট পৃষ্ঠা শনাক্ত ও সমন্বয় করা হয়েছে: পৃষ্ঠা ${duplicateOriginalPages.map(toBengaliNumber).join(', ')}।`
    );
  }
  if (outOfOrderDetected) {
    warnings.push(
      `Batch ${toBengaliNumber(batchIndex + 1)}-এ পৃষ্ঠার ক্রম এলোমেলো ছিল; সঠিক মূল পৃষ্ঠা ক্রমে সাজানো হয়েছে।`
    );
  }

  const ocrUsed = orderedPages.some((p) => p.ocrUsed);

  let status: PdfExtractionStatus;
  if (orderedPages.length === 0) {
    status = 'failed';
  } else if (missingOriginalPages.length > 0) {
    status = 'partial';
  } else {
    status = 'success';
  }

  return {
    batchIndex,
    status,
    expectedMappings,
    pages: orderedPages,
    extractedPageCount: orderedPages.length,
    missingOriginalPages,
    duplicateOriginalPages,
    outOfOrderDetected,
    ocrUsed,
    usedFilesApi,
    warnings,
    ...(status === 'failed'
      ? {
          error: `Batch ${toBengaliNumber(batchIndex + 1)} থেকে কোনো পাঠযোগ্য টেক্সট সংগ্রহ করা যায়নি।`,
        }
      : {}),
  };
}

/**
 * Combines results from one or more PDF batches in strict original page order.
 * Detects out-of-order batches, cross-batch duplicate pages, missing pages, and
 * failed batches — NEVER reporting full `success` if any batch failed or any page is missing.
 */
export function combineBatchExtractions(params: {
  totalExpectedMappings: PageMapping[];
  originalPageRange: string;
  batchResults: BatchExtractionResult[];
  localPages?: NormalizedExtractedPage[];
  fallbackChapter?: string;
}): CombinedExtractionResult {
  const { totalExpectedMappings, originalPageRange, batchResults } = params;
  const localPages = params.localPages ?? [];

  let outOfOrderDetected = false;
  let prevBatchIdx = -1;
  for (const br of batchResults) {
    if (br.batchIndex < prevBatchIdx) {
      outOfOrderDetected = true;
    }
    prevBatchIdx = br.batchIndex;
    if (br.outOfOrderDetected) {
      outOfOrderDetected = true;
    }
  }

  // Sort batch results deterministically by batchIndex before merging
  const sortedBatches = [...batchResults].sort((a, b) => a.batchIndex - b.batchIndex);

  const mergedPages = new Map<number, NormalizedExtractedPage>();
  const duplicatePagesSet = new Set<number>();
  const warnings: string[] = [];

  // Seed with pages extracted directly from embedded PDF text layers (zero Gemini calls)
  for (const page of localPages) {
    if (!mergedPages.has(page.originalPageNumber)) {
      mergedPages.set(page.originalPageNumber, page);
    }
  }

  let completedBatches = 0;
  let failedBatches = 0;
  let anyBatchError: string | undefined;

  for (const batch of sortedBatches) {
    if (batch.status === 'success') {
      completedBatches += 1;
    } else if (batch.status === 'failed') {
      failedBatches += 1;
      if (!anyBatchError && batch.error) {
        anyBatchError = batch.error;
      }
    } else {
      // Partial batch counts as neither fully completed nor fully failed,
      // but it prevents overall status from being 'success'
      if (!anyBatchError && batch.error) {
        anyBatchError = batch.error;
      }
    }

    for (const dup of batch.duplicateOriginalPages) {
      duplicatePagesSet.add(dup);
    }

    for (const warn of batch.warnings) {
      if (!warnings.includes(warn)) {
        warnings.push(warn);
      }
    }

    for (const page of batch.pages) {
      if (mergedPages.has(page.originalPageNumber)) {
        duplicatePagesSet.add(page.originalPageNumber);
        const existing = mergedPages.get(page.originalPageNumber)!;
        if (page.content.length > existing.content.length) {
          mergedPages.set(page.originalPageNumber, page);
        }
      } else {
        mergedPages.set(page.originalPageNumber, page);
      }
    }
  }

  const orderedPages = Array.from(mergedPages.values()).sort(
    (a, b) => a.originalPageNumber - b.originalPageNumber
  );

  const missingOriginalPages = totalExpectedMappings
    .map((m) => m.originalPageNumber)
    .filter((orig) => !mergedPages.has(orig));

  const duplicateOriginalPages = Array.from(duplicatePagesSet).sort((a, b) => a - b);

  const sections: ExtractedSectionItem[] = orderedPages.map((p) => ({
    chapter: p.chapter || params.fallbackChapter || 'অধ্যায় ১',
    pageNumber: p.originalPageNumber,
    pdfPageIndex: p.pdfPageIndex,
    content: p.content,
  }));

  const rawText = sections
    .map((s) => `--- পৃষ্ঠা ${s.pageNumber} ---\n[${s.chapter}]\n${s.content}`)
    .join('\n\n');

  const meaningfulCharCount = stripPageMarkersAndHeaders(rawText).length;
  const hasAnyBatchFailure = sortedBatches.some((b) => b.status === 'failed');
  const hasAnyBatchPartial = sortedBatches.some((b) => b.status === 'partial');

  let extractionStatus: PdfExtractionStatus;
  if (orderedPages.length === 0 || meaningfulCharCount === 0) {
    extractionStatus = 'failed';
  } else if (
    missingOriginalPages.length > 0 ||
    hasAnyBatchFailure ||
    hasAnyBatchPartial ||
    (sortedBatches.length === 0 && localPages.length === 0)
  ) {
    extractionStatus = 'partial';
  } else {
    extractionStatus = 'success';
  }

  // Never claim OCR completed unless OCR actually ran on at least one extracted page
  const ocrCompleted =
    extractionStatus !== 'failed' && orderedPages.some((p) => p.ocrUsed);
  const method: 'text' | 'ocr' = ocrCompleted ? 'ocr' : 'text';

  let error: string | undefined;
  if (extractionStatus === 'failed') {
    error =
      anyBatchError ||
      'PDF থেকে কোনো ব্যবহারযোগ্য টেক্সট বা OCR ফলাফল পাওয়া যায়নি।';
  } else if (extractionStatus === 'partial') {
    const missingLabel =
      missingOriginalPages.length > 0
        ? ` অনুপস্থিত পৃষ্ঠা: ${missingOriginalPages.slice(0, 12).map(toBengaliNumber).join(', ')}${missingOriginalPages.length > 12 ? '...' : ''}।`
        : '';
    error = `আংশিক এক্সট্র্যাকশন সম্পন্ন হয়েছে (${toBengaliNumber(totalExpectedMappings.length)}টি পৃষ্ঠার মধ্যে ${toBengaliNumber(orderedPages.length)}টি পৃষ্ঠা পাওয়া গেছে)।${missingLabel} অসম্পূর্ণ ডকুমেন্ট পূর্ণাঙ্গ হিসেবে সংরক্ষণ করা যাবে না—অনুগ্রহ করে পুনরায় চেষ্টা করুন।`;
  }

  return {
    extractionStatus,
    method,
    ocrCompleted,
    actualPageCount: totalExpectedMappings.length,
    expectedPageCount: totalExpectedMappings.length,
    extractedPageCount: orderedPages.length,
    originalPageRange,
    totalBatches: sortedBatches.length,
    completedBatches,
    failedBatches,
    missingOriginalPages,
    duplicateOriginalPages,
    outOfOrderDetected,
    sections,
    rawText,
    meaningfulCharCount,
    warnings,
    ...(error ? { error } : {}),
  };
}

/**
 * Merges newly recovered pages from a missing-pages-only mini-PDF extraction into an
 * existing partial CombinedExtractionResult without losing any previously extracted pages.
 * Maps sequential mini-PDF pages (1..K) back to their exact original printed page numbers
 * and source PDF internal page indices, then recomputes full save-readiness status.
 */
export function mergePartialExtractionWithRecoveredPages(params: {
  previous: CombinedExtractionResult;
  recovered: CombinedExtractionResult;
  /** Ordered list of missing page targets that were sliced into the mini-PDF (index 0 => mini-PDF page 1). */
  requestedMissingTargets: PageMapping[];
  fallbackChapter?: string;
}): CombinedExtractionResult {
  const { previous, recovered, requestedMissingTargets, fallbackChapter = 'অধ্যায় ১' } = params;

  const mergedByOriginal = new Map<number, ExtractedSectionItem>();

  for (const sec of previous.sections) {
    if (sec.content.trim()) {
      mergedByOriginal.set(sec.pageNumber, sec);
    }
  }

  // Map mini-PDF 1-based page index back to the exact original book page & source PDF index
  const targetByMiniIdx = new Map<number, PageMapping>();
  const targetByOriginal = new Map<number, PageMapping>();
  requestedMissingTargets.forEach((mapping, idx) => {
    targetByMiniIdx.set(idx + 1, mapping);
    targetByOriginal.set(mapping.originalPageNumber, mapping);
  });

  for (const sec of recovered.sections) {
    const cleaned = sec.content.trim();
    if (!cleaned) continue;

    // Prefer exact mini-PDF index mapping (1..K -> requestedMissingTargets[k-1]);
    // fall back to originalPageNumber if caller passed direct original page numbers.
    const mappedTarget =
      targetByMiniIdx.get(sec.pdfPageIndex) ??
      targetByMiniIdx.get(sec.pageNumber) ??
      targetByOriginal.get(sec.pageNumber);

    if (!mappedTarget) continue;

    const existing = mergedByOriginal.get(mappedTarget.originalPageNumber);
    if (!existing || cleaned.length > existing.content.length) {
      mergedByOriginal.set(mappedTarget.originalPageNumber, {
        chapter: sec.chapter.trim() || existing?.chapter || fallbackChapter,
        pageNumber: mappedTarget.originalPageNumber,
        pdfPageIndex: mappedTarget.pdfPageIndex,
        content: cleaned,
      });
    }
  }

  const orderedSections = Array.from(mergedByOriginal.values()).sort(
    (a, b) => a.pageNumber - b.pageNumber
  );

  // Recompute remaining missing pages from previous missing list + any still-unfilled targets
  const remainingMissing = previous.missingOriginalPages
    .filter((orig) => !mergedByOriginal.has(orig))
    .sort((a, b) => a - b);

  const rawText = orderedSections
    .map((s) => `--- পৃষ্ঠা ${s.pageNumber} ---\n[${s.chapter}]\n${s.content}`)
    .join('\n\n');

  const meaningfulCharCount = stripPageMarkersAndHeaders(rawText).length;
  const expectedCount = Math.max(previous.actualPageCount, orderedSections.length);

  let extractionStatus: PdfExtractionStatus;
  if (orderedSections.length === 0 || meaningfulCharCount === 0) {
    extractionStatus = 'failed';
  } else if (remainingMissing.length > 0 || orderedSections.length < expectedCount) {
    extractionStatus = 'partial';
  } else {
    extractionStatus = 'success';
  }

  const ocrCompleted =
    extractionStatus !== 'failed' && (previous.ocrCompleted || recovered.ocrCompleted);
  const method: 'text' | 'ocr' = ocrCompleted ? 'ocr' : 'text';

  let error: string | undefined;
  if (extractionStatus === 'partial') {
    const missingLabel =
      remainingMissing.length > 0
        ? ` অনুপস্থিত পৃষ্ঠা: ${remainingMissing.slice(0, 12).map(toBengaliNumber).join(', ')}${remainingMissing.length > 12 ? '...' : ''}।`
        : '';
    error = `আংশিক এক্সট্র্যাকশন সম্পন্ন হয়েছে (${toBengaliNumber(expectedCount)}টি পৃষ্ঠার মধ্যে ${toBengaliNumber(orderedSections.length)}টি পৃষ্ঠা পাওয়া গেছে)।${missingLabel} অসম্পূর্ণ ডকুমেন্ট পূর্ণাঙ্গ হিসেবে সংরক্ষণ করা যাবে না—বাকি পৃষ্ঠাগুলো সম্পন্ন করুন।`;
  } else if (extractionStatus === 'failed') {
    error =
      recovered.error ||
      previous.error ||
      'PDF থেকে কোনো ব্যবহারযোগ্য টেক্সট পাওয়া যায়নি।';
  }

  const combinedWarnings = Array.from(
    new Set([
      ...(extractionStatus === 'success' ? [] : previous.warnings),
      ...recovered.warnings,
    ])
  );

  return {
    extractionStatus,
    method,
    ocrCompleted,
    actualPageCount: expectedCount,
    expectedPageCount: expectedCount,
    extractedPageCount: orderedSections.length,
    originalPageRange: previous.originalPageRange,
    totalBatches: previous.totalBatches + recovered.totalBatches,
    completedBatches:
      extractionStatus === 'success'
        ? previous.totalBatches + recovered.totalBatches
        : previous.completedBatches + recovered.completedBatches,
    failedBatches: extractionStatus === 'success' ? 0 : recovered.failedBatches,
    missingOriginalPages: remainingMissing,
    duplicateOriginalPages: [],
    outOfOrderDetected: previous.outOfOrderDetected || recovered.outOfOrderDetected,
    sections: orderedSections,
    rawText,
    meaningfulCharCount,
    warnings: combinedWarnings,
    ...(error ? { error } : {}),
  };
}

export interface SaveReadinessExtractionContext {
  status: PdfExtractionStatus;
  actualPageCount: number;
  extractedPageCount: number;
  missingOriginalPages: number[];
  sourceWasUploadedPdf: boolean;
}

/**
 * Validates whether a Book / PDF form submission is genuinely ready to be saved
 * into the Knowledge Base.
 * - Rejects empty or page-range-only placeholder text (e.g., "Page 37-44").
 * - Strips page markers and bracket headers before enforcing >= 20 substantive chars.
 * - Blocks saving partial/failed PDF extractions as complete documents.
 */
export function validateBookSaveReadiness(params: {
  title: string;
  subject: string;
  rawText: string;
  extractionContext?: SaveReadinessExtractionContext | null;
}): BookSaveReadinessResult {
  const title = (params.title ?? '').trim();
  const subject = (params.subject ?? '').trim();
  const rawText = (params.rawText ?? '').trim();

  if (!title) {
    return {
      ok: false,
      error: 'অনুগ্রহ করে বইয়ের নাম লিখুন।',
      meaningfulCharCount: 0,
      computedTotalPages: 0,
    };
  }

  if (!subject) {
    return {
      ok: false,
      error: 'অনুগ্রহ করে বিষয় উল্লেখ করুন।',
      meaningfulCharCount: 0,
      computedTotalPages: 0,
    };
  }

  const ctx = params.extractionContext;
  if (ctx?.sourceWasUploadedPdf) {
    if (ctx.status === 'failed') {
      return {
        ok: false,
        error:
          'PDF এক্সট্র্যাকশন ব্যর্থ হয়েছে এবং কোনো ব্যবহারযোগ্য টেক্সট পাওয়া যায়নি। তাই Knowledge Base-এ সংরক্ষণ করা যাবে না।',
        meaningfulCharCount: 0,
        computedTotalPages: ctx.actualPageCount,
      };
    }

    if (
      ctx.status === 'partial' ||
      ctx.extractedPageCount < ctx.actualPageCount ||
      ctx.missingOriginalPages.length > 0
    ) {
      return {
        ok: false,
        error: `PDF-এর সব পৃষ্ঠা সম্পূর্ণভাবে এক্সট্র্যাক্ট হয়নি (${toBengaliNumber(ctx.actualPageCount)}টির মধ্যে ${toBengaliNumber(ctx.extractedPageCount)}টি পৃষ্ঠা সম্পন্ন)। অসম্পূর্ণ ডকুমেন্ট সংরক্ষণ করা যাবে না—অনুগ্রহ করে পুনরায় এক্সট্র্যাক্ট করুন।`,
        meaningfulCharCount: stripPageMarkersAndHeaders(rawText).length,
        computedTotalPages: ctx.actualPageCount,
      };
    }
  }

  if (!rawText) {
    return {
      ok: false,
      error:
        'সংরক্ষণের জন্য কোনো পাঠ্য নেই। অনুগ্রহ করে একটি PDF/টেক্সট ফাইল আপলোড করুন অথবা কমপক্ষে ২০ অক্ষরের মূল পাঠ্য পেস্ট করুন।',
      meaningfulCharCount: 0,
      computedTotalPages: 0,
    };
  }

  if (isPageRangeOnlyText(rawText)) {
    return {
      ok: false,
      error:
        'শুধুমাত্র পৃষ্ঠা রেঞ্জ বা শিরোনাম (যেমন: "Page 37-44") বইয়ের মূল পাঠ্য হিসেবে সংরক্ষণ করা যাবে না। অনুগ্রহ করে PDF থেকে প্রকৃত টেক্সট এক্সট্র্যাক্ট করুন অথবা মূল বিষয়বস্তু যুক্ত করুন।',
      meaningfulCharCount: 0,
      computedTotalPages: ctx?.actualPageCount ?? 1,
    };
  }

  const substantive = stripPageMarkersAndHeaders(rawText);
  if (substantive.length < MIN_MEANINGFUL_TEXT_CHARS) {
    return {
      ok: false,
      error: `মূল পাঠ্যে কমপক্ষে ${toBengaliNumber(MIN_MEANINGFUL_TEXT_CHARS)} অক্ষরের কার্যকর টেক্সট থাকতে হবে (বর্তমানে ${toBengaliNumber(substantive.length)} অক্ষর)। পৃষ্ঠা নম্বর বা হেডার বাদে প্রকৃত টেক্সট নিশ্চিত করুন।`,
      meaningfulCharCount: substantive.length,
      computedTotalPages: ctx?.actualPageCount ?? 1,
    };
  }

  const computedTotalPages =
    ctx?.sourceWasUploadedPdf && ctx.actualPageCount > 0
      ? ctx.actualPageCount
      : Math.max(1, ctx?.extractedPageCount ?? 1);

  return {
    ok: true,
    meaningfulCharCount: substantive.length,
    computedTotalPages,
  };
}

function normalizeBookKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function simpleDeterministicHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface BookSubmissionDuplicateCandidate {
  title: string;
  subject: string;
  totalPages: number;
  chunks: Array<{ pageNumber: number; content: string }>;
}

/**
 * Computes a deterministic content fingerprint for a book submission so retries
 * or accidental double-clicks do not create duplicate Knowledge Base records.
 */
export function buildBookSubmissionFingerprint(
  candidate: BookSubmissionDuplicateCandidate
): string {
  const normalizedTitle = normalizeBookKeyPart(candidate.title);
  const normalizedSubject = normalizeBookKeyPart(candidate.subject);
  const firstChunkSample = normalizeBookKeyPart(
    candidate.chunks[0]?.content.slice(0, 240) ?? ''
  );
  const lastChunkSample = normalizeBookKeyPart(
    candidate.chunks[candidate.chunks.length - 1]?.content.slice(0, 240) ?? ''
  );
  const pagesSig = candidate.chunks.map((c) => c.pageNumber).join(',');
  const payload = [
    normalizedTitle,
    normalizedSubject,
    String(candidate.totalPages),
    String(candidate.chunks.length),
    pagesSig,
    firstChunkSample,
    lastChunkSample,
  ].join('|');
  return `${normalizedTitle}:${candidate.totalPages}:${simpleDeterministicHash(payload)}`;
}

/**
 * Checks whether an equivalent book with identical title, subject, page count,
 * and chunk content fingerprint already exists in the user's Knowledge Base.
 */
export function findDuplicateBookMatch<
  T extends {
    id: number;
    title: string;
    subject: string;
    totalPages: number;
    chunks: Array<{ pageNumber: number; content: string }>;
  },
>(existingBooks: T[], candidate: BookSubmissionDuplicateCandidate): T | null {
  const targetFp = buildBookSubmissionFingerprint(candidate);
  for (const book of existingBooks) {
    if (buildBookSubmissionFingerprint(book) === targetFp) {
      return book;
    }
  }
  return null;
}

