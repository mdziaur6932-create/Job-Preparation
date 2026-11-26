'use client';

import React, { useMemo, useState } from 'react';
import {
  FileDown,
  FileText,
  Copy,
  Check,
  Loader2,
  BookOpen,
  SlidersHorizontal,
  Code2,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import {
  buildBookCardSummary,
  buildSmartReaderViews,
} from '@/src/lib/reader-page-grouper';
import {
  applyExamExportOptionsToDocument,
  buildSafeExportFilename,
  buildStructuredExamPdfBytes,
  formatExamPapersAsJson,
  formatExamPapersAsText,
  triggerBrowserFileDownload,
  type ExamNumberingStyle,
} from '@/src/lib/exam-paper-exporter';
import { stripPromotionalBookAds } from '@/src/lib/exam-text-formatter';
import { buildStructuredExamDocxBytes } from '@/src/lib/exam-word-exporter';
import { FormattedReaderContent } from './FormattedReaderContent';
import { KatexEquationVerifier } from './KatexEquationVerifier';

type ExportScope = 'single' | 'all';

export function ExamPaperExportPanel() {
  const { data, selectedBookId } = useWorkspace();

  const defaultBookId = useMemo(() => {
    if (selectedBookId && data.books.some((b) => b.id === selectedBookId)) {
      return selectedBookId;
    }
    const examOrOcrBook = data.books.find(
      (b) =>
        b.extractionMethod === 'ocr' ||
        b.category === 'রিসেন্ট জব সলুশন' ||
        buildBookCardSummary(b.chunks).isExamBook
    );
    return examOrOcrBook?.id ?? data.books[0]?.id ?? null;
  }, [data.books, selectedBookId]);

  const [exportBookId, setExportBookId] = useState<number | null>(defaultBookId);
  const [scope, setScope] = useState<ExportScope>('single');
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [numberingStyle, setNumberingStyle] =
    useState<ExamNumberingStyle>('original');
  const [includeHeader, setIncludeHeader] = useState(true);
  const [includeSolutions, setIncludeSolutions] = useState(true);
  const [justifyText, setJustifyText] = useState(true);
  const [layoutColumns, setLayoutColumns] = useState<1 | 2>(2);
  const [previewPageCount, setPreviewPageCount] = useState<number>(1);

  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingDocx, setExportingDocx] = useState(false);
  const [copied, setCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeBook = useMemo(
    () =>
      data.books.find((b) => b.id === exportBookId) ??
      data.books.find((b) => b.id === defaultBookId) ??
      data.books[0] ??
      null,
    [data.books, exportBookId, defaultBookId]
  );

  const readerCollection = useMemo(() => {
    if (!activeBook) {
      return { isExamBook: false, effectiveMode: 'page' as const, views: [] };
    }
    return buildSmartReaderViews(activeBook.chunks, 'exam');
  }, [activeBook]);

  const activeView = useMemo(() => {
    if (readerCollection.views.length === 0) return null;
    return (
      readerCollection.views.find((v) => v.id === selectedViewId) ??
      readerCollection.views[0]
    );
  }, [readerCollection.views, selectedViewId]);

  const targetUnits = useMemo(() => {
    if (readerCollection.views.length === 0) return [];
    if (scope === 'all') return readerCollection.views;
    return activeView ? [activeView] : [];
  }, [readerCollection.views, scope, activeView]);

  const previewTransformed = useMemo(() => {
    if (!activeView) return '';
    return applyExamExportOptionsToDocument(activeView.content, {
      numberingStyle,
      includeHeader,
      includeSolutions,
    }).formatted;
  }, [activeView, numberingStyle, includeHeader, includeSolutions]);

  const removedAdsCount = useMemo(() => {
    if (!activeView) return 0;
    const rawCombined = activeView.sourceChunks.map((c) => c.content).join('\n');
    return stripPromotionalBookAds(rawCombined).removedCount;
  }, [activeView]);

  const exportOptions = useMemo(
    () => ({
      bookTitle: activeBook?.title ?? 'Exam Paper',
      numberingStyle,
      includeHeader,
      includeSolutions,
      layoutColumns,
      justifyText,
    }),
    [activeBook, numberingStyle, includeHeader, includeSolutions, layoutColumns, justifyText]
  );

  const exportBaseFilename = useMemo(() => {
    if (!activeBook) return 'exam-paper';
    if (scope === 'single' && activeView) {
      return `${activeView.title}-${activeView.pageLabel}`;
    }
    return `${activeBook.title}-all-exams`;
  }, [activeBook, scope, activeView]);

  const handleExportText = () => {
    if (targetUnits.length === 0) return;
    setErrorMessage(null);
    try {
      const formattedText = formatExamPapersAsText(targetUnits, exportOptions);
      const filename = buildSafeExportFilename(exportBaseFilename, 'txt');
      // Prepend UTF-8 BOM so Windows Notepad & MS Word open Bengali Unicode cleanly
      triggerBrowserFileDownload(
        `\uFEFF${formattedText}`,
        'text/plain;charset=utf-8',
        filename
      );
      setStatusMessage(
        `সফলভাবে Formatted Text ফাইল ডাউনলোড হয়েছে (${targetUnits.length}টি পরীক্ষা/পৃষ্ঠা): ${filename}`
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'টেক্সট ফাইল এক্সপোর্ট করতে সমস্যা হয়েছে।'
      );
    }
  };

  const handleExportJson = () => {
    if (targetUnits.length === 0) return;
    setErrorMessage(null);
    try {
      const jsonContent = formatExamPapersAsJson(targetUnits, exportOptions);
      const filename = buildSafeExportFilename(exportBaseFilename, 'json');
      triggerBrowserFileDownload(
        jsonContent,
        'application/json;charset=utf-8',
        filename
      );
      setStatusMessage(
        `সফলভাবে Structured JSON ফাইল ডাউনলোড হয়েছে (${targetUnits.length}টি পরীক্ষা/পৃষ্ঠা): ${filename}`
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Structured JSON এক্সপোর্ট করতে সমস্যা হয়েছে।'
      );
    }
  };

  const handleExportPdf = async () => {
    if (targetUnits.length === 0) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setExportingPdf(true);
    try {
      const { bytes, pageCount } = await buildStructuredExamPdfBytes(
        targetUnits,
        exportOptions
      );
      const filename = buildSafeExportFilename(exportBaseFilename, 'pdf');
      triggerBrowserFileDownload(bytes, 'application/pdf', filename);
      setStatusMessage(
        `সফলভাবে ${pageCount} পৃষ্ঠার Structured PDF ডাউনলোড হয়েছে: ${filename}`
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Structured PDF তৈরি করতে সমস্যা হয়েছে।'
      );
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportDocx = async () => {
    if (targetUnits.length === 0) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setExportingDocx(true);
    try {
      const bytes = await buildStructuredExamDocxBytes(
        targetUnits,
        exportOptions
      );
      const filename = buildSafeExportFilename(exportBaseFilename, 'docx');
      triggerBrowserFileDownload(
        bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename
      );
      setStatusMessage(
        `সফলভাবে Microsoft Word (.docx) ফাইল ডাউনলোড হয়েছে (${targetUnits.length}টি পরীক্ষা/পৃষ্ঠা): ${filename}`
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Word (.docx) ফাইল তৈরি করতে সমস্যা হয়েছে।'
      );
    } finally {
      setExportingDocx(false);
    }
  };

  const handleCopyFormattedText = async () => {
    if (targetUnits.length === 0) return;
    setErrorMessage(null);
    try {
      const formattedText = formatExamPapersAsText(targetUnits, exportOptions);
      await navigator.clipboard.writeText(formattedText);
      setCopied(true);
      setStatusMessage('সম্পূর্ণ ফরম্যাটেড টেক্সট ক্লিপবোর্ডে কপি করা হয়েছে।');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setErrorMessage('ক্লিপবোর্ডে কপি করা যায়নি—দয়া করে .txt ডাউনলোড ব্যবহার করুন।');
    }
  };

  if (data.books.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
        <BookOpen className="mx-auto h-7 w-7 text-slate-400" />
        <p className="mt-3 text-sm font-semibold text-slate-900">
          এক্সপোর্ট করার জন্য এখনো কোনো বই লাইব্রেরিতে নেই
        </p>
        <p className="mt-1 text-xs text-slate-500">
          প্রথমে Book Library থেকে একটি স্ক্যান করা PDF বা প্রশ্নপত্র আপলোড ও OCR সম্পন্ন করুন।
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="exam-paper-export-panel"
      className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start"
    >
      {/* Left: Export Source & Formatting Settings (5 cols) */}
      <section
        aria-label="প্রশ্নপত্র এক্সপোর্ট সেটিংস"
        className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-5"
      >
        <div className="border-b border-slate-200 pb-3.5">
          <h2 className="text-base font-semibold text-slate-900">
            স্ক্যান ও OCR প্রশ্নপত্র এক্সপোর্ট (PDF / Word / TXT / JSON)
          </h2>
          <p className="mt-1 text-xs text-slate-500 leading-relaxed">
            OCR প্রসেসিং শেষে সম্পূর্ণ পরীক্ষার প্রশ্নপত্রগুলো সঠিক নম্বর, টেবিল, বোল্ড/আন্ডারলাইন, Justify অ্যালাইনমেন্ট ও A4 Narrow মার্জিনসহ Structured PDF, Microsoft Word (.docx), Formatted Text অথবা JSON হিসেবে ডাউনলোড করুন।
          </p>
        </div>

        {/* 1. Book Selection */}
        <div>
          <label
            htmlFor="export-book-select"
            className="block text-xs font-semibold text-slate-700"
          >
            ১. OCR / লাইব্রেরি বই নির্বাচন করুন
          </label>
          <select
            id="export-book-select"
            value={activeBook?.id ?? ''}
            onChange={(e) => {
              setExportBookId(Number(e.target.value));
              setSelectedViewId(null);
              setStatusMessage(null);
              setErrorMessage(null);
            }}
            className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
          >
            {data.books.map((book) => {
              const summary = buildBookCardSummary(book.chunks);
              return (
                <option key={book.id} value={book.id}>
                  {book.title} ({summary.unitLabel})
                </option>
              );
            })}
          </select>
        </div>

        {/* 2. Export Scope */}
        <div className="space-y-2.5">
          <span className="block text-xs font-semibold text-slate-700">
            ২. এক্সপোর্টের পরিসর নির্বাচন করুন
          </span>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setScope('single')}
              className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                scope === 'single'
                  ? 'border-blue-600 bg-blue-50 text-blue-800'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              নির্বাচিত ১টি পরীক্ষা
            </button>
            <button
              type="button"
              onClick={() => setScope('all')}
              className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                scope === 'all'
                  ? 'border-blue-600 bg-blue-50 text-blue-800'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              বইয়ের সব ({readerCollection.views.length}টি)
            </button>
          </div>

          {scope === 'single' && readerCollection.views.length > 0 && (
            <div>
              <label
                htmlFor="export-exam-select"
                className="block text-xs font-medium text-slate-600"
              >
                কোন পরীক্ষা / পৃষ্ঠা এক্সপোর্ট করবেন
              </label>
              <select
                id="export-exam-select"
                value={activeView?.id ?? ''}
                onChange={(e) => {
                  setSelectedViewId(e.target.value);
                  setStatusMessage(null);
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              >
                {readerCollection.views.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.title} ({view.pageLabel})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* 3. Formatting Settings */}
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <SlidersHorizontal className="h-3.5 w-3.5 text-blue-700" />
            <span>৩. ফরম্যাটিং ও নাম্বারিং সেটিংস</span>
          </div>

          <div>
            <label
              htmlFor="export-numbering-style"
              className="block text-xs font-medium text-slate-600"
            >
              প্রশ্নের নাম্বারিং স্টাইল
            </label>
            <select
              id="export-numbering-style"
              value={numberingStyle}
              onChange={(e) =>
                setNumberingStyle(e.target.value as ExamNumberingStyle)
              }
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
            >
              <option value="original">মূল ফরম্যাট (স্বয়ংক্রিয় মেরামতসহ)</option>
              <option value="english">ইংরেজি ক্রমিক (01. 02. 03.)</option>
              <option value="bengali">বাংলা ক্রমিক (০১। ০২। ০৩।)</option>
            </select>
          </div>

          <div>
            <span className="block text-xs font-medium text-slate-600">
              A4 পেজ লেআউট (Narrow Margin 0.5&quot; · অরিজিনাল প্রশ্নপত্র)
            </span>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <button
                type="button"
                data-testid="export-layout-2col"
                onClick={() => setLayoutColumns(2)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                  layoutColumns === 2
                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                ২ কলাম (অরিজিনাল প্রশ্নপত্র)
              </button>
              <button
                type="button"
                data-testid="export-layout-1col"
                onClick={() => setLayoutColumns(1)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                  layoutColumns === 1
                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                ১ কলাম (A4 বুক ফরম্যাট)
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              ছোট অপশনগুলো স্বয়ংক্রিয়ভাবে এক লাইনে ২টি করে (ক, খ / গ, ঘ) এবং বড় অপশন ১টি করে বসবে।
            </p>
          </div>

          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={includeHeader}
                onChange={(e) => setIncludeHeader(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <span>পরীক্ষার শিরোনাম, পদের নাম ও তারিখ যুক্ত রাখুন</span>
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSolutions}
                onChange={(e) => setIncludeSolutions(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <span>উত্তর ও সমাধান (Solution / Answer) যুক্ত রাখুন</span>
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                data-testid="export-toggle-justify"
                checked={justifyText}
                onChange={(e) => setJustifyText(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <span>সকল প্রশ্ন ও ব্যাখ্যা Justify (দুই পাশে সমান) রাখুন</span>
            </label>
          </div>
        </div>

        {/* Inline Status / Error Feedback */}
        {errorMessage && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
          >
            {errorMessage}
          </p>
        )}
        {statusMessage && (
          <p
            role="status"
            data-testid="exam-export-status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800"
          >
            {statusMessage}
          </p>
        )}

        {/* Export Actions */}
        <div className="space-y-2.5 pt-1">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              data-testid="btn-export-pdf"
              disabled={exportingPdf || targetUnits.length === 0}
              onClick={() => void handleExportPdf()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {exportingPdf ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>A4 PDF তৈরি হচ্ছে...</span>
                </>
              ) : (
                <>
                  <FileDown className="h-4 w-4" />
                  <span>A4 PDF ডাউনলোড (.pdf)</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="btn-export-docx"
              disabled={exportingDocx || targetUnits.length === 0}
              onClick={() => void handleExportDocx()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50 transition-colors"
            >
              {exportingDocx ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Word (.docx) তৈরি হচ্ছে...</span>
                </>
              ) : (
                <>
                  <FileText className="h-4 w-4" />
                  <span>Word ডাউনলোড (.docx)</span>
                </>
              )}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              type="button"
              disabled={targetUnits.length === 0}
              onClick={handleExportText}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              <FileText className="h-3.5 w-3.5 text-blue-700" />
              <span>Formatted Text (.txt)</span>
            </button>

            <button
              type="button"
              data-testid="btn-export-json"
              disabled={targetUnits.length === 0}
              onClick={handleExportJson}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              <Code2 className="h-3.5 w-3.5 text-slate-700" />
              <span>Structured JSON (.json)</span>
            </button>

            <button
              type="button"
              disabled={targetUnits.length === 0}
              onClick={() => void handleCopyFormattedText()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                  <span>কপি হয়েছে</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5 text-slate-600" />
                  <span>টেক্সট কপি করুন</span>
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Right: KaTeX Equation Verifier + Live Structured Exam Preview (7 cols) */}
      <div className="lg:col-span-7 space-y-5">
        {activeView && (
          <KatexEquationVerifier
            examContent={previewTransformed}
            removedAdsCount={removedAdsCount}
          />
        )}

        <section
          aria-label="এক্সপোর্ট প্রশ্নপত্র প্রিভিউ"
          className="rounded-xl border border-slate-200 bg-white overflow-hidden"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-5 py-3.5">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                লাইভ Structured প্রিভিউ (KaTeX রেন্ডারসহ)
              </h3>
              {activeView && (
                <p className="text-xs text-slate-500 mt-0.5">
                  {activeBook?.title} · {activeView.title} ({activeView.pageLabel})
                  {scope === 'all' && readerCollection.views.length > 1
                    ? ` · ডাউনলোডে মোট ${readerCollection.views.length}টি পরীক্ষা যুক্ত হবে`
                    : ''}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {activeView && (
                <span className="rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-800 font-mono tabular-nums">
                  মোট {previewPageCount}টি A4 পৃষ্ঠা
                </span>
              )}
              {activeView && activeView.questionCount > 0 && (
                <span className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 font-mono tabular-nums">
                  মোট প্রশ্ন: {activeView.questionCount}টি
                </span>
              )}
            </div>
          </div>

          <div className="p-3 sm:p-4 max-h-[780px] overflow-y-auto bg-slate-200/70">
            {activeView ? (
              <FormattedReaderContent
                content={previewTransformed}
                layoutMode={layoutColumns === 2 ? 'double' : 'single'}
                hideAnswers={!includeSolutions}
                justifyText={justifyText}
                runningHeaderTitle={activeBook?.title}
                pageLabel={activeView.pageLabel}
                onPageCountChange={setPreviewPageCount}
              />
            ) : (
              <p className="py-12 text-center text-sm text-slate-500">
                এই বইয়ে প্রিভিউ দেখানোর মতো কোনো OCR/টেক্সট পৃষ্ঠা পাওয়া যায়নি।
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
