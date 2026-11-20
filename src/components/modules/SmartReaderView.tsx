'use client';

import React, { useMemo, useState } from 'react';
import {
  Search,
  Copy,
  Check,
  BookOpen,
  Sparkles,
  Loader2,
  GitCompare,
  ListChecks,
  Lightbulb,
  FileText,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { rankChunksHybrid } from '@/src/lib/rag-engine';

type ReaderActionMode = 'summary' | 'facts' | 'explain' | 'compare';

export function SmartReaderView() {
  const { data, selectedBookId, setSelectedBookId } = useWorkspace();

  const activeBook = useMemo(
    () =>
      data.books.find((b) => b.id === selectedBookId) ?? data.books[0] ?? null,
    [data.books, selectedBookId]
  );

  const [selectedChunkId, setSelectedChunkId] = useState<number | null>(null);
  const [crossQuery, setCrossQuery] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // AI Reader Workbench state
  const [aiMode, setAiMode] = useState<ReaderActionMode>('summary');
  const [aiOutput, setAiOutput] = useState<string>('');
  const [aiCitations, setAiCitations] = useState<
    Array<{ bookTitle: string; chapter: string; pageNumber: number }>
  >([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const allChunks = useMemo(
    () => data.books.flatMap((b) => b.chunks),
    [data.books]
  );

  const activeChunk = useMemo(() => {
    if (!activeBook) return null;
    return (
      activeBook.chunks.find((c) => c.id === selectedChunkId) ??
      activeBook.chunks[0] ??
      null
    );
  }, [activeBook, selectedChunkId]);

  const crossBookMatches = useMemo(() => {
    if (!crossQuery.trim()) return [];
    return rankChunksHybrid(allChunks, crossQuery.trim(), { topK: 5 });
  }, [allChunks, crossQuery]);

  const handleCopy = async (id: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const runReaderAi = async (mode: ReaderActionMode) => {
    setAiMode(mode);
    setAiError(null);
    setAiLoading(true);

    const targetChunks =
      mode === 'compare' && crossBookMatches.length > 0
        ? crossBookMatches
        : mode === 'compare' && activeChunk
          ? rankChunksHybrid(allChunks, activeChunk.chapter, { topK: 4 })
          : activeChunk
            ? [activeChunk]
            : [];

    if (targetChunks.length === 0) {
      setAiError('বিশ্লেষণ করার মতো কোনো অধ্যায় পাওয়া যায়নি।');
      setAiLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/ai/reader', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          topic: crossQuery.trim() || activeChunk?.chapter || activeBook?.title,
          chunks: targetChunks.map((c) => ({
            bookTitle: c.bookTitle,
            chapter: c.chapter,
            pageNumber: c.pageNumber,
            content: c.content,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'AI বিশ্লেষণ তৈরি করা যায়নি।');
      }
      setAiOutput(json.result || '');
      setAiCitations(Array.isArray(json.citations) ? json.citations : []);
    } catch (err) {
      setAiError(
        err instanceof Error ? err.message : 'AI বিশ্লেষণ ব্যর্থ হয়েছে।'
      );
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-slate-200 pb-5">
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
          02. স্মার্ট রিডার ও একাধিক বই থেকে টপিক সংগ্রহ
        </h1>
        <p className="mt-1.5 text-sm text-slate-600">
          বইয়ের নির্দিষ্ট পৃষ্ঠা ও অধ্যায় পড়ুন, টেক্সট কপি করুন, এবং RAG-এর মাধ্যমে একাধিক বইয়ের তথ্য বইয়ের নাম ও পৃষ্ঠা নম্বরসহ একত্রিত করুন।
        </p>
      </div>

      {/* Cross-Book RAG Search Bar */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <label
          htmlFor="cross-book-rag-search"
          className="block text-xs font-semibold text-slate-700"
        >
          একাধিক বই থেকে টপিক খুঁজুন (Cross-Book RAG Search)
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="cross-book-rag-search"
              type="search"
              value={crossQuery}
              onChange={(e) => setCrossQuery(e.target.value)}
              placeholder="যেমন: সংবিধান অর্থবিল, রেপো রেট, মৌলিক অধিকার, জাতিসংঘ..."
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            />
          </div>
          <button
            type="button"
            onClick={() => void runReaderAi('compare')}
            disabled={aiLoading || (!crossQuery.trim() && !activeChunk)}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <GitCompare className="h-4 w-4" />
            <span>একাধিক বই একত্র ও তুলনা করুন</span>
          </button>
        </div>

        {crossQuery.trim() && (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <div className="text-xs font-semibold text-slate-600">
              সব বই মিলিয়ে প্রাসঙ্গিক অংশ পাওয়া গেছে:{' '}
              <span className="font-mono tabular-nums text-slate-900">
                {crossBookMatches.length}টি
              </span>
            </div>
            {crossBookMatches.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">
                এই টপিকে কোনো বইয়ে সরাসরি মিল পাওয়া যায়নি। অন্য শব্দ দিয়ে চেষ্টা করুন।
              </p>
            ) : (
              <div className="mt-2.5 divide-y divide-slate-200 rounded-lg border border-slate-200">
                {crossBookMatches.map((match) => (
                  <div key={match.id} className="p-3 bg-slate-50/50">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                      <span className="font-semibold text-slate-900">
                        {match.bookTitle}
                      </span>
                      <span className="font-mono tabular-nums text-slate-500">
                        {match.chapter} · পৃষ্ঠা {match.pageNumber}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-700 leading-relaxed">
                      {match.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main 2-Column Split Reader & AI Workbench */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left: Book & Chapter Reading Pane (7 cols) */}
        <section
          aria-label="বই ও অধ্যায় রিডার"
          className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden"
        >
          <div className="grid grid-cols-1 gap-3 border-b border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="reader-book-select"
                className="block text-xs font-semibold text-slate-600"
              >
                বই নির্বাচন করুন
              </label>
              <select
                id="reader-book-select"
                value={activeBook?.id ?? ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setSelectedBookId(id);
                  setSelectedChunkId(null);
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              >
                {data.books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="reader-chapter-select"
                className="block text-xs font-semibold text-slate-600"
              >
                অধ্যায় ও পৃষ্ঠা
              </label>
              <select
                id="reader-chapter-select"
                value={activeChunk?.id ?? ''}
                onChange={(e) => setSelectedChunkId(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              >
                {(activeBook?.chunks ?? []).map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.chapter} (পৃষ্ঠা {ch.pageNumber})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {activeChunk ? (
            <div className="p-6">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <div className="text-xs text-slate-500">
                  <span className="font-semibold text-slate-800">
                    {activeChunk.bookTitle}
                  </span>
                  <span aria-hidden="true" className="mx-1.5">·</span>
                  <span>{activeChunk.chapter}</span>
                  <span aria-hidden="true" className="mx-1.5">·</span>
                  <span className="font-mono tabular-nums font-medium text-blue-700">
                    পৃষ্ঠা {activeChunk.pageNumber}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void handleCopy(
                      activeChunk.id,
                      `${activeChunk.content}\n\n— উৎস: ${activeChunk.bookTitle}, ${activeChunk.chapter}, পৃষ্ঠা ${activeChunk.pageNumber}`
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  {copiedId === activeChunk.id ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-700" />
                      <span>কপি হয়েছে</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>টেক্সট কপি</span>
                    </>
                  )}
                </button>
              </div>

              <div className="mt-4 text-base leading-8 text-slate-800 whitespace-pre-wrap">
                {activeChunk.content}
              </div>

              {/* Other chapters quick switcher */}
              {activeBook && activeBook.chunks.length > 1 && (
                <div className="mt-6 border-t border-slate-200 pt-4">
                  <div className="text-xs font-semibold text-slate-500 mb-2">
                    এই বইয়ের অন্যান্য অধ্যায়
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {activeBook.chunks.map((ch) => (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => setSelectedChunkId(ch.id)}
                        className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          activeChunk.id === ch.id
                            ? 'border-blue-700 bg-blue-50 text-blue-800'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        পৃ. {ch.pageNumber} — {ch.chapter}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-10 text-center text-sm text-slate-500">
              <BookOpen className="mx-auto h-7 w-7 text-slate-400" />
              <p className="mt-2">পড়ার জন্য প্রথমে Book Library থেকে একটি বই যুক্ত করুন।</p>
            </div>
          )}
        </section>

        {/* Right: AI Smart Reader Workbench (5 cols) */}
        <section
          aria-label="AI স্মার্ট রিডার বিশ্লেষণ"
          className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-700" />
            <h2 className="text-base font-semibold text-slate-900">
              AI স্মার্ট নোট ও ব্যাখ্যা (RAG)
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            শুধুমাত্র সংগৃহীত প্রাসঙ্গিক অধ্যায় পাঠিয়ে সারাংশ, মূল তথ্য ও সহজ ব্যাখ্যা তৈরি হয়।
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void runReaderAi('summary')}
              disabled={aiLoading}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                aiMode === 'summary' && aiOutput
                  ? 'border-blue-700 bg-blue-50 text-blue-800'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>সারাংশ তৈরি</span>
            </button>
            <button
              type="button"
              onClick={() => void runReaderAi('facts')}
              disabled={aiLoading}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                aiMode === 'facts' && aiOutput
                  ? 'border-blue-700 bg-blue-50 text-blue-800'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <ListChecks className="h-3.5 w-3.5" />
              <span>মূল তথ্য ও সংজ্ঞা</span>
            </button>
            <button
              type="button"
              onClick={() => void runReaderAi('explain')}
              disabled={aiLoading}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                aiMode === 'explain' && aiOutput
                  ? 'border-blue-700 bg-blue-50 text-blue-800'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Lightbulb className="h-3.5 w-3.5" />
              <span>সহজ ভাষায় ব্যাখ্যা</span>
            </button>
            <button
              type="button"
              onClick={() => void runReaderAi('compare')}
              disabled={aiLoading}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                aiMode === 'compare' && aiOutput
                  ? 'border-blue-700 bg-blue-50 text-blue-800'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <GitCompare className="h-3.5 w-3.5" />
              <span>বই তুলনা (Compare)</span>
            </button>
          </div>

          <div className="mt-4 min-h-[240px] rounded-lg border border-slate-200 bg-slate-50 p-4">
            {aiLoading ? (
              <div className="flex h-44 flex-col items-center justify-center gap-2 text-xs font-medium text-slate-600">
                <Loader2 className="h-5 w-5 animate-spin text-blue-700" />
                <span>Knowledge Base বিশ্লেষণ করে উত্তর তৈরি হচ্ছে...</span>
              </div>
            ) : aiError ? (
              <p role="alert" className="text-xs font-medium text-red-700">
                {aiError}
              </p>
            ) : aiOutput ? (
              <div className="space-y-4">
                <div className="text-sm leading-7 text-slate-800 whitespace-pre-wrap">
                  {aiOutput}
                </div>
                {aiCitations.length > 0 && (
                  <div className="border-t border-slate-200 pt-3">
                    <div className="text-xs font-semibold text-slate-600">
                      তথ্যের উৎস ও পৃষ্ঠা নম্বর
                    </div>
                    <ul className="mt-1.5 space-y-1 text-xs text-slate-500">
                      {aiCitations.map((c, idx) => (
                        <li key={idx}>
                          {c.bookTitle} · {c.chapter} ·{' '}
                          <span className="font-mono tabular-nums text-slate-700">
                            পৃষ্ঠা {c.pageNumber}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-44 flex-col items-center justify-center text-center text-xs text-slate-500">
                <p>
                  উপরের যেকোনো একটি বাটনে ক্লিক করুন—AI নির্বাচিত অধ্যায় বা একাধিক বই বিশ্লেষণ করে বইয়ের নাম ও পৃষ্ঠা নম্বরসহ নোট তৈরি করে দেবে।
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
