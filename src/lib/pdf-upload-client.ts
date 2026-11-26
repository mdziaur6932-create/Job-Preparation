import { formatAiResponseError } from './ai-client';
import {
  CHUNK_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_BYTES,
  toBengaliNumber,
  validateDeclaredUploadMetadata,
  validateUploadedDocumentHeader,
} from './file-validation';
import {
  FAST_OCR_BATCH_CONCURRENCY,
  type CombinedExtractionResult,
  type PdfOcrSpeed,
  parseOriginalPageRangeSyntax,
} from './pdf-rules';

export type PdfPipelineStage =
  | 'idle'
  | 'validating'
  | 'creating_session'
  | 'uploading_chunk'
  | 'upload_complete'
  | 'counting_pages'
  | 'splitting'
  | 'processing_batch'
  | 'verifying_pages'
  | 'ready'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface PdfPipelineProgress {
  stage: PdfPipelineStage;
  statusMessage: string;
  sessionId: string | null;
  fileName: string;
  fileSize: number;
  maxUploadBytes: number;
  uploadedChunks: number;
  totalChunks: number;
  bytesUploaded: number;
  actualPageCount: number | null;
  originalPageRange: string | null;
  currentBatch: number;
  totalBatches: number;
  completedBatches?: number;
  failedBatches?: number;
  activeBatches?: number;
  lastBatchError?: string | null;
  completedPages: number;
  totalPages: number | null;
  ocrEnabled: boolean;
  ocrActive: boolean | null;
  ocrSpeed?: PdfOcrSpeed;
  localPagesCount?: number;
  ocrPagesCount?: number;
  startedAtMs?: number;
  pagesPerSecond?: number | null;
  estimatedRemainingSeconds?: number | null;
  saveReady: boolean;
  resumable: boolean;
  quotaExhausted?: boolean;
  retryAfterSeconds?: number;
}

export interface RunChunkedPdfPipelineParams {
  file: File;
  useOcr?: boolean;
  ocrMode?: 'auto' | 'force';
  ocrSpeed?: PdfOcrSpeed;
  /** Number of OCR batches to execute in parallel (defaults to 3 in 'fast' mode, 1 when omitted). */
  batchConcurrency?: number;
  pageRangeInput?: string;
  fallbackChapter?: string;
  resumeSessionId?: string | null;
  chunkSizeBytes?: number;
  maxChunkRetries?: number;
  chunkRetryDelayMs?: number;
  getAuthHeaders: () => Promise<Record<string, string> | null>;
  onProgress: (progress: PdfPipelineProgress) => void;
  onUnauthorized?: () => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type RunChunkedPdfPipelineResult =
  | {
      ok: true;
      sessionId: string | null;
      extraction: CombinedExtractionResult;
      quotaExhausted?: boolean;
      retryAfterSeconds?: number;
    }
  | {
      ok: false;
      cancelled?: boolean;
      unauthorized?: boolean;
      quotaExhausted?: boolean;
      retryAfterSeconds?: number;
      resumableSessionId?: string | null;
      error: string;
    };

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || /abort|cancel/i.test(err.message))
  );
}

export async function cancelPdfUploadSession(params: {
  sessionId: string;
  getAuthHeaders: () => Promise<Record<string, string> | null>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchFn = params.fetchImpl ?? fetch;
  try {
    const authHeaders = await params.getAuthHeaders();
    if (!authHeaders) return;
    await fetchFn('/api/ai/extract-pdf/session/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({ sessionId: params.sessionId }),
    });
  } catch {
    // Best-effort server cleanup
  }
}

/**
 * End-to-end browser orchestrator for resumable 4 MB chunked upload, page validation,
 * batch-by-batch server extraction, cancellation, and recovery.
 * Never loads the full 100 MB file into JS memory or Base64-encodes it.
 */
