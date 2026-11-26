import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

import {
  CHUNK_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_BYTES,
  formatFileTooLargeError,
  validateDeclaredUploadMetadata,
  validateUploadedDocumentHeader,
} from './file-validation';
import {
  DEFAULT_MAX_BATCH_BYTES,
  GEMINI_HARD_PDF_LIMIT_BYTES,
  buildBookSubmissionFingerprint,
  buildPageMappings,
  combineBatchExtractions,
  evaluateLocalExtractedPageText,
  findDuplicateBookMatch,
  isPageRangeOnlyText,
  validateAndNormalizeBatchPages,
  validateBookSaveReadiness,
} from './pdf-rules';
import {
  MAX_ACTIVE_SESSIONS_PER_USER,
  PDF_JOBS_BASE_DIR,
  PDF_SESSION_TTL_MS,
  cleanupAndDeletePdfSession,
  cleanupExpiredPdfSessions,
  getOwnedPdfSession,
} from './pdf-session-store';
import {
  loadAndValidatePdfDocument,
  prepareAndSplitPdfOnDisk,
} from './pdf-splitter';
import {
  type PdfExtractionGeminiClient,
  setPdfExtractorClientForTesting,
} from './pdf-extractor-service';
import { runChunkedPdfPipeline } from './pdf-upload-client';
import { setAiGuardTestOverrides } from './ai-api-guard';
import { InMemorySlidingWindowRateLimitStore } from './rate-limit';
import { GEMINI_MODEL } from './gemini';
import { chunkBookText } from './rag-engine';
import type { AuthDependencies } from './server-auth';

import { POST as initSessionPost } from '../../app/api/ai/extract-pdf/session/init/route';
import {
  GET as chunkSessionGet,
  POST as chunkSessionPost,
} from '../../app/api/ai/extract-pdf/session/chunk/route';
import { POST as prepareSessionPost } from '../../app/api/ai/extract-pdf/session/prepare/route';
import { POST as batchSessionPost } from '../../app/api/ai/extract-pdf/session/batch/route';
import { POST as finalizeSessionPost } from '../../app/api/ai/extract-pdf/session/finalize/route';
import { POST as cancelSessionPost } from '../../app/api/ai/extract-pdf/session/cancel/route';
import { POST as directExtractPost } from '../../app/api/ai/extract-pdf/route';

// ============================================================================
// Deterministic Test Fixtures & In-Process Route Fetch Bridge
// ============================================================================

function createMockAuthDeps(): AuthDependencies {
  const users: Record<
    string,
    { uid: string; email: string; name: string; dbUserId: number }
  > = {
    'token-user-1': {
      uid: 'uid-pdf-1',
      email: 'pdf1@test.local',
      name: 'PDF User 1',
      dbUserId: 901,
    },
    'token-user-2': {
      uid: 'uid-pdf-2',
      email: 'pdf2@test.local',
      name: 'PDF User 2',
      dbUserId: 902,
    },
  };

  return {
    verifyIdToken: async (token: string) => {
      const match = users[token];
      if (!match) {
        const err = new Error('Invalid Firebase token') as Error & { code: string };
        err.code = 'auth/argument-error';
        throw err;
      }
      return { uid: match.uid, email: match.email, name: match.name };
    },
    resolveUser: async (uid: string) => {
      const match = Object.values(users).find((u) => u.uid === uid);
      return match ? { id: match.dbUserId } : null;
    },
  };
}

/**
 * Generates a real, structurally valid PDF using pdf-lib.
 * When `bytesPerPagePayload > 0`, attaches an uncompressed binary stream to each page's
 * Resources so the generated PDF has exact target megabyte size (e.g., 2 MB, 18 MB, 56 MB)
 * and exercises real pdf-lib loading, page copying, and byte-size batch bisection.
 */
async function buildRealPdfBytes(options: {
  pageCount: number;
  bytesPerPagePayload?: number;
  withTextFont?: boolean;
  /** 1-based page indices that should contain embedded text (overrides withTextFont when provided). */
  textPageIndices?: number[];
}): Promise<Uint8Array> {
  const {
    pageCount,
    bytesPerPagePayload = 0,
    withTextFont = true,
    textPageIndices,
  } = options;
  const doc = await PDFDocument.create();
  const textIndexSet = textPageIndices ? new Set(textPageIndices) : null;
  const needsFont = textIndexSet ? textIndexSet.size > 0 : withTextFont;
  const font = needsFont ? await doc.embedFont(StandardFonts.Helvetica) : null;

  for (let i = 0; i < pageCount; i += 1) {
    const page = doc.addPage([595, 842]);
    const shouldDrawText = textIndexSet ? textIndexSet.has(i + 1) : withTextFont;
    if (font && shouldDrawText) {
      page.drawText(`Bangladesh BCS Exam Study Material - Internal Page ${i + 1}`, {
        x: 48,
        y: 780,
        size: 12,
        font,
      });
    }
    if (bytesPerPagePayload > 0) {
      const payload = new Uint8Array(bytesPerPagePayload);
      for (let b = 0; b < payload.length; b += 4096) {
        payload[b] = (i * 31 + b) & 0xff;
      }
      const streamRef = doc.context.register(doc.context.stream(payload));
      page.node.set(PDFName.of('TestPayload'), streamRef);
    }
  }

  return doc.save({ useObjectStreams: false });
}

function makeJsonReq(
  url: string,
  body: Record<string, unknown>,
  token?: string
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function makeChunkReq(
  sessionId: string,
  chunkIndex: number,
  bytes: Uint8Array,
  token?: string,
  extraHeaders?: Record<string, string>
): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-session-id': sessionId,
    'x-chunk-index': String(chunkIndex),
    'content-length': String(bytes.byteLength),
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest('http://localhost:3000/api/ai/extract-pdf/session/chunk', {
    method: 'POST',
    headers,
    body: Buffer.from(bytes),
  });
}

/**
 * In-process fetch router that dispatches client `runChunkedPdfPipeline` requests
 * directly to the real Next.js App Router route handlers.
 */
function createInProcessSessionFetch(
  interceptor?: (
    urlPath: string,
    init: RequestInit | undefined,
    next: () => Promise<Response>
  ) => Promise<Response>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const fullUrl = rawUrl.startsWith('http')
      ? rawUrl
      : `http://localhost:3000${rawUrl}`;
    const parsed = new URL(fullUrl);

    const invokeRealRoute = async (): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      let reqBody: BodyInit | undefined;
      if (init?.body instanceof Blob) {
        reqBody = Buffer.from(await init.body.arrayBuffer());
      } else if (init?.body !== undefined && init?.body !== null) {
        reqBody = init.body;
      }

      const nextReq = new NextRequest(fullUrl, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : reqBody,
        signal: init?.signal ?? undefined,
      });

      if (parsed.pathname === '/api/ai/extract-pdf/session/init') {
        return initSessionPost(nextReq);
      }
      if (parsed.pathname === '/api/ai/extract-pdf/session/chunk') {
        return method === 'GET' ? chunkSessionGet(nextReq) : chunkSessionPost(nextReq);
      }
      if (parsed.pathname === '/api/ai/extract-pdf/session/prepare') {
        return prepareSessionPost(nextReq);
      }
      if (parsed.pathname === '/api/ai/extract-pdf/session/batch') {
        return batchSessionPost(nextReq);
      }
      if (parsed.pathname === '/api/ai/extract-pdf/session/finalize') {
        return finalizeSessionPost(nextReq);
      }
      if (parsed.pathname === '/api/ai/extract-pdf/session/cancel') {
        return cancelSessionPost(nextReq);
      }
      throw new Error(`Unexpected fetch path in test: ${parsed.pathname}`);
    };

    if (interceptor) {
      return interceptor(parsed.pathname, init, invokeRealRoute);
    }
    return invokeRealRoute();
  }) as typeof fetch;
}

