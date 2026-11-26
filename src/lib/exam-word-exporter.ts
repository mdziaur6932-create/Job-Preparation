import {
  AlignmentType,
  BorderStyle,
  ColumnBreak,
  Document,
  Footer,
  Header,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  SectionType,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  UnderlineType,
  WidthType,
  type ISectionOptions,
} from 'docx';
import {
  applyExamExportOptionsToDocument,
  type ExamExportOptions,
} from './exam-paper-exporter';
import {
  EDITORIAL_1COL_OPTION_MAX_CHARS,
  EDITORIAL_2COL_OPTION_MAX_CHARS,
  groupDisplayItemsWithOptionBlocks,
  isExamSubjectHeadingLine,
  parseStructuredExamHeader,
} from './exam-option-layout';
import {
  computeMcqTabCountToTargetStop,
  isMcqExamDocument,
  MCQ_PAGE_MAKEUP_SPEC,
  type InlineOptionAnswerAttachment,
  type McqEnhancedDisplayBlock,
} from './mcq-page-makeup-spec';
import {
  clusterExamBlocksByQuestion,
  estimateMcqClusterWordMetricsPt,
  optimizeMcqAdaptivePagination,
} from './mcq-adaptive-pagination';
import { formatMathForPlainText } from './exam-math-and-answer-guard';
import {
  parseInlineRichText,
  splitTextBlocksWithTables,
  type ParsedMarkdownTable,
  type TableAlignment,
} from './rich-text-and-table-parser';
import { splitMixedScriptSegments } from './exam-typography';
import type { SmartReaderViewUnit } from './reader-page-grouper';

// ISO A4 in twips for Written & Prose documents (210mm x 297mm = 8.268" x 11.693")
const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;
// Narrow margin = 0.5 inch (12.7 mm) = 720 twips
const NARROW_MARGIN_TWIPS = 720;
const A4_USABLE_WIDTH_TWIPS = A4_WIDTH_TWIPS - NARROW_MARGIN_TWIPS * 2; // 10466 twips

// Exact MCQ Word Tab Stops: 0.35" L, 1" L, 1.75" L, 2.5" L, 3.35" R
const MCQ_WORD_TAB_STOPS = MCQ_PAGE_MAKEUP_SPEC.tabs.stops.map((stop) => ({
  type: stop.alignment === 'right' ? TabStopType.RIGHT : TabStopType.LEFT,
  position: stop.positionTwips,
}));

// Deterministic 1-column 2-up option tab stops: 0.35" L for a)/c), 3.50" L (5040 twips) for b)/d)
const MCQ_1COL_OPTION_TAB_STOPS = [
  { type: TabStopType.LEFT, position: MCQ_PAGE_MAKEUP_SPEC.paragraph.hangingIndentTwips },
  { type: TabStopType.LEFT, position: 5040 },
];

const MCQ_HANGING_TWIPS = MCQ_PAGE_MAKEUP_SPEC.paragraph.hangingIndentTwips; // 504 (0.35")
const MCQ_LINE_SPACING = {
  before: MCQ_PAGE_MAKEUP_SPEC.paragraph.spaceBeforeTwips, // 0pt
  after: MCQ_PAGE_MAKEUP_SPEC.paragraph.spaceAfterTwips, // 0pt
  line: MCQ_PAGE_MAKEUP_SPEC.paragraph.lineSpacingWordAuto, // 288 (Multiple 1.2)
  lineRule: LineRuleType.AUTO,
};

function makeTabRuns(count: number): TextRun[] {
  const safeCount = Math.max(1, count);
  const runs: TextRun[] = [];
  for (let i = 0; i < safeCount; i += 1) {
    runs.push(new TextRun({ children: [new Tab()] }));
  }
  return runs;
}

export interface ExamWordExportOptions extends ExamExportOptions {
  /** Apply full Justify alignment (`AlignmentType.BOTH`) to questions, explanations, and body paragraphs. Default: true. */
  justifyText?: boolean;
}

const TABLE_CELL_BORDER = {
  style: BorderStyle.SINGLE,
  size: 5,
  color: '475569',
};

const TABLE_HEADER_BORDER = {
  style: BorderStyle.SINGLE,
  size: 7,
  color: '0F172A',
};

function toDocxAlignment(align?: TableAlignment) {
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right') return AlignmentType.RIGHT;
  return AlignmentType.LEFT;
}

/**
 * Converts rich inline text (`**bold**`, `*italic*`, `<u>underline</u>`, mixed Bengali/English)
 * into authentic Microsoft Word `TextRun` objects using SolaimanLipi (11pt) for Bengali
 * and Times New Roman (12pt) for English.
 */
