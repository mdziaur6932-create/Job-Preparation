'use client';

import React, { useMemo } from 'react';
import katex from 'katex';
import {
  parseTextIntoKatexSegments,
  prepareLatexForKatex,
} from '@/src/lib/latex-math-parser';
import { splitMixedScriptSegments } from '@/src/lib/exam-typography';
import { parseInlineRichText } from '@/src/lib/rich-text-and-table-parser';

interface KatexMathTextProps {
  text: string;
  className?: string;
  examTypography?: boolean;
}

function renderStyledRunContent(
  value: string,
  examTypography: boolean,
  keyPrefix: string
): React.ReactNode {
  if (!examTypography) {
    return value;
  }
  const runs = splitMixedScriptSegments(value);
  return runs.map((run, idx) => (
    <span
      key={`${keyPrefix}-${idx}`}
      data-exam-script={run.script}
      className={run.script === 'en' ? 'exam-text-en' : 'exam-text-bn'}
    >
      {run.text}
    </span>
  ));
}

function renderRichTextSegment(
  value: string,
  examTypography: boolean,
  keyPrefix: string
): React.ReactNode {
  const spans = parseInlineRichText(value);
  if (
    spans.length === 1 &&
    !spans[0].bold &&
    !spans[0].italic &&
    !spans[0].underline
  ) {
    return renderStyledRunContent(spans[0].text, examTypography, keyPrefix);
  }

  return spans.map((span, idx) => {
    const inner = renderStyledRunContent(
      span.text,
      examTypography,
      `${keyPrefix}-r${idx}`
    );
    let node: React.ReactNode = inner;

    if (span.underline) {
      node = (
        <u className="underline decoration-slate-800 decoration-[1.25px] underline-offset-[3px]">
          {node}
        </u>
      );
    }
    if (span.italic) {
      node = <em className="italic">{node}</em>;
    }
    if (span.bold) {
      node = <strong className="font-bold text-slate-950">{node}</strong>;
    }

    return <React.Fragment key={`${keyPrefix}-s${idx}`}>{node}</React.Fragment>;
  });
}

export interface KatexRenderResult {
  html: string;
  isValid: boolean;
  errorMessage: string | null;
}

/**
 * Safely renders a LaTeX math string via KaTeX (`trust: false`, `throwOnError: true`
 * inside try/catch so syntax errors are caught cleanly for the Question Lab verifier).
 */
export function renderKatexSafe(
  latex: string,
  displayMode = false
): KatexRenderResult {
  const prepared = prepareLatexForKatex(latex);
  if (!prepared) {
    return { html: '', isValid: true, errorMessage: null };
  }
  try {
    const html = katex.renderToString(prepared, {
      displayMode,
      throwOnError: true,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    });
    return { html, isValid: true, errorMessage: null };
  } catch (err) {
    const fallbackHtml = katex.renderToString(prepared, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      errorColor: '#dc2626',
    });
    return {
      html: fallbackHtml,
      isValid: false,
      errorMessage:
        err instanceof Error ? err.message : 'LaTeX সিনট্যাক্স ত্রুটি পাওয়া গেছে।',
    };
  }
}

/**
 * Renders mixed Bengali/English exam text with authentic KaTeX typesetting for all
 * inline/display `$...$`, `$$...$$`, `\(...\)`, and bare `\frac` / `\sqrt` / `x^2` expressions,
 * plus safe inline rich-text emphasis (**bold**, *italic*, <u>underlined</u>).
 * When `examTypography` is enabled, Bengali runs render in SolaimanLipi 11pt and English
 * runs render in Times New Roman 12pt.
 */
export function KatexMathText({
  text,
  className,
  examTypography = false,
}: KatexMathTextProps) {
  const segments = useMemo(() => parseTextIntoKatexSegments(text), [text]);

  if (segments.length === 0) return null;
  if (segments.length === 1 && segments[0].kind === 'text') {
    const renderedText = renderRichTextSegment(
      segments[0].value,
      examTypography,
      's0'
    );
    return className ? (
      <span className={className}>{renderedText}</span>
    ) : (
      <>{renderedText}</>
    );
  }

  return (
    <span className={className}>
      {segments.map((seg, idx) => {
        if (seg.kind === 'text') {
          return (
            <React.Fragment key={idx}>
              {renderRichTextSegment(seg.value, examTypography, `s${idx}`)}
            </React.Fragment>
          );
        }

        const rendered = renderKatexSafe(seg.latex, seg.displayMode);
        const hasFraction = /\\(?:d|t)?frac\{/.test(seg.latex);
        const hasSqrt = /\\sqrt(?:\[[^\]]+\])?\{/.test(seg.latex);

        return (
          <span
            key={idx}
            data-testid="katex-math-expression"
            data-has-fraction={hasFraction ? 'true' : undefined}
            data-has-sqrt={hasSqrt ? 'true' : undefined}
            className={
              seg.displayMode
                ? 'my-1.5 block overflow-x-auto py-1'
                : 'mx-0.5 inline-block align-middle'
            }
          >
            {hasFraction && (
              <span data-testid="stacked-math-fraction" className="sr-only">
                fraction
              </span>
            )}
            {hasSqrt && (
              <span data-testid="math-sqrt-token" className="sr-only">
                sqrt
              </span>
            )}
            <span
              // KaTeX with trust:false emits strictly sanitized MathML/HTML spans
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
          </span>
        );
      })}
    </span>
  );
}

/**
 * Renders a single standalone LaTeX equation with KaTeX plus validation status,
 * used inside Question Lab's LaTeX Equation Verifier.
 */
export function KatexEquationPreview({
  latex,
  displayMode = true,
}: {
  latex: string;
  displayMode?: boolean;
}) {
  const rendered = useMemo(
    () => renderKatexSafe(latex, displayMode),
    [latex, displayMode]
  );

  if (!latex.trim()) {
    return (
      <span className="text-xs text-slate-400">
        যাচাই করার জন্য যেকোনো LaTeX সমীকরণ লিখুন বা তালিকা থেকে নির্বাচন করুন।
      </span>
    );
  }

  return (
    <div className="space-y-1.5">
      <div
        data-testid="katex-verifier-rendered"
        className="overflow-x-auto text-slate-900"
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
      {!rendered.isValid && rendered.errorMessage && (
        <p
          role="alert"
          className="text-[11px] font-medium text-red-700 font-mono"
        >
          {rendered.errorMessage}
        </p>
      )}
    </div>
  );
}
