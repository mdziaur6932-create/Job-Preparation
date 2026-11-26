import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { NextRequest } from 'next/server';
import { ThinkingLevel, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import {
  convertBijoyToUnicode,
  isBijoyFontName,
  looksLikeBijoyAnsiText,
  tryConvertBijoyPageText,
} from './bijoy-to-unicode';
import {
  GEMINI_FAST_OCR_MODEL,
  GEMINI_MODEL,
} from './gemini';
import {
  mergePartialExtractionWithRecoveredPages,
  parseDelimitedPagesOutput,
  parsePdfPageSubsetSyntax,
  repairMalformedJsonString,
  salvagePagesFromMalformedJson,
  validateBookSaveReadiness,
} from './pdf-rules';
import {
  type PdfExtractionGeminiClient,
  setPdfExtractorClientForTesting,
} from './pdf-extractor-service';
import { runChunkedPdfPipeline } from './pdf-upload-client';
import {
  sliceSpecificPdfPagesInBrowser,
  tryFastClientPdfPreprocess,
} from './client-pdf-accelerator';
import { setAiGuardTestOverrides } from './ai-api-guard';
import { InMemorySlidingWindowRateLimitStore } from './rate-limit';
import { POST as initSessionPost } from '../../app/api/ai/extract-pdf/session/init/route';
import {
  GET as chunkSessionGet,
  POST as chunkSessionPost,
} from '../../app/api/ai/extract-pdf/session/chunk/route';
import { POST as prepareSessionPost } from '../../app/api/ai/extract-pdf/session/prepare/route';
import { POST as batchSessionPost } from '../../app/api/ai/extract-pdf/session/batch/route';
import { POST as finalizeSessionPost } from '../../app/api/ai/extract-pdf/session/finalize/route';
import { POST as cancelSessionPost } from '../../app/api/ai/extract-pdf/session/cancel/route';

function createMockAuthDeps() {
  return {
    verifyIdToken: async (token: string) => {
      if (token === 'token-user-1') {
        return { uid: 'uid-speed-1', email: 'speed1@example.com', name: 'Speed User' };
      }
      throw new Error('Invalid token');
    },
    upsertUser: async ({ uid, email, displayName }: { uid: string; email: string; displayName: string }) => ({
      id: 901,
      uid,
      email,
      displayName,
      targetExam: 'BCS',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }),
  };
}

function createInProcessSessionFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const fullUrl = rawUrl.startsWith('http') ? rawUrl : `http://localhost:3000${rawUrl}`;
    const parsedUrl = new URL(fullUrl);
    const method = (init?.method ?? 'GET').toUpperCase();

    const headers = new Headers(init?.headers);
    let body: BodyInit | undefined;
    if (init?.body instanceof Blob) {
      body = Buffer.from(await init.body.arrayBuffer());
    } else if (init?.body !== undefined && init?.body !== null) {
      body = init.body;
    }

    const req = new NextRequest(fullUrl, {
      method,
      headers,
      body,
      signal: init?.signal ?? undefined,
    });

    switch (parsedUrl.pathname) {
      case '/api/ai/extract-pdf/session/init':
        return initSessionPost(req);
      case '/api/ai/extract-pdf/session/chunk':
        return method === 'GET' ? chunkSessionGet(req) : chunkSessionPost(req);
      case '/api/ai/extract-pdf/session/prepare':
        return prepareSessionPost(req);
      case '/api/ai/extract-pdf/session/batch':
        return batchSessionPost(req);
      case '/api/ai/extract-pdf/session/finalize':
        return finalizeSessionPost(req);
      case '/api/ai/extract-pdf/session/cancel':
        return cancelSessionPost(req);
      default:
        throw new Error(`Unexpected URL in speed test fetch: ${parsedUrl.pathname}`);
    }
  }) as typeof fetch;
}

async function buildTestPdfBytes(pageCount: number, withText: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = withText ? await doc.embedFont(StandardFonts.Helvetica) : null;
  for (let i = 1; i <= pageCount; i += 1) {
    const page = doc.addPage([595, 842]);
    if (font) {
      page.drawText(
        `Bangladesh BCS Job Solution Page ${i}: Constitution of Bangladesh 1972 MCQ and Detailed Explanation.`,
        { x: 40, y: 760, size: 12, font }
      );
    }
  }
  return doc.save();
}