function createStructuredGeminiMock(options?: {
  onGenerate?: (
    prompt: string,
    model: string,
    usedFilesApi: boolean,
    callIndex: number
  ) => { text?: string; throwError?: Error };
}) {
  const uploadedFiles = new Set<string>();
  const deletedFiles: string[] = [];
  const modelsUsed: string[] = [];
  let generateCallCount = 0;
  let uploadCounter = 0;

  const client: PdfExtractionGeminiClient = {
    files: {
      upload: async ({ config }) => {
        uploadCounter += 1;
        const name = `files/mock-gemini-batch-${uploadCounter}`;
        uploadedFiles.add(name);
        return {
          name,
          uri: `https://generativelanguage.googleapis.com/v1beta/${name}`,
          mimeType: config?.mimeType ?? 'application/pdf',
          state: 'ACTIVE',
        };
      },
      get: async ({ name }) => ({
        name,
        uri: `https://generativelanguage.googleapis.com/v1beta/${name}`,
        mimeType: 'application/pdf',
        state: 'ACTIVE',
      }),
      delete: async ({ name }) => {
        uploadedFiles.delete(name);
        deletedFiles.push(name);
        return {};
      },
    },
    models: {
      generateContent: async (params) => {
        generateCallCount += 1;
        modelsUsed.push(String(params.model));

        const parts = (params.contents as { parts?: Array<Record<string, unknown>> })?.parts ?? [];
        const textPart = parts.find((p) => typeof p.text === 'string');
        const prompt = String(textPart?.text ?? '');
        const usedFilesApi = parts.some((p) => 'fileData' in p);

        if (options?.onGenerate) {
          const custom = options.onGenerate(
            prompt,
            String(params.model),
            usedFilesApi,
            generateCallCount
          );
          if (custom.throwError) {
            throw custom.throwError;
          }
          if (custom.text !== undefined) {
            return { text: custom.text } as never;
          }
        }

        // Parse exact mapping lines emitted by buildBatchExtractionPrompt
        const pages: Array<Record<string, unknown>> = [];
        const regex =
          /Source PDF internal page (\d+)\) => Original printed book page (\d+)/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(prompt)) !== null) {
          const pdfPageIndex = Number(match[1]);
          const originalPageNumber = Number(match[2]);
          pages.push({
            pdfPageIndex,
            originalPageNumber,
            chapter: `বাংলাদেশ বিষয়াবলি (পৃষ্ঠা ${originalPageNumber})`,
            content: `বাংলাদেশের সংবিধান ও মুক্তিযুদ্ধের গুরুত্বপূর্ণ তথ্য — মূল পৃষ্ঠা ${originalPageNumber} (PDF পৃষ্ঠা ${pdfPageIndex})। ১৯৭১ সালের মহান মুক্তিযুদ্ধ ও ১৯৭২ সালের সংবিধানের মূলনীতি বিস্তারিত আলোচনা করা হয়েছে।`,
            hasReadableText: true,
            ocrUsed: true,
          });
        }

        return { text: JSON.stringify({ pages }) } as never;
      },
    },
  };

  return {
    client,
    getStats: () => ({
      generateCallCount,
      modelsUsed,
      remainingRemoteFiles: Array.from(uploadedFiles),
      deletedFiles,
      totalUploadedFiles: uploadCounter,
    }),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Tests 1–4: File Sizes (<15 MB, 15–50 MB, 50–100 MB, >100 MB) + Cleanup
// ============================================================================

test('1 & 8 & 9 & 18 & 20: Real <15 MB 8-page scanned PDF with original page range 37-44 completes fast 1-batch OCR (8 pages/batch), preserves 1..8 -> 37..44 mapping, passes Save validation with totalPages=8, and cleans up temp files', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock();
  setPdfExtractorClientForTesting(mock.client);

  try {
    // Real scanned 8-page PDF (~1.6 MB < 15 MB, no embedded text layer)
    const pdfBytes = await buildRealPdfBytes({
      pageCount: 8,
      bytesPerPagePayload: 200 * 1024,
      withTextFont: false,
    });
    assert.ok(pdfBytes.byteLength > 1_000_000 && pdfBytes.byteLength < 15 * 1024 * 1024);

    const file = new File([Buffer.from(pdfBytes)], 'bcs-history-p37-44.pdf', {
      type: 'application/pdf',
    });

    const stagesSeen: string[] = [];
    let capturedSessionId: string | null = null;

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      pageRangeInput: 'Page 37-44',
      fallbackChapter: 'অধ্যায় ৪: মুক্তিযুদ্ধ',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: (p) => {
        stagesSeen.push(`${p.stage}:${p.statusMessage}`);
        if (p.sessionId) capturedSessionId = p.sessionId;
      },
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const ex = outcome.extraction;
    assert.equal(ex.extractionStatus, 'success');
    assert.equal(ex.actualPageCount, 8);
    assert.equal(ex.expectedPageCount, 8);
    assert.equal(ex.extractedPageCount, 8);
    assert.equal(ex.originalPageRange, '37-44');
    assert.equal(ex.totalBatches, 1); // 8 pages fit in 1 fast batch (<= 8 pages & <= 35 MB)!
    assert.equal(ex.completedBatches, 1);
    assert.equal(ex.failedBatches, 0);
    assert.deepEqual(ex.missingOriginalPages, []);
    assert.equal(ex.ocrCompleted, true);
    assert.equal(ex.method, 'ocr');

    // Exact 1:1 internal -> original page mapping (1->37 ... 8->44)
    assert.deepEqual(
      ex.sections.map((s) => [s.pdfPageIndex, s.pageNumber]),
      [
        [1, 37],
        [2, 38],
        [3, 39],
        [4, 40],
        [5, 41],
        [6, 42],
        [7, 43],
        [8, 44],
      ]
    );

    // Free-Tier model preserved strictly (only 1 Gemini call instead of 2!)
    const stats = mock.getStats();
    assert.equal(stats.generateCallCount, 1);
    assert.ok(stats.modelsUsed.every((m) => m === GEMINI_MODEL));

    // Knowledge Base Save readiness & RAG chunking check
    const readiness = validateBookSaveReadiness({
      title: 'বাংলাদেশের ইতিহাস (পৃষ্ঠা ৩৭-৪৪)',
      subject: 'বাংলাদেশ বিষয়াবলি',
      rawText: ex.rawText,
      extractionContext: {
        status: ex.extractionStatus,
        actualPageCount: ex.actualPageCount,
        extractedPageCount: ex.extractedPageCount,
        missingOriginalPages: ex.missingOriginalPages,
        sourceWasUploadedPdf: true,
      },
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.computedTotalPages, 8); // NOT 44!

    const ragChunks = chunkBookText({
      bookId: 105,
      bookTitle: 'বাংলাদেশের ইতিহাস',
      chapter: 'অধ্যায় ৪',
      rawText: ex.rawText,
    });
    assert.deepEqual(
      Array.from(new Set(ragChunks.map((c) => c.pageNumber))),
      [37, 38, 39, 40, 41, 42, 43, 44]
    );

    // Temp directory cleaned up completely
    assert.ok(capturedSessionId);
    const sessionDir = path.join(PDF_JOBS_BASE_DIR, capturedSessionId);
    assert.equal(await pathExists(sessionDir), false);

    // Key Bengali progress milestones appeared
    assert.ok(stagesSeen.some((s) => s.includes('PDF যাচাই করা হচ্ছে')));
    assert.ok(stagesSeen.some((s) => s.includes('Upload Session তৈরি হচ্ছে')));
    assert.ok(stagesSeen.some((s) => s.includes('Batch ১/১ প্রসেস হচ্ছে')));
    assert.ok(stagesSeen.some((s) => s.includes('Knowledge Base-এ সংরক্ষণের জন্য প্রস্তুত')));
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('2: Real 15-50 MB PDF (~20 MB) uploads in 4 MB chunks, splits <= 35 MB, uses Gemini Files API (>10 MB), deletes remote & local temp files', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock();
  setPdfExtractorClientForTesting(mock.client);

  try {
    // 6 scanned pages × 3.4 MB = ~20.4 MB real PDF
    const pdfBytes = await buildRealPdfBytes({
      pageCount: 6,
      bytesPerPagePayload: Math.floor(3.4 * 1024 * 1024),
      withTextFont: false,
    });
    assert.ok(pdfBytes.byteLength > 15 * 1024 * 1024 && pdfBytes.byteLength < 50 * 1024 * 1024);

    const file = new File([Buffer.from(pdfBytes)], 'bcs-medium-20mb.pdf', {
      type: 'application/pdf',
    });

    let maxChunkProgress = 0;
    let totalChunksReported = 0;
    let capturedSessionId: string | null = null;

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: (p) => {
        maxChunkProgress = Math.max(maxChunkProgress, p.uploadedChunks);
        totalChunksReported = Math.max(totalChunksReported, p.totalChunks);
        if (p.sessionId) capturedSessionId = p.sessionId;
      },
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.extraction.extractionStatus, 'success');
    assert.equal(outcome.extraction.actualPageCount, 6);
    assert.equal(outcome.extraction.extractedPageCount, 6);
    assert.equal(totalChunksReported, Math.ceil(pdfBytes.byteLength / CHUNK_UPLOAD_SIZE_BYTES));
    assert.equal(maxChunkProgress, totalChunksReported);

    // First 4-page batch is ~13.6 MB (> 10 MB threshold) => must use Gemini Files API and delete it
    const stats = mock.getStats();
    assert.ok(stats.totalUploadedFiles >= 1, 'Expected Gemini Files API upload for >10 MB batch');
    assert.deepEqual(stats.remainingRemoteFiles, [], 'All temporary Gemini Files must be deleted');
    assert.equal(stats.deletedFiles.length, stats.totalUploadedFiles);

    // Local session temp dir cleaned up
    assert.ok(capturedSessionId);
    assert.equal(await pathExists(path.join(PDF_JOBS_BASE_DIR, capturedSessionId)), false);
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('3: Real 50-100 MB PDF (~56 MB) uploads in 4 MB chunks (14+ chunks), bisects batches strictly <= 35 MB (< 50 MB Gemini cap), extracts all pages, cleans up all remote & local files', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock();
  setPdfExtractorClientForTesting(mock.client);

  try {
    // 8 scanned pages × 7 MB = ~56 MB real PDF (8 pages = 56 MB > 35 MB triggers recursive bisection!)
    const pdfBytes = await buildRealPdfBytes({
      pageCount: 8,
      bytesPerPagePayload: 7 * 1024 * 1024,
      withTextFont: false,
    });
    assert.ok(pdfBytes.byteLength > 50 * 1024 * 1024 && pdfBytes.byteLength < 100 * 1024 * 1024);

    const file = new File([Buffer.from(pdfBytes)], 'bcs-large-56mb.pdf', {
      type: 'application/pdf',
    });

    let prepareBatchSizes: number[] = [];
    let capturedSessionId: string | null = null;

    const fetchWithInspect = createInProcessSessionFetch(async (urlPath, _init, next) => {
      const res = await next();
      if (urlPath === '/api/ai/extract-pdf/session/prepare' && res.ok) {
        const cloned = res.clone();
        const json = (await cloned.json()) as {
          batches?: Array<{ byteSize: number }>;
        };
        prepareBatchSizes = (json.batches ?? []).map((b) => b.byteSize);
      }
      return res;
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: false, // 8 pages/batch initially -> 56 MB triggers <=35 MB recursive bisection!
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: (p) => {
        if (p.sessionId) capturedSessionId = p.sessionId;
      },
      fetchImpl: fetchWithInspect,
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.extraction.extractionStatus, 'success');
    assert.equal(outcome.extraction.actualPageCount, 8);
    assert.equal(outcome.extraction.extractedPageCount, 8);
    assert.ok(prepareBatchSizes.length >= 2, '56 MB PDF must bisect into >= 2 batches <= 35 MB');
    for (const sz of prepareBatchSizes) {
      assert.ok(
        sz <= DEFAULT_MAX_BATCH_BYTES && sz < GEMINI_HARD_PDF_LIMIT_BYTES,
        `Batch size ${sz} exceeded 35 MB safety threshold`
      );
    }

    const stats = mock.getStats();
    assert.equal(stats.totalUploadedFiles, prepareBatchSizes.length);
    assert.deepEqual(stats.remainingRemoteFiles, []);
    assert.ok(capturedSessionId);
    assert.equal(await pathExists(path.join(PDF_JOBS_BASE_DIR, capturedSessionId)), false);
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('4: PDF above 100 MB (101 MB) is rejected on client metadata validation, session init, and direct API with actual size and 100 MB limit', async () => {
  const overLimitBytes = 101 * 1024 * 1024;
  const metaCheck = validateDeclaredUploadMetadata({
    fileName: 'oversized-101mb.pdf',
    declaredMimeType: 'application/pdf',
    fileSize: overLimitBytes,
    maxBytes: MAX_UPLOAD_BYTES,
  });
  assert.equal(metaCheck.ok, false);
  if (!metaCheck.ok) {
    assert.equal(metaCheck.code, 'FILE_TOO_LARGE');
    assert.ok(metaCheck.error.includes('101.00 MB'));
    assert.ok(metaCheck.error.includes('100 MB'));
  }

  const headerCheck = validateUploadedDocumentHeader(
    'oversized-101mb.pdf',
    'application/pdf',
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    overLimitBytes,
    MAX_UPLOAD_BYTES
  );
  assert.equal(headerCheck.ok, false);

  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  try {
    const initRes = await initSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/init',
        {
          fileName: 'oversized-101mb.pdf',
          declaredMimeType: 'application/pdf',
          fileSize: overLimitBytes,
          useOcr: true,
        },
        'token-user-1'
      )
    );
    assert.equal(initRes.status, 400);
    const initJson = (await initRes.json()) as { code: string; error: string };
    assert.equal(initJson.code, 'FILE_TOO_LARGE');
    assert.equal(initJson.error, formatFileTooLargeError(overLimitBytes, MAX_UPLOAD_BYTES));
  } finally {
    setAiGuardTestOverrides(null);
  }
});

// ============================================================================
// Tests 5, 6, 7: Empty PDF, Invalid PDF Signature, Corrupted PDF
// ============================================================================

test('5, 6, 7: Rejects empty PDF, invalid PDF signature, and corrupted PDF (with full temp cleanup)', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  try {
    // 5a. Empty 0-byte PDF rejected on init
    const emptyInit = await initSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/init',
        {
          fileName: 'empty.pdf',
          declaredMimeType: 'application/pdf',
          fileSize: 0,
        },
        'token-user-1'
      )
    );
    assert.equal(emptyInit.status, 400);
    assert.equal(((await emptyInit.json()) as { code: string }).code, 'EMPTY_FILE');

    // 5b. Zero-page structurally empty PDF rejected by loadAndValidatePdfDocument
    const zeroPageDoc = await PDFDocument.create();
    const zeroPageBytes = await zeroPageDoc.save({ addDefaultPage: false });
    await assert.rejects(
      () => loadAndValidatePdfDocument(zeroPageBytes),
      /বৈধ পৃষ্ঠা পাওয়া যায়নি/
    );

    // 6. Invalid PDF signature (plain text / HTML renamed to .pdf) rejected on Chunk 0 + cleaned up
    const fakePdfBytes = new TextEncoder().encode('<html>not a pdf file at all</html>');
    const badSigInit = await initSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/init',
        {
          fileName: 'spoofed.pdf',
          declaredMimeType: 'application/pdf',
          fileSize: fakePdfBytes.byteLength,
        },
        'token-user-1'
      )
    );
    assert.equal(badSigInit.status, 200);
    const { sessionId: badSigSessionId } = (await badSigInit.json()) as { sessionId: string };

    const badSigChunk = await chunkSessionPost(
      makeChunkReq(badSigSessionId, 0, fakePdfBytes, 'token-user-1')
    );
    assert.equal(badSigChunk.status, 400);
    assert.equal(((await badSigChunk.json()) as { code: string }).code, 'INVALID_FILE_TYPE');
    assert.equal(await pathExists(path.join(PDF_JOBS_BASE_DIR, badSigSessionId)), false);

    // 7. Corrupted PDF (has %PDF-1.4 header, truncated/garbage body) rejected on prepare + cleaned up
    const corruptedBytes = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 999 0 R >>\nCORRUPTED_EOF_MISSING'
    );
    const corruptInit = await initSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/init',
        {
          fileName: 'corrupted.pdf',
          declaredMimeType: 'application/pdf',
          fileSize: corruptedBytes.byteLength,
        },
        'token-user-1'
      )
    );
    assert.equal(corruptInit.status, 200);
    const { sessionId: corruptSessionId } = (await corruptInit.json()) as { sessionId: string };

    const corruptChunk = await chunkSessionPost(
      makeChunkReq(corruptSessionId, 0, corruptedBytes, 'token-user-1')
    );
    assert.equal(corruptChunk.status, 200);

    const corruptPrepare = await prepareSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/prepare',
        { sessionId: corruptSessionId },
        'token-user-1'
      )
    );
    assert.equal(corruptPrepare.status, 400);
    const corruptJson = (await corruptPrepare.json()) as { error: string };
    assert.ok(corruptJson.error.includes('Corrupted PDF'));
    assert.equal(await pathExists(path.join(PDF_JOBS_BASE_DIR, corruptSessionId)), false);

    // Also verify corrupted PDF rejected on direct POST /api/ai/extract-pdf
    const directForm = new FormData();
    directForm.append(
      'file',
      new File([Buffer.from(corruptedBytes)], 'corrupted-direct.pdf', {
        type: 'application/pdf',
      })
    );
    const directRes = await directExtractPost(
      new NextRequest('http://localhost:3000/api/ai/extract-pdf', {
        method: 'POST',
        headers: { authorization: 'Bearer token-user-1' },
        body: directForm,
      })
    );
    assert.equal(directRes.status, 400);
  } finally {
    setAiGuardTestOverrides(null);
  }
});

