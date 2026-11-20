'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Play,
  Save,
  Send,
  Plus,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import {
  extractMistakesFromAttempt,
  scoreExamAttempt,
  type WrittenGradeOverride,
} from '@/src/lib/exam-engine';
import type { ExamAnswerDraft, ExamMode } from '@/src/types/system';

export function ExamCenterView() {
  const {
    data,
    activeExamId,
    setActiveExamId,
    createExam,
    saveExamDraft,
    saveExamAttempt,
    setActiveModule,
  } = useWorkspace();

  // Custom Exam Builder state
  const [showBuilder, setShowBuilder] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSubject, setNewSubject] = useState('সমন্বিত (বিসিএস ও ব্যাংক)');
  const [newMode, setNewMode] = useState<ExamMode>('Mixed');
  const [durationMinutes, setDurationMinutes] = useState(15);
  const [marksPerQuestion, setMarksPerQuestion] = useState(1);
  const [negativeMark, setNegativeMark] = useState(0.25);
  const [selectedQIds, setSelectedQIds] = useState<number[]>(() =>
    data.questions.slice(0, 5).map((q) => q.id)
  );
  const [builderError, setBuilderError] = useState<string | null>(null);

  // Live Exam Runner state
  const activeExam = useMemo(
    () => data.exams.find((e) => e.id === activeExamId) ?? null,
    [data.exams, activeExamId]
  );

  const activeExamQuestions = useMemo(() => {
    if (!activeExam) return [];
    const qMap = new Map(data.questions.map((q) => [q.id, q]));
    return activeExam.questionIds
      .map((id) => qMap.get(id))
      .filter((q): q is NonNullable<typeof q> => Boolean(q));
  }, [activeExam, data.questions]);

  const [answers, setAnswers] = useState<Record<string, ExamAnswerDraft>>(
    () => activeExam?.draftAnswers ?? {}
  );
  const [secondsLeft, setSecondsLeft] = useState(
    () => (activeExam?.durationMinutes ?? 15) * 60
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const beginExamSession = (exam: NonNullable<typeof activeExam>) => {
    setAnswers(exam.draftAnswers ?? {});
    setSecondsLeft(exam.durationMinutes * 60);
    setElapsedSeconds(0);
    setSavedNotice(null);
    setSubmitError(null);
    setActiveExamId(exam.id);
  };

  // Countdown timer
  useEffect(() => {
    if (!activeExam || submitting) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeExam, submitting]);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  const handleToggleQuestion = (qId: number) => {
    setSelectedQIds((prev) =>
      prev.includes(qId) ? prev.filter((id) => id !== qId) : [...prev, qId]
    );
  };

  const handleAutoPick = (mode: ExamMode) => {
    setNewMode(mode);
    const pool = data.questions.filter((q) => {
      if (mode === 'MCQ') return q.questionType === 'MCQ';
      if (mode === 'Written') return q.questionType !== 'MCQ';
      return true;
    });
    setSelectedQIds(pool.slice(0, 6).map((q) => q.id));
  };

  const handleCreateExam = async (e: React.FormEvent) => {
    e.preventDefault();
    setBuilderError(null);
    if (!newTitle.trim()) {
      setBuilderError('অনুগ্রহ করে পরীক্ষার শিরোনাম দিন।');
      return;
    }
    if (selectedQIds.length === 0) {
      setBuilderError('অন্তত ১টি প্রশ্ন নির্বাচন করুন।');
      return;
    }

    const created = await createExam({
      title: newTitle.trim(),
      subject: newSubject.trim() || 'সমন্বিত',
      examMode: newMode,
      durationMinutes: Math.max(2, durationMinutes),
      marksPerQuestion: Math.max(0.5, marksPerQuestion),
      negativeMark: Math.max(0, negativeMark),
      questionIds: selectedQIds,
    });

    setNewTitle('');
    setShowBuilder(false);
    beginExamSession(created);
  };

  const handleSaveMidExam = async () => {
    if (!activeExam) return;
    await saveExamDraft(activeExam.id, answers);
    setSavedNotice('পরীক্ষার উত্তর সংরক্ষিত হয়েছে — পরে আবার এখান থেকেই শুরু করতে পারবেন।');
    setTimeout(() => setSavedNotice(null), 3000);
  };

  const handleSubmitExam = async () => {
    if (!activeExam) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      // 1. Collect answered written/short questions for Gemini AI Evaluation
      const writtenInputs = activeExamQuestions
        .filter((q) => q.questionType !== 'MCQ')
        .map((q) => {
          const text = (answers[String(q.id)]?.writtenText ?? '').trim();
          const maxMarks =
            q.questionType === 'Short'
              ? Math.max(2, activeExam.marksPerQuestion * 2)
              : Math.max(5, activeExam.marksPerQuestion * 5);
          return {
            questionId: q.id,
            stem: q.stem,
            modelAnswer: q.modelAnswer,
            userAnswer: text,
            maxMarks,
            bookTitle: q.bookTitle,
            pageNumber: q.pageNumber,
          };
        })
        .filter((item) => item.userAnswer.length > 0);

      // Preliminary MCQ score for AI context
      const preliminary = scoreExamAttempt(
        activeExam,
        activeExamQuestions,
        answers
      );

      let writtenOverrides: WrittenGradeOverride[] = [];
      let aiRecommendation = '';

      try {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 14000);
        const res = await fetch('/api/ai/evaluate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            writtenItems: writtenInputs,
            examTitle: activeExam.title,
            weakTopics: preliminary.weakTopics,
            mcqAccuracy: preliminary.mcqAccuracy,
          }),
        });
        window.clearTimeout(timeoutId);
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json.writtenGrades)) {
            writtenOverrides = json.writtenGrades;
          }
          if (typeof json.aiRecommendation === 'string') {
            aiRecommendation = json.aiRecommendation;
          }
        }
      } catch {
        // Fallback deterministic evaluation still proceeds cleanly
      }

      const finalScore = scoreExamAttempt(
        activeExam,
        activeExamQuestions,
        answers,
        writtenOverrides
      );

      const fallbackRec =
        finalScore.weakTopics.length > 0
          ? `${finalScore.weakTopics.slice(0, 2).join(', ')} অধ্যায়গুলো পুনরায় রিভিশন দিন এবং ভুল নোটবুকের প্রশ্নগুলো অনুশীলন করুন।`
          : 'অসাধারণ ফলাফল! কঠিন স্তরের মডেল টেস্ট দিয়ে আপনার গতি ও নির্ভুলতা আরও বাড়ান।';

      const todayIso = new Date().toISOString().slice(0, 10);
      const extractedMistakes = extractMistakesFromAttempt(
        { id: 0, evaluations: finalScore.evaluations },
        1,
        todayIso
      ).map((m) => ({
        questionId: m.questionId,
        questionStem: m.questionStem,
        subject: m.subject,
        chapter: m.chapter,
        userAnswer: m.userAnswer,
        correctAnswer: m.correctAnswer,
        reason: m.reason,
        mastered: false,
        reviewCount: 0,
        nextReviewDate: m.nextReviewDate,
      }));

      await saveExamAttempt(
        {
          examId: activeExam.id,
          examTitle: activeExam.title,
          subject: activeExam.subject,
          totalMarks: finalScore.totalMarks,
          obtainedMarks: finalScore.obtainedMarks,
          negativeDeduction: finalScore.negativeDeduction,
          correctCount: finalScore.correctCount,
          wrongCount: finalScore.wrongCount,
          skippedCount: finalScore.skippedCount,
          mcqAccuracy: finalScore.mcqAccuracy,
          writtenScore: finalScore.writtenScore,
          durationSeconds: Math.max(10, elapsedSeconds),
          evaluations: finalScore.evaluations,
          weakTopics: finalScore.weakTopics,
          aiRecommendation: aiRecommendation || fallbackRec,
        },
        extractedMistakes
      );

      setActiveExamId(null);
      setActiveModule('evaluation');
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'পরীক্ষা জমা দিতে সমস্যা হয়েছে।'
      );
    } finally {
      setSubmitting(false);
    }
  };

  // LIVE EXAM RUNNER VIEW
  if (activeExam) {
    const answeredCount = activeExamQuestions.filter((q) => {
      const d = answers[String(q.id)];
      if (!d) return false;
      return q.questionType === 'MCQ'
        ? d.selectedOption !== undefined
        : Boolean(d.writtenText?.trim());
    }).length;

    return (
      <div className="space-y-6">
        {/* Sticky Exam Bar */}
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-slate-900">
              {activeExam.title}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
              <span>{activeExam.examMode}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                উত্তর দেওয়া হয়েছে: {answeredCount}/{activeExamQuestions.length}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-red-700">
                নেগেটিভ মার্কিং: -{activeExam.negativeMark}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div
              aria-label="অবশিষ্ট সময়"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm font-semibold tabular-nums text-slate-900"
            >
              <Clock className="h-4 w-4 text-blue-700" />
              <span>{formatTime(secondsLeft)}</span>
            </div>
            <button
              type="button"
              onClick={() => void handleSaveMidExam()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Save className="h-3.5 w-3.5" />
              <span>সংরক্ষণ</span>
            </button>
            <button
              type="button"
              onClick={() => void handleSubmitExam()}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>মূল্যায়ন হচ্ছে...</span>
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  <span>পরীক্ষা জমা দিন</span>
                </>
              )}
            </button>
          </div>
        </div>

        {submitting && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-medium text-blue-900"
          >
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>
              MCQ উত্তর মূল্যায়ন সম্পন্ন হয়েছে; লিখিত উত্তর ও ব্যক্তিগত পরামর্শ AI দ্বারা বিশ্লেষণ করা হচ্ছে...
            </span>
          </div>
        )}

        {savedNotice && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{savedNotice}</span>
          </div>
        )}

        {submitError && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-800"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        {/* Questions Sheet */}
        <div className="space-y-4">
          {activeExamQuestions.map((q, idx) => {
            const draft = answers[String(q.id)] ?? {};
            const maxMarks =
              q.questionType === 'MCQ'
                ? activeExam.marksPerQuestion
                : q.questionType === 'Short'
                  ? Math.max(2, activeExam.marksPerQuestion * 2)
                  : Math.max(5, activeExam.marksPerQuestion * 5);

            return (
              <article
                key={q.id}
                className="rounded-xl border border-slate-200 bg-white p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span>
                    প্রশ্ন {idx + 1} · {q.questionType} · {q.subject}
                  </span>
                  <span className="font-mono tabular-nums font-semibold text-slate-700">
                    নম্বর: {maxMarks}
                  </span>
                </div>
                <h2 className="mt-2 text-base font-semibold text-slate-900 leading-relaxed">
                  {q.stem}
                </h2>

                {q.questionType === 'MCQ' ? (
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {q.options.map((opt, optIdx) => {
                      const selected = draft.selectedOption === optIdx;
                      return (
                        <button
                          key={optIdx}
                          type="button"
                          onClick={() =>
                            setAnswers((prev) => ({
                              ...prev,
                              [String(q.id)]: {
                                ...prev[String(q.id)],
                                selectedOption: optIdx,
                              },
                            }))
                          }
                          aria-pressed={selected}
                          className={`flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors ${
                            selected
                              ? 'border-blue-700 bg-blue-50 font-semibold text-blue-900'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          <span className="font-mono text-xs font-semibold text-slate-500">
                            {String.fromCharCode(65 + optIdx)}.
                          </span>
                          <span>{opt}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-4">
                    <label
                      htmlFor={`written-answer-${q.id}`}
                      className="block text-xs font-medium text-slate-600 mb-1.5"
                    >
                      আপনার লিখিত উত্তর (জমা দেওয়ার পর AI মূল্যায়ন ও মডেল উত্তর দেখানো হবে)
                    </label>
                    <textarea
                      id={`written-answer-${q.id}`}
                      rows={4}
                      value={draft.writtenText ?? ''}
                      onChange={(e) =>
                        setAnswers((prev) => ({
                          ...prev,
                          [String(q.id)]: {
                            ...prev[String(q.id)],
                            writtenText: e.target.value,
                          },
                        }))
                      }
                      placeholder="মূল পয়েন্ট ও প্রাসঙ্গিক তথ্যসহ আপনার উত্তর এখানে লিখুন..."
                      className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 leading-relaxed focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={() => {
              void handleSaveMidExam();
              setActiveExamId(null);
            }}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            সংরক্ষণ করে পরীক্ষা তালিকা দেখুন
          </button>
          <button
            type="button"
            onClick={() => void handleSubmitExam()}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>AI মূল্যায়ন চলছে...</span>
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                <span>পরীক্ষা জমা দিন ও ফলাফল দেখুন</span>
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // EXAM HUB VIEW
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            04. Exam Center (MCQ ও Written পরীক্ষা)
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            নিজে প্রশ্ন নির্বাচন করে বা রেডি মডেল টেস্টে সময় ও নেগেটিভ মার্কিংসহ বাস্তব চাকরির পরীক্ষার অনুশীলন করুন।
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowBuilder((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="h-4 w-4" />
          <span>{showBuilder ? 'ফর্ম বন্ধ করুন' : 'নতুন পরীক্ষা তৈরি করুন'}</span>
        </button>
      </div>

      {/* Custom Exam Builder */}
      {showBuilder && (
        <form
          onSubmit={handleCreateExam}
          className="rounded-xl border border-slate-200 bg-white p-6 space-y-5"
        >
          <h2 className="text-base font-semibold text-slate-900">
            কাস্টম প্রশ্নপত্র ও পরীক্ষার নিয়মাবলি নির্ধারণ করুন
          </h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label
                htmlFor="exam-title-input"
                className="block text-xs font-semibold text-slate-700"
              >
                পরীক্ষার শিরোনাম *
              </label>
              <input
                id="exam-title-input"
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="যেমন: সংবিধান ও মুদ্রানীতি মডেল টেস্ট ০৩"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="exam-mode-select"
                className="block text-xs font-semibold text-slate-700"
              >
                পরীক্ষার ধরন
              </label>
              <select
                id="exam-mode-select"
                value={newMode}
                onChange={(e) => handleAutoPick(e.target.value as ExamMode)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              >
                <option value="Mixed">MCQ + Written (সমন্বিত)</option>
                <option value="MCQ">শুধু MCQ</option>
                <option value="Written">শুধু Written / Short</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="exam-subject-input"
                className="block text-xs font-semibold text-slate-700"
              >
                বিষয়
              </label>
              <input
                id="exam-subject-input"
                type="text"
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="exam-duration-input"
                className="block text-xs font-semibold text-slate-700"
              >
                সময় (মিনিট)
              </label>
              <input
                id="exam-duration-input"
                type="number"
                min={2}
                max={180}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="exam-marks-input"
                className="block text-xs font-semibold text-slate-700"
              >
                প্রতি MCQ নম্বর
              </label>
              <input
                id="exam-marks-input"
                type="number"
                step="0.5"
                min={0.5}
                value={marksPerQuestion}
                onChange={(e) => setMarksPerQuestion(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="exam-neg-select"
                className="block text-xs font-semibold text-slate-700"
              >
                নেগেটিভ মার্কিং (ভুল MCQ প্রতি)
              </label>
              <select
                id="exam-neg-select"
                value={negativeMark}
                onChange={(e) => setNegativeMark(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
              >
                <option value={0}>0.00 (নেই)</option>
                <option value={0.25}>-0.25 (ব্যাংক / প্রাইমারি)</option>
                <option value={0.5}>-0.50 (বিসিএস প্রিলিমিনারি)</option>
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-700">
                প্রশ্নব্যাংক থেকে প্রশ্ন নির্বাচন করুন ({selectedQIds.length}টি নির্বাচিত)
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
              {data.questions.map((q) => (
                <label
                  key={q.id}
                  className="flex items-start gap-2.5 p-3 hover:bg-slate-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedQIds.includes(q.id)}
                    onChange={() => handleToggleQuestion(q.id)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-slate-900">
                      {q.stem}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {q.questionType} · {q.difficulty} · {q.subject}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {builderError && (
            <p role="alert" className="text-xs font-medium text-red-700">
              {builderError}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowBuilder(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              বাতিল
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-800"
            >
              পরীক্ষা তৈরি করে শুরু করুন
            </button>
          </div>
        </form>
      )}

      {/* Ready Exams & Mock Tests List */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
        {data.exams.map((exam) => (
          <div
            key={exam.id}
            className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between hover:bg-slate-50/60 transition-colors"
          >
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900">
                {exam.title}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                <span className="font-medium text-slate-700">{exam.subject}</span>
                <span aria-hidden="true">·</span>
                <span>{exam.examMode}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {exam.questionIds.length}টি প্রশ্ন
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  সময় {exam.durationMinutes} মিনিট
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-red-700">
                  নেগেটিভ -{exam.negativeMark}
                </span>
                {exam.status === 'in_progress' && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-semibold text-amber-700">
                      চলমান (উত্তর সংরক্ষিত)
                    </span>
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => beginExamSession(exam)}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="h-3.5 w-3.5" />
              <span>
                {exam.status === 'in_progress'
                  ? 'পরীক্ষা চালিয়ে যান'
                  : 'পরীক্ষা শুরু করুন'}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
