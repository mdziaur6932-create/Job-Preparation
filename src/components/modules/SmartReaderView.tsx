'use client';

import React, { useEffect, useMemo, useState } from 'react';
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
  ChevronLeft,
  ChevronRight,
  Wrench,
  BookCheck,
  Save,
  RotateCcw,
  ShieldCheck,
  AlertTriangle,
  Code2,
  Download,
  Wand2,
  Layers,
  Filter,
  SlidersHorizontal,
  ChevronDown,
  Printer,
  FileDown,
  Columns2,
  AlignJustify,
  Eye,
  EyeOff,
  PanelRightOpen,
  PanelRightClose,
  Pencil,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { resolveOfflineScopeKey } from '@/src/lib/offline-cache-policy';
import { formatAiResponseError } from '@/src/lib/ai-client';
import { normalizeExamDocumentFormatting } from '@/src/lib/exam-text-formatter';
import {
  analyzeExamQuestionAnswers,
  formatMathForPlainText,
} from '@/src/lib/exam-math-and-answer-guard';
import {
  buildStructuredExamJsonFromText,
  type OcrRefinedExamPaperJson,
} from '@/src/lib/ocr-refiner-agent';
import {
  buildSafeExportFilename,
  buildStructuredExamPdfBytes,
  triggerBrowserFileDownload,
} from '@/src/lib/exam-paper-exporter';
import { buildStructuredExamDocxBytes } from '@/src/lib/exam-word-exporter';
import { toBengaliNumber } from '@/src/lib/file-validation';
import {
  buildFullPageSearchChunks,
  buildSmartReaderViews,
  type SmartReaderViewMode,
} from '@/src/lib/reader-page-grouper';
import {
  analyzeBookOrSeriesQuestions,
  filterExamViewsByFormat,
  getAvailableSubjects,
  getAvailableTopicsForSubject,
} from '@/src/lib/book-series-and-topic-analyzer';
import { buildUnifiedSeriesGroupsWithOverrides } from '@/src/lib/book-catalog-organization';
import { useBookCatalogOverrides } from '@/src/lib/book-catalog-storage';
import { rankChunksHybrid } from '@/src/lib/rag-engine';
import {
  FormattedReaderContent,
  type A4ReaderLayoutMode,
} from './FormattedReaderContent';
import {
  TopicAndRepeatExplorer,
  type ReaderFormatFilter,
} from './TopicAndRepeatExplorer';
import { SmartReaderOcrEditor } from './SmartReaderOcrEditor';

type ReaderActionMode = 'summary' | 'facts' | 'explain' | 'compare';
type AdvancedViewMode = 'exam' | 'repeated' | 'page';