export async function runChunkedPdfPipeline(
  params: RunChunkedPdfPipelineParams
): Promise<RunChunkedPdfPipelineResult> {
  const {
    file,
    useOcr = true,
    ocrMode = 'auto',
    ocrSpeed = 'accurate',
    batchConcurrency,
    pageRangeInput = '',
    fallbackChapter = 'অধ্যায় ১',
    resumeSessionId = null,
    chunkSizeBytes = CHUNK_UPLOAD_SIZE_BYTES,
    maxChunkRetries = 2,
    chunkRetryDelayMs = 600,
    getAuthHeaders,
    onProgress,
    onUnauthorized,
    signal,
    fetchImpl = fetch,
  } = params;

  const effectiveBatchConcurrency = Math.max(
    1,
    Math.min(
      6,
      typeof batchConcurrency === 'number' && Number.isFinite(batchConcurrency)
        ? Math.trunc(batchConcurrency)
        : ocrSpeed === 'fast'
          ? FAST_OCR_BATCH_CONCURRENCY
          : 1
    )
  );
  const pipelineStartedAtMs = Date.now();

  const state: PdfPipelineProgress = {
    stage: 'validating',
    statusMessage: 'PDF যাচাই করা হচ্ছে...',
    sessionId: resumeSessionId,
    fileName: file.name,
    fileSize: file.size,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    uploadedChunks: 0,
    totalChunks: Math.max(1, Math.ceil(Math.max(1, file.size) / chunkSizeBytes)),
    bytesUploaded: 0,
    actualPageCount: null,
    originalPageRange: pageRangeInput.trim() || null,
    currentBatch: 0,
    totalBatches: 0,
    completedBatches: 0,
    failedBatches: 0,
    activeBatches: 0,
    lastBatchError: null,
    completedPages: 0,
    totalPages: null,
    ocrEnabled: useOcr,
    ocrActive: null,
    ocrSpeed,
    startedAtMs: pipelineStartedAtMs,
    pagesPerSecond: null,
    estimatedRemainingSeconds: null,
    saveReady: false,
    resumable: false,
  };

  const emit = (patch: Partial<PdfPipelineProgress>) => {
    Object.assign(state, patch);
    onProgress({ ...state });
  };

  emit({ stage: 'validating', statusMessage: 'PDF যাচাই করা হচ্ছে...' });

  // 1. Client-side metadata & header signature validation (reads ONLY first 8 KB)
  const metaCheck = validateDeclaredUploadMetadata({
    fileName: file.name,
    declaredMimeType: file.type,
    fileSize: file.size,
    maxBytes: MAX_UPLOAD_BYTES,
  });
  if (!metaCheck.ok) {
    emit({ stage: 'failed', statusMessage: metaCheck.error, resumable: false });
    return { ok: false, error: metaCheck.error };
  }

  const rangeCheck = parseOriginalPageRangeSyntax(pageRangeInput);
  if (!rangeCheck.ok) {
    emit({ stage: 'failed', statusMessage: rangeCheck.error, resumable: false });
    return { ok: false, error: rangeCheck.error };
  }

  const headerSlice = new Uint8Array(
    await file.slice(0, Math.min(file.size, 8192)).arrayBuffer()
  );
  const headerCheck = validateUploadedDocumentHeader(
    file.name,
    file.type,
    headerSlice,
    file.size,
    MAX_UPLOAD_BYTES
  );
  if (!headerCheck.ok) {
    emit({ stage: 'failed', statusMessage: headerCheck.error, resumable: false });
    return { ok: false, error: headerCheck.error };
  }

  const authHeaders = await getAuthHeaders();
  if (!authHeaders) {
    onUnauthorized?.();
    emit({ stage: 'idle', statusMessage: '' });
    return {
      ok: false,
      unauthorized: true,
      error:
        'এই AI ফিচারটি ব্যবহার করতে Google অ্যাকাউন্ট দিয়ে সাইন ইন করুন।',
    };
  }

  let activeSessionId: string | null = resumeSessionId;
  let activeChunkSize = chunkSizeBytes;
  let totalChunks = Math.max(1, Math.ceil(file.size / activeChunkSize));
  let startChunkIndex = 0;
  let bytesUploaded = 0;

  try {
    // 2. Resume existing session OR create a new upload session
    if (activeSessionId) {
      emit({
        stage: 'creating_session',
        statusMessage: 'পূর্ববর্তী Upload Session যাচাই করা হচ্ছে...',
      });
      const statusRes = await fetchImpl(
        `/api/ai/extract-pdf/session/chunk?sessionId=${encodeURIComponent(activeSessionId)}`,
        {
          method: 'GET',
          headers: authHeaders,
          signal,
        }
      );
      if (statusRes.status === 401) {
        onUnauthorized?.();
        return {
          ok: false,
          unauthorized: true,
          error: formatAiResponseError(401, null, 'সাইন-ইন প্রয়োজন।'),
        };
      }
      if (statusRes.ok) {
        const statusJson = (await statusRes.json()) as {
          status?: string;
          chunkSizeBytes?: number;
          totalChunks?: number;
          nextExpectedChunkIndex?: number;
          bytesReceived?: number;
          receivedChunkIndices?: number[];
        };
        if (statusJson.status === 'uploading') {
          activeChunkSize = Number(statusJson.chunkSizeBytes || chunkSizeBytes);
          totalChunks = Number(statusJson.totalChunks || totalChunks);
          startChunkIndex = Number(statusJson.nextExpectedChunkIndex || 0);
          bytesUploaded = Number(statusJson.bytesReceived || 0);
          emit({
            sessionId: activeSessionId,
            totalChunks,
            uploadedChunks: startChunkIndex,
            bytesUploaded,
          });
        } else {
          activeSessionId = null;
        }
      } else {
        activeSessionId = null;
      }
    }

    if (!activeSessionId) {
      emit({
        stage: 'creating_session',
        statusMessage: 'Upload Session তৈরি হচ্ছে...',
      });
      const initRes = await fetchImpl('/api/ai/extract-pdf/session/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          fileName: file.name,
          declaredMimeType: file.type,
          fileSize: file.size,
          chunkSizeBytes,
          useOcr,
          ocrMode,
          ocrSpeed,
          pageRangeInput: pageRangeInput.trim(),
          fallbackChapter,
        }),
        signal,
      });
      const initJson = (await initRes.json().catch(() => ({}))) as {
        sessionId?: string;
        chunkSizeBytes?: number;
        totalChunks?: number;
        error?: string;
        code?: string;
        retryAfterSeconds?: number;
      };

      if (!initRes.ok || !initJson.sessionId) {
        if (initRes.status === 401) {
          onUnauthorized?.();
        }
        const msg = formatAiResponseError(
          initRes.status,
          initJson,
          'Upload Session তৈরি করা যায়নি।'
        );
        emit({ stage: 'failed', statusMessage: msg, resumable: false });
        return {
          ok: false,
          unauthorized: initRes.status === 401,
          error: msg,
        };
      }

      activeSessionId = initJson.sessionId;
      activeChunkSize = Number(initJson.chunkSizeBytes || chunkSizeBytes);
      totalChunks = Number(initJson.totalChunks || totalChunks);
      startChunkIndex = 0;
      bytesUploaded = 0;
      emit({
        sessionId: activeSessionId,
        totalChunks,
        uploadedChunks: 0,
        bytesUploaded: 0,
      });
    }

    // 3. Upload remaining chunks sequentially (each <= 4 MB raw binary Blob slice)
    for (let chunkIndex = startChunkIndex; chunkIndex < totalChunks; chunkIndex += 1) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const startByte = chunkIndex * activeChunkSize;
      const endByte = Math.min(file.size, startByte + activeChunkSize);
      const chunkBlob = file.slice(startByte, endByte);

      emit({
        stage: 'uploading_chunk',
        statusMessage: `Chunk ${toBengaliNumber(chunkIndex + 1)}/${toBengaliNumber(totalChunks)} আপলোড হচ্ছে...`,
        uploadedChunks: chunkIndex,
        totalChunks,
        bytesUploaded,
      });

      let chunkSucceeded = false;
      let lastChunkError = 'Chunk আপলোড করতে সমস্যা হয়েছে।';

      for (let attempt = 0; attempt <= maxChunkRetries; attempt += 1) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        try {
          const freshHeaders = (await getAuthHeaders()) ?? authHeaders;
          const chunkRes = await fetchImpl('/api/ai/extract-pdf/session/chunk', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Session-Id': activeSessionId,
              'X-Chunk-Index': String(chunkIndex),
              'X-Total-Chunks': String(totalChunks),
              ...freshHeaders,
            },
            body: chunkBlob,
            signal,
          });

          const chunkJson = (await chunkRes.json().catch(() => ({}))) as {
            ok?: boolean;
            code?: string;
            duplicate?: boolean;
            bytesReceived?: number;
            receivedChunksCount?: number;
            error?: string;
            retryAfterSeconds?: number;
          };

          if (chunkRes.ok || (chunkRes.status === 409 && chunkJson.duplicate)) {
            bytesUploaded = Number(chunkJson.bytesReceived ?? endByte);
            chunkSucceeded = true;
            emit({
              uploadedChunks: chunkIndex + 1,
              bytesUploaded,
            });
            break;
          }

          if (chunkRes.status === 401) {
            onUnauthorized?.();
            return {
              ok: false,
              unauthorized: true,
              resumableSessionId: activeSessionId,
              error: formatAiResponseError(401, chunkJson, 'সাইন-ইন প্রয়োজন।'),
            };
          }

          lastChunkError = formatAiResponseError(
            chunkRes.status,
            chunkJson,
            `Chunk ${toBengaliNumber(chunkIndex + 1)} আপলোড ব্যর্থ হয়েছে।`
          );

          // Do not retry deterministic 400/413/403 validation errors
          if (
            chunkRes.status === 400 ||
            chunkRes.status === 403 ||
            chunkRes.status === 413
          ) {
            emit({ stage: 'failed', statusMessage: lastChunkError, resumable: false });
            return { ok: false, error: lastChunkError };
          }
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) {
            throw err;
          }
          lastChunkError =
            err instanceof Error
              ? err.message
              : `Chunk ${toBengaliNumber(chunkIndex + 1)} আপলোডের সময় সংযোগ বিচ্ছিন্ন হয়েছে।`;
        }

        if (attempt < maxChunkRetries) {
          await sleepWithAbort(chunkRetryDelayMs * (attempt + 1), signal);
        }
      }

      if (!chunkSucceeded) {
        emit({
          stage: 'failed',
          statusMessage: lastChunkError,
          resumable: true,
        });
        return {
          ok: false,
          resumableSessionId: activeSessionId,
          error: lastChunkError,
        };
      }
    }

    emit({
      stage: 'upload_complete',
      statusMessage: 'PDF সম্পূর্ণ আপলোড হয়েছে...',
      uploadedChunks: totalChunks,
      bytesUploaded: file.size,
      resumable: false,
    });

    // 4. Prepare: validate full PDF, count actual pages, map original page range, split <= 35 MB batches
    emit({
      stage: 'counting_pages',
      statusMessage: 'PDF পৃষ্ঠা গণনা করা হচ্ছে...',
    });

    const prepareHeaders = (await getAuthHeaders()) ?? authHeaders;
    const prepareRes = await fetchImpl('/api/ai/extract-pdf/session/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...prepareHeaders,
      },
      body: JSON.stringify({
        sessionId: activeSessionId,
        pageRangeInput: pageRangeInput.trim(),
        useOcr,
        ocrMode,
        ocrSpeed,
        fallbackChapter,
      }),
      signal,
    });

    const prepareJson = (await prepareRes.json().catch(() => ({}))) as {
      immediate?: boolean;
      kind?: 'text' | 'image' | 'pdf';
      documentProfile?: 'text_based' | 'scanned' | 'mixed';
      result?: CombinedExtractionResult;
      actualPageCount?: number;
      originalPageRange?: string;
      localPagesCount?: number;
      ocrPagesCount?: number;
      totalBatches?: number;
      pagesRequiringOcrCount?: number;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    };

    if (!prepareRes.ok) {
      if (prepareRes.status === 401) {
        onUnauthorized?.();
      }
      const msg = formatAiResponseError(
        prepareRes.status,
        prepareJson,
        'PDF যাচাই ও পৃষ্ঠা বিভাজন সম্পন্ন করা যায়নি।'
      );
      emit({ stage: 'failed', statusMessage: msg, resumable: false });
      return {
        ok: false,
        unauthorized: prepareRes.status === 401,
        error: msg,
      };
    }

    // Immediate path for plain text / markdown files AND 100% searchable PDFs (0 Gemini API calls!)
    if (prepareJson.immediate && prepareJson.result) {
      const immediateResult = prepareJson.result;
      const isSearchablePdf = prepareJson.kind === 'pdf';
      emit({
        stage: 'ready',
        statusMessage: isSearchablePdf
          ? `সরাসরি টেক্সট সংগ্রহ সম্পন্ন হয়েছে (${toBengaliNumber(immediateResult.extractedPageCount)} পৃষ্ঠা · AI OCR প্রয়োজন হয়নি)।`
          : 'Knowledge Base-এ সংরক্ষণের জন্য প্রস্তুত।',
        actualPageCount: immediateResult.actualPageCount,
        originalPageRange: immediateResult.originalPageRange,
        totalBatches: 0,
        currentBatch: 0,
        completedPages: immediateResult.extractedPageCount,
        totalPages: immediateResult.actualPageCount,
        localPagesCount: prepareJson.localPagesCount ?? immediateResult.extractedPageCount,
        ocrPagesCount: 0,
        ocrActive: immediateResult.ocrCompleted,
        saveReady: immediateResult.extractionStatus === 'success',
      });
      return {
        ok: true,
        sessionId: activeSessionId,
        extraction: immediateResult,
      };
    }

    const actualPageCount = Number(prepareJson.actualPageCount || 1);
    const totalBatches = Number(prepareJson.totalBatches || 1);
    const mappedRange = prepareJson.originalPageRange || `1-${actualPageCount}`;
    const localPagesCount = Number(prepareJson.localPagesCount || 0);
    const ocrPagesCount = Number(prepareJson.ocrPagesCount ?? actualPageCount - localPagesCount);

    emit({
      stage: 'splitting',
      statusMessage:
        localPagesCount > 0
          ? `${toBengaliNumber(localPagesCount)}টি পৃষ্ঠা সরাসরি পাওয়া গেছে · বাকি ${toBengaliNumber(ocrPagesCount)}টি স্ক্যান পৃষ্ঠার ব্যাচ তৈরি হচ্ছে...`
          : 'স্ক্যান করা PDF ব্যাচে ভাগ করা হচ্ছে...',
      actualPageCount,
      totalPages: actualPageCount,
      originalPageRange: mappedRange,
      localPagesCount,
      ocrPagesCount,
      totalBatches,
      currentBatch: 0,
      completedPages: localPagesCount,
    });

    // 5. Process split PDF batches via a bounded parallel worker pool
    //    (4x concurrent in 'fast' mode -> ~4x wall-clock speedup; stops immediately on 429 quota or 401 auth).
    let quotaExhausted = false;
    let quotaErrorMessage: string | null = null;
    let quotaRetryAfterSeconds: number | undefined;
    let unauthorizedHit = false;
    let unauthorizedMessage = 'সাইন-ইন প্রয়োজন।';
    let nextBatchToSchedule = 0;
    let activeWorkers = 0;
    let finishedBatchesCount = 0;
    let consecutiveZeroPageFailures = 0;
    let circuitBroken = false;
    let lastBatchError: string | null = null;
    let completedOcrPagesSoFar = 0;
    const ocrPhaseStartedAtMs = Date.now();
    const batchExtractedCounts = new Map<number, number>();
    const failedBatchIndices = new Set<number>();
    const retryableFailedBatches = new Set<number>();

    const poolAbortController = new AbortController();
    const onParentAbort = () => {
      poolAbortController.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      signal.addEventListener('abort', onParentAbort, { once: true });
    }

    const computeTelemetry = (completedTotalPages: number) => {
      const elapsedSec = Math.max(0.5, (Date.now() - ocrPhaseStartedAtMs) / 1000);
      const ocrDone = Math.max(0, completedTotalPages - localPagesCount);
      const pagesPerSec = ocrDone > 0 ? Math.round((ocrDone / elapsedSec) * 10) / 10 : null;
      const remainingOcrPages = Math.max(0, ocrPagesCount - ocrDone);
      const etaSeconds =
        pagesPerSec && pagesPerSec > 0 && remainingOcrPages > 0
          ? Math.max(1, Math.ceil(remainingOcrPages / pagesPerSec))
          : null;
      return { pagesPerSec, etaSeconds };
    };

    const workerCount = Math.min(effectiveBatchConcurrency, Math.max(1, totalBatches));

    const runBatchWorker = async (workerIdx: number) => {
      // Gentle stagger only for large PDFs (>= 8 batches) to smooth Free-Tier RPM bursts
      if (workerIdx > 0 && totalBatches >= 8) {
        await sleepWithAbort(workerIdx * 350, poolAbortController.signal).catch(() => {});
      }
      while (true) {
        if (
          signal?.aborted ||
          poolAbortController.signal.aborted ||
          quotaExhausted ||
          unauthorizedHit ||
          circuitBroken
        ) {
          return;
        }

        const batchIndex = nextBatchToSchedule;
        if (batchIndex >= totalBatches) {
          return;
        }
        nextBatchToSchedule += 1;
        activeWorkers += 1;

        const parallelTag =
          workerCount > 1
            ? ` (${toBengaliNumber(activeWorkers)}টি ব্যাচ একসাথে)`
            : '';
        emit({
          stage: 'processing_batch',
          statusMessage: `Batch ${toBengaliNumber(Math.min(totalBatches, finishedBatchesCount + 1))}/${toBengaliNumber(totalBatches)} প্রসেস হচ্ছে${parallelTag}...`,
          currentBatch: Math.max(state.currentBatch, batchIndex + 1),
          totalBatches,
          activeBatches: activeWorkers,
          completedBatches: finishedBatchesCount,
          failedBatches: failedBatchIndices.size,
          lastBatchError,
        });

        try {
          const batchHeaders = (await getAuthHeaders()) ?? authHeaders;
          const batchRes = await fetchImpl('/api/ai/extract-pdf/session/batch', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...batchHeaders,
            },
            body: JSON.stringify({
              sessionId: activeSessionId,
              batchIndex,
            }),
            signal: poolAbortController.signal,
          });

          const batchJson = (await batchRes.json().catch(() => ({}))) as {
            completedPagesCount?: number;
            totalExpectedPages?: number;
            quotaExhausted?: boolean;
            batchResult?: {
              status?: string;
              extractedPageCount?: number;
              ocrUsed?: boolean;
              error?: string;
              errorCode?: string;
              retryable?: boolean;
            };
            error?: string;
            code?: string;
            retryable?: boolean;
            retryAfterSeconds?: number;
          };

          if (!batchRes.ok) {
            if (batchRes.status === 401) {
              unauthorizedHit = true;
              unauthorizedMessage = formatAiResponseError(
                401,
                batchJson,
                'সাইন-ইন প্রয়োজন।'
              );
              poolAbortController.abort();
              return;
            }

            if (batchRes.status === 429 || batchJson.code === 'AI_RATE_LIMITED') {
              quotaExhausted = true;
              quotaRetryAfterSeconds =
                typeof batchJson.retryAfterSeconds === 'number' && batchJson.retryAfterSeconds > 0
                  ? Math.ceil(batchJson.retryAfterSeconds)
                  : 35;
              quotaErrorMessage = formatAiResponseError(
                batchRes.status,
                batchJson,
                'ফ্রি-টিয়ার Gemini API কোটা সাময়িকভাবে শেষ হয়ে গেছে। প্রক্রিয়াটি নিরাপদে বন্ধ করা হয়েছে।'
              );
              poolAbortController.abort();
              return;
            }

            failedBatchIndices.add(batchIndex);
            if (batchRes.status >= 500 && batchJson.retryable !== false) {
              retryableFailedBatches.add(batchIndex);
            }
            consecutiveZeroPageFailures += 1;
            lastBatchError = formatAiResponseError(
              batchRes.status,
              batchJson,
              `Batch ${toBengaliNumber(batchIndex + 1)} প্রসেস করতে সমস্যা হয়েছে।`
            );
          } else {
            const batchPages = Number(batchJson.batchResult?.extractedPageCount ?? 0);
            batchExtractedCounts.set(batchIndex, batchPages);
            completedOcrPagesSoFar = Array.from(batchExtractedCounts.values()).reduce(
              (sum, count) => sum + count,
              0
            );
            const serverCompleted = Number(
              batchJson.completedPagesCount ?? localPagesCount + completedOcrPagesSoFar
            );
            const bestCompletedPages = Math.max(
              state.completedPages,
              localPagesCount + completedOcrPagesSoFar,
              serverCompleted
            );

            if (
              batchJson.quotaExhausted ||
              batchJson.batchResult?.errorCode === 'AI_RATE_LIMITED'
            ) {
              quotaExhausted = true;
              quotaRetryAfterSeconds =
                typeof batchJson.retryAfterSeconds === 'number' && batchJson.retryAfterSeconds > 0
                  ? Math.ceil(batchJson.retryAfterSeconds)
                  : 35;
              quotaErrorMessage =
                batchJson.batchResult?.error ||
                'ফ্রি-টিয়ার Gemini API কোটা সাময়িকভাবে শেষ হয়ে গেছে। প্রক্রিয়াটি নিরাপদে বন্ধ করা হয়েছে।';
              poolAbortController.abort();
              return;
            }

            const batchStatus = batchJson.batchResult?.status;
            if (batchStatus === 'failed' || batchPages === 0) {
              failedBatchIndices.add(batchIndex);
              if (batchJson.batchResult?.retryable !== false) {
                retryableFailedBatches.add(batchIndex);
              }
              if (bestCompletedPages === localPagesCount) {
                consecutiveZeroPageFailures += 1;
              }
              lastBatchError =
                batchJson.batchResult?.error ||
                `Batch ${toBengaliNumber(batchIndex + 1)} থেকে কোনো টেক্সট পাওয়া যায়নি।`;
            } else if (batchStatus === 'partial') {
              if (batchJson.batchResult?.retryable !== false) {
                retryableFailedBatches.add(batchIndex);
              }
              consecutiveZeroPageFailures = 0;
            } else {
              failedBatchIndices.delete(batchIndex);
              consecutiveZeroPageFailures = 0;
            }

            finishedBatchesCount += 1;
            const { pagesPerSec, etaSeconds } = computeTelemetry(bestCompletedPages);

            emit({
              stage: 'processing_batch',
              statusMessage: `${toBengaliNumber(bestCompletedPages)}/${toBengaliNumber(actualPageCount)} পৃষ্ঠা সম্পন্ন${
                etaSeconds ? ` · আনুমানিক বাকি ~${toBengaliNumber(etaSeconds)} সে.` : ''
              }...`,
              completedPages: bestCompletedPages,
              totalPages: actualPageCount,
              completedBatches: finishedBatchesCount,
              failedBatches: failedBatchIndices.size,
              lastBatchError,
              pagesPerSecond: pagesPerSec,
              estimatedRemainingSeconds: etaSeconds,
              ocrActive: batchJson.batchResult?.ocrUsed ? true : state.ocrActive,
            });
          }

          // Circuit breaker: if 4+ batches all fail with 0 extracted pages total, stop wasting user time
          if (
            consecutiveZeroPageFailures >= 4 &&
            completedOcrPagesSoFar === 0 &&
            totalBatches >= 5
          ) {
            circuitBroken = true;
            poolAbortController.abort();
            return;
          }
        } catch (workerErr) {
          if (signal?.aborted) {
            throw workerErr;
          }
          if (poolAbortController.signal.aborted && (quotaExhausted || unauthorizedHit || circuitBroken)) {
            return;
          }
          failedBatchIndices.add(batchIndex);
          retryableFailedBatches.add(batchIndex);
          consecutiveZeroPageFailures += 1;
          lastBatchError =
            workerErr instanceof Error
              ? workerErr.message
              : `Batch ${toBengaliNumber(batchIndex + 1)} প্রসেস করতে নেটওয়ার্ক সমস্যা হয়েছে।`;
        } finally {
          activeWorkers = Math.max(0, activeWorkers - 1);
          if (!signal?.aborted && !quotaExhausted && !unauthorizedHit) {
            emit({
              activeBatches: activeWorkers,
              completedBatches: finishedBatchesCount,
              failedBatches: failedBatchIndices.size,
              lastBatchError,
            });
          }
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: workerCount }, (_, workerIdx) => runBatchWorker(workerIdx))
      );

      // 5b. Automatic single-pass recovery for any retryable failed/partial batches using
      //     quote/backslash-proof plain-text delimited mode on GEMINI_MODEL.
      if (
        retryableFailedBatches.size > 0 &&
        !signal?.aborted &&
        !quotaExhausted &&
        !unauthorizedHit &&
        !circuitBroken
      ) {
        const recoveryQueue = Array.from(retryableFailedBatches).sort((a, b) => a - b);
        let recoveryCursor = 0;
        const recoveryWorkers = Math.min(2, recoveryQueue.length);

        emit({
          stage: 'processing_batch',
          statusMessage: `অসম্পূর্ণ ${toBengaliNumber(recoveryQueue.length)}টি ব্যাচ নিরাপদ মোডে পুনরায় সংগ্রহ হচ্ছে...`,
          activeBatches: recoveryWorkers,
          failedBatches: failedBatchIndices.size,
          lastBatchError,
        });

        const runRecoveryWorker = async () => {
          while (true) {
            if (
              signal?.aborted ||
              poolAbortController.signal.aborted ||
              quotaExhausted ||
              unauthorizedHit
            ) {
              return;
            }
            const idx = recoveryCursor;
            if (idx >= recoveryQueue.length) {
              return;
            }
            recoveryCursor += 1;
            const batchIndex = recoveryQueue[idx];

            try {
              const recoveryHeaders = (await getAuthHeaders()) ?? authHeaders;
              const recoveryRes = await fetchImpl('/api/ai/extract-pdf/session/batch', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...recoveryHeaders,
                },
                body: JSON.stringify({
                  sessionId: activeSessionId,
                  batchIndex,
                  preferDelimitedFallback: true,
                }),
                signal: poolAbortController.signal,
              });

              const recoveryJson = (await recoveryRes.json().catch(() => ({}))) as {
                completedPagesCount?: number;
                quotaExhausted?: boolean;
                batchResult?: {
                  status?: string;
                  extractedPageCount?: number;
                  ocrUsed?: boolean;
                  error?: string;
                  errorCode?: string;
                };
                error?: string;
                code?: string;
              };

              if (!recoveryRes.ok) {
                if (recoveryRes.status === 401) {
                  unauthorizedHit = true;
                  unauthorizedMessage = formatAiResponseError(401, recoveryJson, 'সাইন-ইন প্রয়োজন।');
                  poolAbortController.abort();
                  return;
                }
                if (recoveryRes.status === 429 || recoveryJson.code === 'AI_RATE_LIMITED') {
                  quotaExhausted = true;
                  quotaErrorMessage = formatAiResponseError(
                    recoveryRes.status,
                    recoveryJson,
                    'ফ্রি-টিয়ার Gemini API কোটা সাময়িকভাবে শেষ হয়ে গেছে। প্রক্রিয়াটি নিরাপদে বন্ধ করা হয়েছে।'
                  );
                  poolAbortController.abort();
                  return;
                }
                continue;
              }

              if (
                recoveryJson.quotaExhausted ||
                recoveryJson.batchResult?.errorCode === 'AI_RATE_LIMITED'
              ) {
                quotaExhausted = true;
                quotaErrorMessage =
                  recoveryJson.batchResult?.error ||
                  'ফ্রি-টিয়ার Gemini API কোটা সাময়িকভাবে শেষ হয়ে গেছে। প্রক্রিয়াটি নিরাপদে বন্ধ করা হয়েছে।';
                poolAbortController.abort();
                return;
              }

              const recoveredPages = Number(recoveryJson.batchResult?.extractedPageCount ?? 0);
              const prevPages = batchExtractedCounts.get(batchIndex) ?? 0;
              batchExtractedCounts.set(batchIndex, Math.max(prevPages, recoveredPages));
              completedOcrPagesSoFar = Array.from(batchExtractedCounts.values()).reduce(
                (sum, count) => sum + count,
                0
              );
              const serverCompleted = Number(
                recoveryJson.completedPagesCount ?? localPagesCount + completedOcrPagesSoFar
              );
              const bestCompletedPages = Math.max(
                state.completedPages,
                localPagesCount + completedOcrPagesSoFar,
                serverCompleted
              );

              if (recoveryJson.batchResult?.status === 'success') {
                failedBatchIndices.delete(batchIndex);
                if (failedBatchIndices.size === 0) {
                  lastBatchError = null;
                }
              }

              const { pagesPerSec, etaSeconds } = computeTelemetry(bestCompletedPages);
              emit({
                stage: 'processing_batch',
                statusMessage: `নিরাপদ রিকভারি: ${toBengaliNumber(bestCompletedPages)}/${toBengaliNumber(actualPageCount)} পৃষ্ঠা সম্পন্ন...`,
                completedPages: bestCompletedPages,
                totalPages: actualPageCount,
                failedBatches: failedBatchIndices.size,
                lastBatchError,
                pagesPerSecond: pagesPerSec,
                estimatedRemainingSeconds: etaSeconds,
                ocrActive: recoveryJson.batchResult?.ocrUsed ? true : state.ocrActive,
              });
            } catch (recErr) {
              if (signal?.aborted) {
                throw recErr;
              }
            }
          }
        };

        await Promise.all(Array.from({ length: recoveryWorkers }, () => runRecoveryWorker()));
      }
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onParentAbort);
      }
    }

    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (unauthorizedHit) {
      onUnauthorized?.();
      await cancelPdfUploadSession({
        sessionId: activeSessionId,
        getAuthHeaders,
        fetchImpl,
      });
      return {
        ok: false,
        unauthorized: true,
        error: unauthorizedMessage,
      };
    }

    // 6. Finalize: verify all pages in strict order and clean up server temp files + Gemini Files
    emit({
      stage: 'verifying_pages',
      statusMessage: 'পৃষ্ঠা যাচাই করা হচ্ছে...',
    });

    const finalizeHeaders = (await getAuthHeaders()) ?? authHeaders;
    const finalizeRes = await fetchImpl('/api/ai/extract-pdf/session/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...finalizeHeaders,
      },
      body: JSON.stringify({ sessionId: activeSessionId }),
      signal,
    });

    const combined = (await finalizeRes.json().catch(() => ({}))) as CombinedExtractionResult & {
      error?: string;
      code?: string;
    };

    if (!finalizeRes.ok) {
      const msg = formatAiResponseError(
        finalizeRes.status,
        combined,
        'পৃষ্ঠা যাচাই ও ফলাফল সমন্বয় করা যায়নি।'
      );
      emit({ stage: 'failed', statusMessage: msg, saveReady: false });
      return { ok: false, error: msg };
    }

    if (combined.extractionStatus === 'success') {
      emit({
        stage: 'ready',
        statusMessage: 'Knowledge Base-এ সংরক্ষণের জন্য প্রস্তুত।',
        actualPageCount: combined.actualPageCount,
        originalPageRange: combined.originalPageRange,
        completedPages: combined.extractedPageCount,
        totalPages: combined.actualPageCount,
        ocrActive: combined.ocrCompleted,
        saveReady: true,
      });
      return {
        ok: true,
        sessionId: activeSessionId,
        extraction: combined,
      };
    }

    if (combined.extractionStatus === 'partial') {
      const partialMsg =
        quotaErrorMessage ||
        combined.error ||
        `আংশিক এক্সট্র্যাকশন সম্পন্ন হয়েছে (${toBengaliNumber(combined.actualPageCount)}টির মধ্যে ${toBengaliNumber(combined.extractedPageCount)}টি পৃষ্ঠা সম্পন্ন)।`;
      emit({
        stage: 'partial',
        statusMessage: partialMsg,
        actualPageCount: combined.actualPageCount,
        originalPageRange: combined.originalPageRange,
        completedPages: combined.extractedPageCount,
        totalPages: combined.actualPageCount,
        ocrActive: combined.ocrCompleted,
        saveReady: false,
        quotaExhausted,
        retryAfterSeconds: quotaRetryAfterSeconds,
      });
      return {
        ok: true,
        sessionId: activeSessionId,
        extraction: {
          ...combined,
          error: partialMsg,
        },
        quotaExhausted,
        retryAfterSeconds: quotaRetryAfterSeconds,
      };
    }

    const failedMsg =
      quotaErrorMessage ||
      combined.error ||
      'PDF থেকে কোনো পাঠযোগ্য টেক্সট সংগ্রহ করা যায়নি।';
    emit({
      stage: 'failed',
      statusMessage: failedMsg,
      actualPageCount: combined.actualPageCount,
      originalPageRange: combined.originalPageRange,
      completedPages: 0,
      totalPages: combined.actualPageCount,
      ocrActive: false,
      saveReady: false,
      quotaExhausted,
      retryAfterSeconds: quotaRetryAfterSeconds,
    });
    return {
      ok: false,
      quotaExhausted,
      retryAfterSeconds: quotaRetryAfterSeconds,
      error: failedMsg,
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      if (activeSessionId) {
        await cancelPdfUploadSession({
          sessionId: activeSessionId,
          getAuthHeaders,
          fetchImpl,
        });
      }
      emit({
        stage: 'cancelled',
        statusMessage: 'PDF আপলোড ও প্রসেসিং নিরাপদে বাতিল করা হয়েছে।',
        saveReady: false,
        resumable: false,
      });
      return {
        ok: false,
        cancelled: true,
        error: 'PDF আপলোড ও প্রসেসিং বাতিল করা হয়েছে।',
      };
    }

    const errMsg =
      err instanceof Error
        ? err.message
        : 'PDF প্রসেস করতে অপ্রত্যাশিত সমস্যা হয়েছে।';
    emit({
      stage: 'failed',
      statusMessage: errMsg,
      saveReady: false,
    });
    return { ok: false, error: errMsg };
  }
}
