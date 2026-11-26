import { PDFDocument } from 'pdf-lib';
import {
  parseExamDocumentForDisplay,
  type ParsedExamDisplayLine,
  type ParsedExamDocument,
} from './exam-text-formatter';
import {
  formatMathForPlainText,
  parseMathRichTokens,
  type MathRichToken,
} from './exam-math-and-answer-guard';
import {
  buildStructuredExamJsonFromText,
  type OcrRefinedExamPaperJson,
} from './ocr-refiner-agent';
import {
  EXAM_BN_FONT_SIZE_PT,
  EXAM_EN_FONT_SIZE_PT,
  EXAM_HEADER_FONT_SIZE_PT,
  EXAM_HEADER_FONT_STACK,
  SOLAIMAN_LIPI_FONT_STACK,
  TIMES_NEW_ROMAN_FONT_STACK,
  ptToCanvasPx,
  splitMixedScriptSegments,
} from './exam-typography';
import {
  EDITORIAL_1COL_OPTION_MAX_CHARS,
  EDITORIAL_2COL_OPTION_MAX_CHARS,
  groupDisplayItemsWithOptionBlocks,
  isExamSubjectHeadingLine,
  parseStructuredExamHeader,
} from './exam-option-layout';
import {
  isMcqExamDocument,
  MCQ_PAGE_MAKEUP_SPEC,
  type McqEnhancedDisplayBlock,
} from './mcq-page-makeup-spec';
import {
  clusterExamBlocksByQuestion,
  estimateMcqClusterWordMetricsPt,
  optimizeMcqAdaptivePagination,
} from './mcq-adaptive-pagination';
import {
  formatMarkdownTableAsPlainText,
  parseInlineRichText,
  serializeMarkdownTable,
  splitTextBlocksWithTables,
  stripInlineRichMarkup,
  type ParsedMarkdownTable,
} from './rich-text-and-table-parser';
import type { SmartReaderViewUnit } from './reader-page-grouper';

export type ExamNumberingStyle = 'original' | 'english' | 'bengali';

export interface ExamExportOptions {
  bookTitle: string;
  numberingStyle: ExamNumberingStyle;
  includeHeader: boolean;
  includeSolutions: boolean;
  /** 1 = Clean A4 single-column, 2 = Original 2-column printed exam paper */
  layoutColumns?: 1 | 2;
  /** Distribute word spacing across wrapped lines for clean justified exam typography. Default: true. */
  justifyText?: boolean;
}

const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

function toBengaliNumber(num: number, padTwoDigits = true): string {
  const raw = padTwoDigits && num < 10 ? `0${num}` : String(num);
  return raw.replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)] ?? d);
}

function formatQuestionNumberLabel(
  originalLabel: string,
  seqIndex: number,
  parsedNumber: number,
  style: ExamNumberingStyle
): string {
  if (style === 'original') return originalLabel;
  const effectiveNum = parsedNumber > 0 ? parsedNumber : seqIndex;
  if (style === 'english') {
    return `${effectiveNum < 10 ? `0${effectiveNum}` : String(effectiveNum)}.`;
  }
  return `${toBengaliNumber(effectiveNum, true)}।`;
}

function stripInlineAnswerForPractice(text: string): string {
  return text
    .replace(/\s*(?:Answer|Ans|উত্তর)\s*[:ঃ]\s*[^|]+$/i, '')
    .trim();
}

/**
 * Applies export formatting settings (numbering style, header toggle, solution toggle)
 * to a parsed exam paper so live preview, `.txt` export, and `.pdf` export stay 100% consistent.
 */
export function applyExamExportOptionsToDocument(
  content: string,
  options: Pick<ExamExportOptions, 'numberingStyle' | 'includeHeader' | 'includeSolutions'>
): ParsedExamDocument {
  const base = parseExamDocumentForDisplay(content);
  if (!base.isExam) {
    return base;
  }

  const headerLines = options.includeHeader ? base.headerLines : [];
  const nextBody: ParsedExamDisplayLine[] = [];
  let qCounter = 0;
  let skippingSolutionBlock = false;

  for (const item of base.bodyItems) {
    if (item.kind === 'question') {
      skippingSolutionBlock = false;
      qCounter += 1;
      const numberLabel = formatQuestionNumberLabel(
        item.numberLabel,
        qCounter,
        item.questionNumber,
        options.numberingStyle
      );
      nextBody.push({
        kind: 'question',
        numberLabel,
        questionNumber: item.questionNumber || qCounter,
        text: item.text,
      });
      continue;
    }

    if (item.kind === 'ai_badge') {
      if (!options.includeSolutions) {
        skippingSolutionBlock = true;
        continue;
      }
      skippingSolutionBlock = false;
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'reference') {
      if (!options.includeSolutions) {
        continue;
      }
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'solution') {
      if (!options.includeSolutions) {
        skippingSolutionBlock = true;
        continue;
      }
      skippingSolutionBlock = false;
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'explanation') {
      if (!options.includeSolutions) {
        skippingSolutionBlock = true;
        continue;
      }
      skippingSolutionBlock = false;
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'math') {
      if (!options.includeSolutions && skippingSolutionBlock) {
        continue;
      }
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'option') {
      skippingSolutionBlock = false;
      nextBody.push({
        kind: 'option',
        marker: item.marker,
        text: options.includeSolutions
          ? item.text
          : stripInlineAnswerForPractice(item.text),
      });
      continue;
    }

    if (item.kind === 'highlight') {
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'center_block') {
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'diagram' || item.kind === 'image') {
      if (!options.includeSolutions && skippingSolutionBlock) {
        continue;
      }
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'table') {
      if (!options.includeSolutions && skippingSolutionBlock) {
        continue;
      }
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'text') {
      if (isExamSubjectHeadingLine(item.text)) {
        skippingSolutionBlock = false;
        nextBody.push(item);
        continue;
      }
      if (!options.includeSolutions && skippingSolutionBlock) {
        continue;
      }
      nextBody.push(item);
      continue;
    }

    if (item.kind === 'spacer') {
      if (nextBody.length > 0 && nextBody[nextBody.length - 1].kind !== 'spacer') {
        nextBody.push(item);
      }
    }
  }

  // Reconstruct canonical formatted string from the transformed structure
  const serialized: string[] = [];
  if (headerLines.length > 0) {
    serialized.push(...headerLines);
    serialized.push('');
  }
  for (const item of nextBody) {
    switch (item.kind) {
      case 'spacer':
        serialized.push('');
        break;
      case 'question':
        serialized.push(`${item.numberLabel} ${item.text}`);
        break;
      case 'option':
        serialized.push(`    ${item.marker} ${item.text}`);
        break;
      case 'ai_badge':
        serialized.push('[AI দ্বারা তৈরি উত্তর]');
        break;
      case 'reference':
        serialized.push(`${item.label}: ${item.text}`);
        break;
      case 'highlight':
        serialized.push(`[হাইলাইট: ${item.text}]`);
        break;
      case 'solution':
        serialized.push(`${item.label}: ${item.text}`);
        break;
      case 'explanation':
        serialized.push(`${item.label}: ${item.text}`);
        break;
      case 'math':
        serialized.push(`    ${item.text}`);
        break;
      case 'center_block':
        serialized.push('<center>', ...item.lines, '</center>');
        break;
      case 'diagram':
        serialized.push(`[চিত্র: ${item.caption}]`);
        break;
      case 'image':
        serialized.push(`![${item.alt}](${item.src})`);
        break;
      case 'table':
        serialized.push(
          serializeMarkdownTable({
            headers: item.headers,
            alignments: item.alignments,
            rows: item.rows,
          })
        );
        break;
      case 'text':
        serialized.push(item.indented ? `    ${item.text}` : item.text);
        break;
    }
  }

  return {
    formatted: serialized.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    isExam: true,
    headerLines,
    bodyItems: nextBody,
  };
}

/**
 * Exports one or more OCR-processed exam papers into a clean, publication-formatted UTF-8 text file.
 */
