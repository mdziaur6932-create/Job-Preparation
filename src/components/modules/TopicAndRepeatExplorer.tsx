'use client';

import React, { useMemo, useState } from 'react';
import {
  Flame,
  Layers,
  Search,
  BookOpen,
  ArrowUpRight,
  Sparkles,
  RotateCcw,
} from 'lucide-react';
import type {
  BookIntelligenceReport,
  QuestionFormatType,
} from '@/src/lib/book-series-and-topic-analyzer';
import { KatexMathText } from './KatexMathText';

export type ReaderFormatFilter = 'all' | QuestionFormatType;

interface TopicAndRepeatExplorerProps {
  mode: 'topic' | 'repeated';
  report: BookIntelligenceReport;
  formatFilter: ReaderFormatFilter;
  selectedSubject: string;
  selectedTopic: string;
  onSelectSubject: (subject: string) => void;
  onSelectTopic: (topic: string) => void;
  onJumpToExam: (examId: string) => void;
  onReturnToFullExam?: () => void;
}

export function TopicAndRepeatExplorer({
  mode,
  report,
  formatFilter,
  selectedSubject,
  selectedTopic,
  onSelectSubject,
  onSelectTopic,
  onJumpToExam,
  onReturnToFullExam,
}: TopicAndRepeatExplorerProps) {
  const [query, setQuery] = useState('');

  // Topic buckets filtered by active MCQ / Written / ALL format AND selectedSubject
  const filteredTopicBuckets = useMemo(() => {
    return report.topicBuckets
      .filter(
        (bucket) =>
          selectedSubject === 'ALL' || bucket.subjectGroup === selectedSubject
      )
      .map((bucket) => {
        const items =
          formatFilter === 'all'
            ? bucket.items
            : bucket.items.filter((it) => it.format === formatFilter);
        return {
          ...bucket,
          filteredItems: items,
          filteredCount: items.length,
        };
      })
      .filter((b) => b.filteredCount > 0);
  }, [report.topicBuckets, formatFilter, selectedSubject]);

  const effectiveSelectedTopic = useMemo(() => {
    if (selectedTopic === 'ALL') return 'ALL';
    const exists = filteredTopicBuckets.some((b) => b.topic === selectedTopic);
    return exists ? selectedTopic : 'ALL';
  }, [selectedTopic, filteredTopicBuckets]);

  const visibleTopicItems = useMemo(() => {
    const base =
      effectiveSelectedTopic === 'ALL'
        ? filteredTopicBuckets.flatMap((b) => b.filteredItems)
        : filteredTopicBuckets.find((b) => b.topic === effectiveSelectedTopic)
            ?.filteredItems ?? [];

    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (it) =>
        it.questionText.toLowerCase().includes(q) ||
        it.institution.toLowerCase().includes(q) ||
        (it.postName?.toLowerCase().includes(q) ?? false) ||
        it.topic.toLowerCase().includes(q) ||
        it.subjectGroup.toLowerCase().includes(q) ||
        it.answerText.toLowerCase().includes(q) ||
        it.options.some((o) => o.text.toLowerCase().includes(q))
    );
  }, [filteredTopicBuckets, effectiveSelectedTopic, query]);

  const visibleRepeatedItems = useMemo(() => {
    return report.repeatedQuestions.filter((item) => {
      if (formatFilter !== 'all' && item.format !== formatFilter) return false;
      if (selectedSubject !== 'ALL' && item.subjectGroup !== selectedSubject) {
        return false;
      }
      if (effectiveSelectedTopic !== 'ALL' && item.topic !== effectiveSelectedTopic) {
        return false;
      }
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        item.canonicalQuestion.toLowerCase().includes(q) ||
        item.topic.toLowerCase().includes(q) ||
        item.subjectGroup.toLowerCase().includes(q) ||
        item.answerText.toLowerCase().includes(q) ||
        item.occurrences.some(
          (o) =>
            o.institution.toLowerCase().includes(q) ||
            (o.postName?.toLowerCase().includes(q) ?? false)
        )
      );
    });
  }, [
    report.repeatedQuestions,
    formatFilter,
    selectedSubject,
    effectiveSelectedTopic,
    query,
  ]);

  const veryHighCount = useMemo(
    () =>
      visibleRepeatedItems.filter((r) => r.priorityTier === 'very_high').length,
    [visibleRepeatedItems]
  );

  if (mode === 'topic') {
    const activeScopeTitle =
      effectiveSelectedTopic !== 'ALL'
        ? `${selectedSubject !== 'ALL' ? `${selectedSubject} · ` : ''}${effectiveSelectedTopic}`
        : selectedSubject !== 'ALL'
          ? `বিষয়: ${selectedSubject}`
          : 'টপিকভিত্তিক প্রশ্ন সংগ্রহ';

    return (
      <div data-testid="topic-wise-explorer" className="p-6 space-y-5">
        {/* Top Summary Strip */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Layers className="h-4 w-4 text-blue-700 shrink-0" />
              <h2 className="text-base font-bold text-slate-900">
                {activeScopeTitle}
              </h2>
              <span className="font-mono text-xs tabular-nums text-slate-500">
                ({visibleTopicItems.length}টি প্রশ্ন)
              </span>
            </div>
            <p className="text-xs text-slate-500">
              {report.seriesTitle}
              {' · '}
              {report.isMultiPart
                ? `${report.partCount}টি পার্ট · ${report.totalExams}টি পরীক্ষা থেকে পরীক্ষার নাম, পদ ও তারিখসহ`
                : `${report.totalExams}টি পরীক্ষা থেকে পরীক্ষার নাম, পদ ও তারিখসহ`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                data-testid="topic-explorer-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="প্রশ্ন, টপিক বা পরীক্ষা খুঁজুন..."
                className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>
            {onReturnToFullExam && (
              <button
                type="button"
                onClick={onReturnToFullExam}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3 w-3" />
                <span>পূর্ণ পরীক্ষায় ফিরুন</span>
              </button>
            )}
          </div>
        </div>

        {/* Interactive Topic Filter Buttons (Scoped to active Subject) */}
        {filteredTopicBuckets.length > 0 && (
          <div
            role="group"
            aria-label="টপিক নির্বাচন"
            data-testid="topic-filter-list"
            className="flex flex-wrap gap-1.5"
          >
            <button
              type="button"
              onClick={() => onSelectTopic('ALL')}
              className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                effectiveSelectedTopic === 'ALL'
                  ? 'border-blue-700 bg-blue-700 text-white'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {selectedSubject !== 'ALL'
                ? `${selectedSubject}-এর সব টপিক`
                : 'সব টপিক'}{' '}
              <span className="font-mono tabular-nums opacity-85">
                ({filteredTopicBuckets.reduce((s, b) => s + b.filteredCount, 0)})
              </span>
            </button>
            {filteredTopicBuckets.map((bucket) => (
              <button
                key={bucket.topic}
                type="button"
                data-testid={`topic-btn-${bucket.topic}`}
                onClick={() => onSelectTopic(bucket.topic)}
                className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  effectiveSelectedTopic === bucket.topic
                    ? 'border-blue-700 bg-blue-700 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {bucket.topic}{' '}
                <span className="font-mono tabular-nums opacity-80">
                  ({bucket.filteredCount})
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Topic Question Cards */}
        {visibleTopicItems.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center space-y-3 text-xs text-slate-500">
            <p>
              এই ফিল্টারে কোনো প্রশ্ন পাওয়া যায়নি। অন্য বিষয়, টপিক বা MCQ/Written ফিল্টার পরিবর্তন করে দেখুন।
            </p>
            {(selectedSubject !== 'ALL' || selectedTopic !== 'ALL') && (
              <button
                type="button"
                onClick={() => {
                  onSelectSubject('ALL');
                  onSelectTopic('ALL');
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                সব বিষয় ও টপিক দেখান
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {visibleTopicItems.map((item) => (
              <article
                key={item.id}
                data-testid="topic-question-card"
                className="p-4 space-y-2.5"
              >
                {/* Clean Zero-Pill Exam Attribution Header */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600">
                    <span className="font-bold text-slate-900">
                      {item.institution}
                    </span>
                    {item.postName && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="font-medium text-slate-700">
                          পদের নাম: {item.postName}
                        </span>
                      </>
                    )}
                    {item.examDate && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="font-mono tabular-nums text-slate-500">
                          {item.examDate}
                        </span>
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span
                      className={`font-semibold ${
                        item.format === 'MCQ'
                          ? 'text-indigo-700'
                          : 'text-emerald-700'
                      }`}
                    >
                      {item.format === 'MCQ' ? 'MCQ' : 'Written'}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-medium text-slate-700">
                      {item.subjectGroup} / {item.topic}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-slate-500">
                      {item.pageLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => onJumpToExam(item.examId)}
                      className="ml-1 inline-flex items-center gap-0.5 text-[11px] font-semibold text-blue-700 hover:underline whitespace-nowrap shrink-0"
                    >
                      <span>পূর্ণ পরীক্ষা</span>
                      <ArrowUpRight className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Question Stem */}
                <div className="flex items-baseline gap-2 text-slate-900">
                  <span className="font-mono tabular-nums font-bold text-slate-800 shrink-0 text-sm">
                    {item.numberLabel}
                  </span>
                  <span className="font-semibold">
                    <KatexMathText text={item.questionText} examTypography />
                  </span>
                </div>

                {/* Options / Sub-Items */}
                {item.options.length > 0 && (
                  <div className="pl-6 space-y-1 text-slate-800">
                    {item.options.map((opt, idx) => (
                      <div key={idx} className="flex items-baseline gap-2">
                        <span className="font-medium text-slate-600 shrink-0 min-w-[1.4rem] text-sm">
                          {opt.marker}
                        </span>
                        <span>
                          <KatexMathText text={opt.text} examTypography />
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Bold Answer Below Question/Options */}
                {item.answerText && (
                  <div className="pl-6 pt-1 flex flex-wrap items-baseline gap-2">
                    <span className="inline-flex items-center rounded bg-blue-700 px-2 py-0.5 text-xs font-bold text-white">
                      {item.answerLabel.endsWith(':')
                        ? item.answerLabel
                        : `${item.answerLabel}:`}
                    </span>
                    <span
                      data-testid="topic-answer-bold"
                      className="font-bold text-slate-900"
                    >
                      <KatexMathText text={item.answerText} examTypography />
                    </span>
                    {item.isAiGenerated && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800">
                        <Sparkles className="h-3 w-3" />
                        <span>AI দ্বারা তৈরি উত্তর</span>
                      </span>
                    )}
                  </div>
                )}

                {/* MCQ Explanation (ব্যাখ্যা) */}
                {item.explanation && (
                  <div
                    data-testid="topic-explanation-block"
                    className="pl-6 pt-1"
                  >
                    <div className="rounded-r border-l-2 border-rose-800 bg-rose-50/60 px-2.5 py-1.5 text-slate-800">
                      <span className="mr-1.5 inline-flex items-center rounded bg-rose-900 px-1.5 py-0.5 text-xs font-bold text-white">
                        ব্যাখ্যা:
                      </span>
                      <KatexMathText text={item.explanation} examTypography />
                    </div>
                  </div>
                )}

                {/* Math / Descriptive Solution Steps */}
                {item.solutionSteps.length > 0 && (
                  <div className="pl-6 space-y-1 text-slate-700">
                    {item.solutionSteps.map((step, idx) => (
                      <div key={idx}>
                        <KatexMathText text={step} examTypography />
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Repeated Questions & Priority Analysis View
  return (
    <div data-testid="repeated-questions-explorer" className="p-6 space-y-5">
      {/* Header & Priority Summary */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Flame className="h-4 w-4 text-rose-600 shrink-0" />
            <h2 className="text-base font-bold text-slate-900">
              বারবার আসা প্রশ্ন ও গুরুত্ব বিশ্লেষণ ({report.seriesTitle})
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            মোট রিপিট প্রশ্ন:{' '}
            <span className="font-mono tabular-nums font-semibold text-slate-900">
              {visibleRepeatedItems.length}টি
            </span>
            {veryHighCount > 0 && (
              <>
                {' · '}
                অতি গুরুত্বপূর্ণ (৩+ বার):{' '}
                <span className="font-mono tabular-nums font-semibold text-rose-700">
                  {veryHighCount}টি
                </span>
              </>
            )}
            {selectedSubject !== 'ALL' && ` · বিষয়: ${selectedSubject}`}
            {effectiveSelectedTopic !== 'ALL' &&
              ` · টপিক: ${effectiveSelectedTopic}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-52">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="রিপিট প্রশ্ন খুঁজুন..."
              className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>
          {onReturnToFullExam && (
            <button
              type="button"
              onClick={onReturnToFullExam}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3 w-3" />
              <span>পূর্ণ পরীক্ষায় ফিরুন</span>
            </button>
          )}
        </div>
      </div>

      {/* Topic Sub-filter */}
      {filteredTopicBuckets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSelectTopic('ALL')}
            className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              effectiveSelectedTopic === 'ALL'
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            সব টপিক
          </button>
          {filteredTopicBuckets.map((bucket) => (
            <button
              key={bucket.topic}
              type="button"
              onClick={() => onSelectTopic(bucket.topic)}
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                effectiveSelectedTopic === bucket.topic
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {bucket.topic}
            </button>
          ))}
        </div>
      )}

      {/* Repeated Question Cards */}
      {visibleRepeatedItems.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center space-y-2">
          <BookOpen className="mx-auto h-6 w-6 text-slate-400" />
          <p className="text-sm font-semibold text-slate-800">
            এই ফিল্টারে এখনও একাধিকবার রিপিট হওয়া প্রশ্ন পাওয়া যায়নি
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            একই বইয়ের আরও পার্ট যুক্ত করলে বা সব পার্ট একসাথে বিশ্লেষণ করলে যে প্রশ্নগুলো একাধিক পরীক্ষায় এসেছে তা স্বয়ংক্রিয়ভাবে এখানে গুরুত্ব অনুযায়ী দেখাবে।
          </p>
        </div>
      ) : (
        <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {visibleRepeatedItems.map((group) => (
            <article
              key={group.id}
              data-testid="repeated-question-card"
              className="p-4 space-y-3"
            >
              {/* Priority & Frequency Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                  <span
                    data-testid="repeat-count-badge"
                    className={`inline-flex items-center gap-1 font-bold ${
                      group.priorityTier === 'very_high'
                        ? 'text-rose-700'
                        : 'text-amber-700'
                    }`}
                  >
                    <Flame className="h-3.5 w-3.5" />
                    <span className="font-mono tabular-nums">
                      {group.repeatCount} বার রিপিট
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span
                    data-testid="repeat-priority-badge"
                    className={`font-bold ${
                      group.priorityTier === 'very_high'
                        ? 'text-rose-800'
                        : 'text-amber-800'
                    }`}
                  >
                    {group.priorityLabel}
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-mono tabular-nums text-slate-600">
                    গুরুত্ব {group.importanceScore}%
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <span
                    className={`font-semibold ${
                      group.format === 'MCQ'
                        ? 'text-indigo-700'
                        : 'text-emerald-700'
                    }`}
                  >
                    {group.format === 'MCQ' ? 'MCQ' : 'Written'}
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="font-medium text-slate-700">
                    {group.subjectGroup} / {group.topic}
                  </span>
                </div>
              </div>

              {/* Canonical Question */}
              <div className="font-semibold text-slate-900">
                <KatexMathText text={group.canonicalQuestion} examTypography />
              </div>

              {/* Options (if MCQ) */}
              {group.options.length > 0 && (
                <div className="pl-4 space-y-1 text-slate-800">
                  {group.options.map((opt, idx) => (
                    <div key={idx} className="flex items-baseline gap-2">
                      <span className="font-medium text-slate-600 shrink-0 min-w-[1.4rem] text-sm">
                        {opt.marker}
                      </span>
                      <span>
                        <KatexMathText text={opt.text} examTypography />
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Bold Answer Below */}
              {group.answerText && (
                <div className="flex flex-wrap items-baseline gap-2 pt-0.5">
                  <span className="inline-flex items-center rounded bg-blue-700 px-2 py-0.5 text-xs font-bold text-white">
                    {group.answerLabel.endsWith(':')
                      ? group.answerLabel
                      : `${group.answerLabel}:`}
                  </span>
                  <span
                    data-testid="repeat-answer-bold"
                    className="font-bold text-slate-900"
                  >
                    <KatexMathText text={group.answerText} examTypography />
                  </span>
                </div>
              )}

              {/* Exam Occurrence History */}
              <div className="border-t border-slate-100 pt-2.5 space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-600">
                  যে যে পরীক্ষায় ও পদে এসেছে ({group.occurrences.length}টি):
                </div>
                <ul className="space-y-1">
                  {group.occurrences.map((occ, idx) => (
                    <li
                      key={`${occ.examId}-${occ.numberLabel}-${idx}`}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-semibold text-slate-900">
                          {occ.institution}
                        </span>
                        {occ.postName && (
                          <span className="text-slate-600">
                            · পদ: {occ.postName}
                          </span>
                        )}
                        {occ.examDate && (
                          <span className="font-mono tabular-nums text-slate-500">
                            · {occ.examDate}
                          </span>
                        )}
                        <span className="font-mono tabular-nums text-[11px] text-slate-500">
                          ({occ.pageLabel} · প্রশ্ন {occ.numberLabel})
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => onJumpToExam(occ.examId)}
                        className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-blue-700 hover:underline whitespace-nowrap shrink-0"
                      >
                        <span>পরীক্ষা খুলুন</span>
                        <ArrowUpRight className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
