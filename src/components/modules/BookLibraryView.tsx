'use client';

import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  FileUp,
  Search,
  Trash2,
  ArrowRight,
  Plus,
  X,
  Loader2,
  ScanText,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { chunkBookText } from '@/src/lib/rag-engine';
import type { BookCategory } from '@/src/types/system';

const CATEGORIES: Array<'সব' | BookCategory> = [
  'সব',
  'BCS',
  'Bank',
  'Primary',
  'Current GK',
  'Previous Year',
];

export function BookLibraryView() {
  const {
    data,
    addBook,
    deleteBook,
    setSelectedBookId,
    setActiveModule,
  } = useWorkspace();

  const [categoryFilter, setCategoryFilter] = useState<'সব' | BookCategory>('সব');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  // Add Book / PDF Upload Form state
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [subject, setSubject] = useState('বাংলাদেশ বিষয়াবলি');
  const [category, setCategory] = useState<BookCategory>('BCS');
  const [chapterName, setChapterName] = useState('অধ্যায় ১: মূল আলোচনা');
  const [rawText, setRawText] = useState('');
  const [useOcr, setUseOcr] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [extractionNote, setExtractionNote] = useState<string | null>(null);
  const [extractedPages, setExtractedPages] = useState<number>(1);
  const [extractionMethod, setExtractionMethod] = useState<'text' | 'ocr' | 'manual'>('manual');

  const totalChunks = useMemo(
    () => data.books.reduce((sum, b) => sum + b.chunks.length, 0),
    [data.books]
  );

  const totalPages = useMemo(
    () => data.books.reduce((sum, b) => sum + b.totalPages, 0),
    [data.books]
  );

  const filteredBooks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return data.books.filter((book) => {
      if (categoryFilter !== 'সব' && book.category !== categoryFilter) {
        return false;
      }
      if (!q) return true;
      return (
        book.title.toLowerCase().includes(q) ||
        book.subject.toLowerCase().includes(q) ||
        book.author.toLowerCase().includes(q) ||
        book.chunks.some(
          (c) =>
            c.chapter.toLowerCase().includes(q) ||
            c.content.toLowerCase().includes(q)
        )
      );
    });
  }, [data.books, categoryFilter, searchQuery]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFormError(null);
    setExtractionNote(null);

    if (!title.trim()) {
      setTitle(file.name.replace(/\.[^.]+$/, ''));
    }

    setExtracting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('useOcr', String(useOcr));

      const res = await fetch('/api/ai/extract-pdf', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'ফাইল থেকে টেক্সট বের করা যায়নি।');
      }

      setRawText(json.rawText || '');
      setExtractedPages(Number(json.totalPages || 1));
      setExtractionMethod(json.method === 'ocr' ? 'ocr' : 'text');
      setExtractionNote(
        `সফলভাবে ${json.totalPages || 1} পৃষ্ঠার টেক্সট সংগ্রহ করা হয়েছে (${
          json.method === 'ocr' ? 'OCR সম্পন্ন' : 'টেক্সট এক্সট্র্যাকশন'
        })।`
      );
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : 'PDF প্রসেস করতে সমস্যা হয়েছে। নিচে সরাসরি টেক্সট পেস্ট করেও বই যুক্ত করতে পারবেন।'
      );
    } finally {
      setExtracting(false);
    }
  };

  const handleCreateBook = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!title.trim()) {
      setFormError('অনুগ্রহ করে বইয়ের নাম লিখুন।');
      return;
    }
    if (!subject.trim()) {
      setFormError('অনুগ্রহ করে বিষয় উল্লেখ করুন।');
      return;
    }
    if (rawText.trim().length < 20) {
      setFormError(
        'অনুগ্রহ করে একটি PDF/টেক্সট ফাইল আপলোড করুন অথবা অধ্যায়ের কমপক্ষে ২০ অক্ষরের পাঠ্য পেস্ট করুন।'
      );
      return;
    }

    setSaving(true);
    try {
      const chunks = chunkBookText({
        bookId: 0,
        bookTitle: title.trim(),
        chapter: chapterName.trim() || 'অধ্যায় ১',
        rawText: rawText.trim(),
      });

      const computedPages = Math.max(
        extractedPages,
        chunks.reduce((max, c) => Math.max(max, c.pageNumber), 1)
      );

      await addBook({
        title: title.trim(),
        author: author.trim() || 'ব্যক্তিগত নোট / গাইড',
        subject: subject.trim(),
        category,
        totalPages: computedPages,
        extractionMethod,
        ocrCompleted: extractionMethod === 'ocr' || useOcr,
        chunks: chunks.map((c) => ({
          chapter: c.chapter,
          pageNumber: c.pageNumber,
          chunkIndex: c.chunkIndex,
          content: c.content,
        })),
      });

      setTitle('');
      setAuthor('');
      setRawText('');
      setExtractionNote(null);
      setShowAddForm(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'বই সংরক্ষণ করতে সমস্যা হয়েছে।'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-6">
        <div className="max-w-2xl">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            01. বইয়ের লাইব্রেরি ও Knowledge Base
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
            PDF বই আপলোড, স্ক্যান করা বইয়ের OCR টেক্সট সংগ্রহ এবং অধ্যায় ও পৃষ্ঠা অনুযায়ী RAG Knowledge Base পরিচালনা করুন।
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddForm((v) => !v)}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
        >
          {showAddForm ? (
            <>
              <X className="h-4 w-4" />
              <span>ফর্ম বন্ধ করুন</span>
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              <span>নতুন বই / PDF যুক্ত করুন</span>
            </>
          )}
        </button>
      </div>

      {/* Summary Metric Strip (Single-Elevation, No Nested Cards) */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 border border-slate-200 bg-white rounded-xl divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">সংরক্ষিত বই</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {data.books.length}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">ইনডেক্সড চ্যাংক (RAG)</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {totalChunks}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">মোট পৃষ্ঠা</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {totalPages}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">তৈরি প্রশ্নব্যাংক</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-blue-700 tabular-nums">
            {data.questions.length}
          </div>
        </div>
      </div>

      {/* Add Book / PDF Upload Form */}
      {showAddForm && (
        <section
          aria-label="নতুন বই বা PDF আপলোড ফর্ম"
          className="rounded-xl border border-slate-200 bg-white p-6"
        >
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                নতুন PDF বই আপলোড বা অধ্যায় যুক্ত করুন
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                PDF বা স্ক্যান করা ছবি আপলোড করলে AI স্বয়ংক্রিয়ভাবে OCR ও পৃষ্ঠা অনুযায়ী টেক্সট আলাদা করবে।
              </p>
            </div>
          </div>

          <form onSubmit={handleCreateBook} className="mt-5 space-y-5">
            {/* File Upload + OCR Toggle */}
            <div className="flex flex-col gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <FileUp className="mt-0.5 h-5 w-5 text-blue-700 shrink-0" />
                <div>
                  <label
                    htmlFor="pdf-file-upload"
                    className="block text-sm font-semibold text-slate-900"
                  >
                    PDF, ছবি (JPG/PNG) বা টেক্সট ফাইল নির্বাচন করুন
                  </label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    সর্বোচ্চ ১৫ MB · বাংলা ও ইংরেজি স্ক্যান করা PDF-এর জন্য OCR সমর্থিত
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-4">
                    <input
                      id="pdf-file-upload"
                      type="file"
                      accept=".pdf,.txt,.md,image/*"
                      onChange={handleFileChange}
                      className="text-xs text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-100"
                    />
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={useOcr}
                        onChange={(e) => setUseOcr(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                      />
                      <ScanText className="h-3.5 w-3.5 text-slate-500" />
                      <span>স্ক্যান PDF-এর জন্য AI OCR চালু রাখুন</span>
                    </label>
                  </div>
                </div>
              </div>
              {extracting && (
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-blue-700">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>টেক্সট ও OCR প্রসেস হচ্ছে...</span>
                </div>
              )}
            </div>

            {extractionNote && (
              <p className="text-xs font-medium text-emerald-700">
                {extractionNote}
              </p>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <label
                  htmlFor="book-title-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  বইয়ের নাম *
                </label>
                <input
                  id="book-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="যেমন: বাংলাদেশের মুক্তিযুদ্ধ ও ইতিহাস গাইড"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div>
                <label
                  htmlFor="book-subject-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  বিষয় (Subject) *
                </label>
                <input
                  id="book-subject-input"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="যেমন: বাংলাদেশ বিষয়াবলি"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div>
                <label
                  htmlFor="book-category-select"
                  className="block text-xs font-semibold text-slate-700"
                >
                  ক্যাটাগরি
                </label>
                <select
                  id="book-category-select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as BookCategory)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                >
                  <option value="BCS">BCS</option>
                  <option value="Bank">Bank</option>
                  <option value="Primary">Primary</option>
                  <option value="Current GK">Current GK</option>
                  <option value="Previous Year">Previous Year</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="book-author-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  লেখক / প্রকাশনী
                </label>
                <input
                  id="book-author-input"
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="ঐচ্ছিক"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div className="sm:col-span-3">
                <label
                  htmlFor="book-chapter-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  প্রাথমিক অধ্যায়ের নাম
                </label>
                <input
                  id="book-chapter-input"
                  type="text"
                  value={chapterName}
                  onChange={(e) => setChapterName(e.target.value)}
                  placeholder="অধ্যায় ১: ভাষা আন্দোলন থেকে মুক্তিযুদ্ধ"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="book-raw-text"
                className="block text-xs font-semibold text-slate-700"
              >
                সংগৃহীত টেক্সট বা অধ্যায়ের পাঠ্য * (পৃষ্ঠা আলাদা করতে &quot;--- পৃষ্ঠা ৫ ---&quot; লিখতে পারেন)
              </label>
              <textarea
                id="book-raw-text"
                rows={5}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="এখানে PDF থেকে সংগৃহীত টেক্সট স্বয়ংক্রিয়ভাবে আসবে, অথবা সরাসরি যেকোনো বইয়ের নোট পেস্ট করুন..."
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 leading-relaxed focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
              />
            </div>

            {formError && (
              <p role="alert" className="text-xs font-medium text-red-700">
                {formError}
              </p>
            )}

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                বাতিল
              </button>
              <button
                type="submit"
                disabled={saving || extracting}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>Knowledge Base-এ সংরক্ষণ করুন</span>
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Search & Category Filter Toolbar */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div
          role="tablist"
          aria-label="বইয়ের ক্যাটাগরি ফিল্টার"
          className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-200/70 p-1"
        >
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={categoryFilter === cat}
              onClick={() => setCategoryFilter(cat)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                categoryFilter === cat
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            aria-label="বই, অধ্যায় বা টপিক খুঁজুন"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="বই, অধ্যায় বা টপিক খুঁজুন..."
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
          />
        </div>
      </div>

      {/* Book Directory List (Clean Editorial Table/List, Zero Pills) */}
      {filteredBooks.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
          <BookOpen className="mx-auto h-8 w-8 text-slate-400" />
          <h2 className="mt-3 text-base font-semibold text-slate-900">
            কোনো বই পাওয়া যায়নি
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            অনুসন্ধান পরিবর্তন করুন অথবা নতুন PDF বই আপলোড করে আপনার Knowledge Base শুরু করুন।
          </p>
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="mt-4 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 transition-colors"
          >
            প্রথম বই যুক্ত করুন
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
          {filteredBooks.map((book) => (
            <article
              key={book.id}
              className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between hover:bg-slate-50/70 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-slate-900 leading-snug">
                  {book.title}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{book.subject}</span>
                  <span aria-hidden="true">·</span>
                  <span>{book.category}</span>
                  <span aria-hidden="true">·</span>
                  <span>{book.author}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {book.totalPages} পৃষ্ঠা
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {book.chunks.length} অধ্যায়/অংশ
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {book.extractionMethod === 'ocr'
                      ? 'OCR সম্পন্ন'
                      : 'টেক্সট ইনডেক্সড'}
                  </span>
                </div>

                {/* Chapter Preview Line */}
                {book.chunks.length > 0 && (
                  <p className="mt-2.5 text-xs text-slate-600 line-clamp-2 leading-relaxed">
                    অধ্যায়সমূহ:{' '}
                    {book.chunks
                      .map((c) => `${c.chapter} (পৃ. ${c.pageNumber})`)
                      .join(' · ')}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedBookId(book.id);
                    setActiveModule('reader');
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap"
                >
                  <span>স্মার্ট রিডার</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedBookId(book.id);
                    setActiveModule('question-lab');
                  }}
                  className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  প্রশ্ন তৈরি
                </button>
                <button
                  type="button"
                  onClick={() => void deleteBook(book.id)}
                  aria-label={`বই মুছুন: ${book.title}`}
                  className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-700 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
