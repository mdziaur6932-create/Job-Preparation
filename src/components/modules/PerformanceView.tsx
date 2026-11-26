'use client';

import React, { useMemo, useState } from 'react';
import {
  Send,
  Loader2,
  GraduationCap,
  Mic,
  ArrowUpRight,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { formatAiResponseError } from '@/src/lib/ai-client';
import { computePerformanceAnalytics } from '@/src/lib/exam-engine';
import { rankChunksHybrid } from '@/src/lib/rag-engine';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export function PerformanceView() {
  const {
    data,
    setSelectedAttemptId,
    setActiveModule,
    getAiAuthHeaders,
    requestAiSignIn,
  } = useWorkspace();

  const analytics = useMemo(
    () => computePerformanceAnalytics(data.attempts),
    [data.attempts]
  );

  // Phase 3 Personal AI Study Assistant & Viva Examiner
  const [assistantMode, setAssistantMode] = useState<'tutor' | 'viva'>('tutor');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text: 'আসসালামু আলাইকুম! আমি আপনার ব্যক্তিগত AI শিক্ষক ও ভাইভা বোর্ড পরীক্ষক। আপনার আপলোড করা বইগুলো থেকে যেকোনো প্রশ্ন করতে পারেন অথবা "ভাইভা প্র্যাকটিস" মোডে মৌখিক পরীক্ষা শুরু করতে পারেন।',
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const allChunks = useMemo(
    () => data.books.flatMap((b) => b.chunks),
    [data.books]
  );

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setChatError(null);

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn(
        assistantMode === 'viva' ? 'AI ভাইভা বোর্ড পরীক্ষক' : 'ব্যক্তিগত AI শিক্ষক'
      );
      return;
    }

    const nextHistory: ChatMessage[] = [
      ...messages,
      { role: 'user', text: trimmed },
    ];
    setMessages(nextHistory);
    setInput('');
    setSending(true);

    try {
      const relevantChunks = rankChunksHybrid(allChunks, trimmed, { topK: 4 });
      const res = await fetch('/api/ai/tutor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          mode: assistantMode,
          message: trimmed,
          history: messages,
          chunks: relevantChunks.map((c) => ({
            bookTitle: c.bookTitle,
            chapter: c.chapter,
            pageNumber: c.pageNumber,
            content: c.content,
          })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          requestAiSignIn(
            assistantMode === 'viva' ? 'AI ভাইভা বোর্ড পরীক্ষক' : 'ব্যক্তিগত AI শিক্ষক'
          );
        }
        throw new Error(
          formatAiResponseError(res.status, json, 'AI উত্তর দিতে পারেনি।')
        );
      }
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: json.reply || '' },
      ]);
    } catch (err) {
      setChatError(
        err instanceof Error ? err.message : 'সংযোগে সমস্যা হয়েছে।'
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="border-b border-slate-200 pb-5">
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
          08. Performance Analysis ও ব্যক্তিগত AI শিক্ষক
        </h1>
        <p className="mt-1.5 text-sm text-slate-600">
          পরীক্ষার ফলাফলের ইতিহাস, বিষয়ভিত্তিক অগ্রগতি, দুর্বল ও শক্তিশালী অধ্যায়, সময় ব্যবস্থাপনা এবং RAG-ভিত্তিক AI শিক্ষক ও ভাইভা প্রস্তুতি।
        </p>
      </div>

      {/* Executive KPI Strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5 rounded-xl border border-slate-200 bg-white divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">মোট পরীক্ষা</div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {analytics.totalExams}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">গড় নম্বর (%)</div>
          <div className="mt-1 font-mono text-2xl font-bold text-blue-700 tabular-nums">
            {analytics.averagePercentage}%
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">MCQ নির্ভুলতা</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {analytics.overallMcqAccuracy}%
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">লিখিত গড়</div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {analytics.overallWrittenAverage > 0
              ? `${analytics.overallWrittenAverage}%`
              : '—'}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium text-slate-500">
            প্রশ্নপ্রতি গড় সময়
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {analytics.avgSecondsPerQuestion} সে.
          </div>
        </div>
      </div>

      {/* Subject Breakdown + Weak vs Strong Chapters */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        <section className="lg:col-span-6 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">
              বিষয়ভিত্তিক দক্ষতা (Subject-wise Performance)
            </h2>
          </div>
          {analytics.subjectBreakdown.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              পরীক্ষা দিলে বিষয়ভিত্তিক বিশ্লেষণ এখানে দেখা যাবে।
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {analytics.subjectBreakdown.map((sub) => (
                <div key={sub.subject} className="p-4 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-900">
                      {sub.subject}
                    </span>
                    <span className="font-mono tabular-nums text-slate-600">
                      গড় {sub.avgScorePercent}% · MCQ {sub.mcqAccuracy}% ({sub.attempts} পরীক্ষা)
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full bg-blue-700"
                      style={{
                        width: `${Math.min(100, Math.max(4, sub.avgScorePercent))}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="lg:col-span-6 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">
              দুর্বল বনাম শক্তিশালী অধ্যায়
            </h2>
          </div>
          <div className="grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-y-0 sm:divide-x divide-slate-200">
            <div className="p-4 space-y-2.5">
              <div className="text-xs font-semibold text-red-700">
                দুর্বল অধ্যায় (অগ্রাধিকার রিভিশন)
              </div>
              {analytics.weakChapters.length === 0 ? (
                <p className="text-xs text-slate-500">কোনো দুর্বল অধ্যায় শনাক্ত হয়নি।</p>
              ) : (
                <ul className="space-y-2 text-xs">
                  {analytics.weakChapters.map((ch) => (
                    <li
                      key={`${ch.subject}-${ch.chapter}`}
                      className="flex items-start justify-between gap-2"
                    >
                      <span className="text-slate-700">{ch.chapter}</span>
                      <span className="font-mono tabular-nums font-semibold text-red-700 shrink-0">
                        {ch.accuracyPercent}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="p-4 space-y-2.5">
              <div className="text-xs font-semibold text-emerald-700">
                শক্তিশালী অধ্যায়
              </div>
              {analytics.strongChapters.length === 0 ? (
                <p className="text-xs text-slate-500">পর্যাপ্ত তথ্য এখনো নেই।</p>
              ) : (
                <ul className="space-y-2 text-xs">
                  {analytics.strongChapters.map((ch) => (
                    <li
                      key={`${ch.subject}-${ch.chapter}`}
                      className="flex items-start justify-between gap-2"
                    >
                      <span className="text-slate-700">{ch.chapter}</span>
                      <span className="font-mono tabular-nums font-semibold text-emerald-700 shrink-0">
                        {ch.accuracyPercent}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Exam History Table */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-900">
            পরীক্ষার ফলাফলের ইতিহাস (Exam History)
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
              <tr>
                <th className="px-5 py-3">পরীক্ষার নাম</th>
                <th className="px-5 py-3">বিষয়</th>
                <th className="px-5 py-3 text-right">প্রাপ্ত নম্বর</th>
                <th className="px-5 py-3 text-right">নেগেটিভ</th>
                <th className="px-5 py-3 text-right">MCQ নির্ভুলতা</th>
                <th className="px-5 py-3 text-right">বিস্তারিত</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.attempts.map((att) => (
                <tr key={att.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3.5 font-medium text-slate-900">
                    {att.examTitle}
                  </td>
                  <td className="px-5 py-3.5 text-xs text-slate-600">
                    {att.subject}
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                    {att.obtainedMarks}/{att.totalMarks}
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono tabular-nums text-red-700">
                    -{att.negativeDeduction}
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono tabular-nums text-emerald-700">
                    {att.mcqAccuracy}%
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedAttemptId(att.id);
                        setActiveModule('evaluation');
                      }}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900"
                    >
                      <span>মূল্যায়ন</span>
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Personal AI Study Assistant & Viva Examiner (Phase 3 Unified Architecture) */}
      <section
        aria-label="ব্যক্তিগত AI শিক্ষক ও ভাইভা পরীক্ষক"
        className="rounded-xl border border-slate-200 bg-white overflow-hidden"
      >
        <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              ব্যক্তিগত AI শিক্ষক ও ভাইভা বোর্ড (RAG Powered)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              আপনার আপলোড করা বইয়ের Knowledge Base ব্যবহার করে পড়াশোনার প্রশ্ন করুন অথবা বিসিএস/ব্যাংক ভাইভা অনুশীলন করুন।
            </p>
          </div>
          <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setAssistantMode('tutor')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                assistantMode === 'tutor'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <GraduationCap className="h-3.5 w-3.5" />
              <span>AI শিক্ষক</span>
            </button>
            <button
              type="button"
              onClick={() => setAssistantMode('viva')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                assistantMode === 'viva'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Mic className="h-3.5 w-3.5" />
              <span>ভাইভা বোর্ড</span>
            </button>
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto p-5 space-y-3 bg-slate-50/50">
          {messages.map((m, idx) => (
            <div
              key={idx}
              className={`max-w-3xl rounded-lg p-3.5 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'ml-auto bg-blue-700 text-white'
                  : 'border border-slate-200 bg-white text-slate-800'
              }`}
            >
              {m.text}
            </div>
          ))}
        </div>

        <form
          onSubmit={handleSendMessage}
          className="border-t border-slate-200 p-4 space-y-2"
        >
          {chatError && (
            <p role="alert" className="text-xs font-medium text-red-700">
              {chatError}
            </p>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              aria-label="AI শিক্ষকের জন্য প্রশ্ন বা ভাইভা উত্তর লিখুন"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                assistantMode === 'viva'
                  ? 'ভাইভা বোর্ড শুরু করতে "বিসিএস ভাইভা শুরু করুন" লিখুন বা প্রশ্নের উত্তর দিন...'
                  : 'যেকোনো টপিক জিজ্ঞাসা করুন (যেমন: অনুচ্ছেদ ৮১ ও ৮৭-এর পার্থক্য কী?)'
              }
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              <span>পাঠান</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
