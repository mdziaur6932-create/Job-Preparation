import fs from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { guardPdfSessionRequest } from '@/src/lib/ai-api-guard';
import {
  MAX_SINGLE_CHUNK_BYTES,
  MAX_UPLOAD_BYTES,
  formatFileTooLargeError,
  toBengaliNumber,
  validateUploadedDocumentHeader,
} from '@/src/lib/file-validation';
import { mapAiErrorToHttpResponse } from '@/src/lib/gemini';
import { safeDeleteGeminiFile } from '@/src/lib/pdf-extractor-service';
import {
  cleanupAndDeletePdfSession,
  getOwnedPdfSession,
} from '@/src/lib/pdf-session-store';

export async function GET(req: NextRequest) {
  const guard = await guardPdfSessionRequest(req, 'session-control');
  if (!guard.ok) {
    return guard.response;
  }

  const sessionId = req.nextUrl.searchParams.get('sessionId')?.trim() ?? '';
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
  return NextResponse.json({
    sessionId: session.sessionId,
    status: session.status,
    expectedFileSize: session.expectedFileSize,
    bytesReceived: session.bytesReceived,
    chunkSizeBytes: session.chunkSizeBytes,
    totalChunks: session.totalChunks,
    nextExpectedChunkIndex: session.nextExpectedChunkIndex,
    receivedChunkIndices: Array.from(session.receivedChunkIndices).sort((a, b) => a - b),
    uploadCompleted: session.uploadCompleted,
  });
}

