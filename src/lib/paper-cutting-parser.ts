import type { Book, CurrentGkItem, Question } from '@/src/types/system';
import { toBengaliNumber } from './file-validation';

export const PAPER_CUTTING_SOURCE_PREFIX = 'পেপার কাটিং';
export const PAPER_CUTTING_SUMMARY_MARKER = '[PAPER_CUTTING]';
export const PAPER_CUTTING_QA_HEADER = '--- ছোট প্রশ্ন ও উত্তর ---';
export const PAPER_CUTTING_ALLOWED_CATEGORIES = [
  'জাতীয়',
  'অর্থনীতি',
  'আন্তর্জাতিক',
  'বিজ্ঞান ও প্রযুক্তি',
] as const;

export type PaperCuttingCategory =
  (typeof PAPER_CUTTING_ALLOWED_CATEGORIES)[number];

export interface PaperCuttingShortQA {
  question: string;
  answer: string;
  topicTag?: string;
}

export interface PaperCuttingAnalysisResult {
  headline: string;
  category: PaperCuttingCategory;
  eventDate: string;
  newspaperSource: string;
  keySummary: string;
  shortQAs: PaperCuttingShortQA[];
}

export interface PaperCuttingStorageMeta {
  fileName?: string;
  driveFileId?: string | null;
  driveWebViewLink?: string | null;
}

export interface ParsedPaperCuttingData {
  isPaperCutting: boolean;
  keySummary: string;
  shortQAs: PaperCuttingShortQA[];
  newspaperName: string;
  fileName: string | null;
  driveFileId: string | null;
}

const FIRESTORE_TITLE_MAX = 235;
const FIRESTORE_SUMMARY_MAX = 5800;
const FIRESTORE_SOURCE_MAX = 195;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DRIVE_TAG_RE = /\[driveId:([a-zA-Z0-9_-]{10,120})\]/;

