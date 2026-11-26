'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  Square,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  HardDrive,
  ExternalLink,
  CloudUpload,
  FolderOpen,
  Download,
  RefreshCw,
  Zap,
  Gauge,
  Layers,
  GitMerge,
  Newspaper,
  Sparkles,
  WifiOff,
  FileText,
  Database,
  FolderPlus,
  List,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { OfflinePdfPreviewModal } from '../pwa/OfflinePdfPreviewModal';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import {
  formatOfflineBytes,
  resolveOfflineScopeKey,
  summarizeOfflineStudyMaterials,
} from '@/src/lib/offline-cache-policy';
import {
  getServiceWorkerCacheStatus,
  type OfflinePdfBlobRecord,
  type ServiceWorkerCacheStatus,
} from '@/src/lib/offline-library-cache';
import {
  type DriveFolderFileItem,
  PAPER_CUTTING_DRIVE_FOLDER_URL,
  buildBookDrivePayload,
  buildDrivePayloadFromSavedBook,
  deleteBookFromGoogleDrive,
  downloadGoogleDriveFile,
  extractGoogleDriveFolderId,
  listGoogleDriveFolderFiles,
  uploadBookToGoogleDrive,
} from '@/src/lib/google-drive';
import { formatAiResponseError } from '@/src/lib/ai-client';
import { prepareImageForPaperCuttingApi } from '@/src/lib/image-upload-utils';
import {
  type PaperCuttingAnalysisResult,
  extractImportedPaperCuttingDriveIds,
  formatPaperCuttingForBookChunk,
  serializePaperCuttingToGkInput,
} from '@/src/lib/paper-cutting-parser';
import {
  AUTH_INITIALIZING_WAIT_MESSAGE,
  isAuthStateResolving,
} from '@/src/lib/frontend-auth';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  formatFileSize,
  toBengaliNumber,
  validateDeclaredUploadMetadata,
  validateUploadedDocumentHeader,
} from '@/src/lib/file-validation';
import {
  ACCURATE_OCR_BATCH_CONCURRENCY,
  FAST_OCR_BATCH_CONCURRENCY,
  type CombinedExtractionResult,
  type PdfOcrSpeed,
  type SaveReadinessExtractionContext,
  buildPageMappings,
  findDuplicateBookMatch,
  mergePartialExtractionWithRecoveredPages,
  stripPageMarkersAndHeaders,
  validateBookSaveReadiness,
} from '@/src/lib/pdf-rules';
import {
  type PdfPipelineProgress,
  cancelPdfUploadSession,
  runChunkedPdfPipeline,
} from '@/src/lib/pdf-upload-client';
import {
  sliceSpecificPdfPagesInBrowser,
  tryFastClientPdfPreprocess,
} from '@/src/lib/client-pdf-accelerator';
import { extractDocxDocument } from '@/src/lib/docx-extractor';
import {
  buildBookCardSummary,
  buildFullPageBookChunks,
} from '@/src/lib/reader-page-grouper';
import {
  BOOK_FORMAT_LABELS,
  buildVirtualMasterBookCatalog,
  detectBookContentFormat,
  type BookContentFormat,
} from '@/src/lib/book-catalog-organization';
import { useBookCatalogOverrides } from '@/src/lib/book-catalog-storage';
import type { Book, BookCategory } from '@/src/types/system';

const BOOK_CATEGORY_OPTIONS: BookCategory[] = [
  'রিসেন্ট জব সলুশন',
  'BCS',
  'Bank',
  'Primary',
  'Previous Year',
  'বিষয়ভিত্তিক মূল বই',
  'Current GK',
  'অন্যান্য',
];

const CATEGORIES: Array<'সব' | BookCategory> = [
  'সব',
  ...BOOK_CATEGORY_OPTIONS,
];

const FORMAT_FILTER_OPTIONS: Array<{
  id: 'all' | BookContentFormat;
  label: string;
}> = [
  { id: 'all', label: 'সব ধরন' },
  { id: 'MCQ', label: 'MCQ' },
  { id: 'Written', label: 'Written (লিখিত)' },
  { id: 'Combined', label: 'MCQ + Written' },
  { id: 'Textbook', label: 'মূল বই / নোট' },
];

function buildChunksFromExtractionOrRawText(params: {
  bookTitle: string;
  fallbackChapter: string;
  rawText: string;
  extractionResult: CombinedExtractionResult | null;
  rawTextModifiedByUser: boolean;
}) {
  return buildFullPageBookChunks(params);
}