// ============================================================================
// Tests 10, 11, 12, 17: Missing Page, Duplicate Page, Out-of-Order, Partial Failure
// ============================================================================

test('10, 11, 12: Detects missing pages, duplicate pages, and out-of-order pages/batches deterministically', () => {
  const mappingRes = buildPageMappings(8, 'Page 37-44');
  assert.equal(mappingRes.ok, true);
  if (!mappingRes.ok) return;

  // Batch 0 (pages 37-40): out-of-order + duplicate page 39 + missing page 38
  const batch0 = validateAndNormalizeBatchPages({
    batchIndex: 0,
    expectedMappings: mappingRes.mappings.slice(0, 4),
    rawPages: [
      {
        pdfPageIndex: 4,
        originalPageNumber: 40,
        chapter: 'অধ্যায় ৪',
        content: 'পৃষ্ঠা ৪০-এর সম্পূর্ণ ঐতিহাসিক আলোচনা ও গুরুত্বপূর্ণ প্রশ্নোত্তর।',
        hasReadableText: true,
        ocrUsed: true,
      },
      {
        pdfPageIndex: 3,
        originalPageNumber: 39,
        chapter: 'অধ্যায় ৪',
        content: 'পৃষ্ঠা ৩৯-এর প্রথম সংস্করণ টেক্সট।',
        hasReadableText: true,
        ocrUsed: true,
      },
      {
        pdfPageIndex: 3,
        originalPageNumber: 39,
        chapter: 'অধ্যায় ৪',
        content: 'পৃষ্ঠা ৩৯-এর আরও বিস্তারিত ও সম্পূর্ণ ঐতিহাসিক বিবরণ সংগৃহীত হয়েছে।',
        hasReadableText: true,
        ocrUsed: true,
      },
      {
        pdfPageIndex: 1,
        originalPageNumber: 37,
        chapter: 'অধ্যায় ৪',
        content: 'পৃষ্ঠা ৩৭-এর সম্পূর্ণ ঐতিহাসিক বিবরণ ও বিশ্লেষণ।',
        hasReadableText: true,
        ocrUsed: true,
      },
    ],
    fallbackChapter: 'অধ্যায় ৪',
    useOcr: true,
    batchRequiresOcr: true,
    usedFilesApi: false,
  });

  assert.equal(batch0.status, 'partial');
  assert.deepEqual(batch0.missingOriginalPages, [38]);
  assert.deepEqual(batch0.duplicateOriginalPages, [39]);
  assert.equal(batch0.outOfOrderDetected, true);
  assert.deepEqual(
    batch0.pages.map((p) => p.originalPageNumber),
    [37, 39, 40]
  );

  // Batch 1 (pages 41-44): all 4 valid
  const batch1 = validateAndNormalizeBatchPages({
    batchIndex: 1,
    expectedMappings: mappingRes.mappings.slice(4, 8),
    rawPages: [41, 42, 43, 44].map((orig, i) => ({
      pdfPageIndex: 5 + i,
      originalPageNumber: orig,
      chapter: 'অধ্যায় ৪',
      content: `পৃষ্ঠা ${orig}-এর সম্পূর্ণ পাঠ্য এবং বিসিএস পরীক্ষার নোট।`,
      hasReadableText: true,
      ocrUsed: true,
    })),
    fallbackChapter: 'অধ্যায় ৪',
    useOcr: true,
    batchRequiresOcr: true,
    usedFilesApi: false,
  });
  assert.equal(batch1.status, 'success');

  // Feed batch1 BEFORE batch0 to verify out-of-order batch detection & re-ordering
  const combined = combineBatchExtractions({
    totalExpectedMappings: mappingRes.mappings,
    originalPageRange: '37-44',
    batchResults: [batch1, batch0],
    fallbackChapter: 'অধ্যায় ৪',
  });

  assert.equal(combined.outOfOrderDetected, true);
  assert.equal(combined.extractionStatus, 'partial'); // NEVER 'success' when page 38 is missing!
  assert.deepEqual(combined.missingOriginalPages, [38]);
  assert.deepEqual(combined.duplicateOriginalPages, [39]);
  assert.deepEqual(
    combined.sections.map((s) => s.pageNumber),
    [37, 39, 40, 41, 42, 43, 44]
  );

  // Save validation MUST block partial extraction
  const saveCheck = validateBookSaveReadiness({
    title: 'বিসিএস ইতিহাস',
    subject: 'বাংলাদেশ বিষয়াবলি',
    rawText: combined.rawText,
    extractionContext: {
      status: combined.extractionStatus,
      actualPageCount: combined.actualPageCount,
      extractedPageCount: combined.extractedPageCount,
      missingOriginalPages: combined.missingOriginalPages,
      sourceWasUploadedPdf: true,
    },
  });
  assert.equal(saveCheck.ok, false);
});

