'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  BookOpen,
  ArrowRight,
  Award,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';

export function EvaluationView() {
  const {
    data,
    selectedAttemptId,
    setSelectedAttemptId,
    setActiveModule,
  } = useWorkspace();

  const activeAttempt = useMemo(
    () =>
      data.attempts.find((a) => a.id === selectedAttemptId) ??
      data.attempts[0] ??
      null,
    [data.attempts, selectedAttemptId]
  );

  if (!activeAttempt) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
        <Award className="mx-auto h-8 w-8 text-slate-400" />
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          এখনো কোনো পরীক্ষার ফলাফল নেই
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Exam Center থেকে একটি MCQ বা Written পরীক্ষা জমা দিলে এখানে বিস্তারিত AI মূল্যায়ন ও মডেল উত্তর দেখতে পাবেন।
        </p>
        <button
          type="button"
          onClick={() => setActiveModule('exam-center')}
          className="mt-4 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          পরীক্ষা কেন্দ্রে যান
        </button>
      </div>
    );
  }

  const scorePct =
    activeAttempt.totalMarks > 0
      ? Math.max(
          0,
          Math.round((activeAttempt.obtainedMarks / activeAttempt.totalMarks) * 100)
        )
      : 0;

  return (
    <div className="space-y-6">
      {/* Header + Attempt Selector */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            05. AI Evaluation ও পরীক্ষার ফলাফল
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            স্বয়ংক্রিয় MCQ মূল্যায়ন, লিখিত উত্তরের মান যাচাই, মডেল উত্তর, ভুলের কারণ এবং দুর্বল টপিক বিশ্লেষণ।
          </p>
        </div>

        <div className="w-full sm:w-80">
          <label
            htmlFor="eval-attempt-select"
            className="block text-xs font-semibold text-slate-600"
          >
            পরীক্ষার ফলাফল নির্বাচন করুন
          </label>
          <select
            id="eval-attempt-select"
            value={activeAttempt.id}
            onChange={(e) => setSelectedAttemptId(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
          >
            {data.attempts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.examTitle} ({a.obtainedMarks}/{a.totalMarks})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Scorecard KPI Strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5 rounded-xl border border-slate-200 bg-white divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">প্রাপ্ত নম্বর</div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {activeAttempt.obtainedMarks}
            <span className="text-sm font-normal text-slate-400">
              /{activeAttempt.totalMarks}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
            {scorePct}% স্কোর
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">নেগেটিভ কাটা</div>
          <div className="mt-1 font-mono text-2xl font-bold text-red-700 tabular-nums">
            -{activeAttempt.negativeDeduction}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
            ভুল: {activeAttempt.wrongCount} · বাদ: {activeAttempt.skippedCount}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">MCQ নির্ভুলতা</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {activeAttempt.mcqAccuracy}%
          </div>
          <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
            সঠিক: {activeAttempt.correctCount}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">লিখিত স্কোর</div>
          <div className="mt-1 font-mono text-2xl font-bold text-blue-700 tabular-nums">
            {activeAttempt.writtenScore > 0
              ? `${activeAttempt.writtenScore}%`
              : 'প্রযোজ্য নয়'}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">AI পরীক্ষক মূল্যায়ন</div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">মোট সময়</div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {Math.floor(activeAttempt.durationSeconds / 60)}মি{' '}
            {activeAttempt.durationSeconds % 60}সে
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {activeAttempt.subject}
          </div>
        </div>
      </div>

      {/* AI Recommendation & Weak Topics */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              AI পরীক্ষকের সামগ্রিক পরামর্শ ও দুর্বল টপিক
            </h2>
            <p className="mt-1.5 text-sm text-slate-700 leading-relaxed">
              {activeAttempt.aiRecommendation}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setActiveModule('planner')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <span>ভুল নোটবুকে রিভিশন করুন</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {activeAttempt.weakTopics.length > 0 && (
          <div className="border-t border-slate-100 pt-3 text-xs text-slate-600">
            <span className="font-semibold text-red-700">
              শনাক্তকৃত দুর্বল অধ্যায়:
            </span>{' '}
            {activeAttempt.weakTopics.join(' · ')}
          </div>
        )}
      </section>

      {/* Question-by-Question Detailed Evaluation */}
      <section aria-label="প্রশ্নভিত্তিক বিস্তারিত মূল্যায়ন" className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">
          প্রশ্নভিত্তিক উত্তর মূল্যায়ন ও মডেল উত্তর
        </h2>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
          {activeAttempt.evaluations.map((ev, idx) => {
            const isCorrect = ev.status === 'correct';
            const isWrong = ev.status === 'wrong';
            const isSkipped = ev.status === 'skipped';

            return (
              <article key={`${ev.questionId}-${idx}`} className="p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {isCorrect && (
                      <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                        <CheckCircle2 className="h-4 w-4" />
                        সঠিক
                      </span>
                    )}
                    {isWrong && (
                      <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                        <XCircle className="h-4 w-4" />
                        ভুল
                      </span>
                    )}
                    {ev.status === 'partial' && (
                      <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
                        <MinusCircle className="h-4 w-4" />
                        আংশিক সঠিক
                      </span>
                    )}
                    {isSkipped && (
                      <span className="inline-flex items-center gap-1 font-semibold text-slate-500">
                        <MinusCircle className="h-4 w-4" />
                        অনুত্তরিত
                      </span>
                    )}
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span className="text-slate-600">{ev.questionType}</span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
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
                      {ev.awardedMarks > 0 ? `+${ev.awardedMarks}` : ev.awardedMarks}
                    </span>{' '}
                    / {ev.maxMarks}
                  </div>
                </div>

                <h3 className="text-sm font-semibold text-slate-900 leading-relaxed">
                  {idx + 1}. {ev.stem}
                </h3>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="font-semibold text-slate-600">আপনার উত্তর</div>
                    <p className="mt-1 text-slate-800 leading-relaxed whitespace-pre-wrap">
                      {ev.userAnswer}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="font-semibold text-emerald-800">
                      সঠিক / মডেল উত্তর
                    </div>
                    <p className="mt-1 text-slate-800 leading-relaxed whitespace-pre-wrap">
                      {ev.modelAnswer || ev.correctAnswer}
                    </p>
                  </div>
                </div>

                <div className="space-y-1 text-xs text-slate-600 leading-relaxed">
                  <p>
                    <span className="font-semibold text-slate-800">
                      বিশ্লেষণ:
                    </span>{' '}
                    {ev.mistakeExplanation}
                  </p>
                  <p>
                    <span className="font-semibold text-blue-800">
                      উন্নতির পরামর্শ:
                    </span>{' '}
                    {ev.improvementTip}
                  </p>
                  <p className="inline-flex items-center gap-1.5 text-slate-500 pt-1">
                    <BookOpen className="h-3.5 w-3.5" />
                    <span>
                      উৎস: {ev.bookTitle} · পৃষ্ঠা{' '}
                      <span className="font-mono tabular-nums">
                        {ev.pageNumber}
                      </span>
                    </span>
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