function buildRichTextRuns(
  rawText: string,
  options?: {
    baseBold?: boolean;
    baseColor?: string;
    sizeScale?: number;
  }
): TextRun[] {
  const cleaned = formatMathForPlainText(rawText ?? '');
  if (!cleaned) return [];

  const baseBold = options?.baseBold ?? false;
  const baseColor = options?.baseColor ?? '0F172A';
  const scale = options?.sizeScale ?? 1;

  const spans = parseInlineRichText(cleaned);
  const runs: TextRun[] = [];

  for (const span of spans) {
    const segments = splitMixedScriptSegments(span.text);
    for (const seg of segments) {
      const isEn = seg.script === 'en';
      // Word font size is in half-points: 11pt BN = 22, 12pt EN = 24
      const halfPtSize = Math.round((isEn ? 24 : 22) * scale);
      runs.push(
        new TextRun({
          text: seg.text,
          font: isEn ? 'Times New Roman' : 'SolaimanLipi',
          size: halfPtSize,
          bold: baseBold || span.bold,
          italics: span.italic,
          underline: span.underline ? { type: UnderlineType.SINGLE } : undefined,
          color: baseColor,
        })
      );
    }
  }

  return runs;
}

function buildDocxDataTable(
  table: ParsedMarkdownTable,
  indented: boolean
): Table {
  const colCount = Math.max(1, table.headers.length);
  const colWidthPct = Math.floor(100 / colCount);

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: table.headers.map((headerText, idx) =>
      new TableCell({
        width: { size: colWidthPct, type: WidthType.PERCENTAGE },
        shading: {
          type: ShadingType.CLEAR,
          color: 'auto',
          fill: 'F1F5F9',
        },
        borders: {
          top: TABLE_HEADER_BORDER,
          bottom: TABLE_HEADER_BORDER,
          left: TABLE_HEADER_BORDER,
          right: TABLE_HEADER_BORDER,
        },
        margins: { top: 45, bottom: 45, left: 75, right: 75 },
        children: [
          new Paragraph({
            alignment: toDocxAlignment(table.alignments[idx]),
            spacing: { before: 10, after: 10, line: 240 },
            children: buildRichTextRuns(headerText, {
              baseBold: true,
              baseColor: '0F172A',
              sizeScale: 0.88,
            }),
          }),
        ],
      })
    ),
  });

  const bodyRows = table.rows.map((row, rIdx) =>
    new TableRow({
      cantSplit: true,
      children: table.headers.map((_, cIdx) =>
        new TableCell({
          width: { size: colWidthPct, type: WidthType.PERCENTAGE },
          shading:
            rIdx % 2 === 1
              ? {
                  type: ShadingType.CLEAR,
                  color: 'auto',
                  fill: 'F8FAFC',
                }
              : undefined,
          borders: {
            top: TABLE_CELL_BORDER,
            bottom: TABLE_CELL_BORDER,
            left: TABLE_CELL_BORDER,
            right: TABLE_CELL_BORDER,
          },
          margins: { top: 40, bottom: 40, left: 75, right: 75 },
          children: [
            new Paragraph({
              alignment: toDocxAlignment(table.alignments[cIdx]),
              spacing: { before: 10, after: 10, line: 240 },
              children: buildRichTextRuns(row[cIdx] ?? '', {
                baseColor: '0F172A',
                sizeScale: 0.88,
              }),
            }),
          ],
        })
      ),
    })
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    indent: indented ? { size: 280, type: WidthType.DXA } : undefined,
    rows: [headerRow, ...bodyRows],
  });
}

