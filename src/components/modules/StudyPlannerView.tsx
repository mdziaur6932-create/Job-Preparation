'use client';

import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Plus,
  Trash2,
  RotateCcw,
  Calendar,
  BookMarked,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';

type PlannerTab = 'routine' | 'mistakes' | 'revision';

export function StudyPlannerView() {
  const {
    data,
    addStudyTask,
    toggleStudyTask,
    deleteStudyTask,
    toggleMistakeMastered,
    createExam,
    setActiveExamId,
    setActiveModule,
  } = useWorkspace();

  const [tab, setTab] = useState<PlannerTab>('routine');

  // Add Task Form
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('বাংলাদেশ বিষয়াবলি');
  const [chapter, setChapter] = useState('');
  const [taskType, setTaskType] = useState<
    'reading' | 'revision' | 'practice' | 'exam'
  >('reading');
  const [scheduledDate, setScheduledDate] = useState('2026-11-20');
  const [durationMinutes, setDurationMinutes] = useState(45);
  const [taskError, setTaskError] = useState<string | null>(null);

  const completedTasks = data.studyTasks.filter((t) => t.completed).length;
  const completionPct =
    data.studyTasks.length > 0
      ? Math.round((completedTasks / data.studyTasks.length) * 100)
      : 0;

  const activeMistakes = useMemo(
    () => data.mistakes.filter((m) => !m.mastered),
    [data.mistakes]
  );

  // Smart Revision items derived from weak topics & library chapters
  const smartRevisionList = useMemo(() => {
    const weakSet = new Set(data.attempts.flatMap((a) => a.weakTopics));
    return data.books.flatMap((book) =>
      book.chunks.map((ch) => ({
        id: ch.id,
        bookTitle: book.title,
        subject: book.subject,
        chapter: ch.chapter,
        pageNumber: ch.pageNumber,
        priority: weakSet.has(ch.chapter) ? 'উচ্চ অগ্রাধিকার (দুর্বল অধ্যায়)' : 'নিয়মিত রিভিশন',
        isWeak: weakSet.has(ch.chapter),
      }))
    );
  }, [data.books, data.attempts]);

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setTaskError(null);
    if (!title.trim()) {
      setTaskError('অনুগ্রহ করে পড়ার লক্ষ্য বা কাজের শিরোনাম লিখুন।');
      return;
    }
    await addStudyTask({
      title: title.trim(),
      subject: subject.trim() || 'সাধারণ',
      chapter: chapter.trim() || 'মূল অধ্যায়',
      taskType,
      scheduledDate: scheduledDate || '2026-11-20',
      durationMinutes: Math.max(10, durationMinutes),
    });
    setTitle('');
    setChapter('');
  };

  const handleStartMistakeExam = async () => {
    const mistakeQuestionIds = Array.from(
      new Set(
        activeMistakes
          .map((m) => m.questionId)
          .filter((id): id is number => typeof id === 'number')
      )
    );
    const validIds = mistakeQuestionIds.filter((id) =>
      data.questions.some((q) => q.id === id)
    );
    if (validIds.length === 0) return;

    const exam = await createExam({
      title: `ভুল নোটবুক পুনঃঅনুশীলন পরীক্ষা (${validIds.length} প্রশ্ন)`,
      subject: 'ভুল সংশোধন অনুশীলন',
      examMode: 'Mixed',
      durationMinutes: Math.max(5, validIds.length * 2),
      marksPerQuestion: 1,
      negativeMark: 0.25,
      questionIds: validIds,
    });
    setActiveExamId(exam.id);
    setActiveModule('exam-center');
  };

  const taskTypeLabel: Record<string, string> = {
    reading: 'অধ্যায় পড়া',
    revision: 'রিভিশন',
    practice: 'অনুশীলন',
    exam: 'মডেল টেস্ট',
  };

  return (
    <div className="space-y-6">
      {/* Header + Tabs */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            07. Study Planner, Mistake Notebook ও Smart Revision
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            দৈনিক পড়ার লক্ষ্য নির্ধারণ করুন, ভুল করা প্রশ্নগুলো আলাদাভাবে অনুশীলন করুন এবং স্পেসড-রিভিশন রুটিন অনুসরণ করুন।
          </p>
        </div>

        <div
          role="tablist"
          aria-label="প্ল্যানার সেকশন"
          className="inline-flex items-center gap-1 rounded-lg bg-slate-200/70 p-1 self-start sm:self-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'routine'}
            onClick={() => setTab('routine')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              tab === 'routine'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            দৈনিক রুটিন ({data.studyTasks.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mistakes'}
            onClick={() => setTab('mistakes')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              tab === 'mistakes'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            ভুল নোটবুক ({activeMistakes.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'revision'}
            onClick={() => setTab('revision')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              tab === 'revision'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            স্মার্ট রিভিশন
          </button>
        </div>
      </div>

      {/* TAB 1: DAILY ROUTINE */}
      {tab === 'routine' && (
        <div className="space-y-6">
          {/* Progress Summary */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-900">
                আজকের ও আসন্ন পড়ার অগ্রগতি
              </span>
              <span className="font-mono font-semibold tabular-nums text-blue-700">
                {completedTasks}/{data.studyTasks.length} সম্পন্ন ({completionPct}%)
              </span>
            </div>
            <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full bg-blue-700 transition-all duration-200"
                style={{ width: `${completionPct}%` }}
              />
            </div>
          </div>

          {/* Quick Add Task Form */}
          <form
            onSubmit={handleAddTask}
            className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
          >
            <h2 className="text-sm font-semibold text-slate-900">
              নতুন পড়ার লক্ষ্য যুক্ত করুন
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <div className="sm:col-span-2">
                <label
                  htmlFor="task-title-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  লক্ষ্য / কাজের বিবরণ *
                </label>
                <input
                  id="task-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="যেমন: সংবিধানের অনুচ্ছেদ ৪৮–৬৫ রিভিশন"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="task-subject-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  বিষয়
                </label>
                <input
                  id="task-subject-input"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor="task-type-select"
                  className="block text-xs font-semibold text-slate-700"
                >
                  ধরন
                </label>
                <select
                  id="task-type-select"
                  value={taskType}
                  onChange={(e) =>
                    setTaskType(
                      e.target.value as
                        | 'reading'
                        | 'revision'
                        | 'practice'
                        | 'exam'
                    )
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                >
                  <option value="reading">অধ্যায় পড়া</option>
                  <option value="revision">রিভিশন</option>
                  <option value="practice">অনুশীলন</option>
                  <option value="exam">মডেল টেস্ট</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="task-date-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  তারিখ
                </label>
                <input
                  id="task-date-input"
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor="task-duration-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  সময় (মিনিট)
                </label>
                <input
                  id="task-duration-input"
                  type="number"
                  min={10}
                  max={240}
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
                />
              </div>
            </div>

            {taskError && (
              <p role="alert" className="text-xs font-medium text-red-700">
                {taskError}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>রুটিনে যুক্ত করুন</span>
              </button>
            </div>
          </form>

          {/* Tasks List */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
            {data.studyTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center justify-between gap-4 p-4 hover:bg-slate-50/70 transition-colors"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => void toggleStudyTask(task.id)}
                    aria-label={
                      task.completed
                        ? `অসম্পন্ন চিহ্নিত করুন: ${task.title}`
                        : `সম্পন্ন চিহ্নিত করুন: ${task.title}`
                    }
                    className="mt-0.5 text-slate-400 hover:text-blue-700 shrink-0"
                  >
                    {task.completed ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-700" />
                    ) : (
                      <Circle className="h-5 w-5" />
                    )}
                  </button>
                  <div className="min-w-0">
                    <p
                      className={`text-sm font-semibold ${
                        task.completed
                          ? 'line-through text-slate-400'
                          : 'text-slate-900'
                      }`}
                    >
                      {task.title}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span>{task.subject}</span>
                      <span aria-hidden="true">·</span>
                      <span>{taskTypeLabel[task.taskType] ?? task.taskType}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {task.scheduledDate}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {task.durationMinutes} মিনিট
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void deleteStudyTask(task.id)}
                  aria-label={`লক্ষ্য মুছুন: ${task.title}`}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700 shrink-0"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 2: MISTAKE NOTEBOOK */}
      {tab === 'mistakes' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                ভুল নোটবুক (Mistake Notebook)
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                পরীক্ষায় ভুল করা বা কম নম্বর পাওয়া প্রশ্নগুলো স্বয়ংক্রিয়ভাবে এখানে জমা হয়।
              </p>
            </div>
            {activeMistakes.length > 0 && (
              <button
                type="button"
                onClick={() => void handleStartMistakeExam()}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>ভুল প্রশ্নগুলোর পুনঃঅনুশীলন পরীক্ষা দিন</span>
              </button>
            )}
          </div>

          {data.mistakes.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              বর্তমানে ভুল নোটবুকে কোনো প্রশ্ন নেই।
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
              {data.mistakes.map((m) => (
                <article key={m.id} className="p-5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">
                        {m.subject}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{m.chapter}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        পরবর্তী রিভিশন: {m.nextReviewDate || 'আজ'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          m.mastered
                            ? 'font-semibold text-emerald-700'
                            : 'font-semibold text-amber-700'
                        }
                      >
                        {m.mastered ? 'আয়ত্ত হয়েছে' : 'রিভিশন বাকি'}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => void toggleMistakeMastered(m.id)}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        m.mastered
                          ? 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                          : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                      }`}
                    >
                      {m.mastered ? 'আবার রিভিশনে রাখুন' : 'আয়ত্ত হয়েছে চিহ্নিত করুন'}
                    </button>
                  </div>

                  <h3 className="text-sm font-semibold text-slate-900">
                    {m.questionStem}
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
                    <p className="text-red-700">
                      <span className="font-semibold">আপনার ভুল উত্তর:</span>{' '}
                      {m.userAnswer}
                    </p>
                    <p className="text-emerald-800">
                      <span className="font-semibold">সঠিক উত্তর:</span>{' '}
                      {m.correctAnswer}
                    </p>
                  </div>
                  <p className="text-xs text-slate-600">{m.reason}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: SMART REVISION */}
      {tab === 'revision' && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 p-5">
            <div className="flex items-center gap-2">
              <BookMarked className="h-4 w-4 text-blue-700" />
              <h2 className="text-base font-semibold text-slate-900">
                Smart Revision ও সিলেবাস ট্র্যাকার
              </h2>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              পরীক্ষার দুর্বল অধ্যায়গুলো অগ্রাধিকার দিয়ে স্বয়ংক্রিয়ভাবে রিভিশন তালিকা সাজানো হয়েছে।
            </p>
          </div>

          <div className="divide-y divide-slate-200">
            {smartRevisionList.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {item.chapter}
                  </p>
                  <div className="mt-0.5 text-xs text-slate-500">
                    <span>{item.bookTitle}</span>
                    <span aria-hidden="true" className="mx-1.5">·</span>
                    <span>{item.subject}</span>
                    <span aria-hidden="true" className="mx-1.5">·</span>
                    <span className="font-mono tabular-nums">
                      পৃষ্ঠা {item.pageNumber}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className={`text-xs font-semibold ${
                      item.isWeak ? 'text-red-700' : 'text-slate-600'
                    }`}
                  >
                    {item.priority}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void addStudyTask({
                        title: `রিভিশন: ${item.chapter}`,
                        subject: item.subject,
                        chapter: item.chapter,
                        taskType: 'revision',
                        scheduledDate: '2026-11-21',
                        durationMinutes: 30,
                      });
                      setTab('routine');
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Calendar className="h-3.5 w-3.5" />
                    <span>রুটিনে নিন</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