export function BookLibraryView() {
  const {
    data,
    user,
    authLoading,
    authStatus,
    addBook,
    addGkItem,
    mergeBooksIntoSeries,
    appendPartToBook,
    updateBookDriveMeta,
    deleteBook,
    setSelectedBookId,
    setActiveModule,
    getAiAuthHeaders,
    requestAiSignIn,
    driveConnected,
    driveSyncEnabled: syncToDriveOnSave,
    setDriveSyncEnabled: setSyncToDriveOnSave,
    driveFolderId,
    driveFolderUrl,
    driveFolderLabel,
    driveImportFolderUrl,
    getDriveAccessToken,
    clearDriveSession,
    connectGoogleDrive,
    offlineSavedAt,
    cachedPdfsMeta,
    cacheBookPdfOffline,
    getCachedBookPdf,
    syncAllOfflineMaterials,
  } = useWorkspace();

  const authResolving = authLoading || isAuthStateResolving(authStatus);
  const isOnline = useOnlineStatus();
  const catalogScopeKey = resolveOfflineScopeKey(user?.uid ?? null);
  const {
    overrides: catalogOverrides,
    assignBookToMaster,
    assignBookFormat,
  } = useBookCatalogOverrides(catalogScopeKey);

  const [categoryFilter, setCategoryFilter] = useState<'সব' | BookCategory>('সব');
  const [formatFilter, setFormatFilter] = useState<'all' | BookContentFormat>('all');
  const [libraryViewMode, setLibraryViewMode] = useState<'master' | 'parts'>('master');
  const [expandedMasterKeys, setExpandedMasterKeys] = useState<Record<string, boolean>>({});
  const [editingFolderBookId, setEditingFolderBookId] = useState<number | null>(null);
  const [folderDraftName, setFolderDraftName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);

  // Offline Library & Service Worker cache state
  const [swStatus, setSwStatus] = useState<ServiceWorkerCacheStatus | null>(null);
  const [syncingOffline, setSyncingOffline] = useState(false);
  const [offlineSyncNotice, setOfflineSyncNotice] = useState<string | null>(null);
  const [previewOfflinePdf, setPreviewOfflinePdf] =
    useState<OfflinePdfBlobRecord | null>(null);
  const [openingOfflinePdfId, setOpeningOfflinePdfId] = useState<number | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    const refreshStatus = async () => {
      const initial = await getServiceWorkerCacheStatus();
      if (!cancelled) setSwStatus(initial);
      if (
        !initial.active &&
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator
      ) {
        try {
          await navigator.serviceWorker.ready;
          if (cancelled) return;
          const readyStatus = await getServiceWorkerCacheStatus();
          if (!cancelled) setSwStatus(readyStatus);
        } catch {
          // Ignore if SW registration is unavailable in this environment
        }
      }
    };
    void refreshStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const cachedPdfByBookId = useMemo(
    () => new Map(cachedPdfsMeta.map((item) => [item.bookId, item])),
    [cachedPdfsMeta]
  );

  const offlineSummary = useMemo(
    () => summarizeOfflineStudyMaterials(data),
    [data]
  );

  const cachedPdfTotalBytes = useMemo(
    () => cachedPdfsMeta.reduce((acc, item) => acc + item.sizeBytes, 0),
    [cachedPdfsMeta]
  );

  const handleSyncOfflineNow = async () => {
    setSyncingOffline(true);
    setOfflineSyncNotice(null);
    try {
      const result = await syncAllOfflineMaterials();
      setSwStatus(result.swStatus);
      setOfflineSyncNotice(
        `অফলাইন লাইব্রেরি হালনাগাদ সম্পন্ন — ${toBengaliNumber(offlineSummary.booksCount)}টি বই, ${toBengaliNumber(offlineSummary.questionsCount)}টি প্রশ্ন ও অ্যাপ ফাইল ইন্টারনেট ছাড়াই ব্যবহারযোগ্য।`
      );
    } catch {
      setOfflineSyncNotice('অফলাইন ক্যাশ হালনাগাদ করতে সমস্যা হয়েছে।');
    } finally {
      setSyncingOffline(false);
    }
  };

  const handleOpenOfflinePdf = async (bookId: number) => {
    setOpeningOfflinePdfId(bookId);
    try {
      const rec = await getCachedBookPdf(bookId);
      if (rec) {
        setPreviewOfflinePdf(rec);
      } else {
        setOfflineSyncNotice('এই বইটির মূল PDF ফাইলটি অফলাইন ক্যাশে পাওয়া যায়নি।');
      }
    } finally {
      setOpeningOfflinePdfId(null);
    }
  };

  // Google Drive sync, existing folder importer & delete confirmation state
  const [connectingDrive, setConnectingDrive] = useState(false);
  const [syncingBookId, setSyncingBookId] = useState<number | null>(null);
  const [showDriveImporter, setShowDriveImporter] = useState(false);
  const [importFolderUrlInput, setImportFolderUrlInput] = useState(
    driveImportFolderUrl
  );
  const [importCategory, setImportCategory] = useState<BookCategory>('BCS');
  const [loadingDriveFiles, setLoadingDriveFiles] = useState(false);
  const [driveFolderFiles, setDriveFolderFiles] = useState<DriveFolderFileItem[]>(
    []
  );
  const [driveFilesLoadedOnce, setDriveFilesLoadedOnce] = useState(false);
  const [importingDriveFileId, setImportingDriveFileId] = useState<string | null>(
    null
  );
  const [selectedDriveImageIds, setSelectedDriveImageIds] = useState<string[]>(
    []
  );
  const [bulkDriveImageStatus, setBulkDriveImageStatus] = useState<string | null>(
    null
  );
  const [driveImportError, setDriveImportError] = useState<string | null>(null);
  const [driveNotice, setDriveNotice] = useState<{
    tone: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);
  const [pendingDeleteBook, setPendingDeleteBook] = useState<Book | null>(null);
  const [deletingBook, setDeletingBook] = useState(false);
  const [deleteModalError, setDeleteModalError] = useState<string | null>(null);

  // Add Book / PDF Upload Form state
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [subject, setSubject] = useState('বাংলাদেশ বিষয়াবলি');
  const [category, setCategory] = useState<BookCategory>('BCS');
  const [chapterName, setChapterName] = useState('অধ্যায় ১: মূল আলোচনা');
  const [originalPageRangeInput, setOriginalPageRangeInput] = useState('');
  const [rawText, setRawText] = useState('');
  const [rawTextModified, setRawTextModified] = useState(false);
  const [autoSaveOnComplete, setAutoSaveOnComplete] = useState(true);
  const [forceOcr, setForceOcr] = useState(false);
  const [ocrSpeed, setOcrSpeed] = useState<PdfOcrSpeed>('accurate');
  const [pdfSubsetInput, setPdfSubsetInput] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<string | null>(null);
  const [extractionMethod, setExtractionMethod] = useState<'text' | 'ocr' | 'manual'>('manual');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [effectivePdfSourceFile, setEffectivePdfSourceFile] = useState<File | null>(null);
  const [quotaCooldownSeconds, setQuotaCooldownSeconds] = useState<number>(0);
  const [pipelineProgress, setPipelineProgress] = useState<PdfPipelineProgress | null>(null);
  const [extractionResult, setExtractionResult] = useState<CombinedExtractionResult | null>(null);
  const [resumableSessionId, setResumableSessionId] = useState<string | null>(null);
  const [appendToBookId, setAppendToBookId] = useState<number | null>(null);
  const [uploadFormat, setUploadFormat] = useState<'' | BookContentFormat>('');
  const [uploadMasterFolderName, setUploadMasterFolderName] = useState('');
  const [mergingSeriesKey, setMergingSeriesKey] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);

  const isCooldownActive = quotaCooldownSeconds > 0;
  useEffect(() => {
    if (!isCooldownActive) return;
    const timer = window.setInterval(() => {
      setQuotaCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isCooldownActive]);

  const totalChunks = useMemo(
    () => data.books.reduce((sum, b) => sum + b.chunks.length, 0),
    [data.books]
  );

  const totalPages = useMemo(
    () => data.books.reduce((sum, b) => sum + b.totalPages, 0),
    [data.books]
  );

  const virtualCatalog = useMemo(
    () => buildVirtualMasterBookCatalog(data.books, catalogOverrides),
    [data.books, catalogOverrides]
  );

  const existingMasterFolderSuggestions = useMemo(() => {
    const names = new Set<string>();
    for (const entry of virtualCatalog) {
      if (entry.isVirtualSeries || entry.isCustomGrouped) {
        names.add(entry.title);
      }
    }
    for (const customName of Object.values(catalogOverrides.customMasterByBookId)) {
      if (customName.trim()) names.add(customName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'bn'));
  }, [virtualCatalog, catalogOverrides.customMasterByBookId]);

  const filteredCatalogEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return virtualCatalog.filter((entry) => {
      if (categoryFilter !== 'সব') {
        const matchesCat =
          entry.category === categoryFilter ||
          entry.books.some((b) => b.category === categoryFilter);
        if (!matchesCat) return false;
      }
      if (formatFilter !== 'all') {
        const matchesFmt =
          entry.format === formatFilter ||
          entry.books.some(
            (b) =>
              detectBookContentFormat(
                b,
                catalogOverrides.customFormatByBookId[String(b.id)]
              ) === formatFilter
          );
        if (!matchesFmt) return false;
      }
      if (!q) return true;
      if (entry.title.toLowerCase().includes(q)) return true;
      return entry.books.some(
        (book) =>
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
  }, [
    virtualCatalog,
    categoryFilter,
    formatFilter,
    searchQuery,
    catalogOverrides.customFormatByBookId,
  ]);

  const filteredBooks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return data.books.filter((book) => {
      if (categoryFilter !== 'সব' && book.category !== categoryFilter) {
        return false;
      }
      if (formatFilter !== 'all') {
        const fmt = detectBookContentFormat(
          book,
          catalogOverrides.customFormatByBookId[String(book.id)]
        );
        if (fmt !== formatFilter) return false;
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
  }, [
    data.books,
    categoryFilter,
    formatFilter,
    searchQuery,
    catalogOverrides.customFormatByBookId,
  ]);

  const toggleMasterExpand = (masterKey: string) => {
    setExpandedMasterKeys((prev) => ({
      ...prev,
      [masterKey]: !prev[masterKey],
    }));
  };

  const handleMergeSeriesParts = async (seriesKey: string, bookIds: number[], seriesTitle: string) => {
    if (mergingSeriesKey !== null) return;
    setMergingSeriesKey(seriesKey);
    setSaveSuccessNotice(null);
    try {
      const merged = await mergeBooksIntoSeries(bookIds, seriesTitle);
      if (merged) {
        setSaveSuccessNotice(
          `"${merged.title}" এর ${toBengaliNumber(bookIds.length)}টি পার্ট সফলভাবে একটি সম্পূর্ণ বইয়ে একত্র করা হয়েছে (মোট ${toBengaliNumber(merged.totalPages)} পৃষ্ঠা)। এখন স্মার্ট রিডারে পুরো বই একসাথে পড়ুন ও টপিক/রিপিট প্রশ্ন দেখুন।`
        );
      }
    } finally {
      setMergingSeriesKey(null);
    }
  };

  const extractionContext = useMemo<SaveReadinessExtractionContext | null>(() => {
    if (!selectedFile) return null;
    const isPdf =
      selectedFile.name.toLowerCase().endsWith('.pdf') ||
      selectedFile.type === 'application/pdf';
    if (!extractionResult) {
      return {
        status: 'failed',
        actualPageCount: pipelineProgress?.actualPageCount ?? 0,
        extractedPageCount: 0,
        missingOriginalPages: [],
        sourceWasUploadedPdf: isPdf,
      };
    }
    return {
      status: extractionResult.extractionStatus,
      actualPageCount: extractionResult.actualPageCount,
      extractedPageCount: extractionResult.extractedPageCount,
      missingOriginalPages: extractionResult.missingOriginalPages,
      sourceWasUploadedPdf: isPdf,
    };
  }, [selectedFile, extractionResult, pipelineProgress?.actualPageCount]);

  const liveSaveReadiness = useMemo(
    () =>
      validateBookSaveReadiness({
        title,
        subject,
        rawText,
        extractionContext,
      }),
    [title, subject, rawText, extractionContext]
  );

  const resetFormState = () => {
    setTitle('');
    setAuthor('');
    setOriginalPageRangeInput('');
    setRawText('');
    setRawTextModified(false);
    setFormError(null);
    setExtractionMethod('manual');
    setSelectedFile(null);
    setEffectivePdfSourceFile(null);
    setQuotaCooldownSeconds(0);
    setPipelineProgress(null);
    setExtractionResult(null);
    setResumableSessionId(null);
    setAppendToBookId(null);
    setUploadFormat('');
    setUploadMasterFolderName('');
    activeSessionIdRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleConnectGoogleDrive = async () => {
    setConnectingDrive(true);
    setDriveNotice(null);
    try {
      const token = await connectGoogleDrive();
      if (token) {
        setDriveNotice({
          tone: 'success',
          message:
            'Google Drive সফলভাবে সংযুক্ত হয়েছে। এখন বই সেভ করলে নির্ধারিত Drive ফোল্ডারেও সংরক্ষিত হবে।',
        });
      } else {
        setDriveNotice({
          tone: 'warning',
          message:
            'Google Drive অনুমতি সম্পন্ন হয়নি। অনুগ্রহ করে পুনরায় "Google Drive সংযুক্ত করুন" বাটনে ক্লিক করে অনুমতি দিন।',
        });
      }
    } finally {
      setConnectingDrive(false);
    }
  };

  const handlePushBookToDrive = async (book: Book) => {
    if (syncingBookId !== null) return;
    setSyncingBookId(book.id);
    setDriveNotice(null);

    try {
      let token = getDriveAccessToken();
      if (!token) {
        token = await connectGoogleDrive();
      }
      if (!token) {
        setDriveNotice({
          tone: 'warning',
          message:
            'Google Drive সংযুক্ত না থাকায় ফাইলটি আপলোড করা যায়নি। আগে Google Drive সংযুক্ত করুন।',
        });
        return;
      }

      const payload = buildDrivePayloadFromSavedBook(book);
      const result = await uploadBookToGoogleDrive({
        accessToken: token,
        folderId: driveFolderId,
        title: book.title,
        subject: book.subject,
        bookId: book.id,
        payload,
      });

      if (!result.ok) {
        if (result.code === 'unauthorized') {
          clearDriveSession();
        }
        setDriveNotice({
          tone: 'error',
          message: result.error,
        });
        return;
      }

      await updateBookDriveMeta(book.id, {
        driveFileId: result.fileId,
        driveWebViewLink: result.webViewLink,
        driveFileName: result.fileName,
      });

      setDriveNotice({
        tone: 'success',
        message: `"${book.title}" সফলভাবে আপনার নির্ধারিত Google Drive ফোল্ডারে (${result.fileName}) সংরক্ষিত হয়েছে।`,
      });
    } finally {
      setSyncingBookId(null);
    }
  };

  const handleConfirmDeleteBook = async (options: {
    deleteFromDrive: boolean;
    reconnectDriveFirst?: boolean;
  }) => {
    if (!pendingDeleteBook || deletingBook) return;
    const targetBook = pendingDeleteBook;
    setDeletingBook(true);
    setDeleteModalError(null);

    try {
      let driveStatusNote = '';

      if (targetBook.driveFileId && options.deleteFromDrive) {
        let token = getDriveAccessToken();
        if (!token && options.reconnectDriveFirst) {
          token = await connectGoogleDrive();
        }
        if (!token) {
          setDeleteModalError(
            'Google Drive সংযুক্ত নয়। Drive থেকেও ডিলিট করতে প্রথমে Google Drive সংযুক্ত করুন, অথবা "শুধু লাইব্রেরি থেকে মুছুন" নির্বাচন করুন।'
          );
          return;
        }

        const driveDel = await deleteBookFromGoogleDrive({
          accessToken: token,
          fileId: targetBook.driveFileId,
        });

        if (!driveDel.ok) {
          if (driveDel.code === 'unauthorized') {
            clearDriveSession();
          }
          setDeleteModalError(driveDel.error);
          return;
        }

        driveStatusNote = driveDel.alreadyDeleted
          ? ' (Google Drive ফোল্ডারে ফাইলটি ইতিমধ্যেই মুছে ফেলা ছিল)।'
          : ' এবং নির্ধারিত Google Drive ফোল্ডার থেকেও স্থায়ীভাবে মুছে ফেলা হয়েছে।';
      }

      await deleteBook(targetBook.id);
      setPendingDeleteBook(null);
      setDeleteModalError(null);
      setSaveSuccessNotice(
        `"${targetBook.title}" লাইব্রেরি থেকে মুছে ফেলা হয়েছে${driveStatusNote || '।'}`
      );
    } catch (err) {
      setDeleteModalError(
        err instanceof Error
          ? err.message
          : 'বইটি মুছে ফেলতে সমস্যা হয়েছে। আবার চেষ্টা করুন।'
      );
    } finally {
      setDeletingBook(false);
    }
  };

  const importedDriveFileIdSet = useMemo(
    () => extractImportedPaperCuttingDriveIds(data.gkItems, data.books),
    [data.gkItems, data.books]
  );

  const driveImageFilesInFolder = useMemo(
    () => driveFolderFiles.filter((f) => f.kindLabel === 'Image'),
    [driveFolderFiles]
  );

  const handleLoadDriveFolderFiles = async () => {
    if (loadingDriveFiles) return;
    setDriveImportError(null);
    const parsedFolderId = extractGoogleDriveFolderId(importFolderUrlInput);
    if (!parsedFolderId) {
      setDriveImportError(
        'সঠিক Google Drive ফোল্ডার লিংক বা ফোল্ডার আইডি দিন (যেমন: https://drive.google.com/drive/folders/...)'
      );
      return;
    }

    setLoadingDriveFiles(true);
    try {
      let token = getDriveAccessToken();
      if (!token) {
        token = await connectGoogleDrive();
      }
      if (!token) {
        setDriveImportError(
          'Google Drive সংযুক্ত না থাকায় ফোল্ডারের বই লোড করা যায়নি। আগে Google Drive সংযুক্ত করুন।'
        );
        return;
      }

      const listed = await listGoogleDriveFolderFiles({
        accessToken: token,
        folderId: parsedFolderId,
      });

      if (!listed.ok) {
        if (listed.code === 'unauthorized') {
          clearDriveSession();
        }
        setDriveImportError(listed.error);
        return;
      }

      setDriveFolderFiles(listed.files);
      setDriveFilesLoadedOnce(true);
      setSelectedDriveImageIds(
        listed.files
          .filter(
            (f) => f.kindLabel === 'Image' && !importedDriveFileIdSet.has(f.id)
          )
          .map((f) => f.id)
      );
    } finally {
      setLoadingDriveFiles(false);
    }
  };

  const handleBulkImportDriveImages = async () => {
    const queue = driveFolderFiles.filter(
      (f) => f.kindLabel === 'Image' && selectedDriveImageIds.includes(f.id)
    );
    if (queue.length === 0 || bulkDriveImageStatus || extracting || saving) {
      return;
    }

    setDriveImportError(null);
    setDriveNotice(null);
    setSaveSuccessNotice(null);

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('Google Drive পেপার কাটিং ফটো থেকে ছোট প্রশ্ন তৈরি');
      return;
    }

    let token = getDriveAccessToken();
    if (!token) {
      token = await connectGoogleDrive();
    }
    if (!token) {
      setDriveImportError(
        'Google Drive সংযুক্ত না থাকায় ফটোগুলো ডাউনলোড করা যায়নি। আগে Google Drive সংযুক্ত করুন।'
      );
      return;
    }

    const collectedChunks: Array<{
      chapter: string;
      pageNumber: number;
      chunkIndex: number;
      content: string;
    }> = [];
    const failedNotes: string[] = [];
    let totalQaCount = 0;

    try {
      for (let i = 0; i < queue.length; i += 1) {
        const df = queue[i];
        setBulkDriveImageStatus(
          `Drive ফটো বিশ্লেষণ ও ছোট প্রশ্ন তৈরি হচ্ছে (${toBengaliNumber(i + 1)}/${toBengaliNumber(queue.length)}): ${df.name}...`
        );

        const dl = await downloadGoogleDriveFile({
          accessToken: token,
          file: df,
        });
        if (!dl.ok) {
          if (dl.code === 'unauthorized') {
            clearDriveSession();
            failedNotes.push(`${df.name} (Drive সেশন শেষ)`);
            break;
          }
          failedNotes.push(`${df.name} (${dl.error})`);
          continue;
        }

        try {
          const prepared = await prepareImageForPaperCuttingApi(dl.file);
          URL.revokeObjectURL(prepared.previewUrl);

          const res = await fetch('/api/ai/paper-cutting', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders,
            },
            body: JSON.stringify({
              imageBase64: prepared.imageBase64,
              mimeType: prepared.mimeType,
              fileName: df.name,
            }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (res.status === 401) {
              requestAiSignIn('Google Drive পেপার কাটিং ফটো বিশ্লেষণ');
            }
            throw new Error(
              formatAiResponseError(res.status, json, 'ফটো বিশ্লেষণ ব্যর্থ হয়েছে।')
            );
          }

          const analysis = json.analysis as PaperCuttingAnalysisResult;
          totalQaCount += analysis.shortQAs.length;

          // Also sync each photo's extracted short Q&As into 06. Current GK -> Paper Cutting
          await addGkItem(
            serializePaperCuttingToGkInput(analysis, {
              fileName: df.name,
              driveFileId: df.id,
              driveWebViewLink: df.webViewLink,
            })
          );

          collectedChunks.push({
            chapter: `${analysis.headline} (${analysis.eventDate})`,
            pageNumber: collectedChunks.length + 1,
            chunkIndex: collectedChunks.length,
            content: formatPaperCuttingForBookChunk(analysis, {
              fileName: df.name,
              driveFileId: df.id,
            }),
          });

          setSelectedDriveImageIds((prev) => prev.filter((id) => id !== df.id));
        } catch (err) {
          failedNotes.push(
            `${df.name} (${err instanceof Error ? err.message : 'বিশ্লেষণ ত্রুটি'})`
          );
        }
      }

      if (collectedChunks.length > 0) {
        const todayIso = new Date().toISOString().slice(0, 10);
        const bookTitle =
          collectedChunks.length === 1
            ? `পেপার কাটিং — ${collectedChunks[0].chapter}`
            : `পেপার কাটিং সংকলন (${todayIso} · ${toBengaliNumber(collectedChunks.length)}টি ছবি)`;
        await addBook({
          title: bookTitle,
          author: 'সংবাদপত্র পেপার কাটিং (Google Drive)',
          subject: 'সাম্প্রতিক সাধারণ জ্ঞান',
          category: importCategory === 'BCS' ? 'Current GK' : importCategory,
          totalPages: collectedChunks.length,
          extractionMethod: 'ocr',
          ocrCompleted: true,
          driveFileId:
            collectedChunks.length === 1 ? queue[0]?.id ?? null : null,
          driveWebViewLink:
            collectedChunks.length === 1 ? queue[0]?.webViewLink ?? null : null,
          driveFileName:
            collectedChunks.length === 1 ? queue[0]?.name ?? null : null,
          chunks: collectedChunks,
        });

        setSaveSuccessNotice(
          `Google Drive-এর ${toBengaliNumber(collectedChunks.length)}টি পেপার কাটিং ফটো থেকে মোট ${toBengaliNumber(totalQaCount)}টি ছোট প্রশ্ন ও উত্তর তৈরি করে Library এবং Current GK (Paper Cutting)-এ সংরক্ষণ করা হয়েছে।`
        );
      }

      if (failedNotes.length > 0) {
        setDriveImportError(`কিছু ফটো প্রসেস হয়নি: ${failedNotes.join(' | ')}`);
      }
    } finally {
      setBulkDriveImageStatus(null);
    }
  };

  const handleImportDriveFile = async (driveFile: DriveFolderFileItem) => {
    if (importingDriveFileId !== null || extracting || saving) return;
    setDriveImportError(null);
    setDriveNotice(null);
    setImportingDriveFileId(driveFile.id);

    try {
      let token = getDriveAccessToken();
      if (!token) {
        token = await connectGoogleDrive();
      }
      if (!token) {
        setDriveImportError(
          'Google Drive সংযুক্ত না থাকায় বইটি ডাউনলোড করা যায়নি। আগে Google Drive সংযুক্ত করুন।'
        );
        return;
      }

      const downloadRes = await downloadGoogleDriveFile({
        accessToken: token,
        file: driveFile,
      });

      if (!downloadRes.ok) {
        if (downloadRes.code === 'unauthorized') {
          clearDriveSession();
        }
        setDriveImportError(downloadRes.error);
        return;
      }

      const cleanTitle =
        driveFile.name.replace(/\.[^.]+$/, '').trim() || driveFile.name;
      setTitle(cleanTitle);
      setCategory(importCategory);
      setSelectedFile(downloadRes.file);
      setResumableSessionId(null);
      setShowAddForm(true);

      await runFileExtraction(downloadRes.file, {
        overrideTitle: cleanTitle,
        overrideCategory: importCategory,
        existingDriveMeta: {
          driveFileId: driveFile.id,
          driveWebViewLink: driveFile.webViewLink,
          driveFileName: driveFile.name,
        },
      });
    } finally {
      setImportingDriveFileId(null);
    }
  };

  const persistBookRecord = async (params: {
    targetTitle: string;
    targetSubject: string;
    targetAuthor: string;
    targetCategory: BookCategory;
    targetChapter: string;
    targetRawText: string;
    targetMethod: 'text' | 'ocr' | 'manual';
    targetExtractionResult: CombinedExtractionResult | null;
    targetExtractionContext: SaveReadinessExtractionContext | null;
    targetRawTextModified: boolean;
    sourceFile?: File | null;
    existingDriveMeta?: {
      driveFileId: string;
      driveWebViewLink: string;
      driveFileName: string;
    } | null;
  }): Promise<boolean> => {
    if (saveInFlightRef.current) {
      return false;
    }

    const readiness = validateBookSaveReadiness({
      title: params.targetTitle,
      subject: params.targetSubject,
      rawText: params.targetRawText,
      extractionContext: params.targetExtractionContext,
    });

    if (!readiness.ok) {
      setFormError(readiness.error || 'বই সংরক্ষণের শর্ত পূরণ হয়নি।');
      return false;
    }

    const trimmedTitle = params.targetTitle.trim();
    const trimmedSubject = params.targetSubject.trim();
    const fallbackChapter = params.targetChapter.trim() || 'অধ্যায় ১';

    const chunks = buildChunksFromExtractionOrRawText({
      bookTitle: trimmedTitle,
      fallbackChapter,
      rawText: params.targetRawText,
      extractionResult: params.targetExtractionResult,
      rawTextModifiedByUser: params.targetRawTextModified,
    });

    if (chunks.length === 0) {
      setFormError('পাঠ্য থেকে কোনো বৈধ RAG চ্যাংক তৈরি করা যায়নি।');
      return false;
    }

    const totalPagesToSave = params.targetExtractionContext?.sourceWasUploadedPdf
      ? readiness.computedTotalPages
      : Math.max(
          readiness.computedTotalPages,
          new Set(chunks.map((c) => c.pageNumber)).size
        );

    const targetAppendBook =
      appendToBookId !== null
        ? data.books.find((b) => b.id === appendToBookId) ?? null
        : null;

    if (!targetAppendBook) {
      const duplicate = findDuplicateBookMatch(data.books, {
        title: trimmedTitle,
        subject: trimmedSubject,
        totalPages: totalPagesToSave,
        chunks: chunks.map((c) => ({
          pageNumber: c.pageNumber,
          content: c.content,
        })),
      });

      if (duplicate) {
        setFormError(
          `এই বইটি ("${duplicate.title}") ইতিমধ্যে Knowledge Base-এ সংরক্ষিত আছে। ডুপ্লিকেট রেকর্ড তৈরি প্রতিরোধ করা হয়েছে।`
        );
        return false;
      }
    }

    saveInFlightRef.current = true;
    setSaving(true);
    setDriveNotice(null);
    try {
      let driveFileId: string | null =
        params.existingDriveMeta?.driveFileId ?? null;
      let driveWebViewLink: string | null =
        params.existingDriveMeta?.driveWebViewLink ?? null;
      let driveFileName: string | null =
        params.existingDriveMeta?.driveFileName ?? null;
      let pendingDriveWarning: string | null = null;

      if (syncToDriveOnSave && !driveFileId) {
        const driveToken = getDriveAccessToken();
        if (driveToken) {
          const drivePayload = buildBookDrivePayload({
            title: trimmedTitle,
            author: params.targetAuthor.trim() || 'ব্যক্তিগত নোট / গাইড',
            subject: trimmedSubject,
            category: params.targetCategory,
            totalPages: totalPagesToSave,
            rawText: params.targetRawText,
            chunks: chunks.map((c) => ({
              chapter: c.chapter,
              pageNumber: c.pageNumber,
              content: c.content,
            })),
            sourceFile: params.sourceFile ?? null,
          });

          const uploadRes = await uploadBookToGoogleDrive({
            accessToken: driveToken,
            folderId: driveFolderId,
            title: trimmedTitle,
            subject: trimmedSubject,
            payload: drivePayload,
          });

          if (uploadRes.ok) {
            driveFileId = uploadRes.fileId;
            driveWebViewLink = uploadRes.webViewLink;
            driveFileName = uploadRes.fileName;
          } else {
            if (uploadRes.code === 'unauthorized') {
              clearDriveSession();
            }
            pendingDriveWarning = `বইটি লাইব্রেরিতে সংরক্ষিত হয়েছে, তবে Google Drive আপলোড ব্যর্থ হয়েছে: ${uploadRes.error}`;
          }
        } else {
          pendingDriveWarning =
            'বইটি লাইব্রেরিতে সংরক্ষিত হয়েছে। নির্ধারিত Google Drive ফোল্ডারে পাঠাতে উপরে "Google Drive সংযুক্ত করুন" অথবা বইটির পাশের "Drive-এ সেভ" বাটনে ক্লিক করুন।';
        }
      }

      if (targetAppendBook) {
        const appended = await appendPartToBook(targetAppendBook.id, {
          totalPages: totalPagesToSave,
          chunks,
          extractionMethod: params.targetMethod,
          ocrCompleted: params.targetExtractionResult
            ? params.targetExtractionResult.ocrCompleted
            : params.targetMethod === 'ocr',
        });
        if (appended) {
          if (params.sourceFile) {
            await cacheBookPdfOffline(
              appended.id,
              appended.title,
              params.sourceFile,
              params.sourceFile.name
            );
          }
          setSaveSuccessNotice(
            `"${appended.title}" বইয়ে নতুন পার্ট (+${toBengaliNumber(totalPagesToSave)} পৃষ্ঠা) সফলভাবে যুক্ত হয়েছে। এখন মোট ${toBengaliNumber(appended.totalPages)} পৃষ্ঠা একটি বইয়ে একত্র রয়েছে।`
          );
          resetFormState();
          setShowAddForm(false);
          return true;
        }
      }

      const createdBook = await addBook({
        title: trimmedTitle,
        author: params.targetAuthor.trim() || 'ব্যক্তিগত নোট / গাইড',
        subject: trimmedSubject,
        category: params.targetCategory,
        totalPages: totalPagesToSave,
        extractionMethod: params.targetMethod,
        ocrCompleted: params.targetExtractionResult
          ? params.targetExtractionResult.ocrCompleted
          : params.targetMethod === 'ocr',
        driveFileId,
        driveWebViewLink,
        driveFileName,
        chunks,
      });

      if (uploadFormat) {
        assignBookFormat(createdBook.id, uploadFormat);
      }
      if (uploadMasterFolderName.trim()) {
        assignBookToMaster(createdBook.id, uploadMasterFolderName.trim());
      }

      if (params.sourceFile) {
        await cacheBookPdfOffline(
          createdBook.id,
          createdBook.title,
          params.sourceFile,
          params.sourceFile.name
        );
      }

      setSaveSuccessNotice(
        driveFileId
          ? `"${trimmedTitle}" সফলভাবে Knowledge Base, অফলাইন ক্যাশ এবং নির্ধারিত Google Drive ফোল্ডারে সংরক্ষিত হয়েছে (${toBengaliNumber(totalPagesToSave)} পৃষ্ঠা)।`
          : `"${trimmedTitle}" সফলভাবে Knowledge Base ও অফলাইন ক্যাশে সংরক্ষিত হয়েছে (${toBengaliNumber(totalPagesToSave)} পৃষ্ঠা)।`
      );
      if (pendingDriveWarning) {
        setDriveNotice({
          tone: 'warning',
          message: pendingDriveWarning,
        });
      }
      resetFormState();
      setShowAddForm(false);
      return true;
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'বই সংরক্ষণ করতে সমস্যা হয়েছে।'
      );
      return false;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const runFileExtraction = async (
    file: File,
    options?: {
      resumeSessionId?: string | null;
      overrideTitle?: string;
      overrideCategory?: BookCategory;
      existingDriveMeta?: {
        driveFileId: string;
        driveWebViewLink: string;
        driveFileName: string;
      } | null;
    }
  ) => {
    setFormError(null);
    setSaveSuccessNotice(null);
    setExtractionResult(null);
    setRawTextModified(false);

    // Immediate client-side size/type verification before checking auth or opening a session
    const precheck = validateDeclaredUploadMetadata({
      fileName: file.name,
      declaredMimeType: file.type,
      fileSize: file.size,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    if (!precheck.ok) {
      setFormError(precheck.error);
      setPipelineProgress({
        stage: 'failed',
        statusMessage: precheck.error,
        sessionId: null,
        fileName: file.name,
        fileSize: file.size,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        uploadedChunks: 0,
        totalChunks: 0,
        bytesUploaded: 0,
        actualPageCount: null,
        originalPageRange: originalPageRangeInput.trim() || null,
        currentBatch: 0,
        totalBatches: 0,
        completedPages: 0,
        totalPages: null,
        ocrEnabled: true,
        ocrActive: null,
        saveReady: false,
        resumable: false,
      });
      return false;
    }

    const derivedTitle =
      options?.overrideTitle?.trim() ||
      title.trim() ||
      file.name.replace(/\.[^.]+$/, '').trim() ||
      'নতুন বই';
    const effectiveCategory = options?.overrideCategory ?? category;
    if (!title.trim() || options?.overrideTitle) {
      setTitle(derivedTitle);
    }

    // Ultra-fast client-local fast path for plain TXT / MD files (works even without AI calls!)
    if (precheck.expectedKind === 'text') {
      const headerSlice = new Uint8Array(
        await file.slice(0, Math.min(file.size, 8192)).arrayBuffer()
      );
      const headerCheck = validateUploadedDocumentHeader(
        file.name,
        file.type,
        headerSlice,
        file.size,
        MAX_UPLOAD_BYTES
      );
      if (!headerCheck.ok) {
        setFormError(headerCheck.error);
        return false;
      }
      const textContent = (await file.text()).trim();
      const meaningfulLen = stripPageMarkersAndHeaders(textContent).length;
      if (!textContent || meaningfulLen < 20) {
        setFormError('টেক্সট ফাইলটিতে কমপক্ষে ২০ অক্ষরের পাঠযোগ্য বিষয়বস্তু পাওয়া যায়নি।');
        return false;
      }
      const parsedTextPages = buildFullPageBookChunks({
        bookTitle: derivedTitle,
        fallbackChapter: chapterName.trim() || 'অধ্যায় ১',
        rawText: textContent,
        extractionResult: null,
        rawTextModifiedByUser: true,
      });
      const resolvedSections =
        parsedTextPages.length > 0
          ? parsedTextPages.map((p, idx) => ({
              chapter: p.chapter,
              pageNumber: p.pageNumber,
              pdfPageIndex: idx + 1,
              content: p.content,
            }))
          : [
              {
                chapter: chapterName.trim() || 'অধ্যায় ১',
                pageNumber: 1,
                pdfPageIndex: 1,
                content: textContent,
              },
            ];
      const estimatedPages = Math.max(
        resolvedSections.length,
        new Set(resolvedSections.map((s) => s.pageNumber)).size
      );
      const formattedCombinedRaw = resolvedSections
        .map((s) => `--- পৃষ্ঠা ${s.pageNumber} ---\n[${s.chapter}]\n${s.content}`)
        .join('\n\n');
      const localCombined: CombinedExtractionResult = {
        extractionStatus: 'success',
        method: 'text',
        ocrCompleted: false,
        actualPageCount: estimatedPages,
        expectedPageCount: estimatedPages,
        extractedPageCount: estimatedPages,
        originalPageRange: estimatedPages === 1 ? '1' : `1-${estimatedPages}`,
        totalBatches: 0,
        completedBatches: 0,
        failedBatches: 0,
        missingOriginalPages: [],
        duplicateOriginalPages: [],
        outOfOrderDetected: false,
        sections: resolvedSections,
        rawText: formattedCombinedRaw,
        meaningfulCharCount: meaningfulLen,
        warnings: [],
      };
      setExtractionResult(localCombined);
      setRawText(formattedCombinedRaw);
      setExtractionMethod('text');
      setPipelineProgress({
        stage: 'ready',
        statusMessage: 'টেক্সট ফাইল সরাসরি পড়া সম্পন্ন হয়েছে।',
        sessionId: null,
        fileName: file.name,
        fileSize: file.size,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        uploadedChunks: 1,
        totalChunks: 1,
        bytesUploaded: file.size,
        actualPageCount: estimatedPages,
        originalPageRange: localCombined.originalPageRange,
        currentBatch: 0,
        totalBatches: 0,
        completedPages: estimatedPages,
        totalPages: estimatedPages,
        localPagesCount: estimatedPages,
        ocrPagesCount: 0,
        ocrEnabled: false,
        ocrActive: false,
        saveReady: true,
        resumable: false,
      });

      if (autoSaveOnComplete) {
        await persistBookRecord({
          targetTitle: derivedTitle,
          targetSubject: subject.trim() || 'বাংলাদেশ বিষয়াবলি',
          targetAuthor: author,
          targetCategory: effectiveCategory,
          targetChapter: chapterName,
          targetRawText: textContent,
          targetMethod: 'text',
          targetExtractionResult: localCombined,
          targetExtractionContext: {
            status: 'success',
            actualPageCount: estimatedPages,
            extractedPageCount: estimatedPages,
            missingOriginalPages: [],
            sourceWasUploadedPdf: false,
          },
          targetRawTextModified: false,
          sourceFile: file,
          existingDriveMeta: options?.existingDriveMeta ?? null,
        });
      } else {
        setShowAdvancedOptions(true);
      }
      return true;
    }

    // Client-local fast path for Word (.docx) files (instant extraction, 0 Gemini calls, works in Guest & Cloud mode!)
    if (precheck.expectedKind === 'docx') {
      setExtracting(true);
      setPipelineProgress({
        stage: 'validating',
        statusMessage: 'Word (.docx) ফাইল যাচাই ও টেক্সট সংগ্রহ করা হচ্ছে...',
        sessionId: null,
        fileName: file.name,
        fileSize: file.size,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        uploadedChunks: 0,
        totalChunks: 1,
        bytesUploaded: 0,
        actualPageCount: null,
        originalPageRange: null,
        currentBatch: 0,
        totalBatches: 0,
        completedPages: 0,
        totalPages: 0,
        localPagesCount: 0,
        ocrPagesCount: 0,
        ocrEnabled: false,
        ocrActive: false,
        saveReady: false,
        resumable: false,
      });

      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const docxOutcome = await extractDocxDocument({
          bytes,
          fileName: file.name,
          fallbackChapter: chapterName.trim() || 'অধ্যায় ১: মূল আলোচনা',
          pageRangeInput: originalPageRangeInput,
          maxBytes: MAX_UPLOAD_BYTES,
        });

        if (!docxOutcome.ok) {
          setPipelineProgress(null);
          setFormError(docxOutcome.error);
          return false;
        }

        const combined = docxOutcome.extraction;
        setExtractionResult(combined);
        setRawText(combined.rawText);
        setExtractionMethod('text');
        setPipelineProgress({
          stage: 'ready',
          statusMessage: `Word (.docx) থেকে ${toBengaliNumber(combined.extractedPageCount)}টি অংশ/পৃষ্ঠা তাৎক্ষণিকভাবে সংগৃহীত হয়েছে (কোনো AI কোটা ব্যবহৃত হয়নি)।`,
          sessionId: null,
          fileName: file.name,
          fileSize: file.size,
          maxUploadBytes: MAX_UPLOAD_BYTES,
          uploadedChunks: 1,
          totalChunks: 1,
          bytesUploaded: file.size,
          actualPageCount: combined.actualPageCount,
          originalPageRange: combined.originalPageRange,
          currentBatch: 0,
          totalBatches: 0,
          completedPages: combined.extractedPageCount,
          totalPages: combined.actualPageCount,
          localPagesCount: combined.extractedPageCount,
          ocrPagesCount: 0,
          ocrEnabled: false,
          ocrActive: false,
          saveReady: true,
          resumable: false,
        });

        if (autoSaveOnComplete) {
          const saved = await persistBookRecord({
            targetTitle: derivedTitle,
            targetSubject: subject.trim() || 'বাংলাদেশ বিষয়াবলি',
            targetAuthor: author,
            targetCategory: effectiveCategory,
            targetChapter: chapterName,
            targetRawText: combined.rawText,
            targetMethod: 'text',
            targetExtractionResult: combined,
            targetExtractionContext: {
              status: 'success',
              actualPageCount: combined.actualPageCount,
              extractedPageCount: combined.extractedPageCount,
              missingOriginalPages: [],
              sourceWasUploadedPdf: false,
            },
            targetRawTextModified: false,
            sourceFile: file,
            existingDriveMeta: options?.existingDriveMeta ?? null,
          });
          if (!saved) {
            setShowAdvancedOptions(true);
          }
        } else {
          setShowAdvancedOptions(true);
        }

        return true;
      } finally {
        setExtracting(false);
      }
    }

    // AI Paper Cutting Vision path for newspaper/image photos (JPG, PNG, WebP)
    if (precheck.expectedKind === 'image') {
      const authHeaders = await getAiAuthHeaders();
      if (!authHeaders) {
        requestAiSignIn('ছবি / পেপার কাটিং থেকে AI ছোট প্রশ্ন তৈরি');
        return false;
      }

      setExtracting(true);
      setPipelineProgress({
        stage: 'validating',
        statusMessage:
          'ছবিটি AI দিয়ে পড়া হচ্ছে এবং গুরুত্বপূর্ণ তথ্য ছোট প্রশ্ন আকারে সাজানো হচ্ছে...',
        sessionId: null,
        fileName: file.name,
        fileSize: file.size,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        uploadedChunks: 0,
        totalChunks: 1,
        bytesUploaded: 0,
        actualPageCount: 1,
        originalPageRange: '1',
        currentBatch: 1,
        totalBatches: 1,
        completedPages: 0,
        totalPages: 1,
        localPagesCount: 0,
        ocrPagesCount: 1,
        ocrEnabled: true,
        ocrActive: true,
        saveReady: false,
        resumable: false,
      });

      try {
        const prepared = await prepareImageForPaperCuttingApi(file);
        URL.revokeObjectURL(prepared.previewUrl);

        const res = await fetch('/api/ai/paper-cutting', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            imageBase64: prepared.imageBase64,
            mimeType: prepared.mimeType,
            fileName: file.name,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) {
            requestAiSignIn('ছবি / পেপার কাটিং থেকে AI ছোট প্রশ্ন তৈরি');
          }
          const errMsg = formatAiResponseError(
            res.status,
            json,
            'ছবিটি থেকে গুরুত্বপূর্ণ তথ্য ও ছোট প্রশ্ন তৈরি করা যায়নি।'
          );
          setFormError(errMsg);
          setPipelineProgress(null);
          return false;
        }

        const analysis = json.analysis as PaperCuttingAnalysisResult;
        const formattedChunk = formatPaperCuttingForBookChunk(analysis, {
          fileName: file.name,
          driveFileId: options?.existingDriveMeta?.driveFileId ?? null,
        });
        const resolvedTitle =
          options?.overrideTitle?.trim() ||
          title.trim() ||
          `পেপার কাটিং — ${analysis.headline}`;
        const resolvedChapter = `${analysis.category} · ${analysis.eventDate}`;
        const formattedRaw = `--- পৃষ্ঠা 1 ---\n[${resolvedChapter}]\n${formattedChunk}`;

        const imageCombined: CombinedExtractionResult = {
          extractionStatus: 'success',
          method: 'ocr',
          ocrCompleted: true,
          actualPageCount: 1,
          expectedPageCount: 1,
          extractedPageCount: 1,
          originalPageRange: '1',
          totalBatches: 1,
          completedBatches: 1,
          failedBatches: 0,
          missingOriginalPages: [],
          duplicateOriginalPages: [],
          outOfOrderDetected: false,
          sections: [
            {
              chapter: resolvedChapter,
              pageNumber: 1,
              pdfPageIndex: 1,
              content: formattedChunk,
            },
          ],
          rawText: formattedRaw,
          meaningfulCharCount: formattedChunk.length,
          warnings: [],
        };

        setTitle(resolvedTitle);
        setSubject('সাম্প্রতিক সাধারণ জ্ঞান');
        setExtractionResult(imageCombined);
        setRawText(formattedRaw);
        setExtractionMethod('ocr');
        setPipelineProgress({
          stage: 'ready',
          statusMessage: `ছবিটি থেকে ${toBengaliNumber(analysis.shortQAs.length)}টি গুরুত্বপূর্ণ ছোট প্রশ্ন ও উত্তর তৈরি সম্পন্ন হয়েছে।`,
          sessionId: null,
          fileName: file.name,
          fileSize: file.size,
          maxUploadBytes: MAX_UPLOAD_BYTES,
          uploadedChunks: 1,
          totalChunks: 1,
          bytesUploaded: file.size,
          actualPageCount: 1,
          originalPageRange: '1',
          currentBatch: 1,
          totalBatches: 1,
          completedPages: 1,
          totalPages: 1,
          localPagesCount: 0,
          ocrPagesCount: 1,
          ocrEnabled: true,
          ocrActive: true,
          saveReady: true,
          resumable: false,
        });

        // Automatically sync extracted short Q&As into 06. Current GK -> Paper Cutting
        await addGkItem(
          serializePaperCuttingToGkInput(analysis, {
            fileName: file.name,
            driveFileId: options?.existingDriveMeta?.driveFileId ?? null,
            driveWebViewLink:
              options?.existingDriveMeta?.driveWebViewLink ?? null,
          })
        );

        if (autoSaveOnComplete) {
          const saved = await persistBookRecord({
            targetTitle: resolvedTitle,
            targetSubject: 'সাম্প্রতিক সাধারণ জ্ঞান',
            targetAuthor: analysis.newspaperSource || author || 'পেপার কাটিং',
            targetCategory:
              effectiveCategory === 'BCS' ? 'Current GK' : effectiveCategory,
            targetChapter: resolvedChapter,
            targetRawText: formattedRaw,
            targetMethod: 'ocr',
            targetExtractionResult: imageCombined,
            targetExtractionContext: {
              status: 'success',
              actualPageCount: 1,
              extractedPageCount: 1,
              missingOriginalPages: [],
              sourceWasUploadedPdf: false,
            },
            targetRawTextModified: false,
            sourceFile: file,
            existingDriveMeta: options?.existingDriveMeta ?? null,
          });
          if (saved) {
            setSaveSuccessNotice(
              `"${resolvedTitle}" থেকে ${toBengaliNumber(analysis.shortQAs.length)}টি ছোট প্রশ্ন ও উত্তর তৈরি করে Library এবং Current GK (Paper Cutting)-এ সংরক্ষণ করা হয়েছে।`
            );
          } else {
            setShowAdvancedOptions(true);
          }
        } else {
          setShowAdvancedOptions(true);
        }

        return true;
      } catch (err) {
        setFormError(
          err instanceof Error
            ? err.message
            : 'ছবি বিশ্লেষণ করতে সমস্যা হয়েছে।'
        );
        setPipelineProgress(null);
        return false;
      } finally {
        setExtracting(false);
      }
    }

    // Browser-side fast accelerator for PDFs:
    // 1. Slices optional page subset (e.g., 1-25) in-browser before uploading
    // 2. Extracts searchable Unicode & Bijoy/SutonnyMJ PDFs in ~1-2s with ZERO upload & ZERO AI calls
    let effectiveUploadFile = file;
    let effectivePageRange = originalPageRangeInput;

    if (precheck.expectedKind === 'pdf' && !options?.resumeSessionId) {
      setExtracting(true);
      setPipelineProgress({
        stage: 'validating',
        statusMessage: 'ব্রাউজারে দ্রুত PDF বিশ্লেষণ ও টেক্সট যাচাই চলছে...',
        sessionId: null,
        fileName: file.name,
        fileSize: file.size,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        uploadedChunks: 0,
        totalChunks: 1,
        bytesUploaded: 0,
        actualPageCount: null,
        originalPageRange: originalPageRangeInput.trim() || null,
        currentBatch: 0,
        totalBatches: 0,
        completedPages: 0,
        totalPages: null,
        ocrEnabled: true,
        ocrActive: null,
        ocrSpeed,
        saveReady: false,
        resumable: false,
      });

      const localPrecheck = await tryFastClientPdfPreprocess({
        file,
        pageRangeInput: originalPageRangeInput,
        pdfSubsetInput,
        fallbackChapter: chapterName.trim() || 'অধ্যায় ১',
        forceOcr,
        onStatus: (statusMessage) => {
          setPipelineProgress((prev) =>
            prev ? { ...prev, statusMessage } : prev
          );
        },
      });

      if (localPrecheck.kind === 'validation_error') {
        setExtracting(false);
        setFormError(localPrecheck.error);
        setPipelineProgress((prev) =>
          prev
            ? {
                ...prev,
                stage: 'failed',
                statusMessage: localPrecheck.error,
                saveReady: false,
              }
            : null
        );
        return false;
      }

      if (localPrecheck.kind === 'extracted_locally') {
        try {
          const combined = localPrecheck.extraction;
          const bijoyTag =
            localPrecheck.bijoyPagesConverted > 0
              ? ` · বিজয়→ইউনিকোড রূপান্তরিত (${toBengaliNumber(localPrecheck.bijoyPagesConverted)} পৃষ্ঠা)`
              : '';
          setExtractionResult(combined);
          setRawText(combined.rawText);
          setExtractionMethod('text');
          setPipelineProgress({
            stage: 'ready',
            statusMessage: `ব্রাউজারে তাৎক্ষণিক টেক্সট সংগ্রহ সম্পন্ন (${toBengaliNumber(combined.extractedPageCount)} পৃষ্ঠা${bijoyTag} · কোনো AI কোটা ব্যবহৃত হয়নি)।`,
            sessionId: null,
            fileName: localPrecheck.effectiveFile.name,
            fileSize: localPrecheck.effectiveFile.size,
            maxUploadBytes: MAX_UPLOAD_BYTES,
            uploadedChunks: 1,
            totalChunks: 1,
            bytesUploaded: localPrecheck.effectiveFile.size,
            actualPageCount: combined.actualPageCount,
            originalPageRange: combined.originalPageRange,
            currentBatch: 0,
            totalBatches: 0,
            completedPages: combined.extractedPageCount,
            totalPages: combined.actualPageCount,
            localPagesCount: combined.extractedPageCount,
            ocrPagesCount: 0,
            ocrEnabled: false,
            ocrActive: false,
            ocrSpeed,
            saveReady: true,
            resumable: false,
          });

          if (autoSaveOnComplete) {
            const saved = await persistBookRecord({
              targetTitle: derivedTitle,
              targetSubject: subject.trim() || 'বাংলাদেশ বিষয়াবলি',
              targetAuthor: author,
              targetCategory: effectiveCategory,
              targetChapter: chapterName,
              targetRawText: combined.rawText,
              targetMethod: 'text',
              targetExtractionResult: combined,
              targetExtractionContext: {
                status: 'success',
                actualPageCount: combined.actualPageCount,
                extractedPageCount: combined.extractedPageCount,
                missingOriginalPages: [],
                sourceWasUploadedPdf: true,
              },
              targetRawTextModified: false,
              sourceFile: localPrecheck.effectiveFile,
              existingDriveMeta: options?.existingDriveMeta ?? null,
            });
            if (!saved) {
              setShowAdvancedOptions(true);
            }
          } else {
            setShowAdvancedOptions(true);
          }
          return true;
        } finally {
          setExtracting(false);
        }
      }

      effectiveUploadFile = localPrecheck.effectiveFile;
      effectivePageRange = localPrecheck.effectivePageRangeInput;
      setEffectivePdfSourceFile(effectiveUploadFile);
      setExtracting(false);
    } else if (precheck.expectedKind === 'pdf') {
      setEffectivePdfSourceFile(file);
    }

    if (authResolving) {
      setFormError(AUTH_INITIALIZING_WAIT_MESSAGE);
      return false;
    }

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('PDF টেক্সট ও OCR এক্সট্র্যাকশন');
      return false;
    }

    const abortController = new AbortController();
    activeAbortRef.current = abortController;
    setExtracting(true);
    setResumableSessionId(null);

    try {
      const outcome = await runChunkedPdfPipeline({
        file: effectiveUploadFile,
        useOcr: true,
        ocrMode: forceOcr ? 'force' : 'auto',
        ocrSpeed,
        batchConcurrency:
          ocrSpeed === 'fast'
            ? FAST_OCR_BATCH_CONCURRENCY
            : ACCURATE_OCR_BATCH_CONCURRENCY,
        pageRangeInput: effectivePageRange,
        fallbackChapter: chapterName.trim() || 'অধ্যায় ১',
        resumeSessionId: options?.resumeSessionId ?? null,
        getAuthHeaders: getAiAuthHeaders,
        signal: abortController.signal,
        onUnauthorized: () => requestAiSignIn('PDF টেক্সট ও OCR এক্সট্র্যাকশন'),
        onProgress: (progress) => {
          if (progress.sessionId) {
            activeSessionIdRef.current = progress.sessionId;
          }
          setPipelineProgress(progress);
        },
      });

      if (!outcome.ok) {
        if (outcome.resumableSessionId) {
          setResumableSessionId(outcome.resumableSessionId);
        }
        if (outcome.quotaExhausted) {
          setQuotaCooldownSeconds(outcome.retryAfterSeconds ?? 35);
        }
        if (!outcome.unauthorized && !outcome.cancelled) {
          setFormError(outcome.error);
        }
        return false;
      }

      const combined = outcome.extraction;
      setExtractionResult(combined);
      setRawText(combined.rawText);
      setExtractionMethod(combined.method);
      activeSessionIdRef.current = null;
      setResumableSessionId(null);

      if (combined.extractionStatus !== 'success') {
        if (outcome.quotaExhausted) {
          setQuotaCooldownSeconds(outcome.retryAfterSeconds ?? 35);
        }
        if (combined.error) {
          setFormError(combined.error);
        }
        return false;
      }
      setQuotaCooldownSeconds(0);

      // One-step UX: when all pages succeeded and auto-save is enabled, save directly to Book Library!
      if (autoSaveOnComplete) {
        const isPdf =
          file.name.toLowerCase().endsWith('.pdf') ||
          file.type === 'application/pdf';
        const saved = await persistBookRecord({
          targetTitle: derivedTitle,
          targetSubject: subject.trim() || 'বাংলাদেশ বিষয়াবলি',
          targetAuthor: author,
          targetCategory: effectiveCategory,
          targetChapter: chapterName,
          targetRawText: combined.rawText,
          targetMethod: combined.method,
          targetExtractionResult: combined,
          targetExtractionContext: {
            status: combined.extractionStatus,
            actualPageCount: combined.actualPageCount,
            extractedPageCount: combined.extractedPageCount,
            missingOriginalPages: combined.missingOriginalPages,
            sourceWasUploadedPdf: isPdf,
          },
          targetRawTextModified: false,
          sourceFile: file,
          existingDriveMeta: options?.existingDriveMeta ?? null,
        });
        if (!saved) {
          setShowAdvancedOptions(true);
        }
      } else {
        setShowAdvancedOptions(true);
      }

      return true;
    } finally {
      activeAbortRef.current = null;
      setExtracting(false);
    }
  };

  const handleSelectedFile = async (file: File) => {
    setSelectedFile(file);
    setResumableSessionId(null);
    const ok = await runFileExtraction(file);
    if (!ok && file.size > MAX_UPLOAD_BYTES && fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleSelectedFile(file);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragActive(false);
    if (extracting || authResolving) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await handleSelectedFile(file);
  };

  const handleCancelExtraction = async () => {
    const controller = activeAbortRef.current;
    const sessionId = activeSessionIdRef.current ?? resumableSessionId;
    if (controller) {
      controller.abort();
    }
    if (sessionId) {
      await cancelPdfUploadSession({
        sessionId,
        getAuthHeaders: getAiAuthHeaders,
      });
    }
    activeSessionIdRef.current = null;
    setResumableSessionId(null);
    setExtracting(false);
  };

  const handleResumeUpload = async () => {
    if (!selectedFile || !resumableSessionId || extracting) return;
    await runFileExtraction(selectedFile, {
      resumeSessionId: resumableSessionId,
    });
  };

  const handleRetryExtraction = async () => {
    if (!selectedFile || extracting) return;
    setQuotaCooldownSeconds(0);
    await runFileExtraction(selectedFile);
  };

  /**
   * Smart Resume: slices ONLY the missing pages from the already-selected PDF in the browser
   * (e.g., 4 missing pages out of 100 -> ~0.7 MB, 1 single AI call!) and merges them cleanly
   * with all previously extracted pages — never wasting Free-Tier quota or re-OCRing completed pages.
   */
  const handleCompleteMissingPages = async () => {
    const sourceFile = effectivePdfSourceFile ?? selectedFile;
    if (
      !sourceFile ||
      !extractionResult ||
      extractionResult.missingOriginalPages.length === 0 ||
      extracting ||
      saving
    ) {
      return;
    }

    const isPdf =
      sourceFile.name.toLowerCase().endsWith('.pdf') ||
      sourceFile.type.toLowerCase() === 'application/pdf';
    if (!isPdf) {
      await handleRetryExtraction();
      return;
    }

    if (authResolving) {
      setFormError(AUTH_INITIALIZING_WAIT_MESSAGE);
      return;
    }

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('অনুপস্থিত পৃষ্ঠা OCR সম্পন্নকরণ');
      return;
    }

    const previousExtraction = extractionResult;
    const missingOriginalPages = previousExtraction.missingOriginalPages;
    const missingCount = missingOriginalPages.length;
    const alreadyDoneCount = previousExtraction.extractedPageCount;

    setFormError(null);
    setQuotaCooldownSeconds(0);
    setExtracting(true);

    const abortController = new AbortController();
    activeAbortRef.current = abortController;

    try {
      setPipelineProgress((prev) =>
        prev
          ? {
              ...prev,
              stage: 'splitting',
              statusMessage: `শুধু বাকি ${toBengaliNumber(missingCount)}টি পৃষ্ঠা আলাদা করা হচ্ছে (${toBengaliNumber(alreadyDoneCount)}টি সংরক্ষিত আছে)...`,
              quotaExhausted: false,
            }
          : prev
      );

      // Map original printed page numbers back to internal 1-based page indices inside `sourceFile`
      const fullMapping = buildPageMappings(
        previousExtraction.actualPageCount,
        previousExtraction.originalPageRange
      );
      const pdfIndexByOriginal = new Map<number, number>();
      const originalByPdfIndex = new Map<number, number>();
      if (fullMapping.ok) {
        for (const m of fullMapping.mappings) {
          pdfIndexByOriginal.set(m.originalPageNumber, m.pdfPageIndex);
          originalByPdfIndex.set(m.pdfPageIndex, m.originalPageNumber);
        }
      }

      const missingPdfIndices = missingOriginalPages.map(
        (orig) => pdfIndexByOriginal.get(orig) ?? orig
      );

      const sliced = await sliceSpecificPdfPagesInBrowser({
        file: sourceFile,
        pdfPageIndices: missingPdfIndices,
        originalPageNumberByPdfIndex: originalByPdfIndex,
      });

      const outcome = await runChunkedPdfPipeline({
        file: sliced.file,
        useOcr: true,
        ocrMode: 'force',
        ocrSpeed,
        batchConcurrency: Math.min(
          2,
          ocrSpeed === 'fast'
            ? FAST_OCR_BATCH_CONCURRENCY
            : ACCURATE_OCR_BATCH_CONCURRENCY
        ),
        pageRangeInput: '',
        fallbackChapter: chapterName.trim() || 'অধ্যায় ১',
        getAuthHeaders: getAiAuthHeaders,
        signal: abortController.signal,
        onUnauthorized: () => requestAiSignIn('অনুপস্থিত পৃষ্ঠা OCR সম্পন্নকরণ'),
        onProgress: (miniProgress) => {
          if (miniProgress.sessionId) {
            activeSessionIdRef.current = miniProgress.sessionId;
          }
          setPipelineProgress((prev) => ({
            ...(prev ?? miniProgress),
            stage: miniProgress.stage === 'ready' ? 'verifying_pages' : miniProgress.stage,
            statusMessage: `বাকি ${toBengaliNumber(missingCount)}টি পৃষ্ঠা সংগ্রহ হচ্ছে (${toBengaliNumber(alreadyDoneCount + miniProgress.completedPages)}/${toBengaliNumber(previousExtraction.actualPageCount)})...`,
            sessionId: miniProgress.sessionId,
            uploadedChunks: miniProgress.uploadedChunks,
            totalChunks: miniProgress.totalChunks,
            bytesUploaded: miniProgress.bytesUploaded,
            fileSize: sliced.file.size,
            completedPages: Math.min(
              previousExtraction.actualPageCount,
              alreadyDoneCount + miniProgress.completedPages
            ),
            totalPages: previousExtraction.actualPageCount,
            actualPageCount: previousExtraction.actualPageCount,
            originalPageRange: previousExtraction.originalPageRange,
            activeBatches: miniProgress.activeBatches,
            failedBatches: miniProgress.failedBatches,
            lastBatchError: miniProgress.lastBatchError,
            pagesPerSecond: miniProgress.pagesPerSecond,
            estimatedRemainingSeconds: miniProgress.estimatedRemainingSeconds,
          }));
        },
      });

      activeSessionIdRef.current = null;

      if (!outcome.ok) {
        if (outcome.quotaExhausted) {
          setQuotaCooldownSeconds(outcome.retryAfterSeconds ?? 35);
        }
        if (!outcome.unauthorized && !outcome.cancelled) {
          setFormError(outcome.error);
          setPipelineProgress((prev) =>
            prev
              ? {
                  ...prev,
                  stage: 'partial',
                  statusMessage: outcome.error,
                  completedPages: previousExtraction.extractedPageCount,
                  totalPages: previousExtraction.actualPageCount,
                  saveReady: false,
                  quotaExhausted: outcome.quotaExhausted,
                  retryAfterSeconds: outcome.retryAfterSeconds,
                }
              : prev
          );
        }
        return;
      }

      const merged = mergePartialExtractionWithRecoveredPages({
        previous: previousExtraction,
        recovered: outcome.extraction,
        requestedMissingTargets: sliced.targets,
        fallbackChapter: chapterName.trim() || 'অধ্যায় ১',
      });

      setExtractionResult(merged);
      setRawText(merged.rawText);
      setExtractionMethod(merged.method);
      setRawTextModified(false);

      if (merged.extractionStatus === 'success') {
        setQuotaCooldownSeconds(0);
        setFormError(null);
        setPipelineProgress({
          stage: 'ready',
          statusMessage: `সকল ${toBengaliNumber(merged.extractedPageCount)}টি পৃষ্ঠা সফলভাবে সম্পূর্ণ হয়েছে—Knowledge Base-এ সংরক্ষণের জন্য প্রস্তুত।`,
          sessionId: null,
          fileName: sourceFile.name,
          fileSize: sourceFile.size,
          maxUploadBytes: MAX_UPLOAD_BYTES,
          uploadedChunks: 1,
          totalChunks: 1,
          bytesUploaded: sourceFile.size,
          actualPageCount: merged.actualPageCount,
          originalPageRange: merged.originalPageRange,
          currentBatch: merged.totalBatches,
          totalBatches: merged.totalBatches,
          completedBatches: merged.completedBatches,
          failedBatches: 0,
          lastBatchError: null,
          completedPages: merged.extractedPageCount,
          totalPages: merged.actualPageCount,
          ocrEnabled: true,
          ocrActive: merged.ocrCompleted,
          ocrSpeed,
          saveReady: true,
          resumable: false,
        });

        if (autoSaveOnComplete) {
          const derivedTitle =
            title.trim() ||
            sourceFile.name.replace(/\.[^.]+$/, '').trim() ||
            'নতুন বই';
          const saved = await persistBookRecord({
            targetTitle: derivedTitle,
            targetSubject: subject.trim() || 'বাংলাদেশ বিষয়াবলি',
            targetAuthor: author,
            targetCategory: category,
            targetChapter: chapterName,
            targetRawText: merged.rawText,
            targetMethod: merged.method,
            targetExtractionResult: merged,
            targetExtractionContext: {
              status: 'success',
              actualPageCount: merged.actualPageCount,
              extractedPageCount: merged.extractedPageCount,
              missingOriginalPages: [],
              sourceWasUploadedPdf: true,
            },
            targetRawTextModified: false,
            sourceFile,
          });
          if (!saved) {
            setShowAdvancedOptions(true);
          }
        } else {
          setShowAdvancedOptions(true);
        }
      } else {
        if (outcome.quotaExhausted) {
          setQuotaCooldownSeconds(outcome.retryAfterSeconds ?? 35);
        }
        const partialMsg =
          (outcome.quotaExhausted ? outcome.extraction.error : null) ||
          merged.error ||
          `এখন পর্যন্ত ${toBengaliNumber(merged.extractedPageCount)}/${toBengaliNumber(merged.actualPageCount)} পৃষ্ঠা সম্পন্ন হয়েছে।`;
        setFormError(partialMsg);
        setPipelineProgress((prev) =>
          prev
            ? {
                ...prev,
                stage: 'partial',
                statusMessage: partialMsg,
                completedPages: merged.extractedPageCount,
                totalPages: merged.actualPageCount,
                actualPageCount: merged.actualPageCount,
                failedBatches: 0,
                saveReady: false,
                quotaExhausted: outcome.quotaExhausted,
                retryAfterSeconds: outcome.retryAfterSeconds,
              }
            : prev
        );
      }
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : 'বাকি পৃষ্ঠাগুলো আলাদা করে প্রসেস করতে সমস্যা হয়েছে।'
      );
    } finally {
      activeAbortRef.current = null;
      setExtracting(false);
    }
  };

  const handleCreateBook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saveInFlightRef.current || saving || extracting) {
      return;
    }

    setFormError(null);
    await persistBookRecord({
      targetTitle: title,
      targetSubject: subject,
      targetAuthor: author,
      targetCategory: category,
      targetChapter: chapterName,
      targetRawText: rawText,
      targetMethod: extractionMethod,
      targetExtractionResult: extractionResult,
      targetExtractionContext: extractionContext,
      targetRawTextModified: rawTextModified,
      sourceFile: selectedFile,
    });
  };

  const uploadPercent = useMemo(() => {
    if (!pipelineProgress || pipelineProgress.fileSize <= 0) return 0;
    const ratio = pipelineProgress.bytesUploaded / pipelineProgress.fileSize;
    return Math.min(100, Math.max(0, Math.round(ratio * 100)));
  }, [pipelineProgress]);

  const canSubmitBook =
    !saving &&
    !extracting &&
    !(
      extractionContext?.sourceWasUploadedPdf &&
      extractionContext.status !== 'success'
    );

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-6">
        <div className="max-w-2xl">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            01. বইয়ের লাইব্রেরি ও Knowledge Base
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
            শুধু PDF বা Word (.docx) আপলোড করুন (সর্বোচ্চ ১০০ MB)—টেক্সট থাকলে তাৎক্ষণিকভাবে সংগ্রহ হবে, স্ক্যান করা PDF হলে স্বয়ংক্রিয় AI OCR সম্পন্ন হয়ে লাইব্রেরিতে সংরক্ষিত হবে।
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setSaveSuccessNotice(null);
            setShowAddForm((v) => !v);
          }}
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

      {/* Auto-Save / Save Success Banner */}
      {saveSuccessNotice && (
        <div
          role="status"
          data-testid="book-save-success"
          className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          <div className="flex items-center gap-2.5 font-medium">
            <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
            <span>{saveSuccessNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setSaveSuccessNotice(null)}
            aria-label="সফলতার বার্তা বন্ধ করুন"
            className="rounded-md p-1 text-emerald-700 hover:bg-emerald-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Summary Metric Strip */}
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

      {/* Google Drive Folder Sync Strip */}
      <section
        aria-label="Google Drive ফোল্ডার সিঙ্ক"
        data-testid="google-drive-sync-bar"
        className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                driveConnected
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-blue-50 text-blue-700'
              }`}
            >
              <HardDrive className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <h2 className="text-sm font-semibold text-slate-900">
                  Google Drive ফোল্ডার সিঙ্ক
                </h2>
                <span
                  data-testid="google-drive-status"
                  className={`text-xs font-medium ${
                    driveConnected ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {driveConnected
                    ? 'সংযুক্ত (সেভ ও ডিলিট সিঙ্ক সক্রিয়)'
                    : 'সংযুক্ত নয় (সেশন অনুমোদন প্রয়োজন)'}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">
                সেভের গন্তব্য:{' '}
                <strong className="font-medium text-slate-700">
                  {driveFolderLabel}
                </strong>{' '}
                — বই সেভ করলে এখানে আপলোড হবে এবং মুছে ফেললে Drive থেকেও ডিলিট হবে।{' '}
                <a
                  href={driveFolderUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline"
                >
                  <span>সেভ ফোল্ডার দেখুন</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <label
              htmlFor="drive-auto-sync-toggle"
              className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none"
            >
              <input
                id="drive-auto-sync-toggle"
                type="checkbox"
                checked={syncToDriveOnSave}
                onChange={(e) => setSyncToDriveOnSave(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <span>সেভ করলে Drive-এ পাঠান</span>
            </label>

            <button
              type="button"
              data-testid="toggle-drive-importer-btn"
              onClick={() => {
                setDriveImportError(null);
                setShowDriveImporter((v) => !v);
              }}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                showDriveImporter
                  ? 'border-blue-600 bg-blue-50 text-blue-800'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
              }`}
            >
              <FolderOpen className="h-3.5 w-3.5 text-blue-700" />
              <span>Drive ফোল্ডার থেকে বই যুক্ত করুন</span>
            </button>

            {!driveConnected && (
              <button
                type="button"
                data-testid="connect-google-drive-btn"
                disabled={connectingDrive || authResolving}
                onClick={() => void handleConnectGoogleDrive()}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {connectingDrive ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700" />
                ) : (
                  <HardDrive className="h-3.5 w-3.5 text-blue-700" />
                )}
                <span>
                  {connectingDrive
                    ? 'সংযুক্ত হচ্ছে...'
                    : 'Google Drive সংযুক্ত করুন'}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Existing Google Drive Library Folder Importer Panel */}
        {showDriveImporter && (
          <div
            data-testid="google-drive-importer-panel"
            className="rounded-lg border border-slate-200 bg-slate-50/80 p-4 space-y-3"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-xs font-semibold text-slate-900">
                  আগে থেকে Google Drive-এ থাকা বই বা পেপার কাটিং ফটো অ্যাপে সংযুক্ত করুন
                </h3>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  আপনার Drive ফোল্ডারের PDF, Word (.docx), Google Docs, টেক্সট অথবা পেপার কাটিং ফটো (JPG/PNG/WebP) সরাসরি ইমপোর্ট করুন—ফটো ইমপোর্ট করলে AI স্বয়ংক্রিয়ভাবে ছোট প্রশ্ন তৈরি করে Library ও Current GK-তে সংরক্ষণ করবে।
                </p>
              </div>
              <a
                href={
                  importFolderUrlInput.startsWith('https://drive.google.com/')
                    ? importFolderUrlInput
                    : driveImportFolderUrl
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
              >
                <span>নির্বাচিত ফোল্ডার খুলুন</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            {/* Quick Folder Presets: Main Library vs Dedicated Paper Cutting Photos Folder */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold text-slate-600">
                দ্রুত ফোল্ডার নির্বাচন:
              </span>
              <button
                type="button"
                data-testid="drive-preset-library-btn"
                onClick={() => {
                  setImportFolderUrlInput(driveImportFolderUrl);
                  setImportCategory('BCS');
                  setDriveImportError(null);
                }}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  importFolderUrlInput.trim() === driveImportFolderUrl
                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <FolderOpen className="h-3 w-3" />
                <span>মূল লাইব্রেরি ফোল্ডার</span>
              </button>
              <button
                type="button"
                data-testid="drive-preset-paper-cutting-btn"
                onClick={() => {
                  setImportFolderUrlInput(PAPER_CUTTING_DRIVE_FOLDER_URL);
                  setImportCategory('Current GK');
                  setDriveImportError(null);
                }}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  importFolderUrlInput.includes('1WZlt8I7B0pISMEkaYOxv_36gvs-kdsNW')
                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Newspaper className="h-3 w-3" />
                <span>পেপার কাটিং ফটো ফোল্ডার</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
              <div className="sm:col-span-6">
                <label
                  htmlFor="drive-import-folder-url"
                  className="block text-[11px] font-semibold text-slate-700"
                >
                  Google Drive ফোল্ডার লিংক বা আইডি
                </label>
                <input
                  id="drive-import-folder-url"
                  type="text"
                  value={importFolderUrlInput}
                  onChange={(e) => setImportFolderUrlInput(e.target.value)}
                  placeholder="https://drive.google.com/drive/folders/..."
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div className="sm:col-span-3">
                <label
                  htmlFor="drive-import-category"
                  className="block text-[11px] font-semibold text-slate-700"
                >
                  ইমপোর্ট ক্যাটাগরি
                </label>
                <select
                  id="drive-import-category"
                  value={importCategory}
                  onChange={(e) =>
                    setImportCategory(e.target.value as BookCategory)
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                >
                  {BOOK_CATEGORY_OPTIONS.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-3 flex items-end">
                <button
                  type="button"
                  data-testid="load-drive-folder-files-btn"
                  disabled={loadingDriveFiles || authResolving}
                  onClick={() => void handleLoadDriveFolderFiles()}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
                >
                  {loadingDriveFiles ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {loadingDriveFiles
                      ? 'লোড হচ্ছে...'
                      : driveFilesLoadedOnce
                        ? 'তালিকা রিফ্রেশ করুন'
                        : 'ফোল্ডারের ফাইল দেখুন'}
                  </span>
                </button>
              </div>
            </div>

            {bulkDriveImageStatus && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-900"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700 shrink-0" />
                <span>{bulkDriveImageStatus}</span>
              </div>
            )}

            {driveImportError && (
              <p
                role="alert"
                data-testid="drive-import-error"
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
              >
                {driveImportError}
              </p>
            )}

            {driveFilesLoadedOnce && driveFolderFiles.length === 0 && (
              <p className="rounded-md border border-slate-200 bg-white px-3 py-3 text-xs text-slate-600 text-center">
                এই ফোল্ডারে কোনো সমর্থিত বই (PDF, .docx, Google Docs, TXT/MD বা ছবি) পাওয়া যায়নি।
              </p>
            )}

            {/* Batch Action Strip when Folder Contains Paper Cutting Photos */}
            {driveImageFilesInFolder.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-2">
                <div className="text-xs text-slate-800">
                  <span className="font-semibold">
                    {toBengaliNumber(driveImageFilesInFolder.length)}টি ছবি (Paper Cutting) পাওয়া গেছে
                  </span>{' '}
                  — নির্বাচিত ফটোগুলো থেকে একসাথে AI ছোট প্রশ্ন তৈরি হয়ে Library ও Current GK-তে যুক্ত হবে।
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={Boolean(bulkDriveImageStatus)}
                    onClick={() => {
                      const unimported = driveImageFilesInFolder
                        .filter((f) => !importedDriveFileIdSet.has(f.id))
                        .map((f) => f.id);
                      setSelectedDriveImageIds(
                        selectedDriveImageIds.length === unimported.length
                          ? []
                          : unimported
                      );
                    }}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    সব নতুন ছবি নির্বাচন
                  </button>
                  <button
                    type="button"
                    data-testid="bulk-import-drive-images-btn"
                    disabled={
                      selectedDriveImageIds.length === 0 ||
                      Boolean(bulkDriveImageStatus) ||
                      extracting ||
                      saving
                    }
                    onClick={() => void handleBulkImportDriveImages()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>
                      নির্বাচিত ({toBengaliNumber(selectedDriveImageIds.length)}) ফটো Add ও AI ছোট প্রশ্ন তৈরি
                    </span>
                  </button>
                </div>
              </div>
            )}

            {driveFolderFiles.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white divide-y divide-slate-200 max-h-64 overflow-y-auto">
                {driveFolderFiles.map((df) => {
                  const alreadyImported = importedDriveFileIdSet.has(df.id);
                  const isImportingThis = importingDriveFileId === df.id;
                  const isImageFile = df.kindLabel === 'Image';
                  const isChecked = selectedDriveImageIds.includes(df.id);
                  return (
                    <div
                      key={df.id}
                      className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex items-center gap-2.5">
                        {isImageFile && (
                          <input
                            type="checkbox"
                            aria-label={`ছবি নির্বাচন: ${df.name}`}
                            checked={isChecked}
                            disabled={
                              alreadyImported || Boolean(bulkDriveImageStatus)
                            }
                            onChange={() =>
                              setSelectedDriveImageIds((prev) =>
                                prev.includes(df.id)
                                  ? prev.filter((id) => id !== df.id)
                                  : [...prev, df.id]
                              )
                            }
                            className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600 shrink-0"
                          />
                        )}
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="text-xs font-semibold text-slate-900 truncate">
                            {df.name}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500">
                            · {isImageFile ? 'ছবি (Paper Cutting)' : df.kindLabel}
                          </span>
                          {df.size > 0 && (
                            <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                              · {formatFileSize(df.size)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <a
                          href={df.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          <span>দেখুন</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                        {alreadyImported ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 px-2 py-1">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>ইতিমধ্যে যুক্ত আছে</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={
                              importingDriveFileId !== null ||
                              Boolean(bulkDriveImageStatus) ||
                              extracting ||
                              saving
                            }
                            onClick={() => void handleImportDriveFile(df)}
                            className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
                          >
                            {isImportingThis ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : isImageFile ? (
                              <Sparkles className="h-3 w-3" />
                            ) : (
                              <Download className="h-3 w-3" />
                            )}
                            <span>
                              {isImportingThis
                                ? 'প্রসেস হচ্ছে...'
                                : isImageFile
                                  ? 'Add ও ছোট প্রশ্ন তৈরি'
                                  : 'লাইব্রেরিতে যুক্ত করুন'}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {driveNotice && (
          <div
            role={driveNotice.tone === 'error' ? 'alert' : 'status'}
            data-testid="google-drive-notice"
            className={`flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-xs font-medium leading-relaxed ${
              driveNotice.tone === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : driveNotice.tone === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            <span>{driveNotice.message}</span>
            <button
              type="button"
              onClick={() => setDriveNotice(null)}
              aria-label="বার্তা বন্ধ করুন"
              className="rounded p-0.5 opacity-70 hover:opacity-100 shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </section>

      {/* Offline Study Vault & Service Worker Cache Strip */}
      <section
        aria-label="অফলাইন লাইব্রেরি ও ক্যাশ"
        data-testid="offline-library-panel"
        className="rounded-xl border border-slate-200 bg-white p-4 space-y-2.5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                !isOnline
                  ? 'bg-amber-50 text-amber-700'
                  : swStatus?.active || offlineSavedAt
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-slate-100 text-slate-600'
              }`}
            >
              {!isOnline ? (
                <WifiOff className="h-4 w-4" />
              ) : (
                <Database className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <h2 className="text-sm font-semibold text-slate-900">
                  অফলাইন লাইব্রেরি ও স্টাডি ক্যাশ
                </h2>
                <span
                  data-testid="offline-cache-status"
                  className={`text-xs font-medium ${
                    !isOnline
                      ? 'text-amber-700'
                      : swStatus?.active || offlineSavedAt
                        ? 'text-emerald-700'
                        : 'text-slate-500'
                  }`}
                >
                  {!isOnline
                    ? 'অফলাইন মোডে সংরক্ষিত কপি থেকে চলছে'
                    : swStatus?.active
                      ? 'সক্রিয় (ইন্টারনেট ছাড়াও পড়া যাবে)'
                      : 'অফলাইন ক্যাশ প্রস্তুত হচ্ছে'}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">
                সংরক্ষিত:{' '}
                <strong className="font-medium text-slate-700">
                  {toBengaliNumber(offlineSummary.booksCount)}টি বই
                </strong>
                {' · '}
                {toBengaliNumber(offlineSummary.chunksCount)}টি অধ্যায়/অংশ
                {' · '}
                {toBengaliNumber(offlineSummary.questionsCount)}টি প্রশ্ন
                {cachedPdfsMeta.length > 0 && (
                  <>
                    {' · '}
                    <strong className="font-medium text-slate-700">
                      {toBengaliNumber(cachedPdfsMeta.length)}টি মূল PDF (
                      {formatOfflineBytes(cachedPdfTotalBytes)})
                    </strong>
                  </>
                )}
                {offlineSavedAt && (
                  <>
                    {' · '}
                    সর্বশেষ সেভ:{' '}
                    <span className="font-mono text-[11px] tabular-nums">
                      {new Date(offlineSavedAt).toLocaleTimeString('bn-BD', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="offline-sync-now-btn"
              disabled={syncingOffline}
              onClick={() => void handleSyncOfflineNow()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {syncingOffline ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700" />
              ) : (
                <Download className="h-3.5 w-3.5 text-blue-700" />
              )}
              <span>
                {syncingOffline
                  ? 'অফলাইনে সেভ হচ্ছে...'
                  : 'অফলাইনের জন্য সব সেভ করুন'}
              </span>
            </button>
          </div>
        </div>

        {offlineSyncNotice && (
          <div
            role="status"
            data-testid="offline-sync-notice"
            className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900"
          >
            <span>{offlineSyncNotice}</span>
            <button
              type="button"
              onClick={() => setOfflineSyncNotice(null)}
              aria-label="বার্তা বন্ধ করুন"
              className="rounded p-0.5 text-emerald-700 hover:bg-emerald-100 shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </section>

      {/* Simplified One-Step Add Book / PDF Upload Form */}
      {showAddForm && (
        <section
          aria-label="নতুন বই বা PDF আপলোড ফর্ম"
          className="rounded-xl border border-slate-200 bg-white p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                এক ধাপে PDF বা Word (.docx) বই যুক্ত করুন
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                সর্বোচ্চ {toBengaliNumber(MAX_UPLOAD_MB)} MB · Word (.docx) ও সার্চেবল PDF তাৎক্ষণিকভাবে (০ AI কল), স্ক্যান করা অংশে স্বয়ংক্রিয় AI OCR।
              </p>
            </div>

            <label
              htmlFor="book-auto-save-toggle"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
            >
              <input
                id="book-auto-save-toggle"
                type="checkbox"
                checked={autoSaveOnComplete}
                disabled={extracting || saving}
                onChange={(e) => setAutoSaveOnComplete(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <span>সম্পন্ন হলে স্বয়ংক্রিয়ভাবে সংরক্ষণ করুন</span>
            </label>
          </div>

          <form onSubmit={handleCreateBook} className="mt-5 space-y-5">
            {/* Compact Book Metadata Row (Auto-filled on PDF selection) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <label
                  htmlFor="book-title-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  বইয়ের নাম * <span className="font-normal text-slate-400">(খালি রাখলে ফাইলের নাম বসবে)</span>
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
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
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
                  {BOOK_CATEGORY_OPTIONS.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Option (ক): Format (MCQ / Written) & Virtual Master Book Folder Controls */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3.5">
              <div>
                <label
                  htmlFor="book-upload-format-select"
                  className="block text-xs font-semibold text-slate-700"
                >
                  বইয়ের ধরন (MCQ / Written আলাদা করুন)
                </label>
                <select
                  id="book-upload-format-select"
                  data-testid="book-upload-format-select"
                  value={uploadFormat}
                  disabled={extracting || saving}
                  onChange={(e) =>
                    setUploadFormat(e.target.value as '' | BookContentFormat)
                  }
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  <option value="">স্বয়ংক্রিয় শনাক্ত (নাম ও প্রশ্ন দেখে)</option>
                  <option value="MCQ">MCQ (বহুনির্বাচনি)</option>
                  <option value="Written">Written (লিখিত)</option>
                  <option value="Combined">MCQ + Written (সমন্বিত)</option>
                  <option value="Textbook">মূল বই / নোট (বিষয়ভিত্তিক)</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="book-upload-master-folder-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  মাস্টার বই ফোল্ডার (Option ক — খণ্ডগুলো ১টি ফোল্ডারে রাখুন)
                </label>
                <input
                  id="book-upload-master-folder-input"
                  data-testid="book-upload-master-folder-input"
                  type="text"
                  list="existing-virtual-master-folders"
                  disabled={extracting || saving}
                  value={uploadMasterFolderName}
                  onChange={(e) => setUploadMasterFolderName(e.target.value)}
                  placeholder="খালি রাখলে নাম দেখে অটো-গ্রুপ হবে (যেমন: রিসেন্ট জব সলুশন ২০২৬ MCQ)"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                />
                <datalist id="existing-virtual-master-folders">
                  {existingMasterFolderSuggestions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>
            </div>

            {/* Multi-Part Series Append Option */}
            {data.books.length > 0 && (
              <div className="rounded-lg border border-blue-200/80 bg-blue-50/50 p-3.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <label
                    htmlFor="append-to-existing-book-select"
                    className="flex items-center gap-1.5 text-xs font-semibold text-slate-900"
                  >
                    <Layers className="h-3.5 w-3.5 text-blue-700 shrink-0" />
                    <span>এটি কি কোনো বইয়ের পরবর্তী পার্ট (Part 02, Part 03...)?</span>
                  </label>
                  <p className="mt-0.5 text-[11px] text-slate-600">
                    বিদ্যমান বই বেছে নিলে নতুন পার্টটি স্বয়ংক্রিয়ভাবে একই বইয়ের পরবর্তী পৃষ্ঠা হিসেবে যুক্ত হবে (অথবা আলাদা পার্ট হিসেবে সেভ করলেও AI নাম দেখে একত্রে চিনে নেবে)।
                  </p>
                </div>
                <select
                  id="append-to-existing-book-select"
                  data-testid="append-to-book-select"
                  value={appendToBookId ?? ''}
                  disabled={extracting || saving}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) {
                      setAppendToBookId(null);
                    } else {
                      const targetId = Number(val);
                      setAppendToBookId(targetId);
                      const chosen = data.books.find((b) => b.id === targetId);
                      if (chosen) {
                        if (!title.trim()) setTitle(chosen.title);
                        setSubject(chosen.subject);
                        setCategory(chosen.category);
                      }
                    }
                  }}
                  className="sm:w-72 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  <option value="">নতুন বই হিসেবে সংরক্ষণ করুন</option>
                  {data.books.map((b) => (
                    <option key={b.id} value={b.id}>
                      পার্ট যুক্ত করুন → {b.title} ({b.totalPages} পৃষ্ঠা)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Clean Drag & Drop / One-Click Upload Zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!extracting && !authResolving) setIsDragActive(true);
              }}
              onDragLeave={() => setIsDragActive(false)}
              onDrop={(e) => void handleDrop(e)}
              className={`rounded-xl border-2 border-dashed p-5 transition-colors space-y-4 ${
                isDragActive
                  ? 'border-blue-600 bg-blue-50/70'
                  : 'border-slate-300 bg-slate-50/80'
              }`}
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
                    <FileUp className="h-5 w-5" />
                  </div>
                  <div>
                    <label
                      htmlFor="pdf-file-upload"
                      className="block text-sm font-semibold text-slate-900 cursor-pointer"
                    >
                      PDF, Word (.docx), ছবি (PNG/JPEG/WebP) বা টেক্সট (TXT/MD) ফাইল নির্বাচন বা ড্রপ করুন
                    </label>
                    <p className="text-xs text-slate-500 mt-0.5">
                      সর্বোচ্চ ১০০ MB ({MAX_UPLOAD_MB} MB) · ডিজিটাল/বিজয় PDF ও Word (.docx) ব্রাউজারেই ১–২ সেকেন্ডে প্রসেস হয়, স্ক্যান PDF ৩× প্যারালাল টার্বো OCR-এ চলে
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {!extracting && (
                    <button
                      type="button"
                      disabled={authResolving}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
                    >
                      <FileUp className="h-3.5 w-3.5" />
                      <span>{selectedFile ? 'অন্য ফাইল বাছাই করুন' : 'ফাইল বাছাই করুন'}</span>
                    </button>
                  )}
                  {extracting && (
                    <button
                      type="button"
                      onClick={() => void handleCancelExtraction()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 transition-colors"
                    >
                      <Square className="h-3 w-3 fill-current" />
                      <span>বাতিল করুন</span>
                    </button>
                  )}
                  {!extracting &&
                    selectedFile &&
                    extractionResult &&
                    extractionResult.extractionStatus === 'partial' &&
                    extractionResult.missingOriginalPages.length > 0 && (
                      <button
                        type="button"
                        data-testid="resume-missing-pages-top-btn"
                        onClick={() => void handleCompleteMissingPages()}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
                      >
                        <Zap className="h-3.5 w-3.5" />
                        <span>
                          বাকি {toBengaliNumber(extractionResult.missingOriginalPages.length)}টি পৃষ্ঠা সম্পন্ন করুন
                        </span>
                      </button>
                    )}
                  {!extracting && selectedFile && resumableSessionId && (
                    <button
                      type="button"
                      onClick={() => void handleResumeUpload()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>অসম্পূর্ণ আপলোড চালিয়ে যান</span>
                    </button>
                  )}
                  {!extracting && selectedFile && !resumableSessionId && (
                    <button
                      type="button"
                      onClick={() => void handleRetryExtraction()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>শুরু থেকে চেষ্টা করুন</span>
                    </button>
                  )}
                </div>

                <input
                  ref={fileInputRef}
                  id="pdf-file-upload"
                  type="file"
                  accept=".pdf,.docx,.txt,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp"
                  disabled={extracting || authResolving}
                  onChange={handleFileChange}
                  className="sr-only"
                />
              </div>

              {/* Speed Mode & Fast Page Slice Controls */}
              <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white/90 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                    <Gauge className="h-3.5 w-3.5 text-blue-700" />
                    <span>OCR মোড:</span>
                  </span>
                  <div
                    role="group"
                    aria-label="OCR প্রসেসিং স্পিড মোড"
                    className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5"
                  >
                    <button
                      type="button"
                      disabled={extracting}
                      aria-pressed={ocrSpeed === 'accurate'}
                      onClick={() => setOcrSpeed('accurate')}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                        ocrSpeed === 'accurate'
                          ? 'bg-blue-700 text-white shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      উচ্চ নির্ভুলতা (নির্ভুল বানান, টেবিল ও ফরম্যাট)
                    </button>
                    <button
                      type="button"
                      disabled={extracting}
                      aria-pressed={ocrSpeed === 'fast'}
                      onClick={() => setOcrSpeed('fast')}
                      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                        ocrSpeed === 'fast'
                          ? 'bg-slate-900 text-white shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Zap className="h-3 w-3" />
                      <span>দ্রুত (টার্বো)</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor="pdf-page-subset-input"
                    className="text-xs font-semibold text-slate-700 whitespace-nowrap"
                  >
                    PDF অংশ বাছাই:
                  </label>
                  <select
                    aria-label="দ্রুত পৃষ্ঠা প্রিসেট"
                    disabled={extracting}
                    value={
                      pdfSubsetInput === '' ||
                      pdfSubsetInput === '1-25' ||
                      pdfSubsetInput === '1-50'
                        ? pdfSubsetInput
                        : 'custom'
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val !== 'custom') {
                        setPdfSubsetInput(val);
                      }
                    }}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 focus:border-blue-600 focus:outline-none disabled:opacity-50"
                  >
                    <option value="">সব পৃষ্ঠা</option>
                    <option value="1-25">প্রথম ২৫ পৃষ্ঠা (খুব দ্রুত)</option>
                    <option value="1-50">প্রথম ৫০ পৃষ্ঠা</option>
                    <option value="custom">কাস্টম রেঞ্জ</option>
                  </select>
                  <input
                    id="pdf-page-subset-input"
                    type="text"
                    disabled={extracting}
                    value={pdfSubsetInput}
                    onChange={(e) => setPdfSubsetInput(e.target.value)}
                    placeholder="যেমন: 1-25 বা 26-50"
                    className="w-36 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:opacity-50"
                  />
                </div>
              </div>

              {/* Real Server-Confirmed Upload & Extraction Status Panel */}
              {pipelineProgress && (
                <div
                  data-testid="pdf-pipeline-status"
                  className="rounded-lg border border-slate-200 bg-white p-3.5 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold">
                      {extracting || saving ? (
                        <Loader2 className="h-4 w-4 animate-spin text-blue-700 shrink-0" />
                      ) : pipelineProgress.stage === 'ready' ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
                      ) : pipelineProgress.stage === 'partial' ? (
                        <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-red-700 shrink-0" />
                      )}
                      <span
                        className={
                          pipelineProgress.stage === 'ready'
                            ? 'text-emerald-800'
                            : pipelineProgress.stage === 'partial'
                              ? 'text-amber-800'
                              : pipelineProgress.stage === 'failed'
                                ? 'text-red-700'
                                : 'text-slate-900'
                        }
                      >
                        {saving ? 'Knowledge Base-এ সংরক্ষণ করা হচ্ছে...' : pipelineProgress.statusMessage}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-slate-500 tabular-nums">
                      {formatFileSize(pipelineProgress.fileSize)} / {MAX_UPLOAD_MB} MB
                    </span>
                  </div>

                  {/* Upload Progress Bar */}
                  {pipelineProgress.totalChunks > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-slate-600">
                        <span>
                          আপলোড অগ্রগতি: Chunk {toBengaliNumber(pipelineProgress.uploadedChunks)}/
                          {toBengaliNumber(pipelineProgress.totalChunks)} (
                          {formatFileSize(pipelineProgress.bytesUploaded)})
                        </span>
                        <span className="font-mono tabular-nums">{uploadPercent}%</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                        <div
                          className={`h-full transition-all duration-200 ${
                            pipelineProgress.stage === 'failed'
                              ? 'bg-red-600'
                              : pipelineProgress.stage === 'ready'
                                ? 'bg-emerald-600'
                                : 'bg-blue-700'
                          }`}
                          style={{ width: `${uploadPercent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Parallel OCR Extraction Progress Bar (separate from Upload bar) */}
                  {pipelineProgress.totalBatches > 0 && pipelineProgress.totalPages && pipelineProgress.totalPages > 0 && (
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                        <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
                          <Zap className="h-3 w-3 text-blue-700" />
                          <span>
                            OCR অগ্রগতি: {toBengaliNumber(pipelineProgress.completedPages)}/
                            {toBengaliNumber(pipelineProgress.totalPages)} পৃষ্ঠা
                            {pipelineProgress.activeBatches && pipelineProgress.activeBatches > 1
                              ? ` · একসাথে ${toBengaliNumber(pipelineProgress.activeBatches)}টি ব্যাচ চালু`
                              : ''}
                            {pipelineProgress.pagesPerSecond
                              ? ` · গতি ~${toBengaliNumber(pipelineProgress.pagesPerSecond)} পৃষ্ঠা/সে.`
                              : ''}
                            {pipelineProgress.estimatedRemainingSeconds
                              ? ` · বাকি ~${toBengaliNumber(pipelineProgress.estimatedRemainingSeconds)} সে.`
                              : ''}
                          </span>
                        </span>
                        <span className="font-mono font-semibold text-blue-700 tabular-nums">
                          {Math.min(
                            100,
                            Math.round(
                              (pipelineProgress.completedPages / pipelineProgress.totalPages) * 100
                            )
                          )}
                          %
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                        <div
                          className={`h-full transition-all duration-300 ${
                            pipelineProgress.stage === 'failed'
                              ? 'bg-red-600'
                              : pipelineProgress.stage === 'ready'
                                ? 'bg-emerald-600'
                                : 'bg-indigo-600'
                          }`}
                          style={{
                            width: `${Math.min(
                              100,
                              Math.round(
                                (pipelineProgress.completedPages / pipelineProgress.totalPages) * 100
                              )
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Immediate Batch Failure Alert (never render stray 0 when failedBatches === 0!) */}
                  {(pipelineProgress.failedBatches ?? 0) > 0 &&
                    Boolean(pipelineProgress.lastBatchError) && (
                      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        সতর্কতা ({toBengaliNumber(pipelineProgress.failedBatches ?? 0)}টি ব্যাচে সমস্যা):{' '}
                        {pipelineProgress.lastBatchError}
                      </p>
                    )}

                  {/* Concise Metadata Grid */}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-100 pt-2.5 text-xs sm:grid-cols-3 lg:grid-cols-6">
                    <div>
                      <dt className="text-[11px] text-slate-500">নির্বাচিত ফাইল</dt>
                      <dd className="font-medium text-slate-800 truncate" title={pipelineProgress.fileName}>
                        {pipelineProgress.fileName}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500">প্রকৃত PDF পৃষ্ঠা</dt>
                      <dd className="font-mono font-medium text-slate-800 tabular-nums">
                        {pipelineProgress.actualPageCount !== null
                          ? `${toBengaliNumber(pipelineProgress.actualPageCount)} পৃষ্ঠা`
                          : 'অপেক্ষমাণ'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500">মূল পৃষ্ঠা রেঞ্জ</dt>
                      <dd className="font-mono font-medium text-slate-800 tabular-nums">
                        {pipelineProgress.originalPageRange ?? 'স্বয়ংক্রিয়'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500">প্রসেসিং পদ্ধতি</dt>
                      <dd className="font-medium text-slate-800">
                        {pipelineProgress.localPagesCount !== undefined &&
                        pipelineProgress.ocrPagesCount === 0
                          ? 'সরাসরি টেক্সট (তাৎক্ষণিক)'
                          : pipelineProgress.localPagesCount &&
                              pipelineProgress.localPagesCount > 0
                            ? `টেক্সট + ${pipelineProgress.ocrSpeed === 'fast' ? 'টার্বো OCR' : 'OCR'}`
                            : pipelineProgress.totalBatches > 0
                              ? `${pipelineProgress.ocrSpeed === 'fast' ? 'টার্বো OCR' : 'OCR'} (${toBengaliNumber(pipelineProgress.completedBatches ?? pipelineProgress.currentBatch)}/${toBengaliNumber(pipelineProgress.totalBatches)})`
                              : 'স্বয়ংক্রিয়'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500">সম্পন্ন পৃষ্ঠা</dt>
                      <dd className="font-mono font-medium text-slate-800 tabular-nums">
                        {pipelineProgress.totalPages !== null
                          ? `${toBengaliNumber(pipelineProgress.completedPages)}/${toBengaliNumber(pipelineProgress.totalPages)}`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500">সংরক্ষণ অবস্থা</dt>
                      <dd className="font-medium text-slate-800">
                        <span
                          className={
                            pipelineProgress.saveReady
                              ? 'text-emerald-700 font-semibold'
                              : pipelineProgress.stage === 'partial'
                                ? 'text-amber-700 font-semibold'
                                : 'text-slate-600'
                          }
                        >
                          {pipelineProgress.saveReady
                            ? 'সংরক্ষণের জন্য প্রস্তুত'
                            : pipelineProgress.stage === 'partial'
                              ? 'আংশিক (সংরক্ষণ স্থগিত)'
                              : 'চলমান / অপ্রস্তুত'}
                        </span>
                      </dd>
                    </div>
                  </dl>

                  {extractionResult && extractionResult.missingOriginalPages.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2.5">
                      <div className="space-y-1 text-xs text-amber-950">
                        <p className="font-semibold">
                          অনুপস্থিত মূল পৃষ্ঠা ({toBengaliNumber(extractionResult.missingOriginalPages.length)}টি):{' '}
                          {extractionResult.missingOriginalPages.map(toBengaliNumber).join(', ')}।
                        </p>
                        <p className="text-amber-900">
                          আপনার{' '}
                          <strong>
                            {toBengaliNumber(extractionResult.extractedPageCount)}টি পৃষ্ঠা ইতিমধ্যেই নিরাপদে সংরক্ষিত আছে
                          </strong>
                          —পুরো PDF আবার আপলোড করতে হবে না। শুধু বাকি{' '}
                          {toBengaliNumber(extractionResult.missingOriginalPages.length)}টি পৃষ্ঠা সম্পন্ন করলেই বইটি সংরক্ষণ করা যাবে।
                          {quotaCooldownSeconds > 0
                            ? ` (ফ্রি-টিয়ার সীমা রিসেট হতে ~${toBengaliNumber(quotaCooldownSeconds)} সে. অপেক্ষা করুন)`
                            : ''}
                        </p>
                      </div>
                      {!extracting && selectedFile && (
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            data-testid="resume-missing-pages-btn"
                            onClick={() => void handleCompleteMissingPages()}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
                          >
                            <Zap className="h-3.5 w-3.5" />
                            <span>
                              {quotaCooldownSeconds > 0
                                ? `এখনই বাকি ${toBengaliNumber(extractionResult.missingOriginalPages.length)}টি পৃষ্ঠা চেষ্টা করুন (${toBengaliNumber(quotaCooldownSeconds)} সে.)`
                                : `শুধু বাকি ${toBengaliNumber(extractionResult.missingOriginalPages.length)}টি পৃষ্ঠা সম্পন্ন করুন`}
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Collapsible Advanced & Manual Options Disclosure */}
            <div className="rounded-lg border border-slate-200 bg-slate-50/50">
              <button
                type="button"
                aria-expanded={showAdvancedOptions}
                onClick={() => setShowAdvancedOptions((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-xs font-semibold text-slate-700 hover:bg-slate-100/70 transition-colors rounded-lg"
              >
                <span className="inline-flex items-center gap-2">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
                  <span>অ্যাডভান্সড ও ম্যানুয়াল অপশন (মূল পৃষ্ঠা রেঞ্জ, লেখক, বা সরাসরি টেক্সট পেস্ট)</span>
                </span>
                {showAdvancedOptions ? (
                  <ChevronUp className="h-4 w-4 text-slate-500 shrink-0" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-slate-500 shrink-0" />
                )}
              </button>

              {showAdvancedOptions && (
                <div className="border-t border-slate-200 p-4 space-y-4 bg-white rounded-b-lg">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div>
                      <label
                        htmlFor="pdf-page-range-input"
                        className="block text-xs font-semibold text-slate-700"
                      >
                        মূল বইয়ের পৃষ্ঠা রেঞ্জ (ঐচ্ছিক)
                      </label>
                      <input
                        id="pdf-page-range-input"
                        type="text"
                        value={originalPageRangeInput}
                        disabled={extracting}
                        onChange={(e) => setOriginalPageRangeInput(e.target.value)}
                        placeholder="যেমন: Page 37-44 অথবা ৩৭-৪৪"
                        className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:opacity-50"
                      />
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
                        className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                      />
                    </div>

                    <div>
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
                        placeholder="অধ্যায় ১: মূল আলোচনা"
                        className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                      />
                    </div>
                  </div>

                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                    <input
                      id="pdf-force-ocr-toggle"
                      type="checkbox"
                      checked={forceOcr}
                      disabled={extracting}
                      onChange={(e) => setForceOcr(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                    />
                    <ScanText className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                    <span>সব পৃষ্ঠায় জোরপূর্বক AI OCR চালান (ডিফল্ট অটো-ডিটেক্টের বদলে)</span>
                  </label>

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor="book-raw-text"
                        className="block text-xs font-semibold text-slate-700"
                      >
                        সংগৃহীত টেক্সট বা অধ্যায়ের পাঠ্য (ম্যানুয়ালি পেস্ট বা রিভিউ করুন)
                      </label>
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        কার্যকর পাঠ্য: {toBengaliNumber(liveSaveReadiness.meaningfulCharCount)} অক্ষর
                      </span>
                    </div>
                    <textarea
                      id="book-raw-text"
                      rows={5}
                      value={rawText}
                      onChange={(e) => {
                        setRawText(e.target.value);
                        setRawTextModified(true);
                        if (!selectedFile) {
                          setExtractionMethod('manual');
                        }
                      }}
                      placeholder="এখানে PDF থেকে সংগৃহীত প্রকৃত টেক্সট স্বয়ংক্রিয়ভাবে আসবে, অথবা সরাসরি যেকোনো বইয়ের নোট পেস্ট করুন..."
                      className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 leading-relaxed focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                  </div>
                </div>
              )}
            </div>

            {formError && (
              <p
                role="alert"
                data-testid="book-form-error"
                className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700"
              >
                {formError}
              </p>
            )}

            {/* Show explicit Save button when advanced/manual text is open or auto-save is off */}
            {(showAdvancedOptions || !autoSaveOnComplete || rawText.trim().length > 0) && (
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (extracting) {
                      void handleCancelExtraction();
                    }
                    setShowAddForm(false);
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  disabled={!canSubmitBook}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span>Knowledge Base-এ সংরক্ষণ করুন</span>
                </button>
              </div>
            )}
          </form>
        </section>
      )}

      {/* Search, Category, Format & Option (ক) Master Folder Toolbar */}
      <div className="space-y-3">
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

        {/* Format Segmented Filter (MCQ / Written / Combined / Textbook) + Master Folder vs Flat Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="বইয়ের ধরন ফিল্টার">
            <span className="text-xs font-semibold text-slate-600 mr-1">
              ধরন:
            </span>
            {FORMAT_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                data-testid={`library-format-filter-${opt.id}`}
                aria-pressed={formatFilter === opt.id}
                onClick={() => setFormatFilter(opt.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                  formatFilter === opt.id
                    ? 'bg-blue-700 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200/80'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div
            role="group"
            aria-label="লাইব্রেরি ভিউ মোড"
            className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5"
          >
            <button
              type="button"
              data-testid="library-view-master"
              aria-pressed={libraryViewMode === 'master'}
              onClick={() => setLibraryViewMode('master')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                libraryViewMode === 'master'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FolderOpen className="h-3.5 w-3.5 text-blue-700" />
              <span>মাস্টার বই ফোল্ডার ({toBengaliNumber(filteredCatalogEntries.length)})</span>
            </button>
            <button
              type="button"
              data-testid="library-view-parts"
              aria-pressed={libraryViewMode === 'parts'}
              onClick={() => setLibraryViewMode('parts')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                libraryViewMode === 'parts'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <List className="h-3.5 w-3.5 text-slate-600" />
              <span>সব খণ্ড আলাদা ({toBengaliNumber(filteredBooks.length)})</span>
            </button>
          </div>
        </div>
      </div>

      {/* Book Directory List — Option (ক) Virtual Master Book Folders or Flat Parts */}
      {(libraryViewMode === 'master' ? filteredCatalogEntries.length === 0 : filteredBooks.length === 0) ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center">
          <BookOpen className="mx-auto h-8 w-8 text-slate-400" />
          <h2 className="mt-3 text-base font-semibold text-slate-900">
            কোনো বই পাওয়া যায়নি
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            ক্যাটাগরি, ধরন (MCQ/Written) বা অনুসন্ধান পরিবর্তন করুন অথবা নতুন PDF বই আপলোড করুন।
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {(categoryFilter !== 'সব' || formatFilter !== 'all' || searchQuery.trim()) && (
              <button
                type="button"
                onClick={() => {
                  setCategoryFilter('সব');
                  setFormatFilter('all');
                  setSearchQuery('');
                }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
              >
                ফিল্টার রিসেট করুন
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 transition-colors"
            >
              নতুন বই যুক্ত করুন
            </button>
          </div>
        </div>
      ) : libraryViewMode === 'master' ? (
        <div
          data-testid="virtual-master-catalog-list"
          className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200"
        >
          {filteredCatalogEntries.map((entry) => {
            if (entry.isVirtualSeries) {
              const isExpanded = Boolean(expandedMasterKeys[entry.masterKey]);
              const isMergingThis = mergingSeriesKey === entry.masterKey;
              return (
                <article
                  key={entry.masterKey}
                  data-testid="virtual-master-book-card"
                  data-master-format={entry.format}
                  className="bg-white transition-colors"
                >
                  <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between hover:bg-slate-50/70">
                    <div className="flex items-start gap-3.5 min-w-0 flex-1">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700">
                        <FolderOpen className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h2 className="text-base font-bold text-slate-900 leading-snug">
                          {entry.title}
                        </h2>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                          <span className="font-semibold text-blue-800">
                            {BOOK_FORMAT_LABELS[entry.format]}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{entry.category}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums font-semibold text-slate-800">
                            {toBengaliNumber(entry.books.length)}টি খণ্ড একত্রিত
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            মোট {toBengaliNumber(entry.totalPages)} পৃষ্ঠা
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{entry.subject}</span>
                        </div>
                        <p className="mt-2 text-xs text-slate-600 line-clamp-1">
                          খণ্ডসমূহ: {entry.books.map((b) => b.title).join(' · ')}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        data-testid="toggle-master-parts-btn"
                        aria-expanded={isExpanded}
                        onClick={() => toggleMasterExpand(entry.masterKey)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors whitespace-nowrap"
                      >
                        {isExpanded ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                        <span>
                          খণ্ডসমূহ ({toBengaliNumber(entry.books.length)})
                        </span>
                      </button>
                      <button
                        type="button"
                        data-testid="open-master-reader-btn"
                        onClick={() => {
                          setSelectedBookId(entry.primaryBookId);
                          setActiveModule('reader');
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap"
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                        <span>সম্পূর্ণ সিরিজ পড়ুন</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedBookId(entry.primaryBookId);
                          setActiveModule('question-lab');
                        }}
                        className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
                      >
                        প্রশ্ন তৈরি
                      </button>
                    </div>
                  </div>

                  {/* Expanded Parts Drawer for Virtual Master Book */}
                  {isExpanded && (
                    <div
                      data-testid="master-parts-drawer"
                      className="border-t border-slate-200 bg-slate-50/70 px-5 py-3.5 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-slate-700">
                          এই মাস্টার বইয়ের অন্তর্ভুক্ত খণ্ডসমূহ (মূল PDF অক্ষত রেখে ভার্চুয়ালি সংযুক্ত)
                        </span>
                        <button
                          type="button"
                          disabled={mergingSeriesKey !== null}
                          onClick={() =>
                            void handleMergeSeriesParts(
                              entry.masterKey,
                              entry.books.map((b) => b.id),
                              entry.title
                            )
                          }
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline disabled:opacity-50"
                        >
                          {isMergingThis ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <GitMerge className="h-3 w-3" />
                          )}
                          <span>
                            {isMergingThis
                              ? 'একত্র করা হচ্ছে...'
                              : 'স্থায়ীভাবে ১টি বইয়ে মার্জ করুন (ঐচ্ছিক)'}
                          </span>
                        </button>
                      </div>

                      <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                        {entry.books.map((partBook, idx) => {
                          const partSummary = buildBookCardSummary(partBook.chunks);
                          const partFormat = detectBookContentFormat(
                            partBook,
                            catalogOverrides.customFormatByBookId[String(partBook.id)]
                          );
                          const isEditingThisFolder = editingFolderBookId === partBook.id;
                          return (
                            <div
                              key={partBook.id}
                              data-testid={`master-part-row-${partBook.id}`}
                              className="p-3 space-y-2"
                            >
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-mono text-[11px] font-semibold text-slate-500">
                                      অংশ {toBengaliNumber(idx + 1)}
                                    </span>
                                    <span className="text-xs font-semibold text-slate-900">
                                      {partBook.title}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                                    <span className="font-medium text-blue-700">
                                      {BOOK_FORMAT_LABELS[partFormat]}
                                    </span>
                                    <span>·</span>
                                    <span className="font-mono tabular-nums">
                                      {toBengaliNumber(partBook.totalPages)} পৃষ্ঠা
                                    </span>
                                    <span>·</span>
                                    <span>{partSummary.unitLabel}</span>
                                  </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                                  <select
                                    aria-label={`ধরন পরিবর্তন: ${partBook.title}`}
                                    value={partFormat}
                                    onChange={(e) =>
                                      assignBookFormat(
                                        partBook.id,
                                        e.target.value as BookContentFormat
                                      )
                                    }
                                    className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
                                  >
                                    <option value="MCQ">MCQ</option>
                                    <option value="Written">Written</option>
                                    <option value="Combined">MCQ + Written</option>
                                    <option value="Textbook">মূল বই</option>
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (isEditingThisFolder) {
                                        setEditingFolderBookId(null);
                                      } else {
                                        setEditingFolderBookId(partBook.id);
                                        setFolderDraftName(
                                          catalogOverrides.customMasterByBookId[String(partBook.id)] ??
                                            entry.title
                                        );
                                      }
                                    }}
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                                  >
                                    <FolderPlus className="h-3 w-3 text-blue-700" />
                                    <span>ফোল্ডার</span>
                                  </button>
                                  {cachedPdfByBookId.has(partBook.id) && (
                                    <button
                                      type="button"
                                      onClick={() => void handleOpenOfflinePdf(partBook.id)}
                                      className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100"
                                    >
                                      PDF
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedBookId(partBook.id);
                                      setActiveModule('reader');
                                    }}
                                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                                  >
                                    পড়ুন
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDeleteModalError(null);
                                      setPendingDeleteBook(partBook);
                                    }}
                                    aria-label={`বই মুছুন: ${partBook.title}`}
                                    className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>

                              {isEditingThisFolder && (
                                <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50/50 p-2">
                                  <input
                                    type="text"
                                    list="existing-virtual-master-folders"
                                    value={folderDraftName}
                                    onChange={(e) => setFolderDraftName(e.target.value)}
                                    placeholder="নতুন বা বিদ্যমান মাস্টার বইয়ের নাম লিখুন..."
                                    className="flex-1 min-w-[200px] rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      assignBookToMaster(partBook.id, folderDraftName.trim() || null);
                                      setEditingFolderBookId(null);
                                    }}
                                    className="rounded bg-blue-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-800"
                                  >
                                    সংরক্ষণ
                                  </button>
                                  {catalogOverrides.customMasterByBookId[String(partBook.id)] && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        assignBookToMaster(partBook.id, null);
                                        setEditingFolderBookId(null);
                                      }}
                                      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                                    >
                                      আলাদা করুন
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setEditingFolderBookId(null)}
                                    className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600"
                                  >
                                    বাতিল
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </article>
              );
            }

            // Standalone single-PDF book card
            const book = entry.books[0];
            const cardSummary = buildBookCardSummary(book.chunks);
            const isEditingFolder = editingFolderBookId === book.id;
            return (
              <article
                key={book.id}
                data-testid="standalone-book-card"
                data-book-format={entry.format}
                className="p-5 hover:bg-slate-50/70 transition-colors space-y-3"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold text-slate-900 leading-snug">
                      {book.title}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                      <span className="font-semibold text-blue-800">
                        {BOOK_FORMAT_LABELS[entry.format]}
                      </span>
                      <span aria-hidden="true">·</span>
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
                        {cardSummary.unitLabel}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {book.extractionMethod === 'ocr'
                          ? 'OCR সম্পন্ন'
                          : 'টেক্সট ইনডেক্সড'}
                      </span>
                      {book.driveFileId && (
                        <>
                          <span aria-hidden="true">·</span>
                          <a
                            href={
                              book.driveWebViewLink ||
                              `https://drive.google.com/file/d/${encodeURIComponent(book.driveFileId)}/view`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline"
                          >
                            <HardDrive className="h-3 w-3" />
                            <span>Google Drive-এ সংরক্ষিত</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </>
                      )}
                      {(offlineSavedAt || cachedPdfByBookId.has(book.id)) && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 font-medium text-blue-700">
                            <CheckCircle2 className="h-3 w-3" />
                            <span>
                              {cachedPdfByBookId.has(book.id)
                                ? 'অফলাইন PDF সংরক্ষিত'
                                : 'অফলাইনে প্রস্তুত'}
                            </span>
                          </span>
                        </>
                      )}
                    </div>

                    {cardSummary.previewLabels.length > 0 && (
                      <p className="mt-2 text-xs text-slate-600 line-clamp-2 leading-relaxed">
                        {cardSummary.isExamBook ? 'পরীক্ষাসমূহ: ' : 'অধ্যায়সমূহ: '}
                        {cardSummary.previewLabels.join(' · ')}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      data-testid={`assign-folder-btn-${book.id}`}
                      onClick={() => {
                        if (isEditingFolder) {
                          setEditingFolderBookId(null);
                        } else {
                          setEditingFolderBookId(book.id);
                          setFolderDraftName(
                            catalogOverrides.customMasterByBookId[String(book.id)] ?? ''
                          );
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap"
                    >
                      <FolderPlus className="h-3.5 w-3.5 text-blue-700" />
                      <span>ফোল্ডার / ধরন</span>
                    </button>
                    {cachedPdfByBookId.has(book.id) && (
                      <button
                        type="button"
                        data-testid={`open-offline-pdf-btn-${book.id}`}
                        disabled={openingOfflinePdfId === book.id}
                        onClick={() => void handleOpenOfflinePdf(book.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {openingOfflinePdfId === book.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                        <span>অফলাইন PDF</span>
                      </button>
                    )}
                    {!book.driveFileId && (
                      <button
                        type="button"
                        disabled={syncingBookId !== null}
                        onClick={() => void handlePushBookToDrive(book)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {syncingBookId === book.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CloudUpload className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {syncingBookId === book.id ? 'আপলোড হচ্ছে...' : 'Drive-এ সেভ'}
                        </span>
                      </button>
                    )}
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
                      onClick={() => {
                        setDeleteModalError(null);
                        setPendingDeleteBook(book);
                      }}
                      aria-label={`বই মুছুন: ${book.title}`}
                      className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-700 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {isEditingFolder && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/50 p-3">
                    <select
                      aria-label="বইয়ের ধরন নির্বাচন"
                      value={entry.format}
                      onChange={(e) =>
                        assignBookFormat(book.id, e.target.value as BookContentFormat)
                      }
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 focus:border-blue-600 focus:outline-none"
                    >
                      <option value="MCQ">MCQ</option>
                      <option value="Written">Written (লিখিত)</option>
                      <option value="Combined">MCQ + Written</option>
                      <option value="Textbook">মূল বই / নোট</option>
                    </select>
                    <input
                      type="text"
                      list="existing-virtual-master-folders"
                      value={folderDraftName}
                      onChange={(e) => setFolderDraftName(e.target.value)}
                      placeholder="ভার্চুয়াল মাস্টার বই ফোল্ডারের নাম (একাধিক খণ্ড একত্র করতে)"
                      className="flex-1 min-w-[220px] rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        assignBookToMaster(book.id, folderDraftName.trim() || null);
                        setEditingFolderBookId(null);
                      }}
                      className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
                    >
                      ফোল্ডারে যুক্ত করুন
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingFolderBookId(null)}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      বাতিল
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div
          data-testid="flat-parts-catalog-list"
          className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200"
        >
          {filteredBooks.map((book) => {
            const cardSummary = buildBookCardSummary(book.chunks);
            const fmt = detectBookContentFormat(
              book,
              catalogOverrides.customFormatByBookId[String(book.id)]
            );
            return (
            <article
              key={book.id}
              className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between hover:bg-slate-50/70 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-slate-900 leading-snug">
                  {book.title}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                  <span className="font-semibold text-blue-800">
                    {BOOK_FORMAT_LABELS[fmt]}
                  </span>
                  <span aria-hidden="true">·</span>
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
                    {cardSummary.unitLabel}
                  </span>
                </div>

                {cardSummary.previewLabels.length > 0 && (
                  <p className="mt-2 text-xs text-slate-600 line-clamp-2 leading-relaxed">
                    {cardSummary.isExamBook ? 'পরীক্ষাসমূহ: ' : 'অধ্যায়সমূহ: '}
                    {cardSummary.previewLabels.join(' · ')}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {cachedPdfByBookId.has(book.id) && (
                  <button
                    type="button"
                    data-testid={`open-offline-pdf-btn-${book.id}`}
                    disabled={openingOfflinePdfId === book.id}
                    onClick={() => void handleOpenOfflinePdf(book.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>অফলাইন PDF</span>
                  </button>
                )}
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
                  onClick={() => {
                    setDeleteModalError(null);
                    setPendingDeleteBook(book);
                  }}
                  aria-label={`বই মুছুন: ${book.title}`}
                  className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-700 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </article>
            );
          })}
        </div>
      )}

      {/* Mandatory Explicit Confirmation Modal for Book & Google Drive Deletion */}
      {pendingDeleteBook && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-book-dialog-title"
          data-testid="book-delete-confirm-modal"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => {
              if (!deletingBook) {
                setPendingDeleteBook(null);
                setDeleteModalError(null);
              }
            }}
            aria-hidden="true"
          />
          <div className="relative z-10 w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700">
                  <Trash2 className="h-4 w-4" />
                </div>
                <div>
                  <h2
                    id="delete-book-dialog-title"
                    className="text-base font-bold text-slate-900"
                  >
                    বই মুছে ফেলার নিশ্চিতকরণ
                  </h2>
                  <p className="text-xs font-medium text-slate-500">
                    {pendingDeleteBook.title}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={deletingBook}
                onClick={() => {
                  setPendingDeleteBook(null);
                  setDeleteModalError(null);
                }}
                aria-label="বন্ধ করুন"
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {pendingDeleteBook.driveFileId ? (
              <div className="mt-4 space-y-2 text-sm leading-relaxed text-slate-700">
                <p>
                  আপনি কি নিশ্চিতভাবে{' '}
                  <strong className="font-semibold text-slate-900">
                    “{pendingDeleteBook.title}”
                  </strong>{' '}
                  বইটি মুছে ফেলতে চান?
                </p>
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  এই বইটি আপনার নির্ধারিত Google Drive ফোল্ডারে সংরক্ষিত আছে
                  {pendingDeleteBook.driveFileName
                    ? ` (${pendingDeleteBook.driveFileName})`
                    : ''}
                  । নিশ্চিত করলে এটি লাইব্রেরি এবং Google Drive ফোল্ডার—উভয় জায়গা থেকেই স্থায়ীভাবে মুছে ফেলা হবে।
                </p>
              </div>
            ) : (
              <p className="mt-4 text-sm leading-relaxed text-slate-700">
                আপনি কি নিশ্চিতভাবে{' '}
                <strong className="font-semibold text-slate-900">
                  “{pendingDeleteBook.title}”
                </strong>{' '}
                বইটি লাইব্রেরি থেকে স্থায়ীভাবে মুছে ফেলতে চান?
              </p>
            )}

            {deleteModalError && (
              <p
                role="alert"
                data-testid="delete-book-modal-error"
                className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800"
              >
                {deleteModalError}
              </p>
            )}

            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={deletingBook}
                onClick={() => {
                  setPendingDeleteBook(null);
                  setDeleteModalError(null);
                }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors sm:whitespace-nowrap"
              >
                বাতিল
              </button>

              {pendingDeleteBook.driveFileId ? (
                <>
                  <button
                    type="button"
                    disabled={deletingBook}
                    onClick={() =>
                      void handleConfirmDeleteBook({ deleteFromDrive: false })
                    }
                    className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors sm:whitespace-nowrap"
                  >
                    শুধু লাইব্রেরি থেকে মুছুন
                  </button>
                  <button
                    type="button"
                    data-testid="confirm-delete-book-btn"
                    disabled={deletingBook}
                    onClick={() =>
                      void handleConfirmDeleteBook({
                        deleteFromDrive: true,
                        reconnectDriveFirst: !driveConnected,
                      })
                    }
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-60 transition-colors sm:whitespace-nowrap"
                  >
                    {deletingBook && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <span>
                      {deletingBook
                        ? 'মুছে ফেলা হচ্ছে...'
                        : driveConnected
                          ? 'লাইব্রেরি ও Drive থেকে মুছুন'
                          : 'Drive সংযুক্ত করে উভয় থেকে মুছুন'}
                    </span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="confirm-delete-book-btn"
                  disabled={deletingBook}
                  onClick={() =>
                    void handleConfirmDeleteBook({ deleteFromDrive: false })
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-60 transition-colors sm:whitespace-nowrap"
                >
                  {deletingBook && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>{deletingBook ? 'মুছে ফেলা হচ্ছে...' : 'নিশ্চিত করে মুছুন'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {previewOfflinePdf && (
        <OfflinePdfPreviewModal
          bookTitle={previewOfflinePdf.bookTitle}
          fileName={previewOfflinePdf.fileName}
          mimeType={previewOfflinePdf.mimeType}
          blob={previewOfflinePdf.blob}
          onClose={() => setPreviewOfflinePdf(null)}
        />
      )}
    </div>
  );
}