function buildMcqTabbedOptionParagraphs(
  rows: Array<Array<{ marker: string; text: string }>>,
  columns: 1 | 2,
  bodyAlign: (typeof AlignmentType)[keyof typeof AlignmentType],
  inlineAnswer?: InlineOptionAnswerAttachment,
  lineSpacingSpec: {
    before: number;
    after: number;
    line: number;
    lineRule: (typeof LineRuleType)[keyof typeof LineRuleType];
  } = MCQ_LINE_SPACING,
  pageColumns: 1 | 2 = 2
): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  rows.forEach((optRow, rIdx) => {
    const isLastRow = rIdx === rows.length - 1;
    const rowInlineAnswer = isLastRow ? inlineAnswer : undefined;

    if (columns === 2) {
      const firstOpt = optRow[0];
      const secondOpt = optRow[1];
      const children: TextRun[] = [];
      const isSingleColPage = pageColumns === 1;

      if (firstOpt) {
        children.push(...makeTabRuns(1)); // Jump 0" -> 0.35" Left
        children.push(
          new TextRun({
            text: `${firstOpt.marker} `,
            font: /[A-Za-z]/.test(firstOpt.marker) ? 'Times New Roman' : 'SolaimanLipi',
            size: /[A-Za-z]/.test(firstOpt.marker) ? 23 : 21,
            bold: false,
            color: '0F172A',
          }),
          ...buildRichTextRuns(firstOpt.text, {
            baseColor: '0F172A',
            sizeScale: 0.96,
          })
        );
      }

      if (secondOpt) {
        const tabsToCol2 = isSingleColPage
          ? firstOpt
            ? 1 // Single deterministic jump from end of a)/c) directly to 3.50" Left
            : 2 // 0" -> 0.35" -> 3.50"
          : firstOpt
            ? computeMcqTabCountToTargetStop(
                0.35,
                `${firstOpt.marker} ${firstOpt.text}`,
                1.75
              )
            : 3; // 0" -> 0.35" -> 1" -> 1.75"
        children.push(...makeTabRuns(tabsToCol2));
        children.push(
          new TextRun({
            text: `${secondOpt.marker} `,
            font: /[A-Za-z]/.test(secondOpt.marker) ? 'Times New Roman' : 'SolaimanLipi',
            size: /[A-Za-z]/.test(secondOpt.marker) ? 23 : 21,
            bold: false,
            color: '0F172A',
          }),
          ...buildRichTextRuns(secondOpt.text, {
            baseColor: '0F172A',
            sizeScale: 0.96,
          })
        );
      }

      if (rowInlineAnswer && !isSingleColPage) {
        const tabsToRightEdge = secondOpt
          ? computeMcqTabCountToTargetStop(
              1.75,
              `${secondOpt.marker} ${secondOpt.text}`,
              3.35
            )
          : firstOpt
            ? computeMcqTabCountToTargetStop(
                0.35,
                `${firstOpt.marker} ${firstOpt.text}`,
                3.35
              )
            : 1;
        children.push(...makeTabRuns(tabsToRightEdge));
        children.push(
          new TextRun({
            text: `${rowInlineAnswer.label}: `,
            font: 'SolaimanLipi',
            size: 20,
            bold: true,
            color: 'B91C1C',
          }),
          ...buildRichTextRuns(rowInlineAnswer.text, {
            baseBold: true,
            baseColor: '0F172A',
            sizeScale: 0.94,
          })
        );
      }

      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          widowControl: true,
          indent: { left: MCQ_HANGING_TWIPS, hanging: MCQ_HANGING_TWIPS },
          spacing: lineSpacingSpec,
          tabStops: isSingleColPage ? MCQ_1COL_OPTION_TAB_STOPS : MCQ_WORD_TAB_STOPS,
          children,
        })
      );
      return;
    }

    const opt = optRow[0];
    if (!opt) return;
    const children: TextRun[] = [
      ...makeTabRuns(1), // Jump 0" -> 0.35" Left
      new TextRun({
        text: `${opt.marker} `,
        font: /[A-Za-z]/.test(opt.marker) ? 'Times New Roman' : 'SolaimanLipi',
        size: /[A-Za-z]/.test(opt.marker) ? 23 : 21,
        bold: false,
        color: '0F172A',
      }),
      ...buildRichTextRuns(opt.text, {
        baseColor: '0F172A',
        sizeScale: 0.96,
      }),
    ];

    if (rowInlineAnswer) {
      const tabsToRight = computeMcqTabCountToTargetStop(
        0.35,
        `${opt.marker} ${opt.text}`,
        3.35
      );
      children.push(
        ...makeTabRuns(tabsToRight),
        new TextRun({
          text: `${rowInlineAnswer.label}: `,
          font: 'SolaimanLipi',
          size: 20,
          bold: true,
          color: 'B91C1C',
        }),
        ...buildRichTextRuns(rowInlineAnswer.text, {
          baseBold: true,
          baseColor: '0F172A',
          sizeScale: 0.94,
        })
      );
    }

    paragraphs.push(
      new Paragraph({
        alignment: rowInlineAnswer ? AlignmentType.LEFT : bodyAlign,
        widowControl: true,
        indent: { left: MCQ_HANGING_TWIPS, hanging: MCQ_HANGING_TWIPS },
        spacing: lineSpacingSpec,
        tabStops: MCQ_WORD_TAB_STOPS,
        children,
      })
    );
  });

  return paragraphs;
}

function buildMastheadChildren(
  rawHeaderLines: string[],
  fallbackTitle: string,
  usableWidthTwips: number
): Paragraph[] {
  const masthead = parseStructuredExamHeader(
    rawHeaderLines.length > 0 ? rawHeaderLines : [fallbackTitle]
  );
  const children: Paragraph[] = [];

  const titles =
    masthead.titleLines.length > 0 ? masthead.titleLines : [fallbackTitle];

  titles.forEach((line, idx) => {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: idx === 0 ? 0 : 25, after: 25 },
        children: [
          new TextRun({
            text: line,
            font: 'SolaimanLipi',
            size: idx === 0 ? 31 : 25,
            bold: true,
            color: '0F172A',
          }),
        ],
      })
    );
  });

  if (masthead.postLine) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 15, after: 30 },
        children: [
          new TextRun({
            text: masthead.postLine,
            font: 'SolaimanLipi',
            size: 24,
            bold: true,
            color: '0F172A',
          }),
        ],
      })
    );
  }

  for (const extra of masthead.otherMetaLines) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 15, after: 25 },
        children: [
          new TextRun({
            text: extra,
            font: 'SolaimanLipi',
            size: 21,
            bold: true,
            color: '1E293B',
          }),
        ],
      })
    );
  }

  if (masthead.timeText || masthead.dateText || masthead.marksText) {
    children.push(
      new Paragraph({
        tabStops: [
          { type: TabStopType.CENTER, position: Math.floor(usableWidthTwips / 2) },
          { type: TabStopType.RIGHT, position: usableWidthTwips },
        ],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 8, color: '0F172A', space: 4 },
        },
        spacing: { before: 40, after: 90 },
        children: [
          new TextRun({
            text: `${masthead.timeText || ''}\t${masthead.dateText || ''}\t${masthead.marksText || ''}`,
            font: 'SolaimanLipi',
            size: 21,
            bold: true,
            color: '0F172A',
          }),
        ],
      })
    );
  } else {
    children.push(
      new Paragraph({
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 8, color: '0F172A', space: 4 },
        },
        spacing: { before: 20, after: 90 },
        children: [],
      })
    );
  }

  return children;
}

