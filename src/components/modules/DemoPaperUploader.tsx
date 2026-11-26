'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  FileText,
  Image as ImageIcon,
  Loader2,
  Sparkles,
  Trash2,
  AlertCircle,
  CheckCircle2,
  PieChart,
  RefreshCw,
} from 'lucide-react';
import {
  allocateQuestionsByPercentage,
  type DemoPaperAnalysis,
} from '@/src/lib/demo-paper-blueprint';
import {
  computeSubjectDistribution,
  summarizeWrittenBlueprint,
} from '@/src/lib/job-exam-paper';
import {
  prepareDemoPaperFiles,
  type PreparedDemoPaperFile,
} from '@/src/lib/demo-file-upload';
import {
  formatAiResponseError,
  isRateLimitErrorPayload,
} from '@/src/lib/ai-client';
import { toBengaliNumber } from '@/src/lib/file-validation';
import { useWorkspace } from '@/src/components/WorkspaceProvider';
import { analyzeDemoPaperTextLocally } from '@/src/lib/local-demo-paper-analyzer';
import { tryConvertBijoyPageText } from '@/src/lib/bijoy-to-unicode';
import { reconstructPdfPageTextFromTextItems } from '@/src/lib/exam-text-formatter';

const demoAiResultCache = new Map<string, DemoPaperAnalysis>();

