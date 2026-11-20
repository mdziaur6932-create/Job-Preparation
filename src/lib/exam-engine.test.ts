import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreExamAttempt,
  extractMistakesFromAttempt,
  computePerformanceAnalytics,
  analyzePreviousYearPatterns,
} from './exam-engine';
import { createInitialSeedData } from './seed-data';

test('scoreExamAttempt applies exact negative marking for wrong MCQ and zero for skipped', () => {
  const seed = createInitialSeedData();
  const mcqs = seed.questions.filter((q) => q.questionType === 'MCQ').slice(0, 3);
  // q0 correct (1), q1 wrong (-0.25), q2 skipped (0)
  const result = scoreExamAttempt(
    { marksPerQuestion: 1, negativeMark: 0.25 },
    mcqs,
    {
      [String(mcqs[0].id)]: { selectedOption: mcqs[0].correctOptionIndex ?? 0 },
      [String(mcqs[1].id)]: {
        selectedOption: ((mcqs[1].correctOptionIndex ?? 0) + 1) % 4,
      },
    }
  );

  assert.equal(result.totalMarks, 3);
  assert.equal(result.obtainedMarks, 0.75);
  assert.equal(result.negativeDeduction, 0.25);
  assert.equal(result.correctCount, 1);
  assert.equal(result.wrongCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.mcqAccuracy, 50);
  assert.equal(result.weakTopics.includes(mcqs[1].chapter), true);
});

test('scoreExamAttempt incorporates AI written grade overrides without negative penalty', () => {
  const seed = createInitialSeedData();
  const writtenQ = seed.questions.find((q) => q.questionType === 'Written')!;
  const result = scoreExamAttempt(
    { marksPerQuestion: 1, negativeMark: 0.5 },
    [writtenQ],
    {
      [String(writtenQ.id)]: {
        writtenText: 'অনুচ্ছেদ ২৬ থেকে ৪৭ক মৌলিক অধিকার এবং অনুচ্ছেদ ১০২ রিট এখতিয়ার।',
      },
    },
    [
      {
        questionId: writtenQ.id,
        awardedMarks: 4.5,
        mistakeExplanation: 'খুব ভালো হয়েছে।',
        improvementTip: 'অনুচ্ছেদ ৪৪ যুক্ত করুন।',
      },
    ]
  );

  assert.equal(result.totalMarks, 5);
  assert.equal(result.obtainedMarks, 4.5);
  assert.equal(result.negativeDeduction, 0);
  assert.equal(result.writtenScore, 90);
  assert.equal(result.correctCount, 1);
});

test('extractMistakesFromAttempt collects wrong and partial questions for Mistake Notebook', () => {
  const seed = createInitialSeedData();
  const mistakes = extractMistakesFromAttempt(seed.attempts[0], 900, '2026-11-20');
  assert.equal(mistakes.length, 1);
  assert.equal(mistakes[0].id, 900);
  assert.equal(mistakes[0].questionId, 204);
  assert.equal(mistakes[0].mastered, false);
});

test('computePerformanceAnalytics aggregates accuracy, weak chapters, and time per question', () => {
  const seed = createInitialSeedData();
  const analytics = computePerformanceAnalytics(seed.attempts);
  assert.equal(analytics.totalExams, 2);
  assert.equal(analytics.overallMcqAccuracy, 75);
  assert.ok(analytics.weakChapters.length >= 1);
  assert.ok(analytics.strongChapters.length >= 1);
  assert.ok(analytics.avgSecondsPerQuestion > 0);
});

test('analyzePreviousYearPatterns ranks recurring chapters accurately', () => {
  const seed = createInitialSeedData();
  const patterns = analyzePreviousYearPatterns(seed.questions);
  assert.ok(patterns.length >= 5);
  assert.equal(patterns[0].frequency >= patterns[patterns.length - 1].frequency, true);
});
