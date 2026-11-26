'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Play,
  Save,
  Send,
  Plus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  BookOpen,
  Sparkles,
  Eye,
  Flag,
  Globe,
  LayoutGrid,
  Trash2,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
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
import { prepareImageForPaperCuttingApi } from '@/src/lib/image-upload-utils';
import {
  extractMistakesFromAttempt,
  scoreExamAttempt,
  type WrittenGradeOverride,
} from '@/src/lib/exam-engine';
import {
  classifyQuestionSyllabusTopic,
  type SyllabusSubjectGroup,
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
  SUBJECT_SERIAL_ORDER,
  buildCurrentGkChunks,
  cloneDefaultWrittenBlueprint,
  detectQuestionSubjectGroup,
  orderQuestionsForExam,
  parseWrittenQuestionStructure,
  summarizeWrittenBlueprint,
  type QuestionLanguageMode,
  type QuestionOrderingMode,
  type WrittenSectionBlueprint,
} from '@/src/lib/job-exam-paper';
import { DemoPaperUploader } from './DemoPaperUploader';
import { ExamAnswerSheetView } from './ExamAnswerSheetView';
import { WrittenBlueprintEditor } from './WrittenBlueprintEditor';
import {
  LiveWrittenQuestionCard,
  type HandwrittenPhotoItem,
} from './LiveWrittenQuestionCard';
import { KatexMathText } from './KatexMathText';
import type {
  DifficultyLevel,
  ExamAnswerDraft,
  ExamAttempt,
  ExamMode,
  Question,
} from '@/src/types/system';

type ExamBuilderSourceMode = 'ai-books' | 'manual-bank';