function clampText(value: string, maxLen: number): string {
  const cleaned = value.replace(/\r\n/g, '\n').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

export function normalizePaperCuttingCategory(raw: unknown): PaperCuttingCategory {
  const value = String(raw ?? '').trim();
  if (
    value === 'জাতীয়' ||
    value === 'অর্থনীতি' ||
    value === 'আন্তর্জাতিক' ||
    value === 'বিজ্ঞান ও প্রযুক্তি'
  ) {
    return value;
  }
  const lower = value.toLowerCase();
  if (
    lower.includes('econ') ||
    lower.includes('bank') ||
    lower.includes('trade') ||
    lower.includes('অর্থ') ||
    lower.includes('বাণিজ্য') ||
    lower.includes('ব্যাংক') ||
    lower.includes('বাজেট')
  ) {
    return 'অর্থনীতি';
  }
  if (
    lower.includes('inter') ||
    lower.includes('world') ||
    lower.includes('global') ||
    lower.includes('আন্তর্জাতিক') ||
    lower.includes('বিশ্ব')
  ) {
    return 'আন্তর্জাতিক';
  }
  if (
    lower.includes('sci') ||
    lower.includes('tech') ||
    lower.includes('ict') ||
    lower.includes('বিজ্ঞান') ||
    lower.includes('প্রযুক্তি') ||
    lower.includes('কম্পিউটার')
  ) {
    return 'বিজ্ঞান ও প্রযুক্তি';
  }
  return 'জাতীয়';
}

export function normalizeEventDate(raw: unknown, fallbackDate?: string): string {
  const candidate = String(raw ?? '').trim();
  if (ISO_DATE_RE.test(candidate)) {
    return candidate;
  }
  if (fallbackDate && ISO_DATE_RE.test(fallbackDate.trim())) {
    return fallbackDate.trim();
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Normalizes and sanitizes raw AI JSON output for a newspaper cutting photo.
 */
export function normalizePaperCuttingAnalysis(
  raw: Record<string, unknown>,
  defaults?: {
    fileName?: string;
    newspaperHint?: string;
    eventDateHint?: string;
  }
): PaperCuttingAnalysisResult {
  const fallbackName = (defaults?.fileName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  const headline = clampText(
    String(raw.headline ?? raw.title ?? '').trim() ||
      fallbackName ||
      'পত্রিকার গুরুত্বপূর্ণ তথ্য (পেপার কাটিং)',
    FIRESTORE_TITLE_MAX
  );

  const category = normalizePaperCuttingCategory(raw.category);
  const eventDate = normalizeEventDate(raw.eventDate, defaults?.eventDateHint);

  const newspaperSource = clampText(
    String(raw.newspaperSource ?? raw.source ?? '').trim() ||
      defaults?.newspaperHint?.trim() ||
      'দৈনিক সংবাদপত্র',
    80
  );

  const keySummary = clampText(
    String(raw.keySummary ?? raw.summary ?? '').trim() ||
      'পত্রিকার কাটিং থেকে চাকরির পরীক্ষার উপযোগী গুরুত্বপূর্ণ তথ্য ও ছোট প্রশ্নোত্তর সংগ্রহ করা হয়েছে।',
    1200
  );

  const rawList = Array.isArray(raw.shortQAs)
    ? raw.shortQAs
    : Array.isArray(raw.questions)
      ? raw.questions
      : [];

  const seenQuestions = new Set<string>();
  const shortQAs: PaperCuttingShortQA[] = [];

  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const q = String(obj.question ?? obj.stem ?? '')
      .replace(/^\s*(?:প্রশ্ন\s*)?[\d০-৯]+[.)।:-]\s*/u, '')
      .replace(/\s+/g, ' ')
      .trim();
    const a = String(obj.answer ?? obj.modelAnswer ?? '')
      .replace(/^\s*(?:উত্তর|উঃ|Ans(?:wer)?)\s*[:ঃ.-]\s*/iu, '')
      .replace(/\s+/g, ' ')
      .trim();
    const topicTag = String(obj.topicTag ?? obj.topic ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!q || !a) continue;
    const dedupeKey = q.toLowerCase();
    if (seenQuestions.has(dedupeKey)) continue;
    seenQuestions.add(dedupeKey);

    shortQAs.push({
      question: clampText(q, 280),
      answer: clampText(a, 320),
      ...(topicTag ? { topicTag: clampText(topicTag, 48) } : {}),
    });

    if (shortQAs.length >= 15) break;
  }

  return {
    headline,
    category,
    eventDate,
    newspaperSource,
    keySummary,
    shortQAs,
  };
}

/**
 * Checks whether a CurrentGkItem originated from Paper Cutting.
 */
export function isPaperCuttingGkItem(
  item: Pick<CurrentGkItem, 'source' | 'summary'>
): boolean {
  const src = (item.source ?? '').trim();
  const sum = (item.summary ?? '').trim();
  return (
    src.startsWith(PAPER_CUTTING_SOURCE_PREFIX) ||
    src.toLowerCase().includes('paper cutting') ||
    sum.startsWith(PAPER_CUTTING_SUMMARY_MARKER)
  );
}

/**
 * Serializes a PaperCuttingAnalysisResult into a Firestore-safe CurrentGkItem input.
 * Strictly obeys firestore.rules field length ceilings (title <= 240, summary <= 6000, source <= 200).
 */
export function serializePaperCuttingToGkInput(
  analysis: PaperCuttingAnalysisResult,
  meta?: PaperCuttingStorageMeta
): Omit<CurrentGkItem, 'id' | 'createdAt' | 'convertedToQuestions'> {
  const driveIdClean =
    meta?.driveFileId && /^[a-zA-Z0-9_-]{10,120}$/.test(meta.driveFileId.trim())
      ? meta.driveFileId.trim()
      : null;

  const sourceParts = [PAPER_CUTTING_SOURCE_PREFIX];
  if (analysis.newspaperSource) {
    sourceParts.push(analysis.newspaperSource);
  }
  if (meta?.fileName) {
    sourceParts.push(clampText(meta.fileName.trim(), 48));
  }

  let sourceBase = sourceParts.join(' · ');
  if (driveIdClean) {
    const driveTag = `[driveId:${driveIdClean}]`;
    const maxBase = FIRESTORE_SOURCE_MAX - driveTag.length - 1;
    sourceBase = `${clampText(sourceBase, maxBase)} ${driveTag}`;
  }
  const source = clampText(sourceBase, FIRESTORE_SOURCE_MAX);

  const summaryLines: string[] = [
    PAPER_CUTTING_SUMMARY_MARKER,
    analysis.keySummary.trim(),
  ];

  if (analysis.shortQAs.length > 0) {
    summaryLines.push('');
    summaryLines.push(PAPER_CUTTING_QA_HEADER);
    for (let i = 0; i < analysis.shortQAs.length; i += 1) {
      const qa = analysis.shortQAs[i];
      const tagPart = qa.topicTag ? ` [${qa.topicTag}]` : '';
      const block = `প্রশ্ন ${toBengaliNumber(i + 1)}: ${qa.question}${tagPart}\nউত্তর: ${qa.answer}`;
      const candidate = [...summaryLines, block].join('\n');
      if (candidate.length > FIRESTORE_SUMMARY_MAX) {
        break;
      }
      summaryLines.push(block);
    }
  }

  const summary = clampText(summaryLines.join('\n'), FIRESTORE_SUMMARY_MAX);

  return {
    title: clampText(analysis.headline, FIRESTORE_TITLE_MAX),
    summary,
    category: analysis.category,
    eventDate: analysis.eventDate,
    source,
    isArchived: false,
  };
}

/**
 * Extracts structured keySummary, shortQAs, newspaper name, and Drive file ID
 * from a persisted CurrentGkItem.
 */
export function parsePaperCuttingFromGkItem(
  item: Pick<CurrentGkItem, 'title' | 'summary' | 'source'>
): ParsedPaperCuttingData {
  const isPaperCutting = isPaperCuttingGkItem(item);
  const rawSource = (item.source ?? '').trim();
  const driveMatch = rawSource.match(DRIVE_TAG_RE);
  const driveFileId = driveMatch ? driveMatch[1] : null;

  const sourceWithoutDrive = rawSource.replace(DRIVE_TAG_RE, '').trim();
  const sourceSegments = sourceWithoutDrive
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);

  let newspaperName = 'দৈনিক সংবাদপত্র';
  let fileName: string | null = null;
  if (sourceSegments.length >= 2) {
    newspaperName =
      sourceSegments[0] === PAPER_CUTTING_SOURCE_PREFIX
        ? sourceSegments[1]
        : sourceSegments[0];
    if (sourceSegments.length >= 3) {
      fileName = sourceSegments[2];
    }
  } else if (
    sourceSegments.length === 1 &&
    sourceSegments[0] !== PAPER_CUTTING_SOURCE_PREFIX
  ) {
    newspaperName = sourceSegments[0];
  }

  const rawSummary = (item.summary ?? '').replace(/\r\n/g, '\n').trim();
  const stripped = rawSummary.startsWith(PAPER_CUTTING_SUMMARY_MARKER)
    ? rawSummary.slice(PAPER_CUTTING_SUMMARY_MARKER.length).trim()
    : rawSummary;

  const qaHeaderIndex = stripped.indexOf(PAPER_CUTTING_QA_HEADER);
  if (qaHeaderIndex === -1) {
    return {
      isPaperCutting,
      keySummary: stripped,
      shortQAs: [],
      newspaperName,
      fileName,
      driveFileId,
    };
  }

  const keySummary = stripped.slice(0, qaHeaderIndex).trim();
  const qaBody = stripped
    .slice(qaHeaderIndex + PAPER_CUTTING_QA_HEADER.length)
    .trim();

  const shortQAs: PaperCuttingShortQA[] = [];
  const lines = qaBody
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let currentQuestion: string | null = null;
  let currentTopicTag: string | undefined;

  for (const line of lines) {
    const qMatch = line.match(/^প্রশ্ন\s*[\d০-৯]+\s*[:ঃ.-]\s*(.+)$/u);
    if (qMatch) {
      const rawQ = qMatch[1].trim();
      const tagMatch = rawQ.match(/^(.*?)\s*\[([^\]]{1,48})\]$/);
      if (tagMatch) {
        currentQuestion = tagMatch[1].trim();
        currentTopicTag = tagMatch[2].trim();
      } else {
        currentQuestion = rawQ;
        currentTopicTag = undefined;
      }
      continue;
    }

    const aMatch = line.match(/^(?:উত্তর|উঃ)\s*[:ঃ.-]\s*(.+)$/u);
    if (aMatch && currentQuestion) {
      shortQAs.push({
        question: currentQuestion,
        answer: aMatch[1].trim(),
        ...(currentTopicTag ? { topicTag: currentTopicTag } : {}),
      });
      currentQuestion = null;
      currentTopicTag = undefined;
    }
  }

  return {
    isPaperCutting,
    keySummary,
    shortQAs,
    newspaperName,
    fileName,
    driveFileId,
  };
}