test('1: Bijoy font detection and Bijoy-to-Unicode conversion handles legacy Bangladeshi PDF text', () => {
  assert.equal(isBijoyFontName('ABCDE+SutonnyMJ'), true);
  assert.equal(isBijoyFontName('SutonnyOMJ-Bold'), true);
  assert.equal(isBijoyFontName('TonnyBanglaMJ'), true);
  assert.equal(isBijoyFontName('Helvetica'), false);
  assert.equal(isBijoyFontName('SolaimanLipi'), false);

  const sampleBijoy =
    'evsjv‡`‡ki msweavb 1972 mv‡ji 4 b‡f¤^i MYcwil‡` M„nxZ nq Ges 16 wW‡m¤^i Kvh©Ki nq|';
  assert.equal(looksLikeBijoyAnsiText(sampleBijoy), true);

  const converted = convertBijoyToUnicode(sampleBijoy);
  assert.ok(converted.includes('বাংলাদেশের'), `Expected বাংলাদেশের in: ${converted}`);
  assert.ok(converted.includes('সংবিধান'), `Expected সংবিধান in: ${converted}`);
  assert.ok(converted.includes('সালের'), `Expected সালের in: ${converted}`);

  const outcome = tryConvertBijoyPageText(sampleBijoy, true);
  assert.equal(outcome.converted, true);
  assert.ok(outcome.substantiveLength >= 40);

  // Pure English text must NOT be mangled by Bijoy converter
  const english = 'The Constitution of Bangladesh was adopted on 4 November 1972.';
  assert.equal(looksLikeBijoyAnsiText(english), false);
  assert.equal(tryConvertBijoyPageText(english, false).converted, false);
});

test('2: salvagePagesFromMalformedJson rescues complete page objects when Gemini JSON truncates mid-batch', () => {
  const truncatedJson = `{
    "pages": [
      {
        "pdfPageIndex": 1,
        "originalPageNumber": 1,
        "chapter": "সাম্প্রতিক প্রশ্ন",
        "content": "১। বাংলাদেশের সংবিধান কবে কার্যকর হয়? উত্তর: ১৬ ডিসেম্বর ১৯৭২।",
        "hasReadableText": true,
        "ocrUsed": true
      },
      {
        "pdfPageIndex": 2,
        "originalPageNumber": 2,
        "chapter": "সাম্প্রতিক প্রশ্ন",
        "content": "২। বাংলাদেশের মুক্তিযুদ্ধের সর্বাধিনায়ক কে ছিলেন? উত্তর: বঙ্গবন্ধু শেখ মুজিবুর রহমান।",
        "hasReadableText": true,
        "ocrUsed": true
      },
      {
        "pdfPageIndex": 3,
        "originalPageNumber": 3,
        "chapter": "সাম্প্রতিক প্রশ্ন",
        "content": "৩। এই অংশটি হঠাৎ টোকেন লিমিটে কেটে গে`;

  const salvaged = salvagePagesFromMalformedJson(truncatedJson);
  assert.equal(salvaged.length, 2);
  assert.equal(salvaged[0].originalPageNumber, 1);
  assert.equal(salvaged[1].originalPageNumber, 2);
  assert.ok(salvaged[0].content?.includes('১৬ ডিসেম্বর ১৯৭২'));
});

test('3: parsePdfPageSubsetSyntax parses Bengali/English subset ranges and clamps safely', () => {
  assert.equal(parsePdfPageSubsetSyntax('').ok, true);
  const bn = parsePdfPageSubsetSyntax('২৬-৫০', 100);
  assert.equal(bn.ok, true);
  if (bn.ok) {
    assert.equal(bn.startPage, 26);
    assert.equal(bn.endPage, 50);
    assert.equal(bn.normalizedLabel, '26-50');
  }

  const clamped = parsePdfPageSubsetSyntax('1-50', 30);
  assert.equal(clamped.ok, true);
  if (clamped.ok) {
    assert.equal(clamped.endPage, 30);
    assert.equal(clamped.normalizedLabel, '1-30');
  }

  const outOfRange = parsePdfPageSubsetSyntax('120-150', 100);
  assert.equal(outOfRange.ok, false);
});

