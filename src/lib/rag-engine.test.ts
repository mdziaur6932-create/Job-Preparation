import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkBookText,
  cosineSimilarity,
  rankChunksHybrid,
  deduplicateQuestions,
} from './rag-engine';
import { createInitialSeedData } from './seed-data';

test('chunkBookText respects explicit page markers and splits long content', () => {
  const raw = `--- পৃষ্ঠা ১০ ---
বাংলাদেশের সংবিধান ১৯৭২ সালের ৪ নভেম্বর গৃহীত হয়।

--- পৃষ্ঠা ১১ ---
মৌলিক অধিকার অনুচ্ছেদ ২৬ থেকে ৪৭ক পর্যন্ত বিস্তৃত।`;

  const chunks = chunkBookText({
    bookId: 1,
    bookTitle: 'টেস্ট সংবিধান গাইড',
    chapter: 'অধ্যায় ১',
    rawText: raw,
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].pageNumber, 10);
  assert.equal(chunks[1].pageNumber, 11);
  assert.equal(chunks[0].bookTitle, 'টেস্ট সংবিধান গাইড');
});

test('rankChunksHybrid finds cross-book Bengali topic matches with citations', () => {
  const seed = createInitialSeedData();
  const allChunks = seed.books.flatMap((b) => b.chunks);
  const ranked = rankChunksHybrid(allChunks, 'সংবিধান অর্থবিল অনুচ্ছেদ', { topK: 4 });

  assert.ok(ranked.length >= 2);
  const uniqueBooks = new Set(ranked.map((r) => r.bookId));
  assert.ok(uniqueBooks.size >= 2, 'Expected multi-book hits for constitution & money bill');
  assert.equal(ranked[0].score > 0, true);
});

test('cosineSimilarity computes exact normalized vector similarity', () => {
  assert.equal(Number(cosineSimilarity([1, 0, 0], [1, 0, 0]).toFixed(4)), 1);
  assert.equal(Number(cosineSimilarity([1, 0, 0], [0, 1, 0]).toFixed(4)), 0);
});

test('deduplicateQuestions rejects repeated or near-identical Bengali stems', () => {
  const existing = [
    { stem: 'গণপ্রজাতন্ত্রী বাংলাদেশের সংবিধান গণপরিষদে কবে গৃহীত হয়?' },
  ];
  const candidates = [
    { stem: 'গণপ্রজাতন্ত্রী বাংলাদেশের সংবিধান গণপরিষদে কবে গৃহীত হয়?' },
    { stem: 'জাতিসংঘের নিরাপত্তা পরিষদের স্থায়ী সদস্য সংখ্যা কত?' },
  ];
  const unique = deduplicateQuestions(candidates, existing);
  assert.equal(unique.length, 1);
  assert.equal(
    unique[0].stem,
    'জাতিসংঘের নিরাপত্তা পরিষদের স্থায়ী সদস্য সংখ্যা কত?'
  );
});
