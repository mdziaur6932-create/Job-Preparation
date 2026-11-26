import type {
  Book,
  CurrentGkItem,
  ExamAttempt,
  MistakeItem,
  StudyTask,
} from '../types/system';
import {
  analyzeBookOrSeriesQuestions,
  type BookIntelligenceReport,
} from './book-series-and-topic-analyzer';
import { buildQuestionExamReferenceIndex } from './question-exam-references';

export type PlannerStrategyMode =
  | 'unset'
  | 'foundation'
  | 'revision_mock'
  | 'rapid_fire';

export interface ExamTargetConfig {
  examName: string;
  targetDate: string; // YYYY-MM-DD or ''
  dailyHours: number; // e.g., 2, 3, 4
  focusBookScope: 'all' | number[]; // 'all' automatically includes any future added books
}

export interface ExamCountdownStrategy {
  mode: PlannerStrategyMode;
  daysRemaining: number | null;
  label: string;
  badgeText: string;
  guidance: string;
}

export interface BookCoverageSummary {
  bookId: number;
  bookTitle: string;
  subject: string;
  totalUnits: number;
  coveredUnits: number;
  coveragePct: number;
  weakUnitsCount: number;
  dueRevisionCount: number;
  totalParsedQuestions: number;
  totalExamsDetected: number;
}

export interface SmartRevisionUnit {
  id: string;
  bookId: number;
  bookTitle: string;
  subject: string;
  chapter: string;
  pageNumber: number;
  examId: string | null;
  examFrequency: number; // how many times this topic/exam appears across books
  weakScore: number; // 0-100 derived from attempts & mistakes
  mistakeCount: number;
  memoryStrengthPct: number; // 15-100 Spaced Repetition score
  memoryStatus: 'strong' | 'fading' | 'critical';
  dueToday: boolean;
  daysSinceLastTouch: number | null;
  nextIntervalLabel: string;
  roiPriorityScore: number; // 0-100 combined score (frequency + weakness + decay)
  priorityReason: string;
  isCovered: boolean;
}

export interface DynamicBookIntelligence {
  totalBooks: number;
  bookSummaries: BookCoverageSummary[];
  revisionUnits: SmartRevisionUnit[];
  dueTodayCount: number;
  highImpactUnits: SmartRevisionUnit[];
}

export interface GeneratedRoutineTaskInput {
  title: string;
  subject: string;
  chapter: string;
  taskType: StudyTask['taskType'];
  scheduledDate: string;
  durationMinutes: number;
}

export interface RescheduleAssignment {
  taskId: number;
  fromDate: string;
  toDate: string;
}

export interface StudyStreakMetrics {
  streakDays: number;
  todayCompletedMinutes: number;
  todayTargetMinutes: number;
  todayCompletedTasks: number;
  todayTotalTasks: number;
  overdueCount: number;
}

export type RoutineGenerationSlot =
  | 'slot_30'
  | 'slot_60'
  | 'slot_120'
  | 'week_7';

const DAY_MS = 24 * 60 * 60 * 1000;

export function getTodayIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const base = parseIsoDateLocal(isoDate);
  if (!base) return isoDate;
  const next = new Date(base.getTime() + days * DAY_MS);
  return getTodayIsoDate(next);
}

