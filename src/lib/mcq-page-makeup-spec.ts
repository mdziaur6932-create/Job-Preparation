import type { ParsedExamDocument } from './exam-text-formatter';
import {
  estimateOptionVisualLength,
  type ExamDisplayBlock,
  type OptionItem,
} from './exam-option-layout';

export interface McqTabStopSpec {
  readonly positionIn: number;
  readonly positionTwips: number;
  readonly alignment: 'left' | 'right';
}

export const TWIPS_PER_INCH = 1440;
export const PX_PER_INCH_96 = 96;
export const PX_PER_INCH_150 = 150;

/**
 * Exact Microsoft Word Page Setup, Paragraph, Column, and Tab Stop Specification
 * for Bangladeshi MCQ Job-Solution Publications (Letter 8.5" x 11", 2-column 3.35").
 *
 * STRICT SCOPE: Applies ONLY to MCQ question papers (`isMcqExamDocument === true`),
 * NEVER to Written exams or textbook prose.
 */
export const MCQ_PAGE_MAKEUP_SPEC = {
  paper: {
    label: '8 1/2 x 11 (Letter Portrait)',
    widthIn: 8.5,
    heightIn: 11.0,
    widthTwips: 12240, // 8.5 * 1440
    heightTwips: 15840, // 11.0 * 1440
    widthMm: 215.9,
    heightMm: 279.4,
    widthPx96: 816, // 8.5 * 96
    heightPx96: 1056, // 11.0 * 96
    widthPx150: 1275, // 8.5 * 150
    heightPx150: 1650, // 11.0 * 150
  },
  margins: {
    topIn: 0.5,
    bottomIn: 0.5,
    leftIn: 0.8,
    rightIn: 0.8,
    gutterIn: 0,
    topTwips: 720, // 0.5 * 1440
    bottomTwips: 720, // 0.5 * 1440
    leftTwips: 1152, // 0.8 * 1440
    rightTwips: 1152, // 0.8 * 1440
    gutterTwips: 0,
    headerFromEdgeIn: 0.45,
    footerFromEdgeIn: 0.45,
    headerFromEdgeTwips: 648, // 0.45 * 1440
    footerFromEdgeTwips: 648, // 0.45 * 1440
  },
  columns: {
    count: 2 as const,
    equalWidth: true,
    lineBetween: true,
    widthIn: 3.35, // (8.5 - 0.8 - 0.8 - 0.2) / 2 = 3.35" EXACT
    spacingIn: 0.2,
    widthTwips: 4824, // 3.35 * 1440
    spacingTwips: 288, // 0.2 * 1440
    usableFullWidthIn: 6.9, // 8.5 - 0.8 - 0.8
    usableFullWidthTwips: 9936, // 6.9 * 1440
    widthPx96: 321.6, // 3.35 * 96
    spacingPx96: 19.2, // 0.2 * 96
    usableFullWidthPx96: 662.4, // 6.9 * 96
    widthPx150: 502.5, // 3.35 * 150
    spacingPx150: 30, // 0.2 * 150
    usableFullWidthPx150: 1035, // 6.9 * 150
  },
  paragraph: {
    indentLeftIn: 0,
    indentRightIn: 0,
    hangingIndentIn: 0.35,
    hangingIndentTwips: 504, // 0.35 * 1440 (Word UI: Left 0", Special Hanging By 0.35")
    hangingIndentPx96: 33.6, // 0.35 * 96
    hangingIndentPx150: 52.5, // 0.35 * 150
    spaceBeforePt: 0,
    spaceAfterPt: 0,
    spaceBeforeTwips: 0,
    spaceAfterTwips: 0,
    lineSpacingMultiple: 1.2,
    lineSpacingWordAuto: 288, // 1.2 * 240
    widowOrphanControl: true,
    keepWithNext: true,
    keepLinesTogether: false,
    pageBreakBefore: false,
  },
  tabs: {
    defaultTabStopIn: 0.5,
    defaultTabStopTwips: 720, // 0.5 * 1440
    stops: [
      { positionIn: 0.35, positionTwips: 504, alignment: 'left' },
      { positionIn: 1.0, positionTwips: 1440, alignment: 'left' },
      { positionIn: 1.75, positionTwips: 2520, alignment: 'left' },
      { positionIn: 2.5, positionTwips: 3600, alignment: 'left' },
      { positionIn: 3.35, positionTwips: 4824, alignment: 'right' },
    ] as readonly McqTabStopSpec[],
  },
  /**
   * 96-DPI usable body height inside one 8.5" x 11" MCQ page:
   * 1056px total - (48px top + 48px bottom margins) - ~50px compact running header & folio = 910px.
   */
  usableContentHeightPx96: 910,
} as const;

/**
 * Determines whether a parsed document is strictly an MCQ exam paper (NOT a Written paper
 * or general textbook prose).
 *
 * Rules:
 * - Must be detected as an exam (`parsed.isExam === true`).
 * - Must contain real MCQ options (`option` items >= 2).
 * - If the document has zero/insufficient MCQ options (e.g. Written essays, translations,
 *   short questions, or title explicitly marked Written without MCQ options), returns `false`.
 */
export function isMcqExamDocument(
  parsed: Pick<ParsedExamDocument, 'isExam' | 'headerLines' | 'bodyItems'>,
  titleHint?: string
): boolean {
  if (!parsed.isExam) return false;

  let optionCount = 0;
  let questionCount = 0;
  for (const item of parsed.bodyItems) {
    if (item.kind === 'option') optionCount += 1;
    else if (item.kind === 'question') questionCount += 1;
  }

  // Real MCQ papers always have option lines (ক./খ./গ./ঘ. or a)/b)/c)/d))
  if (optionCount >= 2) {
    return true;
  }

  // Explicitly Written-only or non-MCQ numbered questions (no options)
  const combinedHeader = `${titleHint ?? ''} ${parsed.headerLines.join(' ')}`;
  if (/\bWritten\b|লিখিত/i.test(combinedHeader) && optionCount < 2) {
    return false;
  }
  if (questionCount > 0 && optionCount === 0) {
    return false;
  }

  return false;
}