export function formatExamPapersAsText(
  units: SmartReaderViewUnit[],
  options: ExamExportOptions
): string {
  const divider = '================================================================';
  const blocks: string[] = [];

  for (let idx = 0; idx < units.length; idx += 1) {
    const unit = units[idx];
    const parsed = applyExamExportOptionsToDocument(unit.content, options);
    const lines: string[] = [];

    if (!parsed.isExam) {
      if (options.includeHeader) {
        lines.push(divider);
        lines.push(`${unit.title} (${unit.pageLabel})`);
        lines.push(divider);
        lines.push('');
      }
      lines.push(parsed.formatted);
    } else {
      if (options.includeHeader) {
        lines.push(divider);
        if (parsed.headerLines.length > 0) {
          for (const h of parsed.headerLines) {
            lines.push(h);
          }
        } else {
          lines.push(unit.title);
        }
        lines.push(`${options.bookTitle} | ${unit.pageLabel}`);
        lines.push(divider);
        lines.push('');
      }

      for (const item of parsed.bodyItems) {
        switch (item.kind) {
          case 'spacer':
            if (lines.length > 0 && lines[lines.length - 1] !== '') {
              lines.push('');
            }
            break;
          case 'question':
            if (lines.length > 0 && lines[lines.length - 1] !== '') {
              lines.push('');
            }
            lines.push(
              `${item.numberLabel} ${stripInlineRichMarkup(formatMathForPlainText(item.text))}`
            );
            break;
          case 'option':
            lines.push(
              `    ${item.marker} ${stripInlineRichMarkup(formatMathForPlainText(item.text))}`
            );
            break;
          case 'ai_badge':
            lines.push(`    [AI দ্বারা তৈরি উত্তর]`);
            break;
          case 'reference':
            lines.push(`    ${item.label}: ${item.text}`);
            break;
          case 'highlight':
            lines.push(
              `    [হাইলাইট: ${stripInlineRichMarkup(formatMathForPlainText(item.text))}]`
            );
            break;
          case 'solution':
            lines.push(
              `    ${item.label}: ${stripInlineRichMarkup(formatMathForPlainText(item.text))}`
            );
            break;
          case 'explanation':
            lines.push(
              `    ${item.label}: ${stripInlineRichMarkup(formatMathForPlainText(item.text))}`
            );
            break;
          case 'math':
            lines.push(`    ${stripInlineRichMarkup(formatMathForPlainText(item.text))}`);
            break;
          case 'center_block':
            if (lines.length > 0 && lines[lines.length - 1] !== '') {
              lines.push('');
            }
            for (const cLine of item.lines) {
              lines.push(stripInlineRichMarkup(formatMathForPlainText(cLine)));
            }
            lines.push('');
            break;
          case 'diagram':
            lines.push(
              `    [চিত্র: ${stripInlineRichMarkup(formatMathForPlainText(item.caption))}]`
            );
            break;
          case 'image':
            lines.push(`    [চিত্র: ${item.alt || 'প্রশ্নের চিত্র'}]`);
            break;
          case 'table':
            lines.push(
              formatMarkdownTableAsPlainText({
                headers: item.headers,
                alignments: item.alignments,
                rows: item.rows,
              })
            );
            break;
          case 'text':
            lines.push(
              item.indented
                ? `    ${stripInlineRichMarkup(formatMathForPlainText(item.text))}`
                : stripInlineRichMarkup(formatMathForPlainText(item.text))
            );
            break;
        }
      }
    }

    blocks.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
  }

  return blocks.filter(Boolean).join('\n\n\n') + '\n';
}

/**
 * Exports one or more OCR-processed exam papers as clean, schema-versioned
 * Structured JSON preserving numbering, LaTeX math, separated bold answers,
 * and red-lined highlights.
 */