function buildFilesCacheKey(files: PreparedDemoPaperFile[]): string {
  return files
    .map(
      (f) =>
        `${f.fileName}:${f.byteSize}:${f.base64.slice(0, 32)}:${f.base64.slice(-32)}`
    )
    .join('|');
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function extractDemoPdfPagesInBrowser(
  files: PreparedDemoPaperFile[]
): Promise<string[]> {
  const pdfFiles = files.filter((f) => f.fileType === 'pdf');
  if (pdfFiles.length === 0) return [];

  const { extractText, extractTextItems, getDocumentProxy } = await import(
    'unpdf'
  );
  const pages: string[] = [];

  for (const pdfFile of pdfFiles) {
    let proxy: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
    try {
      const bytes = base64ToUint8Array(pdfFile.base64);
      proxy = await getDocumentProxy(bytes);

      let rawPages: string[] = [];
      try {
        const positioned = await extractTextItems(proxy);
        if (Array.isArray(positioned.items) && positioned.items.length > 0) {
          rawPages = positioned.items.map((items) =>
            reconstructPdfPageTextFromTextItems(items)
          );
        }
      } catch {
        // Fall back to standard extractText
      }

      if (rawPages.length === 0) {
        const extracted = await extractText(proxy, { mergePages: false });
        if (Array.isArray(extracted.text)) {
          rawPages = extracted.text;
        }
      }

      for (const pageText of rawPages) {
        const converted = tryConvertBijoyPageText(pageText || '', false).text;
        if (converted.trim().length > 20) {
          pages.push(converted.trim());
        }
      }
    } catch {
      // Ignore corrupt/image-only PDF streams; caller will inform user clearly
    } finally {
      if (proxy) {
        try {
          const closable = proxy as unknown as {
            destroy?: () => Promise<void>;
            cleanup?: () => Promise<void>;
          };
          if (typeof closable.destroy === 'function') {
            await closable.destroy();
          } else if (typeof closable.cleanup === 'function') {
            await closable.cleanup();
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  return pages;
}

interface DemoPaperUploaderProps {
  /** Total questions per set currently selected by user (MCQ + Written) so we preview exact allocated counts */
  targetTotalQuestionsPerSet: number;
  analysis: DemoPaperAnalysis | null;
  onAnalysisChange: (analysis: DemoPaperAnalysis | null) => void;
  /** Optional callback invoked when AI finishes analyzing a demo file so parent can sync recommended format */
  onApplyDetectedFormat?: (analysis: DemoPaperAnalysis) => void;
  testIdPrefix?: string;
  compact?: boolean;
}

export function DemoPaperUploader({
  targetTotalQuestionsPerSet,
  analysis,
  onAnalysisChange,
  onApplyDetectedFormat,
  testIdPrefix = 'demo-paper',
  compact = false,
}: DemoPaperUploaderProps) {
  const { getAiAuthHeaders, requestAiSignIn } = useWorkspace();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preparedFiles, setPreparedFiles] = useState<PreparedDemoPaperFile[]>(
    []
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingLabel, setAnalyzingLabel] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isQuotaError, setIsQuotaError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Revoke object URLs on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      for (const f of preparedFiles) {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      }
    };
  }, [preparedFiles]);

  const allocations = useMemo(() => {
    if (!analysis || analysis.topicDistribution.length === 0) return [];
    return allocateQuestionsByPercentage(
      analysis.topicDistribution,
      Math.max(1, targetTotalQuestionsPerSet)
    );
  }, [analysis, targetTotalQuestionsPerSet]);

  const allocationByTopic = useMemo(
    () => new Map(allocations.map((a) => [a.topicLabel, a.targetCount])),
    [allocations]
  );

  const subjectDistribution = useMemo(() => {
    if (!analysis) return [];
    if (analysis.subjectDistribution && analysis.subjectDistribution.length > 0) {
      return analysis.subjectDistribution;
    }
    return computeSubjectDistribution(analysis.topicDistribution);
  }, [analysis]);

  const hasPdfFile = useMemo(
    () => preparedFiles.some((f) => f.fileType === 'pdf'),
    [preparedFiles]
  );

  const runLocalPdfAnalysis = async (
    filesToAnalyze: PreparedDemoPaperFile[]
  ) => {
    if (filesToAnalyze.length === 0) return;
    setAnalyzing(true);
    setAnalyzingLabel('০ API কোটায় PDF স্থানীয়ভাবে বিশ্লেষণ হচ্ছে...');
    setErrorMsg(null);
    setIsQuotaError(false);
    try {
      const pages = await extractDemoPdfPagesInBrowser(filesToAnalyze);
      const localResult = analyzeDemoPaperTextLocally(
        pages,
        filesToAnalyze[0].fileName
      );
      if (!localResult) {
        setErrorMsg(
          'এই PDF-এ সরাসরি পড়ার মতো টেক্সট লেয়ার পাওয়া যায়নি (সম্ভবত স্ক্যান করা ছবি PDF)। AI বিশ্লেষণ ব্যবহার করুন অথবা ডেমো ছাড়াই নিচের "সরাসরি বই থেকে (০ API)" মোডে প্রশ্ন তৈরি করুন।'
        );
        return;
      }
      onAnalysisChange(localResult);
      onApplyDetectedFormat?.(localResult);
    } catch {
      setErrorMsg('স্থানীয় PDF বিশ্লেষণে সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।');
    } finally {
      setAnalyzing(false);
      setAnalyzingLabel('');
    }
  };

  const runAnalysis = async (
    filesToAnalyze: PreparedDemoPaperFile[],
    forceRefresh = false
  ) => {
    if (filesToAnalyze.length === 0) return;

    const cacheKey = buildFilesCacheKey(filesToAnalyze);
    if (!forceRefresh && demoAiResultCache.has(cacheKey)) {
      const cached = demoAiResultCache.get(cacheKey)!;
      setErrorMsg(null);
      setIsQuotaError(false);
      onAnalysisChange(cached);
      onApplyDetectedFormat?.(cached);
      return;
    }

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('ডেমো প্রশ্নের ফটো বা PDF বিশ্লেষণ (AI)');
      setErrorMsg(
        'AI বিশ্লেষণ করতে উপরে "Google সাইন-ইন" করুন, অথবা PDF হলে "স্থানীয় বিশ্লেষণ (০ API)" ব্যবহার করুন।'
      );
      return;
    }

    setAnalyzing(true);
    setAnalyzingLabel('AI ডেমো প্রশ্নপত্র বিশ্লেষণ করছে...');
    setErrorMsg(null);
    setIsQuotaError(false);
    try {
      const res = await fetch('/api/ai/analyze-demo-paper', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          files: filesToAnalyze.map((f) => ({
            fileName: f.fileName,
            mimeType: f.mimeType,
            base64: f.base64,
          })),
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          requestAiSignIn('ডেমো প্রশ্নের ফটো বা PDF বিশ্লেষণ (AI)');
        }
        if (isRateLimitErrorPayload(res.status, json)) {
          setIsQuotaError(true);
        }
        throw new Error(
          formatAiResponseError(
            res.status,
            json,
            'ডেমো প্রশ্নপত্র বিশ্লেষণ করা যায়নি।'
          )
        );
      }

      if (json.analysis) {
        const result = json.analysis as DemoPaperAnalysis;
        demoAiResultCache.set(cacheKey, result);
        onAnalysisChange(result);
        onApplyDetectedFormat?.(result);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'ডেমো প্রশ্নপত্র বিশ্লেষণে সমস্যা হয়েছে।'
      );
    } finally {
      setAnalyzing(false);
      setAnalyzingLabel('');
    }
  };

  const handleFilesSelected = async (rawFiles: FileList | File[] | null) => {
    if (!rawFiles || rawFiles.length === 0) return;
    setErrorMsg(null);
    setIsQuotaError(false);
    try {
      // Clean up old previews
      for (const f of preparedFiles) {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      }
      const filesArr = Array.from(rawFiles);
      const ready = await prepareDemoPaperFiles(filesArr);
      setPreparedFiles(ready);
      await runAnalysis(ready);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'ফাইলটি প্রস্তুত করা যায়নি।'
      );
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleClear = () => {
    for (const f of preparedFiles) {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    }
    setPreparedFiles([]);
    setErrorMsg(null);
    setIsQuotaError(false);
    onAnalysisChange(null);
  };

  const handleRemoveTopic = (topicLabel: string) => {
    if (!analysis) return;
    const remaining = analysis.topicDistribution.filter(
      (t) => t.topicLabel !== topicLabel
    );
    if (remaining.length === 0) {
      onAnalysisChange(null);
      return;
    }
    const sum = remaining.reduce((s, t) => s + t.percentage, 0);
    const rebalanced = remaining.map((t, idx) => {
      if (idx === remaining.length - 1) {
        const prevSum = remaining
          .slice(0, -1)
          .reduce(
            (acc, item) =>
              acc + (sum > 0 ? Math.round((item.percentage / sum) * 100) : 0),
            0
          );
        return { ...t, percentage: Math.max(1, 100 - prevSum) };
      }
      return {
        ...t,
        percentage: sum > 0 ? Math.max(1, Math.round((t.percentage / sum) * 100)) : Math.round(100 / remaining.length),
      };
    });
    onAnalysisChange({
      ...analysis,
      topicDistribution: rebalanced,
    });
  };

  return (
    <div
      data-testid={`${testIdPrefix}-uploader`}
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
            <PieChart className="h-3.5 w-3.5 text-blue-700" />
            <span>ডেমো প্রশ্নের ফটো বা PDF আপলোড করুন (ঐচ্ছিক — টপিক ও % বিশ্লেষণ)</span>
          </span>
          <p className="mt-0.5 text-[11px] text-slate-600">
            যেকোনো চাকরির পরীক্ষার প্রশ্নের ফটো বা PDF দিন—কোন টপিক থেকে কত শতাংশ (%) প্রশ্ন এসেছে তা বিশ্লেষণ করে ঠিক সেই অনুপাতে নতুন প্রশ্ন তৈরি হবে।
          </p>
        </div>

        {(preparedFiles.length > 0 || analysis) && (
          <div className="flex flex-wrap items-center gap-2">
            {hasPdfFile && !analyzing && (
              <button
                type="button"
                data-testid={`${testIdPrefix}-local-analyze-btn`}
                onClick={() => void runLocalPdfAnalysis(preparedFiles)}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                <FileText className="h-3 w-3" />
                <span>স্থানীয় বিশ্লেষণ (০ API)</span>
              </button>
            )}
            {preparedFiles.length > 0 && !analyzing && (
              <button
                type="button"
                onClick={() => void runAnalysis(preparedFiles, true)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
              >
                <RefreshCw className="h-3 w-3" />
                <span>পুনরায় বিশ্লেষণ</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleClear}
              data-testid={`${testIdPrefix}-clear-btn`}
              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50"
            >
              <Trash2 className="h-3 w-3" />
              <span>মুছুন</span>
            </button>
          </div>
        )}
      </div>

      {/* Upload Dropzone */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,application/pdf,.pdf,.jpg,.jpeg,.png,.webp"
        data-testid={`${testIdPrefix}-file-input`}
        onChange={(e) => void handleFilesSelected(e.target.files)}
        className="sr-only"
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          void handleFilesSelected(e.dataTransfer.files);
        }}
        className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
          isDragging
            ? 'border-blue-500 bg-blue-50/70'
            : 'border-slate-300 bg-white hover:border-blue-400'
        }`}
      >
        <div
          className={
            compact
              ? 'flex flex-col items-stretch gap-3 text-left'
              : 'flex flex-col items-center gap-2 sm:flex-row sm:justify-between sm:text-left'
          }
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-blue-100 bg-blue-50 text-blue-700">
              {analyzing ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Upload className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-900 leading-snug">
                {analyzing
                  ? analyzingLabel || 'ডেমো প্রশ্নপত্র বিশ্লেষণ হচ্ছে...'
                  : preparedFiles.length > 0
                    ? `${toBengaliNumber(preparedFiles.length)}টি ডেমো ফাইল যুক্ত আছে`
                    : 'ডেমো প্রশ্নের ফটো (JPG/PNG) অথবা PDF আপলোড করুন'}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 leading-relaxed">
                সর্বোচ্চ ৬টি ফটো অথবা ১০ MB পর্যন্ত PDF ফাইল ড্র্যাগ করে ছাড়ুন বা সিলেক্ট করুন
              </div>
            </div>
          </div>

          <button
            type="button"
            disabled={analyzing}
            data-testid={`${testIdPrefix}-upload-btn`}
            onClick={() => fileInputRef.current?.click()}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-50 transition-colors shrink-0 ${
              compact ? 'w-full' : ''
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            <span>
              {preparedFiles.length > 0 ? 'নতুন ফাইল দিন' : 'ফটো / PDF নির্বাচন করুন'}
            </span>
          </button>
        </div>

        {/* Selected File Previews */}
        {preparedFiles.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-left">
            {preparedFiles.map((f, idx) => (
              <div
                key={`${f.fileName}-${idx}`}
                className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-700"
              >
                {f.fileType === 'pdf' ? (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-red-600" />
                ) : (
                  <ImageIcon className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                )}
                <span className="max-w-[180px] truncate font-medium">
                  {f.fileName}
                </span>
                <span className="font-mono text-[10px] text-slate-400">
                  {(f.byteSize / 1024).toFixed(0)} KB
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          {isQuotaError && hasPdfFile && !analyzing && (
            <button
              type="button"
              data-testid={`${testIdPrefix}-quota-local-fallback-btn`}
              onClick={() => void runLocalPdfAnalysis(preparedFiles)}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-50 transition-colors"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>০ API কোটায় PDF স্থানীয়ভাবে বিশ্লেষণ করুন</span>
            </button>
          )}
        </div>
      )}

      {/* Analyzed Topic Weightage (%) Blueprint */}
      {analysis && (
        <div
          data-testid={`${testIdPrefix}-analysis-result`}
          className="rounded-lg border border-blue-200 bg-white p-3.5 space-y-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-2.5">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                <span>ডেমো প্রশ্নপত্র বিশ্লেষণ সম্পন্ন: {analysis.examTitleDetected}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-600">
                {analysis.summaryNote}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums text-slate-600">
              <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5">
                মোট শনাক্ত: {toBengaliNumber(analysis.totalQuestionsDetected)}টি
              </span>
              {analysis.mcqCountDetected > 0 && (
                <span className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-blue-800">
                  MCQ: {toBengaliNumber(analysis.mcqCountDetected)}
                </span>
              )}
              {analysis.writtenCountDetected > 0 && (
                <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800">
                  Written: {toBengaliNumber(analysis.writtenCountDetected)}
                </span>
              )}
              {analysis.totalMarksDetected && (
                <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-800">
                  পূর্ণমান: {toBengaliNumber(analysis.totalMarksDetected)}
                </span>
              )}
              {analysis.durationMinutesDetected && (
                <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                  সময়: {toBengaliNumber(analysis.durationMinutesDetected)} মি.
                </span>
              )}
            </div>
          </div>

          {(analysis.organizationDetected || analysis.postNameDetected) && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-700">
              {analysis.organizationDetected && (
                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium">
                  প্রতিষ্ঠান: {analysis.organizationDetected}
                </span>
              )}
              {analysis.postNameDetected && (
                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium">
                  পদ: {analysis.postNameDetected}
                </span>
              )}
            </div>
          )}

          {/* Level 1: Subject-level Percentage Breakdown (e.g., Bangla 25%, English 25%, GK 25%, Math 25%) */}
          {subjectDistribution.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-slate-200/80 bg-slate-50/70 p-2.5">
              <div className="text-[11px] font-semibold text-slate-800">
                বিষয়ভিত্তিক শতকরা (%) বণ্টন
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {subjectDistribution.map((sub) => (
                  <div
                    key={sub.subjectGroup}
                    className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
                  >
                    <div className="truncate text-[10.5px] font-medium text-slate-600">
                      {sub.subjectGroup}
                    </div>
                    <div className="mt-0.5 font-mono text-xs font-bold text-blue-700 tabular-nums">
                      {toBengaliNumber(sub.percentage)}%
                      {sub.questionCountInDemo > 0 && (
                        <span className="ml-1 text-[10px] font-normal text-slate-500">
                          ({toBengaliNumber(sub.questionCountInDemo)}টি)
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Written Blueprint Detected Preview */}
          {analysis.writtenSections && analysis.writtenSections.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50/50 p-2.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-amber-950">
                <span>শনাক্তকৃত লিখিত সেকশন ও উপ-প্রশ্ন কাঠামো</span>
                <span className="font-mono tabular-nums">
                  {toBengaliNumber(
                    summarizeWrittenBlueprint(analysis.writtenSections).totalQuestions
                  )}
                  টি প্রশ্ন ·{' '}
                  {toBengaliNumber(
                    summarizeWrittenBlueprint(analysis.writtenSections).totalMarks
                  )}{' '}
                  নম্বর
                </span>
              </div>
              <div className="space-y-1">
                {analysis.writtenSections.map((sec) => (
                  <div
                    key={sec.id}
                    className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-700"
                  >
                    <span className="font-medium text-slate-900">
                      • {sec.subjectGroup}: {sec.title}
                    </span>
                    <span className="font-mono text-[10.5px] text-slate-600">
                      {toBengaliNumber(sec.questionCount)}টি ×{' '}
                      {toBengaliNumber(sec.marksPerQuestion)} নম্বর
                      {sec.subQuestionsPerItem >= 2
                        ? sec.isChoiceOne
                          ? ` (${toBengaliNumber(sec.subQuestionsPerItem)}টির মধ্যে ১টি)`
                          : ` (${toBengaliNumber(sec.subQuestionsPerItem)} উপ-প্রশ্ন)`
                        : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] font-semibold text-slate-700">
              <span>টপিকভিত্তিক শতকরা (%) প্রাধান্য</span>
              <span className="font-mono text-blue-700">
                প্রতি সেটে মোট {toBengaliNumber(Math.max(1, targetTotalQuestionsPerSet))}টি প্রশ্নের বণ্টন
              </span>
            </div>

            <div className="space-y-2">
              {analysis.topicDistribution.map((topic) => {
                const allocated = allocationByTopic.get(topic.topicLabel) ?? 0;
                return (
                  <div
                    key={topic.topicLabel}
                    className="rounded-md border border-slate-200/80 bg-slate-50/70 p-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-semibold text-slate-900 truncate">
                          {topic.topicLabel}
                        </span>
                        <span className="text-[10px] text-slate-500">
                          ({topic.subjectGroup})
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 font-mono text-[11px] tabular-nums">
                        <span className="font-bold text-blue-700">
                          {toBengaliNumber(topic.percentage)}%
                        </span>
                        <span className="text-slate-400">→</span>
                        <span className="font-semibold text-emerald-700">
                          {toBengaliNumber(allocated)}টি প্রশ্ন
                        </span>
                        {analysis.topicDistribution.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveTopic(topic.topicLabel)}
                            title="এই টপিক বাদ দিন"
                            className="text-slate-400 hover:text-red-600"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="h-full rounded-full bg-blue-600 transition-all"
                        style={{
                          width: `${Math.min(100, Math.max(3, topic.percentage))}%`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="flex items-center gap-1.5 text-[11px] text-blue-800 pt-1">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span>
                প্রশ্ন তৈরির সময় AI নির্বাচিত বইগুলো থেকে ঠিক এই টপিক ও শতকরা (%) অনুপাতে প্রতিটি সেট তৈরি করবে।
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
