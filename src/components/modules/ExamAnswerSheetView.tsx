'use client';

import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  BookOpen,
  Sparkles,
  Loader2,
  Eye,
  EyeOff,
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  FileSearch,
  X,
} from 'lucide-react';
import { KatexMathText } from './KatexMathText';
import {
  parseExplanationSource,
  type ParsedExplanation,
} from '@/src/lib/demo-paper-blueprint';
import {
  buildQuestionExamReferenceIndex,
  findExamReferencesForQuestion,
  type QuestionExamReference,
} from '@/src/lib/question-exam-references';
import { parseWrittenQuestionStructure } from '@/src/lib/job-exam-paper';
import { formatAiResponseError } from '@/src/lib/ai-client';
import { toBengaliNumber } from '@/src/lib/file-validation';
import { useWorkspace } from '@/src/components/WorkspaceProvider';
import type { Book, ExamAttempt, Question } from '@/src/types/system';

type AnswerFilter = 'all' | 'correct' | 'wrong' | 'skipped' | 'book' | 'ai';

const BENGALI_OPTION_LABELS = ['ক', 'খ', 'গ', 'ঘ'];

interface ExamAnswerSheetViewProps {
  attempt: ExamAttempt;
  questions: Question[];
  books: Book[];
  /** Optional extra AI explanations already generated for this attempt during submission */
  initialAiExplanations?: Record<number, string>;
  /** Whether the full Q&A + Explanations list starts open or collapsed behind the "Answer দেখুন" button */
  defaultShowAnswers?: boolean;
  onBack?: () => void;
  backLabel?: string;
}

