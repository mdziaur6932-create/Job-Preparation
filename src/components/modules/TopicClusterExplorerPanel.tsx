'use client';

import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Filter,
  Loader2,
  Search,
  Sparkles,
  Tag,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { formatAiResponseError } from '@/src/lib/ai-client';
import { toBengaliNumber } from '@/src/lib/file-validation';
import {
  SYLLABUS_SUBJECT_GROUPS,
  buildCrossBookTopicClusters,
  loadAiTopicTagOverrides,
  saveAiTopicTagOverrides,
  type AiTopicTagOverride,
  type SyllabusSubjectGroup,
} from '@/src/lib/syllabus-topic-tagger';
import { KatexMathText } from './KatexMathText';

interface TopicClusterExplorerPanelProps {
  onPracticeTopic?: (topicLabel: string) => void;
}

export function TopicClusterExplorerPanel({
  onPracticeTopic,
}: TopicClusterExplorerPanelProps) {
  const { data, getAiAuthHeaders, requestAiSignIn } = useWorkspace();

  const [aiOverrides, setAiOverrides] = useState<
    Record<string, AiTopicTagOverride>
  >(() => loadAiTopicTagOverrides());
  const [subjectFilter, setSubjectFilter] = useState<
    'সব' | SyllabusSubjectGroup
  >('সব');
  const [bookFilter, setBookFilter] = useState<string>('all');
  const [formatFilter, setFormatFilter] = useState<'সব' | 'MCQ' | 'Written'>(
    'সব'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTopicLabel, setSelectedTopicLabel] = useState<string>('all');

  const [tagging, setTagging] = useState(false);
  const [tagNotice, setTagNotice] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);

  const { entries, clusters } = useMemo(
    () =>
      buildCrossBookTopicClusters({
        books: data.books,
        questions: data.questions,
        aiTagOverrides: aiOverrides,
      }),
    [data.books, data.questions, aiOverrides]
  );

  const visibleClusters = useMemo(() => {
    return clusters.filter((c) => {
      if (subjectFilter !== 'সব' && c.subjectGroup !== subjectFilter) {
        return false;
      }
      if (bookFilter !== 'all') {
        const hasBook = c.items.some(
          (item) =>
            (bookFilter === 'bank' && item.sourceKind === 'bank') ||
            String(item.bookId) === bookFilter
        );
        if (!hasBook) return false;
      }
      return true;
    });
  }, [clusters, subjectFilter, bookFilter]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((item) => {
      if (subjectFilter !== 'সব' && item.subjectGroup !== subjectFilter) {
        return false;
      }
      if (
        selectedTopicLabel !== 'all' &&
        item.topicLabel !== selectedTopicLabel
      ) {
        return false;
      }
      if (bookFilter !== 'all') {
        if (bookFilter === 'bank') {
          if (item.sourceKind !== 'bank') return false;
        } else if (String(item.bookId) !== bookFilter) {
          return false;
        }
      }
      if (formatFilter === 'MCQ' && item.format !== 'MCQ') return false;
      if (formatFilter === 'Written' && item.format === 'MCQ') return false;
      if (!q) return true;
      return (
        item.stem.toLowerCase().includes(q) ||
        item.topicLabel.toLowerCase().includes(q) ||
        item.bookTitle.toLowerCase().includes(q) ||
        item.examTitle.toLowerCase().includes(q)
      );
    });
  }, [
    entries,
    subjectFilter,
    selectedTopicLabel,
    bookFilter,
    formatFilter,
    searchQuery,
  ]);

  const aiTaggedCount = useMemo(
    () => entries.filter((e) => e.taggedBy === 'ai').length,
    [entries]
  );

  const handleRunAiAutoTagging = async () => {
    if (tagging) return;
    setTagError(null);
    setTagNotice(null);

    if (entries.length === 0) {
      setTagError(
        'ট্যাগিং করার মতো কোনো প্রশ্ন পাওয়া যায়নি। আগে বই ইমপোর্ট করুন বা প্রশ্ন তৈরি করুন।'
      );
      return;
    }

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('AI অটোমেটেড সিলেবাস টপিক ট্যাগিং ও ক্লাস্টারিং');
      return;
    }

    // Prioritize untagged or fallback-classified entries first, up to 40 per batch
    const prioritized = [
      ...entries.filter(
        (e) => e.taggedBy !== 'ai' && e.topicId === 'general-mixed'
      ),
      ...entries.filter(
        (e) => e.taggedBy !== 'ai' && e.topicId !== 'general-mixed'
      ),
      ...entries.filter((e) => e.taggedBy === 'ai'),
    ].slice(0, 40);

    setTagging(true);
    try {
      const res = await fetch('/api/ai/topic-tag', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          items: prioritized.map((e) => ({
            uid: e.uid,
            text: e.stem,
            bookTitle: e.bookTitle,
            currentTopic: e.topicLabel,
          })),
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          requestAiSignIn('AI অটোমেটেড সিলেবাস টপিক ট্যাগিং ও ক্লাস্টারিং');
        }
        throw new Error(
          formatAiResponseError(
            res.status,
            json,
            'AI টপিক ট্যাগিং সম্পন্ন করা যায়নি।'
          )
        );
      }

      const tags = Array.isArray(json.tags) ? json.tags : [];
      if (tags.length > 0) {
        setAiOverrides((prev) => {
          const next = { ...prev };
          for (const t of tags) {
            if (t && typeof t.uid === 'string' && typeof t.topicLabel === 'string') {
              next[t.uid] = {
                topicLabel: t.topicLabel,
                subjectGroup: t.subjectGroup,
                confidence: Number(t.confidence || 90),
              };
            }
          }
          saveAiTopicTagOverrides(next);
          return next;
        });
        setTagNotice(
          `AI সফলভাবে ${toBengaliNumber(tags.length)}টি প্রশ্ন বিশ্লেষণ করে একাডেমিক সিলেবাস টপিকে (যেমন: সন্ধি বিচ্ছেদ, Right Form of Verbs, Math Geometry) ক্লাস্টার করেছে।`
        );
      }
    } catch (err) {
      setTagError(
        err instanceof Error ? err.message : 'AI টপিক ট্যাগিংয়ে সমস্যা হয়েছে।'
      );
    } finally {
      setTagging(false);
    }
  };

  return (
    <div data-testid="topic-cluster-explorer" className="space-y-5">
      {/* Header Action Strip */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Tag className="h-4 w-4 text-blue-700" />
              <h2 className="text-base font-semibold text-slate-900">
                অটোমেটেড AI সিলেবাস টপিক ট্যাগিং ও ক্রস-বুক ক্লাস্টারিং
              </h2>
            </div>
            <p className="mt-1 text-xs text-slate-500 leading-relaxed">
              আপনার ইমপোর্ট করা সকল বই ও প্রশ্নব্যাংকের প্রশ্নগুলো স্বয়ংক্রিয়ভাবে{' '}
              <strong className="font-semibold text-slate-700">
                সন্ধি বিচ্ছেদ (Sandhi Bicched)
              </strong>
              ,{' '}
              <strong className="font-semibold text-slate-700">
                Right Form of Verbs
              </strong>
              ,{' '}
              <strong className="font-semibold text-slate-700">
                Math Geometry (জ্যামিতি)
              </strong>{' '}
              ইত্যাদি একাডেমিক সিলেবাস ক্যাটাগরিতে ভাগ করা হয়েছে।
            </p>
          </div>

          <button
            type="button"
            data-testid="run-ai-topic-tagger-btn"
            disabled={tagging || entries.length === 0}
            onClick={() => void handleRunAiAutoTagging()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {tagging ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>AI ক্লাস্টারিং চলছে...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                <span>AI অটো-ট্যাগ ও ক্লাস্টার করুন</span>
              </>
            )}
          </button>
        </div>

        {/* Summary Metric Strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 border-t border-slate-100 pt-4 text-xs">
          <div>
            <span className="text-slate-500">মোট বিশ্লেষিত প্রশ্ন</span>
            <p className="mt-0.5 font-mono text-lg font-bold text-slate-900 tabular-nums">
              {toBengaliNumber(entries.length)}
            </p>
          </div>
          <div>
            <span className="text-slate-500">সিলেবাস টপিক ক্লাস্টার</span>
            <p className="mt-0.5 font-mono text-lg font-bold text-blue-700 tabular-nums">
              {toBengaliNumber(clusters.length)}
            </p>
          </div>
          <div>
            <span className="text-slate-500">সংযুক্ত উৎস বই</span>
            <p className="mt-0.5 font-mono text-lg font-bold text-slate-900 tabular-nums">
              {toBengaliNumber(data.books.length)}
            </p>
          </div>
          <div>
            <span className="text-slate-500">AI যাচাইকৃত ট্যাগ</span>
            <p className="mt-0.5 font-mono text-lg font-bold text-emerald-700 tabular-nums">
              {toBengaliNumber(aiTaggedCount)}
            </p>
          </div>
        </div>

        {tagNotice && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-medium text-emerald-900"
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
            <span>{tagNotice}</span>
          </div>
        )}
        {tagError && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800"
          >
            {tagError}
          </p>
        )}

        {/* Filter Controls */}
        <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(['সব', ...SYLLABUS_SUBJECT_GROUPS] as const).map((grp) => (
              <button
                key={grp}
                type="button"
                onClick={() => {
                  setSubjectFilter(grp);
                  setSelectedTopicLabel('all');
                }}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                  subjectFilter === grp
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {grp}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="উৎস বই ফিল্টার"
              value={bookFilter}
              onChange={(e) => setBookFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
            >
              <option value="all">
                সকল বই ও প্রশ্নব্যাংক ({toBengaliNumber(data.books.length)} বই)
              </option>
              <option value="bank">শুধু সংরক্ষিত প্রশ্নব্যাংক</option>
              {data.books.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.title}
                </option>
              ))}
            </select>

            <select
              aria-label="প্রশ্নের ফরম্যাট ফিল্টার"
              value={formatFilter}
              onChange={(e) =>
                setFormatFilter(e.target.value as 'সব' | 'MCQ' | 'Written')
              }
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
            >
              <option value="সব">MCQ ও Written</option>
              <option value="MCQ">শুধু MCQ</option>
              <option value="Written">শুধু Written / Short</option>
            </select>

            <div className="relative w-full sm:w-52">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                aria-label="টপিক বা প্রশ্ন খুঁজুন"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="সন্ধি, Verb, Geometry..."
                className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-2.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Main Split: Topic Cluster Directory + Filtered Cross-Book Question Feed */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
        {/* Left: Syllabus Topic Directory */}
        <aside
          aria-label="সিলেবাস টপিক তালিকা"
          className="lg:col-span-4 rounded-xl border border-slate-200 bg-white overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 bg-slate-50/80">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <Filter className="h-3.5 w-3.5 text-blue-700" />
              <span>সিলেবাস টপিকসমূহ</span>
            </span>
            <span className="font-mono text-[11px] text-slate-500 tabular-nums">
              {toBengaliNumber(visibleClusters.length)}টি টপিক
            </span>
          </div>

          <div className="max-h-[540px] overflow-y-auto divide-y divide-slate-100">
            <button
              type="button"
              data-testid="topic-cluster-all"
              onClick={() => setSelectedTopicLabel('all')}
              className={`w-full flex items-center justify-between px-4 py-3 text-left text-xs transition-colors ${
                selectedTopicLabel === 'all'
                  ? 'bg-blue-50 font-semibold text-blue-900'
                  : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span>সব সিলেবাস টপিক একসাথে</span>
              <span className="font-mono tabular-nums text-slate-500">
                {toBengaliNumber(entries.length)}
              </span>
            </button>

            {visibleClusters.map((cluster) => {
              const active = selectedTopicLabel === cluster.topicLabel;
              return (
                <button
                  key={cluster.topicLabel}
                  type="button"
                  data-testid={`topic-cluster-item-${cluster.topicId}`}
                  onClick={() => setSelectedTopicLabel(cluster.topicLabel)}
                  className={`w-full px-4 py-3 text-left transition-colors ${
                    active
                      ? 'bg-blue-50 text-blue-900'
                      : 'text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold leading-snug">
                      {cluster.topicLabel}
                    </span>
                    <span className="font-mono text-xs font-bold tabular-nums text-blue-700 shrink-0">
                      {toBengaliNumber(cluster.totalCount)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                    <span>{cluster.subjectGroup}</span>
                    <span aria-hidden="true">·</span>
                    <span>MCQ {toBengaliNumber(cluster.mcqCount)}</span>
                    <span aria-hidden="true">·</span>
                    <span>Written {toBengaliNumber(cluster.writtenCount)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{toBengaliNumber(cluster.bookTitles.length)} বই</span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right: Matching Questions Across All Imported Books */}
        <section
          aria-label="টপিকভিত্তিক প্রশ্নসমূহ"
          className="lg:col-span-8 rounded-xl border border-slate-200 bg-white overflow-hidden"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 bg-slate-50/70">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                {selectedTopicLabel === 'all'
                  ? 'সকল সিলেবাস টপিকের প্রশ্নসমূহ'
                  : selectedTopicLabel}
              </h3>
              <p className="text-[11px] text-slate-500">
                মোট {toBengaliNumber(filteredEntries.length)}টি প্রশ্ন প্রদর্শিত হচ্ছে
              </p>
            </div>
            {selectedTopicLabel !== 'all' && onPracticeTopic && (
              <button
                type="button"
                onClick={() => onPracticeTopic(selectedTopicLabel)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>এই টপিক দিয়ে AI প্রশ্ন তৈরি করুন</span>
              </button>
            )}
          </div>

          {filteredEntries.length === 0 ? (
            <div className="p-12 text-center">
              <BookOpen className="mx-auto h-7 w-7 text-slate-400" />
              <p className="mt-2 text-sm text-slate-500">
                নির্বাচিত সিলেবাস টপিক বা ফিল্টারে কোনো প্রশ্ন পাওয়া যায়নি।
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200 max-h-[600px] overflow-y-auto">
              {filteredEntries.slice(0, 80).map((item, idx) => (
                <article key={item.uid} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                    <span className="font-semibold text-blue-700">
                      {item.topicLabel}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-semibold text-slate-800">
                      {item.format}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{item.bookTitle}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      পৃষ্ঠা {toBengaliNumber(item.pageNumber)}
                    </span>
                    {item.taggedBy === 'ai' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-emerald-700">
                          AI যাচাইকৃত
                        </span>
                      </>
                    )}
                  </div>

                  <p className="text-sm font-semibold text-slate-900 leading-relaxed">
                    <span className="font-mono text-slate-400 mr-1.5">
                      {toBengaliNumber(idx + 1)}.
                    </span>
                    <KatexMathText text={item.stem} />
                  </p>

                  {item.options.length > 0 && (
                    <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 text-xs text-slate-700 pl-4">
                      {item.options.map((opt, oIdx) => (
                        <li key={oIdx} className="rounded border border-slate-200 bg-slate-50/70 px-2.5 py-1">
                          {['ক', 'খ', 'গ', 'ঘ'][oIdx] ?? String.fromCharCode(65 + oIdx)}){' '}
                          <KatexMathText text={opt} />
                        </li>
                      ))}
                    </ul>
                  )}

                  {item.answerText && (
                    <p className="pl-4 text-xs font-bold text-slate-900 leading-relaxed">
                      <span className="text-emerald-800 mr-1">উত্তর:</span>
                      <KatexMathText text={item.answerText} />
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
