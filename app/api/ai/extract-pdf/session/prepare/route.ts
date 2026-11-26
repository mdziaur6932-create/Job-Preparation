import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { guardAiApiRequest } from '@/src/lib/ai-api-guard';
import {
  DOCX_MIME_TYPE,
  MAX_UPLOAD_BYTES,
  validateUploadedDocumentHeader,
} from '@/src/lib/file-validation';
import { extractDocxDocument } from '@/src/lib/docx-extractor';
import {
  AiInvalidRequestError,
  mapAiErrorToHttpResponse,
  parseJsonBody,
} from '@/src/lib/gemini';
import { safeDeleteGeminiFile } from '@/src/lib/pdf-extractor-service';
import {
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_PAGES_PER_BATCH,
  FAST_OCR_MAX_PAGES_PER_BATCH,
  type PdfOcrSpeed,
  buildPageMappings,
  combineBatchExtractions,
  stripPageMarkersAndHeaders,
} from '@/src/lib/pdf-rules';
import {
  assertConfinedTempPath,
  cleanupAndDeletePdfSession,
  getOwnedPdfSession,
  removeFileSafe,
} from '@/src/lib/pdf-session-store';
import {
  type PdfOcrMode,
  prepareAndSplitPdfOnDisk,
} from '@/src/lib/pdf-splitter';

export const maxDuration = 120;

interface PrepareBody {
  sessionId?: string;
  pageRangeInput?: string;
  useOcr?: boolean;
  ocrMode?: PdfOcrMode;
  ocrSpeed?: PdfOcrSpeed;
  fallbackChapter?: string;
}