export async function POST(req: NextRequest) {
  const guard = await guardPdfSessionRequest(req, 'session-chunk');
  if (!guard.ok) {
    return guard.response;
  }

  const declaredContentLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredContentLength) && declaredContentLength > MAX_SINGLE_CHUNK_BYTES) {
    return NextResponse.json(
      {
        error: formatFileTooLargeError(declaredContentLength, MAX_SINGLE_CHUNK_BYTES),
        code: 'CHUNK_TOO_LARGE',
        retryable: false,
      },
      { status: 413 }
    );
  }

  const sessionId =
    req.headers.get('x-session-id')?.trim() ||
    req.nextUrl.searchParams.get('sessionId')?.trim() ||
    '';
  const chunkIndexRaw =
    req.headers.get('x-chunk-index')?.trim() ??
    req.nextUrl.searchParams.get('chunkIndex')?.trim() ??
    '';

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

  if (session.status !== 'uploading' || session.uploadCompleted) {
    return NextResponse.json(
      {
        error: 'এই আপলোড সেশনে নতুন অংশ যুক্ত করা যাবে না (ইতিমধ্যে সম্পন্ন বা বাতিল হয়েছে)।',
        code: 'UPLOAD_ALREADY_COMPLETED',
        retryable: false,
      },
      { status: 409 }
    );
  }

  const chunkIndex = Number.parseInt(chunkIndexRaw, 10);
  if (
    !/^\d+$/.test(chunkIndexRaw) ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= session.totalChunks
  ) {
    return NextResponse.json(
      {
        error: 'অবৈধ Chunk ক্রমিক নম্বর পাওয়া গেছে।',
        code: 'INVALID_CHUNK_INDEX',
        retryable: false,
      },
      { status: 400 }
    );
  }

  if (session.receivedChunkIndices.has(chunkIndex)) {
    return NextResponse.json(
      {
        error: `Chunk ${toBengaliNumber(chunkIndex + 1)} ইতিমধ্যে সফলভাবে আপলোড হয়েছে।`,
        code: 'DUPLICATE_CHUNK',
        duplicate: true,
        retryable: false,
        chunkIndex,
        nextExpectedChunkIndex: session.nextExpectedChunkIndex,
        bytesReceived: session.bytesReceived,
        receivedChunkIndices: Array.from(session.receivedChunkIndices).sort((a, b) => a - b),
      },
      { status: 409 }
    );
  }

  if (chunkIndex !== session.nextExpectedChunkIndex) {
    return NextResponse.json(
      {
        error: `Chunk ক্রম মিলছে না (প্রত্যাশিত Chunk ${toBengaliNumber(session.nextExpectedChunkIndex + 1)}, পাওয়া গেছে ${toBengaliNumber(chunkIndex + 1)})।`,
        code: 'CHUNK_OUT_OF_ORDER',
        retryable: true,
        expectedChunkIndex: session.nextExpectedChunkIndex,
        receivedChunkIndex: chunkIndex,
        bytesReceived: session.bytesReceived,
      },
      { status: 409 }
    );
  }

  if (session.writeInFlight) {
    return NextResponse.json(
      {
        error: 'একই সেশনে পূর্ববর্তী Chunk এখনও লেখা হচ্ছে। অনুগ্রহ করে মুহূর্ত পর আবার চেষ্টা করুন।',
        code: 'CONCURRENT_CHUNK_WRITE',
        retryable: true,
      },
      { status: 409 }
    );
  }

  session.writeInFlight = true;
  try {
    const rawBuffer = await req.arrayBuffer();
    const chunkBytes = new Uint8Array(rawBuffer);

    if (chunkBytes.byteLength === 0) {
      return NextResponse.json(
        {
          error: 'খালি Chunk গ্রহণযোগ্য নয়।',
          code: 'EMPTY_CHUNK',
          retryable: true,
        },
        { status: 400 }
      );
    }

    if (chunkBytes.byteLength > MAX_SINGLE_CHUNK_BYTES) {
      return NextResponse.json(
        {
          error: formatFileTooLargeError(chunkBytes.byteLength, MAX_SINGLE_CHUNK_BYTES),
          code: 'CHUNK_TOO_LARGE',
          retryable: false,
        },
        { status: 413 }
      );
    }

    const expectedOffset = chunkIndex * session.chunkSizeBytes;
    const expectedChunkLength = Math.min(
      session.chunkSizeBytes,
      session.expectedFileSize - expectedOffset
    );

    if (
      chunkBytes.byteLength !== expectedChunkLength ||
      session.bytesReceived + chunkBytes.byteLength > session.expectedFileSize ||
      session.bytesReceived + chunkBytes.byteLength > MAX_UPLOAD_BYTES
    ) {
      return NextResponse.json(
        {
          error: 'Chunk-এর আকার প্রত্যাশিত ফাইলের আকারের সাথে মিলছে না।',
          code: 'INVALID_CHUNK_SIZE',
          retryable: false,
        },
        { status: 400 }
      );
    }

    // Validate actual binary magic bytes / text format immediately on Chunk 0
    if (chunkIndex === 0) {
      const headerValidation = validateUploadedDocumentHeader(
        session.fileName,
        session.declaredMimeType,
        chunkBytes.subarray(0, Math.min(chunkBytes.byteLength, 8192)),
        session.expectedFileSize,
        MAX_UPLOAD_BYTES
      );

      if (!headerValidation.ok) {
        await cleanupAndDeletePdfSession(session.sessionId, safeDeleteGeminiFile);
        return NextResponse.json(
          {
            error: headerValidation.error,
            code: headerValidation.code,
            retryable: false,
          },
          { status: 400 }
        );
      }

      session.validatedKind = headerValidation.kind;
      session.validatedMimeType = headerValidation.mimeType;
    }

    // Positional write guarantees zero duplicate bytes and avoids loading full file in RAM
    const openFlag = chunkIndex === 0 ? 'w' : 'r+';
    const fh = await fs.open(session.sourceFilePath, openFlag);
    try {
      await fh.write(chunkBytes, 0, chunkBytes.byteLength, expectedOffset);
    } finally {
      await fh.close();
    }

    session.receivedChunkIndices.add(chunkIndex);
    session.bytesReceived += chunkBytes.byteLength;
    session.nextExpectedChunkIndex = chunkIndex + 1;
    session.updatedAtMs = Date.now();
    session.uploadCompleted =
      session.bytesReceived === session.expectedFileSize &&
      session.receivedChunkIndices.size === session.totalChunks;

    return NextResponse.json({
      ok: true,
      sessionId: session.sessionId,
      chunkIndex,
      receivedChunksCount: session.receivedChunkIndices.size,
      totalChunks: session.totalChunks,
      bytesReceived: session.bytesReceived,
      expectedFileSize: session.expectedFileSize,
      nextExpectedChunkIndex: session.nextExpectedChunkIndex,
      uploadCompleted: session.uploadCompleted,
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/extract-pdf/session/chunk',
      'ফাইলের অংশ (Chunk) সংরক্ষণ করা যায়নি।'
    );
  } finally {
    session.writeInFlight = false;
  }
}
