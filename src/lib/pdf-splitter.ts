import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { extractText, extractTextItems, getDocumentProxy } from 'unpdf';
import { AiInvalidRequestError } from './gemini';
import {
  normalizeExamDocumentFormatting,
  reconstructPdfPageTextFromTextItems,
} from './exam-text-formatter';
import {
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_PAGES_PER_BATCH,
  MAX_SAFE_BATCH_BYTES,
  MAX_SINGLE_PAGE_PDF_BYTES,
  buildPageMappings,
  evaluateLocalExtractedPageText,
  type DocumentTextProfile,
  type NormalizedExtractedPage,
  type PageMapping,
} from './pdf-rules';
import { isBijoyFontName, tryConvertBijoyPageText } from './bijoy-to-unicode';
import { formatFileSize, toBengaliNumber } from './file-validation';

export type PdfOcrMode = 'auto' | 'force';

export interface PdfInspectionResult {
  actualPageCount: number;
  pagesWithTextLayer: number[];
  pagesRequiringOcr: number[];
  pagesWithBijoyFont?: number[];
  documentProfile: DocumentTextProfile;
}

export interface SplitPdfBatchDescriptor {
  batchIndex: number;
  filePath: string;
  byteSize: number;
  pageMappings: PageMapping[];
  internalStartPage: number;
  internalEndPage: number;
  originalStartPage: number;
  originalEndPage: number;
  requiresOcrPageIndices: number[];
  hasTextLayerPageIndices: number[];
}

function classifyPdfPageResources(
  pdfDoc: PDFDocument,
  zeroBasedIndex: number
): { hasFont: boolean; hasImageXObject: boolean; hasBijoyFont: boolean } {
  let hasFont = false;
  let hasImageXObject = false;
  let hasBijoyFont = false;

  try {
    const page = pdfDoc.getPage(zeroBasedIndex);
    const resources = page.node.Resources();
    if (!resources) {
      return { hasFont: false, hasImageXObject: false, hasBijoyFont: false };
    }

    const fontDict = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (fontDict && fontDict.keys().length > 0) {
      hasFont = true;
      for (const fontKey of fontDict.keys()) {
        const fontRef = fontDict.get(fontKey);
        const fontObj = fontRef ? pdfDoc.context.lookupMaybe(fontRef, PDFDict) : undefined;
        const baseFont = fontObj?.get(PDFName.of('BaseFont'));
        if (baseFont instanceof PDFName && isBijoyFontName(baseFont.decodeText())) {
          hasBijoyFont = true;
          break;
        }
      }
    }

    const xObjectDict = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (xObjectDict) {
      for (const key of xObjectDict.keys()) {
        const refOrObj = xObjectDict.get(key);
        const lookedUp = refOrObj ? pdfDoc.context.lookup(refOrObj) : undefined;
        if (lookedUp instanceof PDFStream) {
          const subtype = lookedUp.dict.get(PDFName.of('Subtype'));
          if (subtype instanceof PDFName && subtype.decodeText() === 'Image') {
            hasImageXObject = true;
            break;
          }
        }
      }
    }
  } catch {
    // Fallback safely if a non-standard PDF dictionary is encountered
  }

  return { hasFont, hasImageXObject, hasBijoyFont };
}

function inspectLoadedPdfDocument(pdfDoc: PDFDocument): PdfInspectionResult {
  const actualPageCount = pdfDoc.getPageCount();
  if (actualPageCount < 1) {
    throw new AiInvalidRequestError(
      'PDF ফাইলটিতে কোনো বৈধ পৃষ্ঠা পাওয়া যায়নি। অনুগ্রহ করে একটি সঠিক PDF আপলোড করুন।'
    );
  }

  const pagesWithTextLayer: number[] = [];
  const pagesRequiringOcr: number[] = [];
  const pagesWithBijoyFont: number[] = [];

  for (let i = 0; i < actualPageCount; i += 1) {
    const pageNum = i + 1;
    const { hasFont, hasImageXObject, hasBijoyFont } = classifyPdfPageResources(pdfDoc, i);
    if (hasBijoyFont) {
      pagesWithBijoyFont.push(pageNum);
    }
    if (hasFont) {
      pagesWithTextLayer.push(pageNum);
      if (hasImageXObject) {
        pagesRequiringOcr.push(pageNum);
      }
    } else {
      pagesRequiringOcr.push(pageNum);
    }
  }

  let documentProfile: DocumentTextProfile;
  if (pagesRequiringOcr.length === 0) {
    documentProfile = 'text_based';
  } else if (pagesWithTextLayer.length === 0) {
    documentProfile = 'scanned';
  } else {
    documentProfile = 'mixed';
  }

  return {
    actualPageCount,
    pagesWithTextLayer,
    pagesRequiringOcr,
    pagesWithBijoyFont,
    documentProfile,
  };
}

