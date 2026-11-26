import type { BookChunk, Question } from '../types/system';

export interface TextChunkInput {
  bookId: number;
  bookTitle: string;
  chapter: string;
  startPage?: number;
  rawText: string;
  maxCharsPerChunk?: number;
}

export interface RankedChunk extends BookChunk {
  score: number;
  matchedTerms: string[];
}

/**
 * Normalizes Bengali and English text into searchable tokens.
 * Keeps Bengali Unicode range (\u0980-\u09FF), Latin letters, and digits.
 */
export function tokenizeBilingual(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\u0980-\u09FFa-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * Splits a raw book/chapter text into page-indexed chunks for RAG indexing.
 * Recognizes optional markers like "[Page 12]" or "--- পৃষ্ঠা ১২ ---" or splits cleanly by paragraphs.
 */
export function chunkBookText(input: TextChunkInput): Omit<BookChunk, 'id'>[] {
  const maxChars = input.maxCharsPerChunk ?? 850;
  const startPage = input.startPage ?? 1;
  const normalized = input.rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const results: Omit<BookChunk, 'id'>[] = [];
  let currentPage = startPage;
  let currentChapter = input.chapter.trim() || 'অধ্যায় ১';
  let buffer = '';
  let chunkIndex = 0;

  const hasExplicitPageMarkers = paragraphs.some((para) =>
    /^(?:---\s*)?(?:page|পৃষ্ঠা)\s*[:#-]?\s*([0-9০-৯]+)(?:\s*---)?/i.test(para)
  );

  const flushBuffer = () => {
    const trimmed = buffer.trim();
    if (!trimmed) return;
    results.push({
      bookId: input.bookId,
      bookTitle: input.bookTitle,
      chapter: currentChapter,
      pageNumber: currentPage,
      chunkIndex,
      content: trimmed,
    });
    chunkIndex += 1;
    buffer = '';
  };

  const toAsciiDigits = (s: string) =>
    s.replace(/[০-৯]/g, (ch) => String('০১২৩৪৫৬৭৮৯'.indexOf(ch)));

  for (const para of paragraphs) {
    const pageMarker = para.match(
      /^(?:---\s*)?(?:page|পৃষ্ঠা)\s*[:#-]?\s*([0-9০-৯]+)(?:\s*---)?/i
    );
    if (pageMarker) {
      flushBuffer();
      const parsedPage = Number.parseInt(toAsciiDigits(pageMarker[1]), 10);
      currentPage = Number.isFinite(parsedPage) ? parsedPage : currentPage + 1;
      let remainder = para.slice(pageMarker[0].length).trim();
      const chapterMatch = remainder.match(/^\[([^\]]+)\]\s*/);
      if (chapterMatch) {
        const parsedChapter = chapterMatch[1].trim();
        if (parsedChapter) {
          currentChapter = parsedChapter;
        }
        remainder = remainder.slice(chapterMatch[0].length).trim();
      }
      if (remainder) {
        buffer = remainder;
      }
      continue;
    }

    if ((buffer + '\n\n' + para).length > maxChars && buffer.length > 0) {
      flushBuffer();
      if (!hasExplicitPageMarkers && chunkIndex > 0 && chunkIndex % 2 === 0) {
        currentPage += 1;
      }
    }

    buffer = buffer ? `${buffer}\n\n${para}` : para;
  }

  flushBuffer();
  return results;
}

/**
 * Computes cosine similarity between two equal-length embedding vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Hybrid RAG ranker: combines pgvector/embedding cosine similarity (when available)
 * with Bengali/English lexical term overlap and chapter title boost.
 */
export function rankChunksHybrid(
  chunks: BookChunk[],
  query: string,
  options?: {
    queryEmbedding?: number[] | null;
    bookIds?: number[];
    topK?: number;
  }
): RankedChunk[] {
  const topK = options?.topK ?? 6;
  const bookFilter =
    options?.bookIds && options.bookIds.length > 0
      ? new Set(options.bookIds)
      : null;

  const candidateChunks = bookFilter
    ? chunks.filter((c) => bookFilter.has(c.bookId))
    : chunks;

  const queryTokens = Array.from(new Set(tokenizeBilingual(query)));

  const scored: RankedChunk[] = candidateChunks.map((chunk) => {
    const contentTokens = tokenizeBilingual(
      `${chunk.chapter} ${chunk.bookTitle} ${chunk.content}`
    );
    const tokenFreq = new Map<string, number>();
    for (const tok of contentTokens) {
      tokenFreq.set(tok, (tokenFreq.get(tok) ?? 0) + 1);
    }

    const matchedTerms: string[] = [];
    let lexicalScore = 0;
    const chapterLower = chunk.chapter.toLowerCase();

    for (const qTok of queryTokens) {
      let exact = tokenFreq.get(qTok) ?? 0;
      if (exact === 0) {
        // Prefix/substring match for inflected Bengali stems (e.g., সংবিধান -> সংবিধানের)
        for (const [tok, count] of tokenFreq.entries()) {
          if (tok.startsWith(qTok) || (qTok.length >= 4 && tok.includes(qTok))) {
            exact += count * 0.75;
          }
        }
      }
      if (exact > 0) {
        matchedTerms.push(qTok);
        lexicalScore += Math.min(3, Math.log2(1 + exact) + 0.5);
      }
      if (chapterLower.includes(qTok)) {
        lexicalScore += 1.2;
      }
    }

    const normalizedLexical =
      queryTokens.length > 0
        ? Math.min(1, lexicalScore / (queryTokens.length * 2.2))
        : 0.1;

    let semanticScore = 0;
    if (
      options?.queryEmbedding &&
      chunk.embedding &&
      chunk.embedding.length === options.queryEmbedding.length
    ) {
      semanticScore = Math.max(
        0,
        cosineSimilarity(options.queryEmbedding, chunk.embedding)
      );
    }

    const finalScore =
      semanticScore > 0
        ? semanticScore * 0.65 + normalizedLexical * 0.35
        : normalizedLexical;

    return {
      ...chunk,
      score: Number(finalScore.toFixed(4)),
      matchedTerms,
    };
  });

  scored.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);

  if (queryTokens.length === 0 && !options?.queryEmbedding) {
    return scored.slice(0, topK);
  }

  const positive = scored.filter((c) => c.score > 0);
  return (positive.length > 0 ? positive : scored).slice(0, topK);
}

const DEDUP_STOP_WORDS = new Set([
  'নিচের',
  'নিম্নের',
  'কোনটি',
  'কোন',
  'সঠিক',
  'সঠিকটি',
  'উত্তর',
  'এর',
  'হয়',
  'হলো',
  'হবে',
  'কত',
  'কবে',
  'কোথায়',
  'নয়',
  'বলা',
  'একটি',
  'এবং',
  'বা',
  'থেকে',
  'জন্য',
  'সাথে',
  'করে',
  'করা',
  'যায়',
  'থাকে',
  'আছে',
  'হিসেবে',
  'শব্দটির',
  'শব্দের',
  'বাক্যের',
  'কোনটিই',
  'the',
  'is',
  'are',
  'was',
  'were',
  'of',
  'in',
  'to',
  'for',
  'on',
  'at',
  'by',
  'from',
  'with',
  'and',
  'or',
  'an',
  'which',
  'what',
  'who',
  'choose',
  'select',
  'correct',
  'right',
  'following',
  'sentence',
  'word',
]);

function normalizeStemExact(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\u0980-\u09FFa-z0-9]+/g, ' ')
    .trim();
}

