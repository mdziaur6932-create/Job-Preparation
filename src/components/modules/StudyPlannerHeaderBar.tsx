'use client';

import React, { useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  Check,
  Clock,
  Flame,
  Pencil,
  Target,
  X,
} from 'lucide-react';
import { toBengaliNumber } from '@/src/lib/file-validation';
import type {
  ExamCountdownStrategy,
  ExamTargetConfig,
  StudyStreakMetrics,
} from '@/src/lib/smart-study-planner';

interface StudyPlannerHeaderBarProps {
  targetConfig: ExamTargetConfig;
  onUpdateTargetConfig: (next: ExamTargetConfig) => void;
  strategy: ExamCountdownStrategy;
  streakMetrics: StudyStreakMetrics;
  activeMistakesCount: number;
  dueRevisionsCount: number;
  totalBooksCount: number;
  onOpenMistakesTab: () => void;
  onOpenRevisionTab: () => void;
}

export function StudyPlannerHeaderBar({
  targetConfig,
  onUpdateTargetConfig,
  strategy,
  streakMetrics,
  activeMistakesCount,
  dueRevisionsCount,
  totalBooksCount,
  onOpenMistakesTab,
  onOpenRevisionTab,
}: StudyPlannerHeaderBarProps) {
  const [editingGoal, setEditingGoal] = useState(false);
  const [draftName, setDraftName] = useState(targetConfig.examName);
  const [draftDate, setDraftDate] = useState(targetConfig.targetDate);
  const [draftHours, setDraftHours] = useState(targetConfig.dailyHours);

  const todayPct =
    streakMetrics.todayTargetMinutes > 0
      ? Math.min(
          100,
          Math.round(
            (streakMetrics.todayCompletedMinutes /
              streakMetrics.todayTargetMinutes) *
              100
          )
        )
      : 0;

  const strategyAccent =
    strategy.mode === 'rapid_fire'
      ? 'border-red-200 bg-red-50/70 text-red-900'
      : strategy.mode === 'revision_mock'
        ? 'border-amber-200 bg-amber-50/70 text-amber-900'
        : 'border-blue-200 bg-blue-50/60 text-blue-950';

  const handleOpenEdit = () => {
    setDraftName(targetConfig.examName);
    setDraftDate(targetConfig.targetDate);
    setDraftHours(targetConfig.dailyHours);
    setEditingGoal(true);
  };

  const handleSaveGoal = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateTargetConfig({
      ...targetConfig,
      examName: draftName.trim() || 'সরকারি চাকরির প্রস্তুতি পরীক্ষা',
      targetDate: draftDate.trim(),
      dailyHours: Math.max(0.5, Math.min(12, Number(draftHours) || 2)),
    });
    setEditingGoal(false);
  };

  return (
    <section
      aria-label="টার্গেট পরীক্ষা ও দৈনিক অগ্রগতি"
      className="space-y-4"
    >
      {/* Target Exam Countdown + Strategy Banner */}
      <div
        data-testid="target-exam-banner"
        className={`rounded-xl border p-4 sm:p-5 ${strategyAccent}`}
      >
        {!editingGoal ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Target className="h-4 w-4 shrink-0" />
                <h2 className="text-sm font-bold truncate">
                  {targetConfig.examName || 'আসন্ন চাকরির পরীক্ষা (টার্গেট সেট করুন)'}
                </h2>
                <span
                  data-testid="countdown-strategy-badge"
                  className="rounded-md border border-current/20 bg-white/80 px-2 py-0.5 text-[11px] font-semibold"
                >
                  {strategy.badgeText.replace(/\d+/g, (m) =>
                    toBengaliNumber(Number(m))
                  )}
                </span>
              </div>
              <p className="text-xs opacity-90 leading-relaxed">
                {strategy.guidance}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11px] font-medium opacity-85">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  দৈনিক লক্ষ্য: {toBengaliNumber(targetConfig.dailyHours)} ঘণ্টা
                </span>
                <span aria-hidden="true">·</span>
                <span
                  data-testid="planner-active-books-badge"
                  className="inline-flex items-center gap-1"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  লাইব্রেরির {toBengaliNumber(totalBooksCount)}টি বই সংযুক্ত (নতুন বই যোগ হলে স্বয়ংক্রিয়ভাবে যুক্ত হবে)
                </span>
              </div>
            </div>

            <button
              type="button"
              data-testid="edit-target-exam-btn"
              onClick={handleOpenEdit}
              className="inline-flex items-center gap-1.5 self-start sm:self-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 shrink-0"
            >
              <Pencil className="h-3.5 w-3.5" />
              <span>টার্গেট সেট / পরিবর্তন</span>
            </button>
          </div>
        ) : (
          <form onSubmit={handleSaveGoal} className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900">
                টার্গেট পরীক্ষা ও দৈনিক পড়ার সময় নির্ধারণ করুন
              </span>
              <button
                type="button"
                aria-label="বাতিল করুন"
                onClick={() => setEditingGoal(false)}
                className="rounded p-1 text-slate-500 hover:bg-white/70"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="target-exam-name-input"
                  className="block text-[11px] font-semibold text-slate-700"
                >
                  টার্গেট পরীক্ষার নাম
                </label>
                <input
                  id="target-exam-name-input"
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="যেমন: ৪৭তম বিসিএস প্রিলি / ব্যাংক নিয়োগ"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="target-exam-date-input"
                  className="block text-[11px] font-semibold text-slate-700"
                >
                  পরীক্ষার তারিখ
                </label>
                <input
                  id="target-exam-date-input"
                  type="date"
                  value={draftDate}
                  onChange={(e) => setDraftDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="target-daily-hours-input"
                  className="block text-[11px] font-semibold text-slate-700"
                >
                  প্রতিদিন পড়ার সময় (ঘণ্টা)
                </label>
                <input
                  id="target-daily-hours-input"
                  type="number"
                  step={0.5}
                  min={0.5}
                  max={12}
                  value={draftHours}
                  onChange={(e) => setDraftHours(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingGoal(false)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                বাতিল
              </button>
              <button
                type="submit"
                data-testid="save-target-exam-btn"
                className="inline-flex items-center gap-1 rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
              >
                <Check className="h-3.5 w-3.5" />
                <span>সংরক্ষণ করুন</span>
              </button>
            </div>
          </form>
        )}
      </div>

      {/* 4 Compact Summary KPI Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>আজকের পড়া</span>
            <Clock className="h-3.5 w-3.5 text-blue-700" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="font-mono text-xl font-bold tabular-nums text-slate-900">
              {toBengaliNumber(streakMetrics.todayCompletedMinutes)}
            </span>
            <span className="text-xs text-slate-500">
              / {toBengaliNumber(streakMetrics.todayTargetMinutes)} মি.
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-blue-700 transition-all duration-200"
              style={{ width: `${todayPct}%` }}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>টানা পড়ার ধারা (Streak)</span>
            <Flame className="h-3.5 w-3.5 text-amber-600" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-1">
            <span className="font-mono text-xl font-bold tabular-nums text-slate-900">
              {toBengaliNumber(streakMetrics.streakDays)}
            </span>
            <span className="text-xs text-slate-500">দিন টানা</span>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            আজ সম্পন্ন: {toBengaliNumber(streakMetrics.todayCompletedTasks)}/
            {toBengaliNumber(streakMetrics.todayTotalTasks)} কাজ
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenMistakesTab}
          className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-red-300 hover:bg-red-50/30 transition-colors"
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>বাকি ভুল প্রশ্ন</span>
            <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-1">
            <span className="font-mono text-xl font-bold tabular-nums text-slate-900">
              {toBengaliNumber(activeMistakesCount)}
            </span>
            <span className="text-xs text-slate-500">টি রিভিশন বাকি</span>
          </div>
          <p className="mt-1.5 text-[11px] font-medium text-red-700">
            ভুল নোটবুকে অনুশীলন করুন →
          </p>
        </button>

        <button
          type="button"
          onClick={onOpenRevisionTab}
          className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-blue-300 hover:bg-blue-50/30 transition-colors"
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>আজকের স্মার্ট রিভিশন</span>
            <CalendarClock className="h-3.5 w-3.5 text-indigo-700" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-1">
            <span className="font-mono text-xl font-bold tabular-nums text-slate-900">
              {toBengaliNumber(dueRevisionsCount)}
            </span>
            <span className="text-xs text-slate-500">টি অধ্যায় জরুরি</span>
          </div>
          <p className="mt-1.5 text-[11px] font-medium text-indigo-700">
            স্মৃতিশক্তি ও অগ্রাধিকার দেখুন →
          </p>
        </button>
      </div>
    </section>
  );
}
