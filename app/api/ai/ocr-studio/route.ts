import { NextRequest, NextResponse } from 'next/server';
import { ThinkingLevel, Type, type GenerateContentResponse } from '@google/genai';
import { guardAiApiRequest } from '@/src/lib/ai-api-guard';
import { detectBinaryMimeFromMagicBytes } from '@/src/lib/file-validation';
import { normalizeExamDocumentFormatting } from '@/src/lib/exam-text-formatter';
import {
  GEMINI_FAST_OCR_MODEL,
  GEMINI_MODEL,
  extractUpstreamStatus,
  generateWithRetry,
  mapAiErrorToHttpResponse,
  parseJsonBody,
} from '@/src/lib/gemini';
import {
  parseOcrStudioStructuredOutput,
  type DetectedOcrDiagram,
} from '@/src/lib/ocr-studio-utils';

export const maxDuration = 60;

const ALLOWED_OCR_STUDIO_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const MAX_INLINE_OCR_BYTES = 8 * 1024 * 1024; // 8 MB decoded ceiling for fast single-shot JSON OCR
const OCR_PRIMARY_TIMEOUT_MS = 32_000;
const OCR_FALLBACK_TIMEOUT_MS = 22_000;
const OCR_PLAIN_FALLBACK_TIMEOUT_MS = 18_000;

const OCR_STUDIO_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    content: {
      type: Type.STRING,
      description:
        'Cleanly formatted Bengali/English exam questions, options, answers, tables, and solutions extracted from the document.',
    },
    diagrams: {
      type: Type.ARRAY,
      description:
        'Visual geometric figures, dice/cube folding nets, triangles, Venn diagrams, or non-table drawings detected inside the image. Empty array if none.',
      items: {
        type: Type.OBJECT,
        properties: {
          id: {
            type: Type.STRING,
            description: 'Unique marker ID like DIAGRAM_1 matching [[DIAGRAM_1]] in content.',
          },
          label: {
            type: Type.STRING,
            description: 'Short Bengali caption for the diagram (e.g. ৯৯ নং ঘনকের চিত্র).',
          },
          box_2d: {
            type: Type.ARRAY,
            description:
              'Normalized 0-1000 bounding box [ymin, xmin, ymax, xmax] tightly enclosing ONLY the visual diagram/figure.',
            items: { type: Type.NUMBER },
          },
        },
        required: ['id', 'label', 'box_2d'],
      },
    },
  },
  required: ['content'],
};

function buildStructuredOcrPrompt(fallbackChapter: string, isImage: boolean): string {
  const diagramInstruction = isImage
    ? `7. VISUAL DIAGRAMS / GEOMETRY / DICE NETS (AUTO-CROP SUPPORT):
   - If any question contains a visual drawing (such as a triangle-counting figure, a folded cube/dice net with dots, a geometric diagram, or a chart — NOT a text/number table), place a marker line "[[DIAGRAM_1]]" (then "[[DIAGRAM_2]]", etc.) right below that question's stem inside "content", AND add a matching item in the "diagrams" array with exact normalized 0-1000 bounding box [ymin, xmin, ymax, xmax] tightly enclosing ONLY that visual figure (excluding question text and options).
   - If there are NO non-table visual diagrams, return "diagrams": [].`
    : `7. DIAGRAMS: If any question contains a visual figure, put "[চিত্র: সংক্ষিপ্ত বর্ণনা]" below its stem and return "diagrams": [].`;

  return `You are an expert Bangladeshi competitive exam (BCS, Bank, Primary, Govt Job Solution) study-sheet digitizer and OCR specialist.

Extract and structure EVERY visible Bengali (Unicode) and English exam question, option, answer, table, math formula, passage, and solution from the attached document into clean study-sheet format inside the JSON "content" field.

STRICT RULES:
1. TWO-COLUMN READING ORDER: If the page has two vertical columns separated by a line or gap, extract the ENTIRE LEFT COLUMN from top to bottom FIRST, then the ENTIRE RIGHT COLUMN from top to bottom. Never mix left and right columns on the same line.
2. EXACT BENGALI & ENGLISH ACCURACY: Keep every question number, Bengali/English word, number, and option exact. Do not omit or summarize any question.
3. MCQ FORMAT:
   - Keep each numbered question cleanly on its own line (e.g., "৯৫. ...").
   - Put each option on its own line ("ক. ...", "খ. ...", "গ. ...", "ঘ. ..." or "a) ...", "b) ...", "c) ...", "d) ...").
   - Put the answer on its own separate line right after option ঘ/d as "উত্তর: ক" (or "Answer: D") — NEVER stuck at the right margin of an option line.
4. TABLES & NUMBER MATRICES (e.g., 3x3 missing-number grid):
   - Format ANY table or number grid as a standard multi-line GFM Markdown table with NO blank lines between rows:
     | কলাম ১ | কলাম ২ | কলাম ৩ |
     | --- | --- | --- |
     | ৮ | ১ | ৬ |
     | ৩ | ? | ৭ |
     | ৪ | ৯ | ২ |
5. EMPHASIS & MATH:
   - Keep underlined grammar spans as <u>underlined text</u>, **bold**, and *italic*.
   - Format math fractions/roots/exponents in clean inline LaTeX ($\\frac{a}{b}$, $\\sqrt{x}$, $x^2$).
6. SKIP WATERMARKS & PUBLISHER FOOTERS ONLY:
   - Skip diagonal background watermarks, book advertisements, and cross-reference footers like "পৃষ্ঠা: ৮৫৭ এর ৯ নম্বরের অনুরূপ (অগ্রদূত Basic Math, 3rd Edition)".
${diagramInstruction}

Context Title: ${fallbackChapter}`;
}