/**
 * Converts a Paper Cutting GK item's short Q&As into Question Bank records (`Short` type).
 */
export function buildShortQuestionsFromPaperCutting(
  item: Pick<CurrentGkItem, 'title' | 'summary' | 'category' | 'eventDate' | 'source'>
): Array<Omit<Question, 'id' | 'createdAt'>> {
  const parsed = parsePaperCuttingFromGkItem(item);
  if (parsed.shortQAs.length === 0) return [];

  return parsed.shortQAs.map((qa) => ({
    bookId: null,
    bookTitle: `পেপার কাটিং (${parsed.newspaperName})`,
    chapter: `${item.category} · ${item.eventDate}${qa.topicTag ? ` · ${qa.topicTag}` : ''}`,
    pageNumber: 1,
    subject: 'সাম্প্রতিক সাধারণ জ্ঞান',
    questionType: 'Short',
    difficulty: 'Medium',
    stem: qa.question,
    options: [],
    correctOptionIndex: null,
    modelAnswer: qa.answer,
    explanation: `উৎস: ${parsed.newspaperName} (${item.eventDate}) — ${item.title}। ${parsed.keySummary}`,
    isPreviousYear: false,
    examYear: null,
    examSource: null,
    importanceScore: 90,
  }));
}

/**
 * Formats an analyzed Paper Cutting photo into clean Smart-Reader / Book Library text
 * with structured Short Q&A pairs and bold-ready answers.
 */