export function SmartReaderView() {
  const {
    data,
    user,
    selectedBookId,
    setSelectedBookId,
    readerJumpTarget,
    clearReaderJumpTarget,
    updateBookViewContent,
    getAiAuthHeaders,
    requestAiSignIn,
  } = useWorkspace();

  const catalogScopeKey = resolveOfflineScopeKey(user?.uid ?? null);
  const { overrides: catalogOverrides } = useBookCatalogOverrides(catalogScopeKey);

  const activeBook = useMemo(
    () =>
      data.books.find((b) => b.id === selectedBookId) ?? data.books[0] ?? null,
    [data.books, selectedBookId]
  );

  const [advancedViewMode, setAdvancedViewMode] =
    useState<AdvancedViewMode>('exam');
  const [formatFilter, setFormatFilter] = useState<ReaderFormatFilter>('all');
  const [selectedSubject, setSelectedSubject] = useState<string>('ALL');
  const [selectedTopic, setSelectedTopic] = useState<string>('ALL');
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [combineSeriesParts, setCombineSeriesParts] = useState(true);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [crossQuery, setCrossQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Publication-grade A4 Paper Reader & Export state
  const [a4LayoutMode, setA4LayoutMode] = useState<A4ReaderLayoutMode>('single');
  const [hideAnswers, setHideAnswers] = useState(false);
  const [justifyText, setJustifyText] = useState(true);
  const [fontSizeScale, setFontSizeScale] = useState(1);
  const [a4PageCount, setA4PageCount] = useState(1);
  const [showOcrEditor, setShowOcrEditor] = useState(false);
  const [showAiSidebar, setShowAiSidebar] = useState(false);
  const [showOcrTools, setShowOcrTools] = useState(false);
  const [downloadingA4Pdf, setDownloadingA4Pdf] = useState(false);
  const [downloadingDocx, setDownloadingDocx] = useState(false);

  // OCR Refiner, Math Repair & Strict Non-Override Missing-Answer Assist state
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>(
    {}
  );
  const [refinedJsonByView, setRefinedJsonByView] = useState<
    Record<string, OcrRefinedExamPaperJson>
  >({});
  const [showJsonPreview, setShowJsonPreview] = useState(false);
  const [assistLoadingMode, setAssistLoadingMode] = useState<
    'ocr_refiner' | 'repair_math' | 'fill_missing_answers' | null
  >(null);
  const [assistNotice, setAssistNotice] = useState<{
    viewId: string;
    tone: 'info' | 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);

  // AI Reader Workbench state
  const [aiMode, setAiMode] = useState<ReaderActionMode>('summary');
  const [aiOutput, setAiOutput] = useState<string>('');
  const [aiCitations, setAiCitations] = useState<
    Array<{ bookTitle: string; chapter: string; pageNumber: number }>
  >([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const allChunks = useMemo(
    () => buildFullPageSearchChunks(data.books),
    [data.books]
  );

  // Option (ক): Unify Virtual Master Books (numbered monthly splits + Part 01/02 + custom folders)
  const bookSeriesGroups = useMemo(
    () => buildUnifiedSeriesGroupsWithOverrides(data.books, catalogOverrides),
    [data.books, catalogOverrides]
  );

  const activeSeriesGroup = useMemo(() => {
    if (!activeBook) return null;
    return (
      bookSeriesGroups.find((g) =>
        g.books.some((b) => b.id === activeBook.id)
      ) ?? null
    );
  }, [bookSeriesGroups, activeBook]);

  const effectiveBooks = useMemo(() => {
    if (!activeBook) return [];
    if (combineSeriesParts && activeSeriesGroup?.isMultiPart) {
      return activeSeriesGroup.books;
    }
    return [activeBook];
  }, [activeBook, combineSeriesParts, activeSeriesGroup]);

  const effectiveChunks = useMemo(() => {
    if (!activeBook) return [];
    if (combineSeriesParts && activeSeriesGroup?.isMultiPart) {
      return activeSeriesGroup.combinedChunks;
    }
    return activeBook.chunks;
  }, [activeBook, combineSeriesParts, activeSeriesGroup]);

  const bookIntelligence = useMemo(
    () =>
      analyzeBookOrSeriesQuestions(
        effectiveBooks,
        combineSeriesParts && activeSeriesGroup?.isMultiPart
          ? activeSeriesGroup.seriesTitle
          : activeBook?.title
      ),
    [effectiveBooks, combineSeriesParts, activeSeriesGroup, activeBook?.title]
  );

  const viewModePreference: SmartReaderViewMode =
    advancedViewMode === 'page' ? 'page' : 'exam';

  const rawReaderCollection = useMemo(() => {
    if (effectiveChunks.length === 0) {
      return {
        isExamBook: false,
        effectiveMode: 'page' as SmartReaderViewMode,
        views: [],
      };
    }
    return buildSmartReaderViews(effectiveChunks, viewModePreference);
  }, [effectiveChunks, viewModePreference]);

  // Apply MCQ / Written format filter to exam views while strictly preserving serial page order
  const readerCollection = useMemo(() => {
    if (
      !rawReaderCollection.isExamBook ||
      rawReaderCollection.effectiveMode !== 'exam'
    ) {
      return rawReaderCollection;
    }
    const filteredViews = filterExamViewsByFormat(
      rawReaderCollection.views,
      bookIntelligence.examFormatByViewId,
      formatFilter
    );
    return {
      ...rawReaderCollection,
      views: filteredViews,
    };
  }, [rawReaderCollection, formatFilter, bookIntelligence.examFormatByViewId]);

  // Cascading Subject -> Topic options for the collapsible Advanced Option panel
  const availableSubjects = useMemo(
    () => getAvailableSubjects(bookIntelligence, formatFilter),
    [bookIntelligence, formatFilter]
  );

  const effectiveSelectedSubject = useMemo(() => {
    if (selectedSubject === 'ALL') return 'ALL';
    return availableSubjects.some((s) => s.subject === selectedSubject)
      ? selectedSubject
      : 'ALL';
  }, [selectedSubject, availableSubjects]);

  const availableTopics = useMemo(
    () =>
      getAvailableTopicsForSubject(
        bookIntelligence,
        effectiveSelectedSubject,
        formatFilter
      ),
    [bookIntelligence, effectiveSelectedSubject, formatFilter]
  );

  const effectiveSelectedTopic = useMemo(() => {
    if (selectedTopic === 'ALL') return 'ALL';
    return availableTopics.some((t) => t.topic === selectedTopic)
      ? selectedTopic
      : 'ALL';
  }, [selectedTopic, availableTopics]);

  const activeContentDisplay: 'exam' | 'topic' | 'repeated' | 'page' = useMemo(() => {
    if (!rawReaderCollection.isExamBook) return 'page';
    if (advancedViewMode === 'repeated') return 'repeated';
    if (advancedViewMode === 'page') return 'page';
    if (effectiveSelectedSubject !== 'ALL' || effectiveSelectedTopic !== 'ALL') {
      return 'topic';
    }
    return 'exam';
  }, [
    rawReaderCollection.isExamBook,
    advancedViewMode,
    effectiveSelectedSubject,
    effectiveSelectedTopic,
  ]);

  const hasActiveAdvancedFilters =
    advancedViewMode !== 'exam' ||
    effectiveSelectedSubject !== 'ALL' ||
    effectiveSelectedTopic !== 'ALL';

  const advancedModeSelectValue = useMemo(() => {
    if (advancedViewMode === 'repeated') return 'repeated';
    if (advancedViewMode === 'page') return 'page';
    if (formatFilter === 'MCQ') return 'exam_mcq';
    if (formatFilter === 'Written') return 'exam_written';
    return 'exam_all';
  }, [advancedViewMode, formatFilter]);

  const handleResetAdvancedOptions = () => {
    setAdvancedViewMode('exam');
    setSelectedSubject('ALL');
    setSelectedTopic('ALL');
    setSelectedViewId(null);
  };

  const activeViewIndex = useMemo(() => {
    if (readerCollection.views.length === 0) return -1;
    const foundIdx = readerCollection.views.findIndex(
      (v) => v.id === selectedViewId
    );
    return foundIdx >= 0 ? foundIdx : 0;
  }, [readerCollection.views, selectedViewId]);

  const jumpNonce = readerJumpTarget?.nonce ?? 0;
  const jumpBookId = readerJumpTarget?.bookId ?? null;
  const jumpPageNumber = readerJumpTarget?.pageNumber ?? 1;
  const jumpExamId = readerJumpTarget?.examId ?? null;

  useEffect(() => {
    if (!jumpNonce || jumpBookId === null) return;
    if (!activeBook || activeBook.id !== jumpBookId) return;

    const timer = window.setTimeout(() => {
      setFormatFilter('all');
      setSelectedSubject('ALL');
      setSelectedTopic('ALL');
      setAdvancedViewMode(rawReaderCollection.isExamBook ? 'exam' : 'page');

      const candidateViews = rawReaderCollection.views;
      if (candidateViews.length > 0) {
        const matched =
          (jumpExamId
            ? candidateViews.find((v) => v.id === jumpExamId)
            : undefined) ??
          candidateViews.find(
            (v) => jumpPageNumber >= v.startPage && jumpPageNumber <= v.endPage
          ) ??
          candidateViews.find(
            (v) =>
              Math.abs(v.startPage - jumpPageNumber) <= 1 ||
              Math.abs(v.endPage - jumpPageNumber) <= 1
          ) ??
          candidateViews[0];
        if (matched) {
          setSelectedViewId(matched.id);
        }
      }
      clearReaderJumpTarget();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    jumpNonce,
    jumpBookId,
    jumpPageNumber,
    jumpExamId,
    activeBook,
    rawReaderCollection.isExamBook,
    rawReaderCollection.views,
    clearReaderJumpTarget,
  ]);

  const activeView =
    activeViewIndex >= 0 ? readerCollection.views[activeViewIndex] : null;

  const activeExamMeta = activeView
    ? bookIntelligence.examFormatByViewId[activeView.id] ?? null
    : null;

  const activeDisplayContent = useMemo(() => {
    if (!activeView) return '';
    return draftOverrides[activeView.id] ?? activeView.content;
  }, [activeView, draftOverrides]);

  const hasUnsavedDraft = Boolean(
    activeView && draftOverrides[activeView.id] !== undefined
  );

  const examAnalysis = useMemo(
    () => analyzeExamQuestionAnswers(activeDisplayContent),
    [activeDisplayContent]
  );

  const activeStructuredJson = useMemo(() => {
    if (!activeView || !examAnalysis.isExam) return null;
    return (
      refinedJsonByView[activeView.id] ??
      buildStructuredExamJsonFromText(activeDisplayContent, activeView.title)
    );
  }, [activeView, examAnalysis.isExam, refinedJsonByView, activeDisplayContent]);

  const activeAssistNotice =
    activeView && assistNotice?.viewId === activeView.id ? assistNotice : null;

  const crossBookMatches = useMemo(() => {
    if (!crossQuery.trim()) return [];
    return rankChunksHybrid(allChunks, crossQuery.trim(), { topK: 5 });
  }, [allChunks, crossQuery]);

  const runOcrRefinerAgent = async () => {
    if (!activeView) return;

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('OCR Refiner Agent (LaTeX + Structured JSON)');
      return;
    }

    setAssistLoadingMode('ocr_refiner');
    setAssistNotice(null);

    try {
      const res = await fetch('/api/ai/ocr-refiner', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          content: activeDisplayContent,
          bookTitle: activeView.bookTitle,
          examTitle: activeView.title,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          requestAiSignIn('OCR Refiner Agent (LaTeX + Structured JSON)');
        }
        throw new Error(
          formatAiResponseError(
            res.status,
            json,
            'OCR Refiner এজেন্ট চালাতে সমস্যা হয়েছে।'
          )
        );
      }

      if (typeof json.formattedContent === 'string' && json.formattedContent.trim()) {
        setDraftOverrides((prev) => ({
          ...prev,
          [activeView.id]: json.formattedContent,
        }));
      }
      if (json.refinedJson && typeof json.refinedJson === 'object') {
        setRefinedJsonByView((prev) => ({
          ...prev,
          [activeView.id]: json.refinedJson as OcrRefinedExamPaperJson,
        }));
        setShowJsonPreview(true);
      }

      setAssistNotice({
        viewId: activeView.id,
        tone: 'success',
        text:
          typeof json.message === 'string' && json.message
            ? json.message
            : 'OCR Refiner সফলভাবে LaTeX ও Structured JSON তৈরি করেছে।',
      });
    } catch (err) {
      setAssistNotice({
        viewId: activeView.id,
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'OCR Refiner প্রক্রিয়াকরণ ব্যর্থ হয়েছে।',
      });
    } finally {
      setAssistLoadingMode(null);
    }
  };

  const handleDownloadStructuredJson = () => {
    if (!activeView || !activeStructuredJson) return;
    const filename = buildSafeExportFilename(
      `${activeView.title}-${activeView.pageLabel}`,
      'json'
    );
    triggerBrowserFileDownload(
      `${JSON.stringify(activeStructuredJson, null, 2)}\n`,
      'application/json;charset=utf-8',
      filename
    );
  };

  const runExamAssist = async (
    mode: 'repair_math' | 'fill_missing_answers'
  ) => {
    if (!activeView) return;

    // HARD CLIENT-SIDE NON-OVERRIDE GUARD:
    // If every question already has an answer in the book, NEVER call AI!
    if (mode === 'fill_missing_answers') {
      if (!examAnalysis.isExam) {
        setAssistNotice({
          viewId: activeView.id,
          tone: 'info',
          text: 'এই পৃষ্ঠায় নম্বরযুক্ত পরীক্ষার প্রশ্ন পাওয়া যায়নি। তাই AI দিয়ে কোনো উত্তর তৈরি করা হয়নি।',
        });
        return;
      }
      if (examAnalysis.unansweredQuestions.length === 0) {
        setAssistNotice({
          viewId: activeView.id,
          tone: 'info',
          text: `এই পরীক্ষার সবগুলো প্রশ্নের (${examAnalysis.answeredCount}টি) উত্তর মূল বইয়ে ইতিমধ্যেই রয়েছে। নিয়ম অনুযায়ী মূল বইয়ে উত্তর থাকা কোনো প্রশ্নে AI দিয়ে উত্তর তৈরি করা হয়নি।`,
        });
        return;
      }
    }

    if (
      mode === 'repair_math' &&
      examAnalysis.isExam &&
      examAnalysis.corruptedMathQuestions.length === 0 &&
      examAnalysis.mathQuestions.length === 0
    ) {
      setAssistNotice({
        viewId: activeView.id,
        tone: 'info',
        text: 'এই পরীক্ষায় মেরামত করার মতো কোনো গণিত বা ভগ্নাংশ প্রশ্ন শনাক্ত হয়নি।',
      });
      return;
    }

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn(
        mode === 'repair_math'
          ? 'গণিত ও ভগ্নাংশ OCR মেরামত'
          : 'অনুপস্থিত উত্তর অনুসন্ধান (AI + রেফারেন্স)'
      );
      return;
    }

    setAssistLoadingMode(mode);
    setAssistNotice(null);

    try {
      const res = await fetch('/api/ai/exam-assist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          mode,
          content: activeDisplayContent,
          bookTitle: activeView.bookTitle,
          examTitle: activeView.title,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          requestAiSignIn(
            mode === 'repair_math'
              ? 'গণিত ও ভগ্নাংশ OCR মেরামত'
              : 'অনুপস্থিত উত্তর অনুসন্ধান (AI + রেফারেন্স)'
          );
        }
        throw new Error(
          formatAiResponseError(
            res.status,
            json,
            'প্রশ্নপত্র বিশ্লেষণ ও মেরামত করতে সমস্যা হয়েছে।'
          )
        );
      }

      if (
        !json.skippedAll &&
        typeof json.updatedContent === 'string' &&
        json.updatedContent.trim()
      ) {
        setDraftOverrides((prev) => ({
          ...prev,
          [activeView.id]: json.updatedContent,
        }));
      }

      setAssistNotice({
        viewId: activeView.id,
        tone: json.skippedAll ? 'info' : 'success',
        text:
          typeof json.message === 'string' && json.message
            ? json.message
            : 'প্রক্রিয়া সম্পন্ন হয়েছে।',
      });
    } catch (err) {
      setAssistNotice({
        viewId: activeView.id,
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'প্রশ্নপত্র প্রক্রিয়াকরণ ব্যর্থ হয়েছে।',
      });
    } finally {
      setAssistLoadingMode(null);
    }
  };

  const handleSaveDraftToBook = async () => {
    if (!activeBook || !activeView || !hasUnsavedDraft) return;
    setSavingDraft(true);
    try {
      const ownerBookId = activeView.sourceChunks[0]?.bookId ?? activeBook.id;
      await updateBookViewContent(
        ownerBookId,
        activeView.sourceChunks.map((c) => c.id),
        activeDisplayContent
      );
      setDraftOverrides((prev) => {
        const next = { ...prev };
        delete next[activeView.id];
        return next;
      });
      setAssistNotice({
        viewId: activeView.id,
        tone: 'success',
        text: 'সংশোধিত গণিত ও AI-চিহ্নিত উত্তর সফলভাবে বইয়ে সংরক্ষণ করা হয়েছে। এখন Question Lab থেকে PDF/TXT এক্সপোর্ট করলেও এটি পাওয়া যাবে।',
      });
    } catch {
      setAssistNotice({
        viewId: activeView.id,
        tone: 'error',
        text: 'বইয়ে পরিবর্তন সংরক্ষণ করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।',
      });
    } finally {
      setSavingDraft(false);
    }
  };

  const handleDiscardDraft = () => {
    if (!activeView) return;
    setDraftOverrides((prev) => {
      const next = { ...prev };
      delete next[activeView.id];
      return next;
    });
    setRefinedJsonByView((prev) => {
      const next = { ...prev };
      delete next[activeView.id];
      return next;
    });
    setAssistNotice({
      viewId: activeView.id,
      tone: 'info',
      text: 'পূর্বের মূল OCR টেক্সটে ফিরে যাওয়া হয়েছে।',
    });
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleOpenSearchMatch = (bookId: number, pageNumber: number) => {
    const targetBook = data.books.find((b) => b.id === bookId);
    if (!targetBook) return;
    const { views } = buildSmartReaderViews(targetBook.chunks, viewModePreference);
    const matchingView =
      views.find((v) => v.startPage <= pageNumber && pageNumber <= v.endPage) ??
      views[0] ??
      null;
    setSelectedBookId(bookId);
    setSelectedViewId(matchingView ? matchingView.id : null);
    setCrossQuery('');
  };

  const handleDownloadA4Pdf = async () => {
    if (!activeView || downloadingA4Pdf) return;
    setDownloadingA4Pdf(true);
    try {
      const exportUnit = {
        ...activeView,
        content: activeDisplayContent,
      };
      const { bytes } = await buildStructuredExamPdfBytes([exportUnit], {
        bookTitle: activeView.bookTitle,
        numberingStyle: 'original',
        includeHeader: true,
        includeSolutions: !hideAnswers,
        layoutColumns: a4LayoutMode === 'double' ? 2 : 1,
        justifyText,
      });
      const filename = buildSafeExportFilename(
        `${activeView.title}-A4-${a4LayoutMode === 'double' ? '2col' : '1col'}`,
        'pdf'
      );
      triggerBrowserFileDownload(bytes, 'application/pdf', filename);
      setAssistNotice({
        viewId: activeView.id,
        tone: 'success',
        text: `A4 Narrow মার্জিন প্রশ্নপত্র PDF ডাউনলোড সম্পন্ন হয়েছে: ${filename}`,
      });
    } catch (err) {
      setAssistNotice({
        viewId: activeView.id,
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'A4 PDF তৈরি করতে সমস্যা হয়েছে।',
      });
    } finally {
      setDownloadingA4Pdf(false);
    }
  };

  const handleDownloadWordDocx = async () => {
    if (!activeView || downloadingDocx) return;
    setDownloadingDocx(true);
    try {
      const exportUnit = {
        ...activeView,
        content: activeDisplayContent,
      };
      const bytes = await buildStructuredExamDocxBytes([exportUnit], {
        bookTitle: activeView.bookTitle,
        numberingStyle: 'original',
        includeHeader: true,
        includeSolutions: !hideAnswers,
        layoutColumns: a4LayoutMode === 'double' ? 2 : 1,
        justifyText,
      });
      const filename = buildSafeExportFilename(
        `${activeView.title}-A4-${a4LayoutMode === 'double' ? '2col' : '1col'}`,
        'docx'
      );
      triggerBrowserFileDownload(
        bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename
      );
      setAssistNotice({
        viewId: activeView.id,
        tone: 'success',
        text: `Microsoft Word (.docx) প্রশ্নপত্র ডাউনলোড সম্পন্ন হয়েছে: ${filename}`,
      });
    } catch (err) {
      setAssistNotice({
        viewId: activeView.id,
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Word (.docx) ফাইল তৈরি করতে সমস্যা হয়েছে।',
      });
    } finally {
      setDownloadingDocx(false);
    }
  };

  const runReaderAi = async (mode: ReaderActionMode) => {
    setShowAiSidebar(true);
    setAiMode(mode);
    setAiError(null);

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('AI স্মার্ট রিডার ও নোট বিশ্লেষণ');
      return;
    }

    setAiLoading(true);

    const payloadChunks =
      mode === 'compare' && crossBookMatches.length > 0
        ? crossBookMatches.map((c) => ({
            bookTitle: c.bookTitle,
            chapter: c.chapter,
            pageNumber: c.pageNumber,
            content: normalizeExamDocumentFormatting(c.content),
          }))
        : mode === 'compare' && activeView
          ? rankChunksHybrid(allChunks, activeView.title, { topK: 4 }).map((c) => ({
              bookTitle: c.bookTitle,
              chapter: c.chapter,
              pageNumber: c.pageNumber,
              content: normalizeExamDocumentFormatting(c.content),
            }))
          : activeView
            ? [
                {
                  bookTitle: activeView.bookTitle,
                  chapter: `${activeView.title} (${activeView.pageLabel})`,
                  pageNumber: activeView.startPage,
                  content: activeView.content,
                },
              ]
            : [];

    if (payloadChunks.length === 0) {
      setAiError('বিশ্লেষণ করার মতো কোনো অধ্যায় বা পরীক্ষার পৃষ্ঠা পাওয়া যায়নি।');
      setAiLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/ai/reader', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          mode,
          topic: crossQuery.trim() || activeView?.title || activeBook?.title,
          chunks: payloadChunks,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          requestAiSignIn('AI স্মার্ট রিডার ও নোট বিশ্লেষণ');
        }
        throw new Error(
          formatAiResponseError(
            res.status,
            json,
            'AI বিশ্লেষণ তৈরি করা যায়নি।'
          )
        );
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
          বইয়ের সম্পূর্ণ পরীক্ষা বা পূর্ণ পৃষ্ঠা একসাথে পড়ুন, টেক্সট কপি করুন, এবং RAG-এর মাধ্যমে একাধিক বইয়ের তথ্য বইয়ের নাম ও পৃষ্ঠা নম্বরসহ একত্রিত করুন।
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
            disabled={aiLoading || (!crossQuery.trim() && !activeView)}
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
                      <div className="flex items-center gap-2">
                        <span className="font-mono tabular-nums text-slate-500">
                          {match.chapter} · পৃষ্ঠা {match.pageNumber}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            handleOpenSearchMatch(match.bookId, match.pageNumber)
                          }
                          className="rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 transition-colors"
                        >
                          পূর্ণ পৃষ্ঠা খুলুন
                        </button>
                      </div>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-700 leading-relaxed whitespace-pre-line line-clamp-4">
                      {normalizeExamDocumentFormatting(match.content)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main Reader & Optional AI Workbench Split */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left: Book & Chapter Reading Pane (full 12 cols in A4 Focus Mode, 8 cols when AI sidebar open) */}
        <section
          aria-label="বই ও অধ্যায় রিডার"
          className={`${
            showAiSidebar ? 'lg:col-span-8' : 'lg:col-span-12'
          } rounded-xl border border-slate-200 bg-white overflow-hidden`}
        >
          <div className="space-y-3 border-b border-slate-200 bg-slate-50 p-4">
            {/* ROW 1: Book Selector (left) + Multi-Part Series Toggle (right, side-by-side) */}
            <div
              className={`grid grid-cols-1 gap-3 ${
                activeSeriesGroup?.isMultiPart ? 'md:grid-cols-12 items-end' : ''
              }`}
            >
              <div
                className={
                  activeSeriesGroup?.isMultiPart ? 'md:col-span-6' : ''
                }
              >
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
                    setSelectedViewId(null);
                    setSelectedSubject('ALL');
                    setSelectedTopic('ALL');
                    setAdvancedViewMode('exam');
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

              {activeSeriesGroup?.isMultiPart && (
                <div
                  data-testid="reader-series-unified-bar"
                  className="md:col-span-6 flex flex-col gap-1.5 rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-1.5 text-slate-800 truncate">
                    <Layers className="h-3.5 w-3.5 text-blue-700 shrink-0" />
                    <span className="truncate">
                      <strong className="font-semibold text-blue-900">
                        {activeSeriesGroup.seriesTitle}
                      </strong>{' '}
                      ({activeSeriesGroup.books.length}টি পার্ট · মোট{' '}
                      <span className="font-mono tabular-nums font-semibold">
                        {activeSeriesGroup.totalPages}
                      </span>{' '}
                      পৃষ্ঠা)
                    </span>
                  </div>
                  <div className="inline-flex w-full rounded-md border border-blue-200 bg-white p-0.5">
                    <button
                      type="button"
                      data-testid="toggle-series-unified-on"
                      onClick={() => {
                        setCombineSeriesParts(true);
                        setSelectedViewId(null);
                      }}
                      className={`flex-1 rounded px-2.5 py-1 text-[11px] font-semibold transition-colors whitespace-nowrap ${
                        combineSeriesParts
                          ? 'bg-blue-700 text-white'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      সব পার্ট একসাথে ({activeSeriesGroup.books.length} পার্ট)
                    </button>
                    <button
                      type="button"
                      data-testid="toggle-series-unified-off"
                      onClick={() => {
                        setCombineSeriesParts(false);
                        setSelectedViewId(null);
                      }}
                      className={`flex-1 rounded px-2.5 py-1 text-[11px] font-semibold transition-colors whitespace-nowrap ${
                        !combineSeriesParts
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      শুধু নির্বাচিত পার্ট
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ROW 2: Questions Type Segmented Filter (সকল প্রশ্ন | MCQ প্রশ্ন | Written / লিখিত প্রশ্ন) */}
            {rawReaderCollection.isExamBook && (
              <div
                data-testid="reader-format-filter"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                  <Filter className="h-3.5 w-3.5 text-blue-700 shrink-0" />
                  <span>প্রশ্নের ধরন (MCQ / Written আলাদা করুন):</span>
                </span>
                <div
                  role="group"
                  aria-label="প্রশ্নের ধরন নির্বাচন"
                  className="inline-flex rounded-md border border-slate-200 bg-slate-100 p-0.5"
                >
                  <button
                    type="button"
                    data-testid="filter-format-all"
                    aria-pressed={formatFilter === 'all'}
                    onClick={() => {
                      setFormatFilter('all');
                      setSelectedViewId(null);
                      if (advancedViewMode === 'page') {
                        setAdvancedViewMode('exam');
                      }
                    }}
                    className={`rounded px-3 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      formatFilter === 'all'
                        ? 'bg-blue-700 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    সকল প্রশ্ন
                  </button>
                  <button
                    type="button"
                    data-testid="filter-format-mcq"
                    aria-pressed={formatFilter === 'MCQ'}
                    onClick={() => {
                      setFormatFilter('MCQ');
                      setSelectedViewId(null);
                      if (advancedViewMode === 'page') {
                        setAdvancedViewMode('exam');
                      }
                    }}
                    className={`rounded px-3 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      formatFilter === 'MCQ'
                        ? 'bg-indigo-700 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    MCQ প্রশ্ন
                  </button>
                  <button
                    type="button"
                    data-testid="filter-format-written"
                    aria-pressed={formatFilter === 'Written'}
                    onClick={() => {
                      setFormatFilter('Written');
                      setSelectedViewId(null);
                      if (advancedViewMode === 'page') {
                        setAdvancedViewMode('exam');
                      }
                    }}
                    className={`rounded px-3 py-1 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      formatFilter === 'Written'
                        ? 'bg-emerald-700 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Written / লিখিত প্রশ্ন
                  </button>
                </div>
              </div>
            )}

            {/* ROW 3: Exam & Page Selector (strictly filtered by Row 1 + Row 2 in serial page order) */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="reader-chapter-select"
                  className="block text-xs font-semibold text-slate-600"
                >
                  {readerCollection.isExamBook &&
                  readerCollection.effectiveMode === 'exam'
                    ? 'পরীক্ষা ও পৃষ্ঠা নির্বাচন'
                    : 'সম্পূর্ণ পৃষ্ঠা ও অধ্যায়'}
                </label>
                <span className="text-[11px] font-medium text-slate-500 font-mono tabular-nums">
                  {readerCollection.effectiveMode === 'exam'
                    ? `${readerCollection.views.length}টি পরীক্ষা${
                        activeView && activeView.questionCount > 0 && activeContentDisplay === 'exam'
                          ? ` · এই পরীক্ষায় ${activeView.questionCount}টি প্রশ্ন`
                          : ''
                      }`
                    : `${readerCollection.views.length}টি পৃষ্ঠা`}
                </span>
              </div>
              <select
                id="reader-chapter-select"
                value={activeView?.id ?? ''}
                disabled={readerCollection.views.length === 0}
                onChange={(e) => {
                  setSelectedViewId(e.target.value);
                  if (
                    advancedViewMode === 'repeated' ||
                    selectedSubject !== 'ALL' ||
                    selectedTopic !== 'ALL'
                  ) {
                    setAdvancedViewMode('exam');
                    setSelectedSubject('ALL');
                    setSelectedTopic('ALL');
                  }
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400"
              >
                {readerCollection.views.length === 0 ? (
                  <option value="">
                    নির্বাচিত ধরনে কোনো পরীক্ষা পাওয়া যায়নি
                  </option>
                ) : (
                  readerCollection.views.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.title} ({view.pageLabel})
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* ROW 4: Advanced Option (Collapsed by default — opens on click) */}
            {rawReaderCollection.isExamBook && (
              <div className="pt-0.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    data-testid="btn-toggle-advanced-option"
                    aria-expanded={showAdvancedOptions}
                    aria-controls="smart-reader-advanced-panel"
                    onClick={() => setShowAdvancedOptions((prev) => !prev)}
                    className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      showAdvancedOptions || hasActiveAdvancedFilters
                        ? 'border-blue-600 bg-blue-50 text-blue-800'
                        : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
                    }`}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5 text-blue-700" />
                    <span>Advanced Option</span>
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform duration-150 ${
                        showAdvancedOptions ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  {hasActiveAdvancedFilters && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <span>
                        সক্রিয়:{' '}
                        <strong className="font-semibold text-slate-900">
                          {advancedViewMode === 'repeated'
                            ? 'বারবার আসা প্রশ্ন'
                            : advancedViewMode === 'page'
                              ? 'পৃষ্ঠাভিত্তিক'
                              : effectiveSelectedTopic !== 'ALL'
                                ? `${effectiveSelectedSubject !== 'ALL' ? `${effectiveSelectedSubject} · ` : ''}${effectiveSelectedTopic}`
                                : `বিষয়: ${effectiveSelectedSubject}`}
                        </strong>
                      </span>
                      <button
                        type="button"
                        data-testid="btn-reset-advanced-option"
                        onClick={handleResetAdvancedOptions}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline whitespace-nowrap shrink-0"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>রিসেট</span>
                      </button>
                    </div>
                  )}
                </div>

                {showAdvancedOptions && (
                  <div
                    id="smart-reader-advanced-panel"
                    data-testid="advanced-option-panel"
                    className="grid grid-cols-1 gap-3 sm:grid-cols-3 rounded-lg border border-slate-200 bg-white p-3"
                  >
                    {/* Dropdown 1: পূর্ণ পরীক্ষা / বারবার আসা প্রশ্ন / পৃষ্ঠাভিত্তিক */}
                    <div>
                      <label
                        htmlFor="advanced-mode-select"
                        className="block text-xs font-semibold text-slate-700"
                      >
                        পূর্ণ পরীক্ষা / দেখার ধরন:
                      </label>
                      <select
                        id="advanced-mode-select"
                        data-testid="advanced-mode-select"
                        value={advancedModeSelectValue}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === 'exam_all') {
                            setAdvancedViewMode('exam');
                            setFormatFilter('all');
                            setSelectedSubject('ALL');
                            setSelectedTopic('ALL');
                            setSelectedViewId(null);
                          } else if (val === 'exam_mcq') {
                            setAdvancedViewMode('exam');
                            setFormatFilter('MCQ');
                            setSelectedSubject('ALL');
                            setSelectedTopic('ALL');
                            setSelectedViewId(null);
                          } else if (val === 'exam_written') {
                            setAdvancedViewMode('exam');
                            setFormatFilter('Written');
                            setSelectedSubject('ALL');
                            setSelectedTopic('ALL');
                            setSelectedViewId(null);
                          } else if (val === 'repeated') {
                            setAdvancedViewMode('repeated');
                          } else if (val === 'page') {
                            setAdvancedViewMode('page');
                            setSelectedSubject('ALL');
                            setSelectedTopic('ALL');
                            setSelectedViewId(null);
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                      >
                        <option value="exam_all">
                          পূর্ণ পরীক্ষা (সকল — {bookIntelligence.totalExams}টি)
                        </option>
                        <option value="exam_mcq">
                          পূর্ণ পরীক্ষা (MCQ — {bookIntelligence.mcqExamCount + bookIntelligence.mixedExamCount}টি)
                        </option>
                        <option value="exam_written">
                          পূর্ণ পরীক্ষা (Written — {bookIntelligence.writtenExamCount + bookIntelligence.mixedExamCount}টি)
                        </option>
                        <option value="repeated">
                          বারবার আসা প্রশ্ন (Most Repeated — {bookIntelligence.repeatedQuestions.length}টি)
                        </option>
                        <option value="page">পৃষ্ঠাভিত্তিক</option>
                      </select>
                    </div>

                    {/* Dropdown 2: বিষয় (Subject) */}
                    <div>
                      <label
                        htmlFor="advanced-subject-select"
                        className="block text-xs font-semibold text-slate-700"
                      >
                        বিষয়:
                      </label>
                      <select
                        id="advanced-subject-select"
                        data-testid="advanced-subject-select"
                        value={effectiveSelectedSubject}
                        onChange={(e) => {
                          const nextSubject = e.target.value;
                          setSelectedSubject(nextSubject);
                          setSelectedTopic('ALL');
                          if (nextSubject !== 'ALL' && advancedViewMode === 'page') {
                            setAdvancedViewMode('exam');
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                      >
                        <option value="ALL">
                          সকল বিষয় ({availableSubjects.reduce((s, item) => s + item.count, 0)})
                        </option>
                        {availableSubjects.map((sub) => (
                          <option key={sub.subject} value={sub.subject}>
                            {sub.subject} ({sub.count})
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Dropdown 3: টপিক ভিত্তিক (Cascades strictly to selected বিষয়) */}
                    <div>
                      <label
                        htmlFor="advanced-topic-select"
                        className="block text-xs font-semibold text-slate-700"
                      >
                        টপিক ভিত্তিক:
                      </label>
                      <select
                        id="advanced-topic-select"
                        data-testid="advanced-topic-select"
                        value={effectiveSelectedTopic}
                        onChange={(e) => {
                          const nextTopic = e.target.value;
                          setSelectedTopic(nextTopic);
                          if (nextTopic !== 'ALL' && advancedViewMode === 'page') {
                            setAdvancedViewMode('exam');
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                      >
                        <option value="ALL">
                          {effectiveSelectedSubject !== 'ALL'
                            ? `${effectiveSelectedSubject}-এর সকল টপিক`
                            : 'সকল টপিক'}{' '}
                          ({availableTopics.reduce((s, item) => s + item.count, 0)})
                        </option>
                        {availableTopics.map((t) => (
                          <option key={t.topic} value={t.topic}>
                            {t.topic} ({t.count})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {activeContentDisplay === 'topic' ||
          activeContentDisplay === 'repeated' ? (
            <TopicAndRepeatExplorer
              mode={activeContentDisplay}
              report={bookIntelligence}
              formatFilter={formatFilter}
              selectedSubject={effectiveSelectedSubject}
              selectedTopic={effectiveSelectedTopic}
              onSelectSubject={(subject) => {
                setSelectedSubject(subject);
                setSelectedTopic('ALL');
              }}
              onSelectTopic={(topic) => {
                setSelectedTopic(topic);
              }}
              onJumpToExam={(examId) => {
                setAdvancedViewMode('exam');
                setSelectedSubject('ALL');
                setSelectedTopic('ALL');
                setFormatFilter('all');
                setSelectedViewId(examId);
              }}
              onReturnToFullExam={handleResetAdvancedOptions}
            />
          ) : activeView ? (
            <div className="p-4 sm:p-6">
              {/* Top Document Metadata & Quick Utility Row */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3 print:hidden">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <span className="font-semibold text-slate-800">
                    {activeView.bookTitle}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{activeView.title}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums font-medium text-blue-700">
                    {activeView.pageLabel}
                  </span>
                  {activeExamMeta && (
                    <span
                      data-testid="active-exam-format-badge"
                      className="ml-1 font-semibold text-slate-700"
                    >
                      ·{' '}
                      {activeExamMeta.format === 'MCQ'
                        ? `MCQ সেট (${activeExamMeta.mcqCount})`
                        : activeExamMeta.format === 'Written'
                          ? `Written / লিখিত (${activeExamMeta.writtenCount})`
                          : `MCQ (${activeExamMeta.mcqCount}) + Written (${activeExamMeta.writtenCount})`}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="btn-toggle-ai-sidebar"
                    aria-expanded={showAiSidebar}
                    onClick={() => setShowAiSidebar((prev) => !prev)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                      showAiSidebar
                        ? 'border-blue-600 bg-blue-50 text-blue-800'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {showAiSidebar ? (
                      <PanelRightClose className="h-3.5 w-3.5" />
                    ) : (
                      <PanelRightOpen className="h-3.5 w-3.5 text-blue-700" />
                    )}
                    <span>{showAiSidebar ? 'AI প্যানেল লুকান' : 'AI নোট প্যানেল'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopy(
                        activeView.id,
                        `${formatMathForPlainText(activeDisplayContent)}\n\n— উৎস: ${activeView.bookTitle}, ${activeView.title}, ${activeView.pageLabel}`
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
                  >
                    {copiedId === activeView.id ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-emerald-700" />
                        <span>কপি হয়েছে</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span>সম্পূর্ণ টেক্সট কপি</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Publication-Grade A4 Narrow Paper Toolbar */}
              <div
                data-testid="smart-reader-a4-toolbar"
                className="mt-3 flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 print:hidden"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    role="group"
                    aria-label="A4 পেজ কলাম লেআউট"
                    className="inline-flex rounded-md border border-slate-200 bg-white p-0.5"
                  >
                    <button
                      type="button"
                      data-testid="btn-a4-layout-single"
                      aria-pressed={a4LayoutMode === 'single'}
                      onClick={() => setA4LayoutMode('single')}
                      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                        a4LayoutMode === 'single'
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <AlignJustify className="h-3.5 w-3.5" />
                      <span>A4 ১-কলাম</span>
                    </button>
                    <button
                      type="button"
                      data-testid="btn-a4-layout-double"
                      aria-pressed={a4LayoutMode === 'double'}
                      onClick={() => setA4LayoutMode('double')}
                      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                        a4LayoutMode === 'double'
                          ? 'bg-blue-700 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Columns2 className="h-3.5 w-3.5" />
                      <span>A4 ২-কলাম (অরিজিনাল প্রশ্নপত্র)</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    data-testid="btn-a4-toggle-justify"
                    aria-pressed={justifyText}
                    onClick={() => setJustifyText((prev) => !prev)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                      justifyText
                        ? 'border-blue-600 bg-blue-50 text-blue-800'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <AlignJustify className="h-3.5 w-3.5" />
                    <span>Justify</span>
                  </button>

                  {examAnalysis.isExam && (
                    <button
                      type="button"
                      data-testid="btn-a4-toggle-answers"
                      aria-pressed={hideAnswers}
                      onClick={() => setHideAnswers((prev) => !prev)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                        hideAnswers
                          ? 'border-amber-300 bg-amber-50 text-amber-900'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {hideAnswers ? (
                        <Eye className="h-3.5 w-3.5" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5" />
                      )}
                      <span>{hideAnswers ? 'উত্তর দেখান' : 'উত্তর লুকান (প্র্যাকটিস)'}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    data-testid="btn-toggle-ocr-editor"
                    aria-expanded={showOcrEditor}
                    onClick={() => setShowOcrEditor((prev) => !prev)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                      showOcrEditor
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                        : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
                    }`}
                  >
                    <Pencil className="h-3.5 w-3.5 text-emerald-700" />
                    <span>{showOcrEditor ? 'এডিটর বন্ধ করুন' : 'এডিট (Word টুলস)'}</span>
                  </button>

                  {examAnalysis.isExam && (
                    <button
                      type="button"
                      data-testid="btn-toggle-ocr-tools"
                      aria-expanded={showOcrTools || hasUnsavedDraft}
                      onClick={() => setShowOcrTools((prev) => !prev)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                        showOcrTools || hasUnsavedDraft
                          ? 'border-blue-600 bg-blue-50 text-blue-800'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Wrench className="h-3.5 w-3.5 text-blue-700" />
                      <span>OCR ও গণিত টুলস</span>
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="a4-page-count-badge"
                    className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold font-mono tabular-nums text-slate-700 whitespace-nowrap"
                  >
                    মোট {toBengaliNumber(a4PageCount)}টি A4 পৃষ্ঠা · Narrow (0.5&quot;)
                  </span>
                  <button
                    type="button"
                    data-testid="btn-a4-download-docx"
                    disabled={downloadingDocx}
                    onClick={() => void handleDownloadWordDocx()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-100 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {downloadingDocx ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileText className="h-3.5 w-3.5" />
                    )}
                    <span>Word (.docx) ডাউনলোড</span>
                  </button>
                  <button
                    type="button"
                    data-testid="btn-a4-download-pdf"
                    disabled={downloadingA4Pdf}
                    onClick={() => void handleDownloadA4Pdf()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {downloadingA4Pdf ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileDown className="h-3.5 w-3.5" />
                    )}
                    <span>A4 PDF ডাউনলোড</span>
                  </button>
                  <button
                    type="button"
                    data-testid="btn-a4-print-sheet"
                    onClick={() => window.print()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors whitespace-nowrap"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    <span>A4 প্রিন্ট</span>
                  </button>
                </div>
              </div>

              {/* Math Fraction Repair & Strict Non-Override Missing-Answer Bar (collapsed by default for clean A4 focus) */}
              {examAnalysis.isExam &&
                (showOcrTools ||
                  (hasUnsavedDraft && !showOcrEditor) ||
                  Boolean(activeAssistNotice) ||
                  assistLoadingMode !== null) && (
                <div
                  data-testid="exam-math-and-answer-toolbar"
                  className="mt-4 rounded-lg border border-slate-200 bg-slate-50/80 p-3 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="inline-flex items-center gap-1 font-semibold text-slate-700">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-700" />
                        <span>
                          উত্তর আছে: {examAnalysis.answeredCount}/
                          {examAnalysis.questions.length}টি
                        </span>
                      </span>
                      {examAnalysis.unansweredQuestions.length > 0 ? (
                        <span
                          data-testid="unanswered-count-badge"
                          className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900"
                        >
                          উত্তর নেই: {examAnalysis.unansweredQuestions.length}টি
                        </span>
                      ) : (
                        <span
                          data-testid="all-answered-badge"
                          className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800"
                        >
                          সব প্রশ্নের উত্তর বইয়ে আছে
                        </span>
                      )}
                      {examAnalysis.corruptedMathQuestions.length > 0 && (
                        <span
                          data-testid="corrupted-math-badge"
                          className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-800"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          <span>
                            গণিত/ভগ্নাংশ ত্রুটি:{' '}
                            {examAnalysis.corruptedMathQuestions.length}টি
                          </span>
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid="btn-ocr-refiner"
                        disabled={assistLoadingMode !== null}
                        onClick={() => void runOcrRefinerAgent()}
                        className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
                      >
                        {assistLoadingMode === 'ocr_refiner' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                        ) : (
                          <Wand2 className="h-3.5 w-3.5 text-amber-300" />
                        )}
                        <span>OCR Refiner (LaTeX + JSON)</span>
                      </button>

                      <button
                        type="button"
                        data-testid="btn-repair-math"
                        disabled={assistLoadingMode !== null}
                        onClick={() => void runExamAssist('repair_math')}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50 transition-colors"
                      >
                        {assistLoadingMode === 'repair_math' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5 text-blue-700" />
                        )}
                        <span>ম্যাথ ও ভগ্নাংশ মেরামত</span>
                      </button>

                      <button
                        type="button"
                        data-testid="btn-fill-missing-answers"
                        disabled={assistLoadingMode !== null}
                        onClick={() =>
                          void runExamAssist('fill_missing_answers')
                        }
                        className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-50 transition-colors"
                      >
                        {assistLoadingMode === 'fill_missing_answers' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700" />
                        ) : (
                          <BookCheck className="h-3.5 w-3.5 text-blue-700" />
                        )}
                        <span>অনুপস্থিত উত্তর খুঁজুন (AI + রেফারেন্স)</span>
                      </button>

                      <button
                        type="button"
                        data-testid="btn-toggle-structured-json"
                        aria-expanded={showJsonPreview}
                        onClick={() => setShowJsonPreview((prev) => !prev)}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                          showJsonPreview
                            ? 'border-blue-600 bg-blue-50 text-blue-800'
                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <Code2 className="h-3.5 w-3.5" />
                        <span>Structured JSON</span>
                      </button>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    নিয়ম: OCR Refiner গণিতকে LaTeX ফরম্যাটে ও লাল দাগ করা হাইলাইটসহ Structured JSON-এ রূপান্তর করে এবং প্রতিটি প্রশ্নের উত্তর নিচে{' '}
                    <span className="font-bold text-slate-800">বোল্ড</span> আকারে সাজায়। মূল বইয়ে উত্তর থাকলে AI কখনোই উত্তর পরিবর্তন করবে না।
                  </p>

                  {showJsonPreview && activeStructuredJson && (
                    <div
                      data-testid="structured-json-panel"
                      className="rounded-lg border border-slate-200 bg-white overflow-hidden"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-100/80 px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-700">
                          <span>Structured Exam JSON (v{activeStructuredJson.schemaVersion})</span>
                          <span className="font-mono text-slate-500">
                            · প্রশ্ন {activeStructuredJson.refinementSummary.totalQuestions}টি · LaTeX {activeStructuredJson.refinementSummary.mathLatexConvertedCount}টি · হাইলাইট {activeStructuredJson.refinementSummary.preservedHighlightsCount}টি
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopy(
                                `json-${activeView.id}`,
                                JSON.stringify(activeStructuredJson, null, 2)
                              )
                            }
                            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            {copiedId === `json-${activeView.id}` ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-700" />
                                <span>কপি হয়েছে</span>
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                <span>JSON কপি</span>
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            data-testid="btn-download-reader-json"
                            onClick={handleDownloadStructuredJson}
                            className="inline-flex items-center gap-1 rounded bg-blue-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-blue-800"
                          >
                            <Download className="h-3 w-3" />
                            <span>.json ডাউনলোড</span>
                          </button>
                        </div>
                      </div>
                      <pre className="max-h-64 overflow-auto bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100 font-mono">
                        {JSON.stringify(activeStructuredJson, null, 2)}
                      </pre>
                    </div>
                  )}

                  {hasUnsavedDraft && !showOcrEditor && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50/70 px-3 py-2">
                      <span className="text-xs font-medium text-blue-900">
                        অসংরক্ষিত সংশোধন প্রিভিউ চলছে — বইয়ে স্থায়ীভাবে সংরক্ষণ করবেন?
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleDiscardDraft}
                          disabled={savingDraft}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>আগের অবস্থায় ফিরুন</span>
                        </button>
                        <button
                          type="button"
                          data-testid="btn-save-repaired-exam"
                          onClick={() => void handleSaveDraftToBook()}
                          disabled={savingDraft}
                          className="inline-flex items-center gap-1 rounded-md bg-blue-700 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                        >
                          {savingDraft ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3" />
                          )}
                          <span>বইয়ে সংরক্ষণ করুন</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {activeAssistNotice && (
                    <p
                      role={
                        activeAssistNotice.tone === 'error' ? 'alert' : 'status'
                      }
                      data-testid="exam-assist-notice"
                      className={`rounded-md border px-3 py-2 text-xs font-medium leading-relaxed ${
                        activeAssistNotice.tone === 'error'
                          ? 'border-red-200 bg-red-50 text-red-800'
                          : activeAssistNotice.tone === 'success'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border-slate-200 bg-white text-slate-700'
                      }`}
                    >
                      {activeAssistNotice.text}
                    </p>
                  )}
                </div>
              )}

              {showOcrEditor && (
                <SmartReaderOcrEditor
                  value={activeDisplayContent}
                  hasUnsavedChanges={hasUnsavedDraft}
                  saving={savingDraft}
                  defaultPdfPage={activeView.startPage}
                  justifyText={justifyText}
                  fontSizeScale={fontSizeScale}
                  onChange={(nextText) => {
                    setDraftOverrides((prev) => ({
                      ...prev,
                      [activeView.id]: nextText,
                    }));
                  }}
                  onToggleJustify={setJustifyText}
                  onChangeFontSizeScale={setFontSizeScale}
                  onSave={handleSaveDraftToBook}
                  onDiscard={handleDiscardDraft}
                  onClose={() => setShowOcrEditor(false)}
                />
              )}

              <FormattedReaderContent
                content={activeDisplayContent}
                layoutMode={a4LayoutMode}
                hideAnswers={hideAnswers}
                justifyText={justifyText}
                fontSizeScale={fontSizeScale}
                runningHeaderTitle={activeView.bookTitle}
                pageLabel={activeView.pageLabel}
                printableId="smart-reader-a4-sheet"
                onPageCountChange={setA4PageCount}
              />

              {/* Previous / Next & Clean View Switcher */}
              {readerCollection.views.length > 1 && (
                <div className="mt-6 border-t border-slate-200 pt-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={activeViewIndex <= 0}
                      onClick={() => {
                        const prev = readerCollection.views[activeViewIndex - 1];
                        if (prev) setSelectedViewId(prev.id);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      <span>
                        {readerCollection.effectiveMode === 'exam'
                          ? 'আগের পরীক্ষা'
                          : 'আগের পৃষ্ঠা'}
                      </span>
                    </button>

                    <span className="text-xs font-mono tabular-nums text-slate-500">
                      {activeViewIndex + 1} / {readerCollection.views.length}
                    </span>

                    <button
                      type="button"
                      disabled={
                        activeViewIndex >= readerCollection.views.length - 1
                      }
                      onClick={() => {
                        const next = readerCollection.views[activeViewIndex + 1];
                        if (next) setSelectedViewId(next.id);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
                    >
                      <span>
                        {readerCollection.effectiveMode === 'exam'
                          ? 'পরের পরীক্ষা'
                          : 'পরের পৃষ্ঠা'}
                      </span>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-2">
                      {readerCollection.isExamBook &&
                      readerCollection.effectiveMode === 'exam'
                        ? 'এই বইয়ের অন্যান্য পরীক্ষা'
                        : 'এই বইয়ের অন্যান্য পৃষ্ঠা ও অধ্যায়'}
                    </div>
                    <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto pr-1">
                      {readerCollection.views.map((view) => (
                        <button
                          key={view.id}
                          type="button"
                          onClick={() => setSelectedViewId(view.id)}
                          className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors text-left ${
                            activeView.id === view.id
                              ? 'border-blue-700 bg-blue-50 text-blue-800'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {view.pageLabel} — {view.title}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : formatFilter !== 'all' && rawReaderCollection.views.length > 0 ? (
            <div className="p-10 text-center text-sm text-slate-500 space-y-3">
              <BookOpen className="mx-auto h-7 w-7 text-slate-400" />
              <p>
                এই বইয়ে{' '}
                <strong className="text-slate-800">
                  {formatFilter === 'MCQ' ? 'MCQ' : 'Written (লিখিত)'}
                </strong>{' '}
                ধরনের কোনো পরীক্ষা পাওয়া যায়নি।
              </p>
              <button
                type="button"
                onClick={() => setFormatFilter('all')}
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
              >
                সব প্রশ্ন দেখান
              </button>
            </div>
          ) : (
            <div className="p-10 text-center text-sm text-slate-500">
              <BookOpen className="mx-auto h-7 w-7 text-slate-400" />
              <p className="mt-2">পড়ার জন্য প্রথমে Book Library থেকে একটি বই যুক্ত করুন।</p>
            </div>
          )}
        </section>

        {/* Right: Collapsible AI Smart Reader Workbench (4 cols when open) */}
        {showAiSidebar && (
        <section
          aria-label="AI স্মার্ট রিডার বিশ্লেষণ"
          className="lg:col-span-4 rounded-xl border border-slate-200 bg-white p-5 print:hidden"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-blue-700" />
              <h2 className="text-base font-semibold text-slate-900">
                AI স্মার্ট নোট ও ব্যাখ্যা (RAG)
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setShowAiSidebar(false)}
              aria-label="AI প্যানেল বন্ধ করুন"
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
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
                  উপরের যেকোনো একটি বাটনে ক্লিক করুন—AI নির্বাচিত পরীক্ষা/অধ্যায় বা একাধিক বই বিশ্লেষণ করে বইয়ের নাম ও পৃষ্ঠা নম্বরসহ নোট তৈরি করে দেবে।
                </p>
              </div>
            )}
          </div>
        </section>
        )}
      </div>
    </div>
  );
}
