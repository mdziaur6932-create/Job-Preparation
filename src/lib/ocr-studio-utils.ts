import { normalizeExamDocumentFormatting } from './exam-text-formatter';
import { repairMalformedJsonString } from './pdf-rules';
import type { SmartReaderViewUnit } from './reader-page-grouper';

export interface NormalizedCropRect {
  /** Normalized left edge (0..1) */
  x: number;
  /** Normalized top edge (0..1) */
  y: number;
  /** Normalized width (0..1) */
  width: number;
  /** Normalized height (0..1) */
  height: number;
}

export interface PixelCropBox {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  destWidth: number;
  destHeight: number;
}

export interface OcrExtractedSectionInput {
  chapter?: string;
  pageNumber?: number;
  content?: string;
}

const MIN_CROP_DIMENSION_RATIO = 0.02;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Normalizes a drag rectangle (in any drag direction) into clamped `[0..1]` coordinates.
 * Returns `null` if the dragged box is too tiny (accidental single click).
 */
export function normalizeCropRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): NormalizedCropRect | null {
  const x1 = clamp01(startX);
  const y1 = clamp01(startY);
  const x2 = clamp01(endX);
  const y2 = clamp01(endY);

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  if (width < MIN_CROP_DIMENSION_RATIO || height < MIN_CROP_DIMENSION_RATIO) {
    return null;
  }

  return {
    x: left,
    y: top,
    width: Math.min(width, 1 - left),
    height: Math.min(height, 1 - top),
  };
}

/**
 * Converts a normalized crop rectangle (or full image when `rect` is null) into exact
 * source pixel bounds and scaled target dimensions capped at `maxOutputWidth` px.
 */
export function computePixelCropBox(
  rect: NormalizedCropRect | null,
  naturalWidth: number,
  naturalHeight: number,
  maxOutputWidth = 440
): PixelCropBox | null {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth < 4 ||
    naturalHeight < 4
  ) {
    return null;
  }

  const activeRect: NormalizedCropRect = rect ?? {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };

  const sx = Math.max(0, Math.round(activeRect.x * naturalWidth));
  const sy = Math.max(0, Math.round(activeRect.y * naturalHeight));
  const sw = Math.max(
    1,
    Math.min(naturalWidth - sx, Math.round(activeRect.width * naturalWidth))
  );
  const sh = Math.max(
    1,
    Math.min(naturalHeight - sy, Math.round(activeRect.height * naturalHeight))
  );

  const safeMaxWidth = Math.max(120, Math.round(maxOutputWidth));
  const scale = sw > safeMaxWidth ? safeMaxWidth / sw : 1;
  const destWidth = Math.max(1, Math.round(sw * scale));
  const destHeight = Math.max(1, Math.round(sh * scale));

  return { sx, sy, sw, sh, destWidth, destHeight };
}

/**
 * Builds the canonical inline Markdown figure snippet understood by Smart Reader,
 * Word (.docx) export, and A4 PDF export.
 */
