import test from 'node:test';
import assert from 'node:assert/strict';
import type { Book, CurrentGkItem, ExamAttempt, MistakeItem, StudyTask } from '../types/system';
import {
  buildDynamicBookIntelligence,
  computeExamCountdownStrategy,
  computeMemoryStrength,
  computeSmartReschedulePlan,
  computeStudyStreakAndTodayMinutes,
  detectRepeatedMistakeIds,
  generateSmartRoutineTasks,
} from './smart-study-planner';

function makeBook(id: number, title: string, subject: string, chapters: string[]): Book {
  return {
    id,
    title,
    subject,
    author: 'Author',
    fileName: `${title}.pdf`,
    fileSize: '3 MB',
    totalPages: chapters.length * 10,
    uploadedAt: '2026-11-01T00:00:00.000Z',
    chunks: chapters.map((ch, idx) => ({
      id: id * 100 + idx + 1,
      bookId: id,
      bookTitle: title,
      chapter: ch,
      pageNumber: idx * 10 + 1,
      content: `${ch}\n১. বাংলাদেশের সংবিধানের ২৬ অনুচ্ছেদে কী বলা আছে?\nক. মৌলিক অধিকার খ. নির্বাচন গ. অর্থবিল ঘ. বিচার বিভাগ উ. ক`,
    })),
  };
}

test('computeExamCountdownStrategy switches cleanly between foundation, revision_mock, and rapid_fire', () => {
  const today = '2026-11-25';
  assert.equal(computeExamCountdownStrategy('', today).mode, 'unset');
  assert.equal(computeExamCountdownStrategy('2026-12-30', today).mode, 'foundation');
  assert.equal(computeExamCountdownStrategy('2026-12-05', today).mode, 'revision_mock');
  assert.equal(computeExamCountdownStrategy('2026-11-27', today).mode, 'rapid_fire');
  assert.equal(computeExamCountdownStrategy('2026-11-27', today).daysRemaining, 2);
});

test('buildDynamicBookIntelligence automatically includes newly added books with zero config', () => {
  const initialBooks = [
    makeBook(1, 'সংবিধান গাইড', 'বাংলাদেশ বিষয়াবলি', ['মৌলিক অধিকার', 'আইনসভা ও অর্থবিল']),
  ];
  const intelBefore = buildDynamicBookIntelligence({
    books: initialBooks,
    attempts: [],
    mistakes: [],
    studyTasks: [],
    todayIso: '2026-11-25',
  });
  assert.equal(intelBefore.totalBooks, 1);
  assert.equal(intelBefore.bookSummaries.length, 1);

  // User adds a brand-new book later
  const updatedBooks = [
    ...initialBooks,
    makeBook(99, 'নতুন জব সলুশন ২০২৬', 'সমন্বিত', ['দুর্নীতি দমন কমিশন পরীক্ষা ২০২৬']),
  ];
  const intelAfter = buildDynamicBookIntelligence({
    books: updatedBooks,
    attempts: [],
    mistakes: [],
    studyTasks: [],
    todayIso: '2026-11-25',
  });

  assert.equal(intelAfter.totalBooks, 2);
  assert.ok(
    intelAfter.bookSummaries.some((b) => b.bookId === 99 && b.bookTitle === 'নতুন জব সলুশন ২০২৬'),
    'Newly added book must immediately appear in bookSummaries'
  );
  assert.ok(
    intelAfter.revisionUnits.some((u) => u.bookId === 99),
    'Newly added book units must immediately appear in revisionUnits'
  );
});

test('generateSmartRoutineTasks incorporates newly added books and avoids duplicates on repeated clicks', () => {
  const books = [
    makeBook(1, 'বিসিএস বাংলা গাইড', 'বাংলা', ['সন্ধি ও সমাস']),
    makeBook(2, 'জব সলুশন ডিসেম্বর ২০২৬', 'সমন্বিত', ['বাংলাদেশ ব্যাংক সহকারী পরিচালক ২০২৬']),
  ];
  const mistakes: MistakeItem[] = [
    {
      id: 10,
      questionId: 101,
      attemptId: 1,
      questionStem: 'অর্থবিল কোন অনুচ্ছেদে?',
      subject: 'বাংলাদেশ বিষয়াবলি',
      chapter: 'সংবিধান',
      userAnswer: '৮৫',
      correctAnswer: '৮১',
      reason: 'সংবিধানের ৮১ অনুচ্ছেদ',
      mastered: false,
      reviewCount: 2,
      nextReviewDate: '2026-11-25',
      createdAt: '2026-11-20',
    },
  ];
  const gkItems: CurrentGkItem[] = [
    {
      id: 1,
      title: 'জাতীয় বাজেট ২০২৬-২৭ এর মূল খাত',
      summary: 'বিস্তারিত',
      category: 'অর্থনীতি',
      eventDate: '2026-11-15',
      source: 'অর্থ মন্ত্রণালয়',
      isArchived: false,
      convertedToQuestions: false,
      createdAt: '2026-11-15',
    },
  ];

  const firstRun = generateSmartRoutineTasks({
    books,
    attempts: [],
    mistakes,
    gkItems,
    existingTasks: [],
    slot: 'slot_60',
    dailyMinutes: 120,
    strategyMode: 'foundation',
    focusBookScope: 'all',
    todayIso: '2026-11-25',
  });

  assert.ok(firstRun.length >= 2, 'Should generate actionable tasks for 60m slot');
  assert.ok(
    firstRun.some((t) => t.title.includes('জব সলুশন ডিসেম্বর ২০২৬')),
    'Should immediately prioritize newly added book when focusBookScope is all'
  );

  // Convert generated tasks into existingTasks and re-run -> should produce 0 duplicates for the same slot
  const existingAfterFirst: StudyTask[] = firstRun.map((t, i) => ({
    id: 500 + i,
    ...t,
    completed: false,
    createdAt: '2026-11-25',
  }));
  const secondRun = generateSmartRoutineTasks({
    books,
    attempts: [],
    mistakes,
    gkItems,
    existingTasks: existingAfterFirst,
    slot: 'slot_60',
    dailyMinutes: 120,
    strategyMode: 'foundation',
    focusBookScope: 'all',
    todayIso: '2026-11-25',
  });
  assert.equal(secondRun.length, 0, 'Repeated clicks must not create duplicate tasks on same day');
});