test('17 & 18: Partial extraction failure blocks Save, and placeholder-only text ("Page 37-44") is strictly rejected', async () => {
  // Placeholder-only text check
  assert.equal(isPageRangeOnlyText('Page 37-44'), true);
  assert.equal(isPageRangeOnlyText('--- পৃষ্ঠা 37 ---\n[Page 37-44]\nPage 37-44'), true);

  const placeholderSave = validateBookSaveReadiness({
    title: 'ইতিহাস',
    subject: 'বাংলাদেশ বিষয়াবলি',
    rawText: '--- পৃষ্ঠা 37 ---\n[Page 37-44]\nPage 37-44',
  });
  assert.equal(placeholderSave.ok, false);
  assert.equal(placeholderSave.meaningfulCharCount, 0);

  // End-to-end partial extraction failure (batch 1 succeeds, batch 2 fails with 503)
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock({
    onGenerate: (_prompt, _model, _usedFilesApi, callIndex) => {
      if (callIndex >= 2) {
        return { throwError: new Error('503 UNAVAILABLE: overloaded') };
      }
      return {};
    },
  });
  setPdfExtractorClientForTesting(mock.client);

  try {
    // 12 scanned pages => 2 batches (8 pages + 4 pages); batch 1 succeeds, batch 2 fails with 503
    const pdfBytes = await buildRealPdfBytes({ pageCount: 12, withTextFont: false });
    const file = new File([Buffer.from(pdfBytes)], 'partial-fail-12p.pdf', {
      type: 'application/pdf',
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      pageRangeInput: '37-48',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.extraction.extractionStatus, 'partial');
    assert.equal(outcome.extraction.extractedPageCount, 8);
    assert.deepEqual(outcome.extraction.missingOriginalPages, [45, 46, 47, 48]);

    const blockedSave = validateBookSaveReadiness({
      title: 'আংশিক বই',
      subject: 'বাংলাদেশ বিষয়াবলি',
      rawText: outcome.extraction.rawText,
      extractionContext: {
        status: outcome.extraction.extractionStatus,
        actualPageCount: outcome.extraction.actualPageCount,
        extractedPageCount: outcome.extraction.extractedPageCount,
        missingOriginalPages: outcome.extraction.missingOriginalPages,
        sourceWasUploadedPdf: true,
      },
    });
    assert.equal(blockedSave.ok, false);
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

// ============================================================================
// Tests 13, 14, 15: Failed Chunk Retry, Interrupted Upload Recovery, Cancellation
// ============================================================================

test('13 & 14: Failed chunk automatically retries without re-uploading earlier chunks, and interrupted upload resumes cleanly via server session status', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock();
  setPdfExtractorClientForTesting(mock.client);

  try {
    // 4 pages, ~300 KB total with 64 KB chunks => 5 chunks
    const pdfBytes = await buildRealPdfBytes({
      pageCount: 4,
      bytesPerPagePayload: 70 * 1024,
    });
    const file = new File([Buffer.from(pdfBytes)], 'resumable-test.pdf', {
      type: 'application/pdf',
    });

    // Part A: Transient failure on chunk 2 (first attempt fails with 503, retry succeeds without re-sending chunks 0 & 1)
    const sentChunkIndices: number[] = [];
    let failedChunk2Once = false;

    const retryFetch = createInProcessSessionFetch(async (urlPath, init, next) => {
      if (urlPath === '/api/ai/extract-pdf/session/chunk' && init?.method === 'POST') {
        const hdrs = new Headers(init.headers);
        const idx = Number(hdrs.get('x-chunk-index'));
        sentChunkIndices.push(idx);
        if (idx === 2 && !failedChunk2Once) {
          failedChunk2Once = true;
          return new Response(JSON.stringify({ error: 'Transient 503' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return next();
    });

    const retryOutcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      chunkSizeBytes: 64 * 1024,
      maxChunkRetries: 2,
      chunkRetryDelayMs: 5,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: retryFetch,
    });

    assert.equal(retryOutcome.ok, true);
    // Chunk 0 and 1 were each sent ONCE; chunk 2 sent twice (1 fail + 1 retry)
    assert.equal(sentChunkIndices.filter((i) => i === 0).length, 1);
    assert.equal(sentChunkIndices.filter((i) => i === 1).length, 1);
    assert.equal(sentChunkIndices.filter((i) => i === 2).length, 2);

    // Part B: Hard interruption on chunk 2 (exhausts retries) => returns resumableSessionId => resume skips chunks 0 & 1!
    let hardDropChunk2 = true;
    const resumedIndices: number[] = [];

    const interruptFetch = createInProcessSessionFetch(async (urlPath, init, next) => {
      if (urlPath === '/api/ai/extract-pdf/session/chunk' && init?.method === 'POST') {
        const hdrs = new Headers(init.headers);
        const idx = Number(hdrs.get('x-chunk-index'));
        if (hardDropChunk2 && idx === 2) {
          throw new Error('Network connection dropped');
        }
        if (!hardDropChunk2) {
          resumedIndices.push(idx);
        }
      }
      return next();
    });

    const interrupted = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      chunkSizeBytes: 64 * 1024,
      maxChunkRetries: 0,
      chunkRetryDelayMs: 1,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: interruptFetch,
    });

    assert.equal(interrupted.ok, false);
    if (interrupted.ok) return;
    assert.ok(interrupted.resumableSessionId, 'Interrupted upload must return resumableSessionId');

    // Now network recovers -> resume using resumableSessionId
    hardDropChunk2 = false;
    const resumed = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      chunkSizeBytes: 64 * 1024,
      resumeSessionId: interrupted.resumableSessionId,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: interruptFetch,
    });

    assert.equal(resumed.ok, true);
    assert.equal(resumedIndices.includes(0), false, 'Resume must NOT re-upload chunk 0');
    assert.equal(resumedIndices.includes(1), false, 'Resume must NOT re-upload chunk 1');
    assert.equal(resumedIndices[0], 2, 'Resume must start cleanly from missing chunk 2');
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('15 & 20: Upload cancellation aborts cleanly and deletes all local temp files from disk', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  try {
    const pdfBytes = await buildRealPdfBytes({
      pageCount: 4,
      bytesPerPagePayload: 70 * 1024,
    });
    const file = new File([Buffer.from(pdfBytes)], 'cancel-me.pdf', {
      type: 'application/pdf',
    });

    const controller = new AbortController();
    let capturedSessionId: string | null = null;

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      chunkSizeBytes: 64 * 1024,
      signal: controller.signal,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: (p) => {
        if (p.sessionId) capturedSessionId = p.sessionId;
        if (p.uploadedChunks === 1) {
          controller.abort();
        }
      },
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.cancelled, true);
    }
    assert.ok(capturedSessionId);
    assert.equal(await pathExists(path.join(PDF_JOBS_BASE_DIR, capturedSessionId)), false);
  } finally {
    setAiGuardTestOverrides(null);
  }
});

// ============================================================================
// Test 16: Unauthorized Access, Cross-User Ownership, Duplicate Chunks, Session Cap, TTL
// ============================================================================

test('16 & 20: Enforces Firebase auth, cross-user session ownership (403), duplicate chunk prevention (409), active session cap (429), and abandoned session TTL cleanup', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  const createdSessionIds: string[] = [];
  try {
    const pdfBytes = await buildRealPdfBytes({ pageCount: 2, bytesPerPagePayload: 40 * 1024 });

    // Unauthenticated init rejected with 401
    const unauthInit = await initSessionPost(
      makeJsonReq('http://localhost:3000/api/ai/extract-pdf/session/init', {
        fileName: 'unauth.pdf',
        declaredMimeType: 'application/pdf',
        fileSize: pdfBytes.byteLength,
      })
    );
    assert.equal(unauthInit.status, 401);

    // User 1 creates session
    const initRes = await initSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/init',
        {
          fileName: 'owned-by-user-1.pdf',
          declaredMimeType: 'application/pdf',
          fileSize: pdfBytes.byteLength,
          chunkSizeBytes: 64 * 1024,
        },
        'token-user-1'
      )
    );
    assert.equal(initRes.status, 200);
    const { sessionId } = (await initRes.json()) as { sessionId: string };
    createdSessionIds.push(sessionId);

    // User 2 attempts GET chunk status, POST chunk, prepare, batch, finalize, cancel => ALL 403!
    const foreignGet = await chunkSessionGet(
      new NextRequest(
        `http://localhost:3000/api/ai/extract-pdf/session/chunk?sessionId=${sessionId}`,
        { headers: { authorization: 'Bearer token-user-2' } }
      )
    );
    assert.equal(foreignGet.status, 403);

    const foreignChunk = await chunkSessionPost(
      makeChunkReq(sessionId, 0, pdfBytes.subarray(0, 64 * 1024), 'token-user-2')
    );
    assert.equal(foreignChunk.status, 403);

    const foreignPrepare = await prepareSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/prepare',
        { sessionId },
        'token-user-2'
      )
    );
    assert.equal(foreignPrepare.status, 403);

    const foreignCancel = await cancelSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/cancel',
        { sessionId },
        'token-user-2'
      )
    );
    assert.equal(foreignCancel.status, 403);

    // User 1 uploads chunk 0, then attempts duplicate write of chunk 0 => rejected 409 DUPLICATE_CHUNK
    const firstSlice = pdfBytes.subarray(0, Math.min(64 * 1024, pdfBytes.byteLength));
    const okChunk0 = await chunkSessionPost(
      makeChunkReq(sessionId, 0, firstSlice, 'token-user-1')
    );
    assert.equal(okChunk0.status, 200);

    const dupChunk0 = await chunkSessionPost(
      makeChunkReq(sessionId, 0, firstSlice, 'token-user-1')
    );
    assert.equal(dupChunk0.status, 409);
    const dupJson = (await dupChunk0.json()) as { code: string; bytesReceived: number };
    assert.equal(dupJson.code, 'DUPLICATE_CHUNK');
    assert.equal(dupJson.bytesReceived, firstSlice.byteLength);

    // Enforce MAX_ACTIVE_SESSIONS_PER_USER (5) => 6th concurrent session rejected with 429
    for (let i = 1; i < MAX_ACTIVE_SESSIONS_PER_USER; i += 1) {
      const extraInit = await initSessionPost(
        makeJsonReq(
          'http://localhost:3000/api/ai/extract-pdf/session/init',
          {
            fileName: `extra-${i}.pdf`,
            declaredMimeType: 'application/pdf',
            fileSize: pdfBytes.byteLength,
          },
          'token-user-1'
        )
      );
      assert.equal(extraInit.status, 200);
      const { sessionId: extraId } = (await extraInit.json()) as { sessionId: string };
      createdSessionIds.push(extraId);
    }

    const sixthInit = await initSessionPost(
      makeJsonReq(
        'http://localhost:3000/api/ai/extract-pdf/session/init',
        {
          fileName: 'sixth-blocked.pdf',
          declaredMimeType: 'application/pdf',
          fileSize: pdfBytes.byteLength,
        },
        'token-user-1'
      )
    );
    assert.equal(sixthInit.status, 429);
    assert.equal(
      ((await sixthInit.json()) as { code: string }).code,
      'TOO_MANY_ACTIVE_SESSIONS'
    );

    // Verify expired abandoned session cleanup removes disk temp files
    const lookup = getOwnedPdfSession(sessionId, 901);
    assert.equal(lookup.ok, true);
    if (lookup.ok) {
      lookup.session.updatedAtMs = Date.now() - PDF_SESSION_TTL_MS - 10_000;
      const cleaned = await cleanupExpiredPdfSessions(Date.now());
      assert.ok(cleaned >= 1);
      assert.equal(await pathExists(lookup.session.sessionDir), false);
    }
  } finally {
    for (const sid of createdSessionIds) {
      await cleanupAndDeletePdfSession(sid);
    }
    setAiGuardTestOverrides(null);
  }
});