async function readLeadingBytes(filePath: string, maxBytes = 8192): Promise<Uint8Array> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function POST(req: NextRequest) {
  // Enforce authenticated user + primary 5/10min extract-pdf AI extraction quota (once per document)
  const guard = await guardAiApiRequest(req, 'extract-pdf');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<PrepareBody>(req);
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

    if (session.status === 'cancelled' || session.status === 'finalized') {
      return NextResponse.json(
        {
          error: 'এই আপলোড সেশনটি ইতিমধ্যে সম্পন্ন বা বাতিল হয়েছে।',
          code: 'SESSION_CLOSED',
          retryable: false,
        },
        { status: 409 }
      );
    }

    if (session.status === 'prepared' || session.status === 'processing') {
      return NextResponse.json(
        {
          error: 'এই আপলোড সেশনটি ইতিমধ্যে প্রস্তুত করা হয়েছে।',
          code: 'SESSION_ALREADY_PREPARED',
          retryable: false,
        },
        { status: 409 }
      );
    }

    if (
      !session.uploadCompleted ||
      session.bytesReceived !== session.expectedFileSize ||
      session.receivedChunkIndices.size !== session.totalChunks
    ) {
      return NextResponse.json(
        {
          error: 'সম্পূর্ণ ফাইল আপলোড শেষ হওয়ার আগে প্রসেসিং শুরু করা যাবে না।',
          code: 'UPLOAD_INCOMPLETE',
          retryable: true,
          bytesReceived: session.bytesReceived,
          expectedFileSize: session.expectedFileSize,
          nextExpectedChunkIndex: session.nextExpectedChunkIndex,
        },
        { status: 400 }
      );
    }

    if (typeof body.pageRangeInput === 'string') {
      session.pageRangeInput = body.pageRangeInput.trim().slice(0, 80);
    }
    if (typeof body.useOcr === 'boolean') {
      session.useOcr = body.useOcr;
    }
    if (body.ocrMode === 'auto' || body.ocrMode === 'force') {
      session.ocrMode = body.ocrMode;
    }
    if (body.ocrSpeed === 'fast' || body.ocrSpeed === 'accurate') {
      session.ocrSpeed = body.ocrSpeed;
    }
    if (typeof body.fallbackChapter === 'string' && body.fallbackChapter.trim()) {
      session.fallbackChapter = body.fallbackChapter.trim().slice(0, 160);
    }

    const stat = await fs.stat(session.sourceFilePath);
    if (stat.size !== session.expectedFileSize || stat.size > MAX_UPLOAD_BYTES) {
      await cleanupAndDeletePdfSession(session.sessionId, safeDeleteGeminiFile);
      return NextResponse.json(
        {
          error: 'সংরক্ষিত ফাইলের প্রকৃত আকার প্রত্যাশিত আকারের সাথে মিলছে না। অনুগ্রহ করে পুনরায় আপলোড করুন।',
          code: 'FILE_SIZE_MISMATCH',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const headerBytes = await readLeadingBytes(session.sourceFilePath, 8192);
    const headerValidation = validateUploadedDocumentHeader(
      session.fileName,
      session.declaredMimeType,
      headerBytes,
      stat.size,
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

    // Fast path for plain text / markdown files
    if (headerValidation.kind === 'text') {
      const fileBytes = await fs.readFile(session.sourceFilePath);
      const rawText = new TextDecoder('utf-8').decode(fileBytes).trim();
      await cleanupAndDeletePdfSession(session.sessionId, safeDeleteGeminiFile);

      const meaningfulCharCount = stripPageMarkersAndHeaders(rawText).length;
      if (!rawText || meaningfulCharCount === 0) {
        return NextResponse.json(
          {
            error: 'টেক্সট ফাইলটিতে কোনো পাঠযোগ্য বিষয়বস্তু পাওয়া যায়নি।',
            code: 'EMPTY_FILE',
            retryable: false,
          },
          { status: 400 }
        );
      }

      const estimatedPages = Math.max(1, Math.ceil(rawText.length / 1800));
      return NextResponse.json({
        immediate: true,
        kind: 'text',
        result: {
          extractionStatus: 'success',
          method: 'text',
          ocrCompleted: false,
          actualPageCount: estimatedPages,
          expectedPageCount: estimatedPages,
          extractedPageCount: estimatedPages,
          totalPages: estimatedPages,
          originalPageRange: estimatedPages === 1 ? '1' : `1-${estimatedPages}`,
          totalBatches: 1,
          completedBatches: 1,
          failedBatches: 0,
          missingOriginalPages: [],
          duplicateOriginalPages: [],
          outOfOrderDetected: false,
          sections: [
            {
              chapter: session.fallbackChapter,
              pageNumber: 1,
              pdfPageIndex: 1,
              content: rawText,
            },
          ],
          rawText,
          meaningfulCharCount,
          warnings: [],
        },
      });
    }

    // Fast path for Word (.docx) files (local extraction, 0 Gemini calls)
    if (headerValidation.mimeType === DOCX_MIME_TYPE) {
      const fileBytes = await fs.readFile(session.sourceFilePath);
      const docxOutcome = await extractDocxDocument({
        bytes: fileBytes,
        fileName: session.fileName,
        fallbackChapter: session.fallbackChapter,
        pageRangeInput: session.pageRangeInput,
        maxBytes: MAX_UPLOAD_BYTES,
      });
      await cleanupAndDeletePdfSession(session.sessionId, safeDeleteGeminiFile);

      if (!docxOutcome.ok) {
        return NextResponse.json(
          {
            error: docxOutcome.error,
            code: docxOutcome.code,
            retryable: false,
          },
          { status: 400 }
        );
      }

      return NextResponse.json({
        immediate: true,
        kind: 'docx',
        documentProfile: 'text_based',
        actualPageCount: docxOutcome.extraction.actualPageCount,
        originalPageRange: docxOutcome.extraction.originalPageRange,
        localPagesCount: docxOutcome.extraction.extractedPageCount,
        ocrPagesCount: 0,
        pagesRequiringOcrCount: 0,
        totalBatches: 0,
        result: {
          ...docxOutcome.extraction,
          totalPages: docxOutcome.extraction.actualPageCount,
        },
      });
    }

    // Single-image OCR path (PNG / JPEG / WebP)
    if (headerValidation.mimeType !== 'application/pdf') {
      const mappingResult = buildPageMappings(1, session.pageRangeInput);
      if (!mappingResult.ok) {
        return NextResponse.json(
          {
            error: mappingResult.error,
            code: 'INVALID_REQUEST',
            retryable: false,
          },
          { status: 400 }
        );
      }

      session.actualPageCount = 1;
      session.originalPageRangeLabel = mappingResult.originalPageRangeLabel;
      session.documentProfile = 'scanned';
      session.pagesRequiringOcr = [1];
      session.pageMappings = mappingResult.mappings;
      session.batches = [
        {
          batchIndex: 0,
          filePath: session.sourceFilePath,
          byteSize: stat.size,
          pageMappings: mappingResult.mappings,
          internalStartPage: 1,
          internalEndPage: 1,
          originalStartPage: mappingResult.startPage,
          originalEndPage: mappingResult.endPage,
          requiresOcrPageIndices: [1],
          hasTextLayerPageIndices: [],
        },
      ];
      session.status = 'prepared';
      session.updatedAtMs = Date.now();

      return NextResponse.json({
        immediate: false,
        sessionId: session.sessionId,
        kind: 'image',
        actualPageCount: 1,
        originalPageRange: mappingResult.originalPageRangeLabel,
        documentProfile: 'scanned',
        pagesRequiringOcrCount: 1,
        totalBatches: 1,
        batches: [
          {
            batchIndex: 0,
            byteSize: stat.size,
            pageCount: 1,
            internalStartPage: 1,
            internalEndPage: 1,
            originalStartPage: mappingResult.startPage,
            originalEndPage: mappingResult.endPage,
          },
        ],
      });
    }

    // PDF path: single-pass load, validate, local text extraction, and OCR-only <= 35 MB batch splitting
    const batchesDir = assertConfinedTempPath(path.join(session.sessionDir, 'batches'));

    let splitOutput: Awaited<ReturnType<typeof prepareAndSplitPdfOnDisk>>;
    try {
      const maxPagesPerBatch =
        session.ocrSpeed === 'fast'
          ? FAST_OCR_MAX_PAGES_PER_BATCH
          : DEFAULT_MAX_PAGES_PER_BATCH;

      splitOutput = await prepareAndSplitPdfOnDisk({
        sourcePdfPath: session.sourceFilePath,
        outputDir: batchesDir,
        pageRangeInput: session.pageRangeInput,
        fallbackChapter: session.fallbackChapter,
        ocrMode: session.ocrMode,
        maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
        maxPagesPerBatch,
      });
    } catch (splitErr) {
      // Keep the uploaded file alive ONLY if the error was a fixable page-range mismatch
      const isRangeMismatch =
        splitErr instanceof AiInvalidRequestError &&
        /প্রকৃত পৃষ্ঠা সংখ্যা|পৃষ্ঠা রেঞ্জ|পৃষ্ঠা নম্বর/.test(splitErr.bengaliMessage);
      if (!isRangeMismatch) {
        await cleanupAndDeletePdfSession(session.sessionId, safeDeleteGeminiFile);
      }
      throw splitErr;
    }

    const localPagesCount = splitOutput.locallyExtractedPages.length;
    const ocrPagesCount = splitOutput.pageMappings.length - localPagesCount;

    // Fast path: 100% searchable / already-OCR'd PDF -> 0 Gemini API calls, immediate result!
    if (
      splitOutput.batches.length === 0 &&
      localPagesCount === splitOutput.pageMappings.length
    ) {
      const combined = combineBatchExtractions({
        totalExpectedMappings: splitOutput.pageMappings,
        originalPageRange: splitOutput.originalPageRangeLabel,
        batchResults: [],
        localPages: splitOutput.locallyExtractedPages,
        fallbackChapter: session.fallbackChapter,
      });

      session.status = 'finalized';
      await cleanupAndDeletePdfSession(session.sessionId, safeDeleteGeminiFile);

      return NextResponse.json({
        immediate: true,
        kind: 'pdf',
        documentProfile: 'text_based',
        actualPageCount: combined.actualPageCount,
        originalPageRange: combined.originalPageRange,
        localPagesCount,
        ocrPagesCount: 0,
        pagesRequiringOcrCount: 0,
        totalBatches: 0,
        result: {
          ...combined,
          totalPages: combined.actualPageCount,
        },
      });
    }

    session.actualPageCount = splitOutput.inspection.actualPageCount;
    session.originalPageRangeLabel = splitOutput.originalPageRangeLabel;
    session.documentProfile = splitOutput.inspection.documentProfile;
    session.pagesRequiringOcr = splitOutput.inspection.pagesRequiringOcr;
    session.pageMappings = splitOutput.pageMappings;
    session.locallyExtractedPages = splitOutput.locallyExtractedPages;
    session.batches = splitOutput.batches;
    session.status = 'prepared';
    session.updatedAtMs = Date.now();

    // Free source.bin immediately after OCR-only batch PDFs are written so disk usage stays bounded
    await removeFileSafe(session.sourceFilePath);

    return NextResponse.json({
      immediate: false,
      sessionId: session.sessionId,
      kind: 'pdf',
      actualPageCount: splitOutput.inspection.actualPageCount,
      originalPageRange: splitOutput.originalPageRangeLabel,
      documentProfile: splitOutput.inspection.documentProfile,
      localPagesCount,
      ocrPagesCount,
      pagesRequiringOcrCount: splitOutput.inspection.pagesRequiringOcr.length,
      totalBatches: splitOutput.batches.length,
      batches: splitOutput.batches.map((b) => ({
        batchIndex: b.batchIndex,
        byteSize: b.byteSize,
        pageCount: b.pageMappings.length,
        internalStartPage: b.internalStartPage,
        internalEndPage: b.internalEndPage,
        originalStartPage: b.originalStartPage,
        originalEndPage: b.originalEndPage,
      })),
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/extract-pdf/session/prepare',
      'PDF যাচাই ও ব্যাচ বিভাজন সম্পন্ন করা যায়নি।'
    );
  }
}