export function formatPaperCuttingForBookChunk(
  analysis: PaperCuttingAnalysisResult,
  meta?: PaperCuttingStorageMeta
): string {
  const lines: string[] = [
    `শিরোনাম: ${analysis.headline}`,
    `উৎস: ${analysis.newspaperSource} · তারিখ: ${analysis.eventDate} · ক্যাটাগরি: ${analysis.category}`,
  ];

  if (meta?.fileName) {
    lines.push(`মূল ছবি: ${meta.fileName}`);
  }

  lines.push('');
  lines.push(`গুরুত্বপূর্ণ সারসংক্ষেপ: ${analysis.keySummary}`);

  if (analysis.shortQAs.length > 0) {
    lines.push('');
    lines.push('গুরুত্বপূর্ণ ছোট প্রশ্ন ও উত্তর:');
    analysis.shortQAs.forEach((qa, idx) => {
      const tagText = qa.topicTag ? ` (${qa.topicTag})` : '';
      lines.push(`${toBengaliNumber(idx + 1)}. ${qa.question}${tagText}`);
      lines.push(`উত্তর: ${qa.answer}`);
      lines.push('');
    });
  }

  return lines.join('\n').trim();
}

/**
 * Formats clean clipboard text for a Paper Cutting item's Short Q&A list.
 */
export function formatPaperCuttingClipboardText(
  item: Pick<CurrentGkItem, 'title' | 'summary' | 'category' | 'eventDate' | 'source'>
): string {
  const parsed = parsePaperCuttingFromGkItem(item);
  const lines: string[] = [
    item.title,
    `ক্যাটাগরি: ${item.category} | তারিখ: ${item.eventDate} | উৎস: ${parsed.newspaperName}`,
    '',
    parsed.keySummary,
  ];
  if (parsed.shortQAs.length > 0) {
    lines.push('');
    lines.push('ছোট প্রশ্ন ও উত্তর:');
    parsed.shortQAs.forEach((qa, idx) => {
      lines.push(`${toBengaliNumber(idx + 1)}. ${qa.question}`);
      lines.push(`উত্তর: ${qa.answer}`);
    });
  }
  return lines.join('\n');
}

/**
 * Returns a set of Google Drive file IDs already imported into either Paper Cutting GK items or Book Library.
 */
export function extractImportedPaperCuttingDriveIds(
  gkItems: ReadonlyArray<Pick<CurrentGkItem, 'source' | 'summary'>>,
  books: ReadonlyArray<Pick<Book, 'driveFileId'>> = []
): Set<string> {
  const ids = new Set<string>();
  for (const item of gkItems) {
    const parsed = parsePaperCuttingFromGkItem({
      title: '',
      source: item.source,
      summary: item.summary,
    });
    if (parsed.driveFileId) {
      ids.add(parsed.driveFileId);
    }
  }
  for (const book of books) {
    if (book.driveFileId) {
      ids.add(book.driveFileId);
    }
  }
  return ids;
}
