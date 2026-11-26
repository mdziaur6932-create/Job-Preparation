'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  ImagePlus,
  Loader2,
  Newspaper,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { formatAiResponseError } from '@/src/lib/ai-client';
import { formatFileSize, toBengaliNumber } from '@/src/lib/file-validation';
import {
  type DriveFolderFileItem,
  PAPER_CUTTING_DRIVE_FOLDER_URL,
  downloadGoogleDriveFile,
  extractGoogleDriveFolderId,
  listGoogleDriveFolderFiles,
} from '@/src/lib/google-drive';
import { prepareImageForPaperCuttingApi } from '@/src/lib/image-upload-utils';
import {
  type PaperCuttingAnalysisResult,
  buildShortQuestionsFromPaperCutting,
  extractImportedPaperCuttingDriveIds,
  formatPaperCuttingClipboardText,
  formatPaperCuttingForBookChunk,
  parsePaperCuttingFromGkItem,
  serializePaperCuttingToGkInput,
} from '@/src/lib/paper-cutting-parser';
import type { CurrentGkItem } from '@/src/types/system';

interface PaperCuttingPanelProps {
  items: CurrentGkItem[];
  categoryFilter: string;
}

export function PaperCuttingPanel({
  items,
  categoryFilter,
}: PaperCuttingPanelProps) {
  const {
    data,
    addGkItem,
    addBook,
    addQuestions,
    markGkConverted,
    toggleGkArchive,
    deleteGkItem,
    getAiAuthHeaders,
    requestAiSignIn,
    driveConnected,
    getDriveAccessToken,
    clearDriveSession,
    connectGoogleDrive,
  } = useWorkspace();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlsRef = useRef<string[]>([]);

  // Local upload state
  const [newspaperHint, setNewspaperHint] = useState('');
  const [eventDateHint, setEventDateHint] = useState(
    () => new Date().toISOString().slice(0, 10)
  );
  const [alsoSaveToLibrary, setAlsoSaveToLibrary] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionThumbnails, setSessionThumbnails] = useState<
    Record<string, string>
  >({});
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [addingToBankId, setAddingToBankId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Google Drive Paper Cutting folder state
  const [driveFolderInput, setDriveFolderInput] = useState(
    PAPER_CUTTING_DRIVE_FOLDER_URL
  );
  const [loadingDrivePhotos, setLoadingDrivePhotos] = useState(false);
  const [drivePhotosLoadedOnce, setDrivePhotosLoadedOnce] = useState(false);
  const [drivePhotoFiles, setDrivePhotoFiles] = useState<DriveFolderFileItem[]>(
    []
  );
  const [selectedDriveIds, setSelectedDriveIds] = useState<string[]>([]);
  const [driveError, setDriveError] = useState<string | null>(null);

  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      for (const u of urls) {
        URL.revokeObjectURL(u);
      }
    };
  }, []);

  const importedDriveIds = useMemo(
    () => extractImportedPaperCuttingDriveIds(data.gkItems, data.books),
    [data.gkItems, data.books]
  );

  const visibleItems = useMemo(() => {
    return items.filter((item) => {
      if (categoryFilter !== 'সব' && item.category !== categoryFilter) {
        return false;
      }
      return true;
    });
  }, [items, categoryFilter]);

  const unimportedDrivePhotoIds = useMemo(
    () =>
      drivePhotoFiles
        .filter((f) => !importedDriveIds.has(f.id))
        .map((f) => f.id),
    [drivePhotoFiles, importedDriveIds]
  );

  const analyzeAndStoreSinglePhoto = async (params: {
    file: File;
    authHeaders: Record<string, string>;
    driveFile?: DriveFolderFileItem | null;
  }): Promise<{
    analysis: PaperCuttingAnalysisResult;
  }> => {
    const prepared = await prepareImageForPaperCuttingApi(params.file);
    previewUrlsRef.current.push(prepared.previewUrl);

    const res = await fetch('/api/ai/paper-cutting', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...params.authHeaders,
      },
      body: JSON.stringify({
        imageBase64: prepared.imageBase64,
        mimeType: prepared.mimeType,
        fileName: prepared.fileName,
        newspaperHint: newspaperHint.trim(),
        eventDateHint: eventDateHint.trim(),
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        requestAiSignIn('পেপার কাটিং থেকে AI ছোট প্রশ্ন তৈরি');
      }
      throw new Error(
        formatAiResponseError(
          res.status,
          json,
          `"${params.file.name}" বিশ্লেষণ করা যায়নি।`
        )
      );
    }

    const analysis = json.analysis as PaperCuttingAnalysisResult;
    const gkPayload = serializePaperCuttingToGkInput(analysis, {
      fileName: params.file.name,
      driveFileId: params.driveFile?.id ?? null,
      driveWebViewLink: params.driveFile?.webViewLink ?? null,
    });

    await addGkItem(gkPayload);
    setSessionThumbnails((prev) => ({
      ...prev,
      [gkPayload.title]: prepared.previewUrl,
    }));

    if (alsoSaveToLibrary) {
      const chunkText = formatPaperCuttingForBookChunk(analysis, {
        fileName: params.file.name,
        driveFileId: params.driveFile?.id ?? null,
      });
      await addBook({
        title: `পেপার কাটিং — ${analysis.headline}`,
        author: analysis.newspaperSource || 'সংবাদপত্র কাটিং',
        subject: 'সাম্প্রতিক সাধারণ জ্ঞান',
        category: 'Current GK',
        totalPages: 1,
        extractionMethod: 'ocr',
        ocrCompleted: true,
        driveFileId: params.driveFile?.id ?? null,
        driveWebViewLink: params.driveFile?.webViewLink ?? null,
        driveFileName: params.driveFile?.name ?? params.file.name,
        chunks: [
          {
            chapter: `${analysis.category} · ${analysis.eventDate}`,
            pageNumber: 1,
            chunkIndex: 0,
            content: chunkText,
          },
        ],
      });
    }

    return { analysis };
  };

  const handleUploadFiles = async (files: File[]) => {
    if (files.length === 0 || processingStatus) return;
    setErrorMessage(null);
    setStatusNotice(null);

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('পেপার কাটিং ছবি থেকে AI ছোট প্রশ্ন তৈরি');
      return;
    }

    let successCount = 0;
    let totalQaCount = 0;
    const failedNames: string[] = [];

    try {
      for (let idx = 0; idx < files.length; idx += 1) {
        const file = files[idx];
        setProcessingStatus(
          `AI পেপার কাটিং পড়ছে (${toBengaliNumber(idx + 1)}/${toBengaliNumber(files.length)}): ${file.name}...`
        );
        try {
          const { analysis } = await analyzeAndStoreSinglePhoto({
            file,
            authHeaders,
          });
          successCount += 1;
          totalQaCount += analysis.shortQAs.length;
        } catch (err) {
          failedNames.push(
            `${file.name} (${err instanceof Error ? err.message : 'ত্রুটি'})`
          );
        }
      }

      if (successCount > 0) {
        setStatusNotice(
          `${toBengaliNumber(successCount)}টি পেপার কাটিং ছবি থেকে মোট ${toBengaliNumber(totalQaCount)}টি গুরুত্বপূর্ণ ছোট প্রশ্ন ও উত্তর তৈরি করে সংরক্ষণ করা হয়েছে।`
        );
      }
      if (failedNames.length > 0) {
        setErrorMessage(`কিছু ছবি প্রসেস হয়নি: ${failedNames.join(' | ')}`);
      }
    } finally {
      setProcessingStatus(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleLoadDrivePhotos = async () => {
    if (loadingDrivePhotos) return;
    setDriveError(null);
    setStatusNotice(null);

    const folderId = extractGoogleDriveFolderId(driveFolderInput);
    if (!folderId) {
      setDriveError(
        'সঠিক Google Drive ফোল্ডার লিংক বা আইডি দিন (যেমন: https://drive.google.com/drive/folders/...)'
      );
      return;
    }

    setLoadingDrivePhotos(true);
    try {
      let token = getDriveAccessToken();
      if (!token) {
        token = await connectGoogleDrive();
      }
      if (!token) {
        setDriveError(
          'Google Drive সংযুক্ত না থাকায় ফোল্ডারের ফটোগুলো লোড করা যায়নি। আগে Google Drive অনুমোদন দিন।'
        );
        return;
      }

      const listed = await listGoogleDriveFolderFiles({
        accessToken: token,
        folderId,
      });

      if (!listed.ok) {
        if (listed.code === 'unauthorized') {
          clearDriveSession();
        }
        setDriveError(listed.error);
        return;
      }

      const imageOnly = listed.files.filter((f) => f.kindLabel === 'Image');
      setDrivePhotoFiles(imageOnly);
      setDrivePhotosLoadedOnce(true);
      setSelectedDriveIds(
        imageOnly.filter((f) => !importedDriveIds.has(f.id)).map((f) => f.id)
      );
    } finally {
      setLoadingDrivePhotos(false);
    }
  };

  const handleAnalyzeSelectedDrivePhotos = async (
    targetFiles?: DriveFolderFileItem[]
  ) => {
    const queue =
      targetFiles ??
      drivePhotoFiles.filter((f) => selectedDriveIds.includes(f.id));
    if (queue.length === 0 || processingStatus) return;

    setDriveError(null);
    setErrorMessage(null);
    setStatusNotice(null);

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('Google Drive পেপার কাটিং থেকে AI ছোট প্রশ্ন তৈরি');
      return;
    }

    let token = getDriveAccessToken();
    if (!token) {
      token = await connectGoogleDrive();
    }
    if (!token) {
      setDriveError(
        'Google Drive সংযুক্ত না থাকায় ফটো ডাউনলোড করা যায়নি। পুনরায় Google Drive সংযুক্ত করুন।'
      );
      return;
    }

    let successCount = 0;
    let totalQaCount = 0;
    const failedNotes: string[] = [];

    try {
      for (let i = 0; i < queue.length; i += 1) {
        const df = queue[i];
        setProcessingStatus(
          `Drive থেকে ছবি নামিয়ে AI বিশ্লেষণ করছে (${toBengaliNumber(i + 1)}/${toBengaliNumber(queue.length)}): ${df.name}...`
        );
        const dl = await downloadGoogleDriveFile({
          accessToken: token,
          file: df,
        });
        if (!dl.ok) {
          if (dl.code === 'unauthorized') {
            clearDriveSession();
            failedNotes.push(`${df.name} (Drive সেশন শেষ হয়েছে)`);
            break;
          }
          failedNotes.push(`${df.name} (${dl.error})`);
          continue;
        }

        try {
          const { analysis } = await analyzeAndStoreSinglePhoto({
            file: dl.file,
            authHeaders,
            driveFile: df,
          });
          successCount += 1;
          totalQaCount += analysis.shortQAs.length;
          setSelectedDriveIds((prev) => prev.filter((id) => id !== df.id));
        } catch (err) {
          failedNotes.push(
            `${df.name} (${err instanceof Error ? err.message : 'বিশ্লেষণ ব্যর্থ'})`
          );
        }
      }

      if (successCount > 0) {
        setStatusNotice(
          `Google Drive ফোল্ডারের ${toBengaliNumber(successCount)}টি পেপার কাটিং ফটো থেকে মোট ${toBengaliNumber(totalQaCount)}টি ছোট প্রশ্ন ও উত্তর সংরক্ষণ করা হয়েছে।`
        );
      }
      if (failedNotes.length > 0) {
        setDriveError(`কিছু ছবি প্রসেস হয়নি: ${failedNotes.join(' | ')}`);
      }
    } finally {
      setProcessingStatus(null);
    }
  };

  const handleAddShortQAsToBank = async (item: CurrentGkItem) => {
    setErrorMessage(null);
    setStatusNotice(null);
    const shortQuestions = buildShortQuestionsFromPaperCutting(item);
    if (shortQuestions.length === 0) {
      setErrorMessage('এই পেপার কাটিংয়ে সংরক্ষিত কোনো ছোট প্রশ্ন পাওয়া যায়নি।');
      return;
    }
    setAddingToBankId(item.id);
    try {
      await addQuestions(shortQuestions);
      await markGkConverted(item.id);
      setStatusNotice(
        `"${item.title}" থেকে ${toBengaliNumber(shortQuestions.length)}টি ছোট প্রশ্ন সরাসরি Question Bank-এ যুক্ত হয়েছে।`
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'প্রশ্নব্যাংকে যুক্ত করতে সমস্যা হয়েছে।'
      );
    } finally {
      setAddingToBankId(null);
    }
  };

  const handleCopyItem = async (item: CurrentGkItem) => {
    const text = formatPaperCuttingClipboardText(item);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(item.id);
      window.setTimeout(() => {
        setCopiedId((curr) => (curr === item.id ? null : curr));
      }, 2000);
    } catch {
      setErrorMessage('ক্লিপবোর্ডে কপি করা যায়নি।');
    }
  };

  const toggleDriveSelection = (fileId: string) => {
    setSelectedDriveIds((prev) =>
      prev.includes(fileId)
        ? prev.filter((id) => id !== fileId)
        : [...prev, fileId]
    );
  };

  return (
    <div data-testid="paper-cutting-panel" className="space-y-6">
      {/* Dual Intake Bar: Device Photo Upload + Dedicated Google Drive Folder */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Direct Photo Upload Card */}
        <section
          aria-label="পত্রিকার কাটিং ছবি আপলোড"
          className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5 space-y-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                <Newspaper className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  পেপার কাটিং ফটো আপলোড করুন (AI ছোট প্রশ্ন তৈরি)
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">
                  যেকোনো সংবাদপত্রের গুরুত্বপূর্ণ অংশের এক বা একাধিক ফটো দিন—AI গুরুত্বপূর্ণ তথ্য পড়ে পরীক্ষার উপযোগী ছোট প্রশ্ন ও উত্তর তৈরি করে রাখবে।
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="pc-newspaper-hint"
                className="block text-[11px] font-semibold text-slate-700"
              >
                পত্রিকার নাম (ঐচ্ছিক)
              </label>
              <input
                id="pc-newspaper-hint"
                type="text"
                value={newspaperHint}
                onChange={(e) => setNewspaperHint(e.target.value)}
                placeholder="যেমন: প্রথম আলো / বণিক বার্তা / The Daily Star"
                disabled={Boolean(processingStatus)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="pc-date-hint"
                className="block text-[11px] font-semibold text-slate-700"
              >
                পত্রিকার তারিখ (ঐচ্ছিক)
              </label>
              <input
                id="pc-date-hint"
                type="date"
                value={eventDateHint}
                onChange={(e) => setEventDateHint(e.target.value)}
                disabled={Boolean(processingStatus)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>

          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!processingStatus) setIsDragActive(true);
            }}
            onDragLeave={() => setIsDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragActive(false);
              if (processingStatus) return;
              const dropped = Array.from(e.dataTransfer.files || []);
              if (dropped.length > 0) {
                void handleUploadFiles(dropped);
              }
            }}
            className={`rounded-xl border-2 border-dashed p-5 transition-colors ${
              isDragActive
                ? 'border-blue-600 bg-blue-50/70'
                : 'border-slate-300 bg-slate-50/70'
            }`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white border border-slate-200 text-blue-700">
                  <ImagePlus className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-900">
                    পেপার কাটিং ফটো এখানে ড্রপ করুন অথবা বাছাই করুন
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    JPG, PNG বা WebP · একসাথে একাধিক ফটো আপলোড করা যাবে
                  </p>
                </div>
              </div>

              <button
                type="button"
                data-testid="paper-cutting-upload-btn"
                disabled={Boolean(processingStatus)}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {processingStatus ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                <span>ফটো আপলোড ও AI বিশ্লেষণ</span>
              </button>

              <input
                ref={fileInputRef}
                id="paper-cutting-file-input"
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                multiple
                disabled={Boolean(processingStatus)}
                onChange={(e) => {
                  const list = Array.from(e.target.files || []);
                  if (list.length > 0) {
                    void handleUploadFiles(list);
                  }
                }}
                className="sr-only"
              />
            </div>
          </div>

          <label
            htmlFor="pc-also-save-library"
            className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none"
          >
            <input
              id="pc-also-save-library"
              type="checkbox"
              checked={alsoSaveToLibrary}
              onChange={(e) => setAlsoSaveToLibrary(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
            />
            <span>
              একই সাথে Book Library-তেও (Current GK ক্যাটাগরিতে) সংরক্ষণ করুন
            </span>
          </label>
        </section>

        {/* Dedicated Google Drive Paper Cutting Folder Panel */}
        <section
          aria-label="Google Drive পেপার কাটিং ফোল্ডার"
          data-testid="paper-cutting-drive-section"
          className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-3.5 flex flex-col justify-between"
        >
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2.5">
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    driveConnected
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  <HardDrive className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    Google Drive পেপার কাটিং ফোল্ডার
                  </h2>
                  <p className="mt-0.5 text-[11px] text-slate-500 leading-relaxed">
                    নির্ধারিত Drive ফোল্ডারে আগে থেকে রাখা ফটোগুলো এক ক্লিকে লোড করে AI দিয়ে ছোট প্রশ্ন তৈরি করুন।
                  </p>
                </div>
              </div>
              <a
                href={PAPER_CUTTING_DRIVE_FOLDER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline whitespace-nowrap shrink-0"
              >
                <span>ফোল্ডার খুলুন</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <div>
              <label
                htmlFor="pc-drive-folder-url"
                className="block text-[11px] font-semibold text-slate-700"
              >
                Drive ফোল্ডার লিংক বা আইডি
              </label>
              <input
                id="pc-drive-folder-url"
                data-testid="paper-cutting-drive-url-input"
                type="text"
                value={driveFolderInput}
                onChange={(e) => setDriveFolderInput(e.target.value)}
                placeholder={PAPER_CUTTING_DRIVE_FOLDER_URL}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50/70 px-3 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="paper-cutting-load-drive-btn"
                disabled={loadingDrivePhotos || Boolean(processingStatus)}
                onClick={() => void handleLoadDrivePhotos()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {loadingDrivePhotos ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : drivePhotosLoadedOnce ? (
                  <RefreshCw className="h-3.5 w-3.5" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5" />
                )}
                <span>
                  {loadingDrivePhotos
                    ? 'লোড হচ্ছে...'
                    : drivePhotosLoadedOnce
                      ? 'ফটোর তালিকা রিফ্রেশ করুন'
                      : 'Drive ফোল্ডারের ফটো দেখুন'}
                </span>
              </button>

              {drivePhotoFiles.length > 0 && (
                <button
                  type="button"
                  disabled={
                    selectedDriveIds.length === 0 || Boolean(processingStatus)
                  }
                  onClick={() => void handleAnalyzeSelectedDrivePhotos()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>
                    নির্বাচিত ({toBengaliNumber(selectedDriveIds.length)}) থেকে ছোট প্রশ্ন
                  </span>
                </button>
              )}
            </div>

            {driveError && (
              <p
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
              >
                {driveError}
              </p>
            )}
          </div>

          {/* Listed Drive Photos */}
          {drivePhotosLoadedOnce && drivePhotoFiles.length === 0 && (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600 text-center">
              এই Drive ফোল্ডারে কোনো JPG, PNG বা WebP ছবি পাওয়া যায়নি।
            </p>
          )}

          {drivePhotoFiles.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] text-slate-600">
                <span>
                  মোট {toBengaliNumber(drivePhotoFiles.length)}টি ছবি পাওয়া গেছে
                </span>
                {unimportedDrivePhotoIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedDriveIds(
                        selectedDriveIds.length === unimportedDrivePhotoIds.length
                          ? []
                          : unimportedDrivePhotoIds
                      )
                    }
                    className="font-semibold text-blue-700 hover:underline"
                  >
                    {selectedDriveIds.length === unimportedDrivePhotoIds.length
                      ? 'নির্বাচন বাতিল'
                      : `সব নতুন ছবি নির্বাচন (${toBengaliNumber(unimportedDrivePhotoIds.length)})`}
                  </button>
                )}
              </div>

              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-200">
                {drivePhotoFiles.map((df) => {
                  const alreadyImported = importedDriveIds.has(df.id);
                  const checked = selectedDriveIds.includes(df.id);
                  return (
                    <div
                      key={df.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <label className="flex items-center gap-2 min-w-0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={alreadyImported || Boolean(processingStatus)}
                          onChange={() => toggleDriveSelection(df.id)}
                          className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                        />
                        <span className="font-medium text-slate-900 truncate">
                          {df.name}
                        </span>
                        {df.size > 0 && (
                          <span className="font-mono text-[10px] text-slate-500 shrink-0">
                            {formatFileSize(df.size)}
                          </span>
                        )}
                      </label>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {alreadyImported ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>যুক্ত আছে</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={Boolean(processingStatus)}
                            onClick={() =>
                              void handleAnalyzeSelectedDrivePhotos([df])
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                          >
                            <Download className="h-3 w-3" />
                            <span>বিশ্লেষণ</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Live Progress / Status / Error Banners */}
      {processingStatus && (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs font-semibold text-blue-900"
        >
          <Loader2 className="h-4 w-4 animate-spin text-blue-700 shrink-0" />
          <span>{processingStatus}</span>
        </div>
      )}

      {statusNotice && (
        <div
          role="status"
          data-testid="paper-cutting-status-notice"
          className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-900"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
            <span>{statusNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            aria-label="বার্তা বন্ধ করুন"
            className="rounded p-0.5 text-emerald-700 hover:bg-emerald-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800"
        >
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="ত্রুটির বার্তা বন্ধ করুন"
            className="rounded p-0.5 text-red-700 hover:bg-red-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Saved Paper Cutting Cards */}
      {visibleItems.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
          <Newspaper className="mx-auto h-7 w-7 text-slate-400" />
          <p className="mt-2 text-sm font-medium text-slate-700">
            এখনো কোনো পেপার কাটিং যুক্ত করা হয়নি।
          </p>
          <p className="mt-1 text-xs text-slate-500">
            উপরের ফটো আপলোড বক্সে পত্রিকার ছবি দিন অথবা Google Drive ফোল্ডার থেকে ফটো ইমপোর্ট করুন—AI স্বয়ংক্রিয়ভাবে গুরুত্বপূর্ণ তথ্যগুলো ছোট প্রশ্ন ও উত্তর আকারে সাজিয়ে দেবে।
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleItems.map((item) => {
            const parsed = parsePaperCuttingFromGkItem(item);
            const thumbUrl = sessionThumbnails[item.title];
            return (
              <article
                key={item.id}
                data-testid={`paper-cutting-card-${item.id}`}
                className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    {thumbUrl && (
                      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                        {/* Session-local blob preview URL for freshly uploaded newspaper photo */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={thumbUrl}
                          alt={item.title}
                          className="h-full w-full object-cover"
                        />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        <span className="font-semibold text-blue-700">
                          পেপার কাটিং
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-slate-700">
                          {item.category}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          তারিখ: {item.eventDate}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>উৎস: {parsed.newspaperName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-slate-700 font-medium">
                          {toBengaliNumber(parsed.shortQAs.length)}টি ছোট প্রশ্ন
                        </span>
                        {item.convertedToQuestions && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-emerald-700">
                              প্রশ্নব্যাংকে যুক্ত
                            </span>
                          </>
                        )}
                      </div>

                      <h3 className="mt-1 text-base font-bold text-slate-900">
                        {item.title}
                      </h3>
                      {parsed.keySummary && (
                        <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                          {parsed.keySummary}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {parsed.shortQAs.length > 0 && (
                      <button
                        type="button"
                        data-testid={`paper-cutting-add-bank-${item.id}`}
                        disabled={addingToBankId === item.id}
                        onClick={() => void handleAddShortQAsToBank(item)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {addingToBankId === item.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {item.convertedToQuestions
                            ? 'পুনরায় প্রশ্নব্যাংকে যুক্ত করুন'
                            : 'প্রশ্নব্যাংকে যুক্ত করুন'}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleCopyItem(item)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      {copiedId === item.id ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-700" />
                          <span className="text-emerald-700">কপি হয়েছে</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          <span>কপি</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => void toggleGkArchive(item.id)}
                      aria-label={`আর্কাইভে পাঠান: ${item.title}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      <span>আর্কাইভ</span>
                    </button>

                    {confirmDeleteId === item.id ? (
                      <div className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-red-50 px-2 py-1">
                        <button
                          type="button"
                          data-testid={`confirm-delete-paper-cutting-btn-${item.id}`}
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
                          className="rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {deletingId === item.id ? 'মুছছে...' : 'নিশ্চিত মুছুন'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded px-1.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-red-100"
                        >
                          বাতিল
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid={`delete-paper-cutting-btn-${item.id}`}
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

                {/* Extracted Short Q&As List */}
                {parsed.shortQAs.length > 0 && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50/70 divide-y divide-slate-200">
                    {parsed.shortQAs.map((qa, idx) => (
                      <div key={idx} className="px-4 py-3 space-y-1">
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm font-medium text-slate-900 leading-relaxed">
                            <span className="font-mono font-semibold text-blue-700 mr-1.5">
                              {toBengaliNumber(idx + 1)}.
                            </span>
                            {qa.question}
                          </p>
                          {qa.topicTag && (
                            <span className="text-[11px] font-medium text-slate-500 whitespace-nowrap shrink-0">
                              {qa.topicTag}
                            </span>
                          )}
                        </div>
                        <p className="pl-5 text-sm font-bold text-slate-900 leading-relaxed">
                          <span className="text-emerald-800 mr-1">উত্তর:</span>
                          {qa.answer}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
