'use client';

import React, { useMemo, useState } from 'react';
import {
  Sparkles,
  Loader2,
  CheckCircle2,
  Trash2,
  Search,
  BarChart2,
  Plus,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { rankChunksHybrid } from '@/src/lib/rag-engine';
import { analyzePreviousYearPatterns } from '@/src/lib/exam-engine';
import type {
  DifficultyLevel,
  Question,
  QuestionType,
} from '@/src/types/system';

type LabTab = 'generate' | 'bank' | 'pyq';

export function QuestionLabView() {
  const { data, selectedBookId, addQuestions, deleteQuestion } = useWorkspace();

  const [activeTab, setActiveTab] = useState<LabTab>('generate');

  // Generator controls
  const [selectedBookIds, setSelectedBookIds] = useState<number[]>(() =>
    selectedBookId
      ? [selectedBookId]
      : data.books[0]
        ? [data.books[0].id]
        : []
  );
  const [questionType, setQuestionType] = useState<QuestionType>('MCQ');
  const [difficulty, setDifficulty] = useState<DifficultyLevel>('Medium');
  const [count, setCount] = useState(4);
  const [topicHint, setTopicHint] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genSuccessMsg, setGenSuccessMsg] = useState<string | null>(null);
  const [generatedPreview, setGeneratedPreview] = useState<
    Array<Omit<Question, 'id' | 'createdAt'>>
  >([]);

  // Question Bank filters
  const [bankSearch, setBankSearch] = useState('');
  const [bankTypeFilter, setBankTypeFilter] = useState<'সব' | QuestionType>('সব');
  const [bankDifficultyFilter, setBankDifficultyFilter] = useState<
    'সব' | DifficultyLevel
  >('সব');
  const [onlyPreviousYear, setOnlyPreviousYear] = useState(false);
  const [expandedQuestionId, setExpandedQuestionId] = useState<number | null>(
    null
  );

  const pyqPatterns = useMemo(
    () => analyzePreviousYearPatterns(data.questions),
    [data.questions]
  );

  const filteredBank = useMemo(() => {
    const q = bankSearch.trim().toLowerCase();
    return data.questions.filter((item) => {
      if (bankTypeFilter !== 'সব' && item.questionType !== bankTypeFilter) {
        return false;
      }
      if (
        bankDifficultyFilter !== 'সব' &&
        item.difficulty !== bankDifficultyFilter
      ) {
        return false;
      }
      if (onlyPreviousYear && !item.isPreviousYear) return false;
      if (!q) return true;
      return (
        item.stem.toLowerCase().includes(q) ||
        item.subject.toLowerCase().includes(q) ||
        item.chapter.toLowerCase().includes(q) ||
        item.bookTitle.toLowerCase().includes(q)
      );
    });
  }, [
    data.questions,
    bankSearch,
    bankTypeFilter,
    bankDifficultyFilter,
    onlyPreviousYear,
  ]);

  const toggleBookSelection = (id: number) => {
    setSelectedBookIds((prev) =>
      prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]
    );
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenError(null);
    setGenSuccessMsg(null);

    if (selectedBookIds.length === 0) {
      setGenError('প্রশ্ন তৈরির জন্য অন্তত একটি বই নির্বাচন করুন।');
      return;
    }

    const chosenBooks = data.books.filter((b) => selectedBookIds.includes(b.id));
    const allSelectedChunks = chosenBooks.flatMap((b) => b.chunks);
    const rankedChunks = rankChunksHybrid(
      allSelectedChunks,
      topicHint.trim() || chosenBooks.map((b) => b.subject).join(' '),
      { topK: 6 }
    );

    if (rankedChunks.length === 0) {
      setGenError('নির্বাচিত বইগুলোতে কোনো টেক্সট চ্যাংক পাওয়া যায়নি।');
      return;
    }

    setGenerating(true);
    try {
      const subjectLabel =
        chosenBooks.length === 1
          ? chosenBooks[0].subject
          : 'সমন্বিত (একাধিক বই)';

      const res = await fetch('/api/ai/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chunks: rankedChunks.map((c) => ({
            bookId: c.bookId,
            bookTitle: c.bookTitle,
            chapter: c.chapter,
            pageNumber: c.pageNumber,
            content: c.content,
          })),
          existingStems: data.questions.map((q) => q.stem),
          subject: subjectLabel,
          questionType,
          difficulty,
          count,
          topicHint: topicHint.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'AI প্রশ্ন তৈরি করতে ব্যর্থ হয়েছে।');
      }
      const created = Array.isArray(json.questions) ? json.questions : [];
      setGeneratedPreview(created);
      if (created.length === 0) {
        setGenError('নতুন কোনো অনন্য প্রশ্ন তৈরি হয়নি—টপিক পরিবর্তন করে আবার চেষ্টা করুন।');
      }
    } catch (err) {
      setGenError(
        err instanceof Error ? err.message : 'প্রশ্ন তৈরিতে ত্রুটি হয়েছে।'
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveGeneratedToBank = async () => {
    if (generatedPreview.length === 0) return;
    await addQuestions(generatedPreview);
    setGenSuccessMsg(
      `${generatedPreview.length}টি নতুন প্রশ্ন সফলভাবে Question Bank-এ সংরক্ষিত হয়েছে।`
    );
    setGeneratedPreview([]);
  };

  return (
    <div className="space-y-6">
      {/* Header + Sub-tabs */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            03. AI Question Lab ও প্রশ্নব্যাংক
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            এক বা একাধিক বই বিশ্লেষণ করে ডুপ্লিকেটমুক্ত MCQ, Written ও Short প্রশ্ন তৈরি করুন এবং বিগত বছরের প্যাটার্ন বিশ্লেষণ দেখুন।
          </p>
        </div>

        <div
          role="tablist"
          aria-label="প্রশ্ন ল্যাব সেকশন"
          className="inline-flex items-center gap-1 rounded-lg bg-slate-200/70 p-1 self-start sm:self-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'generate'}
            onClick={() => setActiveTab('generate')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'generate'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            AI প্রশ্ন তৈরি
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'bank'}
            onClick={() => setActiveTab('bank')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'bank'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            প্রশ্নব্যাংক ({data.questions.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'pyq'}
            onClick={() => setActiveTab('pyq')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'pyq'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            বিগত বছরের বিশ্লেষণ
          </button>
        </div>
      </div>

      {/* TAB 1: AI GENERATOR */}
      {activeTab === 'generate' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
          <form
            onSubmit={handleGenerate}
            className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-5"
          >
            <div>
              <span className="block text-xs font-semibold text-slate-700 mb-2">
                ১. উৎস বই নির্বাচন করুন (এক বা একাধিক বই)
              </span>
              <div className="max-h-52 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
                {data.books.map((book) => {
                  const checked = selectedBookIds.includes(book.id);
                  return (
                    <label
                      key={book.id}
                      className="flex items-start gap-2.5 p-3 hover:bg-slate-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBookSelection(book.id)}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-slate-900 leading-snug">
                          {book.title}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {book.subject} · {book.chunks.length} অধ্যায়
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="gen-q-type"
                  className="block text-xs font-semibold text-slate-700"
                >
                  প্রশ্নের ধরন
                </label>
                <select
                  id="gen-q-type"
                  value={questionType}
                  onChange={(e) =>
                    setQuestionType(e.target.value as QuestionType)
                  }
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  <option value="MCQ">MCQ (বহুনির্বাচনি)</option>
                  <option value="Written">Written (বর্ণনামূলক)</option>
                  <option value="Short">Short Question (সংক্ষিপ্ত)</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="gen-difficulty"
                  className="block text-xs font-semibold text-slate-700"
                >
                  কঠিনতার মাত্রা
                </label>
                <select
                  id="gen-difficulty"
                  value={difficulty}
                  onChange={(e) =>
                    setDifficulty(e.target.value as DifficultyLevel)
                  }
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  <option value="Easy">Easy (সহজ)</option>
                  <option value="Medium">Medium (মাঝারি)</option>
                  <option value="Hard">Hard (কঠিন / বিশ্লেষণধর্মী)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="gen-count"
                  className="block text-xs font-semibold text-slate-700"
                >
                  প্রশ্নের সংখ্যা
                </label>
                <input
                  id="gen-count"
                  type="number"
                  min={1}
                  max={8}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
              <div className="sm:col-span-2">
                <label
                  htmlFor="gen-topic-hint"
                  className="block text-xs font-semibold text-slate-700"
                >
                  নির্দিষ্ট অধ্যায় বা টপিক (ঐচ্ছিক)
                </label>
                <input
                  id="gen-topic-hint"
                  type="text"
                  value={topicHint}
                  onChange={(e) => setTopicHint(e.target.value)}
                  placeholder="যেমন: মৌলিক অধিকার ও রিট"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                />
              </div>
            </div>

            {genError && (
              <p role="alert" className="text-xs font-medium text-red-700">
                {genError}
              </p>
            )}
            {genSuccessMsg && (
              <p className="text-xs font-medium text-emerald-700">
                {genSuccessMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={generating}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>RAG বিশ্লেষণ করে প্রশ্ন তৈরি হচ্ছে...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  <span>AI দিয়ে নতুন প্রশ্ন তৈরি করুন</span>
                </>
              )}
            </button>
          </form>

          {/* Generated Questions Preview Panel */}
          <section
            aria-label="তৈরি হওয়া প্রশ্নের প্রিভিউ"
            className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  তৈরি হওয়া প্রশ্নসমূহ (ডুপ্লিকেট যাচাইকৃত)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  বিদ্যমান প্রশ্নব্যাংকের সাথে মিলিয়ে পুনরাবৃত্তি বাদ দেওয়া হয়।
                </p>
              </div>
              {generatedPreview.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleSaveGeneratedToBank()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors whitespace-nowrap"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>সবগুলো প্রশ্নব্যাংকে সংরক্ষণ করুন</span>
                </button>
              )}
            </div>

            {generatedPreview.length === 0 ? (
              <div className="py-16 text-center text-sm text-slate-500">
                বাম পাশ থেকে এক বা একাধিক বই নির্বাচন করে &quot;AI দিয়ে নতুন প্রশ্ন তৈরি করুন&quot; বাটনে ক্লিক করুন।
              </div>
            ) : (
              <div className="mt-4 divide-y divide-slate-200">
                {generatedPreview.map((q, idx) => (
                  <div key={idx} className="py-4 first:pt-0">
                    <div className="text-xs text-slate-500">
                      <span>{q.questionType}</span>
                      <span aria-hidden="true" className="mx-1.5">·</span>
                      <span>{q.difficulty}</span>
                      <span aria-hidden="true" className="mx-1.5">·</span>
                      <span>{q.bookTitle}</span>
                      <span aria-hidden="true" className="mx-1.5">·</span>
                      <span className="font-mono tabular-nums">
                        পৃষ্ঠা {q.pageNumber}
                      </span>
                      <span aria-hidden="true" className="mx-1.5">·</span>
                      <span className="font-mono tabular-nums text-blue-700">
                        গুরুত্ব {q.importanceScore}%
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm font-semibold text-slate-900">
                      {idx + 1}. {q.stem}
                    </p>
                    {q.options.length > 0 && (
                      <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 text-xs">
                        {q.options.map((opt, oIdx) => (
                          <li
                            key={oIdx}
                            className={`rounded-md border px-2.5 py-1.5 ${
                              oIdx === q.correctOptionIndex
                                ? 'border-emerald-300 bg-emerald-50 font-semibold text-emerald-900'
                                : 'border-slate-200 text-slate-700'
                            }`}
                          >
                            {String.fromCharCode(65 + oIdx)}. {opt}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-2.5 text-xs text-slate-600 leading-relaxed">
                      <span className="font-semibold text-slate-800">
                        মডেল উত্তর ও ব্যাখ্যা:
                      </span>{' '}
                      {q.modelAnswer} — {q.explanation}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB 2: QUESTION BANK */}
      {activeTab === 'bank' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                {(['সব', 'MCQ', 'Written', 'Short'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setBankTypeFilter(t)}
                    className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                      bankTypeFilter === t
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <select
                aria-label="কঠিনতা ফিল্টার"
                value={bankDifficultyFilter}
                onChange={(e) =>
                  setBankDifficultyFilter(
                    e.target.value as 'সব' | DifficultyLevel
                  )
                }
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
              >
                <option value="সব">সব স্তর</option>
                <option value="Easy">Easy</option>
                <option value="Medium">Medium</option>
                <option value="Hard">Hard</option>
              </select>

              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 ml-1">
                <input
                  type="checkbox"
                  checked={onlyPreviousYear}
                  onChange={(e) => setOnlyPreviousYear(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-blue-700"
                />
                <span>শুধু বিগত বছরের প্রশ্ন</span>
              </label>
            </div>

            <div className="relative w-full lg:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                aria-label="প্রশ্নব্যাংকে খুঁজুন"
                value={bankSearch}
                onChange={(e) => setBankSearch(e.target.value)}
                placeholder="প্রশ্ন, বিষয় বা অধ্যায় খুঁজুন..."
                className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
            {filteredBank.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                নির্বাচিত ফিল্টারে কোনো প্রশ্ন পাওয়া যায়নি।
              </div>
            ) : (
              filteredBank.map((q) => {
                const expanded = expandedQuestionId === q.id;
                return (
                  <div key={q.id} className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                          <span className="font-semibold text-slate-800">
                            {q.questionType}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{q.difficulty}</span>
                          <span aria-hidden="true">·</span>
                          <span>{q.subject}</span>
                          <span aria-hidden="true">·</span>
                          <span>{q.chapter}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            পৃ. {q.pageNumber}
                          </span>
                          {q.isPreviousYear && q.examSource && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-blue-700">
                                {q.examSource} ({q.examYear})
                              </span>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedQuestionId(expanded ? null : q.id)
                          }
                          aria-expanded={expanded}
                          className="mt-1.5 text-left text-sm font-semibold text-slate-900 hover:text-blue-700 transition-colors"
                        >
                          {q.stem}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => void deleteQuestion(q.id)}
                        aria-label={`প্রশ্ন মুছুন: ${q.stem.slice(0, 30)}`}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700 shrink-0"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {expanded && (
                      <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                        {q.options.length > 0 && (
                          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 text-xs">
                            {q.options.map((opt, idx) => (
                              <li
                                key={idx}
                                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${
                                  idx === q.correctOptionIndex
                                    ? 'border-emerald-300 bg-emerald-50 font-semibold text-emerald-900'
                                    : 'border-slate-200 text-slate-700'
                                }`}
                              >
                                {idx === q.correctOptionIndex && (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                                )}
                                <span>
                                  {String.fromCharCode(65 + idx)}. {opt}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="text-xs text-slate-700 leading-relaxed">
                          <span className="font-semibold text-slate-900">
                            মডেল উত্তর:
                          </span>{' '}
                          {q.modelAnswer}
                        </div>
                        {q.explanation && (
                          <div className="text-xs text-slate-600 leading-relaxed">
                            <span className="font-semibold text-slate-800">
                              ব্যাখ্যা ও সূত্র:
                            </span>{' '}
                            {q.explanation} ({q.bookTitle}, পৃষ্ঠা {q.pageNumber})
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 3: PREVIOUS YEAR PATTERN ANALYSIS */}
      {activeTab === 'pyq' && (
        <section
          aria-label="বিগত বছরের প্রশ্ন প্যাটার্ন বিশ্লেষণ"
          className="rounded-xl border border-slate-200 bg-white overflow-hidden"
        >
          <div className="border-b border-slate-200 p-5">
            <div className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-blue-700" />
              <h2 className="text-base font-semibold text-slate-900">
                বিগত বছরের প্রশ্নের পুনরাবৃত্তি ও গুরুত্ব বিশ্লেষণ (PYQ Pattern Analysis)
              </h2>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              প্রশ্নব্যাংকে সংরক্ষিত বিগত BCS, Bank ও সরকারি চাকরির পরীক্ষার প্রশ্ন বিশ্লেষণ করে সর্বোচ্চ সম্ভাব্য অধ্যায়গুলো সাজানো হয়েছে।
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-5 py-3">অধ্যায় ও টপিক</th>
                  <th className="px-5 py-3">বিষয়</th>
                  <th className="px-5 py-3 text-right">পুনরাবৃত্তি</th>
                  <th className="px-5 py-3">বিগত সালসমূহ</th>
                  <th className="px-5 py-3 text-right">গুরুত্ব সূচক</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {pyqPatterns.map((p, idx) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-5 py-3.5 font-medium text-slate-900">
                      {p.chapter}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-600">
                      {p.subject}
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                      {p.frequency} বার
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-600">
                      {p.years.length > 0 ? p.years.join(', ') : '—'}
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono tabular-nums font-semibold text-blue-700">
                      {p.avgImportance}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
