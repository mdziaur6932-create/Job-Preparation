'use client';

import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Sigma,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { extractLatexEquationsFromText } from '@/src/lib/latex-math-parser';
import {
  KatexEquationPreview,
  renderKatexSafe,
} from './KatexMathText';

interface KatexEquationVerifierProps {
  examContent: string;
  removedAdsCount?: number;
}

const DEFAULT_SAMPLE_LATEX =
  '\\frac{3x+7}{4} + \\frac{5x-4}{7} = \\frac{x+3}{2}';

export function KatexEquationVerifier({
  examContent,
  removedAdsCount = 0,
}: KatexEquationVerifierProps) {
  const equations = useMemo(
    () => extractLatexEquationsFromText(examContent),
    [examContent]
  );

  const verifiedList = useMemo(
    () =>
      equations.map((eq) => {
        const check = renderKatexSafe(eq.latex, false);
        return {
          ...eq,
          isValid: check.isValid,
          errorMessage: check.errorMessage,
          renderedHtml: check.html,
        };
      }),
    [equations]
  );

  const [expanded, setExpanded] = useState(true);
  const [sandboxLatex, setSandboxLatex] = useState<string>(
    () => equations[0]?.latex ?? DEFAULT_SAMPLE_LATEX
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const validCount = verifiedList.filter((e) => e.isValid).length;
  const errorCount = verifiedList.length - validCount;

  const sandboxCheck = useMemo(
    () => renderKatexSafe(sandboxLatex, true),
    [sandboxLatex]
  );

  const handleCopyLatex = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1400);
    } catch {
      // Clipboard fallback ignored
    }
  };

  return (
    <section
      aria-label="KaTeX LaTeX সমীকরণ যাচাই"
      data-testid="katex-equation-verifier"
      className="rounded-xl border border-slate-200 bg-white overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sigma className="h-4 w-4 text-blue-700" />
          <h3 className="text-sm font-semibold text-slate-900">
            KaTeX LaTeX সমীকরণ যাচাই (OCR Refiner Math Verifier)
          </h3>
          <span
            data-testid="katex-equation-count"
            className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-800 font-mono tabular-nums"
          >
            সমীকরণ: {verifiedList.length}টি
          </span>
          {verifiedList.length > 0 && errorCount === 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
              <CheckCircle2 className="h-3 w-3" />
              <span>{validCount}টি সঠিকভাবে রেন্ডার হয়েছে</span>
            </span>
          )}
          {errorCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-800">
              <AlertCircle className="h-3 w-3" />
              <span>{errorCount}টি সিনট্যাক্স ত্রুটি</span>
            </span>
          )}
          {removedAdsCount > 0 && (
            <span
              data-testid="stripped-ads-badge"
              className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800"
            >
              {removedAdsCount}টি বিজ্ঞাপন/প্রচারণা লাইন বাদ দেওয়া হয়েছে
            </span>
          )}
        </div>

        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <span>{expanded ? 'সংকুচিত করুন' : 'বিস্তারিত দেখুন'}</span>
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {expanded && (
        <div className="p-5 space-y-4">
          {/* Detected Equations from Selected OCR Exam Paper */}
          {verifiedList.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-600">
                নির্বাচিত প্রশ্নপত্রে শনাক্তকৃত LaTeX সমীকরণ (রেন্ডার যাচাইয়ের জন্য ক্লিক করুন)
              </div>
              <div className="divide-y divide-slate-200 rounded-lg border border-slate-200">
                {verifiedList.map((eq) => (
                  <div
                    key={eq.id}
                    data-testid="katex-verified-row"
                    className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-12 sm:items-center hover:bg-slate-50/70 transition-colors"
                  >
                    <div className="sm:col-span-5 min-w-0 space-y-1">
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className="font-bold text-slate-800">
                          প্রশ্ন {eq.questionLabel}
                        </span>
                        {eq.isValid ? (
                          <span className="inline-flex items-center gap-0.5 font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" />
                            <span>KaTeX Valid</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 font-semibold text-red-700">
                            <AlertCircle className="h-3 w-3" />
                            <span>Syntax Error</span>
                          </span>
                        )}
                      </div>
                      <code className="block truncate rounded bg-slate-100 px-2 py-1 text-[11px] font-mono text-slate-800">
                        {eq.latex}
                      </code>
                    </div>

                    <div className="sm:col-span-5 overflow-x-auto rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900">
                      <span
                        data-testid="katex-row-rendered"
                        dangerouslySetInnerHTML={{ __html: eq.renderedHtml }}
                      />
                    </div>

                    <div className="sm:col-span-2 flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSandboxLatex(eq.latex)}
                        className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-800 hover:bg-blue-100 transition-colors"
                      >
                        যাচাই
                      </button>
                      <button
                        type="button"
                        aria-label={`LaTeX কপি করুন: ${eq.questionLabel}`}
                        onClick={() => void handleCopyLatex(eq.id, eq.latex)}
                        className="rounded border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 transition-colors"
                      >
                        {copiedId === eq.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-700" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
              নির্বাচিত প্রশ্নপত্রে এখনো কোনো LaTeX সমীকরণ শনাক্ত হয়নি। স্মার্ট রিডারে{' '}
              <span className="font-semibold text-slate-800">
                OCR Refiner (LaTeX + JSON)
              </span>{' '}
              চালালে বা নিচের লাইভ বক্সে LaTeX লিখলে এখানে KaTeX প্রিভিউ দেখাবে।
            </p>
          )}

          {/* Interactive Live KaTeX LaTeX Verifier */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="katex-live-latex-input"
                className="text-xs font-semibold text-slate-700"
              >
                লাইভ KaTeX LaTeX পরীক্ষক (সরাসরি সমীকরণ সম্পাদনা ও যাচাই করুন)
              </label>
              <span
                className={`text-[11px] font-semibold ${
                  sandboxCheck.isValid ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {sandboxCheck.isValid ? 'সঠিক LaTeX সিনট্যাক্স' : 'সিনট্যাক্স ত্রুটি'}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <input
                id="katex-live-latex-input"
                data-testid="katex-live-input"
                type="text"
                value={sandboxLatex}
                onChange={(e) => setSandboxLatex(e.target.value)}
                placeholder="যেমন: \frac{3x+7}{4} + \sqrt{x^{2}+1} = 5"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
              <div className="flex min-h-[46px] items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2">
                <KatexEquationPreview latex={sandboxLatex} displayMode={false} />
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
