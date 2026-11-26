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
  Tag,
  Play,
  FileText,
  BookOpen,
  Layers,
  Printer,
  Globe,
  FolderOpen,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { resolveOfflineScopeKey } from '@/src/lib/offline-cache-policy';
import {
  BOOK_FORMAT_LABELS,
  buildVirtualMasterBookCatalog,
} from '@/src/lib/book-catalog-organization';
import { useBookCatalogOverrides } from '@/src/lib/book-catalog-storage';
import {
  formatAiResponseError,
  isRateLimitErrorPayload,
} from '@/src/lib/ai-client';
import { compileExamSetsLocallyFromBooks } from '@/src/lib/local-question-compiler';
import {
  computeNextDeficitBatch,
  selectRotatedChunksForBatch,
  trimGeneratedSetToTargets,
} from '@/src/lib/exam-generation-planner';
import { toBengaliNumber } from '@/src/lib/file-validation';
import { analyzePreviousYearPatterns } from '@/src/lib/exam-engine';
import {
  JOB_EXAM_PRESETS,
  classifyQuestionSyllabusTopic,
} from '@/src/lib/syllabus-topic-tagger';
import {
  allocateQuestionsByPercentage,
  parseExplanationSource,
  splitGenerationIntoBatches,
  type DemoPaperAnalysis,
} from '@/src/lib/demo-paper-blueprint';
import {
  QUESTION_LANGUAGE_LABELS,
  QUESTION_ORDERING_LABELS,
  buildCurrentGkChunks,
  cloneDefaultWrittenBlueprint,
  orderQuestionsForExam,
  parseWrittenQuestionStructure,
  summarizeWrittenBlueprint,
  type QuestionLanguageMode,
  type QuestionOrderingMode,
  type WrittenSectionBlueprint,
} from '@/src/lib/job-exam-paper';
import { ExamPaperExportPanel } from './ExamPaperExportPanel';
import { TopicClusterExplorerPanel } from './TopicClusterExplorerPanel';
import { DemoPaperUploader } from './DemoPaperUploader';
import { WrittenBlueprintEditor } from './WrittenBlueprintEditor';
import {
  PrintableExamPaperModal,
  type PrintPaperMode,
} from './PrintableExamPaperModal';
import { KatexMathText } from './KatexMathText';
import type {
  DifficultyLevel,
  Question,
  QuestionType,
} from '@/src/types/system';

type LabTab = 'generate' | 'topics' | 'export' | 'bank' | 'pyq';
type GeneratorQuestionMode = 'Mixed' | QuestionType;

interface GeneratedQuestionSet {
  setNumber: number;
  questions: Array<Omit<Question, 'id' | 'createdAt'>>;
}

