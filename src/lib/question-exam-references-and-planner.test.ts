import test from 'node:test';
import assert from 'node:assert/strict';
import type { Book, BookChunk } from '../types/system';
import {
  buildQuestionExamReferenceIndex,
  findExamReferencesForQuestion,
} from './question-exam-references';
import {
  computeNextDeficitBatch,
  selectRotatedChunksForBatch,
  trimGeneratedSetToTargets,
} from './exam-generation-planner';
import { deduplicateQuestions } from './rag-engine';

function makeJobSolutionBook(id: number, title: string, pages: string[]): Book {
  const chunks: BookChunk[] = pages.map((content, idx) => ({
    id: id * 1000 + idx + 1,
    bookId: id,
    bookTitle: title,
    chapter: `পৃষ্ঠা ${idx + 1}`,
    pageNumber: idx + 1,
    content,
  }));

  return {
    id,
    title,
    subject: 'সমন্বিত (চাকরির পরীক্ষা)',
    author: 'Recent Publication',
    fileName: `${title}.pdf`,
    fileSize: '4.2 MB',
    totalPages: pages.length,
    uploadedAt: '2026-01-15T10:00:00.000Z',
    chunks,
  };
}

test('buildQuestionExamReferenceIndex resolves multiple exams + post names for a repeated question', () => {
  const book1 = makeJobSolutionBook(101, 'Job Solution - January 2026 (MCQ)', [
    [
      'দুর্নীতি দমন কমিশন',
      'পদের নামঃ উপ সহকারী পরিচালক',
      'তারিখঃ ০৩.০১.২০২৬; সময়ঃ ৬০ মিনিট; পূর্ণমানঃ ১০০',
      '01. IDA স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?',
      'a) মাইক্রোক্রেডিট b) সফট লোন c) বাণিজ্যিক লোন d) পণ্য সাহায্য ans. B',
      'Solution: IDA হলো বিশ্বব্যাংকের একটি অঙ্গসংস্থা। এটি Soft Loan Window নামেও পরিচিত।',
      '02. পাপুয়া নিউগিনি কোন অঞ্চলের অন্তর্ভুক্ত?',
      'a) পলিনেশিয়া b) মাইক্রোনেশিয়া c) মেলানেশিয়া d) ওরিয়েন্টাল অঞ্চল ans. C',
      'Solution: পাপুয়া নিউগিনি ওশেনিয়া মহাদেশের মেলানেশিয়া অঞ্চলে অবস্থিত।',
    ].join('\n'),
  ]);

  const book2 = makeJobSolutionBook(102, 'Job Solution - March 2026 (MCQ)', [
    [
      'বাংলাদেশ ব্যাংক',
      'পদের নাম: সহকারী পরিচালক (জেনারেল)',
      'তারিখ: ১৪.০৩.২০২৬; সময়: ৬০ মিনিট; পূর্ণমান: ১০০',
      '15. IDA স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?',
      'ক. মাইক্রোক্রেডিট খ. সফট লোন গ. বাণিজ্যিক লোন ঘ. অনুদান উ. খ',
      'ব্যাখ্যা: বিশ্বব্যাংকের IDA শাখা স্বল্পোন্নত দেশগুলোকে নমনীয় বা সফট লোন প্রদান করে।',
    ].join('\n'),
  ]);

  const index = buildQuestionExamReferenceIndex([book1, book2]);
  const refs = findExamReferencesForQuestion(index, {
    stem: 'IDA স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?',
    bookId: 101,
    bookTitle: book1.title,
    pageNumber: 1,
  });

  assert.equal(refs.length, 2, 'Should find BOTH exam occurrences across books');
  assert.ok(
    refs.some(
      (r) =>
        r.examTitle.includes('দুর্নীতি দমন কমিশন') &&
        r.postName?.includes('উপ সহকারী পরিচালক')
    ),
    'Should include ACC exam name and post name'
  );
  assert.ok(
    refs.some(
      (r) =>
        r.examTitle.includes('বাংলাদেশ ব্যাংক') &&
        r.postName?.includes('সহকারী পরিচালক')
    ),
    'Should include Bangladesh Bank exam name and post name'
  );
  assert.ok(
    refs[0].originalOptions.length >= 4,
    'Should include original 4 options for modal preview'
  );
  assert.ok(
    refs[0].originalExplanation && refs[0].originalExplanation.includes('Soft Loan'),
    'Should preserve original book explanation'
  );
});