/**
 * Extracts per-page embedded text locally using the serverless PDF.js build (`unpdf`).
 * Note: PDF.js transfers/detaches the ArrayBuffer passed into `extractText`, so callers
 * MUST NOT reuse the same underlying ArrayBuffer with `pdf-lib` afterward.
 * Returns null if the PDF uses unsupported/corrupt text streams so callers safely fall back to OCR.
 */
export async function extractLocalPdfTextPerPage(
  bytes: Uint8Array,
  expectedPageCount?: number
): Promise<string[] | null> {
  let pdfProxy: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    pdfProxy = await getDocumentProxy(view);

    // Prefer coordinate-aware text item extraction so 2-column and Acrobat-OCR PDFs
    // reconstruct true horizontal lines instead of breaking into 1 word per line.
    try {
      const positioned = await extractTextItems(pdfProxy);
      if (
        Array.isArray(positioned.items) &&
        (typeof expectedPageCount !== 'number' ||
          positioned.items.length === expectedPageCount)
      ) {
        return positioned.items.map((pageItems) =>
          reconstructPdfPageTextFromTextItems(pageItems)
        );
      }
    } catch {
      // Fall back to standard extractText below using the same PDFDocumentProxy
    }

    const result = await extractText(pdfProxy, { mergePages: false });
    if (!Array.isArray(result.text)) {
      return null;
    }
    if (
      typeof expectedPageCount === 'number' &&
      result.text.length !== expectedPageCount
    ) {
      return null;
    }
    return result.text;
  } catch {
    return null;
  } finally {
    if (pdfProxy) {
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
  }
}

/**
 * Parses and structurally validates a PDF byte buffer using `pdf-lib`.
 * Rejects corrupted, truncated, encrypted, or 0-page PDFs with clear Bengali messages.
 */
