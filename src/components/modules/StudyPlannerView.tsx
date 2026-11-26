'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookMarked,
  BookOpen,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Clock,
  ExternalLink,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useWorkspace } from '../WorkspaceProvider';
import { StudyPlannerHeaderBar } from './StudyPlannerHeaderBar';
import { StudyTaskVerificationQuizModal } from './StudyTaskVerificationQuizModal';
import { toBengaliNumber } from '@/src/lib/file-validation';
import {
  addDaysToIsoDate,
  buildDynamicBookIntelligence,
  buildMistakeBookJumpMap,
  computeExamCountdownStrategy,
  computeSmartReschedulePlan,
  computeStudyStreakAndTodayMinutes,
  detectRepeatedMistakeIds,
  generateSmartRoutineTasks,
  getTodayIsoDate,
  resolveTaskBookJumpTarget,
  type ExamTargetConfig,
  type RoutineGenerationSlot,
} from '@/src/lib/smart-study-planner';
import type { StudyTask } from '@/src/types/system';

type PlannerTab = 'routine' | 'mistakes' | 'revision';
type RoutineFilter = 'today' | 'overdue' | 'upcoming' | 'all' | 'completed';
type MistakeStatusFilter = 'pending' | 'mastered' | 'all';
type RevisionFilter = 'all' | 'due' | 'high_impact';

interface StoredPlannerMeta {
  targetConfig: ExamTargetConfig;
  focusMinutesByDate: Record<string, number>;
}

const DEFAULT_TARGET_CONFIG: ExamTargetConfig = {
  examName: 'সরকারি চাকরির প্রস্তুতি পরীক্ষা',
  targetDate: '',
  dailyHours: 2.5,
  focusBookScope: 'all',
};

function readPlannerMeta(storageKey: string): StoredPlannerMeta {
  if (typeof window === 'undefined') {
    return { targetConfig: DEFAULT_TARGET_CONFIG, focusMinutesByDate: {} };
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return { targetConfig: DEFAULT_TARGET_CONFIG, focusMinutesByDate: {} };
    }
    const parsed = JSON.parse(raw) as Partial<StoredPlannerMeta>;
    return {
      targetConfig: {
        examName:
          typeof parsed.targetConfig?.examName === 'string'
            ? parsed.targetConfig.examName
            : DEFAULT_TARGET_CONFIG.examName,
        targetDate:
          typeof parsed.targetConfig?.targetDate === 'string'
            ? parsed.targetConfig.targetDate
            : '',
        dailyHours:
          typeof parsed.targetConfig?.dailyHours === 'number' &&
          Number.isFinite(parsed.targetConfig.dailyHours)
            ? parsed.targetConfig.dailyHours
            : DEFAULT_TARGET_CONFIG.dailyHours,
        focusBookScope:
          parsed.targetConfig?.focusBookScope === 'all' ||
          Array.isArray(parsed.targetConfig?.focusBookScope)
            ? parsed.targetConfig.focusBookScope
            : 'all',
      },
      focusMinutesByDate:
        parsed.focusMinutesByDate &&
        typeof parsed.focusMinutesByDate === 'object'
          ? parsed.focusMinutesByDate
          : {},
    };
  } catch {
    return { targetConfig: DEFAULT_TARGET_CONFIG, focusMinutesByDate: {} };
  }
}

