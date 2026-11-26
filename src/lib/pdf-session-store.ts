import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SupportedDocumentMimeType } from './file-validation';
import type {
  BatchExtractionResult,
  DocumentTextProfile,
  NormalizedExtractedPage,
  PageMapping,
  PdfOcrSpeed,
} from './pdf-rules';
import type { PdfOcrMode, SplitPdfBatchDescriptor } from './pdf-splitter';

export const PDF_JOBS_BASE_DIR = path.resolve(os.tmpdir(), 'prostuti-pdf-jobs');
export const PDF_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_ACTIVE_SESSIONS_PER_USER = 5;

export class PdfSessionLimitError extends Error {
  constructor(
    message = 'একসাথে সর্বোচ্চ ৫টি সক্রিয় PDF আপলোড সেশন চালু রাখা যাবে। অনুগ্রহ করে চলমান সেশন শেষ বা বাতিল করে আবার চেষ্টা করুন।'
  ) {
    super(message);
    this.name = 'PdfSessionLimitError';
  }
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PdfSessionStatus =
  | 'uploading'
  | 'prepared'
  | 'processing'
  | 'finalized'
  | 'cancelled';

export interface PdfUploadSession {
  sessionId: string;
  ownerDbUserId: number;
  ownerUid: string;
  fileName: string;
  declaredMimeType: string;
  expectedFileSize: number;
  useOcr: boolean;
  ocrMode: PdfOcrMode;
  ocrSpeed: PdfOcrSpeed;
  pageRangeInput: string;
  fallbackChapter: string;
  sessionDir: string;
  sourceFilePath: string;
  status: PdfSessionStatus;
  createdAtMs: number;
  updatedAtMs: number;
  receivedChunkIndices: Set<number>;
  bytesReceived: number;
  nextExpectedChunkIndex: number;
  chunkSizeBytes: number;
  totalChunks: number;
  uploadCompleted: boolean;
  writeInFlight: boolean;
  validatedKind?: 'text' | 'binary';
  validatedMimeType?: SupportedDocumentMimeType;
  actualPageCount?: number;
  originalPageRangeLabel?: string;
  documentProfile?: DocumentTextProfile;
  pagesRequiringOcr?: number[];
  pageMappings?: PageMapping[];
  locallyExtractedPages?: NormalizedExtractedPage[];
  batches?: SplitPdfBatchDescriptor[];
  batchResults: Map<number, BatchExtractionResult>;
  activeAbortControllers: Set<AbortController>;
  activeGeminiFileNames: Set<string>;
}

export type SessionLookupResult =
  | { ok: true; session: PdfUploadSession }
  | { ok: false; status: 400 | 403 | 404; code: string; error: string };

const globalForPdfSessions = globalThis as unknown as {
  __prostutiPdfSessions?: Map<string, PdfUploadSession>;
};

const sessionRegistry: Map<string, PdfUploadSession> =
  globalForPdfSessions.__prostutiPdfSessions ?? new Map<string, PdfUploadSession>();

if (!globalForPdfSessions.__prostutiPdfSessions) {
  globalForPdfSessions.__prostutiPdfSessions = sessionRegistry;
}

export function isValidSessionId(sessionId: string): boolean {
  return UUID_V4_PATTERN.test(sessionId);
}

/**
 * Ensures any generated session or batch path stays strictly inside PDF_JOBS_BASE_DIR.
 */
export function assertConfinedTempPath(targetPath: string): string {
  const resolvedBase = path.resolve(PDF_JOBS_BASE_DIR);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error('Unsafe temporary file path outside sandbox directory.');
  }
  return resolvedTarget;
}

export async function removeDirectorySafe(dirPath: string): Promise<void> {
  const safePath = assertConfinedTempPath(dirPath);
  await fs.rm(safePath, { recursive: true, force: true }).catch(() => {
    // Ignore already-deleted paths during concurrent cleanup
  });
}

export async function removeFileSafe(filePath: string): Promise<void> {
  const safePath = assertConfinedTempPath(filePath);
  await fs.rm(safePath, { force: true }).catch(() => {
    // Ignore already-deleted paths
  });
}

/**
 * Deletes expired in-memory sessions and their temporary directories on disk.
 */
export async function cleanupExpiredPdfSessions(
  nowMs: number = Date.now(),
  deleteRemoteGeminiFile?: (fileName: string) => Promise<void>
): Promise<number> {
  let cleaned = 0;
  for (const [id, session] of sessionRegistry.entries()) {
    if (nowMs - session.updatedAtMs > PDF_SESSION_TTL_MS) {
      session.status = 'cancelled';
      for (const ctrl of session.activeAbortControllers) {
        ctrl.abort(new Error('PDF processing session expired.'));
      }
      session.activeAbortControllers.clear();
      if (deleteRemoteGeminiFile && session.activeGeminiFileNames.size > 0) {
        const names = Array.from(session.activeGeminiFileNames);
        session.activeGeminiFileNames.clear();
        await Promise.allSettled(names.map((name) => deleteRemoteGeminiFile(name)));
      } else {
        session.activeGeminiFileNames.clear();
      }
      sessionRegistry.delete(id);
      await removeDirectorySafe(session.sessionDir);
      cleaned += 1;
    }
  }
  return cleaned;
}

