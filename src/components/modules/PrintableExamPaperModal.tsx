'use client';

import React, { useState } from 'react';
import {
  Printer,
  X,
  FileText,
  CheckCircle2,
  BookOpen,
  Sparkles,
  FileDown,
  Loader2,
  Columns2,
  AlignJustify,
} from 'lucide-react';
import { KatexMathText } from './KatexMathText';
import { parseExplanationSource } from '@/src/lib/demo-paper-blueprint';
import { parseWrittenQuestionStructure } from '@/src/lib/job-exam-paper';
import { toBengaliNumber } from '@/src/lib/file-validation';
import { decideOptionColumnLayout } from '@/src/lib/exam-option-layout';
import {
  buildSafeExportFilename,
  buildStructuredExamPdfBytes,
  triggerBrowserFileDownload,
} from '@/src/lib/exam-paper-exporter';
import { buildStructuredExamDocxBytes } from '@/src/lib/exam-word-exporter';
import type { Question } from '@/src/types/system';

export type PrintPaperMode = 'question-only' | 'with-answers';

interface PrintableExamPaperModalProps {
  open: boolean;
  onClose: () => void;
  initialMode?: PrintPaperMode;
  organizationName?: string;
  postName?: string;
  examTitle: string;
  setNumber?: number;
  totalSets?: number;
  totalMarks?: number;
  durationMinutes?: number;
  questions: Array<Omit<Question, 'id' | 'createdAt'>>;
}

const BN_OPT_LABELS = ['ক', 'খ', 'গ', 'ঘ'];

function buildPlainExamDocumentForPdf(params: {
  organizationName?: string;
  postName?: string;
  examTitle: string;
  durationMinutes: number;
  todayFormatted: string;
  computedMarks: number;
  setNumber: number;
  totalSets: number;
  mcqItems: Array<Omit<Question, 'id' | 'createdAt'>>;
  writtenItems: Array<Omit<Question, 'id' | 'createdAt'>>;
  includeAnswers: boolean;
}): string {
  const lines: string[] = [];
  lines.push(params.organizationName?.trim() || params.examTitle);
  if (params.postName?.trim()) {
    lines.push(`পদের নাম: ${params.postName.trim()}`);
  }
  if (params.organizationName?.trim() && params.examTitle) {
    lines.push(params.examTitle);
  }
  const setSuffix =
    params.totalSets > 1 ? ` · সেট-${toBengaliNumber(params.setNumber)}` : '';
  lines.push(
    `সময়: ${toBengaliNumber(params.durationMinutes)} মিনিট   তারিখ: ${params.todayFormatted}${setSuffix}   পূর্ণমান: ${toBengaliNumber(params.computedMarks)}`
  );
  lines.push('');

  let qIndex = 1;
  for (const q of params.mcqItems) {
    lines.push(`${toBengaliNumber(qIndex)}. ${q.stem}`);
    q.options.forEach((opt, oIdx) => {
      lines.push(`${BN_OPT_LABELS[oIdx] ?? oIdx + 1}. ${opt}`);
    });
    if (params.includeAnswers) {
      const optPrefix =
        q.correctOptionIndex !== null
          ? `${BN_OPT_LABELS[q.correctOptionIndex] ?? ''}. `
          : '';
      lines.push(`উত্তর: ${optPrefix}${q.modelAnswer}`);
      const expInfo = parseExplanationSource(
        q.explanation,
        q.bookTitle,
        q.pageNumber
      );
      if (expInfo.hasExplanation && expInfo.text) {
        lines.push(`ব্যাখ্যা: ${expInfo.text}`);
      }
    }
    lines.push('');
    qIndex += 1;
  }

  if (params.writtenItems.length > 0) {
    lines.push(
      `লিখিত অংশ (${toBengaliNumber(params.writtenItems.length)}টি প্রশ্ন)`
    );
    lines.push('');
    params.writtenItems.forEach((q, idx) => {
      const parsed = parseWrittenQuestionStructure(q.stem, 5);
      lines.push(
        `${toBengaliNumber(idx + 1)}. ${parsed.displayStem} [${toBengaliNumber(parsed.marks)}]`
      );
      for (const sub of parsed.subItems) {
        lines.push(`${sub.label}. ${sub.prompt}`);
      }
      if (params.includeAnswers) {
        lines.push(`উত্তর: ${q.modelAnswer}`);
        const expInfo = parseExplanationSource(
          q.explanation,
          q.bookTitle,
          q.pageNumber
        );
        if (expInfo.hasExplanation && expInfo.text) {
          lines.push(`ব্যাখ্যা: ${expInfo.text}`);
        }
      }
      lines.push('');
    });
  }

  return lines.join('\n');
}

