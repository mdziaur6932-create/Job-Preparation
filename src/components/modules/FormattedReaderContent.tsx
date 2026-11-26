'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, ExternalLink, Scissors, Image as ImageIcon } from 'lucide-react';
import { parseExamDocumentForDisplay } from '@/src/lib/exam-text-formatter';
import {
  EDITORIAL_1COL_OPTION_MAX_CHARS,
  EDITORIAL_2COL_OPTION_MAX_CHARS,
  groupDisplayItemsWithOptionBlocks,
  isExamSubjectHeadingLine,
  parseStructuredExamHeader,
} from '@/src/lib/exam-option-layout';
import {
  isMcqExamDocument,
  MCQ_PAGE_MAKEUP_SPEC,
  type McqEnhancedDisplayBlock,
} from '@/src/lib/mcq-page-makeup-spec';
import {
  splitTextBlocksWithTables,
  type RichContentBlock,
  type TableAlignment,
} from '@/src/lib/rich-text-and-table-parser';
import {
  DEFAULT_A4_CONTENT_HEIGHT_PX,
  paginateMeasuredBlocksIntoA4Pages,
  type PaginatedA4Page,
} from '@/src/lib/a4-page-paginator';
import {
  clusterExamBlocksByQuestion,
  optimizeMcqAdaptivePagination,
  type ExamQuestionCluster,
  type McqAdaptivePage,
} from '@/src/lib/mcq-adaptive-pagination';
import { toBengaliNumber } from '@/src/lib/file-validation';
import { KatexMathText } from './KatexMathText';

export type A4ReaderLayoutMode = 'single' | 'double';

interface FormattedReaderContentProps {
  content: string;
  layoutMode?: A4ReaderLayoutMode;
  hideAnswers?: boolean;
  justifyText?: boolean;
  fontSizeScale?: number;
  runningHeaderTitle?: string;
  pageLabel?: string;
  printableId?: string;
  onPageCountChange?: (pageCount: number) => void;
}

/**
 * Renders inline mathematical expressions + rich bold/italic/underline emphasis.
 */
function RichMathText({
  text,
  examTypography = true,
}: {
  text: string;
  examTypography?: boolean;
}) {
  return <KatexMathText text={text} examTypography={examTypography} />;
}

function getMarkerScriptClass(marker: string): string {
  return /[A-Za-z0-9]/.test(marker) && !/[\u0980-\u09FF]/.test(marker)
    ? 'exam-text-en'
    : 'exam-text-bn';
}

function getAlignmentClass(align?: TableAlignment): string {
  if (align === 'center') return 'text-center';
  if (align === 'right') return 'text-right';
  return 'text-left';
}