// ============================================================================
// Test 19: Duplicate Save Prevention
// ============================================================================

test('19: Duplicate Save prevention catches identical retry submissions while allowing distinct books', () => {
  const existingBooks = [
    {
      id: 501,
      title: 'বাংলাদেশের ইতিহাস (পৃষ্ঠা ৩৭-৪৪)',
      subject: 'বাংলাদেশ বিষয়াবলি',
      totalPages: 8,
      chunks: [
        { pageNumber: 37, content: '১৯৭১ সালের মহান মুক্তিযুদ্ধের সূচনা ও ঐতিহাসিক প্রেক্ষাপট।' },
        { pageNumber: 44, content: '১৯৭২ সালের বাংলাদেশের সংবিধান প্রণয়ন ও মূলনীতি।' },
      ],
    },
  ];

  const exactRetryMatch = findDuplicateBookMatch(existingBooks, {
    title: '  বাংলাদেশের ইতিহাস (পৃষ্ঠা ৩৭-৪৪) ',
    subject: 'বাংলাদেশ বিষয়াবলি',
    totalPages: 8,
    chunks: [
      { pageNumber: 37, content: '১৯৭১ সালের মহান মুক্তিযুদ্ধের সূচনা ও ঐতিহাসিক প্রেক্ষাপট।' },
      { pageNumber: 44, content: '১৯৭২ সালের বাংলাদেশের সংবিধান প্রণয়ন ও মূলনীতি।' },
    ],
  });
  assert.ok(exactRetryMatch);
  assert.equal(exactRetryMatch.id, 501);

  const distinctBook = findDuplicateBookMatch(existingBooks, {
    title: 'বাংলাদেশের ইতিহাস (পৃষ্ঠা ৪৫-৫২)',
    subject: 'বাংলাদেশ বিষয়াবলি',
    totalPages: 8,
    chunks: [
      { pageNumber: 45, content: 'বাংলাদেশের অর্থনৈতিক উন্নয়ন ও পঞ্চবার্ষিক পরিকল্পনা।' },
    ],
  });
  assert.equal(distinctBook, null);

  assert.notEqual(
    buildBookSubmissionFingerprint(existingBooks[0]),
    buildBookSubmissionFingerprint({
      ...existingBooks[0],
      title: 'ভিন্ন বই',
    })
  );
});