export function ExamCenterView() {
  const {
    data,
    activeExamId,
    setActiveExamId,
    addQuestions,
    createExam,
    deleteExam,
    saveExamDraft,
    saveExamAttempt,
    getAiAuthHeaders,
    requestAiSignIn,
  } = useWorkspace();

  // Custom Exam Builder state
  const [showBuilder, setShowBuilder] = useState(false);
  const [builderSourceMode, setBuilderSourceMode] =
    useState<ExamBuilderSourceMode>('ai-books');
  const [newTitle, setNewTitle] = useState('');
  const [newSubject, setNewSubject] = useState('সমন্বিত (বিসিএস ও ব্যাংক)');
  const [newMode, setNewMode] = useState<ExamMode>('Mixed');
  const [durationMinutes, setDurationMinutes] = useState(20);
  const [marksPerQuestion, setMarksPerQuestion] = useState(1);
  const [negativeMark, setNegativeMark] = useState(0.25);

  // AI Book + Demo Photo/PDF Exam Generator state (null = all imported books selected by default)
  const [userSelectedBookIds, setUserSelectedBookIds] = useState<number[] | null>(null);
  const [aiMcqCount, setAiMcqCount] = useState(10);
  const [aiWrittenCount, setAiWrittenCount] = useState(3);
  const [examSetCount, setExamSetCount] = useState(1);
  const [aiDifficulty, setAiDifficulty] = useState<DifficultyLevel>('Medium');
  const [examOrgName, setExamOrgName] = useState('');
  const [examPostName, setExamPostName] = useState('');
  const [examOrderingMode, setExamOrderingMode] =
    useState<QuestionOrderingMode>('subject_serial');
  const [examLanguageMode, setExamLanguageMode] =
    useState<QuestionLanguageMode>('mixed_bd_job');
  const [includeCurrentGk, setIncludeCurrentGk] = useState(true);
  const [writtenSections, setWrittenSections] = useState<
    WrittenSectionBlueprint[]
  >(() => cloneDefaultWrittenBlueprint());
  const [demoAnalysis, setDemoAnalysis] = useState<DemoPaperAnalysis | null>(null);
  const [examGenerationEngine, setExamGenerationEngine] = useState<'local' | 'ai'>('local');
  const [generatingExam, setGeneratingExam] = useState(false);
  const [genExamProgress, setGenExamProgress] = useState('');

  // Post-exam Answer & Explanation Sheet state (right inside Exam Center)
  const [viewingAttemptId, setViewingAttemptId] = useState<number | null>(null);
  const [answerSheetDefaultOpen, setAnswerSheetDefaultOpen] = useState(false);
  const [attemptAiExplanations, setAttemptAiExplanations] = useState<
    Record<number, Record<number, string>>
  >({});

  // Manual Question Bank selection state
  const [manualTopicFilter, setManualTopicFilter] = useState<string>('সব');
  const [selectedQIds, setSelectedQIds] = useState<number[]>(() =>
    data.questions.slice(0, 5).map((q) => q.id)
  );
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [builderIsQuotaError, setBuilderIsQuotaError] = useState(false);
  const [confirmDeleteExamId, setConfirmDeleteExamId] = useState<number | null>(
    null
  );
  const [deletingExamId, setDeletingExamId] = useState<number | null>(null);

  const activeGkCount = useMemo(
    () => data.gkItems.filter((item) => !item.isArchived).length,
    [data.gkItems]
  );

  const writtenBlueprintSummary = useMemo(
    () => summarizeWrittenBlueprint(writtenSections),
    [writtenSections]
  );

  const targetTotalPerExamSet = useMemo(() => {
    if (newMode === 'MCQ') return Math.min(100, Math.max(1, aiMcqCount || 1));
    if (newMode === 'Written')
      return Math.min(
        25,
        Math.max(1, writtenBlueprintSummary.totalQuestions || aiWrittenCount || 1)
      );
    return (
      Math.min(100, Math.max(1, aiMcqCount || 1)) +
      Math.min(20, Math.max(1, aiWrittenCount || 1))
    );
  }, [newMode, aiMcqCount, aiWrittenCount, writtenBlueprintSummary.totalQuestions]);

  const viewingAttempt = useMemo(
    () =>
      viewingAttemptId !== null
        ? data.attempts.find((a) => a.id === viewingAttemptId) ?? null
        : null,
    [data.attempts, viewingAttemptId]
  );

  const latestAttemptByExamId = useMemo(() => {
    const map = new Map<number, ExamAttempt>();
    for (const att of data.attempts) {
      if (att.examId !== null && !map.has(att.examId)) {
        map.set(att.examId, att);
      }
    }
    return map;
  }, [data.attempts]);

  // Derive selected books without synchronous setState in useEffect
  const selectedBookIds = useMemo(() => {
    const validIds = new Set(data.books.map((b) => b.id));
    if (userSelectedBookIds === null) {
      return data.books.map((b) => b.id);
    }
    return userSelectedBookIds.filter((id) => validIds.has(id));
  }, [userSelectedBookIds, data.books]);

  const manualBankWithTopic = useMemo(
    () =>
      data.questions.map((q) => ({
        question: q,
        topicLabel: classifyQuestionSyllabusTopic(q.stem, {
          chapter: q.chapter,
          subject: q.subject,
        }).label,
      })),
    [data.questions]
  );

  const manualTopicOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of manualBankWithTopic) {
      set.add(item.topicLabel);
    }
    return Array.from(set).sort();
  }, [manualBankWithTopic]);

  const filteredManualQuestions = useMemo(
    () =>
      manualBankWithTopic.filter(
        (item) =>
          manualTopicFilter === 'সব' || item.topicLabel === manualTopicFilter
      ),
    [manualBankWithTopic, manualTopicFilter]
  );

  // Live Exam Runner state
  const activeExam = useMemo(
    () => data.exams.find((e) => e.id === activeExamId) ?? null,
    [data.exams, activeExamId]
  );

  const activeExamQuestions = useMemo(() => {
    if (!activeExam) return [];
    const qMap = new Map(data.questions.map((q) => [q.id, q]));
    return activeExam.questionIds
      .map((id) => qMap.get(id))
      .filter((q): q is NonNullable<typeof q> => Boolean(q));
  }, [activeExam, data.questions]);

  const [answers, setAnswers] = useState<Record<string, ExamAnswerDraft>>(
    () => activeExam?.draftAnswers ?? {}
  );
  const [secondsLeft, setSecondsLeft] = useState(
    () => (activeExam?.durationMinutes ?? 15) * 60
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeSubjectFilter, setActiveSubjectFilter] = useState<
    'সব' | SyllabusSubjectGroup
  >('সব');
  const [reviewMarkedIds, setReviewMarkedIds] = useState<number[]>([]);
  const [handwrittenPhotos, setHandwrittenPhotos] = useState<
    Record<number, HandwrittenPhotoItem[]>
  >({});

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      for (const list of Object.values(handwrittenPhotos)) {
        for (const p of list) {
          if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        }
      }
    };
  }, [handwrittenPhotos]);

  const beginExamSession = (exam: NonNullable<typeof activeExam>) => {
    for (const list of Object.values(handwrittenPhotos)) {
      for (const p of list) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
    }
    setAnswers(exam.draftAnswers ?? {});
    setSecondsLeft(exam.durationMinutes * 60);
    setElapsedSeconds(0);
    setSavedNotice(null);
    setSubmitError(null);
    setActiveSubjectFilter('সব');
    setReviewMarkedIds([]);
    setHandwrittenPhotos({});
    setActiveExamId(exam.id);
  };

  const toggleReviewMark = (questionId: number) => {
    setReviewMarkedIds((prev) =>
      prev.includes(questionId)
        ? prev.filter((id) => id !== questionId)
        : [...prev, questionId]
    );
  };

  const handleAttachHandwrittenPhotos = async (
    questionId: number,
    files: FileList | null
  ) => {
    if (!files || files.length === 0) return;
    const existing = handwrittenPhotos[questionId] ?? [];
    const remainingSlots = Math.max(0, 2 - existing.length);
    if (remainingSlots === 0) {
      throw new Error('প্রতি প্রশ্নে সর্বোচ্চ ২টি হাতে লেখা খাতার ছবি যুক্ত করা যাবে।');
    }

    const picked = Array.from(files).slice(0, remainingSlots);
    const prepared: HandwrittenPhotoItem[] = [];
    for (const file of picked) {
      const img = await prepareImageForPaperCuttingApi(file);
      prepared.push({
        fileName: img.fileName,
        mimeType: img.mimeType,
        base64: img.imageBase64,
        previewUrl: img.previewUrl,
      });
    }

    setHandwrittenPhotos((prev) => ({
      ...prev,
      [questionId]: [...(prev[questionId] ?? []), ...prepared].slice(0, 2),
    }));
  };

  const handleRemoveHandwrittenPhoto = (questionId: number, photoIdx: number) => {
    setHandwrittenPhotos((prev) => {
      const list = prev[questionId] ?? [];
      const removed = list[photoIdx];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return {
        ...prev,
        [questionId]: list.filter((_, idx) => idx !== photoIdx),
      };
    });
  };

  const activeExamQuestionGroups = useMemo(() => {
    const map = new Map<number, SyllabusSubjectGroup>();
    const counts = new Map<SyllabusSubjectGroup, number>();
    for (const q of activeExamQuestions) {
      const grp = detectQuestionSubjectGroup(q);
      map.set(q.id, grp);
      counts.set(grp, (counts.get(grp) ?? 0) + 1);
    }
    const orderedGroups = SUBJECT_SERIAL_ORDER.filter((g) => counts.has(g)).map(
      (group) => ({
        group,
        count: counts.get(group) ?? 0,
      })
    );
    return { map, orderedGroups };
  }, [activeExamQuestions]);

  const jumpToQuestionCard = (questionId: number) => {
    if (activeSubjectFilter !== 'সব') {
      const grp = activeExamQuestionGroups.map.get(questionId);
      if (grp && grp !== activeSubjectFilter) {
        setActiveSubjectFilter('সব');
      }
    }
    window.setTimeout(() => {
      const el = document.getElementById(`exam-question-card-${questionId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 30);
  };

  // Countdown timer
  useEffect(() => {
    if (!activeExam || submitting) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeExam, submitting]);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  const handleToggleQuestion = (qId: number) => {
    setSelectedQIds((prev) =>
      prev.includes(qId) ? prev.filter((id) => id !== qId) : [...prev, qId]
    );
  };

  const handleToggleBook = (bookId: number) => {
    setUserSelectedBookIds((prev) => {
      const current = prev ?? data.books.map((b) => b.id);
      return current.includes(bookId)
        ? current.filter((id) => id !== bookId)
        : [...current, bookId];
    });
  };

  const handleApplyDetectedExamFormat = (analysis: DemoPaperAnalysis) => {
    setNewMode(analysis.recommendedFormat);
    if (analysis.organizationDetected) {
      setExamOrgName(analysis.organizationDetected);
    }
    if (analysis.postNameDetected) {
      setExamPostName(analysis.postNameDetected);
    }
    if (analysis.durationMinutesDetected) {
      setDurationMinutes(analysis.durationMinutesDetected);
    }
    if (analysis.mcqCountDetected > 0) {
      setAiMcqCount(Math.min(100, Math.max(1, analysis.mcqCountDetected)));
    }
    if (analysis.writtenSections && analysis.writtenSections.length > 0) {
      setWrittenSections(analysis.writtenSections);
      setAiWrittenCount(
        Math.min(
          25,
          Math.max(
            1,
            summarizeWrittenBlueprint(analysis.writtenSections).totalQuestions
          )
        )
      );
    } else if (analysis.writtenCountDetected > 0) {
      setAiWrittenCount(Math.min(20, Math.max(1, analysis.writtenCountDetected)));
    }
    if (!newTitle.trim() && analysis.examTitleDetected) {
      setNewTitle(analysis.examTitleDetected);
    }
  };

  const handleAutoPick = (mode: ExamMode) => {
    setNewMode(mode);
    const pool = data.questions.filter((q) => {
      if (mode === 'MCQ') return q.questionType === 'MCQ';
      if (mode === 'Written') return q.questionType !== 'MCQ';
      return true;
    });
    setSelectedQIds(pool.slice(0, 6).map((q) => q.id));
  };

  const createExamLocallyFromBooks = async (resolvedTitle: string) => {
    setBuilderError(null);
    setBuilderIsQuotaError(false);

    if (selectedBookIds.length === 0 && !(includeCurrentGk && activeGkCount > 0)) {
      setBuilderError(
        'প্রশ্ন তৈরির জন্য অন্তত ১টি বই (অথবা Current GK) নির্বাচন করুন।'
      );
      return;
    }

    const chosenBooks = data.books.filter((b) => selectedBookIds.includes(b.id));
    const safeSetCount = Math.min(5, Math.max(1, Math.round(examSetCount || 1)));
    const targetMcq =
      newMode === 'MCQ' || newMode === 'Mixed'
        ? Math.min(100, Math.max(1, Number(aiMcqCount || 10)))
        : 0;
    const targetWritten =
      newMode === 'Written'
        ? Math.min(
            25,
            Math.max(
              1,
              writtenBlueprintSummary.totalQuestions || Number(aiWrittenCount || 3)
            )
          )
        : newMode === 'Mixed'
          ? Math.min(20, Math.max(1, Number(aiWrittenCount || 3)))
          : 0;

    setGeneratingExam(true);
    setGenExamProgress('০ API কোটায় সরাসরি বই থেকে প্রশ্নপত্র সংকলন হচ্ছে...');
    try {
      const compiled = compileExamSetsLocallyFromBooks({
        books: chosenBooks,
        gkItems: data.gkItems,
        includeCurrentGk,
        questionMode: newMode,
        mcqCount: targetMcq,
        writtenCount: targetWritten,
        setCount: safeSetCount,
        difficulty: aiDifficulty,
        subject: newSubject.trim() || 'সমন্বিত (চাকরির পরীক্ষা)',
        jobExamPreset: resolvedTitle,
        topicDistribution: demoAnalysis?.topicDistribution,
        existingStems: data.questions.map((q) => q.stem),
        orderingMode: examOrderingMode,
      });

      if (compiled.sets.length === 0) {
        setBuilderError(
          `নির্বাচিত বইগুলোতে সরাসরি সংকলনযোগ্য প্রশ্ন পাওয়া যায়নি (পাওয়া গেছে: MCQ ${toBengaliNumber(compiled.totalPoolMcq)}টি, লিখিত ${toBengaliNumber(compiled.totalPoolWritten)}টি)। ভিন্ন বই বা "AI স্মার্ট প্রশ্ন তৈরি" মোড নির্বাচন করুন।`
        );
        return;
      }

      let firstCreatedExam = null;
      for (const compiledSet of compiled.sets) {
        const savedQuestions = await addQuestions(compiledSet.questions);
        const setTitle =
          safeSetCount > 1
            ? `${resolvedTitle} — সেট-${toBengaliNumber(compiledSet.setNumber)}`
            : resolvedTitle;
        const created = await createExam({
          title: setTitle,
          subject: newSubject.trim() || 'সমন্বিত',
          examMode: newMode,
          durationMinutes: Math.max(2, durationMinutes),
          marksPerQuestion: Math.max(0.5, marksPerQuestion),
          negativeMark:
            newMode === 'Written' ? 0 : Math.max(0, negativeMark),
          questionIds: savedQuestions.map((q) => q.id),
        });
        if (!firstCreatedExam) {
          firstCreatedExam = created;
        }
      }

      if (firstCreatedExam) {
        if (compiled.unfulfilledCount > 0) {
          setSavedNotice(
            `নির্বাচিত বইগুলো থেকে মোট ${toBengaliNumber(firstCreatedExam.questionIds.length)}টি অনন্য প্রশ্ন পাওয়া গেছে (বইয়ের মোট সংকলনযোগ্য MCQ পুল: ${toBengaliNumber(compiled.totalPoolMcq)}টি)। আরও বেশি প্রশ্ন পেতে অতিরিক্ত বই যোগ করুন অথবা AI মোড ব্যবহার করুন।`
          );
        } else {
          setSavedNotice(null);
        }
        setShowBuilder(false);
        setNewTitle('');
        setDemoAnalysis(null);
        setViewingAttemptId(null);
        setActiveExamId(firstCreatedExam.id);
      }
    } catch (err) {
      setBuilderError(
        err instanceof Error
          ? err.message
          : 'সরাসরি বই থেকে পরীক্ষা তৈরি করতে সমস্যা হয়েছে।'
      );
    } finally {
      setGeneratingExam(false);
      setGenExamProgress('');
    }
  };

  const handleCreateExam = async (e: React.FormEvent) => {
    e.preventDefault();
    setBuilderError(null);
    setBuilderIsQuotaError(false);
    setGenExamProgress('');

    const resolvedTitle =
      newTitle.trim() ||
      (builderSourceMode === 'ai-books'
        ? [examOrgName.trim(), examPostName.trim()].filter(Boolean).join(' — ') ||
          demoAnalysis?.examTitleDetected ||
          `কাস্টম চাকরির মডেল টেস্ট (${new Date().toISOString().slice(0, 10)})`
        : '');

    if (!resolvedTitle) {
      setBuilderError('অনুগ্রহ করে পরীক্ষার শিরোনাম দিন।');
      return;
    }

    // MODE 1: Generate fresh exam questions (1–5 sets) from selected books + Demo Photo/PDF % Blueprint
    if (builderSourceMode === 'ai-books') {
      if (examGenerationEngine === 'local') {
        await createExamLocallyFromBooks(resolvedTitle);
        return;
      }

      if (selectedBookIds.length === 0 && !(includeCurrentGk && activeGkCount > 0)) {
        setBuilderError(
          'প্রশ্ন তৈরির জন্য অন্তত ১টি বই (অথবা Current GK) নির্বাচন করুন (অথবা ম্যানুয়াল প্রশ্নব্যাংক ট্যাব ব্যবহার করুন)।'
        );
        return;
      }

      const authHeaders = await getAiAuthHeaders();
      if (!authHeaders) {
        requestAiSignIn('নির্বাচিত বই ও ডেমো প্রশ্ন থেকে AI পরীক্ষা তৈরি');
        return;
      }

      const demoTopicLabels = demoAnalysis
        ? demoAnalysis.topicDistribution.map((t) => t.topicLabel)
        : [];

      const gkChunks =
        includeCurrentGk && activeGkCount > 0
          ? buildCurrentGkChunks(data.gkItems, 2)
          : [];

      const initialChunks = selectRotatedChunksForBatch({
        books: data.books,
        selectedBookIds,
        selectedTopics: demoTopicLabels,
        topicHint: newSubject,
        batchIndex: 0,
        batchChunkLimit: 10,
        gkChunks,
      });

      if (initialChunks.length === 0) {
        setBuilderError('নির্বাচিত বইগুলোতে পাঠযোগ্য কোনো অধ্যায় পাওয়া যায়নি।');
        return;
      }

      const safeSetCount = Math.min(5, Math.max(1, Math.round(examSetCount || 1)));
      const targetMcq =
        newMode === 'MCQ' || newMode === 'Mixed'
          ? Math.min(100, Math.max(1, Number(aiMcqCount || 10)))
          : 0;
      const targetWritten =
        newMode === 'Written'
          ? Math.min(
              25,
              Math.max(
                1,
                writtenBlueprintSummary.totalQuestions || Number(aiWrittenCount || 3)
              )
            )
          : newMode === 'Mixed'
            ? Math.min(20, Math.max(1, Number(aiWrittenCount || 3)))
            : 0;

      setGeneratingExam(true);
      try {
        const cumulativeStems = [...data.questions.map((q) => q.stem)];
        let firstCreatedExam = null;

        const runAiBatch = async (
          setNum: number,
          batchCursor: number,
          batch: { mcqCount: number; writtenCount: number },
          currentCount: number,
          totalInSet: number,
          isTopUp = false
        ): Promise<Array<Omit<Question, 'id' | 'createdAt'>>> => {
          const batchTotal = batch.mcqCount + batch.writtenCount;
          setGenExamProgress(
            safeSetCount > 1
              ? `সেট ${toBengaliNumber(setNum)}/${toBengaliNumber(safeSetCount)} ${isTopUp ? 'ঘাটতি পূরণ হচ্ছে' : 'তৈরি হচ্ছে'} (${toBengaliNumber(currentCount)}/${toBengaliNumber(totalInSet)})...`
              : `${isTopUp ? 'অবশিষ্ট প্রশ্ন পূর্ণ করা হচ্ছে' : 'প্রশ্ন তৈরি হচ্ছে'} (${toBengaliNumber(currentCount)}/${toBengaliNumber(totalInSet)})...`
          );

          const batchChunks = selectRotatedChunksForBatch({
            books: data.books,
            selectedBookIds,
            selectedTopics: demoTopicLabels,
            topicHint: newSubject,
            batchIndex: batchCursor,
            batchChunkLimit: 10,
            gkChunks,
          });

          const batchType =
            batch.mcqCount > 0 && batch.writtenCount > 0
              ? 'Mixed'
              : batch.mcqCount > 0
                ? 'MCQ'
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
              subject: newSubject.trim() || 'সমন্বিত (চাকরির পরীক্ষা)',
              questionType: batchType,
              difficulty: aiDifficulty,
              mcqCount: batch.mcqCount,
              writtenCount: batch.writtenCount,
              count: batchTotal,
              selectedTopics: demoTopicLabels,
              topicAllocations: batchAllocations.map((a) => ({
                topicLabel: a.topicLabel,
                percentage: a.percentage,
                targetCount: a.targetCount,
              })),
              jobExamPreset: resolvedTitle,
              setNumber: setNum,
              totalSets: safeSetCount,
              organizationName: examOrgName.trim(),
              postName: examPostName.trim(),
              languageMode: examLanguageMode,
              writtenSections: batch.writtenCount > 0 ? writtenSections : [],
            }),
          });

          const json = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (res.status === 401) {
              requestAiSignIn('নির্বাচিত বই ও ডেমো প্রশ্ন থেকে AI পরীক্ষা তৈরি');
            }
            if (isRateLimitErrorPayload(res.status, json)) {
              setBuilderIsQuotaError(true);
            }
            throw new Error(
              formatAiResponseError(
                res.status,
                json,
                'বই থেকে পরীক্ষার প্রশ্ন তৈরি করা যায়নি।'
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

          const generatedForSet: Array<Omit<Question, 'id' | 'createdAt'>> = [];
          const totalInSet = targetMcq + targetWritten;
          let batchCursor = (setNum - 1) * 5;

          for (const batch of batches) {
            const batchQuestions = await runAiBatch(
              setNum,
              batchCursor,
              batch,
              generatedForSet.length,
              totalInSet,
              false
            );
            batchCursor += 1;
            for (const q of batchQuestions) {
              generatedForSet.push(q);
              cumulativeStems.push(q.stem);
            }
          }

          // Bounded deficit top-up loop so 70 requested MCQs actually reaches 70/70
          for (let extraPass = 0; extraPass < 3; extraPass += 1) {
            const currentMcq = generatedForSet.filter(
              (q) => q.questionType === 'MCQ'
            ).length;
            const currentWritten = generatedForSet.length - currentMcq;
            const deficit = computeNextDeficitBatch({
              targetMcq,
              targetWritten,
              currentMcq,
              currentWritten,
              maxQuestionsPerBatch: 18,
            });
            if (!deficit) break;

            const topUpQuestions = await runAiBatch(
              setNum,
              batchCursor,
              deficit,
              generatedForSet.length,
              totalInSet,
              true
            );
            batchCursor += 1;
            if (topUpQuestions.length === 0) break;

            for (const q of topUpQuestions) {
              generatedForSet.push(q);
              cumulativeStems.push(q.stem);
            }
          }

          const finalSetQuestions = trimGeneratedSetToTargets(
            generatedForSet,
            targetMcq,
            targetWritten
          );

          if (finalSetQuestions.length > 0) {
            const orderedSet = orderQuestionsForExam(
              finalSetQuestions,
              examOrderingMode,
              setNum * 23
            );
            const savedQuestions = await addQuestions(orderedSet);
            const setTitle =
              safeSetCount > 1
                ? `${resolvedTitle} — সেট-${toBengaliNumber(setNum)}`
                : resolvedTitle;
            const created = await createExam({
              title: setTitle,
              subject: newSubject.trim() || 'সমন্বিত',
              examMode: newMode,
              durationMinutes: Math.max(2, durationMinutes),
              marksPerQuestion: Math.max(0.5, marksPerQuestion),
              negativeMark:
                newMode === 'Written' ? 0 : Math.max(0, negativeMark),
              questionIds: savedQuestions.map((q) => q.id),
            });
            if (!firstCreatedExam) {
              firstCreatedExam = created;
            }
          }
        }

        if (!firstCreatedExam) {
          setBuilderError(
            'নির্বাচিত বই থেকে নতুন প্রশ্ন তৈরি করা যায়নি। অনুগ্রহ করে আরও বই যুক্ত করে চেষ্টা করুন।'
          );
          return;
        }

        setNewTitle('');
        setShowBuilder(false);
        setViewingAttemptId(null);
        beginExamSession(firstCreatedExam);
      } catch (err) {
        setBuilderError(
          err instanceof Error
            ? err.message
            : 'AI দিয়ে পরীক্ষা তৈরি করতে সমস্যা হয়েছে।'
        );
      } finally {
        setGeneratingExam(false);
        setGenExamProgress('');
      }
      return;
    }

    // MODE 2: Manual Question Bank selection
    if (selectedQIds.length === 0) {
      setBuilderError('অন্তত ১টি প্রশ্ন নির্বাচন করুন।');
      return;
    }

    const created = await createExam({
      title: resolvedTitle,
      subject: newSubject.trim() || 'সমন্বিত',
      examMode: newMode,
      durationMinutes: Math.max(2, durationMinutes),
      marksPerQuestion: Math.max(0.5, marksPerQuestion),
      negativeMark: Math.max(0, negativeMark),
      questionIds: selectedQIds,
    });

    setNewTitle('');
    setShowBuilder(false);
    beginExamSession(created);
  };

  const handleSaveMidExam = async () => {
    if (!activeExam) return;
    await saveExamDraft(activeExam.id, answers);
    setSavedNotice(
      'পরীক্ষার উত্তর সংরক্ষিত হয়েছে — পরে আবার এখান থেকেই শুরু করতে পারবেন।'
    );
    setTimeout(() => setSavedNotice(null), 3000);
  };

  const handleSubmitExam = async () => {
    if (!activeExam) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      // 1. Collect answered written/short questions (typed OR handwritten photo) for Gemini AI Evaluation
      const writtenInputs = activeExamQuestions
        .filter((q) => q.questionType !== 'MCQ')
        .map((q) => {
          const text = (answers[String(q.id)]?.writtenText ?? '').trim();
          const photos = handwrittenPhotos[q.id] ?? [];
          const defaultMax =
            q.questionType === 'Short'
              ? Math.max(2, activeExam.marksPerQuestion * 2)
              : Math.max(5, activeExam.marksPerQuestion * 5);
          const maxMarks = parseWrittenQuestionStructure(
            q.stem,
            defaultMax
          ).marks;
          return {
            questionId: q.id,
            stem: q.stem,
            modelAnswer: q.modelAnswer,
            userAnswer: text,
            maxMarks,
            bookTitle: q.bookTitle,
            pageNumber: q.pageNumber,
            handwrittenImages: photos.map((p) => ({
              mimeType: p.mimeType,
              base64: p.base64,
            })),
          };
        })
        .filter(
          (item) =>
            item.userAnswer.length > 0 || item.handwrittenImages.length > 0
        );

      // Preliminary MCQ score for AI context
      const preliminary = scoreExamAttempt(
        activeExam,
        activeExamQuestions,
        answers
      );

      let writtenOverrides: WrittenGradeOverride[] = [];
      let aiRecommendation = '';
      let guestAiNotice = '';

      const hasAnyHandwrittenPhoto = writtenInputs.some(
        (w) => w.handwrittenImages.length > 0
      );

      const authHeaders = await getAiAuthHeaders();
      if (authHeaders) {
        try {
          const controller = new AbortController();
          const timeoutId = window.setTimeout(
            () => controller.abort(),
            hasAnyHandwrittenPhoto ? 48000 : 18000
          );
          const res = await fetch('/api/ai/evaluate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders,
            },
            signal: controller.signal,
            body: JSON.stringify({
              writtenItems: writtenInputs,
              examTitle: activeExam.title,
              weakTopics: preliminary.weakTopics,
              mcqAccuracy: preliminary.mcqAccuracy,
            }),
          });
          window.clearTimeout(timeoutId);
          const json = await res.json().catch(() => ({}));
          if (res.ok) {
            if (Array.isArray(json.writtenGrades)) {
              writtenOverrides = json.writtenGrades;
            }
            if (typeof json.aiRecommendation === 'string') {
              aiRecommendation = json.aiRecommendation;
            }
          } else if (res.status === 401) {
            requestAiSignIn('AI লিখিত মূল্যায়ন ও ব্যক্তিগত পরামর্শ');
          } else if (res.status === 429) {
            guestAiNotice = formatAiResponseError(
              res.status,
              json,
              'AI মূল্যায়নের অনুরোধ সীমা পূর্ণ হয়েছে; স্থানীয় মূল্যায়ন সংরক্ষণ করা হয়েছে।'
            );
          }
        } catch {
          // Fallback deterministic evaluation still proceeds cleanly
        }
      } else {
        if (writtenInputs.length > 0) {
          requestAiSignIn('AI লিখিত মূল্যায়ন ও ব্যক্তিগত পরামর্শ');
          guestAiNotice =
            'Guest Mode-এ স্থানীয় মূল্যায়ন সংরক্ষণ করা হয়েছে। AI লিখিত মূল্যায়ন ও ব্যক্তিগত পরামর্শের জন্য Google অ্যাকাউন্ট দিয়ে সাইন ইন করুন।';
        }
      }

      const finalScore = scoreExamAttempt(
        activeExam,
        activeExamQuestions,
        answers,
        writtenOverrides
      );

      const fallbackRec =
        guestAiNotice ||
        (finalScore.weakTopics.length > 0
          ? `${finalScore.weakTopics.slice(0, 2).join(', ')} অধ্যায়গুলো পুনরায় রিভিশন দিন এবং ভুল নোটবুকের প্রশ্নগুলো অনুশীলন করুন।`
          : 'অসাধারণ ফলাফল! কঠিন স্তরের মডেল টেস্ট দিয়ে আপনার গতি ও নির্ভুলতা আরও বাড়ান।');

      const todayIso = new Date().toISOString().slice(0, 10);
      const extractedMistakes = extractMistakesFromAttempt(
        { id: 0, evaluations: finalScore.evaluations },
        1,
        todayIso
      ).map((m) => ({
        questionId: m.questionId,
        questionStem: m.questionStem,
        subject: m.subject,
        chapter: m.chapter,
        userAnswer: m.userAnswer,
        correctAnswer: m.correctAnswer,
        reason: m.reason,
        mastered: false,
        reviewCount: 0,
        nextReviewDate: m.nextReviewDate,
      }));

      const savedAttempt = await saveExamAttempt(
        {
          examId: activeExam.id,
          examTitle: activeExam.title,
          subject: activeExam.subject,
          totalMarks: finalScore.totalMarks,
          obtainedMarks: finalScore.obtainedMarks,
          negativeDeduction: finalScore.negativeDeduction,
          correctCount: finalScore.correctCount,
          wrongCount: finalScore.wrongCount,
          skippedCount: finalScore.skippedCount,
          mcqAccuracy: finalScore.mcqAccuracy,
          writtenScore: finalScore.writtenScore,
          durationSeconds: Math.max(10, elapsedSeconds),
          evaluations: finalScore.evaluations,
          weakTopics: finalScore.weakTopics,
          aiRecommendation: aiRecommendation || fallbackRec,
        },
        extractedMistakes
      );

      // Auto-generate AI explanations for any question whose source book lacked an explanation
      if (authHeaders) {
        const missingExpQuestions = activeExamQuestions.filter(
          (q) => !parseExplanationSource(q.explanation).hasExplanation
        );
        if (missingExpQuestions.length > 0) {
          try {
            const explainPayload = missingExpQuestions.slice(0, 25).map((q) => {
              const matchedBook = data.books.find(
                (b) => b.id === q.bookId || b.title === q.bookTitle
              );
              const matchedChunk = matchedBook?.chunks.find(
                (c) => c.pageNumber === q.pageNumber
              );
              return {
                questionId: q.id,
                stem: q.stem,
                correctAnswer:
                  q.questionType === 'MCQ' && q.correctOptionIndex !== null
                    ? q.options[q.correctOptionIndex] ?? q.modelAnswer
                    : q.modelAnswer,
                options: q.options,
                bookTitle: q.bookTitle,
                bookExcerpt: matchedChunk?.content.slice(0, 1000) ?? '',
              };
            });
            const expRes = await fetch('/api/ai/explain-answers', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...authHeaders,
              },
              body: JSON.stringify({ items: explainPayload }),
            });
            if (expRes.ok) {
              const expJson = await expRes.json().catch(() => ({}));
              if (Array.isArray(expJson.explanations)) {
                const mapForAttempt: Record<number, string> = {};
                for (const row of expJson.explanations) {
                  if (row?.questionId && row?.explanation) {
                    mapForAttempt[Number(row.questionId)] = String(
                      row.explanation
                    );
                  }
                }
                setAttemptAiExplanations((prev) => ({
                  ...prev,
                  [savedAttempt.id]: mapForAttempt,
                }));
              }
            }
          } catch {
            // User can still trigger AI explanation generation on-demand inside Answer Sheet
          }
        }
      }

      setActiveExamId(null);
      setAnswerSheetDefaultOpen(false);
      setViewingAttemptId(savedAttempt.id);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'পরীক্ষা জমা দিতে সমস্যা হয়েছে।'
      );
    } finally {
      setSubmitting(false);
    }
  };

  // POST-EXAM ANSWER & EXPLANATION SHEET VIEW (RIGHT INSIDE EXAM CENTER)
  if (!activeExam && viewingAttempt) {
    return (
      <div className="space-y-5">
        <div className="border-b border-slate-200 pb-4">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            04. Exam Center — পরীক্ষার উত্তরপত্র ও ব্যাখ্যা
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            পরীক্ষা শেষে প্রতিটি প্রশ্নের সঠিক উত্তর এবং মূল বইয়ের ব্যাখ্যা (বইয়ে না থাকলে AI দিয়ে লেখা ব্যাখ্যা) এখান থেকে যাচাই করুন।
          </p>
        </div>

        <ExamAnswerSheetView
          attempt={viewingAttempt}
          questions={data.questions}
          books={data.books}
          initialAiExplanations={attemptAiExplanations[viewingAttempt.id]}
          defaultShowAnswers={answerSheetDefaultOpen}
          onBack={() => setViewingAttemptId(null)}
          backLabel="Exam Center-এ ফিরে যান"
        />
      </div>
    );
  }

  // LIVE EXAM RUNNER VIEW
  if (activeExam) {
    const isQuestionAnswered = (q: Question) => {
      const d = answers[String(q.id)];
      if (q.questionType === 'MCQ') {
        return d?.selectedOption !== undefined;
      }
      return Boolean(
        d?.writtenText?.trim() || (handwrittenPhotos[q.id]?.length ?? 0) > 0
      );
    };

    const answeredCount = activeExamQuestions.filter(isQuestionAnswered).length;
    const displayedQuestions =
      activeSubjectFilter === 'সব'
        ? activeExamQuestions
        : activeExamQuestions.filter(
            (q) => activeExamQuestionGroups.map.get(q.id) === activeSubjectFilter
          );

    return (
      <div className="space-y-5">
        {/* Sticky Exam Bar */}
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-slate-900">
              {activeExam.title}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
              <span>{activeExam.examMode}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                উত্তর দেওয়া হয়েছে: {toBengaliNumber(answeredCount)}/
                {toBengaliNumber(activeExamQuestions.length)}
              </span>
              {reviewMarkedIds.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-amber-700">
                    রিভিউ মার্ক: {toBengaliNumber(reviewMarkedIds.length)}টি
                  </span>
                </>
              )}
              {activeExam.examMode !== 'Written' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-red-700">
                    নেগেটিভ মার্কিং: -{activeExam.negativeMark}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div
              aria-label="অবশিষ্ট সময়"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm font-semibold tabular-nums text-slate-900"
            >
              <Clock className="h-4 w-4 text-blue-700" />
              <span>{formatTime(secondsLeft)}</span>
            </div>
            <button
              type="button"
              onClick={() => void handleSaveMidExam()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Save className="h-3.5 w-3.5" />
              <span>সংরক্ষণ</span>
            </button>
            <button
              type="button"
              data-testid="live-exam-submit-top-btn"
              onClick={() => void handleSubmitExam()}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>মূল্যায়ন হচ্ছে...</span>
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  <span>পরীক্ষা জমা দিন</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Subject Quick-Jump Tabs + OMR Question Palette Grid */}
        <div
          data-testid="live-exam-omr-panel"
          className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"
        >
          {/* Subject Quick-Jump Tabs */}
          {activeExamQuestionGroups.orderedGroups.length > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <span className="text-xs font-semibold text-slate-700">
                বিষয় অনুযায়ী দ্রুত যান:
              </span>
              <div
                role="tablist"
                aria-label="বিষয়ভিত্তিক দ্রুত নেভিগেশন"
                className="flex flex-wrap gap-1.5"
              >
                <button
                  type="button"
                  role="tab"
                  data-testid="subject-jump-all"
                  aria-selected={activeSubjectFilter === 'সব'}
                  onClick={() => setActiveSubjectFilter('সব')}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                    activeSubjectFilter === 'সব'
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  সব ({toBengaliNumber(activeExamQuestions.length)})
                </button>
                {activeExamQuestionGroups.orderedGroups.map(({ group, count }) => (
                  <button
                    key={group}
                    type="button"
                    role="tab"
                    data-testid={`subject-jump-${group}`}
                    aria-selected={activeSubjectFilter === group}
                    onClick={() => setActiveSubjectFilter(group)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                      activeSubjectFilter === group
                        ? 'bg-blue-700 text-white'
                        : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {group} ({toBengaliNumber(count)})
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* OMR Question Palette Grid */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
              <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                <LayoutGrid className="h-3.5 w-3.5 text-blue-700" />
                <span>OMR প্রশ্ন প্যালেট (যেকোনো নম্বরে ক্লিক করে যান)</span>
              </span>
              <div className="flex flex-wrap items-center gap-3 text-[11px]">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-xs bg-emerald-600" />
                  উত্তর দেওয়া ({toBengaliNumber(answeredCount)})
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-xs bg-amber-500" />
                  রিভিউ ({toBengaliNumber(reviewMarkedIds.length)})
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-xs border border-slate-300 bg-white" />
                  বাকি ({toBengaliNumber(activeExamQuestions.length - answeredCount)})
                </span>
              </div>
            </div>

            <div
              data-testid="omr-question-palette"
              className="flex flex-wrap gap-1.5"
            >
              {activeExamQuestions.map((q, idx) => {
                const answered = isQuestionAnswered(q);
                const review = reviewMarkedIds.includes(q.id);
                let tileStyle =
                  'border-slate-300 bg-white text-slate-700 hover:border-blue-500';
                if (review) {
                  tileStyle = 'border-amber-500 bg-amber-500 text-white';
                } else if (answered) {
                  tileStyle = 'border-emerald-600 bg-emerald-600 text-white';
                }
                return (
                  <button
                    key={q.id}
                    type="button"
                    data-testid={`omr-tile-${idx + 1}`}
                    onClick={() => jumpToQuestionCard(q.id)}
                    title={`প্রশ্ন ${toBengaliNumber(idx + 1)} (${answered ? 'উত্তর দেওয়া হয়েছে' : 'অনুত্তরিত'}${review ? ', রিভিউ মার্ক' : ''})`}
                    className={`h-8 w-8 rounded-md border font-mono text-xs font-bold tabular-nums transition-colors ${tileStyle}`}
                  >
                    {toBengaliNumber(idx + 1)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {submitting && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-medium text-blue-900"
          >
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>
              MCQ উত্তর মূল্যায়ন সম্পন্ন হয়েছে; লিখিত উত্তর ও হাতে লেখা খাতা (যুক্ত থাকলে) AI দ্বারা বিশ্লেষণ করা হচ্ছে...
            </span>
          </div>
        )}

        {savedNotice && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{savedNotice}</span>
          </div>
        )}

        {submitError && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-800"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        {/* Questions Sheet */}
        <div className="space-y-4">
          {displayedQuestions.map((q) => {
            const globalIdx = activeExamQuestions.findIndex(
              (item) => item.id === q.id
            );
            const draft = answers[String(q.id)] ?? {};
            const isMarked = reviewMarkedIds.includes(q.id);
            const defaultWrittenMax =
              q.questionType === 'Short'
                ? Math.max(2, activeExam.marksPerQuestion * 2)
                : Math.max(5, activeExam.marksPerQuestion * 5);

            if (q.questionType !== 'MCQ') {
              return (
                <LiveWrittenQuestionCard
                  key={q.id}
                  question={q}
                  index={globalIdx}
                  defaultMaxMarks={defaultWrittenMax}
                  writtenText={draft.writtenText ?? ''}
                  onWrittenTextChange={(nextText) =>
                    setAnswers((prev) => ({
                      ...prev,
                      [String(q.id)]: {
                        ...prev[String(q.id)],
                        writtenText: nextText,
                      },
                    }))
                  }
                  attachedPhotos={handwrittenPhotos[q.id] ?? []}
                  onAttachPhotos={(files) =>
                    handleAttachHandwrittenPhotos(q.id, files)
                  }
                  onRemovePhoto={(pIdx) =>
                    handleRemoveHandwrittenPhoto(q.id, pIdx)
                  }
                  isMarkedForReview={isMarked}
                  onToggleReview={() => toggleReviewMark(q.id)}
                />
              );
            }

            const bnOpts = ['ক', 'খ', 'গ', 'ঘ'];
            return (
              <article
                key={q.id}
                id={`exam-question-card-${q.id}`}
                data-testid={`live-mcq-card-${globalIdx + 1}`}
                className={`rounded-xl border bg-white p-5 transition-colors ${
                  isMarked
                    ? 'border-amber-400 ring-1 ring-amber-200'
                    : 'border-slate-200'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono font-bold text-slate-900">
                      প্রশ্ন {toBengaliNumber(globalIdx + 1)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{q.questionType}</span>
                    <span aria-hidden="true">·</span>
                    <span>{q.chapter}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums font-semibold text-slate-700">
                      নম্বর: {toBengaliNumber(activeExam.marksPerQuestion)}
                    </span>
                    <button
                      type="button"
                      data-testid={`review-mark-btn-${globalIdx + 1}`}
                      onClick={() => toggleReviewMark(q.id)}
                      aria-pressed={isMarked}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                        isMarked
                          ? 'border-amber-400 bg-amber-50 text-amber-900'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <Flag className="h-3 w-3" />
                      <span>{isMarked ? 'রিভিউ মার্ক করা' : 'রিভিউ মার্ক'}</span>
                    </button>
                  </div>
                </div>
                <h2 className="mt-2 text-base font-semibold text-slate-900 leading-relaxed">
                  <KatexMathText text={q.stem} />
                </h2>

                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {q.options.map((opt, optIdx) => {
                    const selected = draft.selectedOption === optIdx;
                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() =>
                          setAnswers((prev) => ({
                            ...prev,
                            [String(q.id)]: {
                              ...prev[String(q.id)],
                              selectedOption: optIdx,
                            },
                          }))
                        }
                        aria-pressed={selected}
                        className={`flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors ${
                          selected
                            ? 'border-blue-700 bg-blue-50 font-semibold text-blue-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <span className="font-mono text-xs font-bold text-slate-500">
                          {bnOpts[optIdx] ?? String.fromCharCode(65 + optIdx)}.
                        </span>
                        <span>
                          <KatexMathText text={opt} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={() => {
              void handleSaveMidExam();
              setActiveExamId(null);
            }}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            সংরক্ষণ করে পরীক্ষা তালিকা দেখুন
          </button>
          <button
            type="button"
            onClick={() => void handleSubmitExam()}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>AI মূল্যায়ন চলছে...</span>
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                <span>পরীক্ষা জমা দিন ও ফলাফল দেখুন</span>
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // EXAM HUB VIEW
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            04. Exam Center (MCQ ও Written পরীক্ষা)
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            পছন্দের বই ও নমুনা Demo প্রশ্ন দিয়ে AI-নির্মিত কাস্টম MCQ/Written পরীক্ষা দিন অথবা প্রশ্নব্যাংক থেকে বাছাই করে সময় ও নেগেটিভ মার্কিংসহ অনুশীলন করুন।
          </p>
        </div>
        <button
          type="button"
          data-testid="toggle-exam-builder-btn"
          onClick={() => setShowBuilder((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="h-4 w-4" />
          <span>{showBuilder ? 'ফর্ম বন্ধ করুন' : 'নতুন পরীক্ষা তৈরি করুন'}</span>
        </button>
      </div>

      {/* Custom Exam Builder */}
      {showBuilder && (
        <form
          onSubmit={handleCreateExam}
          data-testid="custom-exam-builder-form"
          className="rounded-xl border border-slate-200 bg-white p-6 space-y-5"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                কাস্টম প্রশ্নপত্র ও পরীক্ষার নিয়মাবলি নির্ধারণ করুন
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                বই ও Demo প্রশ্ন দিলে AI স্বয়ংক্রিয়ভাবে নির্দিষ্ট টপিক ও সংখ্যায় MCQ এবং Written প্রশ্ন তৈরি করে পরীক্ষা শুরু করবে।
              </p>
            </div>

            <div
              role="tablist"
              aria-label="প্রশ্নপত্র তৈরির উৎস"
              className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 self-start"
            >
              <button
                type="button"
                role="tab"
                data-testid="exam-source-ai-books-tab"
                aria-selected={builderSourceMode === 'ai-books'}
                onClick={() => setBuilderSourceMode('ai-books')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  builderSourceMode === 'ai-books'
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>বই ও Demo প্রশ্ন (AI)</span>
              </button>
              <button
                type="button"
                role="tab"
                data-testid="exam-source-manual-bank-tab"
                aria-selected={builderSourceMode === 'manual-bank'}
                onClick={() => setBuilderSourceMode('manual-bank')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  builderSourceMode === 'manual-bank'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span>প্রশ্নব্যাংক ({toBengaliNumber(data.questions.length)})</span>
              </button>
            </div>
          </div>

          {/* Common Exam Settings Row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label
                htmlFor="exam-title-input"
                className="block text-xs font-semibold text-slate-700"
              >
                পরীক্ষার শিরোনাম *
              </label>
              <input
                id="exam-title-input"
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="যেমন: মন্ত্রণালয় ও বিসিএস স্পেশাল মডেল টেস্ট ০৩"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="exam-mode-select"
                className="block text-xs font-semibold text-slate-700"
              >
                পরীক্ষার ধরন
              </label>
              <select
                id="exam-mode-select"
                value={newMode}
                onChange={(e) => handleAutoPick(e.target.value as ExamMode)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              >
                <option value="Mixed">MCQ + Written (সমন্বিত)</option>
                <option value="MCQ">শুধু MCQ</option>
                <option value="Written">শুধু Written / Short</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="exam-subject-input"
                className="block text-xs font-semibold text-slate-700"
              >
                বিষয়
              </label>
              <input
                id="exam-subject-input"
                type="text"
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="exam-duration-input"
                className="block text-xs font-semibold text-slate-700"
              >
                সময় (মিনিট)
              </label>
              <input
                id="exam-duration-input"
                type="number"
                min={2}
                max={180}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="exam-marks-input"
                className="block text-xs font-semibold text-slate-700"
              >
                প্রতি MCQ নম্বর
              </label>
              <input
                id="exam-marks-input"
                type="number"
                step="0.5"
                min={0.5}
                value={marksPerQuestion}
                onChange={(e) => setMarksPerQuestion(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="exam-neg-select"
                className="block text-xs font-semibold text-slate-700"
              >
                নেগেটিভ মার্কিং (ভুল MCQ প্রতি)
              </label>
              <select
                id="exam-neg-select"
                value={negativeMark}
                onChange={(e) => setNegativeMark(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
              >
                <option value={0}>0.00 (নেই)</option>
                <option value={0.25}>-0.25 (ব্যাংক / প্রাইমারি)</option>
                <option value={0.5}>-0.50 (বিসিএস প্রিলিমিনারি)</option>
              </select>
            </div>

            {builderSourceMode === 'ai-books' && (
              <div>
                <label
                  htmlFor="exam-ai-difficulty"
                  className="block text-xs font-semibold text-slate-700"
                >
                  প্রশ্নের মান / কঠিনতা
                </label>
                <select
                  id="exam-ai-difficulty"
                  value={aiDifficulty}
                  onChange={(e) =>
                    setAiDifficulty(e.target.value as DifficultyLevel)
                  }
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                >
                  <option value="Easy">Easy (সহজ)</option>
                  <option value="Medium">Medium (চাকরির স্ট্যান্ডার্ড)</option>
                  <option value="Hard">Hard (কঠিন)</option>
                </select>
              </div>
            )}
          </div>

          {/* MODE A: AI Exam Builder from Selected Books + Demo Question Blueprint */}
          {builderSourceMode === 'ai-books' ? (
            <div className="space-y-5 border-t border-slate-200 pt-5">
              {/* 1. Multi-Book Selection + MCQ/Written Count */}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
                <div className="lg:col-span-6 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800">
                      ১. কোন কোন বই থেকে প্রশ্ন তৈরি হবে তা নির্বাচন করুন ({toBengaliNumber(selectedBookIds.length)}টি বই)
                    </span>
                    {data.books.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setUserSelectedBookIds(
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
                      লাইব্রেরিতে কোনো বই পাওয়া যায়নি। আগে 01. Book Library থেকে বই আপলোড করুন।
                    </p>
                  ) : (
                    <div
                      data-testid="exam-book-selector-list"
                      className="max-h-44 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200"
                    >
                      {data.books.map((book) => {
                        const checked = selectedBookIds.includes(book.id);
                        return (
                          <label
                            key={book.id}
                            className="flex items-start gap-2.5 p-2.5 hover:bg-slate-50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleToggleBook(book.id)}
                              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700"
                            />
                            <span className="min-w-0">
                              <span className="block text-xs font-semibold text-slate-900">
                                {book.title}
                              </span>
                              <span className="block text-[11px] text-slate-500">
                                {book.subject} · {toBengaliNumber(book.totalPages)} পৃষ্ঠা
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {/* Current GK & Paper Cutting Source Toggle */}
                  <label className="flex items-start gap-2 rounded-lg border border-blue-200/80 bg-blue-50/50 p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="exam-include-current-gk"
                      checked={includeCurrentGk}
                      onChange={(e) => setIncludeCurrentGk(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700"
                    />
                    <span className="min-w-0 text-xs">
                      <span className="flex items-center gap-1 font-semibold text-blue-950">
                        <Globe className="h-3.5 w-3.5 text-blue-700" />
                        <span>Current GK ও Paper Cutting থেকে সাম্প্রতিক প্রশ্ন যুক্ত করুন</span>
                      </span>
                      <span className="block text-[11px] text-slate-600 mt-0.5">
                        সক্রিয় সাম্প্রতিক তথ্য: {toBengaliNumber(activeGkCount)}টি
                      </span>
                    </span>
                  </label>
                </div>

                {/* 2. Separate MCQ, Written, Set Counts + Format-Adaptive Options */}
                <div className="lg:col-span-6 space-y-3">
                  <span className="block text-xs font-semibold text-slate-800">
                    ২. MCQ / Written সংখ্যা, সেট এবং প্রতিষ্ঠান ও পদের তথ্য (ঐচ্ছিক)
                  </span>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor="exam-org-input"
                        className="block text-[11px] font-semibold text-slate-700"
                      >
                        প্রতিষ্ঠান / মন্ত্রণালয় (ঐচ্ছিক)
                      </label>
                      <input
                        id="exam-org-input"
                        type="text"
                        value={examOrgName}
                        onChange={(e) => setExamOrgName(e.target.value)}
                        placeholder="যেমন: সামরিক ভূমি ও ক্যান্টনমেন্ট অধিদপ্তর"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="exam-post-input"
                        className="block text-[11px] font-semibold text-slate-700"
                      >
                        পদের নাম (ঐচ্ছিক)
                      </label>
                      <input
                        id="exam-post-input"
                        type="text"
                        value={examPostName}
                        onChange={(e) => setExamPostName(e.target.value)}
                        placeholder="যেমন: জুনিয়র শিক্ষক / অফিস সহকারী"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {(newMode === 'Mixed' || newMode === 'MCQ') && (
                      <div>
                        <label
                          htmlFor="exam-mcq-count-input"
                          className="block text-[11px] font-semibold text-slate-700"
                        >
                          MCQ সংখ্যা (১–১০০)
                        </label>
                        <input
                          id="exam-mcq-count-input"
                          data-testid="exam-mcq-count-input"
                          type="number"
                          min={1}
                          max={100}
                          value={aiMcqCount}
                          onChange={(e) => setAiMcqCount(Number(e.target.value))}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
                        />
                      </div>
                    )}

                    {newMode === 'Mixed' && (
                      <div>
                        <label
                          htmlFor="exam-written-count-input"
                          className="block text-[11px] font-semibold text-slate-700"
                        >
                          Written সংখ্যা (১–২০)
                        </label>
                        <input
                          id="exam-written-count-input"
                          data-testid="exam-written-count-input"
                          type="number"
                          min={1}
                          max={20}
                          value={aiWrittenCount}
                          onChange={(e) =>
                            setAiWrittenCount(Number(e.target.value))
                          }
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
                        />
                      </div>
                    )}

                    <div>
                      <label
                        htmlFor="exam-set-count-input"
                        className="block text-[11px] font-semibold text-slate-700"
                      >
                        কত সেট পরীক্ষা (১–৫)
                      </label>
                      <input
                        id="exam-set-count-input"
                        data-testid="exam-set-count-input"
                        type="number"
                        min={1}
                        max={5}
                        value={examSetCount}
                        onChange={(e) => setExamSetCount(Number(e.target.value))}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
                      />
                    </div>
                  </div>

                  {/* Format-Adaptive MCQ Ordering & Language Controls */}
                  {(newMode === 'MCQ' || newMode === 'Mixed') && (
                    <div
                      data-testid="exam-mcq-adaptive-controls"
                      className="grid grid-cols-1 gap-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-2"
                    >
                      <div>
                        <label
                          htmlFor="exam-ordering-select"
                          className="block text-[11px] font-semibold text-slate-700"
                        >
                          প্রশ্ন সাজানোর ক্রম
                        </label>
                        <select
                          id="exam-ordering-select"
                          value={examOrderingMode}
                          onChange={(e) =>
                            setExamOrderingMode(
                              e.target.value as QuestionOrderingMode
                            )
                          }
                          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                        >
                          {Object.entries(QUESTION_ORDERING_LABELS).map(
                            ([k, label]) => (
                              <option key={k} value={k}>
                                {label}
                              </option>
                            )
                          )}
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="exam-language-select"
                          className="block text-[11px] font-semibold text-slate-700"
                        >
                          প্রশ্নের ভাষার ধরন
                        </label>
                        <select
                          id="exam-language-select"
                          value={examLanguageMode}
                          onChange={(e) =>
                            setExamLanguageMode(
                              e.target.value as QuestionLanguageMode
                            )
                          }
                          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                        >
                          {Object.entries(QUESTION_LANGUAGE_LABELS).map(
                            ([k, label]) => (
                              <option key={k} value={k}>
                                {label}
                              </option>
                            )
                          )}
                        </select>
                      </div>
                    </div>
                  )}

                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    একাধিক সেট দিলে প্রতিটি সেটে সম্পূর্ণ ভিন্ন প্রশ্ন তৈরি হবে এবং পরীক্ষা শেষে প্রতিটি প্রশ্নের উত্তর ও বই/AI ব্যাখ্যা দেখতে পারবেন।
                  </p>
                </div>
              </div>

              {/* Format-Adaptive Written Blueprint Editor (shown only in Written or Mixed mode) */}
              {(newMode === 'Written' || newMode === 'Mixed') && (
                <WrittenBlueprintEditor
                  sections={writtenSections}
                  onChange={setWrittenSections}
                  testIdPrefix="exam-written-blueprint"
                />
              )}

              {/* 3. Demo Photo / PDF Upload & Topic Percentage Blueprint */}
              <DemoPaperUploader
                targetTotalQuestionsPerSet={targetTotalPerExamSet}
                analysis={demoAnalysis}
                onAnalysisChange={setDemoAnalysis}
                onApplyDetectedFormat={handleApplyDetectedExamFormat}
                testIdPrefix="exam-demo"
              />

              {/* 4. Engine Selector: Zero-API Direct Book Compiler vs Gemini AI */}
              <div
                data-testid="exam-engine-selector"
                className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900">
                    ৪. প্রশ্ন তৈরির ইঞ্জিন নির্বাচন করুন
                  </span>
                  <span className="text-[10.5px] font-medium text-emerald-700">
                    {examGenerationEngine === 'local'
                      ? '০ API কোটা · সীমাহীন'
                      : 'অটো মডেল ফেইলওভার সক্রিয়'}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    data-testid="exam-engine-local-btn"
                    onClick={() => {
                      setExamGenerationEngine('local');
                      setBuilderError(null);
                      setBuilderIsQuotaError(false);
                    }}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      examGenerationEngine === 'local'
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-950'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <BookOpen className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                      <span>সরাসরি বই থেকে (০ API)</span>
                    </div>
                    <p className="mt-0.5 text-[10.5px] text-slate-600 leading-snug">
                      লাইব্রেরির বই থেকে তাৎক্ষণিক প্রশ্ন, উত্তর ও ব্যাখ্যাসহ পরীক্ষা তৈরি—কোনো লিমিট নেই।
                    </p>
                  </button>
                  <button
                    type="button"
                    data-testid="exam-engine-ai-btn"
                    onClick={() => {
                      setExamGenerationEngine('ai');
                      setBuilderError(null);
                      setBuilderIsQuotaError(false);
                    }}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      examGenerationEngine === 'ai'
                        ? 'border-blue-600 bg-blue-50 text-blue-950'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <Sparkles className="h-3.5 w-3.5 text-blue-700 shrink-0" />
                      <span>AI স্মার্ট প্রশ্ন তৈরি</span>
                    </div>
                    <p className="mt-0.5 text-[10.5px] text-slate-600 leading-snug">
                      Gemini API দিয়ে নতুন প্রশ্ন ও AI ব্যাখ্যা তৈরি (স্বয়ংক্রিয় মডেল ফেইলওভারসহ)।
                    </p>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* MODE B: Manual Question Bank Selection with Topic Filter */
            <div className="space-y-3 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700">
                  প্রশ্নব্যাংক থেকে প্রশ্ন নির্বাচন করুন ({toBengaliNumber(selectedQIds.length)}টি নির্বাচিত)
                </span>
                <select
                  aria-label="প্রশ্নব্যাংক সিলেবাস টপিক ফিল্টার"
                  value={manualTopicFilter}
                  onChange={(e) => setManualTopicFilter(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700"
                >
                  <option value="সব">সব সিলেবাস টপিক</option>
                  {manualTopicOptions.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              {filteredManualQuestions.length === 0 ? (
                <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-500 text-center">
                  প্রশ্নব্যাংকে এখনো কোনো প্রশ্ন নেই। উপরের “বই ও Demo প্রশ্ন (AI)” ট্যাব ব্যবহার করে সরাসরি আপনার বই থেকে প্রশ্ন তৈরি করে পরীক্ষা দিন!
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {filteredManualQuestions.map(({ question: q, topicLabel }) => (
                    <label
                      key={q.id}
                      className="flex items-start gap-2.5 p-3 hover:bg-slate-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedQIds.includes(q.id)}
                        onChange={() => handleToggleQuestion(q.id)}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-slate-900">
                          {q.stem}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {topicLabel} · {q.questionType} · {q.difficulty} · {q.subject}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {builderError && (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-800"
            >
              <p>{builderError}</p>
              {builderIsQuotaError && builderSourceMode === 'ai-books' && (
                <button
                  type="button"
                  data-testid="exam-quota-local-fallback-btn"
                  onClick={() => {
                    setExamGenerationEngine('local');
                    const fallbackTitle =
                      newTitle.trim() ||
                      [examOrgName.trim(), examPostName.trim()]
                        .filter(Boolean)
                        .join(' — ') ||
                      demoAnalysis?.examTitleDetected ||
                      `কাস্টম চাকরির মডেল টেস্ট (${new Date().toISOString().slice(0, 10)})`;
                    void createExamLocallyFromBooks(fallbackTitle);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-50 transition-colors"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  <span>০ API কোটায় সরাসরি বই থেকে এখনই পরীক্ষা তৈরি করুন</span>
                </button>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              disabled={generatingExam}
              onClick={() => setShowBuilder(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              বাতিল
            </button>
            <button
              type="submit"
              data-testid="submit-custom-exam-btn"
              disabled={generatingExam}
              className={`inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold text-white disabled:opacity-50 transition-colors ${
                builderSourceMode === 'ai-books' && examGenerationEngine === 'local'
                  ? 'bg-emerald-700 hover:bg-emerald-800'
                  : 'bg-blue-700 hover:bg-blue-800'
              }`}
            >
              {generatingExam ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>
                    {genExamProgress || 'বই থেকে প্রশ্নপত্র তৈরি হচ্ছে...'}
                  </span>
                </>
              ) : builderSourceMode === 'ai-books' && examGenerationEngine === 'local' ? (
                <>
                  <BookOpen className="h-4 w-4" />
                  <span>
                    {examSetCount > 1
                      ? `সরাসরি বই থেকে ${toBengaliNumber(Math.min(5, Math.max(1, examSetCount)))} সেট পরীক্ষা তৈরি করুন (০ API)`
                      : 'সরাসরি বই থেকে পরীক্ষা শুরু করুন (০ API)'}
                  </span>
                </>
              ) : builderSourceMode === 'ai-books' ? (
                <>
                  <Sparkles className="h-4 w-4" />
                  <span>
                    {examSetCount > 1
                      ? `${toBengaliNumber(Math.min(5, Math.max(1, examSetCount)))} সেট পরীক্ষা তৈরি করে সেট-১ শুরু করুন`
                      : 'AI দিয়ে বই থেকে প্রশ্ন তৈরি করে পরীক্ষা শুরু করুন'}
                  </span>
                </>
              ) : (
                <span>পরীক্ষা তৈরি করে শুরু করুন</span>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Ready Exams & Mock Tests List */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
        {data.exams.map((exam) => {
          const matchingAttempt = latestAttemptByExamId.get(exam.id) ?? null;
          return (
            <div
              key={exam.id}
              className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between hover:bg-slate-50/60 transition-colors"
            >
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-slate-900">
                  {exam.title}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">
                    {exam.subject}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{exam.examMode}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {exam.questionIds.length}টি প্রশ্ন
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    সময় {exam.durationMinutes} মিনিট
                  </span>
                  {exam.examMode !== 'Written' && exam.negativeMark > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums text-red-700">
                        নেগেটিভ -{exam.negativeMark}
                      </span>
                    </>
                  )}
                  {exam.status === 'in_progress' && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-amber-700">
                        চলমান (উত্তর সংরক্ষিত)
                      </span>
                    </>
                  )}
                  {matchingAttempt && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-emerald-700">
                        সম্পন্ন ({matchingAttempt.obtainedMarks}/
                        {matchingAttempt.totalMarks})
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {matchingAttempt && (
                  <button
                    type="button"
                    data-testid={`view-exam-answer-btn-${exam.id}`}
                    onClick={() => {
                      setAnswerSheetDefaultOpen(true);
                      setViewingAttemptId(matchingAttempt.id);
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 transition-colors whitespace-nowrap"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>উত্তর ও ব্যাখ্যা দেখুন</span>
                  </button>
                )}

                <button
                  type="button"
                  data-testid={`start-exam-btn-${exam.id}`}
                  onClick={() => beginExamSession(exam)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>
                    {exam.status === 'in_progress'
                      ? 'পরীক্ষা চালিয়ে যান'
                      : matchingAttempt
                        ? 'পুনরায় পরীক্ষা দিন'
                        : 'পরীক্ষা শুরু করুন'}
                  </span>
                </button>

                {confirmDeleteExamId === exam.id ? (
                  <div className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-red-50 px-2 py-1">
                    <button
                      type="button"
                      data-testid={`confirm-delete-exam-btn-${exam.id}`}
                      disabled={deletingExamId === exam.id}
                      onClick={async () => {
                        setDeletingExamId(exam.id);
                        try {
                          if (
                            matchingAttempt &&
                            viewingAttemptId === matchingAttempt.id
                          ) {
                            setViewingAttemptId(null);
                          }
                          await deleteExam(exam.id);
                          setConfirmDeleteExamId(null);
                        } finally {
                          setDeletingExamId(null);
                        }
                      }}
                      className="rounded bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      {deletingExamId === exam.id ? 'মুছছে...' : 'নিশ্চিত মুছুন'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteExamId(null)}
                      className="rounded px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-red-100"
                    >
                      বাতিল
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid={`delete-exam-btn-${exam.id}`}
                    aria-label={`পরীক্ষা মুছুন: ${exam.title}`}
                    onClick={() => setConfirmDeleteExamId(exam.id)}
                    className="inline-flex items-center justify-center gap-1 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 transition-colors whitespace-nowrap"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>মুছুন</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {data.exams.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-500">
            কোনো পরীক্ষা তালিকায় নেই। উপরের <strong>&ldquo;+ নতুন পরীক্ষা তৈরি করুন&rdquo;</strong> বাটনে ক্লিক করে নতুন মডেল টেস্ট তৈরি করুন।
          </div>
        )}
      </div>
    </div>
  );
}