export function diffDaysBetweenIso(fromIso: string, toIso: string): number {
  const a = parseIsoDateLocal(fromIso);
  const b = parseIsoDateLocal(toIso);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function parseIsoDateLocal(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const d = new Date(year, month, day, 12, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeMatchKey(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[‘’'"“”`.,?!;ঃ:()[\]{}।\-–—/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeExamCountdownStrategy(
  targetDateIso: string,
  todayIso: string = getTodayIsoDate()
): ExamCountdownStrategy {
  if (!targetDateIso || !parseIsoDateLocal(targetDateIso)) {
    return {
      mode: 'unset',
      daysRemaining: null,
      label: 'টার্গেট তারিখ নির্ধারিত নয়',
      badgeText: 'নিয়মিত প্রস্তুতি মোড',
      guidance:
        'আপনার আসন্ন চাকরির পরীক্ষার তারিখ সেট করুন—বাকি দিনের ওপর ভিত্তি করে প্ল্যানার নিজেই প্রস্তুতি কৌশল বদলে নেবে।',
    };
  }

  const daysRemaining = diffDaysBetweenIso(todayIso, targetDateIso);

  if (daysRemaining < 0) {
    return {
      mode: 'foundation',
      daysRemaining: 0,
      label: 'পরীক্ষার তারিখ অতিক্রান্ত',
      badgeText: 'নতুন লক্ষ্য সেট করুন',
      guidance:
        'এই পরীক্ষার তারিখ শেষ হয়ে গেছে। পরবর্তী চাকরির পরীক্ষার নতুন তারিখ সেট করে আবার রুটিন শুরু করুন।',
    };
  }

  if (daysRemaining <= 3) {
    return {
      mode: 'rapid_fire',
      daysRemaining,
      label: 'ফাইনাল র‍্যাপিড রিভিশন মোড',
      badgeText: `শেষ ${daysRemaining} দিন · র‍্যাপিড রিভিশন`,
      guidance:
        'নতুন অধ্যায় নয়—শুধু ভুল নোটবুক, দুর্বল টপিক ও সাম্প্রতিক GK দ্রুত ঝালাই করুন।',
    };
  }

  if (daysRemaining <= 15) {
    return {
      mode: 'revision_mock',
      daysRemaining,
      label: 'রিভিশন ও মডেল টেস্ট মোড',
      badgeText: `${daysRemaining} দিন বাকি · মক ও রিভিশন`,
      guidance:
        'প্রতিদিন অন্তত ১টি পূর্ণাঙ্গ মডেল টেস্ট, ভুল সংশোধন ও হাই-ফ্রিকোয়েন্সি বিগত প্রশ্ন রিভিশনে জোর দিন।',
    };
  }

  return {
    mode: 'foundation',
    daysRemaining,
    label: 'ভিত্তি গড়া ও অধ্যায় সমাপ্তি মোড',
    badgeText: `${daysRemaining} দিন বাকি · ফাউন্ডেশন`,
    guidance:
      'নতুন অধ্যায় শেষ করা, টপিকভিত্তিক অনুশীলন ও নিয়মিত স্পেসড-রিভিশন একসাথে চালিয়ে যান।',
  };
}

/**
 * Computes Spaced Repetition memory strength (15%–100%) using 1-3-7-15-30 day intervals.
 */
export function computeMemoryStrength(params: {
  daysSinceLastTouch: number | null;
  completedTouches: number;
  isWeak: boolean;
  mistakeCount: number;
}): {
  memoryStrengthPct: number;
  memoryStatus: 'strong' | 'fading' | 'critical';
  dueToday: boolean;
  nextIntervalLabel: string;
} {
  const { daysSinceLastTouch, completedTouches, isWeak, mistakeCount } = params;

  // Never studied yet
  if (daysSinceLastTouch === null || completedTouches === 0) {
    const base = isWeak || mistakeCount > 0 ? 25 : 40;
    return {
      memoryStrengthPct: base,
      memoryStatus: isWeak || mistakeCount > 0 ? 'critical' : 'fading',
      dueToday: isWeak || mistakeCount > 0,
      nextIntervalLabel: isWeak || mistakeCount > 0 ? 'আজই শুরু জরুরি' : 'এখনো পড়া হয়নি',
    };
  }

  const intervals = [1, 3, 7, 15, 30];
  const stageIdx = Math.min(intervals.length - 1, Math.max(0, completedTouches - 1));
  const targetInterval = intervals[stageIdx];
  const safeDays = Math.max(0, daysSinceLastTouch);

  // Decay faster if topic has active mistakes or weak flag
  const penalty = (isWeak ? 14 : 0) + Math.min(20, mistakeCount * 8);
  const ratio = targetInterval > 0 ? safeDays / targetInterval : 1;
  const rawStrength = Math.round(100 - ratio * 55 - penalty);
  const memoryStrengthPct = Math.max(15, Math.min(100, rawStrength));

  const dueToday = safeDays >= targetInterval || memoryStrengthPct < 55;
  const memoryStatus: 'strong' | 'fading' | 'critical' =
    memoryStrengthPct >= 75
      ? 'strong'
      : memoryStrengthPct >= 48
        ? 'fading'
        : 'critical';

  const nextIntervalLabel = dueToday
    ? `আজ রিভিশন জরুরি (${targetInterval} দিনের চক্র)`
    : `${Math.max(1, targetInterval - safeDays)} দিন পর রিভিশন`;

  return {
    memoryStrengthPct,
    memoryStatus,
    dueToday,
    nextIntervalLabel,
  };
}

/**
 * Dynamically indexes ALL books currently in WorkspaceData (6 books now or 30 books in future).
 * Never caches hardcoded book IDs—adding a book in Book Library immediately feeds into
 * book coverage, ROI priority topics, memory decay, and routine generation.
 */
export function buildDynamicBookIntelligence(params: {
  books: Book[];
  attempts: ExamAttempt[];
  mistakes: MistakeItem[];
  studyTasks: StudyTask[];
  todayIso?: string;
}): DynamicBookIntelligence {
  const { books, attempts, mistakes, studyTasks } = params;
  const todayIso = params.todayIso ?? getTodayIsoDate();

  const weakTopicsNorm = new Set(
    attempts.flatMap((a) => a.weakTopics.map((t) => normalizeMatchKey(t))).filter(Boolean)
  );

  // Track mistake counts by chapter & subject
  const mistakesByKey = new Map<string, number>();
  for (const m of mistakes) {
    if (m.mastered) continue;
    const chKey = normalizeMatchKey(m.chapter);
    const subKey = normalizeMatchKey(m.subject);
    if (chKey) mistakesByKey.set(chKey, (mistakesByKey.get(chKey) ?? 0) + 1);
    if (subKey) mistakesByKey.set(`sub:${subKey}`, (mistakesByKey.get(`sub:${subKey}`) ?? 0) + 1);
  }

  // Track completed task touches and last completion date per chapter/title
  const completedTasks = studyTasks.filter((t) => t.completed);

  // Run lightweight book-level exam/topic analysis across all books dynamically
  const reportsByBookId = new Map<number, BookIntelligenceReport>();
  const globalTopicFreq = new Map<string, number>();

  for (const book of books) {
    const report = analyzeBookOrSeriesQuestions([book], book.title);
    reportsByBookId.set(book.id, report);
    for (const bucket of report.topicBuckets) {
      const k = normalizeMatchKey(bucket.topic);
      if (k) {
        globalTopicFreq.set(k, (globalTopicFreq.get(k) ?? 0) + bucket.totalCount);
      }
    }
  }

  const bookSummaries: BookCoverageSummary[] = [];
  const allUnits: SmartRevisionUnit[] = [];

  for (const book of books) {
    const report = reportsByBookId.get(book.id);
    const exams = report?.exams ?? [];
    const useExamUnits = exams.length >= 2;

    // Build concise, meaningful study units per book (detected exams if Job Solution, else grouped chapters)
    const rawUnits: Array<{
      id: string;
      chapter: string;
      pageNumber: number;
      examId: string | null;
      subject: string;
      examFrequency: number;
    }> = [];

    if (useExamUnits) {
      for (const ex of exams.slice(0, 40)) {
        const label = [ex.institution || ex.examTitle, ex.postName]
          .filter(Boolean)
          .join(' — ');
        rawUnits.push({
          id: `book-${book.id}-exam-${ex.examId}`,
          chapter: label || ex.examTitle,
          pageNumber: Math.max(1, ex.startPage),
          examId: ex.examId,
          subject: book.subject || 'সমন্বিত',
          examFrequency: Math.max(1, ex.questionCount),
        });
      }
    } else {
      // Group chunks by distinct chapter title so large PDFs don't explode into 200 duplicate rows
      const seenChapters = new Set<string>();
      for (const ch of book.chunks) {
        const chLabel = (ch.chapter || `পৃষ্ঠা ${ch.pageNumber}`).trim();
        const key = normalizeMatchKey(chLabel);
        if (seenChapters.has(key) && rawUnits.length >= 12) continue;
        seenChapters.add(key);

        // Estimate topic frequency from global parsed clusters if chapter matches a cluster label
        let freq = 1;
        for (const [topicKey, count] of globalTopicFreq.entries()) {
          if (key.includes(topicKey) || topicKey.includes(key)) {
            freq = Math.max(freq, count);
          }
        }

        rawUnits.push({
          id: `book-${book.id}-chunk-${ch.id}`,
          chapter: chLabel,
          pageNumber: Math.max(1, ch.pageNumber),
          examId: null,
          subject: book.subject || 'সাধারণ',
          examFrequency: freq,
        });
        if (rawUnits.length >= 30) break;
      }
    }

    let coveredUnits = 0;
    let weakUnitsCount = 0;
    let dueRevisionCount = 0;

    for (const unit of rawUnits) {
      const unitNorm = normalizeMatchKey(unit.chapter);
      const bookNorm = normalizeMatchKey(book.title);
      const subNorm = normalizeMatchKey(unit.subject);

      const isWeak =
        weakTopicsNorm.has(unitNorm) ||
        Array.from(weakTopicsNorm).some(
          (w) => w.length >= 4 && (unitNorm.includes(w) || w.includes(unitNorm))
        );

      const directMistakes = mistakesByKey.get(unitNorm) ?? 0;
      const subjectMistakes = mistakesByKey.get(`sub:${subNorm}`) ?? 0;
      const mistakeCount = directMistakes > 0 ? directMistakes : Math.min(2, subjectMistakes);

      // Find completed study tasks or exam attempts touching this unit
      let touches = 0;
      let latestTouchIso: string | null = null;

      for (const t of completedTasks) {
        const tCh = normalizeMatchKey(t.chapter);
        const tTitle = normalizeMatchKey(t.title);
        const matched =
          (tCh.length >= 4 && (unitNorm.includes(tCh) || tCh.includes(unitNorm))) ||
          (unitNorm.length >= 5 && tTitle.includes(unitNorm)) ||
          (bookNorm.length >= 5 && tTitle.includes(bookNorm));
        if (matched) {
          touches += 1;
          if (!latestTouchIso || t.scheduledDate > latestTouchIso) {
            latestTouchIso = t.scheduledDate;
          }
        }
      }

      for (const att of attempts) {
        const touchedInEval = att.evaluations.some((ev) => {
          const evBook = normalizeMatchKey(ev.bookTitle);
          const evCh = normalizeMatchKey(ev.chapter);
          return (
            evBook === bookNorm &&
            (ev.pageNumber === unit.pageNumber ||
              (evCh.length >= 4 && (unitNorm.includes(evCh) || evCh.includes(unitNorm))))
          );
        });
        if (touchedInEval) {
          touches += 1;
          const attDate = (att.submittedAt || '').slice(0, 10);
          if (attDate && (!latestTouchIso || attDate > latestTouchIso)) {
            latestTouchIso = attDate;
          }
        }
      }

      const isCovered = touches > 0;
      if (isCovered) coveredUnits += 1;
      if (isWeak || directMistakes > 0) weakUnitsCount += 1;

      const daysSinceLastTouch = latestTouchIso
        ? Math.max(0, diffDaysBetweenIso(latestTouchIso, todayIso))
        : null;

      const mem = computeMemoryStrength({
        daysSinceLastTouch,
        completedTouches: touches,
        isWeak,
        mistakeCount: directMistakes,
      });

      if (mem.dueToday) dueRevisionCount += 1;

      const weakScore = Math.min(
        100,
        (isWeak ? 55 : 0) + directMistakes * 20 + Math.min(15, subjectMistakes * 5)
      );

      // ROI Score: combines weakness (45%), exam frequency (30%), and memory decay (25%)
      const freqNormalized = Math.min(100, Math.round(Math.log2(unit.examFrequency + 1) * 28));
      const decayUrgency = 100 - mem.memoryStrengthPct;
      const roiPriorityScore = Math.min(
        100,
        Math.round(weakScore * 0.45 + freqNormalized * 0.3 + decayUrgency * 0.25)
      );

      let priorityReason = 'নিয়মিত সিলেবাস রিভিশন';
      if (isWeak && directMistakes > 0) {
        priorityReason = `দুর্বল অধ্যায় ও ${directMistakes}টি ভুল প্রশ্ন — সবার আগে পড়ুন`;
      } else if (isWeak) {
        priorityReason = 'পরীক্ষায় দুর্বল অধ্যায় হিসেবে চিহ্নিত';
      } else if (directMistakes > 0) {
        priorityReason = `ভুল নোটবুকে ${directMistakes}টি প্রশ্ন বাকি`;
      } else if (unit.examFrequency >= 10) {
        priorityReason = `হাই-ফ্রিকোয়েন্সি (${unit.examFrequency}টি বিগত প্রশ্ন)`;
      } else if (mem.dueToday && isCovered) {
        priorityReason = 'স্পেসড রিভিশনের সময় হয়েছে (ভুলে যাওয়ার ঝুঁকি)';
      }

      allUnits.push({
        id: unit.id,
        bookId: book.id,
        bookTitle: book.title,
        subject: unit.subject,
        chapter: unit.chapter,
        pageNumber: unit.pageNumber,
        examId: unit.examId,
        examFrequency: unit.examFrequency,
        weakScore,
        mistakeCount: directMistakes,
        memoryStrengthPct: mem.memoryStrengthPct,
        memoryStatus: mem.memoryStatus,
        dueToday: mem.dueToday,
        daysSinceLastTouch,
        nextIntervalLabel: mem.nextIntervalLabel,
        roiPriorityScore,
        priorityReason,
        isCovered,
      });
    }

    const totalUnits = rawUnits.length;
    const coveragePct =
      totalUnits > 0 ? Math.round((coveredUnits / totalUnits) * 100) : 0;

    bookSummaries.push({
      bookId: book.id,
      bookTitle: book.title,
      subject: book.subject || 'সাধারণ',
      totalUnits,
      coveredUnits,
      coveragePct,
      weakUnitsCount,
      dueRevisionCount,
      totalParsedQuestions: report?.totalQuestions ?? 0,
      totalExamsDetected: exams.length,
    });
  }

  // Sort units by ROI Priority descending, then dueToday first
  allUnits.sort((a, b) => {
    if (b.roiPriorityScore !== a.roiPriorityScore) {
      return b.roiPriorityScore - a.roiPriorityScore;
    }
    if (a.dueToday !== b.dueToday) return a.dueToday ? -1 : 1;
    return b.examFrequency - a.examFrequency;
  });

  return {
    totalBooks: books.length,
    bookSummaries,
    revisionUnits: allUnits,
    dueTodayCount: allUnits.filter((u) => u.dueToday).length,
    highImpactUnits: allUnits.slice(0, 8),
  };
}

/**
 * Generates zero-API, high-ROI study routine tasks dynamically from ALL active books
 * (or chosen subset), Mistake Notebook, and Current GK—strictly avoiding duplicates.
 */
export function generateSmartRoutineTasks(params: {
  books: Book[];
  attempts: ExamAttempt[];
  mistakes: MistakeItem[];
  gkItems: CurrentGkItem[];
  existingTasks: StudyTask[];
  slot: RoutineGenerationSlot;
  dailyMinutes: number;
  strategyMode: PlannerStrategyMode;
  focusBookScope: 'all' | number[];
  todayIso?: string;
}): GeneratedRoutineTaskInput[] {
  const {
    books,
    attempts,
    mistakes,
    gkItems,
    existingTasks,
    slot,
    strategyMode,
    focusBookScope,
  } = params;

  const todayIso = params.todayIso ?? getTodayIsoDate();
  const safeDailyMinutes = Math.max(30, Math.min(480, Math.round(params.dailyMinutes || 120)));

  const scopedBooks =
    focusBookScope === 'all'
      ? books
      : books.filter((b) => focusBookScope.includes(b.id));
  const activeBooks = scopedBooks.length > 0 ? scopedBooks : books;

  const intel = buildDynamicBookIntelligence({
    books: activeBooks,
    attempts,
    mistakes,
    studyTasks: existingTasks,
    todayIso,
  });

  const activeMistakes = mistakes.filter((m) => !m.mastered);
  const activeGk = gkItems.filter((g) => !g.isArchived);

  // Deduplication set: (date + normalized title)
  const existingKeys = new Set(
    existingTasks.map((t) => `${t.scheduledDate}|${normalizeMatchKey(t.title)}`)
  );

  const generated: GeneratedRoutineTaskInput[] = [];
  const pushIfUnique = (task: GeneratedRoutineTaskInput): boolean => {
    const key = `${task.scheduledDate}|${normalizeMatchKey(task.title)}`;
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    generated.push(task);
    return true;
  };

  // Round-robin units across distinct books so newly added books always appear immediately!
  const unitsByBook = new Map<number, SmartRevisionUnit[]>();
  for (const unit of intel.revisionUnits) {
    const list = unitsByBook.get(unit.bookId) ?? [];
    list.push(unit);
    unitsByBook.set(unit.bookId, list);
  }
  const bookOrder = [...activeBooks]
    .sort((a, b) => b.id - a.id) // newest books first so freshly uploaded books are guaranteed visibility
    .map((b) => b.id);

  const interleavedUnits: SmartRevisionUnit[] = [];
  let cursor = 0;
  let addedAny = true;
  while (addedAny && interleavedUnits.length < 40) {
    addedAny = false;
    for (const bookId of bookOrder) {
      const list = unitsByBook.get(bookId);
      if (list && list[cursor]) {
        interleavedUnits.push(list[cursor]);
        addedAny = true;
      }
    }
    cursor += 1;
  }

  // Sort top weak/due units first while keeping newest book represented
  const prioritizedUnits = [
    ...intel.revisionUnits.filter((u) => u.weakScore > 0).slice(0, 3),
    ...interleavedUnits,
  ].filter((unit, idx, arr) => arr.findIndex((x) => x.id === unit.id) === idx);

  let unitIdx = 0;
  const pickNextUnit = (): SmartRevisionUnit | null => {
    if (prioritizedUnits.length === 0) return null;
    const u = prioritizedUnits[unitIdx % prioritizedUnits.length];
    unitIdx += 1;
    return u;
  };

  if (slot !== 'week_7') {
    const slotBudget =
      slot === 'slot_30' ? 30 : slot === 'slot_60' ? 60 : 120;
    let remaining = slotBudget;

    // 1. Always start with Mistake Notebook revision if pending mistakes exist
    if (activeMistakes.length > 0 && remaining >= 10) {
      const dur = slotBudget === 30 ? 10 : slotBudget === 60 ? 15 : 25;
      const topSubject = activeMistakes[0].subject || 'সমন্বিত';
      pushIfUnique({
        title: `ভুল নোটবুক সংশোধন — ${topSubject} (${Math.min(10, activeMistakes.length)}টি প্রশ্ন)`,
        subject: topSubject,
        chapter: activeMistakes[0].chapter || 'ভুল নোটবুক',
        taskType: 'practice',
        scheduledDate: todayIso,
        durationMinutes: dur,
      });
      remaining -= dur;
    }

    // 2. High-impact book reading/revision unit(s)
    const maxBookTasks = slotBudget === 120 ? 2 : 1;
    for (let i = 0; i < maxBookTasks && remaining >= 10; i += 1) {
      const unit = pickNextUnit();
      if (!unit) break;
      const dur =
        slotBudget === 30
          ? Math.min(remaining, 10)
          : slotBudget === 60
            ? Math.min(remaining, 30)
            : Math.min(remaining, 40);
      const taskType: StudyTask['taskType'] =
        strategyMode === 'rapid_fire' || unit.isCovered ? 'revision' : 'reading';
      const prefix = taskType === 'revision' ? 'রিভিশন' : 'অধ্যায় পড়া';
      pushIfUnique({
        title: `${prefix}: ${unit.chapter} (${unit.bookTitle})`,
        subject: unit.subject,
        chapter: unit.chapter,
        taskType,
        scheduledDate: todayIso,
        durationMinutes: dur,
      });
      remaining -= dur;
    }

    // 3. Current GK quick drill if available
    if (activeGk.length > 0 && remaining >= 10) {
      const dur = Math.min(remaining, slotBudget === 120 ? 15 : 10);
      pushIfUnique({
        title: `সাম্প্রতিক সাধারণ জ্ঞান (Current GK) — ${activeGk[0].title.slice(0, 45)}`,
        subject: 'সাম্প্রতিক সাধারণ জ্ঞান',
        chapter: activeGk[0].category || 'Current GK',
        taskType: 'revision',
        scheduledDate: todayIso,
        durationMinutes: dur,
      });
      remaining -= dur;
    }

    // 4. Mini model test if budget permits (especially in revision_mock or 120m)
    if (remaining >= 15) {
      const unit = pickNextUnit();
      pushIfUnique({
        title:
          strategyMode === 'revision_mock'
            ? `মডেল টেস্ট অনুশীলন (${unit?.subject || 'সমন্বিত'})`
            : `অনুশীলন ও ৫ প্রশ্নের যাচাই কুইজ (${unit?.chapter || 'মিশ্র টপিক'})`,
        subject: unit?.subject || 'সমন্বিত',
        chapter: unit?.chapter || 'মডেল টেস্ট',
        taskType: strategyMode === 'revision_mock' ? 'exam' : 'practice',
        scheduledDate: todayIso,
        durationMinutes: Math.max(15, remaining),
      });
    }

    return generated;
  }

  // 7-Day Balanced Auto-Routine respecting Exam Countdown Strategy & ALL Books
  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const dateIso = addDaysToIsoDate(todayIso, dayOffset);
    let dayRemaining = safeDailyMinutes;

    // Task A: Core book reading/revision from dynamic book rotation
    const unitA = pickNextUnit();
    if (unitA && dayRemaining >= 30) {
      const dur = Math.min(60, Math.max(30, Math.round(safeDailyMinutes * 0.45)));
      const taskType: StudyTask['taskType'] =
        strategyMode === 'rapid_fire' || unitA.isCovered ? 'revision' : 'reading';
      pushIfUnique({
        title: `${taskType === 'revision' ? 'স্মার্ট রিভিশন' : 'অধ্যায় পড়া'}: ${unitA.chapter} (${unitA.bookTitle})`,
        subject: unitA.subject,
        chapter: unitA.chapter,
        taskType,
        scheduledDate: dateIso,
        durationMinutes: dur,
      });
      dayRemaining -= dur;
    }

    // Task B: Alternating Mistake Notebook / Second Book Unit / Model Test based on strategy
    if (dayOffset % 2 === 0 && activeMistakes.length > 0 && dayRemaining >= 20) {
      const m = activeMistakes[dayOffset % activeMistakes.length];
      const dur = Math.min(30, dayRemaining);
      pushIfUnique({
        title: `ভুল নোটবুক পুনরাবৃত্তি — ${m.subject}`,
        subject: m.subject,
        chapter: m.chapter,
        taskType: 'practice',
        scheduledDate: dateIso,
        durationMinutes: dur,
      });
      dayRemaining -= dur;
    } else if (dayRemaining >= 25) {
      const unitB = pickNextUnit();
      if (unitB) {
        const dur = Math.min(40, dayRemaining);
        pushIfUnique({
          title: `রিভিশন ও প্রশ্ন সমাধান: ${unitB.chapter} (${unitB.bookTitle})`,
          subject: unitB.subject,
          chapter: unitB.chapter,
          taskType: 'revision',
          scheduledDate: dateIso,
          durationMinutes: dur,
        });
        dayRemaining -= dur;
      }
    }

    // Task C: Model test on Day 2, 4, 6 (or every day in revision_mock) / Current GK on others
    if (
      dayRemaining >= 20 &&
      (strategyMode === 'revision_mock' || dayOffset === 2 || dayOffset === 5 || dayOffset === 6)
    ) {
      const dur = Math.min(45, Math.max(20, dayRemaining));
      pushIfUnique({
        title: `মডেল টেস্ট ও মূল্যায়ন — দিন ${dayOffset + 1}`,
        subject: 'সমন্বিত (চাকরির পরীক্ষা)',
        chapter: 'পূর্ণাঙ্গ অনুশীলন',
        taskType: 'exam',
        scheduledDate: dateIso,
        durationMinutes: dur,
      });
    } else if (dayRemaining >= 15 && activeGk.length > 0) {
      const gk = activeGk[dayOffset % activeGk.length];
      pushIfUnique({
        title: `সাম্প্রতিক GK ঝালাই: ${gk.title.slice(0, 48)}`,
        subject: 'সাম্প্রতিক সাধারণ জ্ঞান',
        chapter: gk.category || 'Current GK',
        taskType: 'revision',
        scheduledDate: dateIso,
        durationMinutes: Math.min(20, dayRemaining),
      });
    }
  }

  return generated;
}

/**
 * Redistributes overdue incomplete tasks onto today + upcoming days without overloading
 * the candidate's daily study minute cap.
 */
export function computeSmartReschedulePlan(params: {
  tasks: StudyTask[];
  dailyMinutesCap: number;
  todayIso?: string;
}): RescheduleAssignment[] {
  const { tasks } = params;
  const todayIso = params.todayIso ?? getTodayIsoDate();
  const cap = Math.max(30, Math.round(params.dailyMinutesCap || 120));

  const overdue = tasks
    .filter((t) => !t.completed && t.scheduledDate < todayIso)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));

  if (overdue.length === 0) return [];

  // Track already-scheduled minutes for today and future days
  const loadByDate = new Map<string, number>();
  for (const t of tasks) {
    if (!t.completed && t.scheduledDate >= todayIso) {
      loadByDate.set(
        t.scheduledDate,
        (loadByDate.get(t.scheduledDate) ?? 0) + Math.max(10, t.durationMinutes)
      );
    }
  }

  const assignments: RescheduleAssignment[] = [];
  for (const task of overdue) {
    const dur = Math.max(10, task.durationMinutes);
    let chosenDate = todayIso;

    for (let offset = 0; offset < 14; offset += 1) {
      const candidate = addDaysToIsoDate(todayIso, offset);
      const currentLoad = loadByDate.get(candidate) ?? 0;
      if (currentLoad + dur <= cap || (offset === 13)) {
        chosenDate = candidate;
        loadByDate.set(candidate, currentLoad + dur);
        break;
      }
    }

    assignments.push({
      taskId: task.id,
      fromDate: task.scheduledDate,
      toDate: chosenDate,
    });
  }

  return assignments;
}

export function computeStudyStreakAndTodayMinutes(params: {
  tasks: StudyTask[];
  focusMinutesByDate: Record<string, number>;
  todayIso?: string;
  dailyTargetMinutes?: number;
}): StudyStreakMetrics {
  const { tasks, focusMinutesByDate } = params;
  const todayIso = params.todayIso ?? getTodayIsoDate();

  const todayTasks = tasks.filter((t) => t.scheduledDate === todayIso);
  const todayCompletedTasks = todayTasks.filter((t) => t.completed).length;
  const todayCompletedTaskMinutes = todayTasks
    .filter((t) => t.completed)
    .reduce((sum, t) => sum + Math.max(0, t.durationMinutes), 0);

  const todayLoggedFocusMinutes = Math.max(0, Math.round(focusMinutesByDate[todayIso] ?? 0));
  const todayCompletedMinutes = Math.max(todayCompletedTaskMinutes, todayLoggedFocusMinutes);

  const todayScheduledMinutes = todayTasks.reduce(
    (sum, t) => sum + Math.max(0, t.durationMinutes),
    0
  );
  const todayTargetMinutes =
    todayScheduledMinutes > 0
      ? todayScheduledMinutes
      : Math.max(30, params.dailyTargetMinutes ?? 120);

  const overdueCount = tasks.filter(
    (t) => !t.completed && t.scheduledDate < todayIso
  ).length;

  // Build active dates set (any day with >= 1 completed task OR >= 5 logged focus minutes)
  const activeDates = new Set<string>();
  for (const t of tasks) {
    if (t.completed && t.scheduledDate) {
      activeDates.add(t.scheduledDate);
    }
  }
  for (const [dateKey, mins] of Object.entries(focusMinutesByDate)) {
    if (mins >= 5) activeDates.add(dateKey);
  }

  // Count consecutive streak ending today (or yesterday if today hasn't started yet)
  let streakDays = 0;
  let cursor = activeDates.has(todayIso)
    ? todayIso
    : addDaysToIsoDate(todayIso, -1);

  while (activeDates.has(cursor) && streakDays < 365) {
    streakDays += 1;
    cursor = addDaysToIsoDate(cursor, -1);
  }

  return {
    streakDays,
    todayCompletedMinutes,
    todayTargetMinutes,
    todayCompletedTasks,
    todayTotalTasks: todayTasks.length,
    overdueCount,
  };
}

export function detectRepeatedMistakeIds(mistakes: MistakeItem[]): Set<number> {
  const stemCounts = new Map<string, number>();
  for (const m of mistakes) {
    const key = normalizeMatchKey(m.questionStem);
    if (!key) continue;
    stemCounts.set(key, (stemCounts.get(key) ?? 0) + 1);
  }

  const repeatedIds = new Set<number>();
  for (const m of mistakes) {
    const key = normalizeMatchKey(m.questionStem);
    if (m.reviewCount >= 2 || (key && (stemCounts.get(key) ?? 0) >= 2)) {
      repeatedIds.add(m.id);
    }
  }
  return repeatedIds;
}

export function resolveTaskBookJumpTarget(
  task: StudyTask,
  books: Book[]
): { bookId: number; pageNumber: number; bookTitle: string } | null {
  if (books.length === 0) return null;
  const titleNorm = normalizeMatchKey(task.title);
  const chapterNorm = normalizeMatchKey(task.chapter);
  const subjectNorm = normalizeMatchKey(task.subject);

  // 1. Direct match by book title mentioned in task title
  for (const book of books) {
    const bNorm = normalizeMatchKey(book.title);
    if (bNorm.length >= 4 && titleNorm.includes(bNorm)) {
      const matchedChunk =
        book.chunks.find((c) => {
          const cNorm = normalizeMatchKey(c.chapter);
          return cNorm.length >= 3 && (chapterNorm.includes(cNorm) || cNorm.includes(chapterNorm));
        }) ?? book.chunks[0];
      return {
        bookId: book.id,
        pageNumber: matchedChunk?.pageNumber ?? 1,
        bookTitle: book.title,
      };
    }
  }

  // 2. Match by chapter name across any book
  if (chapterNorm.length >= 3) {
    for (const book of books) {
      const matchedChunk = book.chunks.find((c) => {
        const cNorm = normalizeMatchKey(c.chapter);
        return (
          cNorm.length >= 3 &&
          (chapterNorm.includes(cNorm) || cNorm.includes(chapterNorm))
        );
      });
      if (matchedChunk) {
        return {
          bookId: book.id,
          pageNumber: matchedChunk.pageNumber,
          bookTitle: book.title,
        };
      }
    }
  }

  // 3. Fallback by subject
  if (subjectNorm.length >= 3) {
    const subBook = books.find((b) =>
      normalizeMatchKey(b.subject).includes(subjectNorm) ||
      subjectNorm.includes(normalizeMatchKey(b.subject))
    );
    if (subBook) {
      return {
        bookId: subBook.id,
        pageNumber: subBook.chunks[0]?.pageNumber ?? 1,
        bookTitle: subBook.title,
      };
    }
  }

  return null;
}

export function buildMistakeBookJumpMap(
  mistakes: MistakeItem[],
  books: Book[]
): Map<number, { bookId: number; pageNumber: number; bookTitle: string; examTitle: string | null }> {
  const result = new Map<
    number,
    { bookId: number; pageNumber: number; bookTitle: string; examTitle: string | null }
  >();
  if (mistakes.length === 0 || books.length === 0) return result;

  const refIndex = buildQuestionExamReferenceIndex(books);

  for (const m of mistakes) {
    const chNorm = normalizeMatchKey(m.chapter);
    const stemNorm = normalizeMatchKey(m.questionStem);

    // 1. Exact stem match in indexed book questions
    const exactItems = refIndex.itemsByNormStem.get(stemNorm);
    if (exactItems && exactItems.length > 0) {
      const hit = exactItems[0];
      result.set(m.id, {
        bookId: hit.bookId,
        pageNumber: Math.max(1, hit.pageNumber || 1),
        bookTitle: hit.bookTitle,
        examTitle: hit.institution || hit.examTitle || null,
      });
      continue;
    }

    // 2. Match by chapter name across all books
    let found = false;
    if (chNorm.length >= 3) {
      for (const book of books) {
        const ch = book.chunks.find((c) => {
          const cNorm = normalizeMatchKey(c.chapter);
          return cNorm.length >= 3 && (chNorm.includes(cNorm) || cNorm.includes(chNorm));
        });
        if (ch) {
          result.set(m.id, {
            bookId: book.id,
            pageNumber: Math.max(1, ch.pageNumber),
            bookTitle: book.title,
            examTitle: null,
          });
          found = true;
          break;
        }
      }
    }

    // 3. Fallback by subject
    if (!found) {
      const subNorm = normalizeMatchKey(m.subject);
      const subBook = books.find(
        (b) =>
          subNorm.length >= 3 &&
          (normalizeMatchKey(b.subject).includes(subNorm) ||
            subNorm.includes(normalizeMatchKey(b.subject)))
      );
      if (subBook) {
        result.set(m.id, {
          bookId: subBook.id,
          pageNumber: subBook.chunks[0]?.pageNumber ?? 1,
          bookTitle: subBook.title,
          examTitle: null,
        });
      }
    }
  }

  return result;
}
