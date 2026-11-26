import fs from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { guardPdfSessionRequest } from '@/src/lib/ai-api-guard';
import { mapAiErrorToHttpResponse, parseJsonBody } from '@/src/lib/gemini';
import {
  extractSingleImageDocument,
  extractSinglePdfBatch,
} from '@/src/lib/pdf-extractor-service';
import type { BatchExtractionResult } from '@/src/lib/pdf-rules';
import {
  getOwnedPdfSession,
  removeFileSafe,
} from '@/src/lib/pdf-session-store';

export const maxDuration = 120;

interface BatchProcessBody {
  sessionId?: string;
  batchIndex?: number;
  preferDelimitedFallback?: boolean;
}

export async function POST(req: NextRequest) {
  const guard = await guardPdfSessionRequest(req, 'session-batch');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<BatchProcessBody>(req);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const batchIndex =
      typeof body.batchIndex === 'number' && Number.isInteger(body.batchIndex)
        ? body.batchIndex
        : -1;
    const preferDelimitedFallback = body.preferDelimitedFallback === true;

    const lookup = getOwnedPdfSession(sessionId, guard.session.dbUserId);
    if (!lookup.ok) {
      return NextResponse.json(
        {
          error: lookup.error,
          code: lookup.code,
          retryable: false,
        },
        { status: lookup.status }
      );
    }

    const { session } = lookup;

    if (session.status !== 'prepared' && session.status !== 'processing') {
      return NextResponse.json(
        {
          error: 'এই সেশনটি ব্যাচ প্রসেসিং-এর জন্য প্রস্তুত নয়।',
          code: 'SESSION_NOT_PREPARED',
          retryable: false,
        },
        { status: 409 }
      );
    }

    const batches = session.batches ?? [];
    const targetBatch = batches.find((b) => b.batchIndex === batchIndex);
    if (!targetBatch) {
      return NextResponse.json(
        {
          error: 'নির্ধারিত ব্যাচ নম্বরটি পাওয়া যায়নি।',
          code: 'INVALID_BATCH_INDEX',
          retryable: false,
        },
        { status: 400 }
      );
    }

    session.status = 'processing';
    session.updatedAtMs = Date.now();

    const controller = new AbortController();
    const onRequestAbort = () => {
      controller.abort(new Error('Client disconnected during PDF batch extraction.'));
    };
    req.signal.addEventListener('abort', onRequestAbort, { once: true });
    session.activeAbortControllers.add(controller);

    let batchResult: BatchExtractionResult;
    try {
      if (
        session.validatedMimeType === 'image/png' ||
        session.validatedMimeType === 'image/jpeg' ||
        session.validatedMimeType === 'image/webp'
      ) {
        const imageBytes = await fs.readFile(targetBatch.filePath);
        batchResult = await extractSingleImageDocument({
          imageBytes,
          mimeType: session.validatedMimeType,
          useOcr: session.useOcr,
          originalPageNumber: targetBatch.originalStartPage,
          fallbackChapter: session.fallbackChapter,
          signal: controller.signal,
        });
      } else {
        batchResult = await extractSinglePdfBatch({
          batch: targetBatch,
          useOcr: session.useOcr,
          ocrSpeed: session.ocrSpeed,
          preferDelimitedFallback,
          fallbackChapter: session.fallbackChapter,
          signal: controller.signal,
          onGeminiFileUploaded: (fileName) => {
            session.activeGeminiFileNames.add(fileName);
          },
          onGeminiFileDeleted: (fileName) => {
            session.activeGeminiFileNames.delete(fileName);
          },
        });
      }
    } finally {
      req.signal.removeEventListener('abort', onRequestAbort);
      session.activeAbortControllers.delete(controller);
    }

    // Preserve any previously extracted pages if retrying a partial batch
    const previousBatchResult = session.batchResults.get(batchIndex);
    if (
      previousBatchResult &&
      previousBatchResult.pages.length > 0 &&
      batchResult.status !== 'success' &&
      batchResult.extractedPageCount < previousBatchResult.extractedPageCount
    ) {
      batchResult = previousBatchResult;
    }

    session.batchResults.set(batchIndex, batchResult);
    session.updatedAtMs = Date.now();

    // Free batch temp PDF progressively once fully extracted
    if (batchResult.status === 'success') {
      await removeFileSafe(targetBatch.filePath);
    }

    const localPagesCount = session.locallyExtractedPages?.length ?? 0;
    const completedPagesCount =
      localPagesCount +
      Array.from(session.batchResults.values()).reduce(
        (sum, r) => sum + r.extractedPageCount,
        0
      );
    const totalExpectedPages = session.actualPageCount ?? session.pageMappings?.length ?? 0;
    const quotaExhausted = batchResult.errorCode === 'AI_RATE_LIMITED';

    return NextResponse.json({
      sessionId: session.sessionId,
      batchIndex,
      totalBatches: batches.length,
      batchResult: {
        batchIndex: batchResult.batchIndex,
        status: batchResult.status,
        extractedPageCount: batchResult.extractedPageCount,
        expectedPageCount: batchResult.expectedMappings.length,
        missingOriginalPages: batchResult.missingOriginalPages,
        duplicateOriginalPages: batchResult.duplicateOriginalPages,
        outOfOrderDetected: batchResult.outOfOrderDetected,
        ocrUsed: batchResult.ocrUsed,
        usedFilesApi: batchResult.usedFilesApi,
        warnings: batchResult.warnings,
        error: batchResult.error,
        errorCode: batchResult.errorCode,
        retryable: batchResult.retryable,
      },
      completedPagesCount,
      totalExpectedPages,
      quotaExhausted,
    });
  } catch (error) {
    if (req.signal.aborted) {
      return NextResponse.json(
        {
          error: 'PDF প্রসেসিং বাতিল করা হয়েছে।',
          code: 'CANCELLED',
          retryable: false,
        },
        { status: 499 }
      );
    }

    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/extract-pdf/session/batch',
      'PDF ব্যাচ প্রসেস করা যায়নি।'
    );
  }
}
