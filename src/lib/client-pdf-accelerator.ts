import { tryConvertBijoyPageText } from './bijoy-to-unicode';
import {
  normalizeExamDocumentFormatting,
  reconstructPdfPageTextFromTextItems,
} from './exam-text-formatter';
import { toBengaliNumber } from './file-validation';
import {
  type CombinedExtractionResult,
  type NormalizedExtractedPage,
  buildPageMappings,
  combineBatchExtractions,
  evaluateLocalExtractedPageText,
  parsePdfPageSubsetSyntax,
} from './pdf-rules';

/**
 * Maximum PDF size (45 MB) for instant client-side browser text pre-extraction / page slicing.
 * Larger PDFs go straight to the resumable chunked server pipeline to avoid browser RAM pressure.
 */
export const MAX_CLIENT_ACCELERATOR_BYTES = 45 * 1024 * 1024;

export type ClientPdfAcceleratorOutcome =
  | {
      kind: 'extracted_locally';
      extraction: CombinedExtractionResult;
      effectiveFile: File;
      slicedFromTotalPages?: number;
      bijoyPagesConverted: number;
    }
  | {
      kind: 'needs_cloud_ocr';
      effectiveFile: File;
      effectivePageRangeInput: string;
      slicedFromTotalPages?: number;
      actualPageCount?: number;
    }
  | {
      kind: 'validation_error';
      error: string;
    };

/**
 * Slices a subset of pages (e.g., 1-25 out of 100 pages) directly in the browser using `pdf-lib`
 * BEFORE uploading so the user transfers a 4x smaller file and completes OCR in seconds.
 */