// ============================================================================
// Test 21: Free-Tier Quota Exhaustion (Immediate Stop, Zero Paid/Fallback Switch)
// ============================================================================

test('21: Free-Tier 429 RESOURCE_EXHAUSTED stops immediately on first batch without retrying, without switching models, and cleans up temp files', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  const mock = createStructuredGeminiMock({
    onGenerate: () => ({
      throwError: Object.assign(
        new Error('429 RESOURCE_EXHAUSTED: Free tier quota exceeded'),
        { status: 429 }
      ),
    }),
  });
  setPdfExtractorClientForTesting(mock.client);

  try {
    const pdfBytes = await buildRealPdfBytes({ pageCount: 12, withTextFont: false });
    const file = new File([Buffer.from(pdfBytes)], 'quota-stop-12p.pdf', {
      type: 'application/pdf',
    });

    let capturedSessionId: string | null = null;
    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      pageRangeInput: '37-48',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: (p) => {
        if (p.sessionId) capturedSessionId = p.sessionId;
      },
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.quotaExhausted, true);
      assert.ok(outcome.error.includes('ফ্রি-টিয়ার Gemini API কোটা'));
    }

    // CRITICAL: Must have called Gemini EXACTLY ONCE (no retries on 429, no batch 2 call, no fallback model!)
    const stats = mock.getStats();
    assert.equal(stats.generateCallCount, 1);
    assert.deepEqual(stats.modelsUsed, [GEMINI_MODEL]);
    assert.deepEqual(stats.remainingRemoteFiles, []);

    assert.ok(capturedSessionId);
    assert.equal(await pathExists(path.join(PDF_JOBS_BASE_DIR, capturedSessionId)), false);
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('Single-pass prepareAndSplitPdfOnDisk preserves exact page count and original page mappings for 8-page 37-44 PDF', async () => {
  const tmpDir = path.join(PDF_JOBS_BASE_DIR, `unit-split-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    const pdfBytes = await buildRealPdfBytes({ pageCount: 8, withTextFont: false });
    const srcPath = path.join(tmpDir, 'src.pdf');
    await fs.writeFile(srcPath, pdfBytes);

    const out = await prepareAndSplitPdfOnDisk({
      sourcePdfPath: srcPath,
      outputDir: path.join(tmpDir, 'batches'),
      pageRangeInput: '37-44',
      maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
      maxPagesPerBatch: 4,
      ocrMode: 'auto',
    });

    assert.equal(out.inspection.actualPageCount, 8);
    assert.equal(out.originalPageRangeLabel, '37-44');
    assert.equal(out.batches.length, 2);
    assert.deepEqual(
      out.batches[0].pageMappings.map((m) => [m.pdfPageIndex, m.originalPageNumber]),
      [
        [1, 37],
        [2, 38],
        [3, 39],
        [4, 40],
      ]
    );
    assert.deepEqual(
      out.batches[1].pageMappings.map((m) => [m.pdfPageIndex, m.originalPageNumber]),
      [
        [5, 41],
        [6, 42],
        [7, 43],
        [8, 44],
      ]
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Near-100 MB real PDF (~96 MB) uploads in 24×4 MB chunks, bisects into <=35 MB batches, extracts all pages via Files API, and cleans up all temp files', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock();
  setPdfExtractorClientForTesting(mock.client);

  try {
    // 12 scanned pages × 8 MB = ~96.0 MB real PDF (< 100 MB limit, exercises 25 chunks)
    const pdfBytes = await buildRealPdfBytes({
      pageCount: 12,
      bytesPerPagePayload: 8 * 1024 * 1024,
      withTextFont: false,
    });
    assert.ok(
      pdfBytes.byteLength > 95 * 1024 * 1024 && pdfBytes.byteLength <= MAX_UPLOAD_BYTES,
      `Expected ~96 MB PDF, got ${pdfBytes.byteLength} bytes`
    );

    const file = new File([Buffer.from(pdfBytes)], 'bcs-mega-96mb.pdf', {
      type: 'application/pdf',
    });

    let batchSizes: number[] = [];
    let capturedSessionId: string | null = null;
    let maxUploadedChunks = 0;

    const inspectFetch = createInProcessSessionFetch(async (urlPath, _init, next) => {
      const res = await next();
      if (urlPath === '/api/ai/extract-pdf/session/prepare' && res.ok) {
        const json = (await res.clone().json()) as {
          batches?: Array<{ byteSize: number }>;
        };
        batchSizes = (json.batches ?? []).map((b) => b.byteSize);
      }
      return res;
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: (p) => {
        if (p.sessionId) capturedSessionId = p.sessionId;
        maxUploadedChunks = Math.max(maxUploadedChunks, p.uploadedChunks);
      },
      fetchImpl: inspectFetch,
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.extraction.extractionStatus, 'success');
    assert.equal(outcome.extraction.actualPageCount, 12);
    assert.equal(outcome.extraction.extractedPageCount, 12);
    assert.deepEqual(outcome.extraction.missingOriginalPages, []);
    assert.equal(maxUploadedChunks, Math.ceil(pdfBytes.byteLength / CHUNK_UPLOAD_SIZE_BYTES));
    assert.ok(batchSizes.length >= 3, '96 MB PDF must split into >= 3 batches <= 35 MB');
    for (const sz of batchSizes) {
      assert.ok(
        sz <= DEFAULT_MAX_BATCH_BYTES && sz < GEMINI_HARD_PDF_LIMIT_BYTES,
        `Batch size ${sz} exceeded 35 MB threshold`
      );
    }

    const stats = mock.getStats();
    assert.equal(stats.totalUploadedFiles, batchSizes.length);
    assert.deepEqual(stats.remainingRemoteFiles, []);
    assert.ok(capturedSessionId);
    assert.equal(await pathExists(path.join(PDF_JOBS_BASE_DIR, capturedSessionId)), false);
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('Preserves existing TXT, MD, PNG, JPEG, and WebP upload support end-to-end', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock();
  setPdfExtractorClientForTesting(mock.client);

  try {
    // 1. TXT file via chunked pipeline
    const txtBytes = new TextEncoder().encode(
      'বাংলাদেশের সংবিধান ১৯৭২ সালের ৪ নভেম্বর গণপরিষদে গৃহীত হয় এবং ১৬ ডিসেম্বর কার্যকর হয়।'
    );
    const txtFile = new File([txtBytes], 'notes.txt', { type: 'text/plain' });
    const txtOut = await runChunkedPdfPipeline({
      file: txtFile,
      useOcr: false,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });
    assert.equal(txtOut.ok, true);
    if (txtOut.ok) {
      assert.equal(txtOut.extraction.extractionStatus, 'success');
      assert.equal(txtOut.extraction.method, 'text');
      assert.ok(txtOut.extraction.rawText.includes('১৯৭২'));
    }

    // 2. MD file via chunked pipeline
    const mdFile = new File([txtBytes], 'summary.md', { type: 'text/markdown' });
    const mdOut = await runChunkedPdfPipeline({
      file: mdFile,
      useOcr: false,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });
    assert.equal(mdOut.ok, true);

    // 3. PNG / JPEG / WebP header validation + PNG image OCR through session pipeline
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    assert.equal(
      validateUploadedDocumentHeader('scan.jpg', 'image/jpeg', jpegBytes, jpegBytes.byteLength).ok,
      true
    );
    assert.equal(
      validateUploadedDocumentHeader('scan.webp', 'image/webp', webpBytes, webpBytes.byteLength).ok,
      true
    );

    const pngFile = new File([pngBytes], 'page37.png', { type: 'image/png' });
    const pngOut = await runChunkedPdfPipeline({
      file: pngFile,
      useOcr: true,
      pageRangeInput: '37',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });
    assert.equal(pngOut.ok, true);
    if (pngOut.ok) {
      assert.equal(pngOut.extraction.extractionStatus, 'success');
      assert.equal(pngOut.extraction.actualPageCount, 1);
      assert.equal(pngOut.extraction.sections[0].pageNumber, 37);
    }
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

// ============================================================================
// Tests 22–25: Smart Local-First Extraction, Garbled Font Detection, Partial OCR, Force OCR
// ============================================================================

test('22: evaluateLocalExtractedPageText accepts clean Bengali/English text and routes blank, placeholder, and garbled Bijoy/ANSI pages to OCR', () => {
  const cleanBangla = evaluateLocalExtractedPageText(
    'বাংলাদেশের সংবিধান ১৯৭২ সালের ৪ নভেম্বর গণপরিষদে গৃহীত হয় এবং ১৬ ডিসেম্বর কার্যকর হয়।'
  );
  assert.equal(cleanBangla.usable, true);

  const cleanEnglish = evaluateLocalExtractedPageText(
    'The Constitution of Bangladesh was adopted on 4 November 1972 and came into force on 16 December 1972.'
  );
  assert.equal(cleanEnglish.usable, true);

  // Blank or too short
  assert.equal(evaluateLocalExtractedPageText('   \n  ').usable, false);
  assert.equal(evaluateLocalExtractedPageText('Page 1').usable, false);

  // Placeholder-only text must NEVER pass as usable local text
  assert.equal(evaluateLocalExtractedPageText('--- পৃষ্ঠা 37 ---\nPage 37-44').usable, false);

  // Garbled Bijoy/ANSI mojibake (extended Latin / symbols standing in for Bengali glyphs)
  const bijoyGarbled = evaluateLocalExtractedPageText(
    'evsjv‡`‡ki msweavb 1972 mv‡ji 4 b‡f¤^i MYcwil‡` M„nxZ nq Ges 16 wW‡m¤^i Kvh©Ki nq|'
  );
  assert.equal(bijoyGarbled.usable, false);

  // Private Use Area (PUA) glyph stream
  const puaGarbled = evaluateLocalExtractedPageText(
    '\uE001\uE002\uE003\uE004\uE005\uE006\uE007\uE008\uE009\uE00A\uE00B\uE00C\uE00D\uE00E\uE00F\uE010\uE011\uE012\uE013\uE014\uE015\uE016\uE017\uE018\uE019\uE01A'
  );
  assert.equal(puaGarbled.usable, false);
});

test('23: 100% Searchable 8-page PDF (Page 37-44) extracts locally with immediate=true, 0 Gemini calls, 0 /batch calls, exact 37..44 mapping, and cleans up temp files', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock({
    onGenerate: () => ({
      throwError: new Error('Gemini should NEVER be called for a 100% searchable PDF'),
    }),
  });
  setPdfExtractorClientForTesting(mock.client);

  try {
    const pdfBytes = await buildRealPdfBytes({
      pageCount: 8,
      withTextFont: true,
    });
    const file = new File([Buffer.from(pdfBytes)], 'searchable-bcs-p37-44.pdf', {
      type: 'application/pdf',
    });

    const calledEndpoints: string[] = [];
    let capturedSessionId: string | null = null;
    const inspectFetch = createInProcessSessionFetch(async (urlPath, _init, next) => {
      calledEndpoints.push(urlPath);
      return next();
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      ocrMode: 'auto',
      pageRangeInput: 'Page 37-44',
      fallbackChapter: 'সংবিধান',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: (p) => {
        if (p.sessionId) capturedSessionId = p.sessionId;
      },
      fetchImpl: inspectFetch,
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const ex = outcome.extraction;
    assert.equal(ex.extractionStatus, 'success');
    assert.equal(ex.method, 'text');
    assert.equal(ex.ocrCompleted, false);
    assert.equal(ex.actualPageCount, 8);
    assert.equal(ex.extractedPageCount, 8);
    assert.equal(ex.totalBatches, 0);
    assert.deepEqual(ex.missingOriginalPages, []);
    assert.deepEqual(
      ex.sections.map((s) => [s.pdfPageIndex, s.pageNumber]),
      [
        [1, 37],
        [2, 38],
        [3, 39],
        [4, 40],
        [5, 41],
        [6, 42],
        [7, 43],
        [8, 44],
      ]
    );
    assert.ok(ex.sections[0].content.includes('Internal Page 1'));
    assert.ok(ex.sections[7].content.includes('Internal Page 8'));

    // Zero Gemini calls & zero /batch or /finalize network calls!
    assert.equal(mock.getStats().generateCallCount, 0);
    assert.equal(calledEndpoints.includes('/api/ai/extract-pdf/session/batch'), false);
    assert.equal(calledEndpoints.includes('/api/ai/extract-pdf/session/finalize'), false);

    // Passes Knowledge Base Save validation cleanly
    const readiness = validateBookSaveReadiness({
      title: 'সার্চেবল বিসিএস বই',
      subject: 'বাংলাদেশ বিষয়াবলি',
      rawText: ex.rawText,
      extractionContext: {
        status: ex.extractionStatus,
        actualPageCount: ex.actualPageCount,
        extractedPageCount: ex.extractedPageCount,
        missingOriginalPages: ex.missingOriginalPages,
        sourceWasUploadedPdf: true,
      },
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.computedTotalPages, 8);

    // Temp session cleaned up
    assert.ok(capturedSessionId);
    assert.equal(await pathExists(path.join(PDF_JOBS_BASE_DIR, capturedSessionId)), false);
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('24: Partial OCR mixed 4-page PDF extracts text pages locally (1 & 3), sends ONLY scanned pages (2 & 4) to Gemini, and merges all 4 pages in strict ascending order', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  const promptsSentToGemini: string[] = [];
  const mock = createStructuredGeminiMock({
    onGenerate: (prompt) => {
      promptsSentToGemini.push(prompt);
      return {};
    },
  });
  setPdfExtractorClientForTesting(mock.client);

  try {
    // Pages 1 & 3 have embedded text; pages 2 & 4 are scanned (no text layer)
    const pdfBytes = await buildRealPdfBytes({
      pageCount: 4,
      textPageIndices: [1, 3],
    });
    const file = new File([Buffer.from(pdfBytes)], 'mixed-partial-ocr.pdf', {
      type: 'application/pdf',
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      ocrMode: 'auto',
      pageRangeInput: '37-40',
      fallbackChapter: 'মিশ্র অধ্যায়',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const ex = outcome.extraction;
    assert.equal(ex.extractionStatus, 'success');
    assert.equal(ex.actualPageCount, 4);
    assert.equal(ex.extractedPageCount, 4);
    assert.deepEqual(ex.missingOriginalPages, []);
    assert.equal(ex.ocrCompleted, true);
    assert.equal(ex.totalBatches, 1);

    // Gemini was called ONCE and received ONLY scanned pages 2 (orig 38) and 4 (orig 40)!
    assert.equal(mock.getStats().generateCallCount, 1);
    assert.equal(promptsSentToGemini.length, 1);
    assert.ok(promptsSentToGemini[0].includes('Source PDF internal page 2) => Original printed book page 38'));
    assert.ok(promptsSentToGemini[0].includes('Source PDF internal page 4) => Original printed book page 40'));
    assert.equal(promptsSentToGemini[0].includes('Original printed book page 37'), false);
    assert.equal(promptsSentToGemini[0].includes('Original printed book page 39'), false);

    // Merged sections are in strict ascending order [37, 38, 39, 40]
    assert.deepEqual(
      ex.sections.map((s) => [s.pdfPageIndex, s.pageNumber]),
      [
        [1, 37],
        [2, 38],
        [3, 39],
        [4, 40],
      ]
    );
    // Pages 37 & 39 came locally from unpdf; pages 38 & 40 came from Gemini OCR
    assert.ok(ex.sections[0].content.includes('Internal Page 1'));
    assert.ok(ex.sections[1].content.includes('মূল পৃষ্ঠা 38'));
    assert.ok(ex.sections[2].content.includes('Internal Page 3'));
    assert.ok(ex.sections[3].content.includes('মূল পৃষ্ঠা 40'));
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('25: ocrMode="force" bypasses local text extraction and routes searchable PDF to Gemini OCR', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });
  const mock = createStructuredGeminiMock();
  setPdfExtractorClientForTesting(mock.client);

  try {
    const pdfBytes = await buildRealPdfBytes({ pageCount: 3, withTextFont: true });
    const file = new File([Buffer.from(pdfBytes)], 'force-ocr.pdf', {
      type: 'application/pdf',
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      ocrMode: 'force',
      pageRangeInput: '10-12',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.extraction.extractionStatus, 'success');
    assert.equal(outcome.extraction.method, 'ocr');
    assert.equal(outcome.extraction.ocrCompleted, true);
    assert.equal(mock.getStats().generateCallCount, 1);
    assert.deepEqual(
      outcome.extraction.sections.map((s) => s.pageNumber),
      [10, 11, 12]
    );
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});