/**
 * Generates an authentic, editable Microsoft Word (`.docx`) exam document:
 * - ISO A4 page size (210mm x 297mm) with Narrow margins (0.5 inch / 12.7mm)
 * - Supports 1-column or Original 2-column exam layout (with full-width centered masthead)
 * - Justify alignment for all questions, explanations, and body text (configurable)
 * - Preserves **Bold**, *Italic*, <u>Underline</u>, adaptive 2-per-row MCQ options, and native Word Tables!
 */
export async function buildStructuredExamDocxBytes(
  units: SmartReaderViewUnit[],
  options: ExamWordExportOptions
): Promise<Uint8Array> {
  const requestedColumns: 1 | 2 = options.layoutColumns === 2 ? 2 : 1;
  const justifyText = options.justifyText !== false;
  const bodyAlign = justifyText ? AlignmentType.BOTH : AlignmentType.LEFT;

  const standardA4PageProperties = {
    size: {
      width: A4_WIDTH_TWIPS,
      height: A4_HEIGHT_TWIPS,
    },
    margin: {
      top: NARROW_MARGIN_TWIPS,
      bottom: NARROW_MARGIN_TWIPS,
      left: NARROW_MARGIN_TWIPS,
      right: NARROW_MARGIN_TWIPS,
      gutter: 0,
      header: 360,
      footer: 360,
    },
  };

  const mcqLetterPageProperties = {
    size: {
      width: MCQ_PAGE_MAKEUP_SPEC.paper.widthTwips, // 8.5" = 12240 twips
      height: MCQ_PAGE_MAKEUP_SPEC.paper.heightTwips, // 11" = 15840 twips
    },
    margin: {
      top: MCQ_PAGE_MAKEUP_SPEC.margins.topTwips, // 0.5" = 720 twips
      bottom: MCQ_PAGE_MAKEUP_SPEC.margins.bottomTwips, // 0.5" = 720 twips
      left: MCQ_PAGE_MAKEUP_SPEC.margins.leftTwips, // 0.8" = 1152 twips
      right: MCQ_PAGE_MAKEUP_SPEC.margins.rightTwips, // 0.8" = 1152 twips
      gutter: MCQ_PAGE_MAKEUP_SPEC.margins.gutterTwips, // 0" = 0 twips
      header: MCQ_PAGE_MAKEUP_SPEC.margins.headerFromEdgeTwips, // 0.45" = 648 twips
      footer: MCQ_PAGE_MAKEUP_SPEC.margins.footerFromEdgeTwips, // 0.45" = 648 twips
    },
  };

  const sections: ISectionOptions[] = [];

  for (let uIdx = 0; uIdx < units.length; uIdx += 1) {
    const unit = units[uIdx];
    const parsed = applyExamExportOptionsToDocument(unit.content, options);
    const isMcqUnit = isMcqExamDocument(parsed, options.bookTitle);
    // Strict scope: 8.5x11 2-column MCQ makeup applies ONLY to MCQ papers, NEVER to Written
    const effectiveColumns: 1 | 2 = isMcqUnit ? requestedColumns : 1;
    const unitPageProperties = isMcqUnit
      ? mcqLetterPageProperties
      : standardA4PageProperties;
    const unitUsableWidthTwips = isMcqUnit
      ? MCQ_PAGE_MAKEUP_SPEC.columns.usableFullWidthTwips // 9936 twips (6.9")
      : A4_USABLE_WIDTH_TWIPS;

    const runningTitle = `${options.bookTitle} · ${unit.pageLabel}`;

    const runningHeader = new Header({
      children: [
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: unitUsableWidthTwips }],
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 8, color: '0F172A', space: 3 },
          },
          children: [
            new TextRun({
              text: `${runningTitle}\tবিভিন্ন নিয়োগ পরীক্ষার প্রশ্নোত্তর`,
              font: 'SolaimanLipi',
              size: 18,
              color: '0F172A',
            }),
          ],
        }),
      ],
    });

    const runningFooter = new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          border: {
            top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1', space: 3 },
          },
          children: [
            new TextRun({
              text: 'পৃষ্ঠা ',
              font: 'SolaimanLipi',
              size: 17,
              color: '334155',
            }),
            new TextRun({
              children: [PageNumber.CURRENT],
              font: 'Times New Roman',
              size: 17,
              color: '334155',
            }),
            new TextRun({
              text: ' / ',
              font: 'Times New Roman',
              size: 17,
              color: '64748B',
            }),
            new TextRun({
              children: [PageNumber.TOTAL_PAGES],
              font: 'Times New Roman',
              size: 17,
              color: '334155',
            }),
          ],
        }),
      ],
    });

    const bodyChildren: Array<Paragraph | Table> = [];
    const blockIndentTwips = isMcqUnit ? MCQ_HANGING_TWIPS : 280;
    const blockTabStops = isMcqUnit ? MCQ_WORD_TAB_STOPS : undefined;
    const blockSpacing = isMcqUnit
      ? MCQ_LINE_SPACING
      : { before: 20, after: 40, line: 275, lineRule: LineRuleType.AUTO };

    if (!parsed.isExam) {
      const blocks = splitTextBlocksWithTables(parsed.formatted);
      for (const block of blocks) {
        if (block.kind === 'blank') {
          bodyChildren.push(new Paragraph({ spacing: { before: 30, after: 30 } }));
          continue;
        }
        if (block.kind === 'table') {
          bodyChildren.push(buildDocxDataTable(block.table, false));
          bodyChildren.push(new Paragraph({ spacing: { before: 0, after: 60 } }));
          continue;
        }
        bodyChildren.push(
          new Paragraph({
            alignment: bodyAlign,
            widowControl: true,
            spacing: { before: 30, after: 60, line: 275, lineRule: LineRuleType.AUTO },
            children: buildRichTextRuns(block.text, { baseColor: '0F172A' }),
          })
        );
      }
    } else {
      const maxCharsPerHalfRow =
        effectiveColumns === 2
          ? EDITORIAL_2COL_OPTION_MAX_CHARS
          : EDITORIAL_1COL_OPTION_MAX_CHARS;
      const grouped = groupDisplayItemsWithOptionBlocks(
        parsed.bodyItems,
        maxCharsPerHalfRow
      );
      // Always keep Answer/উত্তর as its own paragraph directly below the options
      const displayBlocks: McqEnhancedDisplayBlock[] = grouped;

      const renderBlocksWithSpacing = (
        blocksToRender: McqEnhancedDisplayBlock[],
        activeMcqLineSpacing: number,
        leadingBreak?: 'column' | 'page'
      ) => {
        const activeSpacing = isMcqUnit
          ? {
              before: 0,
              after: 0,
              line: Math.round(activeMcqLineSpacing * 240),
              lineRule: LineRuleType.AUTO,
            }
          : blockSpacing;
        // Subtle 72-twip (0.05") right breathing cushion on MCQ body text so justified lines never touch the center divider
        const mcqRightBuffer = isMcqUnit && effectiveColumns === 2 ? 72 : 0;
        let pendingBreak = leadingBreak;

        const consumeParagraphBreakProps = () => {
          if (!pendingBreak) {
            return {
              pageBreakBefore: undefined,
              prefixRuns: [] as Array<TextRun | ColumnBreak>,
            };
          }
          if (pendingBreak === 'page') {
            pendingBreak = undefined;
            return {
              pageBreakBefore: true,
              prefixRuns: [] as Array<TextRun | ColumnBreak>,
            };
          }
          pendingBreak = undefined;
          return {
            pageBreakBefore: undefined,
            prefixRuns: [new ColumnBreak()] as Array<TextRun | ColumnBreak>,
          };
        };

        for (const block of blocksToRender) {
          switch (block.kind) {
            case 'spacer':
              break;
            case 'question': {
              const brk = consumeParagraphBreakProps();
              bodyChildren.push(
                new Paragraph({
                  alignment: bodyAlign,
                  widowControl: true,
                  keepNext: true,
                  pageBreakBefore: brk.pageBreakBefore,
                  indent: isMcqUnit
                    ? {
                        left: MCQ_HANGING_TWIPS,
                        hanging: MCQ_HANGING_TWIPS,
                        right: mcqRightBuffer,
                      }
                    : { left: 280, hanging: 280 },
                  spacing: isMcqUnit
                    ? activeSpacing
                    : { before: 80, after: 30, line: 275, lineRule: LineRuleType.AUTO },
                  tabStops: blockTabStops,
                  children: [
                    ...brk.prefixRuns,
                    new TextRun({
                      text: isMcqUnit ? block.numberLabel : `${block.numberLabel} `,
                      font:
                        /[0-9]/.test(block.numberLabel) &&
                        !/[০-৯]/.test(block.numberLabel)
                          ? 'Times New Roman'
                          : 'SolaimanLipi',
                      size:
                        /[0-9]/.test(block.numberLabel) &&
                        !/[০-৯]/.test(block.numberLabel)
                          ? 23
                          : 21,
                      bold: true,
                      color: '0F172A',
                    }),
                    ...(isMcqUnit ? makeTabRuns(1) : []),
                    ...buildRichTextRuns(block.text, {
                      baseBold: isMcqUnit,
                      baseColor: '0F172A',
                      sizeScale: 0.96,
                    }),
                  ],
                })
              );
              break;
            }
            case 'option_group':
              if (isMcqUnit) {
                bodyChildren.push(
                  ...buildMcqTabbedOptionParagraphs(
                    block.rows,
                    block.columns,
                    bodyAlign,
                    undefined,
                    activeSpacing,
                    effectiveColumns
                  )
                );
              } else {
                for (const opt of block.options) {
                  bodyChildren.push(
                    new Paragraph({
                      alignment: bodyAlign,
                      widowControl: true,
                      indent: { left: 280 },
                      spacing: { before: 15, after: 15, line: 270, lineRule: LineRuleType.AUTO },
                      children: [
                        new TextRun({
                          text: `${opt.marker} `,
                          font: /[A-Za-z]/.test(opt.marker)
                            ? 'Times New Roman'
                            : 'SolaimanLipi',
                          size: /[A-Za-z]/.test(opt.marker) ? 23 : 21,
                          bold: false,
                          color: '0F172A',
                        }),
                        ...buildRichTextRuns(opt.text, {
                          baseColor: '0F172A',
                          sizeScale: 0.96,
                        }),
                      ],
                    })
                  );
                }
              }
              break;
            case 'option':
              bodyChildren.push(
                new Paragraph({
                  alignment: bodyAlign,
                  widowControl: true,
                  indent: isMcqUnit
                    ? {
                        left: MCQ_HANGING_TWIPS,
                        hanging: MCQ_HANGING_TWIPS,
                        right: mcqRightBuffer,
                      }
                    : { left: 280 },
                  spacing: activeSpacing,
                  tabStops: blockTabStops,
                  children: [
                    ...(isMcqUnit ? makeTabRuns(1) : []),
                    new TextRun({
                      text: `${block.marker} `,
                      font: /[A-Za-z]/.test(block.marker)
                        ? 'Times New Roman'
                        : 'SolaimanLipi',
                      size: /[A-Za-z]/.test(block.marker) ? 23 : 21,
                      bold: false,
                      color: '0F172A',
                    }),
                    ...buildRichTextRuns(block.text, {
                      baseColor: '0F172A',
                      sizeScale: 0.96,
                    }),
                  ],
                })
              );
              break;
            case 'solution':
              bodyChildren.push(
                new Paragraph({
                  alignment: AlignmentType.LEFT,
                  widowControl: true,
                  indent: { left: blockIndentTwips, right: mcqRightBuffer },
                  spacing: activeSpacing,
                  tabStops: blockTabStops,
                  children: [
                    new TextRun({
                      text: `${block.label}: `,
                      font: 'SolaimanLipi',
                      size: 21,
                      bold: true,
                      color: 'B91C1C',
                    }),
                    ...buildRichTextRuns(block.text, {
                      baseBold: true,
                      baseColor: '0F172A',
                      sizeScale: 0.96,
                    }),
                  ],
                })
              );
              break;
            case 'explanation':
              bodyChildren.push(
                new Paragraph({
                  alignment: bodyAlign,
                  widowControl: true,
                  indent: { left: blockIndentTwips, right: mcqRightBuffer },
                  spacing: activeSpacing,
                  tabStops: blockTabStops,
                  children: [
                    new TextRun({
                      text: `${block.label}: `,
                      font: 'SolaimanLipi',
                      size: 20,
                      bold: true,
                      color: '9F1239',
                    }),
                    ...buildRichTextRuns(block.text, {
                      baseColor: '1E293B',
                      sizeScale: 0.93,
                    }),
                  ],
                })
              );
              break;
            case 'table':
              bodyChildren.push(
                buildDocxDataTable(
                  {
                    headers: block.headers,
                    alignments: block.alignments,
                    rows: block.rows,
                  },
                  block.indented
                )
              );
              bodyChildren.push(
                new Paragraph({ spacing: { before: 0, after: isMcqUnit ? 15 : 30 } })
              );
              break;
            case 'ai_badge':
              bodyChildren.push(
                new Paragraph({
                  widowControl: true,
                  indent: { left: blockIndentTwips },
                  spacing: activeSpacing,
                  children: [
                    new TextRun({
                      text: `★ ${block.text}`,
                      font: 'SolaimanLipi',
                      size: 18,
                      bold: true,
                      color: '92400E',
                    }),
                  ],
                })
              );
              break;
            case 'reference':
              bodyChildren.push(
                new Paragraph({
                  alignment: AlignmentType.LEFT,
                  widowControl: true,
                  indent: { left: blockIndentTwips, right: mcqRightBuffer },
                  spacing: activeSpacing,
                  children: [
                    new TextRun({
                      text: `${block.label}: ${block.text}`,
                      font: 'SolaimanLipi',
                      size: 18,
                      color: '334155',
                    }),
                  ],
                })
              );
              break;
            case 'highlight':
              bodyChildren.push(
                new Paragraph({
                  alignment: bodyAlign,
                  widowControl: true,
                  indent: { left: blockIndentTwips, right: mcqRightBuffer },
                  spacing: activeSpacing,
                  tabStops: blockTabStops,
                  children: [
                    new TextRun({
                      text: 'হাইলাইট: ',
                      font: 'SolaimanLipi',
                      size: 20,
                      bold: true,
                      color: 'B91C1C',
                    }),
                    ...buildRichTextRuns(block.text, {
                      baseColor: '7F1D1D',
                      sizeScale: 0.92,
                    }),
                  ],
                })
              );
              break;
            case 'center_block':
              block.lines.forEach((line, lIdx) => {
                const brk =
                  lIdx === 0
                    ? consumeParagraphBreakProps()
                    : {
                        pageBreakBefore: undefined,
                        prefixRuns: [] as Array<TextRun | ColumnBreak>,
                      };
                bodyChildren.push(
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    widowControl: true,
                    keepNext: true,
                    pageBreakBefore: brk.pageBreakBefore,
                    spacing: isMcqUnit
                      ? activeSpacing
                      : {
                          before: lIdx === 0 ? 80 : 15,
                          after: lIdx === block.lines.length - 1 ? 60 : 15,
                          line: 255,
                        },
                    children: [
                      ...brk.prefixRuns,
                      ...buildRichTextRuns(line, {
                        baseBold: true,
                        baseColor: '0F172A',
                        sizeScale: lIdx === 0 ? 1.05 : 0.96,
                      }),
                    ],
                  })
                );
              });
              break;
            case 'diagram':
              bodyChildren.push(
                new Paragraph({
                  alignment: bodyAlign,
                  widowControl: true,
                  indent: { left: blockIndentTwips, right: mcqRightBuffer },
                  shading: {
                    type: ShadingType.CLEAR,
                    color: 'auto',
                    fill: 'F8FAFC',
                  },
                  border: {
                    top: { style: BorderStyle.DASHED, size: 5, color: '64748B', space: 3 },
                    bottom: { style: BorderStyle.DASHED, size: 5, color: '64748B', space: 3 },
                    left: { style: BorderStyle.DASHED, size: 5, color: '64748B', space: 5 },
                    right: { style: BorderStyle.DASHED, size: 5, color: '64748B', space: 3 },
                  },
                  spacing: activeSpacing,
                  children: [
                    new TextRun({
                      text: 'প্রশ্নের চিত্র: ',
                      font: 'SolaimanLipi',
                      size: 19,
                      bold: true,
                      color: '0F172A',
                    }),
                    ...buildRichTextRuns(block.caption, {
                      baseColor: '1E293B',
                      sizeScale: 0.92,
                    }),
                  ],
                })
              );
              break;
            case 'image':
              bodyChildren.push(
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  widowControl: true,
                  spacing: activeSpacing,
                  children: [
                    new TextRun({
                      text: `[চিত্র: ${block.alt || 'সংযুক্ত ডায়াগ্রাম'}]`,
                      font: 'SolaimanLipi',
                      size: 19,
                      italics: true,
                      color: '334155',
                    }),
                  ],
                })
              );
              break;
            case 'math':
              bodyChildren.push(
                new Paragraph({
                  alignment: AlignmentType.LEFT,
                  widowControl: true,
                  indent: { left: blockIndentTwips, right: mcqRightBuffer },
                  spacing: activeSpacing,
                  tabStops: blockTabStops,
                  children: buildRichTextRuns(block.text, {
                    baseColor: '0F172A',
                    sizeScale: 0.96,
                  }),
                })
              );
              break;
            case 'text':
              if (isExamSubjectHeadingLine(block.text)) {
                const brk = consumeParagraphBreakProps();
                bodyChildren.push(
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    widowControl: true,
                    keepNext: true,
                    pageBreakBefore: brk.pageBreakBefore,
                    indent: isMcqUnit
                      ? { left: MCQ_HANGING_TWIPS, hanging: MCQ_HANGING_TWIPS }
                      : undefined,
                    spacing: isMcqUnit
                      ? activeSpacing
                      : { before: 80, after: 35, line: 260, lineRule: LineRuleType.AUTO },
                    tabStops: blockTabStops,
                    children: [
                      ...brk.prefixRuns,
                      ...buildRichTextRuns(block.text, {
                        baseBold: true,
                        baseColor: '0F172A',
                        sizeScale: 1.04,
                      }),
                    ],
                  })
                );
              } else {
                const brk = consumeParagraphBreakProps();
                bodyChildren.push(
                  new Paragraph({
                    alignment: bodyAlign,
                    widowControl: true,
                    pageBreakBefore: brk.pageBreakBefore,
                    indent: block.indented
                      ? { left: blockIndentTwips, right: mcqRightBuffer }
                      : mcqRightBuffer > 0
                        ? { right: mcqRightBuffer }
                        : undefined,
                    spacing: activeSpacing,
                    tabStops: blockTabStops,
                    children: [
                      ...brk.prefixRuns,
                      ...buildRichTextRuns(block.text, {
                        baseColor: '0F172A',
                        sizeScale: 0.96,
                      }),
                    ],
                  })
                );
              }
              break;
          }
        }
      };

      if (isMcqUnit) {
        const clusters = clusterExamBlocksByQuestion(displayBlocks);
        const clusterMetrics = clusters.map((c) =>
          estimateMcqClusterWordMetricsPt(c, effectiveColumns)
        );
        // Letter 11" = 792pt; minus 0.5" top + 0.5" bottom (72pt) - ~36pt header/footer = 684pt usable body
        const adaptivePages = optimizeMcqAdaptivePagination({
          headerHeight: options.includeHeader ? 72 : 0,
          items: clusterMetrics,
          pageContentHeight: 684,
          layoutMode: effectiveColumns === 2 ? 'double' : 'single',
          itemGap: 1.5,
          minLineSpacing: 1.0,
          maxLineSpacing: 1.5,
          preferredLineSpacing: 1.2,
        });

        adaptivePages.forEach((ap, pageIdx) => {
          const col1Blocks = ap.col1Indices.flatMap((idx) => clusters[idx].blocks);
          const col2Blocks = ap.col2Indices.flatMap((idx) => clusters[idx].blocks);

          if (col1Blocks.length > 0) {
            renderBlocksWithSpacing(
              col1Blocks,
              ap.col1LineSpacing,
              pageIdx > 0 ? 'page' : undefined
            );
          }
          if (effectiveColumns === 2 && col2Blocks.length > 0) {
            renderBlocksWithSpacing(
              col2Blocks,
              ap.col2LineSpacing,
              col1Blocks.length > 0 ? 'column' : pageIdx > 0 ? 'page' : undefined
            );
          }
        });
      } else {
        renderBlocksWithSpacing(displayBlocks, 1.2);
      }
    }

    const mcqTwoColConfig = {
      count: MCQ_PAGE_MAKEUP_SPEC.columns.count, // 2
      space: MCQ_PAGE_MAKEUP_SPEC.columns.spacingTwips, // 288 (0.2")
      separate: MCQ_PAGE_MAKEUP_SPEC.columns.lineBetween, // true
      equalWidth: MCQ_PAGE_MAKEUP_SPEC.columns.equalWidth, // true
    };

    if (options.includeHeader && effectiveColumns === 2 && isMcqUnit) {
      // Full-width centered exam masthead section, followed seamlessly by continuous 2-column MCQ body
      const mastheadParagraphs = buildMastheadChildren(
        parsed.isExam ? parsed.headerLines : [],
        unit.title,
        unitUsableWidthTwips
      );
      sections.push({
        properties: {
          type: uIdx === 0 ? undefined : SectionType.NEXT_PAGE,
          page: unitPageProperties,
        },
        headers: { default: runningHeader },
        footers: { default: runningFooter },
        children: mastheadParagraphs,
      });
      sections.push({
        properties: {
          type: SectionType.CONTINUOUS,
          page: unitPageProperties,
          column: mcqTwoColConfig,
        },
        headers: { default: runningHeader },
        footers: { default: runningFooter },
        children:
          bodyChildren.length > 0 ? bodyChildren : [new Paragraph({ children: [] })],
      });
    } else {
      const combinedChildren: Array<Paragraph | Table> = [];
      if (options.includeHeader) {
        combinedChildren.push(
          ...buildMastheadChildren(
            parsed.isExam ? parsed.headerLines : [],
            unit.title,
            unitUsableWidthTwips
          )
        );
      }
      combinedChildren.push(...bodyChildren);

      sections.push({
        properties: {
          type: uIdx === 0 ? undefined : SectionType.NEXT_PAGE,
          page: unitPageProperties,
          column: effectiveColumns === 2 && isMcqUnit ? mcqTwoColConfig : undefined,
        },
        headers: { default: runningHeader },
        footers: { default: runningFooter },
        children:
          combinedChildren.length > 0
            ? combinedChildren
            : [new Paragraph({ children: [] })],
      });
    }
  }

  const doc = new Document({
    title: options.bookTitle || 'Exam Paper',
    creator: 'Prostuti AI',
    description: 'Publication Exam Paper (Editable Word Document)',
    defaultTabStop: MCQ_PAGE_MAKEUP_SPEC.tabs.defaultTabStopTwips, // 0.5" = 720 twips
    sections:
      sections.length > 0
        ? sections
        : [
            {
              properties: { page: standardA4PageProperties },
              children: [new Paragraph({ children: [] })],
            },
          ],
  });

  const arrayBuffer = await Packer.toArrayBuffer(doc);
  return new Uint8Array(arrayBuffer);
}