/**
 * Estimates horizontal visual width in inches for a single-line MCQ option or answer text
 * rendered in 10.5pt–11pt SolaimanLipi / 11pt–12pt Times New Roman.
 */
export function estimateTextWidthInches(rawText: string): number {
  const visualChars = estimateOptionVisualLength(rawText);
  return Number((visualChars * 0.068).toFixed(3));
}

/**
 * Given a text run that starts at `startIn` (inches from column left), computes how many
 * `\t` tab characters are required in Microsoft Word to land exactly on `targetStopIn`
 * when the paragraph has all 5 MCQ tab stops (`0.35"`, `1"`, `1.75"`, `2.5"`, `3.35"`).
 */
export function computeMcqTabCountToTargetStop(
  startIn: number,
  text: string,
  targetStopIn: number,
  allStopsIn: readonly number[] = MCQ_PAGE_MAKEUP_SPEC.tabs.stops.map((s) => s.positionIn)
): number {
  const endIn = startIn + estimateTextWidthInches(text);
  const safetyBufferIn = 0.06;
  const effectiveEnd = endIn + safetyBufferIn;

  // Count strictly intermediate stops between where the text finishes and targetStopIn
  let intermediateStops = 0;
  for (const stop of allStopsIn) {
    if (stop > effectiveEnd && stop < targetStopIn - 0.01) {
      intermediateStops += 1;
    }
  }
  return 1 + intermediateStops;
}

/**
 * Checks whether a compact MCQ answer (e.g. `উত্তর: গ`, `Answer: B`, `উ. খ`) fits cleanly
 * flush-right at the `3.35"` Right Tab Stop on the LAST row of an MCQ option group
 * (matching authentic Bangladeshi Matrix/Job-Solution page makeup).
 */
export function canPlaceAnswerOnLastOptionRow(params: {
  lastRowOptions: OptionItem[];
  columns: 1 | 2;
  answerLabel: string;
  answerText: string;
  layoutColumns: 1 | 2;
}): boolean {
  const { lastRowOptions, columns, answerLabel, answerText, layoutColumns } = params;
  if (lastRowOptions.length === 0) return false;

  const fullAnswer = `${answerLabel}: ${answerText}`.trim();
  const answerWidthIn = Number((estimateOptionVisualLength(fullAnswer) * 0.082).toFixed(3));
  const colWidthIn =
    layoutColumns === 2
      ? MCQ_PAGE_MAKEUP_SPEC.columns.widthIn // 3.35"
      : MCQ_PAGE_MAKEUP_SPEC.columns.usableFullWidthIn; // 6.90"

  // Very long multi-word explanatory answers belong on their own line below options
  if (answerWidthIn > (layoutColumns === 2 ? 1.15 : 2.1)) {
    return false;
  }

  const lastOpt = lastRowOptions[lastRowOptions.length - 1];
  // Account for fixed 0.22" option marker gutter ("d) " / "ঘ. ") plus realistic glyph width
  const lastOptWidthIn = Number(
    (0.22 + estimateOptionVisualLength(lastOpt.text) * 0.075).toFixed(3)
  );

  const lastOptStartIn =
    columns === 2 && lastRowOptions.length === 2
      ? layoutColumns === 2
        ? 1.75
        : 3.45
      : 0.35;

  const lastOptEndIn = lastOptStartIn + lastOptWidthIn;
  const answerStartIn = colWidthIn - answerWidthIn;

  // Guarantee a crisp visual gap (>= 0.18") between the last option and right-aligned answer
  return answerStartIn - lastOptEndIn >= 0.18;
}

export interface InlineOptionAnswerAttachment {
  label: string;
  text: string;
}

export type McqEnhancedDisplayBlock =
  | Exclude<ExamDisplayBlock, { kind: 'option_group' }>
  | {
      kind: 'option_group';
      options: OptionItem[];
      columns: 1 | 2;
      rows: OptionItem[][];
      inlineAnswer?: InlineOptionAnswerAttachment;
    };

/**
 * Attaches compact MCQ answers directly onto the last option row (flush-right at `3.35"` Right Tab)
 * when space permits, matching Matrix/Job-Solution Word & PDF typesetting while ensuring
 * zero overlap and zero duplicate answer rendering.
 */
export function attachInlineAnswersToOptionGroups(
  blocks: ExamDisplayBlock[],
  layoutColumns: 1 | 2
): McqEnhancedDisplayBlock[] {
  const result: McqEnhancedDisplayBlock[] = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind !== 'option_group') {
      result.push(block);
      continue;
    }

    const nextBlock = blocks[i + 1];
    if (
      nextBlock &&
      nextBlock.kind === 'solution' &&
      block.rows.length > 0 &&
      canPlaceAnswerOnLastOptionRow({
        lastRowOptions: block.rows[block.rows.length - 1],
        columns: block.columns,
        answerLabel: nextBlock.label,
        answerText: nextBlock.text,
        layoutColumns,
      })
    ) {
      result.push({
        ...block,
        inlineAnswer: {
          label: nextBlock.label,
          text: nextBlock.text,
        },
      });
      i += 1; // Consume the solution block so it isn't duplicated on a separate line
      continue;
    }

    result.push(block);
  }

  return result;
}