function buildPlainTextFallbackPrompt(fallbackChapter: string): string {
  return `Extract all Bengali and English exam questions, options, tables (in Markdown table format), math equations, and answers from this study image/page in clean left-column-then-right-column order.
Put each question cleanly numbered, each option on its own line (ক./খ./গ./ঘ. or a)/b)/c)/d)), and each answer on its own line as "উত্তর: ক".
Ignore watermarks and publisher page-reference footers. Return ONLY the clean formatted exam questions directly.
Context: ${fallbackChapter}`;
}

interface ExtractedGeminiPayload {
  text: string;
  finishReason: string;
  blockReason: string;
}

function extractTextFromGeminiResponse(
  response: GenerateContentResponse | null | undefined
): ExtractedGeminiPayload {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const firstCandidate = candidates[0];
  const finishReason = String(firstCandidate?.finishReason ?? '');
  const blockReason = String(response?.promptFeedback?.blockReason ?? '');

  // 1. Check standard SDK `.text` getter first
  let directText = '';
  try {
    directText = typeof response?.text === 'string' ? response.text : '';
  } catch {
    directText = '';
  }
  if (directText.trim()) {
    return { text: directText, finishReason, blockReason };
  }

  // 2. Directly inspect candidate parts (excluding thought-only parts) in case `.text` returned empty
  const parts = Array.isArray(firstCandidate?.content?.parts)
    ? firstCandidate.content.parts
    : [];
  const collected: string[] = [];
  for (const part of parts) {
    const p = part as { text?: unknown; thought?: unknown };
    if (p && typeof p.text === 'string' && p.text.trim() && p.thought !== true) {
      collected.push(p.text);
    }
  }
  if (collected.length > 0) {
    return { text: collected.join('\n'), finishReason, blockReason };
  }

  return { text: '', finishReason, blockReason };
}