test('findExamReferencesForQuestion falls back to source-page exam header when AI paraphrases a question', () => {
  const book = makeJobSolutionBook(201, 'DMLC Job Solution 2026', [
    [
      'বাংলাদেশ পরিসংখ্যান ব্যুরো',
      'পদের নাম: জুনিয়র পরিসংখ্যান সহকারী',
      'তারিখ: ১০.০২.২০২৬; সময়: ৬০ মিনিট; পূর্ণমান: ৭০',
      '১. বাংলাদেশের সংবিধানের কোন অনুচ্ছেদে মৌলিক অধিকারের নিশ্চয়তা দেওয়া হয়েছে?',
      'ক. ২৬ নং খ. ২৭ নং গ. ২৮ নং ঘ. ৩২ নং উ. ক',
    ].join('\n'),
  ]);

  const index = buildQuestionExamReferenceIndex([book]);
  const refs = findExamReferencesForQuestion(index, {
    stem: 'মৌলিক অধিকারের সাথে অসামঞ্জস্যপূর্ণ আইন বাতিল সম্পর্কিত সাংবিধানিক বিধান কত অনুচ্ছেদে আছে?',
    bookId: 201,
    bookTitle: book.title,
    pageNumber: 1,
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0].matchType, 'source_page_exam');
  assert.ok(refs[0].examTitle.includes('পরিসংখ্যান ব্যুরো'));
  assert.ok(refs[0].postName?.includes('জুনিয়র পরিসংখ্যান সহকারী'));
  assert.equal(refs[0].bookId, 201);
  assert.equal(refs[0].pageNumber, 1);
});

test('deduplicateQuestions keeps distinct Bengali MCQs sharing boilerplate words while rejecting real duplicates', () => {
  const incoming = [
    { stem: '‘বিদ্যালয়’ এর সঠিক সন্ধি বিচ্ছেদ কোনটি?' },
    { stem: '‘হিমালয়’ এর সঠিক সন্ধি বিচ্ছেদ কোনটি?' },
    { stem: '‘সংবাদ’ এর সঠিক সন্ধি বিচ্ছেদ কোনটি?' },
    { stem: '‘বিদ্যালয়’ এর সঠিক সন্ধি বিচ্ছেদ কোনটি?' }, // exact duplicate
    { stem: 'Which one is the correct spelling of accommodation?' },
    { stem: 'Which one is the correct spelling of committee?' },
  ];

  const unique = deduplicateQuestions(incoming, []);
  assert.equal(
    unique.length,
    5,
    'Distinct Bengali Sandhi & English spelling MCQs must NOT be falsely dropped'
  );
});

test('selectRotatedChunksForBatch rotates across distinct pages across multi-batch generation', () => {
  const pages = Array.from({ length: 40 }, (_, idx) =>
    `পৃষ্ঠা ${idx + 1} এর বিষয়বস্তু: বাংলাদেশের অর্থনীতি, সংবিধান ও আন্তর্জাতিক সংস্থা অধ্যায় ${idx + 1}।`
  );
  const book = makeJobSolutionBook(301, 'Large Job Solution 2026', pages);

  const batch0 = selectRotatedChunksForBatch({
    books: [book],
    selectedBookIds: [301],
    batchIndex: 0,
    batchChunkLimit: 8,
  });
  const batch1 = selectRotatedChunksForBatch({
    books: [book],
    selectedBookIds: [301],
    batchIndex: 1,
    batchChunkLimit: 8,
  });
  const batch2 = selectRotatedChunksForBatch({
    books: [book],
    selectedBookIds: [301],
    batchIndex: 2,
    batchChunkLimit: 8,
  });

  assert.equal(batch0.length, 8);
  assert.equal(batch1.length, 8);
  assert.equal(batch2.length, 8);

  const pages0 = new Set(batch0.map((c) => c.pageNumber));
  const pages1 = new Set(batch1.map((c) => c.pageNumber));
  const pages2 = new Set(batch2.map((c) => c.pageNumber));
  const unionAll = new Set([...pages0, ...pages1, ...pages2]);

  assert.ok(
    unionAll.size >= 20,
    `Expected rotated batches to cover >=20 distinct pages, got ${unionAll.size}`
  );
});

test('computeNextDeficitBatch + trimGeneratedSetToTargets reliably reaches exact 70/70 MCQs', () => {
  // Simulate 4 initial batches that yield slightly fewer MCQs (18 + 14 + 12 + 10 = 54, just like the user saw!)
  const generated: Array<{ questionType: string; stem: string }> = [];
  const pushFake = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      generated.push({
        questionType: 'MCQ',
        stem: `Question #${generated.length + 1}`,
      });
    }
  };

  pushFake(54);
  const deficit1 = computeNextDeficitBatch({
    targetMcq: 70,
    targetWritten: 0,
    currentMcq: generated.length,
    currentWritten: 0,
    maxQuestionsPerBatch: 18,
  });
  assert.deepEqual(deficit1, { mcqCount: 16, writtenCount: 0 });

  // Simulate top-up returning 18 (slightly over)
  pushFake(18);
  const deficit2 = computeNextDeficitBatch({
    targetMcq: 70,
    targetWritten: 0,
    currentMcq: generated.length,
    currentWritten: 0,
    maxQuestionsPerBatch: 18,
  });
  assert.equal(deficit2, null);

  const trimmed = trimGeneratedSetToTargets(generated, 70, 0);
  assert.equal(trimmed.length, 70, 'Final set must match exact 70 MCQs');
});