export async function slicePdfFileInBrowser(params: {
  file: File;
  startPage: number;
  endPage: number;
}): Promise<{ file: File; totalSourcePages: number; clampedEnd: number }> {
  const { PDFDocument } = await import('pdf-lib');
  const rawBytes = new Uint8Array(await params.file.arrayBuffer());
  const srcDoc = await PDFDocument.load(rawBytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const totalSourcePages = srcDoc.getPageCount();
  if (totalSourcePages < 1) {
    throw new Error('PDF ফাইলটিতে কোনো বৈধ পৃষ্ঠা পাওয়া যায়নি।');
  }
  if (params.startPage > totalSourcePages) {
    throw new Error(
      `এই PDF-এ মোট ${toBengaliNumber(totalSourcePages)}টি পৃষ্ঠা রয়েছে, কিন্তু শুরুর পৃষ্ঠা দেওয়া হয়েছে ${toBengaliNumber(params.startPage)}।`
    );
  }
  const clampedEnd = Math.min(params.endPage, totalSourcePages);

  // If subset covers the entire PDF, keep original file untouched
  if (params.startPage === 1 && clampedEnd === totalSourcePages) {
    return { file: params.file, totalSourcePages, clampedEnd };
  }

  const subDoc = await PDFDocument.create();
  const indices: number[] = [];
  for (let p = params.startPage; p <= clampedEnd; p += 1) {
    indices.push(p - 1);
  }
  const copied = await subDoc.copyPages(srcDoc, indices);
  for (const page of copied) {
    subDoc.addPage(page);
  }
  const slicedBytes = await subDoc.save({ useObjectStreams: true });
  const baseName = params.file.name.replace(/\.pdf$/i, '');
  const slicedName = `${baseName}_p${params.startPage}-${clampedEnd}.pdf`;
  const slicedBuffer = slicedBytes.buffer.slice(
    slicedBytes.byteOffset,
    slicedBytes.byteOffset + slicedBytes.byteLength
  ) as ArrayBuffer;
  const slicedFile = new File([slicedBuffer], slicedName, {
    type: 'application/pdf',
  });

  return { file: slicedFile, totalSourcePages, clampedEnd };
}

/**
 * Slices an arbitrary list of specific 1-based PDF page indices (e.g., [71, 72, 73, 74] or
 * non-contiguous [37, 40, 61]) into a tiny mini-PDF in the browser so only missing pages
 * need to be uploaded and OCR'd — preserving 100% of already-extracted pages.
 */
export async function sliceSpecificPdfPagesInBrowser(params: {
  file: File;
  /** 1-based internal page indices inside `file` to extract. */
  pdfPageIndices: number[];
  /** Optional mapping from 1-based internal page index -> original printed book page number. */
  originalPageNumberByPdfIndex?: Map<number, number>;
}): Promise<{
  file: File;
  totalSourcePages: number;
  targets: Array<{ pdfPageIndex: number; originalPageNumber: number }>;
}> {
  const { PDFDocument } = await import('pdf-lib');
  const rawBytes = new Uint8Array(await params.file.arrayBuffer());
  const srcDoc = await PDFDocument.load(rawBytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const totalSourcePages = srcDoc.getPageCount();
  if (totalSourcePages < 1) {
    throw new Error('PDF ফাইলটিতে কোনো বৈধ পৃষ্ঠা পাওয়া যায়নি।');
  }

  const uniqueValidIndices = Array.from(
    new Set(
      params.pdfPageIndices
        .map((n) => Math.trunc(n))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= totalSourcePages)
    )
  ).sort((a, b) => a - b);

  if (uniqueValidIndices.length === 0) {
    throw new Error('অনুপস্থিত পৃষ্ঠাগুলো PDF ফাইলে শনাক্ত করা যায়নি।');
  }

  const subDoc = await PDFDocument.create();
  const zeroBased = uniqueValidIndices.map((p) => p - 1);
  const copied = await subDoc.copyPages(srcDoc, zeroBased);
  for (const page of copied) {
    subDoc.addPage(page);
  }

  const slicedBytes = await subDoc.save({ useObjectStreams: true });
  const baseName = params.file.name.replace(/\.pdf$/i, '');
  const label =
    uniqueValidIndices.length <= 4
      ? uniqueValidIndices.join('_')
      : `${uniqueValidIndices[0]}-${uniqueValidIndices[uniqueValidIndices.length - 1]}_${uniqueValidIndices.length}p`;
  const slicedName = `${baseName}_missing_${label}.pdf`;
  const slicedBuffer = slicedBytes.buffer.slice(
    slicedBytes.byteOffset,
    slicedBytes.byteOffset + slicedBytes.byteLength
  ) as ArrayBuffer;

  const slicedFile = new File([slicedBuffer], slicedName, {
    type: 'application/pdf',
  });

  const targets = uniqueValidIndices.map((pdfPageIndex) => ({
    pdfPageIndex,
    originalPageNumber:
      params.originalPageNumberByPdfIndex?.get(pdfPageIndex) ?? pdfPageIndex,
  }));

  return { file: slicedFile, totalSourcePages, targets };
}

/**
 * Browser-side PDF accelerator powered by `pdf-lib` + `unpdf` (PDF.js) + Bijoy-to-Unicode:
 * 1. If the user selected a fast page subset (e.g. "1-25"), slices ONLY those pages in-browser first.
 * 2. When `forceOcr` is false and the file is <= 45 MB, runs instant in-browser text extraction.
 *    - 100% searchable Unicode OR Bijoy/SutonnyMJ PDFs finish in ~1–2 seconds with ZERO upload & ZERO AI calls!
 *    - Scanned image PDFs fail fast and hand off seamlessly to the server Turbo Parallel OCR pipeline.
 */
export async function tryFastClientPdfPreprocess(params: {
  file: File;
  pageRangeInput?: string;
  pdfSubsetInput?: string;
  fallbackChapter?: string;
  forceOcr?: boolean;
  onStatus?: (statusMessage: string) => void;
}): Promise<ClientPdfAcceleratorOutcome> {
  const {
    file,
    pageRangeInput = '',
    pdfSubsetInput = '',
    fallbackChapter = 'অধ্যায় ১',
    forceOcr = false,
    onStatus,
  } = params;

  const isPdf =
    file.name.toLowerCase().endsWith('.pdf') ||
    file.type.toLowerCase() === 'application/pdf';
  if (!isPdf) {
    return {
      kind: 'needs_cloud_ocr',
      effectiveFile: file,
      effectivePageRangeInput: pageRangeInput.trim(),
    };
  }

  // Step 1: Validate & apply optional PDF page subset slice (e.g., "1-25" out of 100 pages)
  const subsetCheck = parsePdfPageSubsetSyntax(pdfSubsetInput);
  if (!subsetCheck.ok) {
    return { kind: 'validation_error', error: subsetCheck.error };
  }

  let effectiveFile = file;
  let effectivePageRangeInput = pageRangeInput.trim();
  let slicedFromTotalPages: number | undefined;

  if (!subsetCheck.empty && subsetCheck.startPage !== null && subsetCheck.endPage !== null) {
    if (file.size > MAX_CLIENT_ACCELERATOR_BYTES) {
      return {
        kind: 'validation_error',
        error:
          '৪৫ MB-এর বড় PDF ব্রাউজারে স্লাইস করা যাবে না। অনুগ্রহ করে "সব পৃষ্ঠা" নির্বাচন করে আপলোড করুন।',
      };
    }
    try {
      onStatus?.(
        `পৃষ্ঠা ${toBengaliNumber(subsetCheck.startPage)}–${toBengaliNumber(subsetCheck.endPage)} আলাদা করা হচ্ছে...`
      );
      const sliced = await slicePdfFileInBrowser({
        file,
        startPage: subsetCheck.startPage,
        endPage: subsetCheck.endPage,
      });
      effectiveFile = sliced.file;
      slicedFromTotalPages = sliced.totalSourcePages;
      // Preserve true printed page numbers when no custom originalPageRange was specified
      if (!effectivePageRangeInput) {
        effectivePageRangeInput =
          subsetCheck.startPage === sliced.clampedEnd
            ? `${subsetCheck.startPage}`
            : `${subsetCheck.startPage}-${sliced.clampedEnd}`;
      }
    } catch (sliceErr) {
      return {
        kind: 'validation_error',
        error:
          sliceErr instanceof Error
            ? sliceErr.message
            : 'নির্দিষ্ট পৃষ্ঠা আলাদা করতে সমস্যা হয়েছে।',
      };
    }
  }

  // Step 2: Fast in-browser local text + Bijoy extraction (skip if forceOcr or > 45 MB)
  if (forceOcr || effectiveFile.size > MAX_CLIENT_ACCELERATOR_BYTES) {
    return {
      kind: 'needs_cloud_ocr',
      effectiveFile,
      effectivePageRangeInput,
      slicedFromTotalPages,
    };
  }

  try {
    onStatus?.('ব্রাউজারে দ্রুত টেক্সট লেয়ার যাচাই করা হচ্ছে...');
    const { extractText, extractTextItems, getDocumentProxy } = await import('unpdf');
    const bytes = new Uint8Array(await effectiveFile.arrayBuffer());
    const pdfProxy = await getDocumentProxy(bytes);
    let rawPages: string[] | null = null;
    try {
      try {
        const positioned = await extractTextItems(pdfProxy);
        if (Array.isArray(positioned.items) && positioned.items.length > 0) {
          rawPages = positioned.items.map((pageItems) =>
            reconstructPdfPageTextFromTextItems(pageItems)
          );
        }
      } catch {
        // Fallback to plain extractText using the same proxy
      }
      if (!rawPages) {
        const extracted = await extractText(pdfProxy, { mergePages: false });
        rawPages = Array.isArray(extracted.text) ? extracted.text : null;
      }
    } finally {
      try {
        const closable = pdfProxy as unknown as {
          destroy?: () => Promise<void>;
          cleanup?: () => Promise<void>;
        };
        if (typeof closable.destroy === 'function') {
          await closable.destroy();
        } else if (typeof closable.cleanup === 'function') {
          await closable.cleanup();
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    if (!rawPages || rawPages.length === 0) {
      return {
        kind: 'needs_cloud_ocr',
        effectiveFile,
        effectivePageRangeInput,
        slicedFromTotalPages,
      };
    }

    const actualPageCount = rawPages.length;
    const mappingResult = buildPageMappings(actualPageCount, effectivePageRangeInput);
    if (!mappingResult.ok) {
      return { kind: 'validation_error', error: mappingResult.error };
    }

    const localPages: NormalizedExtractedPage[] = [];
    let bijoyPagesConverted = 0;
    let missingAnyPage = false;

    for (let idx = 0; idx < mappingResult.mappings.length; idx += 1) {
      const mapping = mappingResult.mappings[idx];
      const rawText = rawPages[idx] ?? '';
      const evalResult = evaluateLocalExtractedPageText(rawText);

      if (evalResult.usable) {
        localPages.push({
          pdfPageIndex: mapping.pdfPageIndex,
          originalPageNumber: mapping.originalPageNumber,
          chapter: fallbackChapter,
          content: evalResult.cleanedText,
          charCount: evalResult.substantiveLength,
          hasReadableText: true,
          ocrUsed: false,
          isShortWarning: false,
        });
      } else {
        const bijoy = tryConvertBijoyPageText(rawText, false);
        if (bijoy.converted) {
          bijoyPagesConverted += 1;
          localPages.push({
            pdfPageIndex: mapping.pdfPageIndex,
            originalPageNumber: mapping.originalPageNumber,
            chapter: fallbackChapter,
            content: normalizeExamDocumentFormatting(bijoy.text),
            charCount: bijoy.substantiveLength,
            hasReadableText: true,
            ocrUsed: false,
            isShortWarning: false,
          });
        } else {
          missingAnyPage = true;
          break;
        }
      }
    }

    if (!missingAnyPage && localPages.length === actualPageCount) {
      const combined = combineBatchExtractions({
        totalExpectedMappings: mappingResult.mappings,
        originalPageRange: mappingResult.originalPageRangeLabel,
        batchResults: [],
        localPages,
        fallbackChapter,
      });

      if (combined.extractionStatus === 'success') {
        return {
          kind: 'extracted_locally',
          extraction: combined,
          effectiveFile,
          slicedFromTotalPages,
          bijoyPagesConverted,
        };
      }
    }

    return {
      kind: 'needs_cloud_ocr',
      effectiveFile,
      effectivePageRangeInput,
      slicedFromTotalPages,
      actualPageCount,
    };
  } catch {
    // If browser PDF.js cannot parse a complex/encrypted PDF, fall back gracefully to server pipeline
    return {
      kind: 'needs_cloud_ocr',
      effectiveFile,
      effectivePageRangeInput,
      slicedFromTotalPages,
    };
  }
}
