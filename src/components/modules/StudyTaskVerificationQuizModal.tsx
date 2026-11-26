'use client';

import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ClipboardCheck,
  X,
  XCircle,
} from 'lucide-react';
import { compileExamSetsLocallyFromBooks } from '@/src/lib/local-question-compiler';
import { toBengaliNumber } from '@/src/lib/file-validation';
import { getTodayIsoDate } from '@/src/lib/smart-study-planner';
import type { Book, MistakeItem, Question, StudyTask } from '@/src/types/system';

interface StudyTaskVerificationQuizModalProps {
  task: StudyTask;
  books: Book[];
  questions: Question[];
  onClose: () => void;
  onQuizCompleted: (result: {
    passed: boolean;
    correctCount: number;
    totalCount: number;
    wrongMistakes: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>>;
  }) => Promise<void>;
}

const OPTION_LABELS = ['ক', 'খ', 'গ', 'ঘ'];

export function StudyTaskVerificationQuizModal({
  task,
  books,
  questions,
  onClose,
  onQuizCompleted,
}: StudyTaskVerificationQuizModalProps) {
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Pull up to 5 real MCQs dynamically from ALL books (prioritizing task's book/subject) + Question Bank
  const quizQuestions = useMemo(() => {
    const taskNorm = `${task.title} ${task.subject} ${task.chapter}`.toLowerCase();

    // Prioritize matching books first, then include all remaining books so newly added books always participate
    const sortedBooks = [...books].sort((a, b) => {
      const aHit =
        taskNorm.includes(a.title.toLowerCase()) ||
        taskNorm.includes(a.subject.toLowerCase())
          ? 1
          : 0;
      const bHit =
        taskNorm.includes(b.title.toLowerCase()) ||
        taskNorm.includes(b.subject.toLowerCase())
          ? 1
          : 0;
      if (bHit !== aHit) return bHit - aHit;
      return b.id - a.id;
    });

    const compiled = compileExamSetsLocallyFromBooks({
      books: sortedBooks,
      gkItems: [],
      includeCurrentGk: false,
      questionMode: 'MCQ',
      mcqCount: 5,
      writtenCount: 0,
      setCount: 1,
      difficulty: 'Medium',
      subject: task.subject || 'সমন্বিত',
      jobExamPreset: task.title,
      existingStems: [],
      orderingMode: 'shuffled',
    });

    const fromBooks = compiled.sets[0]?.questions ?? [];
    if (fromBooks.length >= 3) {
      return fromBooks.slice(0, 5);
    }

    // Fallback: supplement from Question Bank MCQs if books are plain-text textbooks without parsed MCQs
    const bankMcqs = questions
      .filter((q) => q.questionType === 'MCQ' && q.options.length >= 2)
      .sort((a, b) => {
        const aMatch =
          a.subject.toLowerCase().includes(task.subject.toLowerCase()) ||
          a.chapter.toLowerCase().includes(task.chapter.toLowerCase())
            ? 1
            : 0;
        const bMatch =
          b.subject.toLowerCase().includes(task.subject.toLowerCase()) ||
          b.chapter.toLowerCase().includes(task.chapter.toLowerCase())
            ? 1
            : 0;
        return bMatch - aMatch;
      })
      .map((q) => ({
        bookId: q.bookId,
        bookTitle: q.bookTitle,
        chapter: q.chapter,
        pageNumber: q.pageNumber,
        subject: q.subject,
        questionType: q.questionType,
        difficulty: q.difficulty,
        stem: q.stem,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        modelAnswer: q.modelAnswer,
        explanation: q.explanation,
        isPreviousYear: q.isPreviousYear,
        examYear: q.examYear,
        examSource: q.examSource,
        importanceScore: q.importanceScore,
      }));

    const seen = new Set(fromBooks.map((q) => q.stem.trim().toLowerCase()));
    const combined = [...fromBooks];
    for (const q of bankMcqs) {
      const k = q.stem.trim().toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        combined.push(q);
      }
      if (combined.length >= 5) break;
    }

    return combined.slice(0, 5);
  }, [books, questions, task.title, task.subject, task.chapter]);

  const results = useMemo(() => {
    if (!submitted) return null;
    let correctCount = 0;
    const wrongMistakes: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>> = [];
    const today = getTodayIsoDate();

    quizQuestions.forEach((q, idx) => {
      const chosenIdx = selectedAnswers[idx];
      const correctIdx = q.correctOptionIndex ?? 0;
      const isCorrect = chosenIdx === correctIdx;
      if (isCorrect) {
        correctCount += 1;
      } else {
        wrongMistakes.push({
          questionId: null,
          questionStem: q.stem,
          subject: q.subject || task.subject || 'সাধারণ',
          chapter: q.chapter || task.chapter || 'যাচাই কুইজ',
          userAnswer:
            chosenIdx !== undefined
              ? q.options[chosenIdx] ?? 'উত্তর দেওয়া হয়নি'
              : 'উত্তর দেওয়া হয়নি',
          correctAnswer:
            q.options[correctIdx] ?? q.modelAnswer ?? 'সঠিক উত্তর',
          reason:
            q.explanation ||
            `পড়া যাচাই কুইজ (${task.title}) — উৎস: ${q.bookTitle}, পৃষ্ঠা ${q.pageNumber}`,
          mastered: false,
          reviewCount: 0,
          nextReviewDate: today,
        });
      }
    });

    const totalCount = quizQuestions.length;
    const passed = totalCount > 0 && correctCount / totalCount >= 0.6;
    return { passed, correctCount, totalCount, wrongMistakes };
  }, [submitted, quizQuestions, selectedAnswers, task.subject, task.chapter, task.title]);

  const handleSubmit = async () => {
    if (quizQuestions.length === 0 || submitted) return;
    setSubmitted(true);
    setSaving(true);
    try {
      let correctCount = 0;
      const wrongMistakes: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>> = [];
      const today = getTodayIsoDate();

      quizQuestions.forEach((q, idx) => {
        const chosenIdx = selectedAnswers[idx];
        const correctIdx = q.correctOptionIndex ?? 0;
        if (chosenIdx === correctIdx) {
          correctCount += 1;
        } else {
          wrongMistakes.push({
            questionId: null,
            questionStem: q.stem,
            subject: q.subject || task.subject || 'সাধারণ',
            chapter: q.chapter || task.chapter || 'যাচাই কুইজ',
            userAnswer:
              chosenIdx !== undefined
                ? q.options[chosenIdx] ?? 'উত্তর দেওয়া হয়নি'
                : 'উত্তর দেওয়া হয়নি',
            correctAnswer:
              q.options[correctIdx] ?? q.modelAnswer ?? 'সঠিক উত্তর',
            reason:
              q.explanation ||
              `পড়া যাচাই কুইজ (${task.title}) — উৎস: ${q.bookTitle}, পৃষ্ঠা ${q.pageNumber}`,
            mastered: false,
            reviewCount: 0,
            nextReviewDate: today,
          });
        }
      });

      const totalCount = quizQuestions.length;
      const passed = totalCount > 0 && correctCount / totalCount >= 0.6;
      await onQuizCompleted({
        passed,
        correctCount,
        totalCount,
        wrongMistakes,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="verification-quiz-title"
      data-testid="verification-quiz-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-blue-700">
              <ClipboardCheck className="h-3.5 w-3.5" />
              <span>০ API যাচাই কুইজ · লাইব্রেরির বই থেকে</span>
            </div>
            <h3
              id="verification-quiz-title"
              className="mt-0.5 text-base font-bold text-slate-900 truncate"
            >
              {task.title}
            </h3>
            <p className="text-xs text-slate-500">
              পাস করলে কাজটি স্বয়ংক্রিয়ভাবে সম্পন্ন হবে; ভুল প্রশ্নগুলো ভুল নোটবুকে যুক্ত হবে।
            </p>
          </div>
          <button
            type="button"
            aria-label="বন্ধ করুন"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {results && (
            <div
              data-testid="verification-quiz-result"
              className={`rounded-xl border p-4 text-xs ${
                results.passed
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              <div className="font-bold text-sm">
                স্কোর: {toBengaliNumber(results.correctCount)}/
                {toBengaliNumber(results.totalCount)} —{' '}
                {results.passed
                  ? 'চমৎকার! কাজটি সম্পন্ন চিহ্নিত করা হয়েছে।'
                  : 'আরও একটু রিভিশন প্রয়োজন!'}
              </div>
              {results.wrongMistakes.length > 0 && (
                <p className="mt-1">
                  ভুল হওয়া {toBengaliNumber(results.wrongMistakes.length)}টি প্রশ্ন
                  স্বয়ংক্রিয়ভাবে আপনার <strong>ভুল নোটবুকে</strong> যুক্ত করা হয়েছে।
                </p>
              )}
            </div>
          )}

          {quizQuestions.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-xs text-slate-600">
              আপনার লাইব্রেরির বইগুলোতে এখনো MCQ প্রশ্ন পাওয়া যায়নি। নতুন MCQ জব সলুশন বই যোগ করলে এখানে সাথে সাথে কুইজ তৈরি হবে।
            </div>
          ) : (
            quizQuestions.map((q, qIdx) => {
              const chosenIdx = selectedAnswers[qIdx];
              const correctIdx = q.correctOptionIndex ?? 0;

              return (
                <div
                  key={qIdx}
                  className="rounded-xl border border-slate-200 bg-white p-4 space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900 leading-relaxed">
                      <span className="mr-1.5 font-mono text-blue-700">
                        {toBengaliNumber(qIdx + 1)}.
                      </span>
                      {q.stem}
                    </p>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {q.bookTitle.slice(0, 24)}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {q.options.map((opt, optIdx) => {
                      const isChosen = chosenIdx === optIdx;
                      const isCorrect = optIdx === correctIdx;

                      let cls =
                        'border-slate-200 bg-slate-50/70 text-slate-800 hover:border-blue-400';
                      if (submitted) {
                        if (isCorrect) {
                          cls =
                            'border-emerald-400 bg-emerald-50 text-emerald-950 font-semibold';
                        } else if (isChosen && !isCorrect) {
                          cls = 'border-red-300 bg-red-50 text-red-900';
                        } else {
                          cls = 'border-slate-200 bg-white text-slate-500';
                        }
                      } else if (isChosen) {
                        cls =
                          'border-blue-600 bg-blue-50 text-blue-950 font-semibold';
                      }

                      return (
                        <button
                          key={optIdx}
                          type="button"
                          disabled={submitted}
                          onClick={() =>
                            setSelectedAnswers((prev) => ({
                              ...prev,
                              [qIdx]: optIdx,
                            }))
                          }
                          className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${cls}`}
                        >
                          <span>
                            <span className="mr-1.5 font-mono font-bold">
                              {OPTION_LABELS[optIdx] ?? optIdx + 1})
                            </span>
                            {opt}
                          </span>
                          {submitted && isCorrect && (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
                          )}
                          {submitted && isChosen && !isCorrect && (
                            <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            বন্ধ করুন
          </button>
          {!submitted && quizQuestions.length > 0 && (
            <button
              type="button"
              data-testid="submit-verification-quiz-btn"
              disabled={saving}
              onClick={() => void handleSubmit()}
              className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
            >
              {saving ? 'যাচাই হচ্ছে...' : 'উত্তর যাচাই করুন'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
