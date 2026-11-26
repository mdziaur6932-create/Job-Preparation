import test from 'node:test';
import assert from 'node:assert/strict';
import type { Book } from '../types/system';
import {
  compileExamSetsLocallyFromBooks,
  resolveMcqCorrectIndex,
} from './local-question-compiler';
import { analyzeDemoPaperTextLocally } from './local-demo-paper-analyzer';

function makeSampleJobSolutionBook(id: number, title: string, content: string): Book {
  return {
    id,
    title,
    author: 'রিসেন্ট পাবলিকেশন',
    subject: 'সকল বিষয়',
    category: 'রিসেন্ট জব সলুশন',
    totalPages: 1,
    extractionMethod: 'text',
    ocrCompleted: true,
    createdAt: '2026-11-25T00:00:00.000Z',
    chunks: [
      {
        id: id * 100 + 1,
        bookId: id,
        bookTitle: title,
        chapter: 'পৃষ্ঠা ১',
        pageNumber: 1,
        chunkIndex: 0,
        content,
      },
    ],
  };
}

const SAMPLE_MCQ_BOOK_TEXT = `দুর্নীতি দমন কমিশন
পদের নাম: উপ সহকারী পরিচালক
তারিখ: ০৩.০১.২০২৬; সময়: ৬০ মিনিট; পূর্ণমান: ১০০

01. IDA স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?
a) মাইক্রোক্রেডিট
b) সফট লোন
c) বাণিজ্যিক লোন
d) পণ্য সাহায্য
ans. B
Solution: IDA হলো বিশ্বব্যাংকের একটি অঙ্গসংস্থা। এটি Soft Loan Window নামেও পরিচিত।

02. ‘বিদ্যালয়’ এর সঠিক সন্ধি বিচ্ছেদ কোনটি?
ক. বিদ্যা + আলয়
খ. বিদ্যা + লয়
গ. বিদ্য + আলয়
ঘ. বিদ + আলয়
উত্তর: ক
ব্যাখ্যা: স্বরসন্ধির নিয়মে আ + আ = আ হয়।

03. Choose the correct sentence (Right Form of Verbs):
a) He go to school daily
b) He goes to school daily
c) He going to school daily
d) He gone to school daily
ans. B

04. একটি ত্রিভুজের তিন কোণের সমষ্টি কত ডিগ্রি?
ক. ৯০ ডিগ্রি
খ. ১৮০ ডিগ্রি
গ. ২৭০ ডিগ্রি
ঘ. ৩৬০ ডিগ্রি
উত্তর: খ
ব্যাখ্যা: ইউক্লিডীয় জ্যামিতি অনুযায়ী ত্রিভুজের তিন কোণের সমষ্টি দুই সমকোণ বা ১৮০ ডিগ্রি।

05. বাংলাদেশের সংবিধান কবে কার্যকর হয়?
ক. ৪ নভেম্বর ১৯৭২
খ. ১৬ ডিসেম্বর ১৯৭২
গ. ২৬ মার্চ ১৯৭২
ঘ. ১০ এপ্রিল ১৯৭১
উ. খ

06. পাপুয়া নিউগিনি কোন অঞ্চলের অন্তর্ভুক্ত?
a) পলিনেশিয়া
b) মাইক্রোনেশিয়া
c) মেলানেশিয়া
d) ওরিয়েন্টাল অঞ্চল
ans. C
Solution: পাপুয়া নিউগিনি ওশেনিয়া মহাদেশের মেলানেশিয়া অঞ্চলে অবস্থিত।`;