export function formatExamPapersAsJson(
  units: SmartReaderViewUnit[],
  options: ExamExportOptions
): string {
  const papers: Array<
    OcrRefinedExamPaperJson & {
      sourceBookTitle: string;
      pageLabel: string;
    }
  > = units.map((unit) => {
    const transformed = applyExamExportOptionsToDocument(unit.content, options);
    const structured = buildStructuredExamJsonFromText(
      transformed.formatted,
      unit.title
    );
    return {
      ...structured,
      sourceBookTitle: options.bookTitle,
      pageLabel: unit.pageLabel,
    };
  });

  const payload =
    papers.length === 1
      ? papers[0]
      : {
          schemaVersion: '1.0' as const,
          bookTitle: options.bookTitle,
          exportedCount: papers.length,
          examPapers: papers,
        };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Generates a clean, filesystem-safe filename preserving Bengali and Latin letters.
 */
export function buildSafeExportFilename(
  baseName: string,
  extension: 'pdf' | 'txt' | 'json' | 'docx'
): string {
  const cleaned = (baseName || 'exam-paper')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return `${cleaned || 'exam-paper'}.${extension}`;
}

// ---------------------------------------------------------------------------
// Structured A4 PDF Renderer (Native Browser Bengali Shaping + pdf-lib A4 PDF)
// ---------------------------------------------------------------------------

const A4_PT_WIDTH = 595.28;
const A4_PT_HEIGHT = 841.89;
// 150 DPI A4 canvas for razor-sharp Bengali conjuncts & print-ready output
// Narrow Margin = 0.5 inch (12.7 mm) => exact 75 px at 150 DPI
const CANVAS_W = 1240;
const CANVAS_H = 1754;
const MARGIN_X = 75;
const MARGIN_TOP = 84;
const MARGIN_BOTTOM = 75;
const CONTENT_W = CANVAS_W - MARGIN_X * 2;
const TWO_COL_GAP = 44;
const FONT_STACK = EXAM_HEADER_FONT_STACK;
const PDF_HEADER_PX = ptToCanvasPx(EXAM_HEADER_FONT_SIZE_PT); // 18pt -> 38px at 150 DPI
const PDF_BN_PX = ptToCanvasPx(EXAM_BN_FONT_SIZE_PT); // 11pt -> 23px at 150 DPI
const PDF_EN_PX = ptToCanvasPx(EXAM_EN_FONT_SIZE_PT); // 12pt -> 25px at 150 DPI

interface MixedCanvasAtom {
  text: string;
  script: 'bn' | 'en';
  width: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

function getCanvasFontForScript(
  script: 'bn' | 'en',
  fontWeight: number,
  italic = false,
  fontSizeScale = 1
): string {
  const stylePrefix = italic ? 'italic ' : '';
  const sizePx = Math.round(
    (script === 'en' ? PDF_EN_PX : PDF_BN_PX) * fontSizeScale
  );
  return script === 'en'
    ? `${stylePrefix}${fontWeight} ${sizePx}px ${TIMES_NEW_ROMAN_FONT_STACK}`
    : `${stylePrefix}${fontWeight} ${sizePx}px ${SOLAIMAN_LIPI_FONT_STACK}`;
}

function wrapMixedScriptCanvasLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontWeight: number,
  fontSizeScale = 1
): MixedCanvasAtom[][] {
  const richSpans = parseInlineRichText(text);
  const atoms: MixedCanvasAtom[] = [];

  for (const span of richSpans) {
    const effectiveWeight = span.bold ? Math.max(fontWeight, 700) : fontWeight;
    const segments = splitMixedScriptSegments(span.text);
    for (const seg of segments) {
      ctx.font = getCanvasFontForScript(
        seg.script,
        effectiveWeight,
        span.italic,
        fontSizeScale
      );
      const parts = seg.text.split(/(\s+)/).filter((p) => p.length > 0);
      for (const part of parts) {
        const w = ctx.measureText(part).width;
        if (w > maxWidth && !/^\s+$/.test(part)) {
          // Break overly long single tokens cleanly inside narrow table cells
          let chunk = '';
          for (const ch of Array.from(part)) {
            if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
              atoms.push({
                text: chunk,
                script: seg.script,
                width: ctx.measureText(chunk).width,
                bold: span.bold,
                italic: span.italic,
                underline: span.underline,
              });
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          if (chunk) {
            atoms.push({
              text: chunk,
              script: seg.script,
              width: ctx.measureText(chunk).width,
              bold: span.bold,
              italic: span.italic,
              underline: span.underline,
            });
          }
        } else {
          atoms.push({
            text: part,
            script: seg.script,
            width: w,
            bold: span.bold,
            italic: span.italic,
            underline: span.underline,
          });
        }
      }
    }
  }

  const lines: MixedCanvasAtom[][] = [];
  let current: MixedCanvasAtom[] = [];
  let currentWidth = 0;

  for (const atom of atoms) {
    if (/^\s+$/.test(atom.text) && current.length === 0) continue;
    if (current.length > 0 && currentWidth + atom.width > maxWidth) {
      lines.push(current);
      current = [];
      currentWidth = 0;
      if (/^\s+$/.test(atom.text)) continue;
    }
    current.push(atom);
    currentWidth += atom.width;
  }

  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [[]];
}

function drawMixedScriptCanvasLine(
  ctx: CanvasRenderingContext2D,
  line: MixedCanvasAtom[],
  startX: number,
  topY: number,
  fontWeight: number,
  color: string,
  fontSizeScale = 1,
  justifyTargetWidth?: number
) {
  // Trim trailing whitespace atoms so justification reaches exact right edge
  let endIdx = line.length;
  while (endIdx > 0 && /^\s+$/.test(line[endIdx - 1].text)) {
    endIdx -= 1;
  }
  const visibleAtoms = line.slice(0, endIdx);

  let extraSpacePerGap = 0;
  if (justifyTargetWidth && justifyTargetWidth > 0 && visibleAtoms.length >= 3) {
    const gapIndices: number[] = [];
    let naturalWidth = 0;
    for (let i = 0; i < visibleAtoms.length; i += 1) {
      naturalWidth += visibleAtoms[i].width;
      if (/^\s+$/.test(visibleAtoms[i].text) && i > 0 && i < visibleAtoms.length - 1) {
        gapIndices.push(i);
      }
    }
    const slack = justifyTargetWidth - naturalWidth;
    // Only justify when slack is natural (avoid over-stretching short lines)
    if (gapIndices.length >= 1 && slack > 1 && slack <= justifyTargetWidth * 0.34) {
      extraSpacePerGap = Math.min(18, slack / gapIndices.length);
    }
  }

  let cursorX = startX;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;

  for (let i = 0; i < visibleAtoms.length; i += 1) {
    const atom = visibleAtoms[i];
    const effectiveWeight = atom.bold ? Math.max(fontWeight, 700) : fontWeight;
    ctx.font = getCanvasFontForScript(
      atom.script,
      effectiveWeight,
      atom.italic,
      fontSizeScale
    );
    const yOffset = atom.script === 'en' ? -1 : 0;
    ctx.fillText(atom.text, cursorX, topY + yOffset);
    if (atom.underline && atom.text.trim().length > 0) {
      const underlineY =
        topY + Math.round((atom.script === 'en' ? PDF_EN_PX : PDF_BN_PX) * fontSizeScale) + 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cursorX, underlineY);
      ctx.lineTo(cursorX + atom.width, underlineY);
      ctx.stroke();
    }
    const isJustifyGap =
      extraSpacePerGap > 0 &&
      /^\s+$/.test(atom.text) &&
      i > 0 &&
      i < visibleAtoms.length - 1;
    cursorX += atom.width + (isJustifyGap ? extraSpacePerGap : 0);
  }
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
      }
      // If a single long token exceeds maxWidth, break safely by characters
      if (ctx.measureText(word).width > maxWidth) {
        let chunk = '';
        for (const ch of Array.from(word)) {
          if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }

  if (current) {
    lines.push(current);
  }
  return lines;
}

interface RichInlinePiece {
  token: MathRichToken;
  width: number;
}

interface RichVisualLine {
  pieces: RichInlinePiece[];
  hasFraction: boolean;
}

function hasRichMathNotation(text: string): boolean {
  return /\\(?:d|t)?frac\{|\\sqrt\{|\[\[frac:|\^|(?<![_\s])_(?!_)|\$[^$\n]+\$|\\(?:times|div|therefore|Rightarrow|pm|le|ge|neq|pi)\b/.test(
    text
  );
}

function measureRichTokenWidth(
  ctx: CanvasRenderingContext2D,
  token: MathRichToken,
  fontWeight: number,
  fontSize: number
): number {
  if (token.kind === 'text') {
    ctx.font = `${fontWeight} ${fontSize}px ${FONT_STACK}`;
    return ctx.measureText(token.value).width;
  }
  if (token.kind === 'sup' || token.kind === 'sub') {
    const scriptSize = Math.max(12, Math.round(fontSize * 0.68));
    ctx.font = `600 ${scriptSize}px ${FONT_STACK}`;
    return ctx.measureText(token.value).width + 2;
  }
  if (token.kind === 'sqrt') {
    ctx.font = `${fontWeight} ${fontSize}px ${FONT_STACK}`;
    const radW = ctx.measureText('√').width;
    const innerW = ctx.measureText(formatMathForPlainText(token.value)).width;
    return radW + innerW + 10;
  }
  const fracSize = Math.max(13, Math.round(fontSize * 0.78));
  ctx.font = `${fontWeight} ${fracSize}px ${FONT_STACK}`;
  const numW = ctx.measureText(formatMathForPlainText(token.num)).width;
  const denW = ctx.measureText(formatMathForPlainText(token.den)).width;
  return Math.max(numW, denW) + 20;
}

function wrapRichMathLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontWeight: number,
  fontSize: number
): RichVisualLine[] {
  const rawTokens = parseMathRichTokens(text);
  const atoms: MathRichToken[] = [];

  for (const tok of rawTokens) {
    if (tok.kind !== 'text') {
      atoms.push(tok);
      continue;
    }
    // Split text tokens into word/space atoms so lines wrap cleanly around fractions
    const parts = tok.value.split(/(\s+)/).filter((p) => p.length > 0);
    for (const part of parts) {
      atoms.push({ kind: 'text', value: part });
    }
  }

  const lines: RichVisualLine[] = [];
  let currentPieces: RichInlinePiece[] = [];
  let currentWidth = 0;
  let currentHasFrac = false;

  const pushLine = () => {
    if (currentPieces.length > 0) {
      lines.push({ pieces: currentPieces, hasFraction: currentHasFrac });
      currentPieces = [];
      currentWidth = 0;
      currentHasFrac = false;
    }
  };

  for (const atom of atoms) {
    if (atom.kind === 'text' && /^\s+$/.test(atom.value) && currentPieces.length === 0) {
      continue;
    }
    const w = measureRichTokenWidth(ctx, atom, fontWeight, fontSize);
    if (currentPieces.length > 0 && currentWidth + w > maxWidth) {
      pushLine();
      if (atom.kind === 'text' && /^\s+$/.test(atom.value)) {
        continue;
      }
    }
    currentPieces.push({ token: atom, width: w });
    currentWidth += w;
    if (atom.kind === 'frac') {
      currentHasFrac = true;
    }
  }
  pushLine();

  return lines.length > 0 ? lines : [{ pieces: [], hasFraction: false }];
}

function getRichLineHeight(line: RichVisualLine, baseLineHeight: number): number {
  return line.hasFraction ? Math.max(baseLineHeight + 22, 54) : baseLineHeight;
}

function drawRichVisualLine(
  ctx: CanvasRenderingContext2D,
  line: RichVisualLine,
  startX: number,
  topY: number,
  fontWeight: number,
  fontSize: number,
  color: string,
  baseLineHeight: number
): number {
  const lineHeight = getRichLineHeight(line, baseLineHeight);
  const textTopY = line.hasFraction
    ? topY + Math.round((lineHeight - fontSize) / 2)
    : topY;

  let cursorX = startX;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  for (const piece of line.pieces) {
    const { token, width } = piece;
    if (token.kind === 'text') {
      ctx.fillStyle = color;
      ctx.font = `${fontWeight} ${fontSize}px ${FONT_STACK}`;
      ctx.fillText(token.value, cursorX, textTopY);
      cursorX += width;
    } else if (token.kind === 'sup') {
      const supSize = Math.max(12, Math.round(fontSize * 0.68));
      ctx.fillStyle = color;
      ctx.font = `600 ${supSize}px ${FONT_STACK}`;
      ctx.fillText(token.value, cursorX + 1, textTopY - Math.round(fontSize * 0.22));
      cursorX += width;
    } else if (token.kind === 'sub') {
      const subSize = Math.max(12, Math.round(fontSize * 0.68));
      ctx.fillStyle = color;
      ctx.font = `600 ${subSize}px ${FONT_STACK}`;
      ctx.fillText(token.value, cursorX + 1, textTopY + Math.round(fontSize * 0.36));
      cursorX += width;
    } else if (token.kind === 'sqrt') {
      ctx.fillStyle = color;
      ctx.font = `${fontWeight} ${fontSize}px ${FONT_STACK}`;
      const radW = ctx.measureText('√').width;
      const innerText = formatMathForPlainText(token.value);
      const innerW = ctx.measureText(innerText).width;
      ctx.fillText('√', cursorX, textTopY);
      ctx.fillText(innerText, cursorX + radW + 3, textTopY);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cursorX + radW, textTopY - 1);
      ctx.lineTo(cursorX + radW + innerW + 6, textTopY - 1);
      ctx.stroke();
      cursorX += width;
    } else {
      // Draw genuine stacked horizontal-bar fraction
      const fracSize = Math.max(13, Math.round(fontSize * 0.78));
      const cleanNum = formatMathForPlainText(token.num);
      const cleanDen = formatMathForPlainText(token.den);
      const barY = topY + Math.round(lineHeight / 2);
      const centerX = cursorX + width / 2;

      ctx.fillStyle = color;
      ctx.font = `${fontWeight} ${fracSize}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.fillText(cleanNum, centerX, barY - fracSize - 4);
      ctx.fillText(cleanDen, centerX, barY + 5);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cursorX + 5, barY);
      ctx.lineTo(cursorX + width - 5, barY);
      ctx.stroke();

      ctx.textAlign = 'left';
      cursorX += width;
    }
  }

  return lineHeight;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('PDF পৃষ্ঠা রেন্ডার করতে ব্যর্থ হয়েছে।'));
        return;
      }
      try {
        const ab = await blob.arrayBuffer();
        resolve(new Uint8Array(ab));
      } catch (err) {
        reject(err);
      }
    }, 'image/png');
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Renders structured exam papers onto ISO A4 pages using the browser's native Unicode
 * Bengali text shaping engine and packages them into a real multi-page `.pdf` via `pdf-lib`.
 */
export async function buildStructuredExamPdfBytes(
  units: SmartReaderViewUnit[],
  options: ExamExportOptions
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  if (typeof document === 'undefined') {
    throw new Error('PDF এক্সপোর্ট শুধুমাত্র ব্রাউজারে চালানো যাবে।');
  }

  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  const renderedCanvases: Array<{
    canvas: HTMLCanvasElement;
    isMcqPage: boolean;
    marginX: number;
    canvasW: number;
    canvasH: number;
  }> = [];

  const requestedLayoutColumns: 1 | 2 = options.layoutColumns === 2 ? 2 : 1;
  const justifyText = options.justifyText !== false;

  for (let unitIdx = 0; unitIdx < units.length; unitIdx += 1) {
    const unit = units[unitIdx];
    const parsed = applyExamExportOptionsToDocument(unit.content, options);
    const isMcqUnit = isMcqExamDocument(parsed, options.bookTitle);
    // Strict scope: 8.5x11 2-column MCQ makeup applies ONLY to MCQ papers, NEVER to Written
    const layoutColumns: 1 | 2 = isMcqUnit ? requestedLayoutColumns : 1;

    const unitCanvasW = isMcqUnit ? MCQ_PAGE_MAKEUP_SPEC.paper.widthPx150 : CANVAS_W; // 1275 vs 1240
    const unitCanvasH = isMcqUnit ? MCQ_PAGE_MAKEUP_SPEC.paper.heightPx150 : CANVAS_H; // 1650 vs 1754
    const unitMarginX = isMcqUnit ? 120 : MARGIN_X; // 0.8" vs 0.5"
    const unitMarginBottom = isMcqUnit ? 75 : MARGIN_BOTTOM; // 0.5"
    const unitContentW = unitCanvasW - unitMarginX * 2; // 1035 (6.9") vs 1090
    // Generous 44px center-divider breathing gap (22px left of line + 22px right before Col 2 numbers)
    const unitTwoColGap = isMcqUnit ? 44 : TWO_COL_GAP;
    const colWidth =
      layoutColumns === 2
        ? Math.floor((unitContentW - unitTwoColGap) / 2)
        : unitContentW;
    const colLeftX = (colIndex: 0 | 1) =>
      colIndex === 0 ? unitMarginX : unitMarginX + colWidth + unitTwoColGap;
    const maxY = unitCanvasH - unitMarginBottom - 6;

    const createPageCanvas = (
      runningTitle: string,
      drawDividerFromY?: number
    ): {
      canvas: HTMLCanvasElement;
      ctx: CanvasRenderingContext2D;
      cursorY: number;
      colIndex: 0 | 1;
      colTopY: number;
    } => {
      const canvas = document.createElement('canvas');
      canvas.width = unitCanvasW;
      canvas.height = unitCanvasH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas 2D context পাওয়া যায়নি।');
      }

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, unitCanvasW, unitCanvasH);

      // Header positioned at 0.45" (~67px bottom edge) for MCQ Letter or standard A4 top
      const headerTextY = isMcqUnit ? 36 : 34;
      const headerRuleY = isMcqUnit ? 60 : 58;
      const bodyStartY = isMcqUnit ? 74 : 72;

      ctx.fillStyle = '#0F172A';
      ctx.font = `600 17px ${FONT_STACK}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      const shortHeader =
        runningTitle.length > 72 ? `${runningTitle.slice(0, 71)}…` : runningTitle;
      ctx.fillText(shortHeader, unitMarginX, headerTextY);

      ctx.font = `500 16px ${FONT_STACK}`;
      ctx.fillStyle = '#1E293B';
      ctx.textAlign = 'right';
      ctx.fillText('বিভিন্ন নিয়োগ পরীক্ষার প্রশ্নোত্তর', unitCanvasW - unitMarginX, headerTextY);
      ctx.textAlign = 'left';

      ctx.strokeStyle = '#0F172A';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(unitMarginX, headerRuleY);
      ctx.lineTo(unitCanvasW - unitMarginX, headerRuleY);
      ctx.stroke();

      if (layoutColumns === 2 && drawDividerFromY !== undefined) {
        const divX = unitMarginX + colWidth + Math.floor(unitTwoColGap / 2);
        ctx.strokeStyle = '#0F172A';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(divX, drawDividerFromY);
        ctx.lineTo(divX, unitCanvasH - unitMarginBottom - 4);
        ctx.stroke();
      }

      renderedCanvases.push({
        canvas,
        isMcqPage: isMcqUnit,
        marginX: unitMarginX,
        canvasW: unitCanvasW,
        canvasH: unitCanvasH,
      });
      return { canvas, ctx, cursorY: bodyStartY, colIndex: 0, colTopY: bodyStartY };
    };

    const runningTitle = `${options.bookTitle} · ${unit.pageLabel}`;

    let pageState = createPageCanvas(runningTitle);

    const drawCenterDividerIfNeeded = (fromY: number) => {
      if (layoutColumns !== 2) return;
      const divX = unitMarginX + colWidth + Math.floor(unitTwoColGap / 2);
      pageState.ctx.strokeStyle = '#0F172A';
      pageState.ctx.lineWidth = 1.4;
      pageState.ctx.beginPath();
      pageState.ctx.moveTo(divX, fromY);
      pageState.ctx.lineTo(divX, unitCanvasH - unitMarginBottom - 4);
      pageState.ctx.stroke();
    };

    const ensureSpace = (neededHeight: number) => {
      if (pageState.cursorY + neededHeight <= maxY) return;
      if (layoutColumns === 2 && pageState.colIndex === 0) {
        pageState.colIndex = 1;
        pageState.cursorY = pageState.colTopY;
        return;
      }
      pageState = createPageCanvas(runningTitle, isMcqUnit ? 74 : 72);
    };

    // Draw Compact Authentic Centered Institutional Exam Masthead across full width
    if (options.includeHeader) {
      const rawHeaderLines =
        parsed.isExam && parsed.headerLines.length > 0
          ? parsed.headerLines
          : [unit.title];
      const masthead = parseStructuredExamHeader(rawHeaderLines);
      const { ctx } = pageState;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      const mainTitles =
        masthead.titleLines.length > 0 ? masthead.titleLines : [unit.title];

      const mainTitlePx = Math.round(PDF_HEADER_PX * 0.86);
      mainTitles.forEach((hLine, idx) => {
        ctx.fillStyle = '#0F172A';
        ctx.font =
          idx === 0
            ? `700 ${mainTitlePx}px ${FONT_STACK}`
            : `700 ${Math.round(mainTitlePx * 0.78)}px ${FONT_STACK}`;
        const wrapped = wrapCanvasText(ctx, hLine, unitContentW - 24);
        for (const wLine of wrapped) {
          ctx.fillText(wLine, unitCanvasW / 2, pageState.cursorY);
          pageState.cursorY += idx === 0 ? 35 : 28;
        }
      });

      if (masthead.postLine) {
        ctx.fillStyle = '#0F172A';
        ctx.font = `700 24px ${FONT_STACK}`;
        const wrappedPost = wrapCanvasText(ctx, masthead.postLine, unitContentW - 24);
        for (const wLine of wrappedPost) {
          ctx.fillText(wLine, unitCanvasW / 2, pageState.cursorY);
          pageState.cursorY += 28;
        }
      }

      for (const extraLine of masthead.otherMetaLines) {
        ctx.fillStyle = '#1E293B';
        ctx.font = `600 21px ${FONT_STACK}`;
        ctx.fillText(extraLine, unitCanvasW / 2, pageState.cursorY);
        pageState.cursorY += 24;
      }

      if (masthead.timeText || masthead.dateText || masthead.marksText) {
        pageState.cursorY += 3;
        ctx.fillStyle = '#0F172A';
        ctx.font = `700 21px ${FONT_STACK}`;
        if (masthead.timeText) {
          ctx.textAlign = 'left';
          ctx.fillText(masthead.timeText, unitMarginX, pageState.cursorY);
        }
        if (masthead.dateText) {
          ctx.textAlign = 'center';
          ctx.fillText(masthead.dateText, unitCanvasW / 2, pageState.cursorY);
        }
        if (masthead.marksText) {
          ctx.textAlign = 'right';
          ctx.fillText(masthead.marksText, unitCanvasW - unitMarginX, pageState.cursorY);
        }
        pageState.cursorY += 26;
      }

      // Clean sharp editorial single bottom rule
      pageState.cursorY += 2;
      ctx.strokeStyle = '#0F172A';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(unitMarginX, pageState.cursorY);
      ctx.lineTo(unitCanvasW - unitMarginX, pageState.cursorY);
      ctx.stroke();

      pageState.cursorY += 10;
      pageState.colTopY = pageState.cursorY;
      ctx.textAlign = 'left';
      drawCenterDividerIfNeeded(pageState.colTopY);
    } else {
      drawCenterDividerIfNeeded(isMcqUnit ? 74 : 72);
    }

    const drawStructuredTableOnCanvas = (
      table: ParsedMarkdownTable,
      indentPx: number
    ) => {
      const colCount = Math.max(1, table.headers.length);
      const tableW = Math.max(160, colWidth - indentPx);
      const cellW = Math.floor(tableW / colCount);
      const cellPadX = 7;
      const cellPadY = 5;
      const tableFontScale = 0.84;
      const tableLineH = 22;

      const renderRow = (
        cells: string[],
        isHeader: boolean,
        rowIdx: number
      ) => {
        const weight = isHeader ? 700 : 400;
        const wrappedCells = Array.from({ length: colCount }, (_, cIdx) =>
          wrapMixedScriptCanvasLines(
            pageState.ctx,
            formatMathForPlainText(cells[cIdx] ?? ''),
            Math.max(40, cellW - cellPadX * 2),
            weight,
            tableFontScale
          )
        );
        const maxLines = Math.max(1, ...wrappedCells.map((wc) => wc.length));
        const rowH = maxLines * tableLineH + cellPadY * 2;

        ensureSpace(rowH + 3);
        const baseX = colLeftX(pageState.colIndex) + indentPx;
        const rowTopY = pageState.cursorY;
        const { ctx } = pageState;

        if (isHeader) {
          ctx.fillStyle = '#F1F5F9';
          ctx.fillRect(baseX, rowTopY, cellW * colCount, rowH);
        } else if (rowIdx % 2 === 1) {
          ctx.fillStyle = '#F8FAFC';
          ctx.fillRect(baseX, rowTopY, cellW * colCount, rowH);
        }

        ctx.strokeStyle = isHeader ? '#334155' : '#64748B';
        ctx.lineWidth = 1.1;

        for (let cIdx = 0; cIdx < colCount; cIdx += 1) {
          const cx = baseX + cIdx * cellW;
          ctx.strokeRect(cx, rowTopY, cellW, rowH);
          const cellLines = wrappedCells[cIdx];
          let ly = rowTopY + cellPadY;
          for (const lineAtoms of cellLines) {
            const lineWidth = lineAtoms.reduce((sum, a) => sum + a.width, 0);
            const align = table.alignments[cIdx] ?? 'left';
            let tx = cx + cellPadX;
            if (align === 'center') {
              tx = cx + Math.max(cellPadX, Math.floor((cellW - lineWidth) / 2));
            } else if (align === 'right') {
              tx = cx + Math.max(cellPadX, cellW - cellPadX - lineWidth);
            }
            drawMixedScriptCanvasLine(
              ctx,
              lineAtoms,
              tx,
              ly,
              weight,
              isHeader ? '#0F172A' : '#1E293B',
              tableFontScale
            );
            ly += tableLineH;
          }
        }

        pageState.cursorY = rowTopY + rowH;
      };

      pageState.cursorY += 4;
      renderRow(table.headers, true, -1);
      table.rows.forEach((row, rIdx) => renderRow(row, false, rIdx));
      pageState.cursorY += 6;
    };

    if (!parsed.isExam) {
      // Plain textbook prose + tables + bold/italic/underline fallback
      const blocks = splitTextBlocksWithTables(parsed.formatted);
      for (const block of blocks) {
        if (block.kind === 'blank') {
          pageState.cursorY += 14;
          continue;
        }
        if (block.kind === 'table') {
          drawStructuredTableOnCanvas(block.table, 0);
          continue;
        }
        const mLines = wrapMixedScriptCanvasLines(
          pageState.ctx,
          formatMathForPlainText(block.text.trim()),
          colWidth,
          400
        );
        mLines.forEach((mLine, lineIdx) => {
          ensureSpace(34);
          const baseX = colLeftX(pageState.colIndex);
          const isLastLine = lineIdx === mLines.length - 1;
          drawMixedScriptCanvasLine(
            pageState.ctx,
            mLine,
            baseX,
            pageState.cursorY,
            400,
            '#1E293B',
            1,
            justifyText && !isLastLine ? colWidth : undefined
          );
          pageState.cursorY += 34;
        });
      }
      continue;
    }

    // Group options into adaptive 2-column / 1-column blocks matching exact MCQ Tab Stop spec
    const maxCharsPerHalfRow =
      layoutColumns === 2
        ? EDITORIAL_2COL_OPTION_MAX_CHARS
        : EDITORIAL_1COL_OPTION_MAX_CHARS;
    const groupedBlocks = groupDisplayItemsWithOptionBlocks(
      parsed.bodyItems,
      maxCharsPerHalfRow
    );
    // Always render Answer/উত্তর directly below the options (never inline on the right)
    const displayBlocks: McqEnhancedDisplayBlock[] = groupedBlocks;

    // Generous 56px (~0.373" @ 150 DPI) hanging indent & question number gap for MCQ
    const numColWidth = isMcqUnit ? 56 : 50;
    const optionIndent = isMcqUnit ? 56 : 50;
    const markerColWidth = 28;
    const textRightBuffer = isMcqUnit && layoutColumns === 2 ? 6 : 0;

    // Build adaptive page/column schedule for MCQ units (strictly [1.00, 1.50] line spacing!)
    interface ScheduledCanvasBlock {
      block: McqEnhancedDisplayBlock;
      lineSpacing: number;
      forceBreak?: 'column' | 'page';
    }
    const scheduledBlocks: ScheduledCanvasBlock[] = [];
    if (isMcqUnit) {
      const clusters = clusterExamBlocksByQuestion(displayBlocks);
      const ptToCanvas150 = 150 / 72; // 2.0833px per pt
      const canvasMetrics = clusters.map((c) => {
        const ptM = estimateMcqClusterWordMetricsPt(c, layoutColumns);
        return {
          heightAt100: ptM.heightAt100 * ptToCanvas150,
          heightAt150: ptM.heightAt150 * ptToCanvas150,
        };
      });
      const bodyStartY = 74;
      const firstHeaderUsed = Math.max(0, pageState.colTopY - bodyStartY);
      const adaptivePages = optimizeMcqAdaptivePagination({
        headerHeight: firstHeaderUsed,
        items: canvasMetrics,
        pageContentHeight: maxY - bodyStartY,
        layoutMode: layoutColumns === 2 ? 'double' : 'single',
        itemGap: 4,
        minLineSpacing: 1.0,
        maxLineSpacing: 1.5,
        preferredLineSpacing: 1.2,
      });

      adaptivePages.forEach((ap, pageIdx) => {
        const col1Blocks = ap.col1Indices.flatMap((idx) => clusters[idx].blocks);
        const col2Blocks = ap.col2Indices.flatMap((idx) => clusters[idx].blocks);

        col1Blocks.forEach((blk, bIdx) => {
          scheduledBlocks.push({
            block: blk,
            lineSpacing: ap.col1LineSpacing,
            forceBreak: pageIdx > 0 && bIdx === 0 ? 'page' : undefined,
          });
        });
        if (layoutColumns === 2) {
          col2Blocks.forEach((blk, bIdx) => {
            scheduledBlocks.push({
              block: blk,
              lineSpacing: ap.col2LineSpacing,
              forceBreak:
                bIdx === 0
                  ? col1Blocks.length > 0
                    ? 'column'
                    : pageIdx > 0
                      ? 'page'
                      : undefined
                  : undefined,
            });
          });
        }
      });
    } else {
      for (const blk of displayBlocks) {
        scheduledBlocks.push({ block: blk, lineSpacing: 1.35 });
      }
    }

    for (let i = 0; i < scheduledBlocks.length; i += 1) {
      const entry = scheduledBlocks[i];
      const item = entry.block;
      if (entry.forceBreak === 'page') {
        pageState = createPageCanvas(runningTitle, isMcqUnit ? 74 : 72);
      } else if (entry.forceBreak === 'column' && layoutColumns === 2) {
        if (pageState.colIndex === 0) {
          pageState.colIndex = 1;
          pageState.cursorY = pageState.colTopY;
        }
      }

      const activeLS = entry.lineSpacing;
      const qLineStep = isMcqUnit ? Math.max(19, Math.round(20 * activeLS)) : 27;
      const optLineStep = isMcqUnit ? Math.max(18, Math.round(19.5 * activeLS)) : 26;
      const expLineStep = isMcqUnit ? Math.max(19, Math.round(20.5 * activeLS)) : 25;

      if (item.kind === 'spacer') {
        pageState.cursorY += 4;
        continue;
      }

      if (item.kind === 'question') {
        const stemWrapW = Math.max(100, colWidth - numColWidth - textRightBuffer);
        const useRich = hasRichMathNotation(item.text);
        if (useRich) {
          const rLines = wrapRichMathLines(
            pageState.ctx,
            item.text,
            stemWrapW,
            500,
            22
          );
          const totalH = rLines.reduce((acc, rl) => acc + getRichLineHeight(rl, qLineStep + 2), 0);
          ensureSpace(totalH + 38);

          const baseX = colLeftX(pageState.colIndex);
          pageState.cursorY += 5;
          const { ctx } = pageState;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillStyle = '#0F172A';
          ctx.font = `600 22px ${FONT_STACK}`;
          const numOffsetY = rLines[0]?.hasFraction ? 10 : 0;
          ctx.fillText(item.numberLabel, baseX, pageState.cursorY + numOffsetY);

          for (const rl of rLines) {
            const consumed = drawRichVisualLine(
              ctx,
              rl,
              baseX + numColWidth,
              pageState.cursorY,
              500,
              22,
              '#0F172A',
              qLineStep + 2
            );
            pageState.cursorY += consumed;
          }
          continue;
        }

        const qLines = wrapMixedScriptCanvasLines(
          pageState.ctx,
          item.text,
          stemWrapW,
          500,
          0.95
        );
        ensureSpace(qLines.length * qLineStep + 38);

        const baseX = colLeftX(pageState.colIndex);
        pageState.cursorY += isMcqUnit ? 3 : 5;
        const { ctx } = pageState;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#0F172A';
        const numScript =
          /[0-9]/.test(item.numberLabel) && !/[০-৯]/.test(item.numberLabel) ? 'en' : 'bn';
        ctx.font = getCanvasFontForScript(numScript, 600, false, 0.95);
        ctx.fillText(item.numberLabel, baseX, pageState.cursorY);

        qLines.forEach((qLine, lineIdx) => {
          const isLastLine = lineIdx === qLines.length - 1;
          drawMixedScriptCanvasLine(
            ctx,
            qLine,
            baseX + numColWidth,
            pageState.cursorY,
            500,
            '#0F172A',
            0.95,
            justifyText && !isLastLine ? stemWrapW : undefined
          );
          pageState.cursorY += qLineStep;
        });
        continue;
      }

      if (item.kind === 'option_group') {
        const availW = colWidth - optionIndent - textRightBuffer;
        // Exact 1.75" Tab Stop proportion adapted cleanly inside padded 2-col MCQ width
        const col2OffsetX =
          isMcqUnit && layoutColumns === 2
            ? Math.round(1.34 * 150)
            : Math.floor((availW + 14) / 2);
        const halfGap = 12;
        const cellW =
          item.columns === 2 ? Math.max(120, col2OffsetX - halfGap) : availW;

        item.rows.forEach((row, rIdx) => {
          const isLastRow = rIdx === item.rows.length - 1;
          const inlineAnswer = isLastRow ? item.inlineAnswer : undefined;

          const measuredCells = row.map((opt, cIdx) => {
            const useRich = hasRichMathNotation(opt.text);
            const activeCellW =
              item.columns === 2
                ? cIdx === 0
                  ? cellW
                  : Math.max(120, availW - col2OffsetX)
                : availW;
            const textMaxW = Math.max(80, activeCellW - markerColWidth);
            if (useRich) {
              const rLines = wrapRichMathLines(
                pageState.ctx,
                opt.text,
                textMaxW,
                400,
                21
              );
              const h = rLines.reduce((acc, rl) => acc + getRichLineHeight(rl, optLineStep), 0);
              return { opt, useRich: true as const, rLines, mLines: [] as MixedCanvasAtom[][], h };
            }
            const mLines = wrapMixedScriptCanvasLines(
              pageState.ctx,
              opt.text,
              textMaxW,
              400,
              0.94
            );
            return {
              opt,
              useRich: false as const,
              rLines: [] as RichVisualLine[],
              mLines,
              h: Math.max(1, mLines.length) * optLineStep,
            };
          });

          const rowH = Math.max(optLineStep, ...measuredCells.map((c) => c.h));
          ensureSpace(rowH + 2);

          const baseX = colLeftX(pageState.colIndex);
          const rowStartY = pageState.cursorY;
          const { ctx } = pageState;

          measuredCells.forEach((cell, cIdx) => {
            const cellX =
              baseX + optionIndent + (cIdx === 1 ? col2OffsetX : 0);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#0F172A';
            const mScript = /[A-Za-z]/.test(cell.opt.marker) ? 'en' : 'bn';
            ctx.font = getCanvasFontForScript(mScript, 400, false, 0.94);

            if (cell.useRich) {
              const mOffsetY = cell.rLines[0]?.hasFraction ? 10 : 0;
              ctx.fillText(cell.opt.marker, cellX, rowStartY + mOffsetY);
              let localY = rowStartY;
              for (const rl of cell.rLines) {
                localY += drawRichVisualLine(
                  ctx,
                  rl,
                  cellX + markerColWidth,
                  localY,
                  400,
                  21,
                  '#0F172A',
                  optLineStep
                );
              }
            } else {
              ctx.fillText(cell.opt.marker, cellX, rowStartY);
              let localY = rowStartY;
              for (const oLine of cell.mLines) {
                drawMixedScriptCanvasLine(
                  ctx,
                  oLine,
                  cellX + markerColWidth,
                  localY,
                  400,
                  '#0F172A',
                  0.94
                );
                localY += optLineStep;
              }
            }
          });

          // Right-aligned answer snapped to exact 3.35" Right Tab edge of column
          if (inlineAnswer) {
            const rightEdgeX = baseX + colWidth;
            const ansValStr = formatMathForPlainText(inlineAnswer.text);
            const ansValScript =
              /[A-Za-z0-9]/.test(ansValStr) && !/[\u0980-\u09FF]/.test(ansValStr)
                ? 'en'
                : 'bn';
            ctx.textBaseline = 'top';
            ctx.textAlign = 'right';
            ctx.font = getCanvasFontForScript(ansValScript, 700, false, 0.92);
            const valWidth = ctx.measureText(ansValStr).width;
            ctx.fillStyle = '#0F172A';
            ctx.fillText(ansValStr, rightEdgeX, rowStartY);

            ctx.font = getCanvasFontForScript('bn', 700, false, 0.92);
            ctx.fillStyle = '#B91C1C';
            ctx.fillText(`${inlineAnswer.label}: `, rightEdgeX - valWidth, rowStartY);
            ctx.textAlign = 'left';
          }

          pageState.cursorY = rowStartY + rowH + (isMcqUnit ? 0 : 1);
        });
        continue;
      }

      if (item.kind === 'option') {
        const optLines = wrapMixedScriptCanvasLines(
          pageState.ctx,
          item.text,
          colWidth - optionIndent - markerColWidth,
          400,
          0.94
        );
        ensureSpace(optLines.length * optLineStep + 4);
        const baseX = colLeftX(pageState.colIndex);
        const { ctx } = pageState;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#0F172A';
        const mScript = /[A-Za-z]/.test(item.marker) ? 'en' : 'bn';
        ctx.font = getCanvasFontForScript(mScript, 400, false, 0.94);
        ctx.fillText(item.marker, baseX + optionIndent, pageState.cursorY);

        for (const oLine of optLines) {
          drawMixedScriptCanvasLine(
            ctx,
            oLine,
            baseX + optionIndent + markerColWidth,
            pageState.cursorY,
            400,
            '#0F172A',
            0.94
          );
          pageState.cursorY += optLineStep;
        }
        continue;
      }

      if (item.kind === 'ai_badge') {
        const badgeLabel = `★ ${item.text}`;
        ensureSpace(24);
        const baseX = colLeftX(pageState.colIndex);
        const { ctx } = pageState;
        ctx.fillStyle = '#92400E';
        ctx.font = `600 15px ${FONT_STACK}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(badgeLabel, baseX + optionIndent, pageState.cursorY + 2);
        pageState.cursorY += 22;
        continue;
      }

      if (item.kind === 'reference') {
        const refText = `${item.label}: ${item.text}`;
        pageState.ctx.font = `500 16px ${FONT_STACK}`;
        const refLines = wrapCanvasText(
          pageState.ctx,
          refText,
          colWidth - optionIndent
        );
        ensureSpace(refLines.length * 22 + 4);

        const baseX = colLeftX(pageState.colIndex);
        const { ctx } = pageState;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#334155';
        ctx.font = `500 16px ${FONT_STACK}`;
        for (const rLine of refLines) {
          ctx.fillText(rLine, baseX + optionIndent, pageState.cursorY);
          pageState.cursorY += 22;
        }
        continue;
      }

      if (item.kind === 'highlight') {
        const hlLines = wrapMixedScriptCanvasLines(
          pageState.ctx,
          `**হাইলাইট:** ${formatMathForPlainText(item.text)}`,
          colWidth - optionIndent,
          400,
          0.92
        );
        ensureSpace(hlLines.length * 24 + 4);
        const baseX = colLeftX(pageState.colIndex);
        const { ctx } = pageState;
        hlLines.forEach((hLine, lineIdx) => {
          const isLastLine = lineIdx === hlLines.length - 1;
          drawMixedScriptCanvasLine(
            ctx,
            hLine,
            baseX + optionIndent,
            pageState.cursorY,
            400,
            '#7F1D1D',
            0.92,
            justifyText && !isLastLine ? colWidth - optionIndent : undefined
          );
          pageState.cursorY += 24;
        });
        continue;
      }

      // Clean Matrix-style crimson inline Answer line (NO blue box!)
      if (item.kind === 'solution') {
        const labelText = `${item.label}: `;
        pageState.ctx.font = getCanvasFontForScript('bn', 700, false, 0.94);
        const labelW = Math.ceil(pageState.ctx.measureText(labelText).width) + 2;
        const firstLineMaxW = Math.max(120, colWidth - optionIndent - labelW);

        if (hasRichMathNotation(item.text || '')) {
          const rLines = wrapRichMathLines(
            pageState.ctx,
            item.text || '',
            firstLineMaxW,
            600,
            21
          );
          const totalH = rLines.reduce((acc, rl) => acc + getRichLineHeight(rl, optLineStep), 0);
          ensureSpace(totalH + 6);

          const baseX = colLeftX(pageState.colIndex);
          const textStartX = baseX + optionIndent + labelW;
          const { ctx } = pageState;
          const labelOffsetY = rLines[0]?.hasFraction ? 10 : 0;
          ctx.fillStyle = '#B91C1C';
          ctx.font = getCanvasFontForScript('bn', 700, false, 0.94);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(labelText, baseX + optionIndent, pageState.cursorY + labelOffsetY);

          for (let sIdx = 0; sIdx < rLines.length; sIdx += 1) {
            const consumed = drawRichVisualLine(
              ctx,
              rLines[sIdx],
              sIdx === 0 ? textStartX : baseX + optionIndent,
              pageState.cursorY,
              600,
              21,
              '#0F172A',
              optLineStep
            );
            pageState.cursorY += consumed;
          }
          pageState.cursorY += 2;
          continue;
        }

        const solLines = wrapMixedScriptCanvasLines(
          pageState.ctx,
          item.text || '',
          firstLineMaxW,
          600,
          0.94
        );
        ensureSpace(Math.max(1, solLines.length) * optLineStep + 4);

        const baseX = colLeftX(pageState.colIndex);
        const textStartX = baseX + optionIndent + labelW;
        const { ctx } = pageState;
        ctx.fillStyle = '#B91C1C';
        ctx.font = getCanvasFontForScript('bn', 700, false, 0.94);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(labelText, baseX + optionIndent, pageState.cursorY);

        for (let sIdx = 0; sIdx < solLines.length; sIdx += 1) {
          drawMixedScriptCanvasLine(
            ctx,
            solLines[sIdx],
            sIdx === 0 ? textStartX : baseX + optionIndent,
            pageState.cursorY,
            600,
            '#0F172A',
            0.94
          );
          pageState.cursorY += optLineStep;
        }
        pageState.cursorY += 2;
        continue;
      }

      // Clean publication inline Explanation / Note (NO pink card, NO maroon pill!)
      if (item.kind === 'explanation') {
        const expLabel = `${item.label}: `;
        pageState.ctx.font = getCanvasFontForScript('bn', 700, false, 0.92);
        const labelW = Math.ceil(pageState.ctx.measureText(expLabel).width) + 2;
        const availW = colWidth - optionIndent - textRightBuffer;
        const expLines = wrapMixedScriptCanvasLines(
          pageState.ctx,
          formatMathForPlainText(item.text || ''),
          Math.max(120, availW),
          400,
          0.92
        );
        // Re-wrap line 0 cleanly after the bold crimson `ব্যাখ্যা:` label by prepending a placeholder width if needed
        const combinedLines = wrapMixedScriptCanvasLines(
          pageState.ctx,
          `${expLabel}${formatMathForPlainText(item.text || '')}`,
          Math.max(120, availW),
          400,
          0.92
        );
        const linesToDraw = combinedLines.length > 0 ? combinedLines : expLines;
        ensureSpace(Math.max(1, linesToDraw.length) * expLineStep + 6);

        const baseX = colLeftX(pageState.colIndex);
        const startX = baseX + optionIndent;
        const { ctx } = pageState;

        linesToDraw.forEach((eLine, lineIdx) => {
          const isLastLine = lineIdx === linesToDraw.length - 1;
          if (lineIdx === 0 && eLine.length > 0) {
            // Draw crimson bold label first, then remainder of line 0 cleanly
            ctx.fillStyle = '#9F1239';
            ctx.font = getCanvasFontForScript('bn', 700, false, 0.92);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(expLabel, startX, pageState.cursorY);

            // Strip the prefix atoms matching expLabel so text isn't duplicated
            let remainingChars = expLabel.length;
            const tailAtoms: MixedCanvasAtom[] = [];
            for (const atom of eLine) {
              if (remainingChars <= 0) {
                tailAtoms.push(atom);
              } else if (atom.text.length <= remainingChars) {
                remainingChars -= atom.text.length;
              } else {
                const slicedText = atom.text.slice(remainingChars);
                remainingChars = 0;
                ctx.font = getCanvasFontForScript(
                  atom.script,
                  atom.bold ? 700 : 400,
                  atom.italic,
                  0.92
                );
                tailAtoms.push({
                  ...atom,
                  text: slicedText,
                  width: ctx.measureText(slicedText).width,
                });
              }
            }
            if (tailAtoms.length > 0) {
              drawMixedScriptCanvasLine(
                ctx,
                tailAtoms,
                startX + labelW,
                pageState.cursorY,
                400,
                '#1E293B',
                0.92,
                justifyText && !isLastLine ? Math.max(80, availW - labelW) : undefined
              );
            }
          } else {
            drawMixedScriptCanvasLine(
              ctx,
              eLine,
              startX,
              pageState.cursorY,
              400,
              '#1E293B',
              0.92,
              justifyText && !isLastLine ? availW : undefined
            );
          }
          pageState.cursorY += expLineStep;
        });
        pageState.cursorY += isMcqUnit ? 2 : 3;
        continue;
      }

      if (item.kind === 'center_block') {
        const lineCount = item.lines.length;
        ensureSpace(lineCount * 28 + 14);
        const baseX = colLeftX(pageState.colIndex);
        const centerX = baseX + colWidth / 2;
        const { ctx } = pageState;
        pageState.cursorY += 4;
        item.lines.forEach((line, lIdx) => {
          ctx.font = `${lIdx === 0 ? 700 : 600} ${lIdx === 0 ? 22 : 19}px ${FONT_STACK}`;
          ctx.fillStyle = '#0F172A';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(formatMathForPlainText(line), centerX, pageState.cursorY);
          pageState.cursorY += 26;
        });
        ctx.textAlign = 'left';
        pageState.cursorY += 4;
        continue;
      }

      if (item.kind === 'diagram') {
        const boxW = colWidth - optionIndent;
        const diagLines = wrapMixedScriptCanvasLines(
          pageState.ctx,
          `প্রশ্নের চিত্র: ${formatMathForPlainText(item.caption)}`,
          Math.max(120, boxW - 18),
          500,
          0.9
        );
        const boxH = Math.max(1, diagLines.length) * 24 + 14;
        ensureSpace(boxH + 6);
        const baseX = colLeftX(pageState.colIndex);
        const boxX = baseX + optionIndent;
        const { ctx } = pageState;
        ctx.fillStyle = '#F8FAFC';
        ctx.strokeStyle = '#64748B';
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, boxX, pageState.cursorY, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();
        let dy = pageState.cursorY + 7;
        for (const dLine of diagLines) {
          drawMixedScriptCanvasLine(ctx, dLine, boxX + 9, dy, 500, '#1E293B', 0.9);
          dy += 24;
        }
        pageState.cursorY += boxH + 4;
        continue;
      }

      if (item.kind === 'image') {
        const boxW = colWidth - optionIndent;
        const imgBoxH = 130;
        ensureSpace(imgBoxH + 10);
        const baseX = colLeftX(pageState.colIndex);
        const boxX = baseX + optionIndent;
        try {
          const loadedImg = await new Promise<HTMLImageElement>((resolve, reject) => {
            const imgEl = new window.Image();
            imgEl.onload = () => resolve(imgEl);
            imgEl.onerror = () => reject(new Error('Image load failed'));
            imgEl.src = item.src;
          });
          const maxW = boxW - 12;
          const maxH = 180;
          const ratio = Math.min(maxW / Math.max(1, loadedImg.width), maxH / Math.max(1, loadedImg.height), 1);
          const drawW = Math.round(loadedImg.width * ratio);
          const drawH = Math.round(loadedImg.height * ratio);
          ensureSpace(drawH + 12);
          const drawX = boxX + Math.round((boxW - drawW) / 2);
          pageState.ctx.drawImage(loadedImg, drawX, pageState.cursorY + 2, drawW, drawH);
          pageState.cursorY += drawH + 8;
        } catch {
          pageState.ctx.font = `italic 17px ${FONT_STACK}`;
          pageState.ctx.fillStyle = '#475569';
          pageState.ctx.fillText(`[চিত্র: ${item.alt || 'ডায়াগ্রাম'}]`, boxX + 8, pageState.cursorY);
          pageState.cursorY += 24;
        }
        continue;
      }

      if (item.kind === 'table') {
        drawStructuredTableOnCanvas(
          {
            headers: item.headers,
            alignments: item.alignments,
            rows: item.rows,
          },
          item.indented ? optionIndent : 0
        );
        continue;
      }

      // Centered bold subject subheading (বাংলা, English, সাধারণ জ্ঞান, গণিত) like Matrix
      if (item.kind === 'text' && isExamSubjectHeadingLine(item.text)) {
        ensureSpace(78);
        const baseX = colLeftX(pageState.colIndex);
        const { ctx } = pageState;
        pageState.cursorY += 6;
        ctx.font = `700 23px ${FONT_STACK}`;
        ctx.fillStyle = '#0F172A';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(stripInlineRichMarkup(item.text), baseX + colWidth / 2, pageState.cursorY);
        ctx.textAlign = 'left';
        pageState.cursorY += 27;
        continue;
      }

      // Math step or regular body line
      const indent = item.kind === 'math' || item.indented ? optionIndent : 0;
      if (hasRichMathNotation(item.text)) {
        const rLines = wrapRichMathLines(
          pageState.ctx,
          item.text,
          colWidth - indent,
          400,
          21
        );
        const totalH = rLines.reduce((acc, rl) => acc + getRichLineHeight(rl, optLineStep), 0);
        ensureSpace(totalH + 4);

        const baseX = colLeftX(pageState.colIndex);
        const { ctx } = pageState;
        for (const rl of rLines) {
          const consumed = drawRichVisualLine(
            ctx,
            rl,
            baseX + indent,
            pageState.cursorY,
            400,
            21,
            '#1E293B',
            optLineStep
          );
          pageState.cursorY += consumed;
        }
        continue;
      }

      const bodyLines = wrapMixedScriptCanvasLines(
        pageState.ctx,
        item.text,
        colWidth - indent,
        400,
        0.94
      );
      ensureSpace(bodyLines.length * optLineStep + 4);

      const baseX = colLeftX(pageState.colIndex);
      const { ctx } = pageState;
      bodyLines.forEach((bLine, lineIdx) => {
        const isLastLine = lineIdx === bodyLines.length - 1;
        drawMixedScriptCanvasLine(
          ctx,
          bLine,
          baseX + indent,
          pageState.cursorY,
          400,
          '#1E293B',
          0.94,
          justifyText && !isLastLine ? colWidth - indent : undefined
        );
        pageState.cursorY += optLineStep;
      });
    }
  }

  // Stamp clean minimalist publication page folio across all generated pages
  const totalPages = renderedCanvases.length;
  for (let p = 0; p < totalPages; p += 1) {
    const entry = renderedCanvases[p];
    const ctx = entry.canvas.getContext('2d');
    if (!ctx) continue;

    const footerRuleY = entry.isMcqPage ? entry.canvasH - 64 : entry.canvasH - 52;
    const footerTextY = entry.isMcqPage ? entry.canvasH - 54 : entry.canvasH - 42;

    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(entry.marginX, footerRuleY);
    ctx.lineTo(entry.canvasW - entry.marginX, footerRuleY);
    ctx.stroke();

    ctx.fillStyle = '#334155';
    ctx.font = `500 16px ${FONT_STACK}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText(
      `পৃষ্ঠা ${toBengaliNumber(p + 1, false)} / ${toBengaliNumber(totalPages, false)}`,
      entry.canvasW / 2,
      footerTextY
    );
  }

  // Package all rendered pages into a real PDF document via pdf-lib (8.5"x11" Letter for MCQ, A4 for Written)
  const LETTER_PT_WIDTH = 612; // 8.5 * 72
  const LETTER_PT_HEIGHT = 792; // 11.0 * 72
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(options.bookTitle || 'Structured Exam Paper');
  pdfDoc.setSubject('OCR Exam Paper Export');
  pdfDoc.setCreator('Prostuti AI');

  for (const entry of renderedCanvases) {
    const pngBytes = await canvasToPngBytes(entry.canvas);
    const pngImage = await pdfDoc.embedPng(pngBytes);
    const ptW = entry.isMcqPage ? LETTER_PT_WIDTH : A4_PT_WIDTH;
    const ptH = entry.isMcqPage ? LETTER_PT_HEIGHT : A4_PT_HEIGHT;
    const page = pdfDoc.addPage([ptW, ptH]);
    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: ptW,
      height: ptH,
    });
  }

  const bytes = await pdfDoc.save();
  return { bytes, pageCount: totalPages };
}

/**
 * Triggers a direct client-side file download without using `window.open`.
 */
export function triggerBrowserFileDownload(
  content: Uint8Array | string,
  mimeType: string,
  filename: string
): void {
  const blobPart: BlobPart =
    typeof content === 'string'
      ? content
      : new Uint8Array(content.buffer as ArrayBuffer, content.byteOffset, content.byteLength);
  const blob = new Blob([blobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