function PublicationTable({
  headers,
  alignments,
  rows,
  examTypography = true,
  indented = false,
}: {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
  examTypography?: boolean;
  indented?: boolean;
}) {
  return (
    <div
      className={`${indented ? 'pl-[28px]' : ''} my-1.5 overflow-x-auto break-inside-avoid`}
    >
      <table
        data-testid="exam-formatted-table"
        className="w-full border-collapse border border-slate-700 bg-white text-slate-950 text-[12px] leading-[1.35]"
      >
        <thead>
          <tr className="bg-slate-100">
            {headers.map((header, hIdx) => (
              <th
                key={`th-${hIdx}`}
                className={`border border-slate-700 px-1.5 py-1 font-bold text-slate-950 align-top ${getAlignmentClass(alignments[hIdx])}`}
              >
                <RichMathText text={header} examTypography={examTypography} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            <tr
              key={`tr-${rIdx}`}
              className={rIdx % 2 === 1 ? 'bg-slate-50/40' : 'bg-white'}
            >
              {headers.map((_, cIdx) => (
                <td
                  key={`td-${rIdx}-${cIdx}`}
                  className={`border border-slate-500 px-1.5 py-0.5 text-slate-900 align-top ${getAlignmentClass(alignments[cIdx])}`}
                >
                  <RichMathText
                    text={row[cIdx] ?? ''}
                    examTypography={examTypography}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Renders `রেফারেন্স:` entries with clickable external links when URLs are present.
 */
function ReferenceLinks({ text }: { text: string }) {
  const segments = text
    .split(/\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {segments.map((seg, idx) => {
        const parenUrlMatch = seg.match(/^(.+?)\s*\((https?:\/\/[^\s)]+)\)$/);
        const bareUrlMatch = seg.match(/^(https?:\/\/\S+)$/);

        if (parenUrlMatch) {
          const [, title, url] = parenUrlMatch;
          return (
            <a
              key={idx}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900"
            >
              <span>{title.trim()}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          );
        }

        if (bareUrlMatch) {
          const url = bareUrlMatch[1];
          return (
            <a
              key={idx}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900 break-all"
            >
              <span>{url}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          );
        }

        return (
          <span key={idx} className="text-slate-700">
            {seg}
          </span>
        );
      })}
    </span>
  );
}

function renderQuestionClusterBody(
  cluster: ExamQuestionCluster,
  layoutMode: A4ReaderLayoutMode,
  justifyClass: string,
  isMcqMode: boolean
) {
  // Generous 0.38" hanging indent & number column with pr-2 gap so question numbers NEVER touch text
  const indentPlClass = isMcqMode ? 'pl-[0.38in]' : 'pl-[30px]';
  const numWidthClass = isMcqMode ? 'w-[0.38in]' : 'w-[30px]';

  return (
    <div
      data-testid="exam-question-cluster"
      className={
        isMcqMode
          ? 'break-inside-avoid space-y-0 min-w-0'
          : layoutMode === 'double'
            ? 'break-inside-avoid space-y-0.5 min-w-0'
            : 'break-inside-avoid space-y-1 min-w-0'
      }
    >
      {cluster.blocks.map((block, bIdx) => {
        switch (block.kind) {
          case 'spacer':
            return <div key={`sp-${bIdx}`} className="h-0.5" aria-hidden="true" />;
          case 'question':
            return (
              <div
                key={`q-${bIdx}`}
                className="flex items-baseline text-slate-950 min-w-0"
              >
                <span
                  data-testid="exam-question-number"
                  className={`${numWidthClass} shrink-0 pr-2 font-semibold tabular-nums text-slate-950 ${getMarkerScriptClass(block.numberLabel)}`}
                >
                  {block.numberLabel}
                </span>
                <span
                  className={`font-semibold text-slate-950 flex-1 min-w-0 break-words ${justifyClass}`}
                >
                  <RichMathText text={block.text} />
                </span>
              </div>
            );
          case 'option_group':
            return (
              <div
                key={`og-${bIdx}`}
                data-testid="mcq-option-group"
                data-columns={block.columns}
                className={`${indentPlClass} space-y-0 min-w-0`}
              >
                {block.rows.map((rowOpts, rIdx) => {
                  const isLastRow = rIdx === block.rows.length - 1;
                  const inlineAnswer = isLastRow ? block.inlineAnswer : undefined;

                  if (block.columns === 2) {
                    const firstOpt = rowOpts[0];
                    const secondOpt = rowOpts[1];
                    const useCompactDoubleMcqRow = isMcqMode && layoutMode === 'double';
                    return (
                      <div
                        key={`orow-${rIdx}`}
                        data-testid="mcq-option-row-2col"
                        className={
                          useCompactDoubleMcqRow
                            ? 'flex items-baseline text-slate-900 min-w-0'
                            : 'grid grid-cols-2 gap-x-8 items-baseline text-slate-900 min-w-0'
                        }
                      >
                        {firstOpt && (
                          <div
                            data-testid="mcq-option-cell-left"
                            className={`flex items-baseline gap-1 min-w-0 ${
                              useCompactDoubleMcqRow ? 'w-[1.34in] shrink-0 pr-1.5' : ''
                            }`}
                          >
                            <span
                              className={`shrink-0 font-normal text-slate-900 ${getMarkerScriptClass(firstOpt.marker)}`}
                            >
                              {firstOpt.marker}
                            </span>
                            <span className="min-w-0 break-words flex-1">
                              <RichMathText text={firstOpt.text} />
                            </span>
                          </div>
                        )}
                        {secondOpt && (
                          <div
                            data-testid="mcq-option-cell-right"
                            className={`flex items-baseline gap-1 min-w-0 ${
                              useCompactDoubleMcqRow ? 'flex-1' : ''
                            }`}
                          >
                            <span
                              className={`shrink-0 font-normal text-slate-900 ${getMarkerScriptClass(secondOpt.marker)}`}
                            >
                              {secondOpt.marker}
                            </span>
                            <span className="min-w-0 break-words flex-1">
                              <RichMathText text={secondOpt.text} />
                            </span>
                          </div>
                        )}
                        {inlineAnswer && (
                          <span
                            data-testid="exam-inline-answer"
                            className="ml-auto pl-2 shrink-0 text-right whitespace-nowrap"
                          >
                            <span className="font-bold text-[#B91C1C] exam-text-bn">
                              {inlineAnswer.label}:
                            </span>{' '}
                            <span
                              data-testid="exam-answer-text"
                              className="font-semibold text-slate-950"
                            >
                              <RichMathText text={inlineAnswer.text} />
                            </span>
                          </span>
                        )}
                      </div>
                    );
                  }

                  const opt = rowOpts[0];
                  return (
                    <div
                      key={`orow-${rIdx}`}
                      className="flex items-baseline gap-1 text-slate-900 min-w-0"
                    >
                      <span
                        className={`shrink-0 font-normal text-slate-900 ${getMarkerScriptClass(opt.marker)}`}
                      >
                        {opt.marker}
                      </span>
                      <span className={`min-w-0 break-words flex-1 ${inlineAnswer ? '' : justifyClass}`}>
                        <RichMathText text={opt.text} />
                      </span>
                      {inlineAnswer && (
                        <span
                          data-testid="exam-inline-answer"
                          className="ml-auto pl-2 shrink-0 text-right whitespace-nowrap"
                        >
                          <span className="font-bold text-[#B91C1C] exam-text-bn">
                            {inlineAnswer.label}:
                          </span>{' '}
                          <span
                            data-testid="exam-answer-text"
                            className="font-semibold text-slate-950"
                          >
                            <RichMathText text={inlineAnswer.text} />
                          </span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          case 'option':
            return (
              <div
                key={`opt-${bIdx}`}
                className={`${indentPlClass} flex items-baseline gap-1 text-slate-900`}
              >
                <span
                  className={`shrink-0 font-normal text-slate-900 ${getMarkerScriptClass(block.marker)}`}
                >
                  {block.marker}
                </span>
                <span className={`flex-1 ${justifyClass}`}>
                  <RichMathText text={block.text} />
                </span>
              </div>
            );
          case 'ai_badge':
            return (
              <div
                key={`aib-${bIdx}`}
                data-testid="ai-generated-answer-badge"
                className={`${indentPlClass} pt-0.5`}
              >
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800">
                  <Sparkles className="h-3 w-3 text-amber-700" />
                  <span>{block.text}</span>
                </span>
              </div>
            );
          case 'reference':
            return (
              <div
                key={`ref-${bIdx}`}
                data-testid="ai-answer-reference"
                className={`${indentPlClass} text-[11.5px] leading-[1.32] text-slate-600 flex flex-wrap items-baseline gap-1`}
              >
                <span className="shrink-0 font-semibold text-slate-700">
                  {block.label}:
                </span>
                <ReferenceLinks text={block.text} />
              </div>
            );
          case 'highlight':
            return (
              <div
                key={`hl-${bIdx}`}
                data-testid="red-lined-highlight"
                className={`${indentPlClass} pt-0.5 text-[12px] leading-[1.3] text-slate-900 ${justifyClass}`}
              >
                <span className="font-bold text-[#B91C1C]">হাইলাইট:</span>{' '}
                <RichMathText text={block.text} />
              </div>
            );
          case 'solution':
            return (
              <div
                key={`sol-${bIdx}`}
                data-testid="exam-answer-line"
                className={`${indentPlClass} flex items-baseline gap-1.5`}
              >
                <span className="shrink-0 font-bold text-[#B91C1C] exam-text-bn">
                  {block.label}:
                </span>
                <span
                  data-testid="exam-answer-text"
                  className={`font-semibold text-slate-950 flex-1 ${justifyClass}`}
                >
                  <RichMathText text={block.text} />
                </span>
              </div>
            );
          case 'explanation':
            return (
              <div
                key={`exp-${bIdx}`}
                data-testid="exam-explanation-block"
                className={`${indentPlClass} text-slate-800 ${justifyClass}`}
              >
                <span className="mr-1 font-bold text-[#9F1239] exam-text-bn">
                  {block.label}:
                </span>
                <span data-testid="exam-explanation-text">
                  <RichMathText text={block.text} />
                </span>
              </div>
            );
          case 'math':
            return (
              <div
                key={`math-${bIdx}`}
                className={`${indentPlClass} text-slate-900 leading-[1.35]`}
              >
                <RichMathText text={block.text} />
              </div>
            );
          case 'center_block':
            return (
              <div
                key={`ctr-${bIdx}`}
                data-testid="exam-centered-block"
                className="my-1.5 border-y border-slate-800/80 py-1.5 text-center space-y-0.5"
              >
                {block.lines.map((line, lIdx) => (
                  <div
                    key={`ctr-ln-${lIdx}`}
                    className={
                      lIdx === 0
                        ? 'font-bold text-slate-950 text-[14.5px]'
                        : 'font-semibold text-slate-900 text-[13px]'
                    }
                  >
                    <RichMathText text={line} />
                  </div>
                ))}
              </div>
            );
          case 'diagram':
            return (
              <div
                key={`diag-${bIdx}`}
                data-testid="exam-diagram-box"
                className="pl-[28px] my-1 break-inside-avoid"
              >
                <div className="rounded border border-dashed border-slate-500 bg-slate-50/70 px-2.5 py-1.5 text-[12px] leading-[1.4] text-slate-800">
                  <div className="mb-0.5 inline-flex items-center gap-1 font-bold text-slate-900">
                    <ImageIcon className="h-3 w-3 text-slate-700" />
                    <span>প্রশ্নের চিত্র:</span>
                  </div>
                  <div className={justifyClass}>
                    <RichMathText text={block.caption} />
                  </div>
                </div>
              </div>
            );
          case 'image':
            return (
              <figure
                key={`img-${bIdx}`}
                data-testid="exam-figure-image"
                className="pl-[28px] my-1.5 break-inside-avoid text-center"
              >
                <div className="inline-block bg-white p-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={block.src}
                    alt={block.alt}
                    className="max-h-48 max-w-full object-contain mx-auto"
                  />
                  {block.alt && block.alt !== 'প্রশ্নের চিত্র' && (
                    <figcaption className="mt-0.5 text-[11px] font-medium text-slate-600">
                      {block.alt}
                    </figcaption>
                  )}
                </div>
              </figure>
            );
          case 'table':
            return (
              <PublicationTable
                key={`tbl-${bIdx}`}
                headers={block.headers}
                alignments={block.alignments}
                rows={block.rows}
                examTypography
                indented={block.indented}
              />
            );
          case 'text':
            if (isExamSubjectHeadingLine(block.text)) {
              return (
                <div
                  key={`subj-${bIdx}`}
                  data-testid="exam-subject-heading"
                  className="pt-1.5 pb-0.5 text-center font-bold text-slate-950 text-[14px] leading-tight tracking-tight"
                >
                  <RichMathText text={block.text} />
                </div>
              );
            }
            return (
              <div
                key={`ln-${bIdx}`}
                className={`${block.indented ? 'pl-[28px]' : ''} text-slate-900 ${justifyClass}`}
              >
                <RichMathText text={block.text} />
              </div>
            );
        }
      })}
    </div>
  );
}

function renderNonExamBlock(block: RichContentBlock, justifyClass: string) {
  if (block.kind === 'blank') {
    return <div className="h-2" aria-hidden="true" />;
  }
  if (block.kind === 'table') {
    return (
      <PublicationTable
        headers={block.table.headers}
        alignments={block.table.alignments}
        rows={block.table.rows}
        examTypography={false}
      />
    );
  }
  return (
    <div className={`text-[15px] leading-8 text-slate-800 ${justifyClass}`}>
      <RichMathText text={block.text} examTypography={false} />
    </div>
  );
}

export function FormattedReaderContent({
  content,
  layoutMode = 'single',
  hideAnswers = false,
  justifyText = true,
  fontSizeScale = 1,
  runningHeaderTitle,
  pageLabel,
  printableId = 'smart-reader-a4-sheet',
  onPageCountChange,
}: FormattedReaderContentProps) {
  const parsed = useMemo(() => parseExamDocumentForDisplay(content), [content]);
  const isMcqMode = useMemo(
    () => isMcqExamDocument(parsed, runningHeaderTitle),
    [parsed, runningHeaderTitle]
  );
  // Strict scope: 2-column MCQ makeup applies ONLY to MCQ papers, NEVER to Written papers
  const effectiveLayoutMode: A4ReaderLayoutMode = isMcqMode ? layoutMode : 'single';
  const maxCharsPerHalfRow =
    effectiveLayoutMode === 'double'
      ? EDITORIAL_2COL_OPTION_MAX_CHARS
      : EDITORIAL_1COL_OPTION_MAX_CHARS;

  const structuredHeader = useMemo(
    () => parseStructuredExamHeader(parsed.headerLines),
    [parsed.headerLines]
  );

  const groupedBlocks = useMemo<McqEnhancedDisplayBlock[]>(() => {
    if (!parsed.isExam) return [];

    let rawBlocks;
    if (!hideAnswers) {
      rawBlocks = groupDisplayItemsWithOptionBlocks(parsed.bodyItems, maxCharsPerHalfRow);
    } else {
      // Properly skip solution/explanation blocks AND any continuation tables/notes inside them
      const filtered: typeof parsed.bodyItems = [];
      let skippingSolutionBlock = false;
      for (const item of parsed.bodyItems) {
        if (item.kind === 'question' || item.kind === 'center_block') {
          skippingSolutionBlock = false;
          filtered.push(item);
          continue;
        }
        if (
          item.kind === 'solution' ||
          item.kind === 'explanation' ||
          item.kind === 'ai_badge' ||
          item.kind === 'reference'
        ) {
          skippingSolutionBlock = true;
          continue;
        }
        if (item.kind === 'option') {
          skippingSolutionBlock = false;
          filtered.push(item);
          continue;
        }
        if (
          skippingSolutionBlock &&
          (item.kind === 'table' ||
            item.kind === 'math' ||
            item.kind === 'text' ||
            item.kind === 'diagram' ||
            item.kind === 'image')
        ) {
          // Keep standalone subject headings even if they appear right after a previous solution
          if (item.kind === 'text' && isExamSubjectHeadingLine(item.text)) {
            skippingSolutionBlock = false;
            filtered.push(item);
          }
          continue;
        }
        filtered.push(item);
      }
      rawBlocks = groupDisplayItemsWithOptionBlocks(filtered, maxCharsPerHalfRow);
    }

    // Always keep Answer/উত্তর directly below the options (never shifted inline to the right)
    return rawBlocks;
  }, [parsed, hideAnswers, maxCharsPerHalfRow]);

  const questionClusters = useMemo(
    () => clusterExamBlocksByQuestion(groupedBlocks),
    [groupedBlocks]
  );

  const nonExamBlocks = useMemo(
    () => (parsed.isExam ? [] : splitTextBlocksWithTables(parsed.formatted)),
    [parsed.isExam, parsed.formatted]
  );

  const totalItems = parsed.isExam ? questionClusters.length : nonExamBlocks.length;
  const justifyClass = justifyText ? 'exam-text-justify' : 'text-left';

  const hasStructuredMetaBar = Boolean(
    structuredHeader.timeText || structuredHeader.dateText || structuredHeader.marksText
  );

  // Hidden off-screen mirror refs for exact pixel-accurate adaptive MCQ & A4 pagination
  const measureHeaderRef = useRef<HTMLDivElement | null>(null);
  const measureBodyRef = useRef<HTMLDivElement | null>(null);
  const measureItemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [measuredPages, setMeasuredPages] = useState<McqAdaptivePage[] | null>(null);

  // Deterministic initial single-page fallback (identical on SSR and first client render -> zero hydration mismatch)
  const fallbackSinglePage = useMemo<McqAdaptivePage[]>(() => {
    const allIndices = Array.from({ length: totalItems }, (_, i) => i);
    if (effectiveLayoutMode === 'double' && isMcqMode && totalItems > 1) {
      const mid = Math.ceil(totalItems / 2);
      return [
        {
          pageNumber: 1,
          isFirstPage: true,
          col1Indices: allIndices.slice(0, mid),
          col2Indices: allIndices.slice(mid),
          col1LineSpacing: 1.2,
          col2LineSpacing: 1.2,
        },
      ];
    }
    return [
      {
        pageNumber: 1,
        isFirstPage: true,
        col1Indices: allIndices,
        col2Indices: [],
        col1LineSpacing: 1.2,
        col2LineSpacing: 1.2,
      },
    ];
  }, [totalItems, effectiveLayoutMode, isMcqMode]);

  useEffect(() => {
    let cancelled = false;

    const computePages = () => {
      if (cancelled) return;
      const headerH = measureHeaderRef.current?.offsetHeight ?? 0;

      if (isMcqMode && parsed.isExam) {
        const bodyEl = measureBodyRef.current;
        const itemsMetrics: Array<{ heightAt100: number; heightAt150: number }> = [];

        // Measure exact real-DOM heights at lineSpacing = 1.00
        if (bodyEl) {
          bodyEl.style.setProperty('--mcq-line-height', '1');
        }
        const heights100: number[] = [];
        for (let i = 0; i < totalItems; i += 1) {
          const el = measureItemRefs.current[i];
          heights100.push(el ? Math.ceil(el.getBoundingClientRect().height) : 48);
        }

        // Measure exact real-DOM heights at lineSpacing = 1.50
        if (bodyEl) {
          bodyEl.style.setProperty('--mcq-line-height', '1.5');
        }
        for (let i = 0; i < totalItems; i += 1) {
          const el = measureItemRefs.current[i];
          const h150 = el ? Math.ceil(el.getBoundingClientRect().height) : heights100[i] * 1.32;
          itemsMetrics.push({
            heightAt100: heights100[i],
            heightAt150: Math.max(heights100[i], h150),
          });
        }
        if (bodyEl) {
          bodyEl.style.setProperty('--mcq-line-height', '1.2');
        }

        const nextPages = optimizeMcqAdaptivePagination({
          headerHeight: headerH,
          items: itemsMetrics,
          pageContentHeight: MCQ_PAGE_MAKEUP_SPEC.usableContentHeightPx96,
          layoutMode: effectiveLayoutMode,
          itemGap: 2,
          minLineSpacing: 1.0,
          maxLineSpacing: 1.5,
          preferredLineSpacing: 1.2,
        });
        setMeasuredPages(nextPages);
        return;
      }

      // Standard A4 pagination for Written exams & general textbook prose (strictly non-MCQ)
      const heights: number[] = [];
      for (let i = 0; i < totalItems; i += 1) {
        const el = measureItemRefs.current[i];
        heights.push(el ? Math.ceil(el.getBoundingClientRect().height) : 48);
      }

      const rawA4Pages: PaginatedA4Page[] = paginateMeasuredBlocksIntoA4Pages({
        headerHeightPx: headerH,
        itemHeightsPx: heights,
        layoutMode: effectiveLayoutMode,
        pageContentHeightPx: DEFAULT_A4_CONTENT_HEIGHT_PX,
        itemGapPx: 10,
      });

      setMeasuredPages(
        rawA4Pages.map((p) => ({
          ...p,
          col1LineSpacing: 1.42,
          col2LineSpacing: 1.42,
        }))
      );
    };

    const rafId = window.requestAnimationFrame(computePages);
    const fontReady = document.fonts?.ready;
    if (fontReady) {
      void fontReady.then(() => {
        if (!cancelled) {
          window.requestAnimationFrame(computePages);
        }
      });
    }

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [
    content,
    effectiveLayoutMode,
    isMcqMode,
    hideAnswers,
    justifyText,
    fontSizeScale,
    parsed.isExam,
    totalItems,
  ]);

  const pagesToRender = useMemo(() => {
    if (!measuredPages) return fallbackSinglePage;
    const maxIdx = totalItems - 1;
    const isValid = measuredPages.every(
      (p) =>
        p.col1Indices.every((i) => i <= maxIdx) &&
        p.col2Indices.every((i) => i <= maxIdx)
    );
    return isValid ? measuredPages : fallbackSinglePage;
  }, [measuredPages, fallbackSinglePage, totalItems]);

  const reportedPageCount = pagesToRender.length;
  useEffect(() => {
    onPageCountChange?.(reportedPageCount);
  }, [reportedPageCount, onPageCountChange]);

  const zoomStyle =
    fontSizeScale !== 1
      ? ({ fontSize: `${Math.round(fontSizeScale * 100)}%` } as React.CSSProperties)
      : undefined;

  const renderMasthead = () =>
    parsed.isExam && parsed.headerLines.length > 0 ? (
      <header
        data-testid="exam-header-block"
        className="mb-2.5 pb-1.5 text-center border-b border-slate-900"
      >
        <div className="space-y-0.5">
          {structuredHeader.titleLines.map((line, idx) => (
            <div
              key={`hdr-title-${idx}`}
              data-testid="exam-header-line"
              className={
                idx === 0
                  ? 'exam-header-text font-bold tracking-tight text-slate-950'
                  : 'text-[14px] font-bold text-slate-900'
              }
            >
              {line}
            </div>
          ))}
          {structuredHeader.postLine && (
            <div
              data-testid="exam-header-line"
              className="text-[14px] font-bold text-slate-950"
            >
              {structuredHeader.postLine}
            </div>
          )}
          {structuredHeader.otherMetaLines.map((line, idx) => (
            <div
              key={`hdr-other-${idx}`}
              data-testid="exam-header-line"
              className="text-[12.5px] font-semibold text-slate-800"
            >
              {line}
            </div>
          ))}
        </div>

        {hasStructuredMetaBar && (
          <div
            data-testid="exam-header-meta-bar"
            className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[12.5px] font-bold text-slate-950"
          >
            <span>{structuredHeader.timeText || ''}</span>
            <span>{structuredHeader.dateText || ''}</span>
            <span>{structuredHeader.marksText || ''}</span>
          </div>
        )}
      </header>
    ) : null;

  return (
    <div
      data-testid="a4-paper-stage"
      data-a4-page-count={pagesToRender.length}
      data-justify={justifyText ? 'true' : 'false'}
      data-makeup-profile={isMcqMode ? 'mcq-letter-8.5x11' : 'standard-a4'}
      className="relative mt-4 rounded-xl border border-slate-300/90 bg-slate-200/85 p-3 sm:p-6 overflow-x-auto print:mt-0 print:border-0 print:bg-white print:p-0 print:overflow-visible"
    >
      {/* Off-screen exact-width measurement mirror matching MCQ 8.5"x11" (3.35" cols) or Written A4 */}
      <div
        aria-hidden="true"
        className={`pointer-events-none invisible fixed -left-[9999px] top-0 -z-50 overflow-hidden ${
          isMcqMode ? 'mcq-letter-page !p-0 !min-h-0 !max-w-none' : ''
        }`}
        style={zoomStyle}
      >
        <div style={{ width: isMcqMode ? '6.9in' : '184.6mm' }}>
          <div ref={measureHeaderRef}>{renderMasthead()}</div>
        </div>
        <div
          ref={measureBodyRef}
          className={isMcqMode ? 'mcq-adaptive-col' : undefined}
          style={{
            width: isMcqMode
              ? effectiveLayoutMode === 'double'
                ? 'calc((6.9in - 33px) / 2)'
                : '6.9in'
              : '184.6mm',
          }}
        >
          {parsed.isExam
            ? questionClusters.map((cluster, idx) => (
                <div
                  key={`m-q-${cluster.id}`}
                  ref={(el) => {
                    measureItemRefs.current[idx] = el;
                  }}
                >
                  {renderQuestionClusterBody(
                    cluster,
                    effectiveLayoutMode,
                    justifyClass,
                    isMcqMode
                  )}
                </div>
              ))
            : nonExamBlocks.map((block, idx) => (
                <div
                  key={`m-b-${idx}`}
                  ref={(el) => {
                    measureItemRefs.current[idx] = el;
                  }}
                >
                  {renderNonExamBlock(block, justifyClass)}
                </div>
              ))}
        </div>
      </div>

      {/* Discrete Stacked Print-Publication Pages */}
      <div
        id={printableId}
        data-testid="a4-paper-sheet"
        data-layout-mode={effectiveLayoutMode}
        data-makeup-profile={isMcqMode ? 'mcq-letter-8.5x11' : 'standard-a4'}
        className="space-y-0"
        style={zoomStyle}
      >
        {pagesToRender.map((page, pageIdx) => (
          <React.Fragment key={`a4-page-${page.pageNumber}`}>
            <article
              data-testid="a4-word-page"
              data-page-number={page.pageNumber}
              data-makeup-profile={isMcqMode ? 'mcq-letter-8.5x11' : 'standard-a4'}
              className={`${
                isMcqMode ? 'mcq-letter-page' : 'a4-word-page'
              } rounded-[2px] border border-slate-300 shadow-[0_8px_28px_rgba(15,23,42,0.14)] text-slate-950 print:rounded-none print:border-0 print:shadow-none`}
            >
              {/* Crisp Editorial Running Header (Matrix Publication Standard) */}
              <div className="mb-1.5 flex items-baseline justify-between gap-4 border-b border-slate-900 pb-0.5 text-[10.5px] text-slate-900">
                <span className="truncate font-semibold tracking-tight">
                  {runningHeaderTitle || 'বিভিন্ন নিয়োগ পরীক্ষার প্রশ্নোত্তর'}
                </span>
                <span className="shrink-0 font-medium text-slate-800">
                  {pageLabel || 'প্রশ্নোত্তর'}
                </span>
              </div>

              {/* Masthead on Page 1 */}
              {page.isFirstPage && renderMasthead()}

              {/* Page Body Content */}
              <div
                data-testid={parsed.isExam ? 'exam-formatted-reader' : 'prose-formatted-reader'}
                className="flex-1 flex flex-col text-slate-950"
              >
                {!parsed.isExam ? (
                  <div className="space-y-2">
                    {page.col1Indices.map((idx) => (
                      <React.Fragment key={`nb-${idx}`}>
                        {renderNonExamBlock(nonExamBlocks[idx], justifyClass)}
                      </React.Fragment>
                    ))}
                  </div>
                ) : effectiveLayoutMode === 'double' && isMcqMode ? (
                  <div className="flex-1 grid grid-cols-1 md:grid-cols-2 items-stretch gap-y-1 md:gap-x-0">
                    <div
                      data-testid="mcq-column-left"
                      data-col-line-spacing={page.col1LineSpacing.toFixed(2)}
                      className="mcq-adaptive-col min-w-0 overflow-hidden space-y-[2px] md:pr-[16px] md:border-r md:border-slate-900"
                      style={
                        {
                          '--mcq-line-height': String(page.col1LineSpacing),
                        } as React.CSSProperties
                      }
                    >
                      {page.col1Indices.map((idx) => (
                        <React.Fragment key={questionClusters[idx].id}>
                          {renderQuestionClusterBody(
                            questionClusters[idx],
                            effectiveLayoutMode,
                            justifyClass,
                            isMcqMode
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                    <div
                      data-testid="mcq-column-right"
                      data-col-line-spacing={page.col2LineSpacing.toFixed(2)}
                      className="mcq-adaptive-col min-w-0 overflow-hidden space-y-[2px] md:pl-[16px]"
                      style={
                        {
                          '--mcq-line-height': String(page.col2LineSpacing),
                        } as React.CSSProperties
                      }
                    >
                      {page.col2Indices.map((idx) => (
                        <React.Fragment key={questionClusters[idx].id}>
                          {renderQuestionClusterBody(
                            questionClusters[idx],
                            effectiveLayoutMode,
                            justifyClass,
                            isMcqMode
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    data-col-line-spacing={page.col1LineSpacing.toFixed(2)}
                    className={`${isMcqMode ? 'mcq-adaptive-col space-y-[2px]' : 'space-y-2.5'} min-w-0`}
                    style={
                      isMcqMode
                        ? ({
                            '--mcq-line-height': String(page.col1LineSpacing),
                          } as React.CSSProperties)
                        : undefined
                    }
                  >
                    {page.col1Indices.map((idx) => (
                      <React.Fragment key={questionClusters[idx].id}>
                        {renderQuestionClusterBody(
                          questionClusters[idx],
                          effectiveLayoutMode,
                          justifyClass,
                          isMcqMode
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>

              {/* Clean Minimalist Publication Page Folio Footer */}
              <footer className="mt-1.5 pt-1 border-t border-slate-300 flex items-center justify-center text-[10.5px] font-medium tabular-nums text-slate-700">
                <span>
                  পৃষ্ঠা {toBengaliNumber(page.pageNumber)} / {toBengaliNumber(pagesToRender.length)}
                </span>
              </footer>
            </article>

            {/* Explicit Microsoft Word–Style Page Break Gap Indicator between consecutive pages */}
            {pageIdx < pagesToRender.length - 1 && (
              <div
                data-testid="a4-page-break-indicator"
                className={`mx-auto my-4 flex ${
                  isMcqMode ? 'max-w-[8.5in]' : 'max-w-[210mm]'
                } items-center gap-3 px-2 select-none print:hidden`}
                aria-label={`পৃষ্ঠা ${page.pageNumber} শেষ, পৃষ্ঠা ${page.pageNumber + 1} শুরু`}
              >
                <div className="h-px flex-1 border-t border-dashed border-slate-500/70" />
                <span className="inline-flex items-center gap-1.5 rounded bg-slate-700 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-xs">
                  <Scissors className="h-3 w-3 text-slate-300" />
                  <span>
                    পৃষ্ঠা {toBengaliNumber(page.pageNumber)} শেষ — পৃষ্ঠা{' '}
                    {toBengaliNumber(page.pageNumber + 1)} শুরু ({isMcqMode ? '8.5×11 MCQ Page Break' : 'A4 Page Break'})
                  </span>
                </span>
                <div className="h-px flex-1 border-t border-dashed border-slate-500/70" />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
