import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_EXPLANATION_PREFIX,
  BOOK_EXPLANATION_PREFIX,
  allocateQuestionsByPercentage,
  encodeExplanationWithSource,
  normalizeTopicPercentages,
  parseExplanationSource,
  splitGenerationIntoBatches,
  stripExplanationSourcePrefix,
} from './demo-paper-blueprint';

test('normalizeTopicPercentages merges duplicate canonical topics and sums to exactly 100%', () => {
  const result = normalizeTopicPercentages([
    { topicLabel: 'সন্ধি বিচ্ছেদ', questionCountInDemo: 3, questionTypes: ['MCQ'] },
    { topicLabel: 'Sandhi Bicched', questionCountInDemo: 2, questionTypes: ['Written'] },
    { topicLabel: 'Right Form of Verbs', questionCountInDemo: 4, questionTypes: ['MCQ'] },
    { topicLabel: 'Math Geometry', questionCountInDemo: 4, questionTypes: ['MCQ'] },
  ]);

  assert.equal(result.length, 3);
  const sum = result.reduce((acc, item) => acc + item.percentage, 0);
  assert.equal(sum, 100);

  const sandhi = result.find((t) => t.topicLabel.includes('সন্ধি বিচ্ছেদ'));
  assert.ok(sandhi, 'Expected Sandhi Bicched canonical topic');
  assert.equal(sandhi.questionCountInDemo, 5);
  assert.ok(sandhi.questionTypes.includes('MCQ'));
  assert.ok(sandhi.questionTypes.includes('Written'));
});

test('normalizeTopicPercentages handles percentage-only input and guarantees 100% sum', () => {
  const result = normalizeTopicPercentages([
    { topicLabel: 'সন্ধি বিচ্ছেদ', percentage: 33.3 },
    { topicLabel: 'Right Form of Verbs', percentage: 33.3 },
    { topicLabel: 'Math Geometry', percentage: 33.3 },
  ]);

  assert.equal(result.length, 3);
  assert.equal(
    result.reduce((acc, item) => acc + item.percentage, 0),
    100
  );
});

test('allocateQuestionsByPercentage distributes 70 questions strictly by topic % with exact total', () => {
  const dist = normalizeTopicPercentages([
    { topicLabel: 'সন্ধি বিচ্ছেদ', percentage: 25 },
    { topicLabel: 'Right Form of Verbs', percentage: 30 },
    { topicLabel: 'Math Geometry', percentage: 25 },
    { topicLabel: 'কম্পিউটার ও তথ্যপ্রযুক্তি (ICT)', percentage: 20 },
  ]);

  const allocations70 = allocateQuestionsByPercentage(dist, 70);
  assert.equal(
    allocations70.reduce((sum, a) => sum + a.targetCount, 0),
    70
  );

  // 30% of 70 = 21, 20% of 70 = 14, 25% of 70 = 17.5 -> 18 & 17
  const verbs = allocations70.find((a) => a.topicLabel.includes('Right Form of Verbs'));
  const ict = allocations70.find((a) => a.topicLabel.includes('ICT'));
  assert.equal(verbs?.targetCount, 21);
  assert.equal(ict?.targetCount, 14);

  const allocations10 = allocateQuestionsByPercentage(dist, 10);
  assert.equal(
    allocations10.reduce((sum, a) => sum + a.targetCount, 0),
    10
  );
});

test('splitGenerationIntoBatches chunks 70 MCQ into <= 15 per batch and handles mixed sets cleanly', () => {
  const batches70 = splitGenerationIntoBatches({
    mcqCount: 70,
    writtenCount: 0,
    maxQuestionsPerBatch: 15,
  });

  assert.equal(batches70.length, 5);
  assert.equal(
    batches70.reduce((sum, b) => sum + b.mcqCount, 0),
    70
  );
  for (const b of batches70) {
    assert.ok(b.mcqCount + b.writtenCount <= 15);
    assert.equal(b.writtenCount, 0);
  }

  const mixed = splitGenerationIntoBatches({
    mcqCount: 20,
    writtenCount: 5,
    maxQuestionsPerBatch: 15,
  });
  assert.equal(mixed.length, 2);
  assert.equal(
    mixed.reduce((sum, b) => sum + b.mcqCount, 0),
    20
  );
  assert.equal(
    mixed.reduce((sum, b) => sum + b.writtenCount, 0),
    5
  );
});

test('encodeExplanationWithSource and parseExplanationSource accurately distinguish Book vs AI vs Missing', () => {
  const bookEncoded = encodeExplanationWithSource('নব + অন্ন = নবান্ন (স্বরসন্ধি)।', 'book');
  assert.ok(bookEncoded.startsWith(BOOK_EXPLANATION_PREFIX));

  const parsedBook = parseExplanationSource(bookEncoded, 'অগ্রদূত বাংলা', 45);
  assert.equal(parsedBook.source, 'book');
  assert.equal(parsedBook.badgeLabel, 'মূল বইয়ের ব্যাখ্যা');
  assert.equal(parsedBook.text, 'নব + অন্ন = নবান্ন (স্বরসন্ধি)।');
  assert.equal(parsedBook.hasExplanation, true);
  assert.ok(parsedBook.sourceNote.includes('অগ্রদূত বাংলা'));

  const aiEncoded = encodeExplanationWithSource(
    `${BOOK_EXPLANATION_PREFIX} ত্রিভুজের তিন কোণের সমষ্টি $180^\\circ$।`,
    'ai'
  );
  assert.ok(aiEncoded.startsWith(AI_EXPLANATION_PREFIX));
  assert.equal(stripExplanationSourcePrefix(aiEncoded), 'ত্রিভুজের তিন কোণের সমষ্টি $180^\\circ$।');

  const parsedAi = parseExplanationSource(aiEncoded);
  assert.equal(parsedAi.source, 'ai');
  assert.equal(parsedAi.badgeLabel, 'AI দিয়ে ব্যাখ্যা লেখা হয়েছে');
  assert.equal(parsedAi.hasExplanation, true);

  const legacyBook = parseExplanationSource('সংবিধানের ২৭ অনুচ্ছেদে আইনের দৃষ্টিতে সমতার কথা বলা হয়েছে।');
  assert.equal(legacyBook.source, 'book');
  assert.equal(legacyBook.badgeLabel, 'বইয়ের ব্যাখ্যা');
  assert.equal(legacyBook.hasExplanation, true);

  const missing = parseExplanationSource('   ');
  assert.equal(missing.hasExplanation, false);
  assert.equal(missing.badgeLabel, 'ব্যাখ্যা অনুপস্থিত');
});