test('4: Turbo fast OCR mode splits into 4-page batches, runs concurrently with gemini-3.1-flash-lite + MINIMAL thinking, and upgrades truncated missing-page retries to gemini-4-hydrogen', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  let inFlight = 0;
  let maxObservedInFlight = 0;
  const modelsUsed: string[] = [];
  const thinkingLevelsUsed: Array<unknown> = [];
  let truncatedOnceOnBatch0 = false;

  const mockClient: PdfExtractionGeminiClient = {
    models: {
      generateContent: async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
        inFlight += 1;
        maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
        modelsUsed.push(String(params.model));
        thinkingLevelsUsed.push(params.config?.thinkingConfig?.thinkingLevel);

        await new Promise((r) => setTimeout(r, 35));
        try {
          const parts = (params.contents as { parts?: Array<{ text?: string }> })?.parts ?? [];
          const prompt = parts.find((p) => typeof p.text === 'string')?.text ?? '';
          const matches = Array.from(
            prompt.matchAll(/Source PDF internal page (\d+)\) => Original printed book page (\d+)/g)
          ).map((m) => ({
            pdfPageIndex: Number(m[1]),
            originalPageNumber: Number(m[2]),
          }));

          // Simulate a truncated JSON response on Batch 0 pass 1 (drops page 4 mid-string!)
          if (
            !truncatedOnceOnBatch0 &&
            matches.some((m) => m.originalPageNumber === 4) &&
            !prompt.includes('CRITICAL RETRY FOCUS')
          ) {
            truncatedOnceOnBatch0 = true;
            const partialObjects = matches.slice(0, 3).map((m) =>
              JSON.stringify({
                pdfPageIndex: m.pdfPageIndex,
                originalPageNumber: m.originalPageNumber,
                chapter: 'রিসেন্ট জব সলুশন',
                content: `পৃষ্ঠা ${m.originalPageNumber}: বাংলাদেশের সাম্প্রতিক সরকারি চাকরির পরীক্ষার প্রশ্ন ও উত্তর।`,
                hasReadableText: true,
                ocrUsed: true,
              })
            );
            return {
              text: `{"pages":[${partialObjects.join(',')},{"pdfPageIndex":4,"originalPageNumber":4,"content":"truncated...`,
            } as GenerateContentResponse;
          }

          return {
            text: JSON.stringify({
              pages: matches.map((m) => ({
                pdfPageIndex: m.pdfPageIndex,
                originalPageNumber: m.originalPageNumber,
                chapter: 'রিসেন্ট জব সলুশন',
                content: `পৃষ্ঠা ${m.originalPageNumber}: বাংলাদেশের সাম্প্রতিক সরকারি চাকরির পরীক্ষার প্রশ্ন ও উত্তর।`,
                hasReadableText: true,
                ocrUsed: true,
              })),
            }),
          } as GenerateContentResponse;
        } finally {
          inFlight -= 1;
        }
      },
    },
  };

  setPdfExtractorClientForTesting(mockClient);

  try {
    const pdfBytes = await buildTestPdfBytes(12, false);
    const file = new File([Buffer.from(pdfBytes)], 'recent-job-solution-12p.pdf', {
      type: 'application/pdf',
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      ocrMode: 'auto',
      ocrSpeed: 'fast',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.extraction.extractionStatus, 'success');
    assert.equal(outcome.extraction.actualPageCount, 12);
    assert.equal(outcome.extraction.extractedPageCount, 12);
    // 12 pages in fast mode = 3 batches of 4 pages each
    assert.equal(outcome.extraction.totalBatches, 3);
    assert.deepEqual(outcome.extraction.missingOriginalPages, []);
    // Parallel worker pool ran multiple batches concurrently!
    assert.ok(
      maxObservedInFlight >= 2,
      `Expected parallel batch execution (>=2 in-flight), got ${maxObservedInFlight}`
    );
    // Primary passes used gemini-3.1-flash-lite with ThinkingLevel.MINIMAL
    assert.ok(modelsUsed.includes(GEMINI_FAST_OCR_MODEL));
    assert.ok(thinkingLevelsUsed.includes(ThinkingLevel.MINIMAL));
    // Targeted missing-page retry for page 4 auto-upgraded to GEMINI_MODEL with ThinkingLevel.MEDIUM
    assert.ok(modelsUsed.includes(GEMINI_MODEL));
    assert.ok(thinkingLevelsUsed.includes(ThinkingLevel.MEDIUM));
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('5: Browser PDF accelerator slices page subset (2-4 of 6) and extracts searchable PDF locally with 0 server/AI calls', async () => {
  const pdfBytes = await buildTestPdfBytes(6, true);
  const file = new File([Buffer.from(pdfBytes)], 'bcs-guide-6p.pdf', {
    type: 'application/pdf',
  });

  const outcome = await tryFastClientPdfPreprocess({
    file,
    pdfSubsetInput: '2-4',
    fallbackChapter: 'সংবিধান',
    forceOcr: false,
  });

  assert.equal(outcome.kind, 'extracted_locally');
  if (outcome.kind !== 'extracted_locally') return;

  assert.equal(outcome.slicedFromTotalPages, 6);
  assert.equal(outcome.extraction.actualPageCount, 3);
  assert.equal(outcome.extraction.extractedPageCount, 3);
  assert.equal(outcome.extraction.originalPageRange, '2-4');
  assert.deepEqual(
    outcome.extraction.sections.map((s) => s.pageNumber),
    [2, 3, 4]
  );
  assert.ok(outcome.extraction.sections[0].content.includes('Page 2'));
  assert.ok(outcome.extraction.sections[2].content.includes('Page 4'));
});

test('6: repairMalformedJsonString & salvagePagesFromMalformedJson rescue math backslashes, raw newlines, trailing commas, prose wrappers, and unescaped inner quotes', () => {
  // Case A: LaTeX backslashes (\frac, \%), raw newline inside string, trailing comma, prose wrapper
  const brokenMathJson = `Here is the extracted JSON:
  {
    "pages": [
      {
        "pdfPageIndex": 37,
        "originalPageNumber": 37,
        "chapter": "গণিত সমাধান",
        "content": "১। যদি x = \\frac{1}{2} এবং লাভ 25\\% হয়,
তবে সঠিক উত্তর: ক) ১/২।",
        "hasReadableText": true,
        "ocrUsed": true,
      },
    ],
  }
  Hope this helps!`;

  const repaired = repairMalformedJsonString(brokenMathJson);
  assert.doesNotThrow(() => JSON.parse(repaired));
  const salvagedMath = salvagePagesFromMalformedJson(brokenMathJson);
  assert.equal(salvagedMath.length, 1);
  assert.equal(salvagedMath[0].originalPageNumber, 37);
  assert.ok(salvagedMath[0].content?.includes('\\frac{1}{2}'));
  assert.ok(salvagedMath[0].content?.includes('25\\%'));

  // Case B: Unescaped double quotes inside Bengali MCQ text
  const unescapedQuotesJson = `{"pages":[{"pdfPageIndex":38,"originalPageNumber":38,"chapter":"বাংলা সাহিত্য","content":"২। কাজী নজরুল ইসলামের "বিদ্রোহী" কবিতা কোন পত্রিকায় প্রকাশিত হয়? উত্তর: সাপ্তাহিক বিজলী।","hasReadableText":true,"ocrUsed":true}]}`;
  const salvagedQuotes = salvagePagesFromMalformedJson(unescapedQuotesJson);
  assert.equal(salvagedQuotes.length, 1);
  assert.equal(salvagedQuotes[0].originalPageNumber, 38);
  assert.ok(salvagedQuotes[0].content?.includes('বিদ্রোহী'));
});

test('7: parseDelimitedPagesOutput parses quotes, math backslashes, and missing final PAGE_END safely', () => {
  const delimitedOutput = `
<<<PAGE_START pdf=37 orig=37 chapter="রিসেন্ট জব সলুশন" ocr=true>>>
১। "বাংলাদেশ ব্যাংক" কবে প্রতিষ্ঠিত হয়?
উত্তর: ১৬ ডিসেম্বর ১৯৭১। গণিত: \\frac{3}{4} + \\sqrt{16} = 4.75 (100\\% সঠিক)।
<<<PAGE_END>>>

<<<PAGE_START pdf=38 orig=38 chapter="রিসেন্ট জব সলুশন" ocr=true>>>
২। "পদ্মা সেতু"-এর দৈর্ঘ্য কত? উত্তর: ৬.১৫ কি.মি.। (এখানে শেষের ট্যাগ কেটে গেছে)`;

  const parsed = parseDelimitedPagesOutput(
    delimitedOutput,
    [
      { pdfPageIndex: 37, originalPageNumber: 37 },
      { pdfPageIndex: 38, originalPageNumber: 38 },
    ],
    'অধ্যায় ১',
    true
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].originalPageNumber, 37);
  assert.ok(parsed[0].content?.includes('"বাংলাদেশ ব্যাংক"'));
  assert.ok(parsed[0].content?.includes('\\frac{3}{4}'));
  assert.equal(parsed[1].originalPageNumber, 38);
  assert.ok(parsed[1].content?.includes('৬.১৫ কি.মি.'));
});

test('8: Turbo fast OCR automatically recovers from complete AI_INVALID_RESPONSE garbage via plain-text delimited GEMINI_MODEL fallback (100% pages succeed)', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  const modelsUsed: string[] = [];
  let delimitedFallbackCalls = 0;

  const mockClient: PdfExtractionGeminiClient = {
    models: {
      generateContent: async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
        modelsUsed.push(String(params.model));
        const parts = (params.contents as { parts?: Array<{ text?: string }> })?.parts ?? [];
        const prompt = parts.find((p) => typeof p.text === 'string')?.text ?? '';
        const matches = Array.from(
          prompt.matchAll(/Source PDF internal page (\d+)\) => Original printed book page (\d+)/g)
        ).map((m) => ({
          pdfPageIndex: Number(m[1]),
          originalPageNumber: Number(m[2]),
        }));

        // Delimited fallback prompt (NO responseMimeType: application/json)
        if (prompt.includes('<<<PAGE_START')) {
          delimitedFallbackCalls += 1;
          assert.equal(params.model, GEMINI_MODEL);
          assert.equal(params.config?.responseMimeType, undefined);
          const blocks = matches
            .map(
              (m) =>
                `<<<PAGE_START pdf=${m.pdfPageIndex} orig=${m.originalPageNumber} chapter="রিসেন্ট জব সলুশন" ocr=true>>>\nপৃষ্ঠা ${m.originalPageNumber}: "উদ্ধৃতি" ও গণিত \\frac{1}{2} সহ পূর্ণাঙ্গ বাংলা প্রশ্নোত্তর।\n<<<PAGE_END>>>`
            )
            .join('\n\n');
          return { text: blocks } as GenerateContentResponse;
        }

        // Simulate flash-lite returning completely unparseable malformed output on Batch 2 (pages 5-8)
        if (matches.some((m) => m.originalPageNumber === 5)) {
          return {
            text: 'Sorry, this page has dense tables and quotes: "broken non-json output',
          } as GenerateContentResponse;
        }

        return {
          text: JSON.stringify({
            pages: matches.map((m) => ({
              pdfPageIndex: m.pdfPageIndex,
              originalPageNumber: m.originalPageNumber,
              chapter: 'রিসেন্ট জব সলুশন',
              content: `পৃষ্ঠা ${m.originalPageNumber}: বাংলাদেশের সরকারি চাকরির পরীক্ষার প্রশ্ন ও সমাধান।`,
              hasReadableText: true,
              ocrUsed: true,
            })),
          }),
        } as GenerateContentResponse;
      },
    },
  };

  setPdfExtractorClientForTesting(mockClient);

  try {
    const pdfBytes = await buildTestPdfBytes(8, false);
    const file = new File([Buffer.from(pdfBytes)], 'dense-job-solution-8p.pdf', {
      type: 'application/pdf',
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      ocrMode: 'auto',
      ocrSpeed: 'fast',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.extraction.extractionStatus, 'success');
    assert.equal(outcome.extraction.extractedPageCount, 8);
    assert.equal(outcome.extraction.failedBatches, 0);
    assert.deepEqual(outcome.extraction.missingOriginalPages, []);
    assert.equal(delimitedFallbackCalls, 1);
    assert.ok(modelsUsed.includes(GEMINI_FAST_OCR_MODEL));
    assert.ok(modelsUsed.includes(GEMINI_MODEL));
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('9: Client automatically retries a transiently failed batch once with preferDelimitedFallback before finalize', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  const baseFetch = createInProcessSessionFetch();
  let batch1TransientFailures = 0;
  let sawPreferDelimitedRetry = false;

  const flakyFetch: typeof fetch = (async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (rawUrl.includes('/api/ai/extract-pdf/session/batch') && typeof init?.body === 'string') {
      const parsedBody = JSON.parse(init.body) as {
        batchIndex?: number;
        preferDelimitedFallback?: boolean;
      };
      if (parsedBody.batchIndex === 1 && batch1TransientFailures === 0) {
        batch1TransientFailures += 1;
        return new Response(
          JSON.stringify({
            error: 'AI থেকে অপ্রত্যাশিত ফরম্যাটের উত্তর পাওয়া গেছে। অনুগ্রহ করে আবার চেষ্টা করুন।',
            code: 'AI_INVALID_RESPONSE',
            retryable: true,
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (parsedBody.batchIndex === 1 && parsedBody.preferDelimitedFallback === true) {
        sawPreferDelimitedRetry = true;
      }
    }
    return baseFetch(input, init);
  }) as typeof fetch;

  const mockClient: PdfExtractionGeminiClient = {
    models: {
      generateContent: async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
        const parts = (params.contents as { parts?: Array<{ text?: string }> })?.parts ?? [];
        const prompt = parts.find((p) => typeof p.text === 'string')?.text ?? '';
        const matches = Array.from(
          prompt.matchAll(/Source PDF internal page (\d+)\) => Original printed book page (\d+)/g)
        ).map((m) => ({
          pdfPageIndex: Number(m[1]),
          originalPageNumber: Number(m[2]),
        }));

        if (prompt.includes('<<<PAGE_START')) {
          return {
            text: matches
              .map(
                (m) =>
                  `<<<PAGE_START pdf=${m.pdfPageIndex} orig=${m.originalPageNumber} chapter="রিসেন্ট জব সলুশন" ocr=true>>>\nপৃষ্ঠা ${m.originalPageNumber}: রিকভারি পাস থেকে সফলভাবে সংগৃহীত পূর্ণাঙ্গ বাংলা টেক্সট।\n<<<PAGE_END>>>`
              )
              .join('\n\n'),
          } as GenerateContentResponse;
        }

        return {
          text: JSON.stringify({
            pages: matches.map((m) => ({
              pdfPageIndex: m.pdfPageIndex,
              originalPageNumber: m.originalPageNumber,
              chapter: 'রিসেন্ট জব সলুশন',
              content: `পৃষ্ঠা ${m.originalPageNumber}: প্রথম পাস থেকে সফলভাবে সংগৃহীত বাংলা টেক্সট।`,
              hasReadableText: true,
              ocrUsed: true,
            })),
          }),
        } as GenerateContentResponse;
      },
    },
  };

  setPdfExtractorClientForTesting(mockClient);

  const progressSnapshots: Array<{ failedBatches?: number; stage: string }> = [];
  try {
    const pdfBytes = await buildTestPdfBytes(8, false);
    const file = new File([Buffer.from(pdfBytes)], 'retry-recovery-8p.pdf', {
      type: 'application/pdf',
    });

    const outcome = await runChunkedPdfPipeline({
      file,
      useOcr: true,
      ocrMode: 'auto',
      ocrSpeed: 'fast',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: (p) => {
        progressSnapshots.push({ failedBatches: p.failedBatches, stage: p.stage });
      },
      fetchImpl: flakyFetch,
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(sawPreferDelimitedRetry, true);
    assert.equal(outcome.extraction.extractionStatus, 'success');
    assert.equal(outcome.extraction.extractedPageCount, 8);
    assert.equal(outcome.extraction.failedBatches, 0);
    assert.deepEqual(outcome.extraction.missingOriginalPages, []);
    const finalSnapshot = progressSnapshots[progressSnapshots.length - 1];
    assert.equal(finalSnapshot.stage, 'ready');
    assert.equal(finalSnapshot.failedBatches, 0);
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});

test('10: sliceSpecificPdfPagesInBrowser + mergePartialExtractionWithRecoveredPages completes missing non-contiguous pages without re-processing completed pages', async () => {
  const pdfBytes = await buildTestPdfBytes(10, true);
  const fullFile = new File([Buffer.from(pdfBytes)], 'job-solution-10p.pdf', {
    type: 'application/pdf',
  });

  // Original printed range 37..46 (pdf 1..10). Suppose pages 39 (pdf 3), 43 (pdf 7), 44 (pdf 8) missed due to 429.
  const origByPdf = new Map<number, number>();
  for (let i = 1; i <= 10; i += 1) {
    origByPdf.set(i, 36 + i);
  }

  const sliced = await sliceSpecificPdfPagesInBrowser({
    file: fullFile,
    pdfPageIndices: [3, 7, 8],
    originalPageNumberByPdfIndex: origByPdf,
  });

  assert.equal(sliced.totalSourcePages, 10);
  assert.deepEqual(sliced.targets, [
    { pdfPageIndex: 3, originalPageNumber: 39 },
    { pdfPageIndex: 7, originalPageNumber: 43 },
    { pdfPageIndex: 8, originalPageNumber: 44 },
  ]);

  // Verify mini-PDF truly has ONLY 3 pages
  const miniDoc = await PDFDocument.load(new Uint8Array(await sliced.file.arrayBuffer()));
  assert.equal(miniDoc.getPageCount(), 3);

  const previousPartial = {
    extractionStatus: 'partial' as const,
    method: 'ocr' as const,
    ocrCompleted: true,
    actualPageCount: 10,
    expectedPageCount: 10,
    extractedPageCount: 7,
    originalPageRange: '37-46',
    totalBatches: 3,
    completedBatches: 2,
    failedBatches: 1,
    missingOriginalPages: [39, 43, 44],
    duplicateOriginalPages: [],
    outOfOrderDetected: false,
    sections: [1, 2, 4, 5, 6, 9, 10].map((pdfIdx) => ({
      chapter: 'রিসেন্ট জব সলুশন',
      pageNumber: 36 + pdfIdx,
      pdfPageIndex: pdfIdx,
      content: `পৃষ্ঠা ${36 + pdfIdx}: পূর্বে সংরক্ষিত সম্পূর্ণ প্রশ্নোত্তর।`,
    })),
    rawText: 'partial',
    meaningfulCharCount: 200,
    warnings: ['quota hit'],
    error: 'partial error',
  };

  // Recovered mini-PDF extraction returns sequential pages 1..3
  const recoveredMini = {
    extractionStatus: 'success' as const,
    method: 'ocr' as const,
    ocrCompleted: true,
    actualPageCount: 3,
    expectedPageCount: 3,
    extractedPageCount: 3,
    originalPageRange: '1-3',
    totalBatches: 1,
    completedBatches: 1,
    failedBatches: 0,
    missingOriginalPages: [],
    duplicateOriginalPages: [],
    outOfOrderDetected: false,
    sections: [
      { chapter: 'রিসেন্ট জব সলুশন', pageNumber: 1, pdfPageIndex: 1, content: 'পৃষ্ঠা ৩৯ এর পুনরুদ্ধারকৃত উত্তর।' },
      { chapter: 'রিসেন্ট জব সলুশন', pageNumber: 2, pdfPageIndex: 2, content: 'পৃষ্ঠা ৪৩ এর পুনরুদ্ধারকৃত উত্তর।' },
      { chapter: 'রিসেন্ট জব সলুশন', pageNumber: 3, pdfPageIndex: 3, content: 'পৃষ্ঠা ৪৪ এর পুনরুদ্ধারকৃত উত্তর।' },
    ],
    rawText: 'mini',
    meaningfulCharCount: 100,
    warnings: [],
  };

  const merged = mergePartialExtractionWithRecoveredPages({
    previous: previousPartial,
    recovered: recoveredMini,
    requestedMissingTargets: sliced.targets,
    fallbackChapter: 'রিসেন্ট জব সলুশন',
  });

  assert.equal(merged.extractionStatus, 'success');
  assert.equal(merged.extractedPageCount, 10);
  assert.deepEqual(merged.missingOriginalPages, []);
  assert.deepEqual(
    merged.sections.map((s) => s.pageNumber),
    [37, 38, 39, 40, 41, 42, 43, 44, 45, 46]
  );
  assert.ok(merged.sections[2].content.includes('পৃষ্ঠা ৩৯'));
  assert.ok(merged.sections[6].content.includes('পৃষ্ঠা ৪৩'));
  assert.ok(merged.sections[7].content.includes('পৃষ্ঠা ৪৪'));

  const readiness = validateBookSaveReadiness({
    title: 'Recent Job SOLUTION Part 01',
    subject: 'বাংলাদেশ বিষয়াবলি',
    rawText: merged.rawText,
    extractionContext: {
      status: merged.extractionStatus,
      actualPageCount: merged.actualPageCount,
      extractedPageCount: merged.extractedPageCount,
      missingOriginalPages: merged.missingOriginalPages,
      sourceWasUploadedPdf: true,
    },
  });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.computedTotalPages, 10);
});

test('11: Quota 429 pause preserves extracted pages and missing-pages-only resume completes 100% of book', async () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps: createMockAuthDeps(), rateLimitStore: store });

  let simulate429OnBatch1 = true;
  let resumeGeminiCalls = 0;

  const mockClient: PdfExtractionGeminiClient = {
    models: {
      generateContent: async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
        const parts = (params.contents as { parts?: Array<{ text?: string }> })?.parts ?? [];
        const prompt = parts.find((p) => typeof p.text === 'string')?.text ?? '';
        const matches = Array.from(
          prompt.matchAll(/Source PDF internal page (\d+)\) => Original printed book page (\d+)/g)
        ).map((m) => ({
          pdfPageIndex: Number(m[1]),
          originalPageNumber: Number(m[2]),
        }));

        if (simulate429OnBatch1 && matches.some((m) => m.originalPageNumber === 5)) {
          const quotaErr = Object.assign(
            new Error('429 RESOURCE_EXHAUSTED: retryDelay: "28s"'),
            { status: 429 }
          );
          throw quotaErr;
        }

        if (!simulate429OnBatch1) {
          resumeGeminiCalls += 1;
        }

        return {
          text: JSON.stringify({
            pages: matches.map((m) => ({
              pdfPageIndex: m.pdfPageIndex,
              originalPageNumber: m.originalPageNumber,
              chapter: 'রিসেন্ট জব সলুশন',
              content: `পৃষ্ঠা ${m.originalPageNumber}: বাংলাদেশের সরকারি চাকরির পরীক্ষার পূর্ণাঙ্গ প্রশ্নোত্তর।`,
              hasReadableText: true,
              ocrUsed: true,
            })),
          }),
        } as GenerateContentResponse;
      },
    },
  };

  setPdfExtractorClientForTesting(mockClient);

  try {
    const pdfBytes = await buildTestPdfBytes(8, false);
    const fullFile = new File([Buffer.from(pdfBytes)], 'quota-resume-8p.pdf', {
      type: 'application/pdf',
    });

    // Pass 1: Batch 0 (pages 1-4) succeeds, Batch 1 (pages 5-8) hits Free-Tier 429!
    const firstOutcome = await runChunkedPdfPipeline({
      file: fullFile,
      useOcr: true,
      ocrMode: 'auto',
      ocrSpeed: 'fast',
      batchConcurrency: 1,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(firstOutcome.ok, true);
    if (!firstOutcome.ok) return;
    assert.equal(firstOutcome.quotaExhausted, true);
    assert.ok((firstOutcome.retryAfterSeconds ?? 0) > 0);
    assert.equal(firstOutcome.extraction.extractionStatus, 'partial');
    assert.equal(firstOutcome.extraction.extractedPageCount, 4);
    assert.deepEqual(firstOutcome.extraction.missingOriginalPages, [5, 6, 7, 8]);

    // Pass 2: User waits for cooldown and clicks "শুধু বাকি ৪টি পৃষ্ঠা সম্পন্ন করুন"
    simulate429OnBatch1 = false;
    const sliced = await sliceSpecificPdfPagesInBrowser({
      file: fullFile,
      pdfPageIndices: firstOutcome.extraction.missingOriginalPages,
    });

    const resumeOutcome = await runChunkedPdfPipeline({
      file: sliced.file,
      useOcr: true,
      ocrMode: 'force',
      ocrSpeed: 'fast',
      getAuthHeaders: async () => ({ Authorization: 'Bearer token-user-1' }),
      onProgress: () => {},
      fetchImpl: createInProcessSessionFetch(),
    });

    assert.equal(resumeOutcome.ok, true);
    if (!resumeOutcome.ok) return;
    assert.equal(resumeGeminiCalls, 1); // ONLY 1 Gemini call for the 4 missing pages!

    const merged = mergePartialExtractionWithRecoveredPages({
      previous: firstOutcome.extraction,
      recovered: resumeOutcome.extraction,
      requestedMissingTargets: sliced.targets,
      fallbackChapter: 'রিসেন্ট জব সলুশন',
    });

    assert.equal(merged.extractionStatus, 'success');
    assert.equal(merged.extractedPageCount, 8);
    assert.deepEqual(merged.missingOriginalPages, []);
    assert.deepEqual(
      merged.sections.map((s) => s.pageNumber),
      [1, 2, 3, 4, 5, 6, 7, 8]
    );
  } finally {
    setPdfExtractorClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});