function normalizeOcrStudioContent(rawContent: string): string {
  const cleaned = String(rawContent || '').replace(/\r\n?/g, '\n').trim();
  if (!cleaned) return '';
  // Protect [[DIAGRAM_N]] tokens across formatting normalization
  const protectedTokens: string[] = [];
  const withPlaceholders = cleaned.replace(
    /\[\[\s*([A-Za-z0-9_-]+)\s*\]\]/g,
    (_, id: string) => {
      const idx = protectedTokens.length;
      protectedTokens.push(`[[${id}]]`);
      return `\n@@OCRDIAGRAMTOKEN${idx}@@\n`;
    }
  );
  let normalized = normalizeExamDocumentFormatting(withPlaceholders);
  for (let i = 0; i < protectedTokens.length; i += 1) {
    normalized = normalized.replace(`@@OCRDIAGRAMTOKEN${i}@@`, protectedTokens[i]);
  }
  return normalized.trim();
}

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'paper-cutting');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const rawBase64 = String(body.fileBase64 ?? body.imageBase64 ?? '')
      .replace(/^data:[a-zA-Z0-9.+/-]+;base64,/, '')
      .replace(/\s+/g, '');
    const declaredMime = String(body.mimeType || '')
      .trim()
      .toLowerCase()
      .replace('image/jpg', 'image/jpeg');
    const fallbackChapter =
      String(body.fallbackChapter || '').trim().slice(0, 160) || 'OCR Studio';

    if (!rawBase64) {
      return NextResponse.json(
        {
          error: 'OCR করার জন্য ছবি বা PDF-এর ডেটা পাওয়া যায়নি।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    if (declaredMime && !ALLOWED_OCR_STUDIO_MIMES.has(declaredMime)) {
      return NextResponse.json(
        {
          error: 'শুধু PNG, JPG, WebP ছবি/স্ক্রিনশট অথবা PDF ফাইল OCR করা যাবে।',
          code: 'INVALID_FILE_TYPE',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const decodedBuffer = Buffer.from(rawBase64, 'base64');
    if (decodedBuffer.length === 0) {
      return NextResponse.json(
        {
          error: 'ফাইলের ডেটা সঠিক নয়। অনুগ্রহ করে পুনরায় আপলোড বা পেস্ট করুন।',
          code: 'INVALID_FILE_DATA',
          retryable: false,
        },
        { status: 400 }
      );
    }

    if (decodedBuffer.length > MAX_INLINE_OCR_BYTES) {
      return NextResponse.json(
        {
          error:
            'ফাইলটি একক OCR অনুরোধের জন্য অনেক বড় (সর্বোচ্চ ৮ MB)। অনুগ্রহ করে ছোট ছবি বা কম পৃষ্ঠার রেঞ্জ দিন।',
          code: 'FILE_TOO_LARGE',
          retryable: false,
        },
        { status: 413 }
      );
    }

    const detectedMime = detectBinaryMimeFromMagicBytes(
      new Uint8Array(
        decodedBuffer.buffer,
        decodedBuffer.byteOffset,
        Math.min(decodedBuffer.byteLength, 1024)
      )
    );

    if (!detectedMime || !ALLOWED_OCR_STUDIO_MIMES.has(detectedMime)) {
      return NextResponse.json(
        {
          error:
            'আপলোড করা ফাইলটি বৈধ PNG, JPG, WebP ছবি বা PDF নয়। অনুগ্রহ করে সঠিক ফাইল দিন।',
          code: 'INVALID_FILE_SIGNATURE',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const isImage = detectedMime !== 'application/pdf';
    const inlinePart = {
      inlineData: {
        mimeType: detectedMime,
        data: rawBase64,
      },
    };
    const structuredPrompt = buildStructuredOcrPrompt(fallbackChapter, isImage);
    const plainPrompt = buildPlainTextFallbackPrompt(fallbackChapter);

    let extractedContent = '';
    let detectedDiagrams: DetectedOcrDiagram[] = [];
    let usedModel: string = GEMINI_MODEL;
    let lastError: unknown = null;
    let lastFinishReason = '';
    let lastBlockReason = '';

    // 3-tier resilient OCR pipeline:
    // Tier 1: GEMINI_MODEL structured JSON (with automatic diagram box_2d detection)
    // Tier 2: GEMINI_FAST_OCR_MODEL structured JSON (if Tier 1 fails OR returns empty/RECITATION)
    // Tier 3: GEMINI_FAST_OCR_MODEL plain text (if structured JSON still returned empty)
    const attempts: Array<{
      model: string;
      thinkingLevel: ThinkingLevel;
      useSchema: boolean;
      timeoutMs: number;
      temperature: number;
    }> = [
      {
        model: GEMINI_MODEL,
        thinkingLevel: ThinkingLevel.LOW,
        useSchema: true,
        timeoutMs: OCR_PRIMARY_TIMEOUT_MS,
        temperature: 0.1,
      },
      {
        model: GEMINI_FAST_OCR_MODEL,
        thinkingLevel: ThinkingLevel.MINIMAL,
        useSchema: true,
        timeoutMs: OCR_FALLBACK_TIMEOUT_MS,
        temperature: 0.1,
      },
      {
        model: GEMINI_FAST_OCR_MODEL,
        thinkingLevel: ThinkingLevel.MINIMAL,
        useSchema: false,
        timeoutMs: OCR_PLAIN_FALLBACK_TIMEOUT_MS,
        temperature: 0.2,
      },
    ];

    for (const attempt of attempts) {
      if (req.signal.aborted) {
        throw new Error('Request aborted');
      }

      try {
        const response = await generateWithRetry(
          {
            model: attempt.model,
            contents: {
              parts: [
                inlinePart,
                { text: attempt.useSchema ? structuredPrompt : plainPrompt },
              ],
            },
            config: {
              thinkingConfig: { thinkingLevel: attempt.thinkingLevel },
              temperature: attempt.temperature,
              ...(attempt.useSchema
                ? {
                    responseMimeType: 'application/json',
                    responseSchema: OCR_STUDIO_RESPONSE_SCHEMA,
                  }
                : {}),
            },
          },
          {
            maxRetries: 0,
            timeoutMs: attempt.timeoutMs,
            signal: req.signal,
            stopOnRateLimit: true,
          }
        );

        const extracted = extractTextFromGeminiResponse(response);
        if (extracted.finishReason) lastFinishReason = extracted.finishReason;
        if (extracted.blockReason) lastBlockReason = extracted.blockReason;

        if (extracted.text.trim()) {
          const parsed = parseOcrStudioStructuredOutput(extracted.text);
          const normalized = normalizeOcrStudioContent(parsed.content);
          if (normalized) {
            extractedContent = normalized;
            detectedDiagrams = parsed.diagrams;
            usedModel = attempt.model;
            break;
          }
        }
      } catch (err) {
        lastError = err;
        if (req.signal.aborted) {
          throw err;
        }
        const status = extractUpstreamStatus(err);
        if (status === 401 || status === 403) {
          throw err;
        }
        // Continue to next resilient fallback tier
      }
    }

    if (!extractedContent) {
      if (lastError && !lastFinishReason && !lastBlockReason) {
        throw lastError;
      }

      const blockedByFilter =
        /RECITATION|SAFETY|PROHIBITED|BLOCKLIST|SPII/i.test(lastFinishReason) ||
        /SAFETY|PROHIBITED|BLOCKLIST|OTHER/i.test(lastBlockReason);

      return NextResponse.json(
        {
          error: blockedByFilter
            ? 'AI সেফটি বা কপিরাইট ফিল্টারের কারণে পুরো ছবিটি একসাথে পড়া যায়নি। অনুগ্রহ করে ২-৩টি প্রশ্ন করে আরেকটু ছোট স্ক্রিনশট নিয়ে চেষ্টা করুন।'
            : 'এই ছবি বা PDF পৃষ্ঠা থেকে টেক্সট পড়া যায়নি। অনুগ্রহ করে আরও স্পষ্ট ছবি দিয়ে আবার চেষ্টা করুন।',
          code: blockedByFilter ? 'OCR_CONTENT_FILTERED' : 'EMPTY_OCR_RESULT',
          finishReason: lastFinishReason || undefined,
          blockReason: lastBlockReason || undefined,
          retryable: true,
        },
        { status: 422 }
      );
    }

    return NextResponse.json({
      ok: true,
      model: usedModel,
      mimeType: detectedMime,
      text: extractedContent,
      rawText: extractedContent,
      diagrams: detectedDiagrams,
      sections: [
        {
          chapter: fallbackChapter,
          pageNumber: 1,
          content: extractedContent,
        },
      ],
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/ocr-studio',
      'OCR সম্পন্ন করা যায়নি। অনুগ্রহ করে একটু পর আবার চেষ্টা করুন।'
    );
  }
}