export async function loadAndValidatePdfDocument(
  bytes: Uint8Array
): Promise<{ pdfDoc: PDFDocument; inspection: PdfInspectionResult }> {
  try {
    const pdfDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    const inspection = inspectLoadedPdfDocument(pdfDoc);
    return { pdfDoc, inspection };
  } catch (err) {
    if (err instanceof AiInvalidRequestError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : '';
    if (/encrypt/i.test(msg)) {
      throw new AiInvalidRequestError(
        'এই PDF ফাইলটি পাসওয়ার্ড-সুরক্ষিত (Encrypted)। অনুগ্রহ করে পাসওয়ার্ড মুক্ত PDF ফাইল আপলোড করুন।'
      );
    }
    throw new AiInvalidRequestError(
      'PDF ফাইলটি ত্রুটিপূর্ণ বা অসম্পূর্ণ (Corrupted PDF)। অনুগ্রহ করে একটি বৈধ PDF ফাইল আপলোড করুন।'
    );
  }
}

export async function inspectPdfBytes(bytes: Uint8Array): Promise<PdfInspectionResult> {
  const { inspection } = await loadAndValidatePdfDocument(bytes);
  return inspection;
}

export async function inspectPdfFile(filePath: string): Promise<PdfInspectionResult> {
  const bytes = await fs.readFile(filePath);
  return inspectPdfBytes(bytes);
}

/**
 * Shared internal disk splitter that slices a given list of PageMappings into valid
 * sub-PDF files guaranteed to stay <= maxBatchBytes (< 50 MB Gemini cap) and <= maxPagesPerBatch.
 */
async function writeSplitBatchesToDisk(params: {
  pdfDoc: PDFDocument;
  mappingsToSplit: PageMapping[];
  outputDir: string;
  ocrSet: Set<number>;
  textSet: Set<number>;
  maxBatchBytes?: number;
  maxPagesPerBatch?: number;
}): Promise<SplitPdfBatchDescriptor[]> {
  if (params.mappingsToSplit.length === 0) {
    return [];
  }

  const maxBatchBytes = Math.min(
    MAX_SAFE_BATCH_BYTES,
    Math.max(512 * 1024, params.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES)
  );
  const maxPagesPerBatch = Math.max(
    1,
    Math.min(25, params.maxPagesPerBatch ?? DEFAULT_MAX_PAGES_PER_BATCH)
  );

  const resolvedOutputDir = path.resolve(params.outputDir);
  await fs.mkdir(resolvedOutputDir, { recursive: true });

  const batches: SplitPdfBatchDescriptor[] = [];

  async function buildSubPdfBytes(slice: PageMapping[]): Promise<Uint8Array> {
    const subDoc = await PDFDocument.create();
    const zeroBasedIndices = slice.map((m) => m.pdfPageIndex - 1);
    const copiedPages = await subDoc.copyPages(params.pdfDoc, zeroBasedIndices);
    for (const p of copiedPages) {
      subDoc.addPage(p);
    }
    return subDoc.save({ useObjectStreams: true });
  }

  async function emitSlice(slice: PageMapping[]): Promise<void> {
    const subBytes = await buildSubPdfBytes(slice);

    if (subBytes.byteLength > maxBatchBytes) {
      if (slice.length > 1) {
        const mid = Math.ceil(slice.length / 2);
        await emitSlice(slice.slice(0, mid));
        await emitSlice(slice.slice(mid));
        return;
      }

      if (subBytes.byteLength > MAX_SINGLE_PAGE_PDF_BYTES) {
        throw new AiInvalidRequestError(
          `পৃষ্ঠা ${toBengaliNumber(slice[0].originalPageNumber)} এককভাবেই ${formatFileSize(subBytes.byteLength)}, যা Gemini-এর ৫০ MB সীমার কাছাকাছি বা বেশি। অনুগ্রহ করে PDF-টির রেজোলিউশন কমিয়ে আবার চেষ্টা করুন।`
        );
      }
    }

    const batchIndex = batches.length;
    const fileName = `batch-${batchIndex}.pdf`;
    const targetPath = path.resolve(resolvedOutputDir, fileName);
    if (!targetPath.startsWith(resolvedOutputDir + path.sep)) {
      throw new Error('Unsafe batch output path.');
    }

    await fs.writeFile(targetPath, subBytes);

    batches.push({
      batchIndex,
      filePath: targetPath,
      byteSize: subBytes.byteLength,
      pageMappings: slice,
      internalStartPage: slice[0].pdfPageIndex,
      internalEndPage: slice[slice.length - 1].pdfPageIndex,
      originalStartPage: slice[0].originalPageNumber,
      originalEndPage: slice[slice.length - 1].originalPageNumber,
      requiresOcrPageIndices: slice
        .map((m) => m.pdfPageIndex)
        .filter((idx) => params.ocrSet.has(idx)),
      hasTextLayerPageIndices: slice
        .map((m) => m.pdfPageIndex)
        .filter((idx) => params.textSet.has(idx)),
    });
  }

  const pendingSlices: PageMapping[][] = [];
  for (let start = 0; start < params.mappingsToSplit.length; start += maxPagesPerBatch) {
    pendingSlices.push(params.mappingsToSplit.slice(start, start + maxPagesPerBatch));
  }

  // Build sub-PDF bytes in bounded parallel waves (4 at a time) while keeping deterministic batch ordering
  const WRITE_CONCURRENCY = 4;
  for (let waveStart = 0; waveStart < pendingSlices.length; waveStart += WRITE_CONCURRENCY) {
    const wave = pendingSlices.slice(waveStart, waveStart + WRITE_CONCURRENCY);
    const waveBytesList = await Promise.all(wave.map((slice) => buildSubPdfBytes(slice)));

    for (let i = 0; i < wave.length; i += 1) {
      const slice = wave[i];
      const subBytes = waveBytesList[i];
      if (subBytes.byteLength > maxBatchBytes) {
        await emitSlice(slice);
      } else {
        const batchIndex = batches.length;
        const fileName = `batch-${batchIndex}.pdf`;
        const targetPath = path.resolve(resolvedOutputDir, fileName);
        if (!targetPath.startsWith(resolvedOutputDir + path.sep)) {
          throw new Error('Unsafe batch output path.');
        }

        await fs.writeFile(targetPath, subBytes);

        batches.push({
          batchIndex,
          filePath: targetPath,
          byteSize: subBytes.byteLength,
          pageMappings: slice,
          internalStartPage: slice[0].pdfPageIndex,
          internalEndPage: slice[slice.length - 1].pdfPageIndex,
          originalStartPage: slice[0].originalPageNumber,
          originalEndPage: slice[slice.length - 1].originalPageNumber,
          requiresOcrPageIndices: slice
            .map((m) => m.pdfPageIndex)
            .filter((idx) => params.ocrSet.has(idx)),
          hasTextLayerPageIndices: slice
            .map((m) => m.pdfPageIndex)
            .filter((idx) => params.textSet.has(idx)),
        });
      }
    }
  }

  return batches;
}

/**
 * Splits a validated PDF file on disk into smaller, valid PDF documents such that:
 * 1. Every batch PDF is strictly <= `maxBatchBytes` (default 35 MB, hard cap 40 MB < Gemini 50 MB limit).
 * 2. Every batch has at most `maxPagesPerBatch` pages (default 8).
 * 3. Original page order and PDF-internal-to-original page mappings are preserved 100%.
 */
export async function splitPdfIntoBatchesOnDisk(params: {
  sourcePdfPath: string;
  outputDir: string;
  pageMappings: PageMapping[];
  maxBatchBytes?: number;
  maxPagesPerBatch?: number;
}): Promise<{
  inspection: PdfInspectionResult;
  batches: SplitPdfBatchDescriptor[];
}> {
  const sourceBytes = await fs.readFile(params.sourcePdfPath);
  const { pdfDoc, inspection } = await loadAndValidatePdfDocument(sourceBytes);

  if (params.pageMappings.length !== inspection.actualPageCount) {
    throw new AiInvalidRequestError(
      `পৃষ্ঠা ম্যাপিং (${toBengaliNumber(params.pageMappings.length)}) এবং PDF-এর প্রকৃত পৃষ্ঠা সংখ্যা (${toBengaliNumber(inspection.actualPageCount)}) মিলছে না।`
    );
  }

  const batches = await writeSplitBatchesToDisk({
    pdfDoc,
    mappingsToSplit: params.pageMappings,
    outputDir: params.outputDir,
    ocrSet: new Set(inspection.pagesRequiringOcr),
    textSet: new Set(inspection.pagesWithTextLayer),
    maxBatchBytes: params.maxBatchBytes,
    maxPagesPerBatch: params.maxPagesPerBatch,
  });

  return { inspection, batches };
}

/**
 * Single-pass PDF validation, page-mapping, smart local text extraction, and OCR-only disk splitting.
 * - Loads the source PDF ONCE so 50–100 MB files are never parsed twice.
 * - In `ocrMode === 'auto'` (default):
 *   1. Reads embedded text locally per page at zero API cost.
 *   2. Keeps pages with clean readable Bengali/English Unicode text in `locallyExtractedPages`.
 *   3. Splits ONLY pages missing/garbled text into `<= 35 MB` batches for Gemini OCR.
 *   4. For 100% searchable/OCR'd PDFs, returns `batches: []` (0 Gemini API calls!).
 * - In `ocrMode === 'force'`: skips local text extraction and splits all pages for Gemini OCR.
 */
export async function prepareAndSplitPdfOnDisk(params: {
  sourcePdfPath: string;
  outputDir: string;
  pageRangeInput?: string | null;
  fallbackChapter?: string;
  ocrMode?: PdfOcrMode;
  maxBatchBytes?: number;
  maxPagesPerBatch?: number;
}): Promise<{
  inspection: PdfInspectionResult;
  pageMappings: PageMapping[];
  originalPageRangeLabel: string;
  locallyExtractedPages: NormalizedExtractedPage[];
  batches: SplitPdfBatchDescriptor[];
}> {
  const ocrMode: PdfOcrMode = params.ocrMode ?? 'auto';
  const fallbackChapter = params.fallbackChapter?.trim() || 'অধ্যায় ১';

  // Step 1: Load and structurally validate the PDF ONCE with `pdf-lib`.
  // Inspecting embedded font resources first takes ~20ms and lets us SKIP `unpdf`
  // entirely on 100% scanned image PDFs (zero font resources -> saves a full disk read + parse).
  const sourceBytes = await fs.readFile(params.sourcePdfPath);
  const { pdfDoc, inspection: resourceInspection } =
    await loadAndValidatePdfDocument(sourceBytes);

  const mappingResult = buildPageMappings(
    resourceInspection.actualPageCount,
    params.pageRangeInput
  );
  if (!mappingResult.ok) {
    throw new AiInvalidRequestError(mappingResult.error);
  }

  const pageMappings = mappingResult.mappings;
  const locallyExtractedPages: NormalizedExtractedPage[] = [];
  let pagesNeedingOcrMappings: PageMapping[] = pageMappings;
  let finalInspection: PdfInspectionResult = resourceInspection;

  if (ocrMode === 'auto') {
    const hasAnyEmbeddedFont = resourceInspection.pagesWithTextLayer.length > 0;
    let localPageTexts: string[] | null = null;

    if (hasAnyEmbeddedFont) {
      // Pass an isolated Uint8Array copy so PDF.js detaching its ArrayBuffer never affects pdf-lib
      const isolatedCopy = new Uint8Array(sourceBytes.byteLength);
      isolatedCopy.set(sourceBytes);
      localPageTexts = await extractLocalPdfTextPerPage(
        isolatedCopy,
        resourceInspection.actualPageCount
      );
    }

    if (localPageTexts && localPageTexts.length === resourceInspection.actualPageCount) {
      const bijoyFontPageSet = new Set(resourceInspection.pagesWithBijoyFont ?? []);
      const verifiedTextPages: number[] = [];
      const verifiedOcrPages: number[] = [];
      const missingMappings: PageMapping[] = [];

      for (let idx = 0; idx < pageMappings.length; idx += 1) {
        const mapping = pageMappings[idx];
        const rawPageText = localPageTexts[idx] ?? '';
        const evaluation = evaluateLocalExtractedPageText(rawPageText);
        if (evaluation.usable) {
          verifiedTextPages.push(mapping.pdfPageIndex);
          locallyExtractedPages.push({
            pdfPageIndex: mapping.pdfPageIndex,
            originalPageNumber: mapping.originalPageNumber,
            chapter: fallbackChapter,
            content: evaluation.cleanedText,
            charCount: evaluation.substantiveLength,
            hasReadableText: true,
            ocrUsed: false,
            isShortWarning: false,
          });
        } else {
          // Check legacy Bangladeshi Bijoy / SutonnyMJ ANSI font encoding before falling back to OCR
          const bijoyOutcome = tryConvertBijoyPageText(
            rawPageText,
            bijoyFontPageSet.has(mapping.pdfPageIndex)
          );
          if (bijoyOutcome.converted) {
            const formattedBijoy = normalizeExamDocumentFormatting(bijoyOutcome.text);
            verifiedTextPages.push(mapping.pdfPageIndex);
            locallyExtractedPages.push({
              pdfPageIndex: mapping.pdfPageIndex,
              originalPageNumber: mapping.originalPageNumber,
              chapter: fallbackChapter,
              content: formattedBijoy,
              charCount: bijoyOutcome.substantiveLength,
              hasReadableText: true,
              ocrUsed: false,
              isShortWarning: false,
            });
          } else {
            verifiedOcrPages.push(mapping.pdfPageIndex);
            missingMappings.push(mapping);
          }
        }
      }

      pagesNeedingOcrMappings = missingMappings;
      finalInspection = {
        actualPageCount: resourceInspection.actualPageCount,
        pagesWithTextLayer: verifiedTextPages,
        pagesRequiringOcr: verifiedOcrPages,
        pagesWithBijoyFont: resourceInspection.pagesWithBijoyFont,
        documentProfile:
          verifiedOcrPages.length === 0
            ? 'text_based'
            : verifiedTextPages.length === 0
              ? 'scanned'
              : 'mixed',
      };
    }
  } else {
    // Explicit force-OCR mode: treat all pages as requiring Gemini OCR
    finalInspection = {
      actualPageCount: resourceInspection.actualPageCount,
      pagesWithTextLayer: resourceInspection.pagesWithTextLayer,
      pagesRequiringOcr: pageMappings.map((m) => m.pdfPageIndex),
      pagesWithBijoyFont: resourceInspection.pagesWithBijoyFont,
      documentProfile:
        resourceInspection.pagesWithTextLayer.length > 0 ? 'mixed' : 'scanned',
    };
  }

  const batches = await writeSplitBatchesToDisk({
    pdfDoc,
    mappingsToSplit: pagesNeedingOcrMappings,
    outputDir: params.outputDir,
    ocrSet: new Set(finalInspection.pagesRequiringOcr),
    textSet: new Set(finalInspection.pagesWithTextLayer),
    maxBatchBytes: params.maxBatchBytes,
    maxPagesPerBatch: params.maxPagesPerBatch,
  });

  return {
    inspection: finalInspection,
    pageMappings,
    originalPageRangeLabel: mappingResult.originalPageRangeLabel,
    locallyExtractedPages,
    batches,
  };
}