export function buildFigureMarkdownSnippet(
  dataUrl: string,
  caption = 'প্রশ্নের চিত্র'
): string {
  const safeCaption =
    caption
      .replace(/[\[\]\r\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'প্রশ্নের চিত্র';
  const cleanUrl = dataUrl.trim();
  if (!/^data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/.test(cleanUrl)) {
    throw new Error('অবৈধ ছবির ডেটা ফরম্যাট পাওয়া গেছে।');
  }
  return `![${safeCaption}](${cleanUrl})`;
}

/**
 * Inserts a snippet (such as a cropped diagram image or newly OCR'd block) into
 * existing editor text cleanly with newline boundaries so block parsers never glue lines.
 */
export function insertBlockSnippetIntoText(
  source: string,
  snippet: string,
  selectionStart?: number,
  selectionEnd?: number
): { nextText: string; nextCursorPos: number } {
  const cleanSnippet = snippet.trim();
  if (!cleanSnippet) {
    return {
      nextText: source,
      nextCursorPos:
        typeof selectionEnd === 'number' ? selectionEnd : source.length,
    };
  }

  if (!source.trim()) {
    return {
      nextText: cleanSnippet,
      nextCursorPos: cleanSnippet.length,
    };
  }

  const start =
    typeof selectionStart === 'number'
      ? Math.max(0, Math.min(source.length, selectionStart))
      : source.length;
  const end =
    typeof selectionEnd === 'number'
      ? Math.max(start, Math.min(source.length, selectionEnd))
      : start;

  const before = source.slice(0, start);
  const after = source.slice(end);

  const leadingBreak =
    before.length === 0 ? '' : before.endsWith('\n') ? '' : '\n';
  const trailingBreak =
    after.length === 0 ? '\n' : after.startsWith('\n') ? '' : '\n';

  const inserted = `${leadingBreak}${cleanSnippet}${trailingBreak}`;
  const nextText = `${before}${inserted}${after}`;
  const nextCursorPos = before.length + inserted.length;

  return { nextText, nextCursorPos };
}

/**
 * Merges extracted OCR sections returned by `/api/ai/extract-pdf` into clean,
 * normalized exam/study text ready for immediate editing and A4 rendering.
 */
export function mergeOcrStudioSections(
  sections: OcrExtractedSectionInput[] | undefined,
  fallbackRawText = ''
): string {
  const validSections = (Array.isArray(sections) ? sections : [])
    .map((s) => ({
      pageNumber: Number(s.pageNumber || 1),
      content: String(s.content ?? '').trim(),
    }))
    .filter((s) => s.content.length > 0);

  if (validSections.length === 0) {
    const fallback = fallbackRawText.trim();
    return fallback ? normalizeExamDocumentFormatting(fallback) : '';
  }

  const joined = validSections.map((s) => s.content).join('\n\n');
  return normalizeExamDocumentFormatting(joined);
}

export interface DetectedOcrDiagram {
  id: string;
  label: string;
  /** Gemini normalized 0..1000 bounding box: [ymin, xmin, ymax, xmax] */
  box_2d: [number, number, number, number];
}

export interface ParsedOcrStudioOutput {
  content: string;
  diagrams: DetectedOcrDiagram[];
}

/**
 * Converts Gemini's normalized 0..1000 [ymin, xmin, ymax, xmax] diagram box
 * into a 0..1 NormalizedCropRect with gentle margin padding so borders are never clipped.
 */
export function convertGeminiBox2dToNormalizedCropRect(
  box2d: readonly number[],
  padRatio = 0.012
): NormalizedCropRect | null {
  if (!Array.isArray(box2d) || box2d.length !== 4) return null;
  const [rawYmin, rawXmin, rawYmax, rawXmax] = box2d.map((n) => Number(n));
  if (
    !Number.isFinite(rawYmin) ||
    !Number.isFinite(rawXmin) ||
    !Number.isFinite(rawYmax) ||
    !Number.isFinite(rawXmax)
  ) {
    return null;
  }

  // Support both 0..1000 (standard Gemini box_2d) and 0..1 coordinates defensively
  const maxCoord = Math.max(rawYmin, rawXmin, rawYmax, rawXmax);
  const scale = maxCoord > 1.05 ? 1000 : 1;

  const y1 = Math.max(0, Math.min(1, Math.min(rawYmin, rawYmax) / scale));
  const y2 = Math.max(0, Math.min(1, Math.max(rawYmin, rawYmax) / scale));
  const x1 = Math.max(0, Math.min(1, Math.min(rawXmin, rawXmax) / scale));
  const x2 = Math.max(0, Math.min(1, Math.max(rawXmin, rawXmax) / scale));

  const rawWidth = x2 - x1;
  const rawHeight = y2 - y1;
  if (rawWidth < MIN_CROP_DIMENSION_RATIO || rawHeight < MIN_CROP_DIMENSION_RATIO) {
    return null;
  }
  // Ignore degenerate full-page bounding boxes (model accidentally boxed the entire page)
  if (rawWidth > 0.94 && rawHeight > 0.94) {
    return null;
  }

  const px = Math.max(0, Math.min(0.05, padRatio));
  const x = Math.max(0, x1 - px);
  const y = Math.max(0, y1 - px);
  const right = Math.min(1, x2 + px);
  const bottom = Math.min(1, y2 + px);

  return {
    x,
    y,
    width: Math.max(MIN_CROP_DIMENSION_RATIO, right - x),
    height: Math.max(MIN_CROP_DIMENSION_RATIO, bottom - y),
  };
}

function sanitizeDetectedDiagrams(rawDiagrams: unknown): DetectedOcrDiagram[] {
  if (!Array.isArray(rawDiagrams)) return [];
  const results: DetectedOcrDiagram[] = [];
  for (let i = 0; i < rawDiagrams.length; i += 1) {
    const entry = rawDiagrams[i];
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const rawBox = obj.box_2d;
    if (!Array.isArray(rawBox) || rawBox.length !== 4) continue;
    const nums = rawBox.map((v) => Number(v));
    if (nums.some((n) => !Number.isFinite(n))) continue;
    // Validate box produces a real non-full-page crop rect
    if (!convertGeminiBox2dToNormalizedCropRect(nums)) continue;

    const id =
      String(obj.id || `DIAGRAM_${results.length + 1}`)
        .trim()
        .replace(/[^A-Za-z0-9_-]/g, '') || `DIAGRAM_${results.length + 1}`;
    const label =
      String(obj.label || 'প্রশ্নের চিত্র').trim().slice(0, 120) || 'প্রশ্নের চিত্র';

    results.push({
      id,
      label,
      box_2d: [nums[0], nums[1], nums[2], nums[3]],
    });
  }
  return results;
}

/**
 * Parses either structured JSON (`{ content, diagrams }`) or plain-text OCR output
 * from `/api/ai/ocr-studio`, safely recovering malformed JSON math backslashes.
 */
export function parseOcrStudioStructuredOutput(
  rawResponseText: string
): ParsedOcrStudioOutput {
  let trimmed = String(rawResponseText || '').replace(/\r\n?/g, '\n').trim();
  if (!trimmed) {
    return { content: '', diagrams: [] };
  }

  const fenceMatch = trimmed.match(/^```(?:json|markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  }

  // Try structured JSON parsing first (with malformed-backslash repair fallback)
  if (trimmed.startsWith('{') || trimmed.includes('"content"')) {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    const candidateJson =
      firstBrace >= 0 && lastBrace > firstBrace
        ? trimmed.slice(firstBrace, lastBrace + 1)
        : trimmed;

    for (const attempt of [candidateJson, repairMalformedJsonString(candidateJson)]) {
      try {
        const parsed = JSON.parse(attempt) as {
          content?: unknown;
          text?: unknown;
          diagrams?: unknown;
          pages?: Array<{ content?: unknown }>;
        };
        if (parsed && typeof parsed === 'object') {
          let content = '';
          if (typeof parsed.content === 'string') {
            content = parsed.content.trim();
          } else if (typeof parsed.text === 'string') {
            content = parsed.text.trim();
          } else if (Array.isArray(parsed.pages)) {
            content = parsed.pages
              .map((p) => String(p?.content ?? '').trim())
              .filter(Boolean)
              .join('\n\n');
          }
          if (content) {
            return {
              content,
              diagrams: sanitizeDetectedDiagrams(parsed.diagrams),
            };
          }
        }
      } catch {
        // Try next recovery pass
      }
    }

    // Salvage truncated JSON `"content": "..."` string if model hit token limit mid-JSON
    const contentKeyMatch = trimmed.match(/"content"\s*:\s*"([\s\S]*)/);
    if (contentKeyMatch) {
      let salvaged = contentKeyMatch[1];
      const endQuote = salvaged.search(/(?<!\\)"\s*(?:,\s*"diagrams"|\})/);
      if (endQuote >= 0) {
        salvaged = salvaged.slice(0, endQuote);
      }
      salvaged = salvaged
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
      if (salvaged.length >= 10) {
        return { content: salvaged, diagrams: [] };
      }
    }
  }

  // Plain-text / Markdown output directly
  return {
    content: trimmed,
    diagrams: [],
  };
}

/**
 * Replaces `[[DIAGRAM_1]]` markers (or `[চিত্র: ...]` placeholders) inside OCR text
 * with embedded Markdown figure lines (`![label](data:image/jpeg;base64,...)`).
 */
export function replaceDiagramMarkersWithEmbeddedFigures(
  text: string,
  resolvedFigures: Array<{ id: string; label: string; dataUrl: string }>
): string {
  if (!text.trim() || resolvedFigures.length === 0) return text;
  let updated = text;
  const unplaced: string[] = [];

  for (const fig of resolvedFigures) {
    const md = buildFigureMarkdownSnippet(fig.dataUrl, fig.label);
    const escapedId = fig.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markerRegex = new RegExp(`\\[\\[?\\s*${escapedId}\\s*\\]?\\]`, 'gi');
    if (markerRegex.test(updated)) {
      updated = updated.replace(markerRegex, `\n${md}\n`);
    } else if (/\[চিত্র\s*:[^\]]*\]/.test(updated)) {
      updated = updated.replace(/\[চিত্র\s*:[^\]]*\]/, `\n${md}\n`);
    } else {
      unplaced.push(md);
    }
  }

  if (unplaced.length > 0) {
    updated = `${updated.trimEnd()}\n\n${unplaced.join('\n\n')}`;
  }

  return updated.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Wraps the current OCR Studio text into a canonical `SmartReaderViewUnit`
 * so the exact same Word (.docx) and A4 PDF exporters used by Smart Reader work seamlessly.
 */
export function buildOcrStudioExportUnit(
  content: string,
  title = 'OCR Studio প্রশ্নপত্র'
): SmartReaderViewUnit {
  const cleanTitle = title.trim() || 'OCR Studio প্রশ্নপত্র';
  return {
    id: 'ocr-studio-document',
    kind: 'exam',
    title: cleanTitle,
    chapter: cleanTitle,
    bookTitle: cleanTitle,
    startPage: 1,
    endPage: 1,
    pageLabel: 'OCR Studio',
    content,
    sourceChunks: [],
    questionCount: 0,
  };
}