export function StudyPlannerView() {
  const {
    data,
    offlineScopeKey,
    addStudyTask,
    addStudyTasksBatch,
    updateStudyTask,
    toggleStudyTask,
    deleteStudyTask,
    toggleMistakeMastered,
    deleteMistake,
    addMistakeItems,
    createExam,
    setActiveExamId,
    setActiveModule,
    openSourceQuestionInReader,
  } = useWorkspace();

  const todayIso = useMemo(() => getTodayIsoDate(), []);
  const plannerStorageKey = `prostuti_planner_meta_${offlineScopeKey}`;

  const [tab, setTab] = useState<PlannerTab>('routine');
  const [plannerMeta, setPlannerMeta] = useState<StoredPlannerMeta>(() =>
    readPlannerMeta(plannerStorageKey)
  );

  // Persist per-user planner target & focus logs cleanly
  const updatePlannerMeta = (
    updater: (prev: StoredPlannerMeta) => StoredPlannerMeta
  ) => {
    setPlannerMeta((prev) => {
      const next = updater(prev);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(plannerStorageKey, JSON.stringify(next));
        } catch {
          // ignore storage quota errors
        }
      }
      return next;
    });
  };

  // Routine filters & notices
  const [routineFilter, setRoutineFilter] = useState<RoutineFilter>('all');
  const [routineNotice, setRoutineNotice] = useState<string | null>(null);
  const [busyRoutineAction, setBusyRoutineAction] = useState(false);

  // Add Task Form (auto today's date + dynamic book picker)
  const [selectedBookForForm, setSelectedBookForForm] = useState<string>('');
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('বাংলাদেশ বিষয়াবলি');
  const [chapter, setChapter] = useState('');
  const [taskType, setTaskType] = useState<StudyTask['taskType']>('reading');
  const [scheduledDate, setScheduledDate] = useState(() => getTodayIsoDate());
  const [durationMinutes, setDurationMinutes] = useState(45);
  const [taskError, setTaskError] = useState<string | null>(null);

  // Inline Edit Task state
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [editChapter, setEditChapter] = useState('');
  const [editTaskType, setEditTaskType] =
    useState<StudyTask['taskType']>('reading');
  const [editDate, setEditDate] = useState('');
  const [editDuration, setEditDuration] = useState(30);

  // Inline Delete confirmations (no window.confirm in iframe)
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<number | null>(
    null
  );
  const [confirmDeleteMistakeId, setConfirmDeleteMistakeId] = useState<
    number | null
  >(null);

  // Live Focus Timer state
  const [focusTaskId, setFocusTaskId] = useState<number | null>(null);
  const [focusRemainingSec, setFocusRemainingSec] = useState(0);
  const [focusElapsedSec, setFocusElapsedSec] = useState(0);
  const [focusRunning, setFocusRunning] = useState(false);

  // 5-Question Verification Quiz modal state
  const [quizTask, setQuizTask] = useState<StudyTask | null>(null);

  // Mistake Notebook filters
  const [mistakeStatusFilter, setMistakeStatusFilter] =
    useState<MistakeStatusFilter>('pending');
  const [mistakeSubjectFilter, setMistakeSubjectFilter] =
    useState<string>('ALL');
  const [mistakeSearch, setMistakeSearch] = useState('');

  // Smart Revision filters
  const [revisionBookFilter, setRevisionBookFilter] = useState<string>('ALL');
  const [revisionPriorityFilter, setRevisionPriorityFilter] =
    useState<RevisionFilter>('all');

  // Tick live Focus Timer cleanly every second when running
  useEffect(() => {
    if (!focusRunning || focusTaskId === null) return;
    const intervalId = window.setInterval(() => {
      setFocusElapsedSec((prev) => prev + 1);
      setFocusRemainingSec((prev) => {
        if (prev <= 1) {
          setFocusRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [focusRunning, focusTaskId]);

  // Dynamic intelligence recomputes automatically whenever data.books changes (including newly uploaded books!)
  const bookIntelligence = useMemo(
    () =>
      buildDynamicBookIntelligence({
        books: data.books,
        attempts: data.attempts,
        mistakes: data.mistakes,
        studyTasks: data.studyTasks,
        todayIso,
      }),
    [data.books, data.attempts, data.mistakes, data.studyTasks, todayIso]
  );

  const strategy = useMemo(
    () =>
      computeExamCountdownStrategy(
        plannerMeta.targetConfig.targetDate,
        todayIso
      ),
    [plannerMeta.targetConfig.targetDate, todayIso]
  );

  const dailyTargetMinutes = Math.round(
    Math.max(0.5, plannerMeta.targetConfig.dailyHours || 2) * 60
  );

  const streakMetrics = useMemo(
    () =>
      computeStudyStreakAndTodayMinutes({
        tasks: data.studyTasks,
        focusMinutesByDate: plannerMeta.focusMinutesByDate,
        todayIso,
        dailyTargetMinutes,
      }),
    [
      data.studyTasks,
      plannerMeta.focusMinutesByDate,
      todayIso,
      dailyTargetMinutes,
    ]
  );

  const activeMistakes = useMemo(
    () => data.mistakes.filter((m) => !m.mastered),
    [data.mistakes]
  );

  const repeatedMistakeIds = useMemo(
    () => detectRepeatedMistakeIds(data.mistakes),
    [data.mistakes]
  );

  const mistakeBookJumpMap = useMemo(
    () => buildMistakeBookJumpMap(data.mistakes, data.books),
    [data.mistakes, data.books]
  );

  const mistakeSubjects = useMemo(() => {
    const set = new Set<string>();
    for (const m of data.mistakes) {
      if (m.subject.trim()) set.add(m.subject.trim());
    }
    return Array.from(set);
  }, [data.mistakes]);

  const filteredMistakes = useMemo(() => {
    const q = mistakeSearch.trim().toLowerCase();
    return data.mistakes.filter((m) => {
      if (mistakeStatusFilter === 'pending' && m.mastered) return false;
      if (mistakeStatusFilter === 'mastered' && !m.mastered) return false;
      if (
        mistakeSubjectFilter !== 'ALL' &&
        m.subject.trim() !== mistakeSubjectFilter
      ) {
        return false;
      }
      if (q) {
        const hay = `${m.questionStem} ${m.subject} ${m.chapter} ${m.correctAnswer}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data.mistakes, mistakeStatusFilter, mistakeSubjectFilter, mistakeSearch]);

  const weekEndIso = useMemo(() => addDaysToIsoDate(todayIso, 7), [todayIso]);

  const routineCounts = useMemo(() => {
    let today = 0;
    let overdue = 0;
    let upcoming = 0;
    let completed = 0;
    for (const t of data.studyTasks) {
      if (t.completed) {
        completed += 1;
      } else {
        if (t.scheduledDate === todayIso) today += 1;
        else if (t.scheduledDate < todayIso) overdue += 1;
        else if (t.scheduledDate <= weekEndIso) upcoming += 1;
      }
    }
    return {
      today,
      overdue,
      upcoming,
      completed,
      all: data.studyTasks.length,
    };
  }, [data.studyTasks, todayIso, weekEndIso]);

  const filteredTasks = useMemo(() => {
    return data.studyTasks
      .filter((t) => {
        if (routineFilter === 'today') return t.scheduledDate === todayIso;
        if (routineFilter === 'overdue')
          return !t.completed && t.scheduledDate < todayIso;
        if (routineFilter === 'upcoming')
          return (
            !t.completed &&
            t.scheduledDate > todayIso &&
            t.scheduledDate <= weekEndIso
          );
        if (routineFilter === 'completed') return t.completed;
        return true;
      })
      .sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return a.scheduledDate.localeCompare(b.scheduledDate);
      });
  }, [data.studyTasks, routineFilter, todayIso, weekEndIso]);

  const scheduledTodayChapterSet = useMemo(() => {
    const set = new Set<string>();
    for (const t of data.studyTasks) {
      if (!t.completed && t.scheduledDate >= todayIso) {
        set.add(t.chapter.trim().toLowerCase());
      }
    }
    return set;
  }, [data.studyTasks, todayIso]);

  const filteredRevisionUnits = useMemo(() => {
    return bookIntelligence.revisionUnits.filter((unit) => {
      if (
        revisionBookFilter !== 'ALL' &&
        String(unit.bookId) !== revisionBookFilter
      ) {
        return false;
      }
      if (revisionPriorityFilter === 'due' && !unit.dueToday) return false;
      if (
        revisionPriorityFilter === 'high_impact' &&
        unit.roiPriorityScore < 45 &&
        unit.weakScore === 0
      ) {
        return false;
      }
      return true;
    });
  }, [
    bookIntelligence.revisionUnits,
    revisionBookFilter,
    revisionPriorityFilter,
  ]);

  const focusTask = useMemo(
    () =>
      focusTaskId !== null
        ? data.studyTasks.find((t) => t.id === focusTaskId) ?? null
        : null,
    [data.studyTasks, focusTaskId]
  );

  // Handlers
  const handleSelectBookInForm = (bookIdStr: string) => {
    setSelectedBookForForm(bookIdStr);
    if (!bookIdStr) return;
    const book = data.books.find((b) => String(b.id) === bookIdStr);
    if (!book) return;
    setSubject(book.subject || 'সমন্বিত');
    const firstChapter = book.chunks[0]?.chapter || 'অধ্যায় ১';
    setChapter(firstChapter);
    if (!title.trim()) {
      setTitle(`অধ্যায় পড়া: ${firstChapter} (${book.title})`);
    }
  };

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setTaskError(null);
    if (!title.trim()) {
      setTaskError('অনুগ্রহ করে পড়ার লক্ষ্য বা কাজের শিরোনাম লিখুন।');
      return;
    }
    await addStudyTask({
      title: title.trim(),
      subject: subject.trim() || 'সাধারণ',
      chapter: chapter.trim() || 'মূল অধ্যায়',
      taskType,
      scheduledDate: scheduledDate || todayIso,
      durationMinutes: Math.max(10, Math.min(240, Number(durationMinutes) || 30)),
    });
    setTitle('');
    setChapter('');
    setSelectedBookForForm('');
    setRoutineNotice('নতুন পড়ার লক্ষ্য রুটিনে যুক্ত হয়েছে।');
  };

  const handleGenerateRoutine = async (slot: RoutineGenerationSlot) => {
    setBusyRoutineAction(true);
    setRoutineNotice(null);
    try {
      const planned = generateSmartRoutineTasks({
        books: data.books,
        attempts: data.attempts,
        mistakes: data.mistakes,
        gkItems: data.gkItems,
        existingTasks: data.studyTasks,
        slot,
        dailyMinutes: dailyTargetMinutes,
        strategyMode: strategy.mode,
        focusBookScope: plannerMeta.targetConfig.focusBookScope,
        todayIso,
      });

      if (planned.length === 0) {
        setRoutineNotice(
          'এই সময়ের জন্য প্রস্তাবিত কাজগুলো ইতিমধ্যেই আপনার রুটিনে যুক্ত আছে।'
        );
        return;
      }

      const addedCount = await addStudyTasksBatch(planned);
      setRoutineFilter(slot === 'week_7' ? 'all' : 'today');
      setRoutineNotice(
        `০ API কোটায় আপনার ${toBengaliNumber(data.books.length)}টি বই, দুর্বল অধ্যায় ও ভুল নোটবুক বিশ্লেষণ করে ${toBengaliNumber(addedCount)}টি স্মার্ট কাজ রুটিনে যুক্ত হয়েছে।`
      );
    } finally {
      setBusyRoutineAction(false);
    }
  };

  const handleSmartReschedule = async () => {
    setBusyRoutineAction(true);
    setRoutineNotice(null);
    try {
      const assignments = computeSmartReschedulePlan({
        tasks: data.studyTasks,
        dailyMinutesCap: dailyTargetMinutes,
        todayIso,
      });
      if (assignments.length === 0) {
        setRoutineNotice('বাকি থাকা (Overdue) কোনো অসম্পন্ন কাজ নেই।');
        return;
      }
      for (const item of assignments) {
        await updateStudyTask(item.taskId, { scheduledDate: item.toDate });
      }
      setRoutineFilter('today');
      setRoutineNotice(
        `মিস হয়ে যাওয়া ${toBengaliNumber(assignments.length)}টি কাজ দৈনিক পড়ার সময় মেনে আজ ও আগামী দিনগুলোতে সুন্দরভাবে ভাগ করে দেওয়া হয়েছে।`
      );
    } finally {
      setBusyRoutineAction(false);
    }
  };

  const handleStartEditTask = (task: StudyTask) => {
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditSubject(task.subject);
    setEditChapter(task.chapter);
    setEditTaskType(task.taskType);
    setEditDate(task.scheduledDate);
    setEditDuration(task.durationMinutes);
  };

  const handleSaveEditTask = async (taskId: number) => {
    if (!editTitle.trim()) return;
    await updateStudyTask(taskId, {
      title: editTitle.trim(),
      subject: editSubject.trim() || 'সাধারণ',
      chapter: editChapter.trim() || 'মূল অধ্যায়',
      taskType: editTaskType,
      scheduledDate: editDate || todayIso,
      durationMinutes: Math.max(10, Math.min(240, Number(editDuration) || 30)),
    });
    setEditingTaskId(null);
    setRoutineNotice('রুটিনের কাজটি সফলভাবে আপডেট করা হয়েছে।');
  };

  const handleStartFocusTimer = (task: StudyTask) => {
    setFocusTaskId(task.id);
    setFocusRemainingSec(Math.max(1, task.durationMinutes) * 60);
    setFocusElapsedSec(0);
    setFocusRunning(true);
  };

  const handleCompleteFocusSession = async () => {
    if (!focusTask) return;
    const loggedMinutes = Math.max(
      1,
      Math.round(focusElapsedSec / 60) || focusTask.durationMinutes
    );
    updatePlannerMeta((prev) => ({
      ...prev,
      focusMinutesByDate: {
        ...prev.focusMinutesByDate,
        [todayIso]: (prev.focusMinutesByDate[todayIso] ?? 0) + loggedMinutes,
      },
    }));
    if (!focusTask.completed) {
      await toggleStudyTask(focusTask.id);
    }
    setFocusRunning(false);
    setFocusTaskId(null);
    setRoutineNotice(
      `অভিনন্দন! “${focusTask.title}” সম্পন্ন হয়েছে এবং আজকের পড়া হিসেবে ${toBengaliNumber(loggedMinutes)} মিনিট যুক্ত হয়েছে।`
    );
  };

  const handleLaunchTaskAction = (task: StudyTask) => {
    if (task.taskType === 'exam') {
      setActiveModule('exam-center');
      return;
    }
    const jump = resolveTaskBookJumpTarget(task, data.books);
    if (jump) {
      openSourceQuestionInReader({
        bookId: jump.bookId,
        pageNumber: jump.pageNumber,
      });
      return;
    }
    setActiveModule('reader');
  };

  const handleStartMistakeExam = async (subjectOnly: string) => {
    const pool = activeMistakes.filter(
      (m) => subjectOnly === 'ALL' || m.subject.trim() === subjectOnly
    );
    const mistakeQuestionIds = Array.from(
      new Set(
        pool
          .map((m) => m.questionId)
          .filter((id): id is number => typeof id === 'number')
      )
    );
    const validIds = mistakeQuestionIds.filter((id) =>
      data.questions.some((q) => q.id === id)
    );
    if (validIds.length === 0) {
      setRoutineNotice(
        'এই ফিল্টারের ভুল প্রশ্নগুলো প্রশ্নব্যাংকে পাওয়া যায়নি—সকল বিষয়ের ভুল পরীক্ষা চেষ্টা করুন।'
      );
      return;
    }

    const label =
      subjectOnly === 'ALL'
        ? `ভুল নোটবুক পুনঃঅনুশীলন পরীক্ষা (${validIds.length} প্রশ্ন)`
        : `ভুল নোটবুক পরীক্ষা — ${subjectOnly} (${validIds.length} প্রশ্ন)`;

    const exam = await createExam({
      title: label,
      subject: subjectOnly === 'ALL' ? 'ভুল সংশোধন অনুশীলন' : subjectOnly,
      examMode: 'Mixed',
      durationMinutes: Math.max(5, validIds.length * 2),
      marksPerQuestion: 1,
      negativeMark: 0.25,
      questionIds: validIds,
    });
    setActiveExamId(exam.id);
    setActiveModule('exam-center');
  };

  const taskTypeLabel: Record<StudyTask['taskType'], string> = {
    reading: 'অধ্যায় পড়া',
    revision: 'রিভিশন',
    practice: 'অনুশীলন',
    exam: 'মডেল টেস্ট',
  };

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      {/* Header + 3 Main Tabs */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            07. Smart Study Planner, ভুল নোটবুক ও স্মার্ট রিভিশন
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            আপনার লাইব্রেরির সব বই, পরীক্ষার দুর্বল অধ্যায় ও ভুল নোটবুক বিশ্লেষণ করে দৈনিক স্মার্ট রুটিন ও স্পেসড রিভিশন পরিচালনা করুন।
          </p>
        </div>

        <div
          role="tablist"
          aria-label="প্ল্যানার সেকশন"
          className="inline-flex items-center gap-1 rounded-lg bg-slate-200/70 p-1 self-start sm:self-auto"
        >
          <button
            type="button"
            role="tab"
            data-testid="planner-tab-routine"
            aria-selected={tab === 'routine'}
            onClick={() => setTab('routine')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              tab === 'routine'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            দৈনিক রুটিন ({toBengaliNumber(data.studyTasks.length)})
          </button>
          <button
            type="button"
            role="tab"
            data-testid="planner-tab-mistakes"
            aria-selected={tab === 'mistakes'}
            onClick={() => setTab('mistakes')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              tab === 'mistakes'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            ভুল নোটবুক ({toBengaliNumber(activeMistakes.length)})
          </button>
          <button
            type="button"
            role="tab"
            data-testid="planner-tab-revision"
            aria-selected={tab === 'revision'}
            onClick={() => setTab('revision')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              tab === 'revision'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            স্মার্ট রিভিশন ({toBengaliNumber(bookIntelligence.dueTodayCount)})
          </button>
        </div>
      </div>

      {/* Top Target Exam Countdown + 4 KPI Summary Bar */}
      <StudyPlannerHeaderBar
        targetConfig={plannerMeta.targetConfig}
        onUpdateTargetConfig={(nextConfig) =>
          updatePlannerMeta((prev) => ({ ...prev, targetConfig: nextConfig }))
        }
        strategy={strategy}
        streakMetrics={streakMetrics}
        activeMistakesCount={activeMistakes.length}
        dueRevisionsCount={bookIntelligence.dueTodayCount}
        totalBooksCount={data.books.length}
        onOpenMistakesTab={() => setTab('mistakes')}
        onOpenRevisionTab={() => setTab('revision')}
      />

      {routineNotice && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-2.5 text-xs font-medium text-blue-900"
        >
          <span>{routineNotice}</span>
          <button
            type="button"
            aria-label="বার্তা বন্ধ করুন"
            onClick={() => setRoutineNotice(null)}
            className="rounded p-1 text-blue-700 hover:bg-blue-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* TAB 1: DAILY ROUTINE & FOCUS TIMER */}
      {tab === 'routine' && (
        <div className="space-y-5">
          {/* Active Focus Timer Banner */}
          {focusTask && (
            <div
              data-testid="live-focus-timer-banner"
              className="sticky top-2 z-20 flex flex-col gap-3 rounded-xl border border-blue-300 bg-blue-50/95 p-4 shadow-md backdrop-blur sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-blue-800">
                  <Clock className="h-3.5 w-3.5" />
                  <span>ফোকাস টাইমার চলছে</span>
                </div>
                <p className="mt-0.5 text-sm font-bold text-slate-900 truncate">
                  {focusTask.title}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <span
                  data-testid="focus-timer-clock"
                  className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 font-mono text-lg font-bold tabular-nums text-blue-900"
                >
                  {formatTimer(focusRemainingSec)}
                </span>
                <button
                  type="button"
                  onClick={() => setFocusRunning((r) => !r)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                >
                  {focusRunning ? (
                    <>
                      <Pause className="h-3.5 w-3.5" />
                      <span>বিরতি</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" />
                      <span>চালু করুন</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  data-testid="complete-focus-session-btn"
                  onClick={() => void handleCompleteFocusSession()}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>সম্পন্ন ও সময় সেভ</span>
                </button>
                <button
                  type="button"
                  aria-label="টাইমার বন্ধ করুন"
                  onClick={() => {
                    setFocusRunning(false);
                    setFocusTaskId(null);
                  }}
                  className="rounded-lg p-2 text-slate-500 hover:bg-white/80"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Quick-Slot Auto-Routine Generator (0 API, Dynamic All-Books) */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-blue-700" />
                  <h2 className="text-sm font-bold text-slate-900">
                    আজ আমার হাতে কত সময় আছে? (এক ক্লিকে স্মার্ট রুটিন — ০ API)
                  </h2>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  লাইব্রেরির সব বই ({toBengaliNumber(data.books.length)}টি), দুর্বল অধ্যায়, ভুল নোটবুক ও Current GK থেকে তাৎক্ষণিকভাবে সেরা রুটিন সাজিয়ে দেয়।
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <label
                  htmlFor="routine-book-scope-select"
                  className="text-xs font-semibold text-slate-600 whitespace-nowrap"
                >
                  বইয়ের উৎস:
                </label>
                <select
                  id="routine-book-scope-select"
                  data-testid="routine-book-scope-select"
                  value={
                    plannerMeta.targetConfig.focusBookScope === 'all'
                      ? 'all'
                      : String(plannerMeta.targetConfig.focusBookScope[0] ?? 'all')
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    updatePlannerMeta((prev) => ({
                      ...prev,
                      targetConfig: {
                        ...prev.targetConfig,
                        focusBookScope: val === 'all' ? 'all' : [Number(val)],
                      },
                    }));
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 max-w-[240px]"
                >
                  <option value="all">
                    সব বই স্বয়ংক্রিয় ({toBengaliNumber(data.books.length)}টি — নতুন বই অটো যুক্ত হবে)
                  </option>
                  {data.books.map((book) => (
                    <option key={book.id} value={String(book.id)}>
                      {book.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                data-testid="generate-slot-30-btn"
                disabled={busyRoutineAction}
                onClick={() => void handleGenerateRoutine('slot_30')}
                className="rounded-lg border border-blue-200 bg-blue-50/70 px-3.5 py-2 text-xs font-semibold text-blue-900 hover:bg-blue-100 disabled:opacity-50"
              >
                ৩০ মিনিটের কুইক প্ল্যান
              </button>
              <button
                type="button"
                data-testid="generate-slot-60-btn"
                disabled={busyRoutineAction}
                onClick={() => void handleGenerateRoutine('slot_60')}
                className="rounded-lg border border-blue-200 bg-blue-50/70 px-3.5 py-2 text-xs font-semibold text-blue-900 hover:bg-blue-100 disabled:opacity-50"
              >
                ১ ঘণ্টার ফোকাস প্ল্যান
              </button>
              <button
                type="button"
                data-testid="generate-slot-120-btn"
                disabled={busyRoutineAction}
                onClick={() => void handleGenerateRoutine('slot_120')}
                className="rounded-lg border border-blue-200 bg-blue-50/70 px-3.5 py-2 text-xs font-semibold text-blue-900 hover:bg-blue-100 disabled:opacity-50"
              >
                ২ ঘণ্টার পূর্ণ প্ল্যান
              </button>
              <button
                type="button"
                data-testid="generate-week-7-btn"
                disabled={busyRoutineAction}
                onClick={() => void handleGenerateRoutine('week_7')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
              >
                <Calendar className="h-3.5 w-3.5" />
                <span>৭ দিনের অটো রুটিন তৈরি করুন</span>
              </button>
            </div>
          </div>

          {/* Quick Add Manual Task Form (with dynamic library book selector & auto today date) */}
          <form
            onSubmit={handleAddTask}
            className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                নতুন পড়ার লক্ষ্য যুক্ত করুন
              </h2>
              {data.books.length > 0 && (
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="task-book-picker"
                    className="text-xs font-medium text-slate-600"
                  >
                    বই থেকে নিন:
                  </label>
                  <select
                    id="task-book-picker"
                    data-testid="task-book-picker"
                    value={selectedBookForForm}
                    onChange={(e) => handleSelectBookInForm(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800 max-w-[230px]"
                  >
                    <option value="">ঐচ্ছিক (বই বাছাই করুন)</option>
                    {data.books.map((b) => (
                      <option key={b.id} value={String(b.id)}>
                        {b.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <div className="sm:col-span-2">
                <label
                  htmlFor="task-title-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  লক্ষ্য / কাজের বিবরণ *
                </label>
                <input
                  id="task-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="যেমন: সংবিধানের অনুচ্ছেদ ৪৮–৬৫ রিভিশন"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="task-subject-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  বিষয়
                </label>
                <input
                  id="task-subject-input"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="task-type-select"
                  className="block text-xs font-semibold text-slate-700"
                >
                  ধরন
                </label>
                <select
                  id="task-type-select"
                  value={taskType}
                  onChange={(e) =>
                    setTaskType(e.target.value as StudyTask['taskType'])
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                >
                  <option value="reading">অধ্যায় পড়া</option>
                  <option value="revision">রিভিশন</option>
                  <option value="practice">অনুশীলন</option>
                  <option value="exam">মডেল টেস্ট</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="task-date-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  তারিখ
                </label>
                <input
                  id="task-date-input"
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor="task-duration-input"
                  className="block text-xs font-semibold text-slate-700"
                >
                  সময় (মিনিট)
                </label>
                <input
                  id="task-duration-input"
                  type="number"
                  min={10}
                  max={240}
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums text-slate-900"
                />
              </div>
            </div>

            {taskError && (
              <p role="alert" className="text-xs font-medium text-red-700">
                {taskError}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                data-testid="add-study-task-btn"
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>রুটিনে যুক্ত করুন</span>
              </button>
            </div>
          </form>

          {/* Filter Pills + Smart Reschedule Bar */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              role="tablist"
              aria-label="রুটিন তারিখ ফিল্টার"
              className="flex flex-wrap items-center gap-1.5"
            >
              {(
                [
                  { id: 'all', label: `সব (${toBengaliNumber(routineCounts.all)})` },
                  { id: 'today', label: `আজ (${toBengaliNumber(routineCounts.today)})` },
                  {
                    id: 'overdue',
                    label: `বাকি থাকা (${toBengaliNumber(routineCounts.overdue)})`,
                  },
                  {
                    id: 'upcoming',
                    label: `আগামী ৭ দিন (${toBengaliNumber(routineCounts.upcoming)})`,
                  },
                  {
                    id: 'completed',
                    label: `সম্পন্ন (${toBengaliNumber(routineCounts.completed)})`,
                  },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  data-testid={`routine-filter-${f.id}`}
                  aria-selected={routineFilter === f.id}
                  onClick={() => setRoutineFilter(f.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    routineFilter === f.id
                      ? 'bg-slate-900 text-white'
                      : f.id === 'overdue' && routineCounts.overdue > 0
                        ? 'border border-red-200 bg-red-50 text-red-800 hover:bg-red-100'
                        : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {routineCounts.overdue > 0 && (
              <button
                type="button"
                data-testid="smart-reschedule-btn"
                disabled={busyRoutineAction}
                onClick={() => void handleSmartReschedule()}
                className="inline-flex items-center gap-1.5 self-start sm:self-auto rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>
                  বাকি থাকা {toBengaliNumber(routineCounts.overdue)}টি কাজ পুনর্বিন্যাস করুন
                </span>
              </button>
            )}
          </div>

          {/* Tasks List */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
            {filteredTasks.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                এই ফিল্টারে কোনো পড়ার কাজ নেই। উপরের <strong>“১ ঘণ্টার ফোকাস প্ল্যান”</strong> বা <strong>“৭ দিনের অটো রুটিন”</strong> বাটনে ক্লিক করে রুটিন তৈরি করুন।
              </div>
            ) : (
              filteredTasks.map((task) => {
                const isOverdue = !task.completed && task.scheduledDate < todayIso;
                const isEditing = editingTaskId === task.id;
                const jumpTarget = resolveTaskBookJumpTarget(task, data.books);

                if (isEditing) {
                  return (
                    <div
                      key={task.id}
                      data-testid={`edit-task-row-${task.id}`}
                      className="p-4 bg-blue-50/40 space-y-3"
                    >
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
                        <input
                          type="text"
                          aria-label="কাজের শিরোনাম এডিট"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="sm:col-span-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
                        />
                        <input
                          type="text"
                          aria-label="বিষয় এডিট"
                          value={editSubject}
                          onChange={(e) => setEditSubject(e.target.value)}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
                        />
                        <input
                          type="date"
                          aria-label="তারিখ এডিট"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900"
                        />
                        <input
                          type="number"
                          aria-label="সময় এডিট"
                          min={10}
                          max={240}
                          value={editDuration}
                          onChange={(e) => setEditDuration(Number(e.target.value))}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900"
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <select
                          aria-label="কাজের ধরন এডিট"
                          value={editTaskType}
                          onChange={(e) =>
                            setEditTaskType(
                              e.target.value as StudyTask['taskType']
                            )
                          }
                          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800"
                        >
                          <option value="reading">অধ্যায় পড়া</option>
                          <option value="revision">রিভিশন</option>
                          <option value="practice">অনুশীলন</option>
                          <option value="exam">মডেল টেস্ট</option>
                        </select>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingTaskId(null)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            বাতিল
                          </button>
                          <button
                            type="button"
                            data-testid={`save-edit-task-btn-${task.id}`}
                            onClick={() => void handleSaveEditTask(task.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>সংরক্ষণ</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={task.id}
                    data-testid={`study-task-row-${task.id}`}
                    className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between hover:bg-slate-50/70 transition-colors"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <button
                        type="button"
                        onClick={() => void toggleStudyTask(task.id)}
                        aria-label={
                          task.completed
                            ? `অসম্পন্ন চিহ্নিত করুন: ${task.title}`
                            : `সম্পন্ন চিহ্নিত করুন: ${task.title}`
                        }
                        className="mt-0.5 text-slate-400 hover:text-blue-700 shrink-0"
                      >
                        {task.completed ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-700" />
                        ) : (
                          <Circle className="h-5 w-5" />
                        )}
                      </button>
                      <div className="min-w-0">
                        <p
                          className={`text-sm font-semibold ${
                            task.completed
                              ? 'line-through text-slate-400'
                              : 'text-slate-900'
                          }`}
                        >
                          {task.title}
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                          <span className="font-medium text-slate-700">
                            {task.subject}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{taskTypeLabel[task.taskType]}</span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={`font-mono tabular-nums ${
                              isOverdue ? 'font-semibold text-red-700' : ''
                            }`}
                          >
                            {task.scheduledDate}
                            {isOverdue ? ' (বাকি থাকা)' : ''}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {toBengaliNumber(task.durationMinutes)} মিনিট
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 pl-8 lg:pl-0 shrink-0">
                      {!task.completed && (
                        <>
                          <button
                            type="button"
                            data-testid={`start-focus-timer-btn-${task.id}`}
                            onClick={() => handleStartFocusTimer(task)}
                            className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] font-semibold text-blue-800 hover:bg-blue-100"
                          >
                            <Play className="h-3 w-3" />
                            <span>টাইমার</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleLaunchTaskAction(task)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            <BookOpen className="h-3 w-3" />
                            <span>
                              {task.taskType === 'exam'
                                ? 'পরীক্ষা দিন'
                                : jumpTarget
                                  ? 'বইয়ে পড়ুন'
                                  : 'রিডার খুলুন'}
                            </span>
                          </button>

                          <button
                            type="button"
                            data-testid={`verify-quiz-task-btn-${task.id}`}
                            onClick={() => setQuizTask(task)}
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100"
                          >
                            <ClipboardCheck className="h-3 w-3" />
                            <span>৫ প্রশ্নের কুইজ</span>
                          </button>
                        </>
                      )}

                      <button
                        type="button"
                        data-testid={`edit-task-btn-${task.id}`}
                        aria-label={`এডিট করুন: ${task.title}`}
                        onClick={() => handleStartEditTask(task)}
                        className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>

                      {confirmDeleteTaskId === task.id ? (
                        <div className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-red-50 px-2 py-1">
                          <button
                            type="button"
                            data-testid={`confirm-delete-task-btn-${task.id}`}
                            onClick={async () => {
                              if (focusTaskId === task.id) {
                                setFocusRunning(false);
                                setFocusTaskId(null);
                              }
                              await deleteStudyTask(task.id);
                              setConfirmDeleteTaskId(null);
                            }}
                            className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-red-700"
                          >
                            নিশ্চিত মুছুন
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteTaskId(null)}
                            className="rounded px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-red-100"
                          >
                            বাতিল
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          data-testid={`delete-task-btn-${task.id}`}
                          aria-label={`লক্ষ্য মুছুন: ${task.title}`}
                          onClick={() => setConfirmDeleteTaskId(task.id)}
                          className="rounded-lg border border-red-200 bg-white p-1.5 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 2: MISTAKE NOTEBOOK */}
      {tab === 'mistakes' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  ভুল নোটবুক (Mistake Notebook)
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  পরীক্ষা ও যাচাই কুইজে ভুল করা প্রশ্নগুলো স্বয়ংক্রিয়ভাবে এখানে জমা হয়। বিষয়ভিত্তিক অনুশীলন করুন বা অপ্রয়োজনীয় ভুল মুছে ফেলুন।
                </p>
              </div>
              {activeMistakes.length > 0 && (
                <button
                  type="button"
                  data-testid="start-mistake-exam-btn"
                  onClick={() => void handleStartMistakeExam(mistakeSubjectFilter)}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>
                    {mistakeSubjectFilter === 'ALL'
                      ? 'সব ভুল প্রশ্নের পুনঃঅনুশীলন পরীক্ষা দিন'
                      : `${mistakeSubjectFilter} বিষয়ের ভুল পরীক্ষা দিন`}
                  </span>
                </button>
              )}
            </div>

            {/* Filter & Search Row */}
            <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    {
                      id: 'pending',
                      label: `রিভিশন বাকি (${toBengaliNumber(activeMistakes.length)})`,
                    },
                    {
                      id: 'mastered',
                      label: `আয়ত্ত হয়েছে (${toBengaliNumber(data.mistakes.length - activeMistakes.length)})`,
                    },
                    {
                      id: 'all',
                      label: `সব (${toBengaliNumber(data.mistakes.length)})`,
                    },
                  ] as const
                ).map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => setMistakeStatusFilter(st.id)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                      mistakeStatusFilter === st.id
                        ? 'bg-slate-900 text-white'
                        : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {st.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="ভুল নোটবুক বিষয় ফিল্টার"
                  data-testid="mistake-subject-filter"
                  value={mistakeSubjectFilter}
                  onChange={(e) => setMistakeSubjectFilter(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
                >
                  <option value="ALL">সব বিষয়</option>
                  {mistakeSubjects.map((sub) => (
                    <option key={sub} value={sub}>
                      {sub}
                    </option>
                  ))}
                </select>

                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    aria-label="ভুল প্রশ্ন খুঁজুন"
                    value={mistakeSearch}
                    onChange={(e) => setMistakeSearch(e.target.value)}
                    placeholder="প্রশ্ন বা অধ্যায় খুঁজুন..."
                    className="w-48 rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {filteredMistakes.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              নির্বাচিত ফিল্টারে কোনো ভুল প্রশ্ন নেই।
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
              {filteredMistakes.map((m) => {
                const isRepeated = repeatedMistakeIds.has(m.id);
                const bookJump = mistakeBookJumpMap.get(m.id) ?? null;

                return (
                  <article
                    key={m.id}
                    data-testid={`mistake-card-${m.id}`}
                    className="p-5 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        <span className="font-semibold text-slate-800">
                          {m.subject}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{m.chapter}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          রিভিশন: {m.nextReviewDate || todayIso}
                        </span>
                        {isRepeated && !m.mastered && (
                          <span className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                            <AlertTriangle className="h-3 w-3" />
                            বারবার ভুল (Red Alert)
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {bookJump && (
                          <button
                            type="button"
                            data-testid={`mistake-book-jump-btn-${m.id}`}
                            onClick={() =>
                              openSourceQuestionInReader({
                                bookId: bookJump.bookId,
                                pageNumber: bookJump.pageNumber,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-100"
                          >
                            <BookOpen className="h-3.5 w-3.5" />
                            <span>মূল বইয়ে দেখুন</span>
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => void toggleMistakeMastered(m.id)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                            m.mastered
                              ? 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                              : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          }`}
                        >
                          {m.mastered ? 'আবার রিভিশনে রাখুন' : 'আয়ত্ত হয়েছে'}
                        </button>

                        {confirmDeleteMistakeId === m.id ? (
                          <div className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-red-50 px-2 py-1">
                            <button
                              type="button"
                              data-testid={`confirm-delete-mistake-btn-${m.id}`}
                              onClick={async () => {
                                await deleteMistake(m.id);
                                setConfirmDeleteMistakeId(null);
                              }}
                              className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-red-700"
                            >
                              নিশ্চিত মুছুন
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteMistakeId(null)}
                              className="rounded px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-red-100"
                            >
                              বাতিল
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            data-testid={`delete-mistake-btn-${m.id}`}
                            aria-label={`ভুল প্রশ্ন মুছুন: ${m.questionStem}`}
                            onClick={() => setConfirmDeleteMistakeId(m.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>মুছুন</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <h3 className="text-sm font-semibold text-slate-900">
                      {m.questionStem}
                    </h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
                      <p className="rounded-lg border border-red-100 bg-red-50/40 px-3 py-2 text-red-800">
                        <span className="font-semibold">আপনার ভুল উত্তর:</span>{' '}
                        {m.userAnswer}
                      </p>
                      <p className="rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2 text-emerald-900">
                        <span className="font-semibold">সঠিক উত্তর:</span>{' '}
                        {m.correctAnswer}
                      </p>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      {m.reason}
                      {bookJump && (
                        <span className="ml-1.5 text-indigo-700 font-medium">
                          · ({bookJump.bookTitle}, পৃষ্ঠা {bookJump.pageNumber}
                          {bookJump.examTitle ? ` · ${bookJump.examTitle}` : ''})
                        </span>
                      )}
                    </p>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: SMART REVISION & ROI PRIORITY (100% Dynamic Book Coverage) */}
      {tab === 'revision' && (
        <div className="space-y-5">
          {/* Dynamic Per-Book Coverage Cards */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BookMarked className="h-4 w-4 text-blue-700" />
                <h2 className="text-sm font-bold text-slate-900">
                  বইভিত্তিক সিলেবাস অগ্রগতি ({toBengaliNumber(bookIntelligence.totalBooks)}টি বই — নতুন বই যোগ হলে স্বয়ংক্রিয়ভাবে যুক্ত হবে)
                </h2>
              </div>
              {revisionBookFilter !== 'ALL' && (
                <button
                  type="button"
                  onClick={() => setRevisionBookFilter('ALL')}
                  className="text-xs font-semibold text-blue-700 hover:underline"
                >
                  সব বই দেখুন
                </button>
              )}
            </div>

            {bookIntelligence.bookSummaries.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
                লাইব্রেরিতে কোনো বই নেই। 01. Book Library-তে বই যুক্ত করলে এখানে স্বয়ংক্রিয়ভাবে সিলেবাস অগ্রগতি দেখাবে।
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {bookIntelligence.bookSummaries.map((b) => {
                  const isSelected = revisionBookFilter === String(b.bookId);
                  return (
                    <button
                      key={b.bookId}
                      type="button"
                      data-testid={`revision-book-card-${b.bookId}`}
                      onClick={() =>
                        setRevisionBookFilter(isSelected ? 'ALL' : String(b.bookId))
                      }
                      className={`rounded-xl border p-4 text-left transition-colors ${
                        isSelected
                          ? 'border-blue-600 bg-blue-50/50 ring-1 ring-blue-600'
                          : 'border-slate-200 bg-white hover:border-blue-300'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-xs font-bold text-slate-900 line-clamp-2">
                          {b.bookTitle}
                        </h3>
                        <span className="font-mono text-xs font-bold tabular-nums text-blue-700 shrink-0">
                          {toBengaliNumber(b.coveragePct)}%
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {b.subject} · {toBengaliNumber(b.coveredUnits)}/
                        {toBengaliNumber(b.totalUnits)} অধ্যায়/পরীক্ষা
                        {b.totalParsedQuestions > 0
                          ? ` · ${toBengaliNumber(b.totalParsedQuestions)} প্রশ্ন`
                          : ''}
                      </p>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full bg-blue-700 transition-all"
                          style={{ width: `${b.coveragePct}%` }}
                        />
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11px]">
                        <span
                          className={
                            b.dueRevisionCount > 0
                              ? 'font-semibold text-amber-700'
                              : 'text-slate-500'
                          }
                        >
                          জরুরি রিভিশন: {toBengaliNumber(b.dueRevisionCount)}টি
                        </span>
                        <span className="text-blue-700 font-medium">
                          {isSelected ? 'ফিল্টার সক্রিয়' : 'ফিল্টার করুন →'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* ROI Priority + Memory Decay Revision List */}
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  স্মৃতিশক্তি মিটার ও নম্বর-ভিত্তিক অগ্রাধিকার তালিকা
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  দুর্বল অধ্যায়, পরীক্ষায় বেশি আসা টপিক এবং ১–৩–৭–১৫–৩০ দিনের স্পেসড রিপিটিশন অনুযায়ী সাজানো।
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="রিভিশন বই ফিল্টার"
                  value={revisionBookFilter}
                  onChange={(e) => setRevisionBookFilter(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 max-w-[200px]"
                >
                  <option value="ALL">
                    সব বই ({toBengaliNumber(data.books.length)}টি)
                  </option>
                  {data.books.map((b) => (
                    <option key={b.id} value={String(b.id)}>
                      {b.title}
                    </option>
                  ))}
                </select>

                {(
                  [
                    { id: 'all', label: 'সব' },
                    { id: 'due', label: 'আজ জরুরি' },
                    { id: 'high_impact', label: 'হাই-ইমপ্যাক্ট' },
                  ] as const
                ).map((pf) => (
                  <button
                    key={pf.id}
                    type="button"
                    onClick={() => setRevisionPriorityFilter(pf.id)}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                      revisionPriorityFilter === pf.id
                        ? 'bg-slate-900 text-white'
                        : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {pf.label}
                  </button>
                ))}
              </div>
            </div>

            {filteredRevisionUnits.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                নির্বাচিত ফিল্টারে কোনো রিভিশন অধ্যায় পাওয়া যায়নি।
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {filteredRevisionUnits.slice(0, 40).map((unit) => {
                  const alreadyInRoutine = scheduledTodayChapterSet.has(
                    unit.chapter.trim().toLowerCase()
                  );
                  const barColor =
                    unit.memoryStatus === 'strong'
                      ? 'bg-emerald-600'
                      : unit.memoryStatus === 'fading'
                        ? 'bg-amber-500'
                        : 'bg-red-600';
                  const textColor =
                    unit.memoryStatus === 'strong'
                      ? 'text-emerald-700'
                      : unit.memoryStatus === 'fading'
                        ? 'text-amber-700'
                        : 'text-red-700';

                  return (
                    <div
                      key={unit.id}
                      data-testid={`revision-unit-row-${unit.bookId}`}
                      className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between hover:bg-slate-50/70 transition-colors"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-900">
                            {unit.chapter}
                          </p>
                          <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-700">
                            ROI {toBengaliNumber(unit.roiPriorityScore)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                          <span className="font-medium text-slate-700">
                            {unit.bookTitle}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{unit.subject}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            পৃষ্ঠা {unit.pageNumber}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className={`font-medium ${textColor}`}>
                            {unit.priorityReason}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 shrink-0">
                        {/* Memory Strength Meter */}
                        <div className="w-36 space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-slate-500">স্মৃতিশক্তি</span>
                            <span className={`font-mono font-bold ${textColor}`}>
                              {toBengaliNumber(unit.memoryStrengthPct)}%
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full ${barColor}`}
                              style={{ width: `${unit.memoryStrengthPct}%` }}
                            />
                          </div>
                          <div className="text-[10px] text-slate-500 truncate">
                            {unit.nextIntervalLabel}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            openSourceQuestionInReader({
                              bookId: unit.bookId,
                              pageNumber: unit.pageNumber,
                              examId: unit.examId,
                            })
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <BookOpen className="h-3.5 w-3.5" />
                          <span>পড়ুন</span>
                        </button>

                        <button
                          type="button"
                          disabled={alreadyInRoutine}
                          onClick={async () => {
                            await addStudyTask({
                              title: `স্মার্ট রিভিশন: ${unit.chapter} (${unit.bookTitle})`,
                              subject: unit.subject,
                              chapter: unit.chapter,
                              taskType: 'revision',
                              scheduledDate: todayIso,
                              durationMinutes: 30,
                            });
                            setRoutineNotice(
                              `“${unit.chapter}” আজকের রুটিনে যুক্ত করা হয়েছে।`
                            );
                            setTab('routine');
                          }}
                          className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                            alreadyInRoutine
                              ? 'border border-emerald-200 bg-emerald-50 text-emerald-700 cursor-default'
                              : 'border border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100'
                          }`}
                        >
                          {alreadyInRoutine ? (
                            <>
                              <Check className="h-3.5 w-3.5" />
                              <span>রুটিনে আছে</span>
                            </>
                          ) : (
                            <>
                              <CalendarClock className="h-3.5 w-3.5" />
                              <span>রুটিনে নিন</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 5-Question Zero-API Verification Quiz Modal */}
      {quizTask && (
        <StudyTaskVerificationQuizModal
          task={quizTask}
          books={data.books}
          questions={data.questions}
          onClose={() => setQuizTask(null)}
          onQuizCompleted={async ({
            passed,
            correctCount,
            totalCount,
            wrongMistakes,
          }) => {
            if (wrongMistakes.length > 0) {
              await addMistakeItems(wrongMistakes);
            }
            if (passed && !quizTask.completed) {
              await toggleStudyTask(quizTask.id);
              updatePlannerMeta((prev) => ({
                ...prev,
                focusMinutesByDate: {
                  ...prev.focusMinutesByDate,
                  [todayIso]:
                    (prev.focusMinutesByDate[todayIso] ?? 0) +
                    Math.min(15, quizTask.durationMinutes),
                },
              }));
            }
            setRoutineNotice(
              passed
                ? `যাচাই কুইজে ${toBengaliNumber(correctCount)}/${toBengaliNumber(totalCount)} পেয়ে “${quizTask.title}” সম্পন্ন হয়েছে!`
                : `যাচাই কুইজে ${toBengaliNumber(correctCount)}/${toBengaliNumber(totalCount)} — ভুল প্রশ্নগুলো ভুল নোটবুকে যুক্ত হয়েছে।`
            );
          }}
        />
      )}
    </div>
  );
}