test('resolveMcqCorrectIndex maps Bengali/English markers and option texts accurately', () => {
  const bnOpts = [
    { marker: 'ক.', text: 'বিদ্যা + আলয়' },
    { marker: 'খ.', text: 'বিদ্যা + লয়' },
    { marker: 'গ.', text: 'বিদ্য + আলয়' },
    { marker: 'ঘ.', text: 'বিদ + আলয়' },
  ];
  assert.equal(resolveMcqCorrectIndex('উ. ক', bnOpts), 0);
  assert.equal(resolveMcqCorrectIndex('উত্তর: খ', bnOpts), 1);
  assert.equal(resolveMcqCorrectIndex('গ', bnOpts), 2);
  assert.equal(resolveMcqCorrectIndex('বিদ + আলয়', bnOpts), 3);

  const enOpts = [
    { marker: 'a)', text: 'মাইক্রোক্রেডিট' },
    { marker: 'b)', text: 'সফট লোন' },
    { marker: 'c)', text: 'বাণিজ্যিক লোন' },
    { marker: 'd)', text: 'পণ্য সাহায্য' },
  ];
  assert.equal(resolveMcqCorrectIndex('ans. B', enOpts), 1);
  assert.equal(resolveMcqCorrectIndex('Answer: c', enOpts), 2);
  assert.equal(resolveMcqCorrectIndex('সফট লোন', enOpts), 1);
});

test('compileExamSetsLocallyFromBooks produces distinct zero-API MCQ sets with exact answers and book explanations', () => {
  const book = makeSampleJobSolutionBook(
    1,
    '01. Job Solution - January 2026 (MCQ)',
    SAMPLE_MCQ_BOOK_TEXT
  );

  const result = compileExamSetsLocallyFromBooks({
    books: [book],
    questionMode: 'MCQ',
    mcqCount: 3,
    writtenCount: 0,
    setCount: 2,
    difficulty: 'Medium',
    subject: 'সমন্বিত (চাকরির পরীক্ষা)',
    orderingMode: 'subject_serial',
  });

  assert.equal(result.totalPoolMcq, 6);
  assert.equal(result.sets.length, 2);
  assert.equal(result.sets[0].questions.length, 3);
  assert.equal(result.sets[1].questions.length, 3);

  // Set 1 and Set 2 must not share any duplicate question stems
  const set1Stems = new Set(result.sets[0].questions.map((q) => q.stem));
  for (const q of result.sets[1].questions) {
    assert.equal(set1Stems.has(q.stem), false, `Duplicate stem across sets: ${q.stem}`);
  }

  // Verify IDA question has correctOptionIndex = 1 ('সফট লোন') and book explanation
  const allCompiled = [...result.sets[0].questions, ...result.sets[1].questions];
  const idaQ = allCompiled.find((q) => q.stem.includes('IDA'));
  assert.ok(idaQ, 'IDA MCQ should be compiled');
  assert.equal(idaQ.options.length, 4);
  assert.equal(idaQ.correctOptionIndex, 1);
  assert.equal(idaQ.options[idaQ.correctOptionIndex!], 'সফট লোন');
  assert.ok(idaQ.explanation.includes('[বইয়ের ব্যাখ্যা]'));
  assert.ok(idaQ.explanation.includes('Soft Loan Window'));
});

test('analyzeDemoPaperTextLocally detects exam metadata, MCQ counts, and 100% normalized topic percentages with 0 API calls', () => {
  const analysis = analyzeDemoPaperTextLocally(
    [SAMPLE_MCQ_BOOK_TEXT],
    'সংস্কৃতি.pdf'
  );
  assert.ok(analysis, 'Should produce local analysis for readable PDF text');
  assert.equal(analysis.fileName, 'সংস্কৃতি.pdf');
  assert.equal(analysis.mcqCountDetected, 6);
  assert.equal(analysis.writtenCountDetected, 0);
  assert.equal(analysis.recommendedFormat, 'MCQ');
  assert.equal(analysis.totalMarksDetected, 100);
  assert.equal(analysis.durationMinutesDetected, 60);

  const pctSum = analysis.topicDistribution.reduce(
    (sum, t) => sum + t.percentage,
    0
  );
  assert.equal(pctSum, 100);
  assert.ok(analysis.subjectDistribution && analysis.subjectDistribution.length > 0);
});
