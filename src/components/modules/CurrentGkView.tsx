'use client';

import React, { useMemo, useState } from 'react';
import {
  Plus,
  Archive,
  Sparkles,
  Loader2,
  CheckCircle2,
  Globe,
  Newspaper,
  Trash2,
  X,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { formatAiResponseError } from '@/src/lib/ai-client';
import { toBengaliNumber } from '@/src/lib/file-validation';
import { isPaperCuttingGkItem } from '@/src/lib/paper-cutting-parser';
import { PaperCuttingPanel } from './PaperCuttingPanel';

const GK_CATEGORIES = ['সব', 'জাতীয়', 'অর্থনীতি', 'আন্তর্জাতিক', 'বিজ্ঞান ও প্রযুক্তি'];

export function CurrentGkView() {
  const {
    data,
    addGkItem,
    toggleGkArchive,
    markGkConverted,
    deleteGkItem,
    addQuestions,
    getAiAuthHeaders,
    requestAiSignIn,
  } = useWorkspace();

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const [viewMode, setViewMode] = useState<'current' | 'paper-cutting' | 'archived'>('current');
  const [categoryFilter, setCategoryFilter] = useState('সব');
  const [showAddForm, setShowAddForm] = useState(false);

  // Add GK form state
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('জাতীয়');
  const [eventDate, setEventDate] = useState('2026-11-20');
  const [source, setSource] = useState('');
  const [summary, setSummary] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Convert to questions state
  const [convertingId, setConvertingId] = useState<number | null>(null);
  const [convertNotice, setConvertNotice] = useState<string | null>(null);
  const [convertError, setConvertError] = useState<string | null>(null);

  const paperCuttingItems = useMemo(() => {
    return data.gkItems.filter(
      (item) => !item.isArchived && isPaperCuttingGkItem(item)
    );
  }, [data.gkItems]);

  const visibleItems = useMemo(() => {
    return data.gkItems.filter((item) => {
      if (viewMode === 'current') {
        if (item.isArchived || isPaperCuttingGkItem(item)) return false;
      }
      if (viewMode === 'archived' && !item.isArchived) return false;
      if (categoryFilter !== 'সব' && item.category !== categoryFilter) {
        return false;
      }
      return true;
    });
  }, [data.gkItems, viewMode, categoryFilter]);

  const handleAddGk = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!title.trim() || !summary.trim()) {
      setFormError('ঘটনার শিরোনাম এবং বিস্তারিত তথ্য উভয়ই আবশ্যক।');
      return;
    }
    await addGkItem({
      title: title.trim(),
      summary: summary.trim(),
      category,
      eventDate: eventDate || '2026-11-20',
      source: source.trim() || 'দৈনিক সংবাদপত্র',
      isArchived: false,
    });
    setTitle('');
    setSource('');
    setSummary('');
    setShowAddForm(false);
  };

  const handleConvertToQuestions = async (item: (typeof data.gkItems)[number]) => {
    setConvertNotice(null);
    setConvertError(null);

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('সাম্প্রতিক GK থেকে AI প্রশ্ন রূপান্তর');
      return;
    }

    setConvertingId(item.id);
    try {
      const res = await fetch('/api/ai/gk-convert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          title: item.title,
          summary: item.summary,
          category: item.category,
          eventDate: item.eventDate,
          source: item.source,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          requestAiSignIn('সাম্প্রতিক GK থেকে AI প্রশ্ন রূপান্তর');
        }
        throw new Error(
          formatAiResponseError(res.status, json, 'প্রশ্ন রূপান্তর ব্যর্থ হয়েছে।')
        );
      }
      const created = Array.isArray(json.questions) ? json.questions : [];
      if (created.length > 0) {
        await addQuestions(created);
        markGkConverted(item.id);
        setConvertNotice(
          `"${item.title}" থেকে ${created.length}টি চাকরির পরীক্ষার উপযোগী প্রশ্ন (MCQ ও Short) Question Bank-এ যুক্ত হয়েছে।`
        );
      }
    } catch (err) {
      setConvertError(
        err instanceof Error ? err.message : 'প্রশ্ন রূপান্তরে সমস্যা হয়েছে।'
      );
    } finally {
      setConvertingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            06. Current GK (সাম্প্রতিক ঘটনা ও সাধারণ জ্ঞান)
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            সাম্প্রতিক তথ্য তারিখ ও উৎসসহ সংরক্ষণ করুন, নতুন ও পুরোনো তথ্য আলাদা রাখুন এবং এক ক্লিকে চাকরির পরীক্ষার প্রশ্নে রূপান্তর করুন।
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowAddForm((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
        >
          {showAddForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          <span>{showAddForm ? 'বন্ধ করুন' : 'সাম্প্রতিক ঘটনা যুক্ত করুন'}</span>
        </button>
      </div>

      {/* Add GK Form */}
      {showAddForm && (
        <form
          onSubmit={handleAddGk}
          className="rounded-xl border border-slate-200 bg-white p-6 space-y-4"
        >
          <h2 className="text-base font-semibold text-slate-900">
            নতুন সাম্প্রতিক সাধারণ জ্ঞান (GK) যুক্ত করুন
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label
                htmlFor="gk-title-input"
                className="block text-xs font-semibold text-slate-700"
              >
                ঘটনার শিরোনাম *
              </label>
              <input
                id="gk-title-input"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="যেমন: ২০২৬ সালে পদ্মা সেতুতে রেল সংযোগ ও অর্থনৈতিক প্রভাব"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="gk-cat-select"
                className="block text-xs font-semibold text-slate-700"
              >
                ক্যাটাগরি
              </label>
              <select
                id="gk-cat-select"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              >
                {GK_CATEGORIES.filter((c) => c !== 'সব').map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="gk-date-input"
                className="block text-xs font-semibold text-slate-700"
              >
                ঘটনার তারিখ
              </label>
              <input
                id="gk-date-input"
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900"
              />
            </div>

            <div className="sm:col-span-4">
              <label
                htmlFor="gk-source-input"
                className="block text-xs font-semibold text-slate-700"
              >
                তথ্যের উৎস (Source)
              </label>
              <input
                id="gk-source-input"
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="যেমন: প্রথম আলো / বাংলাদেশ ব্যাংক প্রতিবেদন"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
              />
            </div>

            <div className="sm:col-span-4">
              <label
                htmlFor="gk-summary-input"
                className="block text-xs font-semibold text-slate-700"
              >
                বিস্তারিত তথ্য ও মূল পরিসংখ্যান *
              </label>
              <textarea
                id="gk-summary-input"
                rows={3}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="ঘটনার তারিখ, সংখ্যা, ব্যক্তি বা চুক্তির মূল তথ্য লিখুন..."
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
              />
            </div>
          </div>

          {formError && (
            <p role="alert" className="text-xs font-medium text-red-700">
              {formError}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              বাতিল
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-800"
            >
              সংরক্ষণ করুন
            </button>
          </div>
        </form>
      )}

      {convertNotice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{convertNotice}</span>
        </div>
      )}
      {convertError && (
        <p role="alert" className="text-xs font-medium text-red-700">
          {convertError}
        </p>
      )}

      {/* Filter Bar: Current vs Paper Cutting vs Archive + Category */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="সাম্প্রতিক, পেপার কাটিং ও পুরোনো তথ্য বিভাজন"
          className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-200/70 p-1 self-start"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'current'}
            onClick={() => setViewMode('current')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              viewMode === 'current'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            সাম্প্রতিক (নতুন)
          </button>
          <button
            type="button"
            role="tab"
            data-testid="tab-paper-cutting"
            aria-selected={viewMode === 'paper-cutting'}
            onClick={() => setViewMode('paper-cutting')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              viewMode === 'paper-cutting'
                ? 'bg-white text-blue-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Newspaper className="h-3.5 w-3.5" />
            <span>Paper Cutting</span>
            {paperCuttingItems.length > 0 && (
              <span className="font-mono text-[11px] tabular-nums opacity-75">
                ({toBengaliNumber(paperCuttingItems.length)})
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'archived'}
            onClick={() => setViewMode('archived')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              viewMode === 'archived'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            পুরোনো / আর্কাইভ
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
          {GK_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                categoryFilter === cat
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Paper Cutting Workspace OR GK Feed */}
      {viewMode === 'paper-cutting' ? (
        <PaperCuttingPanel
          items={paperCuttingItems}
          categoryFilter={categoryFilter}
        />
      ) : visibleItems.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
          <Globe className="mx-auto h-7 w-7 text-slate-400" />
          <p className="mt-2 text-sm text-slate-500">
            এই বিভাগে কোনো সাম্প্রতিক তথ্য নেই।
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
          {visibleItems.map((item) => (
            <article key={item.id} className="p-5 space-y-2.5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">
                      {item.category}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      তারিখ: {item.eventDate}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>উৎস: {item.source}</span>
                    {item.convertedToQuestions && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-emerald-700">
                          প্রশ্নব্যাংকে যুক্ত
                        </span>
                      </>
                    )}
                  </div>
                  <h2 className="mt-1 text-base font-semibold text-slate-900">
                    {item.title}
                  </h2>
                  <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                    {item.summary}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleConvertToQuestions(item)}
                    disabled={convertingId === item.id}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {convertingId === item.id ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>তৈরি হচ্ছে...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>প্রশ্নে রূপান্তর (AI)</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleGkArchive(item.id)}
                    aria-label={
                      item.isArchived
                        ? `সাম্প্রতিকে ফিরিয়ে আনুন: ${item.title}`
                        : `আর্কাইভে পাঠান: ${item.title}`
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    <span>{item.isArchived ? 'পুনরুদ্ধার' : 'আর্কাইভ'}</span>
                  </button>

                  {confirmDeleteId === item.id ? (
                    <div className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-2 py-1">
                      <button
                        type="button"
                        data-testid={`confirm-delete-gk-btn-${item.id}`}
                        disabled={deletingId === item.id}
                        onClick={async () => {
                          setDeletingId(item.id);
                          try {
                            await deleteGkItem(item.id);
                            setConfirmDeleteId(null);
                          } finally {
                            setDeletingId(null);
                          }
                        }}
                        className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                      >
                        {deletingId === item.id ? 'মুছছে...' : 'নিশ্চিত মুছুন'}
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === item.id}
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        বাতিল
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid={`delete-gk-btn-${item.id}`}
                      aria-label={`মুছুন: ${item.title}`}
                      onClick={() => setConfirmDeleteId(item.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-2 text-xs font-medium text-red-700 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>মুছুন</span>
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