test('computeSmartReschedulePlan redistributes overdue tasks across today and upcoming days within daily cap', () => {
  const tasks: StudyTask[] = [
    {
      id: 1,
      title: 'মিসড কাজ ১',
      subject: 'গণিত',
      chapter: 'শতকরা',
      taskType: 'practice',
      scheduledDate: '2026-11-20',
      durationMinutes: 60,
      completed: false,
      createdAt: '2026-11-19',
    },
    {
      id: 2,
      title: 'মিসড কাজ ২',
      subject: 'বাংলা',
      chapter: 'সন্ধি',
      taskType: 'reading',
      scheduledDate: '2026-11-21',
      durationMinutes: 60,
      completed: false,
      createdAt: '2026-11-19',
    },
    {
      id: 3,
      title: 'আজকের কাজ',
      subject: 'ইংরেজি',
      chapter: 'Grammar',
      taskType: 'revision',
      scheduledDate: '2026-11-25',
      durationMinutes: 50,
      completed: false,
      createdAt: '2026-11-24',
    },
  ];

  const plan = computeSmartReschedulePlan({
    tasks,
    dailyMinutesCap: 100,
    todayIso: '2026-11-25',
  });

  assert.equal(plan.length, 2, 'Should reschedule both overdue incomplete tasks');
  // Today already has 50m, so 60m task cannot fit in 100m cap -> moves to 2026-11-26, next to 2026-11-27
  assert.equal(plan[0].toDate, '2026-11-26');
  assert.equal(plan[1].toDate, '2026-11-27');
});

test('computeMemoryStrength + computeStudyStreakAndTodayMinutes + detectRepeatedMistakeIds work accurately', () => {
  const strong = computeMemoryStrength({
    daysSinceLastTouch: 0,
    completedTouches: 2,
    isWeak: false,
    mistakeCount: 0,
  });
  assert.equal(strong.memoryStatus, 'strong');
  assert.equal(strong.dueToday, false);

  const faded = computeMemoryStrength({
    daysSinceLastTouch: 10,
    completedTouches: 1,
    isWeak: true,
    mistakeCount: 2,
  });
  assert.equal(faded.memoryStatus, 'critical');
  assert.equal(faded.dueToday, true);

  const streak = computeStudyStreakAndTodayMinutes({
    tasks: [
      {
        id: 1,
        title: 'Day 1',
        subject: 'বাংলা',
        chapter: 'সন্ধি',
        taskType: 'reading',
        scheduledDate: '2026-11-24',
        durationMinutes: 30,
        completed: true,
        createdAt: '2026-11-24',
      },
      {
        id: 2,
        title: 'Day 2',
        subject: 'গণিত',
        chapter: 'সুদ',
        taskType: 'practice',
        scheduledDate: '2026-11-25',
        durationMinutes: 45,
        completed: true,
        createdAt: '2026-11-25',
      },
    ],
    focusMinutesByDate: { '2026-11-23': 20 },
    todayIso: '2026-11-25',
  });
  assert.equal(streak.streakDays, 3);
  assert.equal(streak.todayCompletedMinutes, 45);

  const repeated = detectRepeatedMistakeIds([
    {
      id: 1,
      questionId: 1,
      attemptId: 1,
      questionStem: 'একই প্রশ্ন',
      subject: 'বাংলা',
      chapter: 'সন্ধি',
      userAnswer: 'ক',
      correctAnswer: 'খ',
      reason: 'র',
      mastered: false,
      reviewCount: 0,
      nextReviewDate: '2026-11-25',
      createdAt: '2026-11-20',
    },
    {
      id: 2,
      questionId: 1,
      attemptId: 2,
      questionStem: 'একই প্রশ্ন',
      subject: 'বাংলা',
      chapter: 'সন্ধি',
      userAnswer: 'গ',
      correctAnswer: 'খ',
      reason: 'র',
      mastered: false,
      reviewCount: 0,
      nextReviewDate: '2026-11-25',
      createdAt: '2026-11-22',
    },
  ]);
  assert.ok(repeated.has(1) && repeated.has(2));
});