export function QuestionLabView() {
  const {
    data,
    user,
    selectedBookId,
    addQuestions,
    deleteQuestion,
    createExam,
    setActiveExamId,
    setActiveModule,
    getAiAuthHeaders,
    requestAiSignIn,
  } = useWorkspace();

  const catalogScopeKey = resolveOfflineScopeKey(user?.uid ?? null);
  const { overrides: catalogOverrides } = useBookCatalogOverrides(catalogScopeKey);
  const virtualCatalog = useMemo(
    () => buildVirtualMasterBookCatalog(data.books, catalogOverrides),
    [data.books, catalogOverrides]
  );
  const [expandedPickerMasters, setExpandedPickerMasters] = useState<
    Record<string, boolean>
  >({});

  const [activeTab, setActiveTab] = useState<LabTab>('generate');

  // Job-Exam Generator controls
  const [selectedBookIds, setSelectedBookIds] = useState<number[]>(() =>
    selectedBookId
      ? [selectedBookId]
      : data.books[0]
        ? [data.books[0].id]
        : []
  );
  const [questionMode, setQuestionMode] =
    useState<GeneratorQuestionMode>('Mixed');
  const [jobExamPreset, setJobExamPreset] = useState<string>(
    JOB_EXAM_PRESETS[0].label
  );
  const [difficulty, setDifficulty] = useState<DifficultyLevel>('Medium');
  const [mcqCount, setMcqCount] = useState(10);
  const [writtenCount, setWrittenCount] = useState(3);
  const [setCount, setSetCount] = useState(1);
  const [organizationName, setOrganizationName] = useState('');
  const [postName, setPostName] = useState('');
  const [paperDurationMinutes, setPaperDurationMinutes] = useState(60);
  const [paperNegativeMark, setPaperNegativeMark] = useState(0.25);
  const [orderingMode, setOrderingMode] =
    useState<QuestionOrderingMode>('subject_serial');
  const [languageMode, setLanguageMode] =
    useState<QuestionLanguageMode>('mixed_bd_job');
  const [includeCurrentGk, setIncludeCurrentGk] = useState(true);
  const [writtenSections, setWrittenSections] = useState<
    WrittenSectionBlueprint[]
  >(() => cloneDefaultWrittenBlueprint());
  const [demoAnalysis, setDemoAnalysis] = useState<DemoPaperAnalysis | null>(
    null
  );
  const [focusTopicFromExplorer, setFocusTopicFromExplorer] = useState<
    string | null
  >(null);
  const [generationEngine, setGenerationEngine] = useState<'local' | 'ai'>('local');
  const [generating, setGenerating] = useState(false);
  const [genProgressText, setGenProgressText] = useState('');
  const [startingExam, setStartingExam] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genIsQuotaError, setGenIsQuotaError] = useState(false);
  const [genSuccessMsg, setGenSuccessMsg] = useState<string | null>(null);
  const [generatedSets, setGeneratedSets] = useState<GeneratedQuestionSet[]>(
    []
  );
  const [activeSetNumber, setActiveSetNumber] = useState(1);
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printModalInitialMode, setPrintModalInitialMode] =
    useState<PrintPaperMode>('question-only');
  const [printSourceKind, setPrintSourceKind] = useState<'generated' | 'bank'>(
    'generated'
  );

  // Question Bank filters
  const [bankSearch, setBankSearch] = useState('');
  const [bankTypeFilter, setBankTypeFilter] = useState<'সব' | QuestionType>(
    'সব'
  );
  const [bankDifficultyFilter, setBankDifficultyFilter] = useState<
    'সব' | DifficultyLevel
  >('সব');
  const [bankTopicFilter, setBankTopicFilter] = useState<string>('সব');
  const [onlyPreviousYear, setOnlyPreviousYear] = useState(false);
  const [expandedQuestionId, setExpandedQuestionId] = useState<number | null>(
    null
  );

  const activeGkCount = useMemo(
    () => data.gkItems.filter((item) => !item.isArchived).length,
    [data.gkItems]
  );

  const writtenBlueprintSummary = useMemo(
    () => summarizeWrittenBlueprint(writtenSections),
    [writtenSections]
  );

  const targetTotalPerSet = useMemo(() => {
    if (questionMode === 'MCQ') return Math.min(100, Math.max(1, mcqCount || 1));
    if (questionMode === 'Written') {
      return Math.min(
        25,
        Math.max(1, writtenBlueprintSummary.totalQuestions || writtenCount || 1)
      );
    }
    if (questionMode === 'Short') {
      return Math.min(20, Math.max(1, writtenCount || 1));
    }
    return (
      Math.min(100, Math.max(1, mcqCount || 1)) +
      Math.min(20, Math.max(1, writtenCount || 1))
    );
  }, [questionMode, mcqCount, writtenCount, writtenBlueprintSummary.totalQuestions]);

  const computedTotalMarks = useMemo(() => {
    if (questionMode === 'MCQ') return Math.min(100, Math.max(1, mcqCount || 1));
    if (questionMode === 'Written') return writtenBlueprintSummary.totalMarks;
    if (questionMode === 'Short') return Math.max(2, (writtenCount || 1) * 2);
    return (
      Math.min(100, Math.max(1, mcqCount || 1)) +
      Math.max(5, (writtenCount || 1) * 5)
    );
  }, [questionMode, mcqCount, writtenCount, writtenBlueprintSummary.totalMarks]);

  const pyqPatterns = useMemo(
    () => analyzePreviousYearPatterns(data.questions),
    [data.questions]
  );

  const bankQuestionsWithTopic = useMemo(
    () =>
      data.questions.map((q) => ({
        question: q,
        syllabusTopic: classifyQuestionSyllabusTopic(q.stem, {
          chapter: q.chapter,
          subject: q.subject,
        }),
      })),
    [data.questions]
  );

  const availableBankTopics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of bankQuestionsWithTopic) {
      counts.set(
        item.syllabusTopic.label,
        (counts.get(item.syllabusTopic.label) ?? 0) + 1
      );
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [bankQuestionsWithTopic]);

  const filteredBank = useMemo(() => {
    const q = bankSearch.trim().toLowerCase();
    return bankQuestionsWithTopic.filter(({ question: item, syllabusTopic }) => {
      if (bankTypeFilter !== 'সব' && item.questionType !== bankTypeFilter) {
        return false;
      }
      if (
        bankDifficultyFilter !== 'সব' &&
        item.difficulty !== bankDifficultyFilter
      ) {
        return false;
      }
      if (
        bankTopicFilter !== 'সব' &&
        syllabusTopic.label !== bankTopicFilter
      ) {
        return false;
      }
      if (onlyPreviousYear && !item.isPreviousYear) return false;
      if (!q) return true;
      return (
        item.stem.toLowerCase().includes(q) ||
        item.subject.toLowerCase().includes(q) ||
        item.chapter.toLowerCase().includes(q) ||
        item.bookTitle.toLowerCase().includes(q) ||
        syllabusTopic.label.toLowerCase().includes(q)
      );
    });
  }, [
    bankQuestionsWithTopic,
    bankSearch,
    bankTypeFilter,
    bankDifficultyFilter,
    bankTopicFilter,
    onlyPreviousYear,
  ]);

  const activeGeneratedSet = useMemo(
    () =>
      generatedSets.find((s) => s.setNumber === activeSetNumber) ??
      generatedSets[0] ??
      null,
    [generatedSets, activeSetNumber]
  );

  const generatedPreview = useMemo(
    () => activeGeneratedSet?.questions ?? [],
    [activeGeneratedSet]
  );

  const previewMcqItems = useMemo(
    () => generatedPreview.filter((q) => q.questionType === 'MCQ'),
    [generatedPreview]
  );
  const previewWrittenItems = useMemo(
    () => generatedPreview.filter((q) => q.questionType !== 'MCQ'),
    [generatedPreview]
  );

  const toggleBookSelection = (id: number) => {
    setSelectedBookIds((prev) =>
      prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]
    );
  };

  const toggleMasterBookSelection = (bookIds: number[]) => {
    setSelectedBookIds((prev) => {
      const allSelected = bookIds.every((id) => prev.includes(id));
      if (allSelected) {
        return prev.filter((id) => !bookIds.includes(id));
      }
      return Array.from(new Set([...prev, ...bookIds]));
    });
  };

  const handlePracticeTopicFromExplorer = (topicLabel: string) => {
    setFocusTopicFromExplorer(topicLabel);
    if (selectedBookIds.length === 0 && data.books.length > 0) {
      setSelectedBookIds(data.books.map((b) => b.id));
    }
    setActiveTab('generate');
  };

  const handleApplyDetectedFormat = (analysis: DemoPaperAnalysis) => {
    setQuestionMode(analysis.recommendedFormat);
    if (analysis.organizationDetected) {
      setOrganizationName(analysis.organizationDetected);
    }
    if (analysis.postNameDetected) {
      setPostName(analysis.postNameDetected);
    }
    if (analysis.durationMinutesDetected) {
      setPaperDurationMinutes(analysis.durationMinutesDetected);
    }
    if (analysis.mcqCountDetected > 0) {
      setMcqCount(Math.min(100, Math.max(1, analysis.mcqCountDetected)));
    }
    if (analysis.writtenSections && analysis.writtenSections.length > 0) {
      setWrittenSections(analysis.writtenSections);
      setWrittenCount(
        Math.min(
          25,
          Math.max(1, summarizeWrittenBlueprint(analysis.writtenSections).totalQuestions)
        )
      );
    } else if (analysis.writtenCountDetected > 0) {
      setWrittenCount(Math.min(20, Math.max(1, analysis.writtenCountDetected)));
    }
  };

  const runLocalDirectBookCompile = () => {
    setGenError(null);
    setGenIsQuotaError(false);
    setGenSuccessMsg(null);

    if (selectedBookIds.length === 0 && !(includeCurrentGk && activeGkCount > 0)) {
      setGenError('প্রশ্ন তৈরির জন্য অন্তত একটি বই (অথবা Current GK) নির্বাচন করুন।');
      return;
    }

    const chosenBooks = data.books.filter((b) => selectedBookIds.includes(b.id));
    const subjectLabel =
      chosenBooks.length === 1
        ? chosenBooks[0].subject
        : 'সমন্বিত (চাকরির পরীক্ষা)';

    const safeSetCount = Math.min(5, Math.max(1, Math.round(setCount || 1)));
    const targetMcq =
      questionMode === 'MCQ' || questionMode === 'Mixed'
        ? Math.min(100, Math.max(1, Math.round(mcqCount || 1)))
        : 0;
    const targetWritten =
      questionMode === 'Written'
        ? Math.min(
            25,
            Math.max(1, writtenBlueprintSummary.totalQuestions || writtenCount || 1)
          )
        : questionMode === 'Short' || questionMode === 'Mixed'
          ? Math.min(20, Math.max(1, Math.round(writtenCount || 1)))
          : 0;

    const compiled = compileExamSetsLocallyFromBooks({
      books: chosenBooks,
      gkItems: data.gkItems,
      includeCurrentGk,
      questionMode,
      mcqCount: targetMcq,
      writtenCount: targetWritten,
      setCount: safeSetCount,
      difficulty,
      subject: subjectLabel,
      jobExamPreset,
      topicDistribution: demoAnalysis?.topicDistribution,
      focusTopics: focusTopicFromExplorer ? [focusTopicFromExplorer] : undefined,
      existingStems: data.questions.map((q) => q.stem),
      orderingMode,
    });

    if (compiled.sets.length === 0) {
      setGenError(
        `নির্বাচিত বইগুলোতে ${questionMode === 'MCQ' ? '৪ অপশনযুক্ত MCQ' : 'সরাসরি সংকলনযোগ্য'} প্রশ্ন পাওয়া যায়নি (পাওয়া গেছে: MCQ ${toBengaliNumber(compiled.totalPoolMcq)}টি, লিখিত ${toBengaliNumber(compiled.totalPoolWritten)}টি)। ভিন্ন বই বা "AI স্মার্ট তৈরি" মোড নির্বাচন করুন।`
      );
      return;
    }

    setGeneratedSets(compiled.sets);
    setActiveSetNumber(compiled.sets[0]?.setNumber ?? 1);

    const shortfallNote =
      compiled.unfulfilledCount > 0
        ? ` (নির্বাচিত বইয়ে মোট ${toBengaliNumber(compiled.totalCompiledQuestions)}টি অনন্য প্রশ্ন পাওয়া গেছে)`
        : '';
    setGenSuccessMsg(
      `০ API কোটায় সরাসরি বই থেকে ${toBengaliNumber(compiled.sets.length)}টি সেটে মোট ${toBengaliNumber(compiled.totalCompiledQuestions)}টি প্রশ্ন সংকলন সম্পন্ন হয়েছে${shortfallNote}।`
    );
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenError(null);
    setGenIsQuotaError(false);
    setGenSuccessMsg(null);
    setGenProgressText('');

    if (generationEngine === 'local') {
      runLocalDirectBookCompile();
      return;
    }

    const authHeaders = await getAiAuthHeaders();
    if (!authHeaders) {
      requestAiSignIn('AI প্রশ্ন তৈরি (Question Lab)');
      return;
    }

    if (selectedBookIds.length === 0 && !(includeCurrentGk && activeGkCount > 0)) {
      setGenError('প্রশ্ন তৈরির জন্য অন্তত একটি বই (অথবা Current GK) নির্বাচন করুন।');
      return;
    }

    const chosenBooks = data.books.filter((b) => selectedBookIds.includes(b.id));
    const demoTopicLabels = demoAnalysis
      ? demoAnalysis.topicDistribution.map((t) => t.topicLabel)
      : focusTopicFromExplorer
        ? [focusTopicFromExplorer]
        : [];

    const gkChunks =
      includeCurrentGk && activeGkCount > 0
        ? buildCurrentGkChunks(data.gkItems, 2)
        : [];
    const initialChunks = selectRotatedChunksForBatch({
      books: data.books,
      selectedBookIds,
      selectedTopics: demoTopicLabels,
      batchIndex: 0,
      batchChunkLimit: 10,
      gkChunks,
    });

    if (initialChunks.length === 0) {
      setGenError('নির্বাচিত বইগুলোতে কোনো টেক্সট চ্যাংক পাওয়া যায়নি।');
      return;
    }

    const safeSetCount = Math.min(5, Math.max(1, Math.round(setCount || 1)));
    const targetMcq =
      questionMode === 'MCQ' || questionMode === 'Mixed'
        ? Math.min(100, Math.max(1, Math.round(mcqCount || 1)))
        : 0;
    const targetWritten =
      questionMode === 'Written'
        ? Math.min(
            25,
            Math.max(1, writtenBlueprintSummary.totalQuestions || writtenCount || 1)
          )
        : questionMode === 'Short' || questionMode === 'Mixed'
          ? Math.min(20, Math.max(1, Math.round(writtenCount || 1)))
          : 0;

    setGenerating(true);
    try {
      const subjectLabel =
        chosenBooks.length === 1
          ? chosenBooks[0].subject
          : 'সমন্বিত (চাকরির পরীক্ষা)';

      const allBuiltSets: GeneratedQuestionSet[] = [];
      const cumulativeStems = [...data.questions.map((q) => q.stem)];

      const runLabAiBatch = async (
        setNum: number,
        batchCursor: number,
        batch: { mcqCount: number; writtenCount: number },
        currentCount: number,
        totalInSet: number,
        totalBatches: number,
        isTopUp = false
      ): Promise<Array<Omit<Question, 'id' | 'createdAt'>>> => {
        const batchTotal = batch.mcqCount + batch.writtenCount;
        setGenProgressText(
          safeSetCount > 1
            ? `সেট ${toBengaliNumber(setNum)}/${toBengaliNumber(safeSetCount)} ${isTopUp ? 'ঘাটতি পূরণ হচ্ছে' : 'তৈরি হচ্ছে'} (${toBengaliNumber(currentCount)}/${toBengaliNumber(totalInSet)} প্রশ্ন)...`
            : totalBatches > 1 || isTopUp
              ? `${isTopUp ? 'অবশিষ্ট প্রশ্ন পূর্ণ করা হচ্ছে' : 'প্রশ্নপত্র তৈরি হচ্ছে'} (${toBengaliNumber(currentCount)}/${toBengaliNumber(totalInSet)} প্রশ্ন)...`
              : 'বই বিশ্লেষণ করে চাকরির প্রশ্নপত্র তৈরি হচ্ছে...'
        );

        const batchChunks = selectRotatedChunksForBatch({
          books: data.books,
          selectedBookIds,
          selectedTopics: demoTopicLabels,
          batchIndex: batchCursor,
          batchChunkLimit: 10,
          gkChunks,
        });

        const batchType: GeneratorQuestionMode =
          batch.mcqCount > 0 && batch.writtenCount > 0
            ? 'Mixed'
            : batch.mcqCount > 0
              ? 'MCQ'
              : questionMode === 'Short'
                ? 'Short'
                : 'Written';

        const batchAllocations = demoAnalysis
          ? allocateQuestionsByPercentage(
              demoAnalysis.topicDistribution,
              batchTotal
            )
          : [];

        const res = await fetch('/api/ai/questions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            chunks: batchChunks.map((c) => ({
              bookId: c.bookId,
              bookTitle: c.bookTitle,
              chapter: c.chapter,
              pageNumber: c.pageNumber,
              content: c.content,
            })),
            existingStems: cumulativeStems.slice(-140),
            subject: subjectLabel,
            questionType: batchType,
            difficulty,
            mcqCount: batch.mcqCount,
            writtenCount: batch.writtenCount,
            count: batchTotal,
            jobExamPreset,
            selectedTopics: demoTopicLabels,
            topicAllocations: batchAllocations.map((a) => ({
              topicLabel: a.topicLabel,
              percentage: a.percentage,
              targetCount: a.targetCount,
            })),
            setNumber: setNum,
            totalSets: safeSetCount,
            organizationName: organizationName.trim(),
            postName: postName.trim(),
            languageMode,
            writtenSections:
              batch.writtenCount > 0 && questionMode !== 'Short'
                ? writtenSections
                : [],
          }),
        });

        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) {
            requestAiSignIn('AI প্রশ্ন তৈরি (Question Lab)');
          }
          if (isRateLimitErrorPayload(res.status, json)) {
            setGenIsQuotaError(true);
          }
          throw new Error(
            formatAiResponseError(
              res.status,
              json,
              'AI প্রশ্ন তৈরি করতে ব্যর্থ হয়েছে।'
            )
          );
        }

        return Array.isArray(json.questions) ? json.questions : [];
      };

      for (let setNum = 1; setNum <= safeSetCount; setNum += 1) {
        const batches = splitGenerationIntoBatches({
          mcqCount: targetMcq,
          writtenCount: targetWritten,
          maxQuestionsPerBatch: 18,
        });

        const setQuestions: Array<Omit<Question, 'id' | 'createdAt'>> = [];
        const totalInSet = targetMcq + targetWritten;
        let batchCursor = (setNum - 1) * 5;

        for (let bIdx = 0; bIdx < batches.length; bIdx += 1) {
          const created = await runLabAiBatch(
            setNum,
            batchCursor,
            batches[bIdx],
            setQuestions.length,
            totalInSet,
            batches.length,
            false
          );
          batchCursor += 1;
          for (const q of created) {
            setQuestions.push(q);
            cumulativeStems.push(q.stem);
          }
        }

        // Bounded deficit top-up loop so requesting 70 MCQs reliably hits 70/70
        for (let extraPass = 0; extraPass < 3; extraPass += 1) {
          const currentMcq = setQuestions.filter(
            (q) => q.questionType === 'MCQ'
          ).length;
          const currentWritten = setQuestions.length - currentMcq;
          const deficit = computeNextDeficitBatch({
            targetMcq,
            targetWritten,
            currentMcq,
            currentWritten,
            maxQuestionsPerBatch: 18,
          });
          if (!deficit) break;

          const topUp = await runLabAiBatch(
            setNum,
            batchCursor,
            deficit,
            setQuestions.length,
            totalInSet,
            batches.length,
            true
          );
          batchCursor += 1;
          if (topUp.length === 0) break;

          for (const q of topUp) {
            setQuestions.push(q);
            cumulativeStems.push(q.stem);
          }
        }

        const finalSet = trimGeneratedSetToTargets(
          setQuestions,
          targetMcq,
          targetWritten
        );

        if (finalSet.length > 0) {
          const orderedSetQuestions = orderQuestionsForExam(
            finalSet,
            orderingMode,
            setNum * 17
          );
          allBuiltSets.push({
            setNumber: setNum,
            questions: orderedSetQuestions,
          });
        }
      }

      setGeneratedSets(allBuiltSets);
      setActiveSetNumber(allBuiltSets[0]?.setNumber ?? 1);

      if (allBuiltSets.length === 0) {
        setGenError(
          'নতুন কোনো অনন্য প্রশ্ন তৈরি হয়নি—বই বা ডেমো প্রশ্ন পরিবর্তন করে আবার চেষ্টা করুন।'
        );
      } else {
        const totalCreated = allBuiltSets.reduce(
          (sum, s) => sum + s.questions.length,
          0
        );
        setGenSuccessMsg(
          `${toBengaliNumber(allBuiltSets.length)}টি সেটে মোট ${toBengaliNumber(totalCreated)}টি চাকরির পরীক্ষার প্রশ্ন তৈরি হয়েছে।`
        );
      }
    } catch (err) {
      setGenError(
        err instanceof Error ? err.message : 'প্রশ্ন তৈরিতে ত্রুটি হয়েছে।'
      );
    } finally {
      setGenerating(false);
      setGenProgressText('');
    }
  };

  const handleSaveAllSetsToBank = async () => {
    const allQuestions = generatedSets.flatMap((s) => s.questions);
    if (allQuestions.length === 0) return;
    await addQuestions(allQuestions);
    setGenSuccessMsg(
      `${toBengaliNumber(generatedSets.length)}টি সেটের মোট ${toBengaliNumber(allQuestions.length)}টি প্রশ্ন সফলভাবে Question Bank-এ সংরক্ষিত হয়েছে।`
    );
    setGeneratedSets([]);
  };

  const handleLaunchExamFromActiveSet = async () => {
    if (!activeGeneratedSet || activeGeneratedSet.questions.length === 0 || startingExam)
      return;
    setStartingExam(true);
    setGenError(null);
    try {
      const savedQuestions = await addQuestions(activeGeneratedSet.questions);
      const hasMcq = savedQuestions.some((q) => q.questionType === 'MCQ');
      const hasWritten = savedQuestions.some((q) => q.questionType !== 'MCQ');
      const examMode =
        hasMcq && hasWritten ? 'Mixed' : hasMcq ? 'MCQ' : 'Written';
      const setSuffix =
        generatedSets.length > 1
          ? ` — সেট-${toBengaliNumber(activeGeneratedSet.setNumber)}`
          : '';
      const titleBase =
        [organizationName.trim(), postName.trim()].filter(Boolean).join(' — ') ||
        demoAnalysis?.examTitleDetected ||
        jobExamPreset.split('(')[0].trim();
      const createdExam = await createExam({
        title: `${titleBase}${setSuffix}`,
        subject:
          demoAnalysis?.topicDistribution[0]?.subjectGroup ||
          focusTopicFromExplorer ||
          'সমন্বিত (চাকরির পরীক্ষা)',
        examMode,
        durationMinutes: Math.max(
          10,
          paperDurationMinutes || savedQuestions.length * 2
        ),
        marksPerQuestion: 1,
        negativeMark: hasMcq ? paperNegativeMark : 0,
        questionIds: savedQuestions.map((q) => q.id),
      });
      setGeneratedSets([]);
      setActiveExamId(createdExam.id);
      setActiveModule('exam-center');
    } catch (err) {
      setGenError(
        err instanceof Error ? err.message : 'পরীক্ষা শুরু করতে সমস্যা হয়েছে।'
      );
    } finally {
      setStartingExam(false);
    }
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
            একাধিক বই বিশ্লেষণ করে চাকরির পরীক্ষার অনুরূপ MCQ ও Written প্রশ্নপত্র তৈরি করুন এবং অটোমেটেড AI টপিক ট্যাগিং দিয়ে সিলেবাসভিত্তিক প্রশ্ন খুঁজুন।
          </p>
        </div>

        <div
          role="tablist"
          aria-label="প্রশ্ন ল্যাব সেকশন"
          className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-200/70 p-1 self-start sm:self-auto"
        >
          <button
            type="button"
            role="tab"
            data-testid="qlab-tab-generate"
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
            data-testid="qlab-tab-topics"
            aria-selected={activeTab === 'topics'}
            onClick={() => setActiveTab('topics')}
            className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'topics'
                ? 'bg-white text-blue-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Tag className="h-3.5 w-3.5" />
            <span>টপিক ক্লাস্টার ও সিলেবাস</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'export'}
            onClick={() => setActiveTab('export')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'export'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            প্রশ্নপত্র এক্সপোর্ট ও KaTeX
          </button>
          <button
            type="button"
            role="tab"
            data-testid="qlab-tab-bank"
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

      {/* TAB: AUTOMATED SYLLABUS TOPIC CLUSTERS ACROSS ALL BOOKS */}
      {activeTab === 'topics' && (
        <TopicClusterExplorerPanel
          onPracticeTopic={handlePracticeTopicFromExplorer}
        />
      )}

      {/* TAB: STRUCTURED EXAM PAPER EXPORT (PDF / TXT) */}
      {activeTab === 'export' && <ExamPaperExportPanel />}

      {/* TAB 1: JOB-EXAM STYLE AI QUESTION GENERATOR */}
      {activeTab === 'generate' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
          <form
            onSubmit={handleGenerate}
            className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-5"
          >
            {/* Step 1: Multi-book selector */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-700">
                  ১. উৎস বই নির্বাচন করুন ({toBengaliNumber(selectedBookIds.length)}টি নির্বাচিত)
                </span>
                {data.books.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedBookIds(
                        selectedBookIds.length === data.books.length
                          ? []
                          : data.books.map((b) => b.id)
                      )
                    }
                    className="text-[11px] font-semibold text-blue-700 hover:underline"
                  >
                    {selectedBookIds.length === data.books.length
                      ? 'সব বাতিল'
                      : 'সব বই নির্বাচন'}
                  </button>
                )}
              </div>
              {data.books.length === 0 ? (
                <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                  এখনো কোনো বই লাইব্রেরিতে যুক্ত নেই। আগে 01. Book Library থেকে বই যুক্ত করুন।
                </p>
              ) : (
                <div
                  data-testid="qlab-book-picker"
                  className="max-h-56 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200"
                >
                  {virtualCatalog.map((entry) => {
                    if (entry.isVirtualSeries) {
                      const partIds = entry.books.map((b) => b.id);
                      const selectedCount = partIds.filter((id) =>
                        selectedBookIds.includes(id)
                      ).length;
                      const allChecked = selectedCount === partIds.length;
                      const isExpanded = Boolean(expandedPickerMasters[entry.masterKey]);
                      return (
                        <div key={entry.masterKey} className="bg-white">
                          <div className="flex items-start justify-between gap-2 p-2.5 hover:bg-slate-50">
                            <label className="flex items-start gap-2.5 flex-1 min-w-0 cursor-pointer">
                              <input
                                type="checkbox"
                                data-testid={`qlab-master-check-${entry.masterKey}`}
                                checked={allChecked}
                                onChange={() => toggleMasterBookSelection(partIds)}
                                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600 shrink-0"
                              />
                              <span className="min-w-0">
                                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 leading-snug">
                                  <FolderOpen className="h-3.5 w-3.5 text-blue-700 shrink-0" />
                                  <span className="truncate">{entry.title}</span>
                                </span>
                                <span className="block text-[11px] text-slate-500 mt-0.5">
                                  <span className="font-semibold text-blue-700">
                                    {BOOK_FORMAT_LABELS[entry.format]}
                                  </span>{' '}
                                  · {toBengaliNumber(entry.books.length)}টি খণ্ড ·{' '}
                                  {toBengaliNumber(entry.totalPages)} পৃষ্ঠা
                                  {selectedCount > 0 && !allChecked
                                    ? ` (${toBengaliNumber(selectedCount)}/${toBengaliNumber(partIds.length)} নির্বাচিত)`
                                    : ''}
                                </span>
                              </span>
                            </label>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedPickerMasters((prev) => ({
                                  ...prev,
                                  [entry.masterKey]: !prev[entry.masterKey],
                                }))
                              }
                              aria-label="খণ্ডসমূহ দেখান"
                              className="rounded p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 shrink-0"
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                          {isExpanded && (
                            <div className="border-t border-slate-100 bg-slate-50/70 divide-y divide-slate-100 pl-7">
                              {entry.books.map((book) => {
                                const checked = selectedBookIds.includes(book.id);
                                return (
                                  <label
                                    key={book.id}
                                    className="flex items-start gap-2 px-2.5 py-1.5 hover:bg-slate-100/70 cursor-pointer"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleBookSelection(book.id)}
                                      className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                                    />
                                    <span className="min-w-0 text-[11px]">
                                      <span className="block font-medium text-slate-800 truncate">
                                        {book.title}
                                      </span>
                                      <span className="text-slate-500">
                                        {toBengaliNumber(book.chunks.length)} অধ্যায়/পৃষ্ঠা
                                      </span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    }

                    const book = entry.books[0];
                    const checked = selectedBookIds.includes(book.id);
                    return (
                      <label
                        key={book.id}
                        className="flex items-start gap-2.5 p-2.5 hover:bg-slate-50 cursor-pointer"
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
                          <span className="block text-[11px] text-slate-500">
                            <span className="font-semibold text-blue-700">
                              {BOOK_FORMAT_LABELS[entry.format]}
                            </span>{' '}
                            · {book.subject} · {toBengaliNumber(book.chunks.length)} অধ্যায়/পৃষ্ঠা
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {/* Current GK & Paper Cutting Source Toggle */}
              <label className="mt-2.5 flex items-start gap-2 rounded-lg border border-blue-200/80 bg-blue-50/50 p-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="qlab-include-current-gk"
                  checked={includeCurrentGk}
                  onChange={(e) => setIncludeCurrentGk(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700"
                />
                <span className="min-w-0 text-xs">
                  <span className="flex items-center gap-1 font-semibold text-blue-950">
                    <Globe className="h-3.5 w-3.5 text-blue-700" />
                    <span>Current GK ও Paper Cutting থেকে সাম্প্রতিক প্রশ্ন অন্তর্ভুক্ত করুন</span>
                  </span>
                  <span className="block text-[11px] text-slate-600 mt-0.5">
                    সক্রিয় সাম্প্রতিক তথ্য: {toBengaliNumber(activeGkCount)}টি (মেট্রোরেল, বাজেট, সাম্প্রতিক খবর)
                  </span>
                </span>
              </label>
            </div>

            {/* Step 2: Job Exam Format + Org/Post + Adaptive MCQ/Written Controls */}
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="gen-job-preset"
                  className="block text-xs font-semibold text-slate-700"
                >
                  ২. চাকরির পরীক্ষার ধরন / প্যাটার্ন
                </label>
                <select
                  id="gen-job-preset"
                  value={jobExamPreset}
                  onChange={(e) => setJobExamPreset(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  {JOB_EXAM_PRESETS.map((p) => (
                    <option key={p.id} value={p.label}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Optional Org & Post Header Context */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="gen-org-name"
                    className="block text-[11px] font-semibold text-slate-700"
                  >
                    প্রতিষ্ঠান / মন্ত্রণালয় (ঐচ্ছিক)
                  </label>
                  <input
                    id="gen-org-name"
                    data-testid="qlab-org-input"
                    type="text"
                    value={organizationName}
                    onChange={(e) => setOrganizationName(e.target.value)}
                    placeholder="যেমন: জেলা প্রশাসকের কার্যালয়"
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="gen-post-name"
                    className="block text-[11px] font-semibold text-slate-700"
                  >
                    পদের নাম (ঐচ্ছিক)
                  </label>
                  <input
                    id="gen-post-name"
                    data-testid="qlab-post-input"
                    type="text"
                    value={postName}
                    onChange={(e) => setPostName(e.target.value)}
                    placeholder="যেমন: অফিস সহকারী / জুনিয়র শিক্ষক"
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="gen-q-type"
                    className="block text-xs font-semibold text-slate-700"
                  >
                    প্রশ্নপত্রের ফরম্যাট
                  </label>
                  <select
                    id="gen-q-type"
                    data-testid="qlab-question-mode-select"
                    value={questionMode}
                    onChange={(e) =>
                      setQuestionMode(e.target.value as GeneratorQuestionMode)
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                  >
                    <option value="Mixed">MCQ + Written (পূর্ণ চাকরির সেট)</option>
                    <option value="MCQ">শুধু MCQ (বহুনির্বাচনি)</option>
                    <option value="Written">শুধু Written (লিখিত)</option>
                    <option value="Short">শুধু Short (সংক্ষিপ্ত)</option>
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
                    className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none"
                  >
                    <option value="Easy">Easy (সহজ)</option>
                    <option value="Medium">Medium (মাঝারি)</option>
                    <option value="Hard">Hard (কঠিন / বিশ্লেষণধর্মী)</option>
                  </select>
                </div>
              </div>

              {/* Separate MCQ, Written, Set Count & Duration */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {(questionMode === 'Mixed' || questionMode === 'MCQ') && (
                  <div>
                    <label
                      htmlFor="gen-mcq-count"
                      className="block text-xs font-semibold text-slate-700"
                    >
                      MCQ সংখ্যা (প্রতি সেট)
                    </label>
                    <input
                      id="gen-mcq-count"
                      data-testid="qlab-mcq-count-input"
                      type="number"
                      min={1}
                      max={100}
                      value={mcqCount}
                      onChange={(e) => setMcqCount(Number(e.target.value))}
                      className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                )}

                {(questionMode === 'Mixed' || questionMode === 'Short') && (
                  <div>
                    <label
                      htmlFor="gen-written-count"
                      className="block text-xs font-semibold text-slate-700"
                    >
                      {questionMode === 'Short'
                        ? 'Short সংখ্যা'
                        : 'Written সংখ্যা'}
                    </label>
                    <input
                      id="gen-written-count"
                      data-testid="qlab-written-count-input"
                      type="number"
                      min={1}
                      max={20}
                      value={writtenCount}
                      onChange={(e) => setWrittenCount(Number(e.target.value))}
                      className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                )}

                <div>
                  <label
                    htmlFor="gen-set-count"
                    className="block text-xs font-semibold text-slate-700"
                  >
                    কত সেট প্রশ্ন (১–৫)
                  </label>
                  <input
                    id="gen-set-count"
                    data-testid="qlab-set-count-input"
                    type="number"
                    min={1}
                    max={5}
                    value={setCount}
                    onChange={(e) => setSetCount(Number(e.target.value))}
                    className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="gen-duration-input"
                    className="block text-xs font-semibold text-slate-700"
                  >
                    সময় (মিনিট)
                  </label>
                  <input
                    id="gen-duration-input"
                    type="number"
                    min={10}
                    max={240}
                    value={paperDurationMinutes}
                    onChange={(e) =>
                      setPaperDurationMinutes(Number(e.target.value))
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              {/* Format-Adaptive MCQ Controls (shown only in MCQ or Mixed mode) */}
              {(questionMode === 'MCQ' || questionMode === 'Mixed') && (
                <div
                  data-testid="qlab-mcq-adaptive-controls"
                  className="grid grid-cols-1 gap-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-2"
                >
                  <div>
                    <label
                      htmlFor="gen-ordering-mode"
                      className="block text-[11px] font-semibold text-slate-700"
                    >
                      প্রশ্ন সাজানোর ক্রম
                    </label>
                    <select
                      id="gen-ordering-mode"
                      value={orderingMode}
                      onChange={(e) =>
                        setOrderingMode(e.target.value as QuestionOrderingMode)
                      }
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    >
                      {Object.entries(QUESTION_ORDERING_LABELS).map(
                        ([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        )
                      )}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="gen-negative-mark"
                      className="block text-[11px] font-semibold text-slate-700"
                    >
                      নেগেটিভ মার্কিং (ভুল MCQ প্রতি)
                    </label>
                    <select
                      id="gen-negative-mark"
                      value={paperNegativeMark}
                      onChange={(e) =>
                        setPaperNegativeMark(Number(e.target.value))
                      }
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900"
                    >
                      <option value={0}>0.00 (নেই)</option>
                      <option value={0.25}>-0.25 (ব্যাংক / প্রাইমারি)</option>
                      <option value={0.5}>-0.50 (বিসিএস প্রিলি)</option>
                    </select>
                  </div>

                  <div className="sm:col-span-2">
                    <label
                      htmlFor="gen-language-mode"
                      className="block text-[11px] font-semibold text-slate-700"
                    >
                      প্রশ্নের ভাষার ধরন
                    </label>
                    <select
                      id="gen-language-mode"
                      value={languageMode}
                      onChange={(e) =>
                        setLanguageMode(e.target.value as QuestionLanguageMode)
                      }
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    >
                      {Object.entries(QUESTION_LANGUAGE_LABELS).map(
                        ([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                </div>
              )}

              {/* Format-Adaptive Written Blueprint Editor (shown only in Written or Mixed mode) */}
              {(questionMode === 'Written' || questionMode === 'Mixed') && (
                <WrittenBlueprintEditor
                  sections={writtenSections}
                  onChange={setWrittenSections}
                  testIdPrefix="qlab-written-blueprint"
                />
              )}
            </div>

            {focusTopicFromExplorer && !demoAnalysis && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
                <span>
                  নির্বাচিত টপিক: <strong>{focusTopicFromExplorer}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => setFocusTopicFromExplorer(null)}
                  className="text-[11px] font-semibold text-blue-700 hover:underline"
                >
                  বাতিল
                </button>
              </div>
            )}

            {/* Step 3: Demo Photo / PDF Upload & AI Topic Percentage Analysis */}
            <DemoPaperUploader
              targetTotalQuestionsPerSet={targetTotalPerSet}
              analysis={demoAnalysis}
              onAnalysisChange={setDemoAnalysis}
              onApplyDetectedFormat={handleApplyDetectedFormat}
              testIdPrefix="qlab-demo"
              compact
            />

            {/* Engine Selector: Zero-API Direct Book Compiler vs Gemini AI (with Auto Failover) */}
            <div
              data-testid="qlab-engine-selector"
              className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900">
                  ৪. প্রশ্ন তৈরির ইঞ্জিন নির্বাচন করুন
                </span>
                <span className="text-[10.5px] font-medium text-emerald-700">
                  {generationEngine === 'local'
                    ? '০ API কোটা · সীমাহীন'
                    : 'অটো মডেল ফেইলওভার সক্রিয়'}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  data-testid="qlab-engine-local-btn"
                  onClick={() => {
                    setGenerationEngine('local');
                    setGenError(null);
                    setGenIsQuotaError(false);
                  }}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    generationEngine === 'local'
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-950'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <BookOpen className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                    <span>সরাসরি বই থেকে (০ API)</span>
                  </div>
                  <p className="mt-0.5 text-[10.5px] text-slate-600 leading-snug">
                    লাইব্রেরির বই থেকে তাৎক্ষণিক প্রশ্ন, উত্তর ও ব্যাখ্যা সংকলন—কোনো কোটা লিমিট নেই।
                  </p>
                </button>
                <button
                  type="button"
                  data-testid="qlab-engine-ai-btn"
                  onClick={() => {
                    setGenerationEngine('ai');
                    setGenError(null);
                    setGenIsQuotaError(false);
                  }}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    generationEngine === 'ai'
                      ? 'border-blue-600 bg-blue-50 text-blue-950'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <Sparkles className="h-3.5 w-3.5 text-blue-700 shrink-0" />
                    <span>AI স্মার্ট প্রশ্ন তৈরি</span>
                  </div>
                  <p className="mt-0.5 text-[10.5px] text-slate-600 leading-snug">
                    Gemini API দিয়ে নতুন প্রশ্ন ও AI ব্যাখ্যা তৈরি (কোটা বাঁচাতে স্বয়ংক্রিয় ফেইলওভারসহ)।
                  </p>
                </button>
              </div>
            </div>

            {genError && (
              <div
                role="alert"
                className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-800"
              >
                <p>{genError}</p>
                {genIsQuotaError && (
                  <button
                    type="button"
                    data-testid="qlab-quota-local-fallback-btn"
                    onClick={() => {
                      setGenerationEngine('local');
                      runLocalDirectBookCompile();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-50 transition-colors"
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                    <span>০ API কোটায় সরাসরি বই থেকে এখনই প্রশ্ন তৈরি করুন</span>
                  </button>
                )}
              </div>
            )}
            {genSuccessMsg && (
              <p className="text-xs font-medium text-emerald-700">
                {genSuccessMsg}
              </p>
            )}

            <button
              type="submit"
              data-testid="qlab-generate-btn"
              disabled={generating}
              className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 transition-colors ${
                generationEngine === 'local'
                  ? 'bg-emerald-700 hover:bg-emerald-800'
                  : 'bg-blue-700 hover:bg-blue-800'
              }`}
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>
                    {genProgressText ||
                      'বই বিশ্লেষণ করে চাকরির প্রশ্নপত্র তৈরি হচ্ছে...'}
                  </span>
                </>
              ) : generationEngine === 'local' ? (
                <>
                  <BookOpen className="h-4 w-4" />
                  <span>
                    {setCount > 1
                      ? `সরাসরি বই থেকে ${toBengaliNumber(Math.min(5, Math.max(1, setCount)))} সেট প্রশ্ন সংকলন করুন (০ API)`
                      : 'সরাসরি বই থেকে চাকরির প্রশ্নপত্র তৈরি করুন (০ API)'}
                  </span>
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  <span>
                    {setCount > 1
                      ? `AI দিয়ে ${toBengaliNumber(Math.min(5, Math.max(1, setCount)))} সেট প্রশ্নপত্র তৈরি করুন`
                      : 'AI দিয়ে চাকরির পরীক্ষার প্রশ্ন তৈরি করুন'}
                  </span>
                </>
              )}
            </button>
          </form>

          {/* Generated Job-Exam Question Paper Preview Panel */}
          <section
            aria-label="তৈরি হওয়া চাকরির প্রশ্নপত্রের প্রিভিউ"
            className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  তৈরি হওয়া প্রশ্নপত্র (চাকরির পরীক্ষার ফরম্যাট)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  ডেমো প্রশ্নপত্রের শতকরা (%) প্রাধান্য অনুযায়ী সেটভিত্তিক MCQ ও Written প্রশ্ন, উত্তর ও বই/AI ব্যাখ্যা।
                </p>
              </div>
              {generatedSets.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="qlab-print-question-only-btn"
                    onClick={() => {
                      setPrintSourceKind('generated');
                      setPrintModalInitialMode('question-only');
                      setPrintModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap"
                  >
                    <Printer className="h-3.5 w-3.5 text-slate-600" />
                    <span>শুধু প্রশ্নপত্র প্রিন্ট</span>
                  </button>
                  <button
                    type="button"
                    data-testid="qlab-print-with-answers-btn"
                    onClick={() => {
                      setPrintSourceKind('generated');
                      setPrintModalInitialMode('with-answers');
                      setPrintModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 transition-colors whitespace-nowrap"
                  >
                    <Printer className="h-3.5 w-3.5 text-blue-700" />
                    <span>উত্তরসহ প্রিন্ট / PDF</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveAllSetsToBank()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-700 bg-white px-3.5 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 transition-colors whitespace-nowrap"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>
                      {generatedSets.length > 1
                        ? `সব সেট (${toBengaliNumber(generatedSets.length)}) সংরক্ষণ`
                        : 'প্রশ্নব্যাংকে সংরক্ষণ'}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={startingExam}
                    onClick={() => void handleLaunchExamFromActiveSet()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {startingExam ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {generatedSets.length > 1
                        ? `সেট-${toBengaliNumber(activeSetNumber)} দিয়ে পরীক্ষা দিন`
                        : 'এই প্রশ্নপত্র দিয়ে পরীক্ষা দিন'}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* Multi-Set Switcher Tabs */}
            {generatedSets.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                <span className="inline-flex items-center gap-1 px-2 text-xs font-semibold text-slate-600">
                  <Layers className="h-3.5 w-3.5 text-blue-700" />
                  প্রশ্নসেট:
                </span>
                {generatedSets.map((s) => (
                  <button
                    key={s.setNumber}
                    type="button"
                    onClick={() => setActiveSetNumber(s.setNumber)}
                    className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                      activeSetNumber === s.setNumber
                        ? 'bg-blue-700 text-white'
                        : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    সেট-{toBengaliNumber(s.setNumber)} ({toBengaliNumber(s.questions.length)}টি)
                  </button>
                ))}
              </div>
            )}

            {generatedPreview.length === 0 ? (
              <div className="py-16 text-center space-y-2">
                <FileText className="mx-auto h-7 w-7 text-slate-300" />
                <p className="text-sm text-slate-500">
                  বাম পাশ থেকে বই, প্রশ্নসংখ্যা, কত সেট প্রশ্ন এবং চাইলে ডেমো প্রশ্নের ফটো বা PDF আপলোড করে{' '}
                  <strong className="font-semibold text-slate-700">
                    “AI দিয়ে চাকরির পরীক্ষার প্রশ্ন তৈরি করুন”
                  </strong>{' '}
                  ক্লিক করুন।
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {previewMcqItems.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                      <h3 className="text-xs font-bold uppercase tracking-wide text-blue-800">
                        অংশ-ক: বহুনির্বাচনি প্রশ্ন (MCQ — {toBengaliNumber(previewMcqItems.length)}টি)
                      </h3>
                    </div>
                    <div className="divide-y divide-slate-200">
                      {previewMcqItems.map((q, idx) => {
                        const expInfo = parseExplanationSource(
                          q.explanation,
                          q.bookTitle,
                          q.pageNumber
                        );
                        return (
                          <div key={`mcq-${idx}`} className="py-3.5 first:pt-0">
                            <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                              <span className="font-semibold text-blue-700">
                                {q.chapter}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{q.bookTitle}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                পৃষ্ঠা {toBengaliNumber(q.pageNumber)}
                              </span>
                            </div>
                            <p className="mt-1.5 text-sm font-semibold text-slate-900">
                              {toBengaliNumber(idx + 1)}. <KatexMathText text={q.stem} />
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
                                    {['ক', 'খ', 'গ', 'ঘ'][oIdx] ??
                                      String.fromCharCode(65 + oIdx)}
                                    ) <KatexMathText text={opt} />
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="mt-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 text-xs space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-bold text-emerald-900">
                                  উত্তর: <KatexMathText text={q.modelAnswer} />
                                </span>
                                {expInfo.hasExplanation && (
                                  <span
                                    className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold ${
                                      expInfo.source === 'ai'
                                        ? 'border-blue-200 bg-blue-50 text-blue-800'
                                        : 'border-emerald-200 bg-white text-emerald-800'
                                    }`}
                                  >
                                    {expInfo.source === 'ai' ? (
                                      <Sparkles className="h-2.5 w-2.5" />
                                    ) : (
                                      <BookOpen className="h-2.5 w-2.5" />
                                    )}
                                    <span>{expInfo.badgeLabel}</span>
                                  </span>
                                )}
                              </div>
                              {expInfo.hasExplanation && (
                                <p className="text-slate-700 leading-relaxed">
                                  <span className="font-semibold text-slate-900">
                                    ব্যাখ্যা:{' '}
                                  </span>
                                  <KatexMathText text={expInfo.text} />
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {previewWrittenItems.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-900">
                        অংশ-খ: লিখিত প্রশ্ন (Written / Short — {toBengaliNumber(previewWrittenItems.length)}টি)
                      </h3>
                    </div>
                    <div className="divide-y divide-slate-200">
                      {previewWrittenItems.map((q, idx) => {
                        const expInfo = parseExplanationSource(
                          q.explanation,
                          q.bookTitle,
                          q.pageNumber
                        );
                        return (
                          <div key={`written-${idx}`} className="py-3.5 first:pt-0">
                            <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                              <span className="font-semibold text-blue-700">
                                {q.chapter}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{q.questionType}</span>
                              <span aria-hidden="true">·</span>
                              <span>{q.bookTitle}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                পৃষ্ঠা {toBengaliNumber(q.pageNumber)}
                              </span>
                            </div>
                            {(() => {
                              const parsedW = parseWrittenQuestionStructure(
                                q.stem,
                                5
                              );
                              return (
                                <div className="mt-1.5 space-y-1.5">
                                  <div className="flex items-start justify-between gap-2">
                                    <p className="text-sm font-semibold text-slate-900 whitespace-pre-wrap">
                                      {toBengaliNumber(idx + 1)}.{' '}
                                      <KatexMathText text={parsedW.displayStem} />
                                      {parsedW.isChoiceOne && (
                                        <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-800 border border-amber-200">
                                          যেকোনো ১টি
                                        </span>
                                      )}
                                    </p>
                                    <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-700">
                                      নম্বর: {toBengaliNumber(parsedW.marks)}
                                    </span>
                                  </div>
                                  {parsedW.subItems.length >= 2 && (
                                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 rounded-md border border-slate-200 bg-slate-50/70 p-2 text-xs text-slate-800">
                                      {parsedW.subItems.map((sub) => (
                                        <div key={sub.label}>
                                          <strong>{sub.label}.</strong>{' '}
                                          <KatexMathText text={sub.prompt} />
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            <div className="mt-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 text-xs space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-semibold text-slate-900">
                                  মডেল উত্তর:
                                </span>
                                {expInfo.hasExplanation && (
                                  <span
                                    className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold ${
                                      expInfo.source === 'ai'
                                        ? 'border-blue-200 bg-blue-50 text-blue-800'
                                        : 'border-emerald-200 bg-white text-emerald-800'
                                    }`}
                                  >
                                    {expInfo.source === 'ai' ? (
                                      <Sparkles className="h-2.5 w-2.5" />
                                    ) : (
                                      <BookOpen className="h-2.5 w-2.5" />
                                    )}
                                    <span>{expInfo.badgeLabel}</span>
                                  </span>
                                )}
                              </div>
                              <p className="font-medium text-slate-900 leading-relaxed whitespace-pre-wrap">
                                <KatexMathText text={q.modelAnswer} />
                              </p>
                              {expInfo.hasExplanation && (
                                <p className="border-t border-slate-200/70 pt-1.5 text-slate-700 leading-relaxed">
                                  <span className="font-semibold text-slate-900">
                                    ব্যাখ্যা:{' '}
                                  </span>
                                  <KatexMathText text={expInfo.text} />
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB 2: QUESTION BANK (ENHANCED WITH SYLLABUS TOPIC FILTER) */}
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
                aria-label="সিলেবাস টপিক ফিল্টার"
                data-testid="bank-topic-filter-select"
                value={bankTopicFilter}
                onChange={(e) => setBankTopicFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
              >
                <option value="সব">সব সিলেবাস টপিক</option>
                {availableBankTopics.map(([topicLabel, cnt]) => (
                  <option key={topicLabel} value={topicLabel}>
                    {topicLabel} ({toBengaliNumber(cnt)})
                  </option>
                ))}
              </select>

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

            <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
              <div className="relative flex-1 lg:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  aria-label="প্রশ্নব্যাংকে খুঁজুন"
                  value={bankSearch}
                  onChange={(e) => setBankSearch(e.target.value)}
                  placeholder="প্রশ্ন, টপিক বা অধ্যায় খুঁজুন..."
                  className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
              {filteredBank.length > 0 && (
                <button
                  type="button"
                  data-testid="bank-print-paper-btn"
                  onClick={() => {
                    setPrintSourceKind('bank');
                    setPrintModalInitialMode('question-only');
                    setPrintModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-100 whitespace-nowrap"
                >
                  <Printer className="h-3.5 w-3.5" />
                  <span>প্রশ্নপত্র প্রিন্ট / PDF</span>
                </button>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
            {filteredBank.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                নির্বাচিত ফিল্টারে কোনো প্রশ্ন পাওয়া যায়নি।
              </div>
            ) : (
              filteredBank.map(({ question: q, syllabusTopic }) => {
                const expanded = expandedQuestionId === q.id;
                return (
                  <div key={q.id} className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                          <span className="font-semibold text-blue-700">
                            {syllabusTopic.label}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-slate-800">
                            {q.questionType}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{q.difficulty}</span>
                          <span aria-hidden="true">·</span>
                          <span>{q.subject}</span>
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
                          <KatexMathText text={q.stem} />
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
                                  {String.fromCharCode(65 + idx)}.{' '}
                                  <KatexMathText text={opt} />
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="text-xs text-slate-700 leading-relaxed">
                          <span className="font-semibold text-slate-900">
                            মডেল উত্তর:
                          </span>{' '}
                          <span className="font-bold text-slate-900">
                            <KatexMathText text={q.modelAnswer} />
                          </span>
                        </div>
                        {q.explanation && (
                          <div className="text-xs text-slate-600 leading-relaxed">
                            <span className="font-semibold text-slate-800">
                              ব্যাখ্যা ও সূত্র:
                            </span>{' '}
                            <KatexMathText text={q.explanation} /> ({q.bookTitle}, পৃষ্ঠা {q.pageNumber})
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

      {/* Printable Real Exam Paper Modal (Question-only OR Question + Answers/Explanations) */}
      <PrintableExamPaperModal
        key={`${printSourceKind}-${printModalInitialMode}-${printModalOpen ? 'open' : 'closed'}`}
        open={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        initialMode={printModalInitialMode}
        organizationName={organizationName}
        postName={postName}
        examTitle={
          printSourceKind === 'bank'
            ? `প্রশ্নব্যাংক মডেল প্রশ্নপত্র (${toBengaliNumber(filteredBank.length)}টি প্রশ্ন)`
            : demoAnalysis?.examTitleDetected ||
              jobExamPreset.split('(')[0].trim()
        }
        setNumber={printSourceKind === 'generated' ? activeSetNumber : 1}
        totalSets={printSourceKind === 'generated' ? generatedSets.length : 1}
        totalMarks={printSourceKind === 'generated' ? computedTotalMarks : undefined}
        durationMinutes={paperDurationMinutes}
        questions={
          printSourceKind === 'bank'
            ? filteredBank.map((item) => item.question)
            : generatedPreview
        }
      />
    </div>
  );
}