export function PrintableExamPaperModal({
  open,
  onClose,
  initialMode = 'question-only',
  organizationName,
  postName,
  examTitle,
  setNumber = 1,
  totalSets = 1,
  totalMarks,
  durationMinutes,
  questions,
}: PrintableExamPaperModalProps) {
  const [printMode, setPrintMode] = useState<PrintPaperMode>(initialMode);
  const [sheetColumns, setSheetColumns] = useState<1 | 2>(2);
  const [justifyText, setJustifyText] = useState(true);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadingDocx, setDownloadingDocx] = useState(false);

  if (!open) return null;

  const mcqItems = questions.filter((q) => q.questionType === 'MCQ');
  const writtenItems = questions.filter((q) => q.questionType !== 'MCQ');

  const computedMarks =
    totalMarks && totalMarks > 0
      ? totalMarks
      : mcqItems.length +
        writtenItems.reduce(
          (sum, q) => sum + parseWrittenQuestionStructure(q.stem, 5).marks,
          0
        );

  const effectiveDuration = durationMinutes || Math.max(30, questions.length);

  const todayFormatted = new Date().toLocaleDateString('bn-BD', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const handleDownloadDirectA4Pdf = async () => {
    if (downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const content = buildPlainExamDocumentForPdf({
        organizationName,
        postName,
        examTitle,
        durationMinutes: effectiveDuration,
        todayFormatted,
        computedMarks,
        setNumber,
        totalSets,
        mcqItems,
        writtenItems,
        includeAnswers: printMode === 'with-answers',
      });
      const { bytes } = await buildStructuredExamPdfBytes(
        [
          {
            id: `printable-${setNumber}`,
            kind: 'exam',
            bookTitle: organizationName?.trim() || examTitle,
            title: examTitle,
            chapter: postName?.trim() || examTitle,
            pageLabel: `A4 Narrow`,
            startPage: 1,
            endPage: 1,
            content,
            questionCount: questions.length,
            sourceChunks: [],
          },
        ],
        {
          bookTitle: organizationName?.trim() || examTitle,
          numberingStyle: 'original',
          includeHeader: true,
          includeSolutions: printMode === 'with-answers',
          layoutColumns: sheetColumns,
          justifyText,
        }
      );
      const filename = buildSafeExportFilename(
        `${examTitle}-${printMode === 'with-answers' ? 'with-answers' : 'question-paper'}-A4`,
        'pdf'
      );
      triggerBrowserFileDownload(bytes, 'application/pdf', filename);
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleDownloadDirectWordDocx = async () => {
    if (downloadingDocx) return;
    setDownloadingDocx(true);
    try {
      const content = buildPlainExamDocumentForPdf({
        organizationName,
        postName,
        examTitle,
        durationMinutes: effectiveDuration,
        todayFormatted,
        computedMarks,
        setNumber,
        totalSets,
        mcqItems,
        writtenItems,
        includeAnswers: printMode === 'with-answers',
      });
      const bytes = await buildStructuredExamDocxBytes(
        [
          {
            id: `printable-${setNumber}`,
            kind: 'exam',
            bookTitle: organizationName?.trim() || examTitle,
            title: examTitle,
            chapter: postName?.trim() || examTitle,
            pageLabel: 'A4 Narrow',
            startPage: 1,
            endPage: 1,
            content,
            questionCount: questions.length,
            sourceChunks: [],
          },
        ],
        {
          bookTitle: organizationName?.trim() || examTitle,
          numberingStyle: 'original',
          includeHeader: true,
          includeSolutions: printMode === 'with-answers',
          layoutColumns: sheetColumns,
          justifyText,
        }
      );
      const filename = buildSafeExportFilename(
        `${examTitle}-${printMode === 'with-answers' ? 'with-answers' : 'question-paper'}-A4`,
        'docx'
      );
      triggerBrowserFileDownload(
        bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename
      );
    } finally {
      setDownloadingDocx(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="প্রিন্টযোগ্য A4 চাকরির পরীক্ষার প্রশ্নপত্র প্রিভিউ"
      data-testid="printable-exam-paper-modal"
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/60 backdrop-blur-xs p-3 sm:p-6 overflow-y-auto print:static print:bg-white print:p-0 print:overflow-visible"
    >
      {/* Top Toolbar (hidden on print) */}
      <div className="mx-auto mb-3 flex w-full max-w-[218mm] flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="tablist">
            <button
              type="button"
              role="tab"
              data-testid="print-mode-question-only"
              aria-selected={printMode === 'question-only'}
              onClick={() => setPrintMode('question-only')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                printMode === 'question-only'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>শুধু প্রশ্নপত্র (হলের কপি)</span>
            </button>
            <button
              type="button"
              role="tab"
              data-testid="print-mode-with-answers"
              aria-selected={printMode === 'with-answers'}
              onClick={() => setPrintMode('with-answers')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                printMode === 'with-answers'
                  ? 'bg-blue-700 text-white'
                  : 'text-slate-700 hover:bg-white'
              }`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>প্রশ্ন + উত্তর ও ব্যাখ্যাসহ</span>
            </button>
          </div>

          <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label="A4 কলাম লেআউট">
            <button
              type="button"
              data-testid="print-cols-2"
              aria-pressed={sheetColumns === 2}
              onClick={() => setSheetColumns(2)}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                sheetColumns === 2
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Columns2 className="h-3.5 w-3.5" />
              <span>২ কলাম (অরিজিনাল)</span>
            </button>
            <button
              type="button"
              data-testid="print-cols-1"
              aria-pressed={sheetColumns === 1}
              onClick={() => setSheetColumns(1)}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                sheetColumns === 1
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <AlignJustify className="h-3.5 w-3.5" />
              <span>১ কলাম</span>
            </button>
          </div>
          <button
            type="button"
            data-testid="print-toggle-justify"
            aria-pressed={justifyText}
            onClick={() => setJustifyText((prev) => !prev)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              justifyText
                ? 'border-blue-600 bg-blue-50 text-blue-800'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <AlignJustify className="h-3.5 w-3.5" />
            <span>Justify</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden lg:inline text-[11px] font-medium text-slate-500">
            A4 · Narrow (0.5&quot;)
          </span>
          <button
            type="button"
            data-testid="download-printable-docx-btn"
            disabled={downloadingDocx}
            onClick={() => void handleDownloadDirectWordDocx()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-800 hover:bg-indigo-100 disabled:opacity-50 whitespace-nowrap"
          >
            {downloadingDocx ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileText className="h-3.5 w-3.5" />
            )}
            <span>Word (.docx)</span>
          </button>
          <button
            type="button"
            data-testid="download-printable-a4-pdf-btn"
            disabled={downloadingPdf}
            onClick={() => void handleDownloadDirectA4Pdf()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-50 whitespace-nowrap"
          >
            {downloadingPdf ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileDown className="h-3.5 w-3.5" />
            )}
            <span>A4 PDF ডাউনলোড</span>
          </button>
          <button
            type="button"
            data-testid="trigger-browser-print-btn"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>প্রিন্ট / PDF সেভ করুন</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="প্রিভিউ বন্ধ করুন"
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* True Publication-Grade A4 Narrow Sheet (210mm width, 12.7mm Narrow Margins) */}
      <div
        id="printable-exam-sheet"
        data-testid="printable-a4-sheet"
        className="a4-paper-sheet exam-document-typography mx-auto w-full rounded-[3px] border border-slate-200 bg-white text-slate-900 shadow-lg print:max-w-none print:rounded-none print:border-0 print:shadow-none"
      >
        {/* Official BD Job Exam Paper Double-Ruled Masthead */}
        <header className="border-b-2 border-slate-900 pb-3 text-center space-y-1">
          <div className="exam-header-text font-bold tracking-tight text-slate-950">
            {organizationName?.trim() || examTitle}
          </div>
          {postName?.trim() && (
            <div className="exam-text-bn text-[13pt] font-bold text-slate-900">
              পদের নাম: {postName.trim()}
            </div>
          )}
          {organizationName?.trim() && examTitle && (
            <div className="exam-text-bn text-[11pt] font-semibold text-slate-700">
              {examTitle}
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-b border-slate-300 py-1.5 text-[10.5pt] font-semibold text-slate-900 exam-text-bn">
            <span>সময়: {toBengaliNumber(effectiveDuration)} মিনিট</span>
            <span>
              পরীক্ষার তারিখ: {todayFormatted}
              {totalSets > 1 ? ` · সেট-${toBengaliNumber(setNumber)}` : ''}
            </span>
            <span>পূর্ণমান: {toBengaliNumber(computedMarks)}</span>
          </div>
        </header>

        {/* MCQ Section — Adaptive 2-per-row / 1-per-row Options inside A4 1-col or 2-col Flow */}
        {mcqItems.length > 0 && (
          <section className="mt-4 space-y-3">
            <h2 className="border-b border-slate-300 pb-1 exam-text-bn text-[11.5pt] font-bold text-slate-900">
              {writtenItems.length > 0
                ? `অংশ-ক: বহুনির্বাচনি প্রশ্ন (MCQ — ${toBengaliNumber(mcqItems.length)}টি)`
                : `বহুনির্বাচনি প্রশ্নপত্র (মোট ${toBengaliNumber(mcqItems.length)}টি প্রশ্ন)`}
            </h2>

            <div
              className={
                sheetColumns === 2
                  ? 'a4-two-col-flow'
                  : 'space-y-3'
              }
            >
              {mcqItems.map((q, idx) => {
                const expInfo = parseExplanationSource(
                  q.explanation,
                  q.bookTitle,
                  q.pageNumber
                );
                const optCols = decideOptionColumnLayout(
                  q.options.map((opt, oIdx) => ({
                    marker: `${BN_OPT_LABELS[oIdx] ?? oIdx + 1}.`,
                    text: opt,
                  })),
                  sheetColumns === 2 ? 18 : 34
                ).columns;
                return (
                  <div
                    key={`print-mcq-${idx}`}
                    className="a4-question-cluster break-inside-avoid space-y-1 pb-2.5"
                  >
                    <p
                      className={`font-semibold text-slate-950 leading-[1.6] ${
                        justifyText ? 'exam-text-justify' : ''
                      }`}
                    >
                      <span className="exam-text-bn font-bold mr-1">
                        {toBengaliNumber(idx + 1)}.
                      </span>
                      <KatexMathText text={q.stem} examTypography />
                    </p>
                    <div
                      data-testid="printable-mcq-options"
                      data-columns={optCols}
                      className={
                        optCols === 2
                          ? 'grid grid-cols-2 gap-x-4 gap-y-0.5 pl-4'
                          : 'grid grid-cols-1 gap-y-0.5 pl-4'
                      }
                    >
                      {q.options.map((opt, oIdx) => {
                        const isCorrect =
                          printMode === 'with-answers' &&
                          oIdx === q.correctOptionIndex;
                        return (
                          <div
                            key={oIdx}
                            className={`flex items-baseline gap-1 min-w-0 leading-[1.55] ${
                              isCorrect
                                ? 'font-bold text-blue-800'
                                : 'text-slate-800'
                            }`}
                          >
                            <span className="exam-text-bn font-semibold shrink-0">
                              {BN_OPT_LABELS[oIdx] ?? oIdx + 1}.
                            </span>
                            <span className="min-w-0 break-words">
                              <KatexMathText text={opt} examTypography />
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {printMode === 'with-answers' && (
                      <div className="ml-4 mt-1 space-y-0.5">
                        <div className="flex flex-wrap items-baseline gap-1.5">
                          <span className="inline-flex items-center rounded bg-blue-50 border border-blue-200 px-1.5 py-0.2 text-[9.5pt] font-bold text-blue-800 exam-text-bn">
                            উত্তর:
                          </span>
                          <span className="font-bold text-blue-800">
                            {q.correctOptionIndex !== null
                              ? `${BN_OPT_LABELS[q.correctOptionIndex] ?? ''}. `
                              : ''}
                            <KatexMathText text={q.modelAnswer} examTypography />
                          </span>
                          {expInfo.hasExplanation && (
                            <span className="inline-flex items-center gap-0.5 text-[9pt] font-medium text-slate-500">
                              {expInfo.source === 'ai' ? (
                                <Sparkles className="h-2.5 w-2.5 text-blue-700" />
                              ) : (
                                <BookOpen className="h-2.5 w-2.5 text-emerald-700" />
                              )}
                              <span>{expInfo.badgeLabel}</span>
                            </span>
                          )}
                        </div>
                        {expInfo.hasExplanation && (
                          <div
                            className={`rounded border border-rose-200/80 bg-rose-50/40 px-2.5 py-1 text-[#7f1d1d] leading-[1.55] ${
                              justifyText ? 'exam-text-justify' : ''
                            }`}
                          >
                            <span className="font-bold exam-text-bn mr-1">
                              ব্যাখ্যা:
                            </span>
                            <KatexMathText text={expInfo.text} examTypography />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Written Section */}
        {writtenItems.length > 0 && (
          <section className="mt-5 space-y-3">
            <h2 className="border-b border-slate-300 pb-1 exam-text-bn text-[11.5pt] font-bold text-slate-900">
              {mcqItems.length > 0
                ? `অংশ-খ: লিখিত প্রশ্নপত্র (${toBengaliNumber(writtenItems.length)}টি প্রশ্ন)`
                : `লিখিত প্রশ্নপত্র (মোট ${toBengaliNumber(writtenItems.length)}টি প্রশ্ন)`}
            </h2>

            <div className="space-y-3.5">
              {writtenItems.map((q, idx) => {
                const parsed = parseWrittenQuestionStructure(q.stem, 5);
                const expInfo = parseExplanationSource(
                  q.explanation,
                  q.bookTitle,
                  q.pageNumber
                );
                return (
                  <div
                    key={`print-w-${idx}`}
                    className="break-inside-avoid space-y-1.5 border-b border-slate-100 pb-3 last:border-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-semibold text-slate-950 leading-[1.6]">
                        <span className="exam-text-bn font-bold mr-1">
                          {toBengaliNumber(idx + 1)}.
                        </span>
                        <KatexMathText text={parsed.displayStem} examTypography />
                        {parsed.isChoiceOne && (
                          <span className="ml-1.5 text-[10pt] font-semibold text-amber-800 exam-text-bn">
                            (যেকোনো ১টি উত্তর দিন)
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-[10pt] font-bold text-slate-800">
                        [{toBengaliNumber(parsed.marks)}]
                      </span>
                    </div>

                    {parsed.subItems.length >= 2 && (
                      <div className="grid grid-cols-1 gap-1 pl-5 sm:grid-cols-2 text-slate-800">
                        {parsed.subItems.map((sub) => (
                          <div key={sub.label} className="leading-[1.55]">
                            <span className="font-semibold exam-text-bn">
                              {sub.label}.
                            </span>{' '}
                            <KatexMathText text={sub.prompt} examTypography />
                          </div>
                        ))}
                      </div>
                    )}

                    {printMode === 'with-answers' && (
                      <div className="ml-4 mt-1.5 rounded border border-slate-200 bg-slate-50/70 p-2.5 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-bold text-blue-800 exam-text-bn">
                            উত্তর:
                          </span>
                          {expInfo.hasExplanation && (
                            <span className="inline-flex items-center gap-0.5 text-[9.5pt] font-medium text-slate-500">
                              {expInfo.source === 'ai' ? (
                                <Sparkles className="h-2.5 w-2.5 text-blue-700" />
                              ) : (
                                <BookOpen className="h-2.5 w-2.5 text-emerald-700" />
                              )}
                              <span>{expInfo.badgeLabel}</span>
                            </span>
                          )}
                        </div>
                        <div className="whitespace-pre-wrap text-slate-900 leading-[1.6]">
                          <KatexMathText text={q.modelAnswer} examTypography />
                        </div>
                        {expInfo.hasExplanation && (
                          <div className="border-t border-rose-200/70 pt-1 text-[#7f1d1d] leading-[1.55]">
                            <span className="font-bold exam-text-bn mr-1">
                              ব্যাখ্যা:
                            </span>
                            <KatexMathText text={expInfo.text} examTypography />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