function extractDedupContentTokens(stem: string): Set<string> {
  const all = tokenizeBilingual(stem);
  const content = all.filter((tok) => !DEDUP_STOP_WORDS.has(tok));
  return new Set(content.length > 0 ? content : all);
}

/**
 * Deduplicates candidate AI questions against existing Question Bank stems.
 * Uses exact normalized stem matching PLUS boilerplate-filtered content-token Jaccard
 * similarity (>= 0.80) so distinct Bengali/English MCQs like
 * "‘বিদ্যালয়’ এর সঠিক সন্ধি বিচ্ছেদ কোনটি?" vs "‘হিমালয়’ এর সঠিক সন্ধি বিচ্ছেদ কোনটি?"
 * are never falsely rejected as duplicates.
 */
export function deduplicateQuestions<T extends { stem: string }>(
  candidates: T[],
  existingQuestions: Pick<Question, 'stem'>[],
  threshold = 0.8
): T[] {
  const seenExact = new Set<string>(
    existingQuestions.map((q) => normalizeStemExact(q.stem)).filter(Boolean)
  );
  const existingTokenSets = existingQuestions.map((q) =>
    extractDedupContentTokens(q.stem)
  );

  const accepted: T[] = [];
  const acceptedSets: Set<string>[] = [];

  for (const candidate of candidates) {
    const exactKey = normalizeStemExact(candidate.stem);
    if (!exactKey) continue;
    if (seenExact.has(exactKey)) continue;

    const cSet = extractDedupContentTokens(candidate.stem);
    if (cSet.size === 0) continue;

    const isDuplicate = [...existingTokenSets, ...acceptedSets].some((other) => {
      if (other.size === 0) return false;
      // For very short stems (<= 2 content tokens), require identical content tokens
      // so two 1-word grammar prompts never collide on a single shared category word.
      if (Math.min(cSet.size, other.size) <= 2) {
        if (cSet.size !== other.size) return false;
        for (const t of cSet) {
          if (!other.has(t)) return false;
        }
        return true;
      }

      let intersection = 0;
      for (const t of cSet) {
        if (other.has(t)) intersection += 1;
      }
      const union = cSet.size + other.size - intersection;
      return union > 0 && intersection / union >= threshold;
    });

    if (!isDuplicate) {
      seenExact.add(exactKey);
      accepted.push(candidate);
      acceptedSets.push(cSet);
    }
  }

  return accepted;
}
