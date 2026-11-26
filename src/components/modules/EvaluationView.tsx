'use client';

import React, { useMemo, useState } from 'react';
import { ArrowRight, Award, Trash2 } from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { ExamAnswerSheetView } from './ExamAnswerSheetView';

export function EvaluationView() {
  const {
    data,
    selectedAttemptId,
    setSelectedAttemptId,
    deleteExamAttempt,
    setActiveModule,
  } = useWorkspace();

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const activeAttempt = useMemo(
    () =>
      data.attempts.find((a) => a.id === selectedAttemptId) ??
      data.attempts[0] ??
      null,
    [data.attempts, selectedAttemptId]
  );

  const handleConfirmDeleteAttempt = async (attemptId: number) => {
    setDeleting(true);
    try {
      await deleteExamAttempt(attemptId);
      setConfirmDeleteId(null);
    } finally {
      setDeleting(false);
    }
  };

  if (!activeAttempt) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
        <Award className="mx-auto h-8 w-8 text-slate-400" />
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          এখনো কোনো পরীক্ষার ফলাফল নেই
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Exam Center থেকে একটি MCQ বা Written পরীক্ষা জমা দিলে এখানে বিস্তারিত উত্তরপত্র, মূল বই ও AI ব্যাখ্যা দেখতে পাবেন।
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

  return (
    <div className="space-y-6">
      {/* Header + Attempt Selector */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            05. AI Evaluation ও উত্তরপত্র বিশ্লেষণ
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            প্রতিটি প্রশ্নের সঠিক উত্তর, মূল বইয়ের ব্যাখ্যা (বইয়ে না থাকলে AI দিয়ে লেখা ব্যাখ্যা) এবং দুর্বল অধ্যায় বিশ্লেষণ।
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="w-full sm:w-72">
            <label
              htmlFor="eval-attempt-select"
              className="block text-xs font-semibold text-slate-600"
            >
              পরীক্ষার ফলাফল নির্বাচন করুন
            </label>
            <select
              id="eval-attempt-select"
              value={activeAttempt.id}
              onChange={(e) => {
                setConfirmDeleteId(null);
                setSelectedAttemptId(Number(e.target.value));
              }}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
            >
              {data.attempts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.examTitle} ({a.obtainedMarks}/{a.totalMarks})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {confirmDeleteId === activeAttempt.id ? (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5">
                <button
                  type="button"
                  data-testid="confirm-delete-attempt-btn"
                  disabled={deleting}
                  onClick={() => void handleConfirmDeleteAttempt(activeAttempt.id)}
                  className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {deleting ? 'মুছছে...' : 'নিশ্চিত মুছুন'}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setConfirmDeleteId(null)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  বাতিল
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="delete-attempt-btn"
                aria-label={`ফলাফল মুছুন: ${activeAttempt.examTitle}`}
                onClick={() => setConfirmDeleteId(activeAttempt.id)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>ফলাফল মুছুন</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveModule('planner')}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <span>ভুল নোটবুক</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Unified Question + Answer + Book/AI Explanation Sheet */}
      <ExamAnswerSheetView
        attempt={activeAttempt}
        questions={data.questions}
        books={data.books}
        defaultShowAnswers={true}
      />
    </div>
  );
}
