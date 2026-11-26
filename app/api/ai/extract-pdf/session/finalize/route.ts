import { NextRequest, NextResponse } from 'next/server';
import { guardPdfSessionRequest } from '@/src/lib/ai-api-guard';
import { mapAiErrorToHttpResponse, parseJsonBody } from '@/src/lib/gemini';
import { safeDeleteGeminiFile } from '@/src/lib/pdf-extractor-service';
import {
  type BatchExtractionResult,
  combineBatchExtractions,
} from '@/src/lib/pdf-rules';
import {
  cleanupAndDeletePdfSession,
  getOwnedPdfSession,
} from '@/src/lib/pdf-session-store';

interface FinalizeBody {
  sessionId?: string;
}

export async function POST(req: NextRequest) {
  const guard = await guardPdfSessionRequest(req, 'session-control');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<FinalizeBody>(req);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';

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

    if (!session.pageMappings || !session.batches) {
      await cleanupAndDeletePdfSession(session.sessionId, safeDeleteGeminiFile);
      return NextResponse.json(
        {
          error: 'সেশনটি চূড়ান্ত করার আগে প্রসেসিং প্রস্তুত করা হয়নি।',
          code: 'SESSION_NOT_PREPARED',
          retryable: false,
        },
        { status: 400 }
      );
    }

    try {
      // Ensure any unexecuted batch (e.g. halted early due to 429 quota) is accounted for as failed
      const allBatchResults: BatchExtractionResult[] = session.batches.map((descriptor) => {
        const existing = session.batchResults.get(descriptor.batchIndex);
        if (existing) {
          return existing;
        }
        return {
          batchIndex: descriptor.batchIndex,
          status: 'failed',
          expectedMappings: descriptor.pageMappings,
          pages: [],
          extractedPageCount: 0,
          missingOriginalPages: descriptor.pageMappings.map((m) => m.originalPageNumber),
          duplicateOriginalPages: [],
          outOfOrderDetected: false,
          ocrUsed: false,
          usedFilesApi: false,
          warnings: [],
          error: 'এই ব্যাচটি সম্পন্ন হয়নি।',
        };
      });

      const combined = combineBatchExtractions({
        totalExpectedMappings: session.pageMappings,
        originalPageRange:
          session.originalPageRangeLabel ??
          (session.pageMappings.length === 1
            ? `${session.pageMappings[0].originalPageNumber}`
            : `${session.pageMappings[0].originalPageNumber}-${session.pageMappings[session.pageMappings.length - 1].originalPageNumber}`),
        batchResults: allBatchResults,
        localPages: session.locallyExtractedPages ?? [],
        fallbackChapter: session.fallbackChapter,
      });

      session.status = 'finalized';

      return NextResponse.json({
        ...combined,
        totalPages: combined.actualPageCount,
      });
    } finally {
      await cleanupAndDeletePdfSession(session.sessionId, safeDeleteGeminiFile);
    }
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/extract-pdf/session/finalize',
      'PDF এক্সট্র্যাকশন ফলাফল সমন্বয় করা যায়নি।'
    );
  }
}
