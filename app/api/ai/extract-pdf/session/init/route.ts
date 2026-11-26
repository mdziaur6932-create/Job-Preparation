import { NextRequest, NextResponse } from 'next/server';
import { guardPdfSessionRequest } from '@/src/lib/ai-api-guard';
import {
  CHUNK_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_BYTES,
  validateDeclaredUploadMetadata,
} from '@/src/lib/file-validation';
import { parseJsonBody, mapAiErrorToHttpResponse } from '@/src/lib/gemini';
import { parseOriginalPageRangeSyntax, type PdfOcrSpeed } from '@/src/lib/pdf-rules';
import {
  PdfSessionLimitError,
  createPdfUploadSession,
} from '@/src/lib/pdf-session-store';

interface InitUploadBody {
  fileName?: string;
  declaredMimeType?: string;
  fileSize?: number;
  chunkSizeBytes?: number;
  useOcr?: boolean;
  ocrMode?: 'auto' | 'force';
  ocrSpeed?: PdfOcrSpeed;
  pageRangeInput?: string;
  fallbackChapter?: string;
}

const MIN_CHUNK_SIZE_BYTES = 64 * 1024; // 64 KB lower bound for tests/custom transports

export async function POST(req: NextRequest) {
  const guard = await guardPdfSessionRequest(req, 'session-init');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<InitUploadBody>(req);
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
    const declaredMimeType =
      typeof body.declaredMimeType === 'string' ? body.declaredMimeType.trim() : '';
    const fileSize = typeof body.fileSize === 'number' ? Math.trunc(body.fileSize) : 0;
    const useOcr = body.useOcr !== false;
    const ocrMode = body.ocrMode === 'force' ? 'force' : 'auto';
    const ocrSpeed: PdfOcrSpeed = body.ocrSpeed === 'fast' ? 'fast' : 'accurate';
    const pageRangeInput =
      typeof body.pageRangeInput === 'string' ? body.pageRangeInput.trim() : '';
    const fallbackChapter =
      typeof body.fallbackChapter === 'string' ? body.fallbackChapter.trim() : '';

    const metaValidation = validateDeclaredUploadMetadata({
      fileName,
      declaredMimeType,
      fileSize,
      maxBytes: MAX_UPLOAD_BYTES,
    });

    if (!metaValidation.ok) {
      return NextResponse.json(
        {
          error: metaValidation.error,
          code: metaValidation.code,
          retryable: false,
          maxUploadBytes: MAX_UPLOAD_BYTES,
        },
        { status: 400 }
      );
    }

    const syntaxCheck = parseOriginalPageRangeSyntax(pageRangeInput);
    if (!syntaxCheck.ok) {
      return NextResponse.json(
        {
          error: syntaxCheck.error,
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const requestedChunkSize =
      typeof body.chunkSizeBytes === 'number' && Number.isFinite(body.chunkSizeBytes)
        ? Math.trunc(body.chunkSizeBytes)
        : CHUNK_UPLOAD_SIZE_BYTES;

    const chunkSizeBytes = Math.min(
      CHUNK_UPLOAD_SIZE_BYTES,
      Math.max(MIN_CHUNK_SIZE_BYTES, requestedChunkSize)
    );
    const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSizeBytes));

    const session = await createPdfUploadSession({
      ownerDbUserId: guard.session.dbUserId,
      ownerUid: guard.session.uid,
      fileName,
      declaredMimeType,
      expectedFileSize: fileSize,
      chunkSizeBytes,
      totalChunks,
      useOcr,
      ocrMode,
      ocrSpeed,
      pageRangeInput,
      fallbackChapter,
    });

    return NextResponse.json({
      sessionId: session.sessionId,
      expectedKind: metaValidation.expectedKind,
      chunkSizeBytes: session.chunkSizeBytes,
      totalChunks: session.totalChunks,
      expectedFileSize: session.expectedFileSize,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    });
  } catch (error) {
    if (error instanceof PdfSessionLimitError) {
      return NextResponse.json(
        {
          error: error.message,
          code: 'TOO_MANY_ACTIVE_SESSIONS',
          retryable: true,
        },
        { status: 429 }
      );
    }

    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/extract-pdf/session/init',
      'PDF আপলোড সেশন তৈরি করা যায়নি।'
    );
  }
}