export function ExamAnswerSheetView({
  attempt,
  questions,
  books,
  initialAiExplanations,
  defaultShowAnswers = true,
  onBack,
  backLabel = 'পরীক্ষার তালিকায় ফিরে যান',
}: ExamAnswerSheetViewProps) {
  const { getAiAuthHeaders, requestAiSignIn, openSourceQuestionInReader } =
    useWorkspace();
  const [showAnswers, setShowAnswers] = useState(defaultShowAnswers);
  const [filter, setFilter] = useState<AnswerFilter>('all');
  const [aiExplanations, setAiExplanations] = useState<Record<number, string>>(
    () => initialAiExplanations ?? {}
  );
  const [generatingAiExplanations, setGeneratingAiExplanations] =
    useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [activeReference, setActiveReference] =
    useState<QuestionExamReference | null>(null);

  const questionMap = useMemo(
    () => new Map(questions.map((q) => [q.id, q])),
    [questions]
  );

  const referenceIndex = useMemo(
    () => buildQuestionExamReferenceIndex(books),
    [books]
  );

  // Build unified items joining attempt.evaluations with full Question options, explanation provenance & exam references
  const enrichedItems = useMemo(() => {
    return attempt.evaluations.map((ev, index) => {
      const sourceQ = questionMap.get(ev.questionId);
      const overrideExp = aiExplanations[ev.questionId];

      // Priority: freshly generated AI explanation > Question Bank explanation > fallback empty
      const rawExp =
        overrideExp ||
        (sourceQ?.explanation && sourceQ.explanation.trim().length > 0
          ? sourceQ.explanation
          : '');

      const parsedExp: ParsedExplanation = parseExplanationSource(
        rawExp,
        ev.bookTitle,
        ev.pageNumber
      );

      const examReferences = findExamReferencesForQuestion(referenceIndex, {
        stem: ev.stem,
        bookId: sourceQ?.bookId ?? null,
        bookTitle: ev.bookTitle,
        pageNumber: ev.pageNumber,
        examSource: sourceQ?.examSource ?? null,
        chapter: ev.chapter,
      });

      return {
        index,
        ev,
        sourceQ,
        parsedExp,
        examReferences,
      };
    });
  }, [attempt.evaluations, questionMap, aiExplanations, referenceIndex]);

  const missingExplanationItems = useMemo(
    () => enrichedItems.filter((item) => !item.parsedExp.hasExplanation),
    [enrichedItems]
  );

  const filteredItems = useMemo(() => {
    return enrichedItems.filter((item) => {
      if (filter === 'all') return true;
      if (filter === 'correct') return item.ev.status === 'correct';
      if (filter === 'wrong')
        return item.ev.status === 'wrong' || item.ev.status === 'partial';
      if (filter === 'skipped') return item.ev.status === 'skipped';
      if (filter === 'book')
        return item.parsedExp.hasExplanation && item.parsedExp.source === 'book';
      if (filter === 'ai')
        return item.parsedExp.hasExplanation && item.parsedExp.source === 'ai';
      return true;
    });
  }, [enrichedItems, filter]);

  const scorePct =
    attempt.totalMarks > 0
      ? Math.max(
          0,
          Math.round((attempt.obtainedMarks / attempt.totalMarks) * 100)
        )
      : 0;

  const bookExpCount = enrichedItems.filter(
    (i) => i.parsedExp.hasExplanation && i.parsedExp.source === 'book'
  ).length;
  const aiExpCount = enrichedItems.filter(
    (i) => i.parsedExp.hasExplanation && i.parsedExp.source === 'ai'
  ).length;

  const handleGenerateMissingExplanations = async () => {
    if (missingExplanationItems.length === 0) return;
    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('অনুপস্থিত ব্যাখ্যা AI দিয়ে তৈরি');
      setExplainError(
        'AI দিয়ে ব্যাখ্যা তৈরি করতে উপরে "Google সাইন-ইন" বাটনে ক্লিক করে সাইন ইন করুন।'
      );
      return;
    }

    setGeneratingAiExplanations(true);
    setExplainError(null);
    try {
      const payloadItems = missingExplanationItems.slice(0, 25).map((item) => {
        const matchedBook = books.find(
          (b) =>
            b.title === item.ev.bookTitle ||
            (item.sourceQ?.bookId && b.id === item.sourceQ.bookId)
        );
        const matchedChunk = matchedBook?.chunks.find(
          (c) => c.pageNumber === item.ev.pageNumber
        );
        return {
          questionId: item.ev.questionId,
          stem: item.ev.stem,
          correctAnswer: item.ev.correctAnswer || item.ev.modelAnswer,
          options: item.sourceQ?.options ?? [],
          bookTitle: item.ev.bookTitle,
          bookExcerpt: matchedChunk?.content.slice(0, 1000) ?? '',
        };
      });

      const res = await fetch('/api/ai/explain-answers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ items: payloadItems }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          requestAiSignIn('অনুপস্থিত ব্যাখ্যা AI দিয়ে তৈরি');
        }
        throw new Error(
          formatAiResponseError(
            res.status,
            json,
            'AI দিয়ে ব্যাখ্যা তৈরি করা যায়নি।'
          )
        );
      }

      if (Array.isArray(json.explanations)) {
        setAiExplanations((prev) => {
          const next = { ...prev };
          for (const row of json.explanations) {
            if (row?.questionId && row?.explanation) {
              next[Number(row.questionId)] = String(row.explanation);
            }
          }
          return next;
        });
      }
    } catch (err) {
      setExplainError(
        err instanceof Error ? err.message : 'ব্যাখ্যা তৈরিতে সমস্যা হয়েছে।'
      );
    } finally {
      setGeneratingAiExplanations(false);
    }
  };

  return (
    <div data-testid="exam-answer-sheet-view" className="space-y-5">
      {/* Top Banner + Score Summary */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-4">
          <div>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="mb-2 inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>{backLabel}</span>
              </button>
            )}
            <h2 className="text-lg font-bold text-slate-900">
              {attempt.examTitle}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {attempt.subject} · মোট প্রশ্ন: {toBengaliNumber(attempt.evaluations.length)}টি · সময়:{' '}
              {toBengaliNumber(Math.floor(attempt.durationSeconds / 60))}মি{' '}
              {toBengaliNumber(attempt.durationSeconds % 60)}সে
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="toggle-answer-sheet-btn"
              onClick={() => setShowAnswers((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-semibold transition-colors ${
                showAnswers
                  ? 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                  : 'bg-blue-700 text-white hover:bg-blue-800'
              }`}
            >
              {showAnswers ? (
                <>
                  <EyeOff className="h-4 w-4" />
                  <span>উত্তর ও ব্যাখ্যা লুকান</span>
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" />
                  <span>উত্তরপত্র ও ব্যাখ্যা দেখুন (Answer Sheet)</span>
                </>
              )}
            </button>

            {missingExplanationItems.length > 0 && showAnswers && (
              <button
                type="button"
                data-testid="generate-missing-explanations-btn"
                disabled={generatingAiExplanations}
                onClick={() => void handleGenerateMissingExplanations()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-50"
              >
                {generatingAiExplanations ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>AI ব্যাখ্যা লিখছে...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>
                      অনুপস্থিত ব্যাখ্যা AI দিয়ে তৈরি করুন ({toBengaliNumber(missingExplanationItems.length)})
                    </span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-medium text-slate-500">প্রাপ্ত নম্বর</div>
            <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
              {attempt.obtainedMarks}
              <span className="text-xs font-normal text-slate-400">
                /{attempt.totalMarks}
              </span>
            </div>
            <div className="text-[11px] font-mono text-slate-500">{scorePct}% স্কোর</div>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
            <div className="text-[11px] font-medium text-emerald-700">সঠিক উত্তর</div>
            <div className="mt-1 font-mono text-xl font-bold text-emerald-800 tabular-nums">
              {toBengaliNumber(attempt.correctCount)}
            </div>
            <div className="text-[11px] font-mono text-emerald-700">
              MCQ নির্ভুলতা {attempt.mcqAccuracy}%
            </div>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50/50 p-3">
            <div className="text-[11px] font-medium text-red-700">ভুল ও নেগেটিভ</div>
            <div className="mt-1 font-mono text-xl font-bold text-red-700 tabular-nums">
              {toBengaliNumber(attempt.wrongCount)}
            </div>
            <div className="text-[11px] font-mono text-red-700">
              নেগেটিভ: -{attempt.negativeDeduction}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-medium text-slate-500">অনুত্তরিত</div>
            <div className="mt-1 font-mono text-xl font-bold text-slate-700 tabular-nums">
              {toBengaliNumber(attempt.skippedCount)}
            </div>
            <div className="text-[11px] text-slate-500">
              লিখিত: {attempt.writtenScore > 0 ? `${attempt.writtenScore}%` : '—'}
            </div>
          </div>
          <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
            <div className="text-[11px] font-medium text-blue-700">ব্যাখ্যার উৎস</div>
            <div className="mt-1 text-xs font-semibold text-slate-800 space-y-0.5">
              <div>মূল বই: {toBengaliNumber(bookExpCount)}টি</div>
              <div className="text-blue-700">AI ব্যাখ্যা: {toBengaliNumber(aiExpCount)}টি</div>
            </div>
          </div>
        </div>

        {attempt.aiRecommendation && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700 leading-relaxed">
            <span className="font-semibold text-slate-900">AI পরামর্শ: </span>
            {attempt.aiRecommendation}
          </div>
        )}
      </div>

      {explainError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{explainError}</span>
        </div>
      )}

      {/* Detailed Answer & Explanation Sheet */}
      {showAnswers && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <span className="text-xs font-bold text-slate-900">
              প্রশ্নভিত্তিক উত্তর ও বিস্তারিত ব্যাখ্যা ({toBengaliNumber(filteredItems.length)}টি)
            </span>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="উত্তরপত্র ফিল্টার">
              {(
                [
                  { id: 'all', label: `সব (${toBengaliNumber(enrichedItems.length)})` },
                  { id: 'correct', label: `সঠিক (${toBengaliNumber(attempt.correctCount)})` },
                  { id: 'wrong', label: `ভুল (${toBengaliNumber(attempt.wrongCount)})` },
                  { id: 'skipped', label: `বাদ (${toBengaliNumber(attempt.skippedCount)})` },
                  { id: 'book', label: `বইয়ের ব্যাখ্যা (${toBengaliNumber(bookExpCount)})` },
                  { id: 'ai', label: `AI ব্যাখ্যা (${toBengaliNumber(aiExpCount)})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === tab.id}
                  onClick={() => setFilter(tab.id)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    filter === tab.id
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {filteredItems.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              নির্বাচিত ফিল্টারে কোনো প্রশ্ন পাওয়া যায়নি।
            </div>
          ) : (
            <div className="space-y-4">
              {filteredItems.map(({ index, ev, sourceQ, parsedExp, examReferences }) => {
                const isCorrect = ev.status === 'correct';
                const isWrong = ev.status === 'wrong';
                const isPartial = ev.status === 'partial';
                const isSkipped = ev.status === 'skipped';

                const options = sourceQ?.options ?? [];
                const correctIdx = sourceQ?.correctOptionIndex ?? null;

                return (
                  <article
                    key={`${ev.questionId}-${index}`}
                    data-testid={`answer-sheet-card-${index + 1}`}
                    className="overflow-hidden rounded-xl border border-slate-200 bg-white"
                  >
                    {/* Question Card Header */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-bold text-slate-900">
                          প্রশ্ন {toBengaliNumber(index + 1)}
                        </span>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        {isCorrect && (
                          <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            সঠিক
                          </span>
                        )}
                        {isWrong && (
                          <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                            <XCircle className="h-3.5 w-3.5" />
                            ভুল
                          </span>
                        )}
                        {isPartial && (
                          <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
                            <MinusCircle className="h-3.5 w-3.5" />
                            আংশিক সঠিক
                          </span>
                        )}
                        {isSkipped && (
                          <span className="inline-flex items-center gap-1 font-semibold text-slate-500">
                            <MinusCircle className="h-3.5 w-3.5" />
                            অনুত্তরিত
                          </span>
                        )}
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700">
                          {ev.questionType}
                        </span>
                        <span className="text-slate-600">{ev.chapter}</span>
                      </div>

                      <div className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                        নম্বর:{' '}
                        <span
                          className={
                            ev.awardedMarks < 0
                              ? 'text-red-700'
                              : ev.awardedMarks > 0
                                ? 'text-emerald-700'
                                : 'text-slate-600'
                          }
                        >
                          {ev.awardedMarks > 0
                            ? `+${ev.awardedMarks}`
                            : ev.awardedMarks}
                        </span>{' '}
                        / {ev.maxMarks}
                      </div>
                    </div>

                    <div className="p-5 space-y-4">
                      {/* 1. Question Stem */}
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          প্রশ্ন
                        </div>
                        {ev.questionType !== 'MCQ' ? (
                          (() => {
                            const parsedW = parseWrittenQuestionStructure(
                              ev.stem,
                              ev.maxMarks
                            );
                            return (
                              <div className="mt-1 space-y-2">
                                <h3 className="text-sm font-semibold text-slate-900 leading-relaxed whitespace-pre-wrap">
                                  <KatexMathText text={parsedW.displayStem} />
                                  {parsedW.isChoiceOne && (
                                    <span className="ml-2 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 border border-amber-200">
                                      যেকোনো ১টি
                                    </span>
                                  )}
                                </h3>
                                {parsedW.subItems.length >= 2 && (
                                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 text-xs text-slate-700">
                                    {parsedW.subItems.map((sub) => (
                                      <div key={sub.label}>
                                        <span className="font-semibold text-slate-900">
                                          {sub.label}.
                                        </span>{' '}
                                        <KatexMathText text={sub.prompt} />
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()
                        ) : (
                          <h3 className="mt-1 text-sm font-semibold text-slate-900 leading-relaxed">
                            <KatexMathText text={ev.stem} />
                          </h3>
                        )}

                        {/* MCQ Options Highlight Grid */}
                        {ev.questionType === 'MCQ' && options.length > 0 && (
                          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {options.map((opt, optIdx) => {
                              const isCorrectOpt =
                                correctIdx !== null
                                  ? optIdx === correctIdx
                                  : opt.trim() === ev.correctAnswer.trim();
                              const isUserSelected =
                                ev.userAnswer.trim() === opt.trim();

                              let optStyle =
                                'border-slate-200 bg-white text-slate-700';
                              if (isCorrectOpt) {
                                optStyle =
                                  'border-emerald-300 bg-emerald-50 text-emerald-950 font-semibold';
                              } else if (isUserSelected && !isCorrectOpt) {
                                optStyle =
                                  'border-red-300 bg-red-50 text-red-900 font-medium';
                              }

                              return (
                                <div
                                  key={optIdx}
                                  className={`flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${optStyle}`}
                                >
                                  <div>
                                    <span className="mr-1.5 font-mono font-bold">
                                      {BENGALI_OPTION_LABELS[optIdx] ?? optIdx + 1})
                                    </span>
                                    <KatexMathText text={opt} />
                                  </div>
                                  {isCorrectOpt && (
                                    <span className="shrink-0 text-[10px] font-bold text-emerald-700">
                                      ✓ সঠিক
                                    </span>
                                  )}
                                  {isUserSelected && !isCorrectOpt && (
                                    <span className="shrink-0 text-[10px] font-bold text-red-700">
                                      ✗ আপনার পছন্দ
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* 2. Answer Section (Your Answer vs Correct / Model Answer) */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
                        <div
                          className={`rounded-lg border p-3 ${
                            isWrong
                              ? 'border-red-200 bg-red-50/40'
                              : isCorrect
                                ? 'border-emerald-200 bg-emerald-50/40'
                                : 'border-slate-200 bg-slate-50'
                          }`}
                        >
                          <div className="font-semibold text-slate-600">
                            আপনার উত্তর
                          </div>
                          <div className="mt-1 text-slate-900 leading-relaxed whitespace-pre-wrap">
                            <KatexMathText text={ev.userAnswer} />
                          </div>
                        </div>
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                          <div className="font-semibold text-emerald-800">
                            সঠিক / মডেল উত্তর (Answer)
                          </div>
                          <div className="mt-1 font-medium text-emerald-950 leading-relaxed whitespace-pre-wrap">
                            <KatexMathText
                              text={ev.correctAnswer || ev.modelAnswer}
                            />
                          </div>
                        </div>
                      </div>

                      {/* 3. Explanation Section (Book Explanation vs AI-written Explanation) */}
                      <div
                        data-testid={`answer-explanation-box-${index + 1}`}
                        className={`rounded-lg border p-3.5 text-xs leading-relaxed ${
                          parsedExp.hasExplanation && parsedExp.source === 'ai'
                            ? 'border-blue-200 bg-blue-50/60'
                            : 'border-slate-200 bg-slate-50/80'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-bold text-slate-900">
                            ব্যাখ্যা (Explanation)
                          </span>

                          {parsedExp.hasExplanation ? (
                            parsedExp.source === 'ai' ? (
                              <span
                                data-testid={`explanation-source-ai-${index + 1}`}
                                className="inline-flex items-center gap-1 rounded-md border border-blue-300 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-blue-800"
                              >
                                <Sparkles className="h-3 w-3 text-blue-700" />
                                <span>AI দিয়ে ব্যাখ্যা লেখা হয়েছে</span>
                              </span>
                            ) : (
                              <span
                                data-testid={`explanation-source-book-${index + 1}`}
                                className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800"
                              >
                                <BookOpen className="h-3 w-3 text-emerald-700" />
                                <span>মূল বইয়ের ব্যাখ্যা</span>
                              </span>
                            )
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                              বইয়ে ব্যাখ্যা নেই
                            </span>
                          )}
                        </div>

                        {parsedExp.hasExplanation ? (
                          <>
                            <p className="mt-2 text-slate-800 whitespace-pre-wrap">
                              <KatexMathText text={parsedExp.text} />
                            </p>
                            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-200/70 pt-2 text-[11px] text-slate-600">
                              <span className="inline-flex items-center gap-1">
                                <BookOpen className="h-3 w-3 shrink-0" />
                                উৎস: {ev.bookTitle} · পৃষ্ঠা{' '}
                                <span className="font-mono tabular-nums">
                                  {ev.pageNumber}
                                </span>
                              </span>
                              {parsedExp.source === 'ai' && (
                                <span className="text-blue-800 font-medium">
                                  · ({parsedExp.sourceNote})
                                </span>
                              )}
                            </p>
                          </>
                        ) : (
                          <p className="mt-1.5 text-slate-600">
                            {ev.mistakeExplanation} (উৎস: {ev.bookTitle}, পৃষ্ঠা{' '}
                            {ev.pageNumber}) — উপরের <strong>&ldquo;অনুপস্থিত ব্যাখ্যা AI দিয়ে তৈরি করুন&rdquo;</strong> বাটনে ক্লিক করলে AI ব্যাখ্যা লিখে দেবে।
                          </p>
                        )}

                        {/* Clickable Exam + Post References */}
                        {examReferences.length > 0 && (
                          <div
                            data-testid={`answer-exam-refs-${index + 1}`}
                            className="mt-3 rounded-lg border border-indigo-200/80 bg-white/90 p-2.5 space-y-2"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] font-bold text-indigo-900">
                              <span className="inline-flex items-center gap-1.5">
                                <FileSearch className="h-3.5 w-3.5 text-indigo-700" />
                                <span>
                                  যেসব পরীক্ষায় প্রশ্নটি এসেছে ({toBengaliNumber(examReferences.length)}টি রেফারেন্স — ক্লিক করে মূল প্রশ্ন দেখুন)
                                </span>
                              </span>
                            </div>
                            <div className="flex flex-col gap-1.5">
                              {examReferences.map((ref, refIdx) => (
                                <button
                                  key={ref.id}
                                  type="button"
                                  data-testid={`answer-exam-ref-btn-${index + 1}-${refIdx}`}
                                  onClick={() => setActiveReference(ref)}
                                  className="group flex w-full flex-col gap-1 rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2 text-left transition-colors hover:border-blue-400 hover:bg-blue-50/60 sm:flex-row sm:items-center sm:justify-between"
                                >
                                  <div className="min-w-0 space-y-0.5">
                                    <div className="text-xs font-semibold text-slate-900 group-hover:text-blue-900">
                                      {ref.examTitle}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-600">
                                      {ref.postName && (
                                        <span className="font-semibold text-indigo-800">
                                          পদ: {ref.postName}
                                        </span>
                                      )}
                                      {ref.examDate && (
                                        <>
                                          {ref.postName && (
                                            <span aria-hidden="true">·</span>
                                          )}
                                          <span className="font-mono tabular-nums">
                                            তারিখ: {ref.examDate}
                                          </span>
                                        </>
                                      )}
                                      <span aria-hidden="true">·</span>
                                      <span>
                                        {ref.bookTitle} (
                                        {ref.pageLabel.includes('পৃষ্ঠা')
                                          ? ref.pageLabel
                                          : `পৃষ্ঠা ${ref.pageLabel}`}
                                        )
                                      </span>
                                    </div>
                                  </div>
                                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-blue-700 group-hover:underline">
                                    <span>মূল প্রশ্ন দেখুন</span>
                                    <ExternalLink className="h-3 w-3" />
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Original Source Question Viewer Modal */}
      {activeReference && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="original-question-modal-title"
          data-testid="original-question-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[1px]"
          onClick={() => setActiveReference(null)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
              <div className="min-w-0 space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">
                  মূল পরীক্ষার প্রশ্নপত্র রেফারেন্স
                </div>
                <h3
                  id="original-question-modal-title"
                  className="text-base font-bold text-slate-900"
                >
                  {activeReference.examTitle}
                </h3>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
                  {activeReference.postName && (
                    <span className="font-semibold text-indigo-800">
                      পদের নাম: {activeReference.postName}
                    </span>
                  )}
                  {activeReference.examDate && (
                    <>
                      {activeReference.postName && <span aria-hidden="true">·</span>}
                      <span className="font-mono tabular-nums">
                        তারিখ: {activeReference.examDate}
                      </span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>
                    বই: {activeReference.bookTitle} (
                    {activeReference.pageLabel.includes('পৃষ্ঠা')
                      ? activeReference.pageLabel
                      : `পৃষ্ঠা ${activeReference.pageLabel}`}
                    )
                  </span>
                </div>
              </div>
              <button
                type="button"
                aria-label="বন্ধ করুন"
                onClick={() => setActiveReference(null)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {activeReference.originalQuestionText ? (
                <>
                  <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                    <div className="text-[11px] font-semibold text-slate-500">
                      মূল প্রশ্ন{' '}
                      {activeReference.numberLabel
                        ? `(${activeReference.numberLabel})`
                        : ''}
                    </div>
                    <p className="text-sm font-semibold text-slate-900 leading-relaxed whitespace-pre-wrap">
                      <KatexMathText text={activeReference.originalQuestionText} />
                    </p>

                    {activeReference.originalOptions.length > 0 && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 pt-1">
                        {activeReference.originalOptions.map((opt, idx) => (
                          <div
                            key={`${opt.marker}-${idx}`}
                            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800"
                          >
                            <span className="mr-1.5 font-mono font-bold text-slate-900">
                              {opt.marker.replace(/[.)ঃ:\s]+$/g, '')})
                            </span>
                            <KatexMathText text={opt.text} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {activeReference.originalAnswerText && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 text-xs">
                      <span className="font-bold text-emerald-900">
                        মূল বইয়ের উত্তর:{' '}
                      </span>
                      <span className="font-semibold text-emerald-950">
                        <KatexMathText text={activeReference.originalAnswerText} />
                      </span>
                    </div>
                  )}

                  {activeReference.originalExplanation && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-800 whitespace-pre-wrap">
                      <div className="mb-1 font-bold text-slate-900">
                        মূল বইয়ের ব্যাখ্যা
                      </div>
                      <KatexMathText text={activeReference.originalExplanation} />
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                  <div className="mb-2 font-bold text-slate-900">
                    মূল বইয়ের সংশ্লিষ্ট পৃষ্ঠার অংশ (
                    {activeReference.pageLabel.includes('পৃষ্ঠা')
                      ? activeReference.pageLabel
                      : `পৃষ্ঠা ${activeReference.pageLabel}`}
                    )
                  </div>
                  {activeReference.sourcePageExcerpt ||
                    'এই পৃষ্ঠার পূর্ণাঙ্গ প্রশ্নপত্র দেখতে নিচের বাটনে ক্লিক করে Smart Reader খুলুন।'}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setActiveReference(null)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                বন্ধ করুন
              </button>
              <button
                type="button"
                data-testid="open-in-smart-reader-btn"
                onClick={() => {
                  const target = activeReference;
                  setActiveReference(null);
                  openSourceQuestionInReader({
                    bookId: target.bookId,
                    pageNumber: target.pageNumber,
                    examId: target.examId,
                  });
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors"
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span>স্মার্ট রিডারে মূল প্রশ্নপত্র খুলুন</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