export async function createPdfUploadSession(params: {
  ownerDbUserId: number;
  ownerUid: string;
  fileName: string;
  declaredMimeType: string;
  expectedFileSize: number;
  chunkSizeBytes: number;
  totalChunks: number;
  useOcr: boolean;
  ocrMode?: PdfOcrMode;
  ocrSpeed?: PdfOcrSpeed;
  pageRangeInput?: string;
  fallbackChapter?: string;
}): Promise<PdfUploadSession> {
  await cleanupExpiredPdfSessions();

  // Strictly bound per-user concurrent active sessions to prevent disk/resource exhaustion
  const userSessions = Array.from(sessionRegistry.values()).filter(
    (s) => s.ownerDbUserId === params.ownerDbUserId && s.status !== 'cancelled' && s.status !== 'finalized'
  );

  if (userSessions.length >= MAX_ACTIVE_SESSIONS_PER_USER) {
    throw new PdfSessionLimitError();
  }

  const sessionId = crypto.randomUUID();
  const sessionDir = assertConfinedTempPath(path.join(PDF_JOBS_BASE_DIR, sessionId));
  const sourceFilePath = assertConfinedTempPath(path.join(sessionDir, 'source.bin'));

  await fs.mkdir(sessionDir, { recursive: true });

  const now = Date.now();
  const session: PdfUploadSession = {
    sessionId,
    ownerDbUserId: params.ownerDbUserId,
    ownerUid: params.ownerUid,
    fileName: params.fileName.trim().slice(0, 240) || 'document.pdf',
    declaredMimeType: params.declaredMimeType.trim().slice(0, 120),
    expectedFileSize: params.expectedFileSize,
    chunkSizeBytes: params.chunkSizeBytes,
    totalChunks: params.totalChunks,
    uploadCompleted: false,
    writeInFlight: false,
    useOcr: Boolean(params.useOcr),
    ocrMode: params.ocrMode ?? 'auto',
    ocrSpeed: params.ocrSpeed ?? 'accurate',
    pageRangeInput: (params.pageRangeInput ?? '').trim().slice(0, 80),
    fallbackChapter: (params.fallbackChapter ?? '').trim().slice(0, 160) || 'অধ্যায় ১',
    sessionDir,
    sourceFilePath,
    status: 'uploading',
    createdAtMs: now,
    updatedAtMs: now,
    receivedChunkIndices: new Set<number>(),
    bytesReceived: 0,
    nextExpectedChunkIndex: 0,
    batchResults: new Map<number, BatchExtractionResult>(),
    activeAbortControllers: new Set<AbortController>(),
    activeGeminiFileNames: new Set<string>(),
  };

  sessionRegistry.set(sessionId, session);
  return session;
}

/**
 * Retrieves an upload session strictly verifying both UUID format and owner authorization.
 */
export function getOwnedPdfSession(
  sessionId: string,
  requesterDbUserId: number
): SessionLookupResult {
  if (!isValidSessionId(sessionId)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SESSION_ID',
      error: 'অবৈধ আপলোড সেশন আইডি। অনুগ্রহ করে ফাইলটি পুনরায় নির্বাচন করুন।',
    };
  }

  const session = sessionRegistry.get(sessionId);
  if (!session) {
    return {
      ok: false,
      status: 404,
      code: 'SESSION_NOT_FOUND',
      error: 'আপলোড সেশনটি পাওয়া যায়নি অথবা ইতিমধ্যে বাতিল/সম্পন্ন হয়েছে।',
    };
  }

  if (session.ownerDbUserId !== requesterDbUserId) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN_SESSION',
      error: 'এই আপলোড সেশনটি অ্যাক্সেস করার অনুমতি আপনার নেই।',
    };
  }

  session.updatedAtMs = Date.now();
  return { ok: true, session };
}

/**
 * Cancels any active work for the session, optionally deletes any uploaded Gemini
 * temporary files, removes local temporary files from disk, and unregisters the session.
 */
export async function cleanupAndDeletePdfSession(
  sessionId: string,
  deleteRemoteGeminiFile?: (fileName: string) => Promise<void>
): Promise<boolean> {
  const session = sessionRegistry.get(sessionId);
  if (!session) {
    return false;
  }

  session.status = 'cancelled';
  for (const ctrl of session.activeAbortControllers) {
    ctrl.abort(new Error('PDF upload/extraction cancelled by user.'));
  }
  session.activeAbortControllers.clear();

  if (deleteRemoteGeminiFile && session.activeGeminiFileNames.size > 0) {
    const names = Array.from(session.activeGeminiFileNames);
    session.activeGeminiFileNames.clear();
    await Promise.allSettled(names.map((name) => deleteRemoteGeminiFile(name)));
  } else {
    session.activeGeminiFileNames.clear();
  }

  sessionRegistry.delete(sessionId);
  await removeDirectorySafe(session.sessionDir);
  return true;
}

/**
 * Creates a standalone temporary working directory for single-request extractions
 * (e.g. direct POST /api/ai/extract-pdf) that is always cleaned up in a finally block.
 */
export async function createEphemeralJobDir(): Promise<string> {
  const id = `ephemeral-${crypto.randomUUID()}`;
  const dir = assertConfinedTempPath(path.join(PDF_JOBS_BASE_DIR, id));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function getActivePdfSessionCountForTesting(): number {
  return sessionRegistry.size;
}
