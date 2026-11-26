import type { Book, BookChunk } from '../types/system';
import { selectChunksForExamBlueprint } from './syllabus-topic-tagger';

export interface DeficitBatchPlan {
  mcqCount: number;
  writtenCount: number;
}

/**
 * Selects a diverse, batch-rotated window of chunks across all selected books so multi-batch
 * AI generation (e.g., 70 MCQs across 4+ batches) draws fresh material from different pages
 * instead of repeating the exact same top-10 chunks on every API call.
 */
export function selectRotatedChunksForBatch(params: {
  books: Book[];
  selectedBookIds: number[];
  selectedTopics?: string[];
  topicHint?: string;
  batchIndex: number;
  batchChunkLimit?: number;
  gkChunks?: BookChunk[];
}): BookChunk[] {
  const {
    books,
    selectedBookIds,
    selectedTopics = [],
    topicHint = '',
    batchIndex,
    batchChunkLimit = 10,
    gkChunks = [],
  } = params;

  const gkReserve = gkChunks.length > 0 ? Math.min(2, gkChunks.length) : 0;
  const bookLimit = Math.max(2, batchChunkLimit - gkReserve);

  const selectedSet = new Set(selectedBookIds);
  const chosenBooks = books.filter((b) => selectedSet.has(b.id));
  if (chosenBooks.length === 0) {
    return gkChunks.slice(0, batchChunkLimit);
  }

  // Gather a large ranked pool covering all selected books (up to 60 chunks)
  const widePool = selectChunksForExamBlueprint({
    books: chosenBooks,
    selectedBookIds,
    selectedTopics,
    topicHint,
    topK: Math.max(bookLimit * 5, 48),
  });

  // Also interleave unranked pages across books so every page of large Job Solution books is reachable
  const seenIds = new Set(widePool.map((c) => c.id));
  const extraInterleaved: BookChunk[] = [];
  const maxBookChunks = Math.max(
    0,
    ...chosenBooks.map((b) => b.chunks.length)
  );
  for (let i = 0; i < maxBookChunks && widePool.length + extraInterleaved.length < 120; i += 1) {
    for (const book of chosenBooks) {
      const ch = book.chunks[i];
      if (ch && !seenIds.has(ch.id)) {
        seenIds.add(ch.id);
        extraInterleaved.push(ch);
      }
    }
  }

  const fullPool = [...widePool, ...extraInterleaved];
  if (fullPool.length <= bookLimit) {
    return [...fullPool, ...gkChunks.slice(0, gkReserve)];
  }

  // Rotate starting window by batchIndex so each batch reads fresh pages
  const stride = Math.max(1, Math.min(bookLimit, Math.floor(fullPool.length / 4) || bookLimit));
  const start = (Math.max(0, batchIndex) * stride) % fullPool.length;
  const picked: BookChunk[] = [];
  for (let i = 0; i < bookLimit; i += 1) {
    picked.push(fullPool[(start + i) % fullPool.length]);
  }

  return [...picked, ...gkChunks.slice(0, gkReserve)];
}

/**
 * Computes the next top-up batch needed to fulfill exact requested MCQ and Written counts.
 * Returns null once both targets are met.
 */
export function computeNextDeficitBatch(params: {
  targetMcq: number;
  targetWritten: number;
  currentMcq: number;
  currentWritten: number;
  maxQuestionsPerBatch?: number;
}): DeficitBatchPlan | null {
  const maxPerBatch = Math.max(4, Math.min(25, params.maxQuestionsPerBatch ?? 18));
  const remainingMcq = Math.max(0, params.targetMcq - params.currentMcq);
  const remainingWritten = Math.max(0, params.targetWritten - params.currentWritten);

  if (remainingMcq === 0 && remainingWritten === 0) {
    return null;
  }

  const takeMcq = Math.min(remainingMcq, maxPerBatch);
  const remainingSlot = maxPerBatch - takeMcq;
  const takeWritten =
    remainingSlot > 0 ? Math.min(remainingWritten, Math.min(10, remainingSlot)) : 0;

  if (takeMcq === 0 && takeWritten === 0) {
    return null;
  }

  return { mcqCount: takeMcq, writtenCount: takeWritten };
}

/**
 * Trims a generated question list cleanly so MCQ and Written totals never exceed the exact
 * requested counts (e.g., requesting 70 MCQs returns at most 70 MCQs).
 */
export function trimGeneratedSetToTargets<T extends { questionType: string }>(
  questions: T[],
  targetMcq: number,
  targetWritten: number
): T[] {
  const out: T[] = [];
  let mcq = 0;
  let written = 0;

  for (const q of questions) {
    if (q.questionType === 'MCQ') {
      if (mcq < targetMcq) {
        out.push(q);
        mcq += 1;
      }
    } else {
      if (written < targetWritten) {
        out.push(q);
        written += 1;
      }
    }
  }

  return out;
}
