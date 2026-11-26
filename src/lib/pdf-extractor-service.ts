import fs from 'node:fs/promises';
import {
  ThinkingLevel,
  Type,
  createPartFromUri,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import {
  AiResponseParseError,
  DEFAULT_PDF_AI_TIMEOUT_MS,
  GEMINI_FAST_OCR_MODEL,
  GEMINI_MODEL,
  classifyAiError,
  extractUpstreamStatus,
  generateWithRetry,
  getGeminiClient,
  getGeminiClientForTesting,
  parseAiJson,
} from './gemini';
import {
  GEMINI_FILES_API_THRESHOLD_BYTES,
  type BatchExtractionResult,
  type PageMapping,
  type PdfOcrSpeed,
  type RawExtractedPageInput,
  parseDelimitedPagesOutput,
  salvagePagesFromMalformedJson,
  validateAndNormalizeBatchPages,
} from './pdf-rules';
import type { SplitPdfBatchDescriptor } from './pdf-splitter';
import { toBengaliNumber } from './file-validation';

export interface GeminiFileHandle {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
}

export interface PdfExtractionGeminiClient {
  models: {
    generateContent: (
      params: GenerateContentParameters
    ) => Promise<GenerateContentResponse>;
  };
  files?: {
    upload: (params: {
      file: string | Blob;
      config?: { mimeType?: string; displayName?: string };
    }) => Promise<GeminiFileHandle>;
    get: (params: { name: string }) => Promise<GeminiFileHandle>;
    delete: (params: { name: string }) => Promise<unknown>;
  };
}

let testPdfExtractorClientOverride: PdfExtractionGeminiClient | null = null;

/**
 * Test-only dependency injection hook for PDF extraction & Gemini Files API tests.
 * Strictly rejected outside NODE_ENV === 'test'.
 */
export function setPdfExtractorClientForTesting(
  client: PdfExtractionGeminiClient | null
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'setPdfExtractorClientForTesting can only be used in test environments.'
    );
  }
  testPdfExtractorClientOverride = client;
}

export function resolvePdfGeminiClient(
  override?: PdfExtractionGeminiClient
): PdfExtractionGeminiClient {
  if (override) return override;
  if (testPdfExtractorClientOverride) return testPdfExtractorClientOverride;
  const sharedTestClient = getGeminiClientForTesting();
  if (sharedTestClient) {
    return sharedTestClient as unknown as PdfExtractionGeminiClient;
  }
  return getGeminiClient() as unknown as PdfExtractionGeminiClient;
}

export async function safeDeleteGeminiFile(
  fileName: string,
  clientOverride?: PdfExtractionGeminiClient
): Promise<void> {
  if (!fileName) return;
  try {
    const client = resolvePdfGeminiClient(clientOverride);
    if (client.files?.delete) {
      await client.files.delete({ name: fileName });
    }
  } catch {
    // Best-effort cleanup of remote temporary Gemini file; never throw or leak internals
  }
}

async function waitForGeminiFileActive(
  client: PdfExtractionGeminiClient,
  uploaded: GeminiFileHandle,
  signal?: AbortSignal,
  maxWaitMs = 45_000
): Promise<GeminiFileHandle> {
  if (!uploaded.name || !client.files?.get) {
    return uploaded;
  }

  let current = uploaded;
  const deadline = Date.now() + maxWaitMs;

  while (current.state === 'PROCESSING') {
    if (signal?.aborted) {
      throw new Error('Request aborted while waiting for Gemini Files API.');
    }
    if (Date.now() > deadline) {
      throw new Error('Gemini Files API processing timed out.');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, 1_000);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    current = await client.files.get({ name: uploaded.name });
  }

  if (current.state === 'FAILED') {
    throw new Error('Gemini Files API failed to process uploaded PDF batch.');
  }

  return current;
}

function buildBatchExtractionPrompt(params: {
  pageMappings: PageMapping[];
  useOcr: boolean;
  requiresOcrPageIndices: number[];
  fallbackChapter: string;
  retryMissingOriginalPages?: number[];
}): string {
  const mappingLines = params.pageMappings
    .map(
      (m, batchRelativeIdx) =>
        `- Sub-PDF page ${batchRelativeIdx + 1} (Source PDF internal page ${m.pdfPageIndex}) => Original printed book page ${m.originalPageNumber}`
    )
    .join('\n');

  const focusInstruction =
    params.retryMissingOriginalPages && params.retryMissingOriginalPages.length > 0
      ? `\nCRITICAL RETRY FOCUS: The previous pass missed or returned empty text for original page(s): ${params.retryMissingOriginalPages.join(', ')}. Extract EVERY SINGLE ONE of these pages completely and accurately.`
      : '';

  const ocrInstruction =
    params.useOcr || params.requiresOcrPageIndices.length > 0
      ? 'Perform high-accuracy Bengali (Unicode) and English OCR on every scanned or image-based page while faithfully preserving selectable text on text-based pages.'
      : 'Extract complete, structured Bengali (Unicode) and English text faithfully from every page.';

  return `You are a precision academic PDF text extraction and OCR engine for Bangladeshi competitive job exams (BCS, Bank, Primary, Govt Jobs).

${ocrInstruction}

EXACT PAGE MAPPING FOR THIS PDF BATCH (${params.pageMappings.length} page(s)):
${mappingLines}
${focusInstruction}

STRICT RULES:
1. You MUST return one item in "pages" for EVERY SINGLE page listed above (${params.pageMappings.length} items total), in ascending original page order.
2. NEVER skip a page, NEVER merge multiple pages into one item, and NEVER summarize or shorten content.
3. NEVER invent text or fill missing pages with placeholders or page-range labels (such as "Page 37-44"). If a page is truly blank/unreadable, set hasReadableText=false and content="".
4. MULTI-COLUMN & CLEAN FORMATTING RULES (CRITICAL):
   - For 2-column exam/solution pages, read the ENTIRE left column from top to bottom FIRST, then the ENTIRE right column from top to bottom. Never mix left and right columns on the same line.
   - NEVER place one word per line. Keep full headers, questions, sentences, and answers on clean horizontal lines.
   - Format exam headers on separate clean lines (e.g., Institution Name on line 1 if printed, "পদের নাম: ..." on next line, "সময়: ... পরীক্ষার তারিখ: ... পূর্ণমান: ..." or "তারিখ: ...; সময়: ...; পূর্ণমান: ..." on the metadata line).
   - Start every numbered question (e.g. "01.", "02.", "03.", "১.", "২.", "৯৩.") on a new line with a blank line separating distinct questions.
   - Put each MCQ option/sub-item (e.g. "a)", "b)", "c)", "d)" or "ক.", "খ.", "গ.", "ঘ." or "ক)", "খ)", "গ)", "ঘ)") on its OWN indented line ("    a) ..."), even when printed side-by-side in 2 mini-columns on the page.
   - MCQ MARGIN / SIDE ANSWERS (CRITICAL): In Bangladeshi MCQ job solution books, the correct answer often sits in the far right margin next to the last option (including the very bottom question of each column or page!) as "উ. ক", "উ. ঘ", "ans. B", "ans. C", or "উত্তর: গ". ALWAYS scan the ENTIRE right margin down to the bottom line of BOTH columns and output EVERY answer cleanly on its own line IMMEDIATELY BELOW all 4 options as "উত্তর: ক" (for Bengali keys ক-ঘ) or "Answer: B" (for English keys A-D). NEVER leave "উ. ক", "ans. B", or "উত্তর: গ" stuck inside an option line, and NEVER miss the last question's bottom-right answer!
   - MCQ EXPLANATIONS vs WRITTEN SOLUTIONS (CRITICAL):
     * When an MCQ question (with options a-d / ক-ঘ) has a printed explanation box labeled "Solution:" or "Explanation:" (e.g. "Solution: IDA হলো বিশ্বব্যাংকের একটি অঙ্গসংস্থা..."), ALWAYS KEEP that explanation intact and output it BELOW the MCQ Answer using the exact Bengali label "ব্যাখ্যা: ..." (NEVER output "Solution:" or "Explanation:" on MCQ questions, and NEVER mistake the explanation for the MCQ answer key!).
     * For non-MCQ Written questions, keep "Solution:" / "সমাধান:" / "উত্তর:" on its own line below the question and keep math derivation steps ("⇒", "∴", "অতএব,") on separate lines.
   - DO NOT OCR / COMPLETELY SKIP:
     * Faint diagonal watermarks ("Recent Publication", "www.prebd.com", "Matrix") and bottom page-number footers.
     * Publisher running headers/footers (e.g., "অগ্রদূত Recent Job Solution", "অগ্রদূত রিসেন্ট লিখিত জব সলিউশন", "প্রফেসর'স Recent Job Solution").
     * Publisher guide-book page cross-reference lines printed beneath MCQs — DO NOT TYPE THEM AT ALL (e.g., "পৃষ্ঠা: ৫৮ (ক্রিম; জানুয়ারি- ২০২৫)", "পৃষ্ঠা: ৫২ (ক্রিম; জানুয়ারি- ২০২৫)", "পৃষ্ঠা: ৩৪৭ (অগ্রদূত আন্তর্জাতিক বিষয়াবলি; ৮ম সংস্করণ)", "পৃষ্ঠা: ৪১ (ক্রিম; জানুয়ারি- ২০২৫)", "পৃষ্ঠা: ২৬৪ (অগ্রদূত বিজ্ঞান; ২য় সংস্করণ)", "[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫০", "পৃষ্ঠা: ৬৬২ এর ৯৪৬ নম্বর (অগ্রদূত Basic Math, 2nd Edition, January-2024)", "পৃষ্ঠা: ২১১ (অগ্রদূত কম্পিউটার ও তথ্য প্রযুক্তি)").
     * Publisher book advertisements and boxed promotional callouts (e.g., "সাম্প্রতিক সাধারণ জ্ঞানের অসাধারণ নির্যাস 'ক্রিম' লাইব্রেরিতে পাওয়া যাচ্ছে।", "...বইটি আগামী সপ্তাহ থেকে লাইব্রেরিতে পাওয়া যাবে।", "শতভাগ কমনের জন্য পড়ুন ...").
5. MATHEMATICS, FRACTIONS & EXPONENTS (CRITICAL — JSON BACKSLASH ESCAPING):
   - ALWAYS write EVERY stacked/vertical fraction using exact inline LaTeX notation: \\frac{numerator}{denominator} (for example: cosA = \\frac{4}{5}, cosB = \\frac{5}{13}, \\frac{3x+7}{4} + \\frac{5x-4}{7} = x + 3\\frac{1}{2}, \\frac{১০}{১০০}). Inside JSON strings you MUST double-escape every LaTeX backslash ("\\\\frac{4}{5}", "\\\\times", "\\\\theta", "\\\\sqrt{2}") so JSON parsing NEVER turns "\\f" into a form-feed or produces "rac{4}{5}"! NEVER split numerator and denominator across separate lines.
   - ALWAYS write exponents cleanly (x⁴, y², z², (x²)² or x^4, y^2). NEVER misread exponents as °, *, ', or @.
   - Preserve exact mathematical symbols: ∴ (NEVER "..." or ".."), ⇒, =, ×, ÷, +, −, :, %, and visually verify equations/factorizations against the page image.
   - NEVER invent or generate missing answers during OCR: transcribe ONLY what is printed on the page.
6. ZERO-TYPO BENGALI DIGITS, WORDS & ENGLISH SPELLING PROOFREADING (CRITICAL):
   - Visually double-check EVERY Bengali digit individually against the image — especially look-alike pairs **৪ vs ৮** (e.g. "৬৪১" vs "৬৮১"), **৩ vs ৬** (e.g. "২০২৬" vs "২০২৩"), **৭ vs ৯**, and **১ vs ২** — in dates, years, options, and math numbers!
   - Visually verify EVERY Bengali word verbatim without substituting synonyms (e.g., keep "কতটি" as "কতটি", NOT "কয়টি"): pay strict attention to যুক্তবর্ণ (ক্ষ, জ্ঞ, হ্ম, ন্ত, ন্দ, স্ত, ষ্ট, ত্র, শ্র, ব্ধ, দ্ধ), vowel signs (ি vs ী, ু vs ূ, ৃ), ড়/ঢ়/য়, শ/ষ/স, ন/ণ, ং/ঃ/ঁ.
   - Ignore faint diagonal watermarks ("Recent Publication", etc.) printed over Bengali text or table cells — read the darker printed letters underneath carefully (e.g., "ব্যঞ্জনবর্ণ", "স্বরবর্ণ", "খুঁটিনাটি", "অরেঞ্জ বিপ্লব", "চেকোস্লোভাকিয়া") without letting watermark strokes corrupt characters.
   - Visually verify EVERY English word letter-by-letter so NO typos slip through (e.g., "Throughout" NEVER "I thoughout", "moments" NEVER "moents", "passage" NEVER "paggage").
7. TABLES, NUMBER GRIDS, SIDE-BY-SIDE OPTIONS & VISUAL DIAGRAMS (CRITICAL):
   - Whenever the page contains ANY printed table, 3×3 / 4×4 number puzzle grid (সংখ্যাছক), schedule, comparison chart, or matching columns (e.g., বামস্তম্ভ / ডানস্তম্ভ, Column A / Column B, বিপ্লবের নাম / সময়কাল / দেশ), you MUST transcribe it as a valid GitHub-Flavored Markdown table starting on a NEW LINE directly below the question stem or introductory "ব্যাখ্যা:" sentence:
     | ৮ | ১ | ৬ |
     | --- | --- | --- |
     | ৩ | ? | ৭ |
     | ৪ | ৯ | ২ |
   - SIDE-BY-SIDE OPTIONS NEXT TO A GRID/DIAGRAM (CRITICAL): When options ("ক. ২", "খ. ৫", "গ. ৬", "ঘ. ৮") are printed to the LEFT or RIGHT side of a 3×3 number grid or figure, you MUST output BOTH the Markdown table/diagram AND ALL 4 options ("    ক. ২", "    খ. ৫", "    গ. ৬", "    ঘ. ৮") plus the margin answer ("উত্তর: খ")! NEVER drop the options when transcribing a grid or figure!
   - STRICT TABLE RULES:
     * NEVER put blank lines between table rows (each row MUST be on the immediately next line).
     * NEVER put multiple table rows on the same line (NEVER output "| ৮ | ১ | ৬ || --- | --- | --- || ৩ | ? | ৭ |" or "| a | b | | --- | --- | | c | d |" on one line) and NEVER glue the first table row onto the end of a question or "ব্যাখ্যা:" sentence.
     * Keep EVERY column count identical across the header row, separator row, and every body row (leave empty cells blank as "| ব্যঞ্জনবর্ণ | ৩৯টি |  |").
   - VISUAL DIAGRAMS / FIGURES / CUBE NETS / GEOMETRY (CRITICAL): If a question depends on a printed diagram, dice/cube folding net (ঘনক-জাল), geometric figure, Venn diagram, or graph that cannot be represented as a plain table, NEVER silently omit it! Immediately below the question stem (and before the options), output a crisp descriptive figure line in the exact format:
     [চিত্র: ... স্পষ্ট ও সম্পূর্ণ বাংলা বিবরণ যাতে চিত্রটি না দেখেও প্রশ্ন সমাধান করা যায় — যেমন ঘনক-জালে প্রতিটি তলের বিন্দু সংখ্যা ও সংযুক্ত অবস্থান ...]
8. BOLD, UNDERLINED & ITALIC FORMATTING (CRITICAL — MANDATORY UNDERLINE SCAN):
   - Faithfully preserve printed typographic emphasis inside questions, options, passages, explanations, and tables:
     * Printed **bold** words/phrases or sub-headings -> wrap in **bold** (do NOT wrap entire normal question stems unless selectively bolded for emphasis).
     * Printed *italic* words/titles/foreign terms -> wrap in *italic*.
     * MANDATORY UNDERLINE DETECTION: Whenever a question mentions "underlined", "underline", "underlined part", "underlined word", "underlined phrase", "underlined clause", "নিম্নরেখ", "রেখাঙ্কিত", "দাগ দেওয়া", or "আন্ডারলাইন" (e.g., "I know <u>where he lives</u>. Here the underlined part is—", "He ran <u>fast</u>. Here the underlined word is—", "<u>সকালে</u> উঠিয়া আমি মনে মনে বলি"), you MUST carefully inspect the sentence in the image to locate the exact printed horizontal line underneath the word/phrase/clause and wrap ONLY that exact underlined span in <u>...</u>! NEVER omit <u>...</u> on underlined grammar questions.
     * Keep fill-in-the-blank lines strictly as underscores (_____) — NEVER wrap blanks in <u>...</u>.
9. Set "pdfPageIndex" to the Source PDF internal page number and "originalPageNumber" to the exact Original printed book page number from the mapping above.
10. Set "chapter" to the detected chapter/topic heading on that page, or "${params.fallbackChapter}" if none is printed.
11. Set "ocrUsed" to true ONLY if visual OCR was performed on scanned/image text for that page; set false if pure digital text was extracted.

Return ONLY valid JSON matching the schema.`;
}

function buildDelimitedBatchExtractionPrompt(params: {
  pageMappings: PageMapping[];
  useOcr: boolean;
  requiresOcrPageIndices: number[];
  fallbackChapter: string;
  retryMissingOriginalPages?: number[];
}): string {
  const mappingLines = params.pageMappings
    .map(
      (m, batchRelativeIdx) =>
        `- Sub-PDF page ${batchRelativeIdx + 1} (Source PDF internal page ${m.pdfPageIndex}) => Original printed book page ${m.originalPageNumber}`
    )
    .join('\n');

  const focusInstruction =
    params.retryMissingOriginalPages && params.retryMissingOriginalPages.length > 0
      ? `\nCRITICAL RETRY FOCUS: Extract EVERY SINGLE ONE of these missing original page(s): ${params.retryMissingOriginalPages.join(', ')}.`
      : '';

  const ocrInstruction =
    params.useOcr || params.requiresOcrPageIndices.length > 0
      ? 'Perform high-accuracy Bengali (Unicode) and English OCR on every scanned or image-based page while faithfully preserving selectable text on text-based pages.'
      : 'Extract complete, structured Bengali (Unicode) and English text faithfully from every page.';

  const exampleMapping = params.pageMappings[0] ?? { pdfPageIndex: 1, originalPageNumber: 1 };

  return `You are a precision academic PDF text extraction and OCR engine for Bangladeshi competitive job exams (BCS, Bank, Primary, Govt Jobs).

${ocrInstruction}

EXACT PAGE MAPPING FOR THIS PDF BATCH (${params.pageMappings.length} page(s)):
${mappingLines}
${focusInstruction}

OUTPUT FORMAT (PLAIN TEXT ONLY — DO NOT RETURN JSON OR MARKDOWN CODE FENCES):
Wrap each page strictly between <<<PAGE_START ...>>> and <<<PAGE_END>>> tags in ascending original page order:

<<<PAGE_START pdf=${exampleMapping.pdfPageIndex} orig=${exampleMapping.originalPageNumber} chapter="${params.fallbackChapter}" ocr=${params.useOcr ? 'true' : 'false'}>>>
[Full verbatim Bengali/English/Math text for that page]
<<<PAGE_END>>>

STRICT RULES:
1. Output one <<<PAGE_START ...>>> ... <<<PAGE_END>>> block for EVERY SINGLE page listed above (${params.pageMappings.length} blocks total).
2. NEVER skip a page, NEVER merge pages, NEVER summarize, and NEVER invent text.
3. MULTI-COLUMN & CLEAN FORMATTING RULES (CRITICAL):
   - For 2-column exam/solution pages, read the ENTIRE left column from top to bottom FIRST, then the ENTIRE right column from top to bottom. Never mix columns horizontally.
   - NEVER output one word per line. Keep complete sentences, headers, questions, and answers on clean horizontal lines.
   - Put each numbered question (01., 02., ১., ২., ৯৩.) on its own line and each option/sub-item (a)-d), ক.-ঘ., ক)-ঘ)) on its own indented line ("    a) ...").
   - MCQ MARGIN ANSWERS & EXPLANATIONS (CRITICAL):
     * Scan the ENTIRE right margin down to the bottom question of BOTH columns and extract every margin MCQ answer ("উ. ক", "ans. B", "উত্তর: গ") onto a clean line IMMEDIATELY BELOW all 4 options as "উত্তর: ক" or "Answer: B" (never leave inside an option or skip the last question's answer!).
     * When an MCQ question has an explanatory box printed as "Solution: ..." or "Explanation: ...", KEEP the explanation and output it BELOW the answer using the label "ব্যাখ্যা: ..." (never "Solution:" or "Explanation:" on MCQs; keep "Solution:" only for non-MCQ Written questions).
   - DO NOT OCR / COMPLETELY SKIP:
     * Faint diagonal watermarks ("Recent Publication", "www.prebd.com", "Matrix") and page footers.
     * Publisher running headers/footers (e.g. "অগ্রদূত Recent Job Solution", "অগ্রদূত রিসেন্ট লিখিত জব সলিউশন").
     * Publisher guide-book page cross-reference lines — DO NOT TYPE THEM AT ALL (e.g. "পৃষ্ঠা: ৫৮ (ক্রিম; জানুয়ারি- ২০২৫)", "পৃষ্ঠা: ৩৪৭ (অগ্রদূত আন্তর্জাতিক বিষয়াবলি; ৮ম সংস্করণ)", "পৃষ্ঠা: ২৬৪ (অগ্রদূত বিজ্ঞান; ২য় সংস্করণ)", "[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫০", "পৃষ্ঠা: ৬৬২ এর ৯৪৬ নম্বর (অগ্রদূত Basic Math, 2nd Edition, January-2024)").
     * Publisher book advertisements and boxed promo notices (e.g. "সাম্প্রতিক সাধারণ জ্ঞানের অসাধারণ নির্যাস 'ক্রিম' লাইব্রেরিতে পাওয়া যাচ্ছে।", "...বইটি আগামী সপ্তাহ থেকে লাইব্রেরিতে পাওয়া যাবে।", "শতভাগ কমনের জন্য পড়ুন ...").
4. MATHEMATICS, FRACTIONS & EXPONENTS (CRITICAL):
   - Write EVERY vertical/stacked fraction inline using \\frac{numerator}{denominator} (e.g., cosA = \\frac{4}{5}, cosB = \\frac{5}{13}, \\frac{3x+7}{4} + \\frac{5x-4}{7} = x + 3\\frac{1}{2}, \\frac{১০}{১০০}). NEVER output "rac{4}{5}" and NEVER break numerator and denominator onto separate lines.
   - Write exponents accurately (x⁴, y², z² or x^4, y^2) — NEVER as °, *, ', or @.
   - Use exact symbols ∴ (never "..." or ".."), ⇒, =, ×, ÷, and verify every equation/factorization visually against the page image.
   - Transcribe strictly what is printed on the page; NEVER fabricate missing answers during OCR.
5. ZERO-TYPO SPELLING, DIGITS, TABLES, DIAGRAMS & BOLD/UNDERLINE/ITALIC FORMATTING (CRITICAL):
   - Visually double-check Bengali digits (**৪ vs ৮** like "৬৪১" vs "৬৮১", **৩ vs ৬** like "২০২৬" vs "২০২৩", **৭ vs ৯**), verbatim Bengali words (keep "কতটি", not "কয়টি"), যুক্তবর্ণ, vowel signs, and English spelling ("Throughout", "moments", "passage") against the image; ignore faint diagonal watermarks overlapping cells.
   - ALWAYS preserve EVERY printed table, 3×3 number grid (সংখ্যাছক), chart, or matching-column grid as a contiguous newline-separated Markdown table starting on a NEW LINE below the question stem or "ব্যাখ্যা:" text:
     | ৮ | ১ | ৬ |
     | --- | --- | --- |
     | ৩ | ? | ৭ |
     | ৪ | ৯ | ২ |
     NEVER put blank lines between table rows, NEVER put multiple table rows on a single line (no "||"), and ALWAYS transcribe ALL 4 options ("ক."–"ঘ.") printed next to a grid/diagram!
   - If a question relies on a visual figure/diagram (e.g., dice/cube net ঘনক-জাল, geometry, Venn diagram), NEVER omit it — output a clear descriptive line "[চিত্র: স্পষ্ট বাংলা বিবরণ]" directly under the question stem before the options.
   - ALWAYS preserve printed emphasis accurately: **bold**, *italic*, and <u>underlined</u>. Whenever a question mentions "underlined part/word/phrase/clause", "নিম্নরেখ", or "রেখাঙ্কিত", you MUST visually locate the horizontal underline in the sentence and wrap that exact span in <u>...</u>. Keep fill-in-the-blank lines as _____.
6. Put the detected chapter heading in chapter="..." (or "${params.fallbackChapter}" if none is printed).
7. Do NOT wrap the output in JSON or code fences.`;
}

const PDF_BATCH_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    pages: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          pdfPageIndex: { type: Type.INTEGER },
          originalPageNumber: { type: Type.INTEGER },
          chapter: { type: Type.STRING },
          content: { type: Type.STRING },
          hasReadableText: { type: Type.BOOLEAN },
          ocrUsed: { type: Type.BOOLEAN },
        },
        required: [
          'pdfPageIndex',
          'originalPageNumber',
          'chapter',
          'content',
          'hasReadableText',
          'ocrUsed',
        ],
      },
    },
  },
  required: ['pages'],
};

interface GeminiBatchJsonResponse {
  pages?: RawExtractedPageInput[];
}

export interface ExtractPdfBatchOptions {
  batch: SplitPdfBatchDescriptor;
  useOcr: boolean;
  ocrSpeed?: PdfOcrSpeed;
  fallbackChapter: string;
  signal?: AbortSignal;
  client?: PdfExtractionGeminiClient;
  filesApiThresholdBytes?: number;
  preferFilesApi?: boolean;
  /** When true, bypasses strict JSON schema and uses quote/backslash-proof plain-text delimited extraction on GEMINI_MODEL. */
  preferDelimitedFallback?: boolean;
  maxMissingPageRetries?: number;
  timeoutMs?: number;
  onGeminiFileUploaded?: (fileName: string) => void;
  onGeminiFileDeleted?: (fileName: string) => void;
}

/**
 * Extracts all pages from a single split PDF batch (guaranteed < 50 MB).
 * - In `ocrSpeed === 'fast'` mode: uses free-tier `GEMINI_FAST_OCR_MODEL` ('gemini-3.1-flash-lite')
 *   with `ThinkingLevel.MINIMAL` (zero thinking latency, 3-4x faster OCR), automatically upgrading
 *   only missed pages to `GEMINI_MODEL` on targeted retry.
 * - In `ocrSpeed === 'accurate'` mode (default when omitted): uses `GEMINI_MODEL` ('gemini-4-hydrogen').
 * Uses Gemini Files API for larger batches (> 10 MB by default) to avoid Base64
 * memory inflation, and ALWAYS cleans up uploaded temporary Gemini files in `finally`.
 */
export async function extractSinglePdfBatch(
  options: ExtractPdfBatchOptions
): Promise<BatchExtractionResult> {
  const {
    batch,
    useOcr,
    ocrSpeed = 'accurate',
    fallbackChapter,
    signal,
    filesApiThresholdBytes = GEMINI_FILES_API_THRESHOLD_BYTES,
    preferFilesApi = false,
    preferDelimitedFallback = false,
    maxMissingPageRetries = 1,
    timeoutMs = DEFAULT_PDF_AI_TIMEOUT_MS,
  } = options;

  const client = resolvePdfGeminiClient(options.client);
  const shouldUseFilesApi =
    Boolean(client.files?.upload) &&
    (preferFilesApi || batch.byteSize > filesApiThresholdBytes);

  let uploadedGeminiFileName: string | null = null;
  let uploadedPart: ReturnType<typeof createPartFromUri> | { inlineData: { mimeType: string; data: string } };
  let usedFilesApi = false;

  try {
    if (signal?.aborted) {
      throw new Error('Request aborted before batch extraction started.');
    }

    if (shouldUseFilesApi && client.files?.upload) {
      const uploaded = await client.files.upload({
        file: batch.filePath,
        config: {
          mimeType: 'application/pdf',
          displayName: `pdf-batch-${batch.batchIndex + 1}-p${batch.originalStartPage}-${batch.originalEndPage}.pdf`,
        },
      });
      if (uploaded.name) {
        uploadedGeminiFileName = uploaded.name;
        options.onGeminiFileUploaded?.(uploaded.name);
      }
      const activeFile = await waitForGeminiFileActive(client, uploaded, signal);
      if (!activeFile.uri) {
        throw new Error('Gemini Files API did not return a valid file URI.');
      }
      uploadedPart = createPartFromUri(
        activeFile.uri,
        activeFile.mimeType || 'application/pdf'
      );
      usedFilesApi = true;
    } else {
      const batchBytes = await fs.readFile(batch.filePath);
      uploadedPart = {
        inlineData: {
          mimeType: 'application/pdf',
          data: Buffer.from(batchBytes).toString('base64'),
        },
      };
      usedFilesApi = false;
    }

    const callDelimitedModelForMappings = async (
      mappingsToExtract: PageMapping[],
      retryMissingOriginalPages?: number[]
    ): Promise<RawExtractedPageInput[]> => {
      const prompt = buildDelimitedBatchExtractionPrompt({
        pageMappings: mappingsToExtract,
        useOcr,
        requiresOcrPageIndices: batch.requiresOcrPageIndices,
        fallbackChapter,
        retryMissingOriginalPages,
      });

      const response = await generateWithRetry(
        {
          model: GEMINI_MODEL,
          contents: {
            parts: [uploadedPart, { text: prompt }],
          },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          },
        },
        {
          client,
          maxRetries: preferDelimitedFallback ? 1 : 2,
          timeoutMs,
          signal,
          stopOnRateLimit: true,
        }
      );

      const delimited = parseDelimitedPagesOutput(
        response.text,
        mappingsToExtract,
        fallbackChapter,
        useOcr
      );
      if (delimited.length > 0) {
        return delimited;
      }

      const salvagedJson = salvagePagesFromMalformedJson(response.text);
      if (salvagedJson.length > 0) {
        return salvagedJson;
      }

      throw new AiResponseParseError('AI returned an unparseable delimited OCR payload.');
    };

    const callModelForMappings = async (
      mappingsToExtract: PageMapping[],
      retryMissingOriginalPages?: number[]
    ): Promise<RawExtractedPageInput[]> => {
      const prompt = buildBatchExtractionPrompt({
        pageMappings: mappingsToExtract,
        useOcr,
        requiresOcrPageIndices: batch.requiresOcrPageIndices,
        fallbackChapter,
        retryMissingOriginalPages,
      });

      const isMissingPageRetry =
        Array.isArray(retryMissingOriginalPages) && retryMissingOriginalPages.length > 0;
      const useFastLiteModel = ocrSpeed === 'fast' && !isMissingPageRetry;
      const selectedModel = useFastLiteModel ? GEMINI_FAST_OCR_MODEL : GEMINI_MODEL;
      const selectedThinkingLevel = useFastLiteModel
        ? ThinkingLevel.MINIMAL
        : ThinkingLevel.MEDIUM;

      const response = await generateWithRetry(
        {
          model: selectedModel,
          contents: {
            parts: [uploadedPart, { text: prompt }],
          },
          config: {
            thinkingConfig: { thinkingLevel: selectedThinkingLevel },
            responseMimeType: 'application/json',
            responseSchema: PDF_BATCH_RESPONSE_SCHEMA,
          },
        },
        {
          client,
          timeoutMs,
          signal,
          stopOnRateLimit: true,
        }
      );

      try {
        const parsed = parseAiJson<GeminiBatchJsonResponse>(response.text, 'object');
        return Array.isArray(parsed.pages) ? parsed.pages : [];
      } catch (parseErr) {
        // Salvage complete/repaired page objects when dense Bengali/Math MCQ responses break strict JSON
        const salvaged = salvagePagesFromMalformedJson(response.text);
        if (salvaged.length > 0) {
          return salvaged;
        }
        const delimited = parseDelimitedPagesOutput(
          response.text,
          mappingsToExtract,
          fallbackChapter,
          useOcr
        );
        if (delimited.length > 0) {
          return delimited;
        }
        throw parseErr;
      }
    };

    let usedDelimitedFallback = false;
    let firstRawPages: RawExtractedPageInput[];

    if (preferDelimitedFallback) {
      usedDelimitedFallback = true;
      firstRawPages = await callDelimitedModelForMappings(batch.pageMappings);
    } else {
      try {
        firstRawPages = await callModelForMappings(batch.pageMappings);
      } catch (firstErr) {
        if (signal?.aborted || extractUpstreamStatus(firstErr) === 429) {
          throw firstErr;
        }
        if (firstErr instanceof AiResponseParseError) {
          // Automatic quote/backslash-proof fallback using GEMINI_MODEL in plain-text delimited mode
          usedDelimitedFallback = true;
          firstRawPages = await callDelimitedModelForMappings(batch.pageMappings);
        } else {
          throw firstErr;
        }
      }
    }

    let normalized = validateAndNormalizeBatchPages({
      batchIndex: batch.batchIndex,
      expectedMappings: batch.pageMappings,
      rawPages: firstRawPages,
      fallbackChapter,
      useOcr,
      batchRequiresOcr: batch.requiresOcrPageIndices.length > 0,
      usedFilesApi,
    });

    // If JSON pass returned 0 valid pages without an upstream error, recover via delimited fallback
    if (
      normalized.extractedPageCount === 0 &&
      !usedDelimitedFallback &&
      !signal?.aborted
    ) {
      try {
        usedDelimitedFallback = true;
        const fallbackRawPages = await callDelimitedModelForMappings(batch.pageMappings);
        normalized = validateAndNormalizeBatchPages({
          batchIndex: batch.batchIndex,
          expectedMappings: batch.pageMappings,
          rawPages: fallbackRawPages,
          fallbackChapter,
          useOcr,
          batchRequiresOcr: batch.requiresOcrPageIndices.length > 0,
          usedFilesApi,
        });
      } catch (fallbackErr) {
        if (signal?.aborted || extractUpstreamStatus(fallbackErr) === 429) {
          throw fallbackErr;
        }
      }
    }

    // If any expected pages were missed/empty on pass 1, run bounded targeted retry
    let retryAttempt = 0;
    while (
      normalized.missingOriginalPages.length > 0 &&
      retryAttempt < maxMissingPageRetries &&
      !signal?.aborted
    ) {
      retryAttempt += 1;
      const missingSet = new Set(normalized.missingOriginalPages);
      const missingMappings = batch.pageMappings.filter((m) =>
        missingSet.has(m.originalPageNumber)
      );
      const missingOrigNums = missingMappings.map((m) => m.originalPageNumber);

      try {
        let retryRawPages: RawExtractedPageInput[];
        if (usedDelimitedFallback) {
          retryRawPages = await callDelimitedModelForMappings(
            missingMappings,
            missingOrigNums
          );
        } else {
          try {
            retryRawPages = await callModelForMappings(
              batch.pageMappings,
              missingOrigNums
            );
          } catch (retryParseErr) {
            if (signal?.aborted || extractUpstreamStatus(retryParseErr) === 429) {
              throw retryParseErr;
            }
            if (retryParseErr instanceof AiResponseParseError) {
              usedDelimitedFallback = true;
              retryRawPages = await callDelimitedModelForMappings(
                missingMappings,
                missingOrigNums
              );
            } else {
              throw retryParseErr;
            }
          }
        }

        const missingPdfIndexSet = new Set(missingMappings.map((m) => m.pdfPageIndex));
        const combinedRaw: RawExtractedPageInput[] = [
          ...normalized.pages.map((p) => ({
            pdfPageIndex: p.pdfPageIndex,
            originalPageNumber: p.originalPageNumber,
            chapter: p.chapter,
            content: p.content,
            hasReadableText: p.hasReadableText,
            ocrUsed: p.ocrUsed,
          })),
          ...retryRawPages.filter((rp) => {
            const orig =
              typeof rp.originalPageNumber === 'number'
                ? Math.round(rp.originalPageNumber)
                : null;
            const pdfIdx =
              typeof rp.pdfPageIndex === 'number'
                ? Math.round(rp.pdfPageIndex)
                : null;
            if (orig !== null) return missingSet.has(orig);
            if (pdfIdx !== null) return missingPdfIndexSet.has(pdfIdx);
            return false;
          }),
        ];

        normalized = validateAndNormalizeBatchPages({
          batchIndex: batch.batchIndex,
          expectedMappings: batch.pageMappings,
          rawPages: combinedRaw,
          fallbackChapter,
          useOcr,
          batchRequiresOcr: batch.requiresOcrPageIndices.length > 0,
          usedFilesApi,
        });
      } catch (retryErr) {
        const upstreamStatus = extractUpstreamStatus(retryErr);
        if (upstreamStatus === 429) {
          throw retryErr;
        }
        normalized.warnings.push(
          `Batch ${toBengaliNumber(batch.batchIndex + 1)}-এর অনুপস্থিত পৃষ্ঠা পুনরায় সংগ্রহের চেষ্টা ব্যর্থ হয়েছে।`
        );
        break;
      }
    }

    return normalized;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    const upstreamStatus = extractUpstreamStatus(error);
    const classified = classifyAiError(
      error,
      `Batch ${toBengaliNumber(batch.batchIndex + 1)} প্রসেস করতে সমস্যা হয়েছে।`
    );

    const quotaFriendlyError =
      upstreamStatus === 429
        ? 'ফ্রি-টিয়ার Gemini API কোটা সাময়িকভাবে শেষ হয়ে গেছে। প্রক্রিয়াটি নিরাপদে বন্ধ করা হয়েছে (কোনো পেইড সেবা চালু করা হয়নি)। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'
        : classified.error;

    return {
      batchIndex: batch.batchIndex,
      status: 'failed',
      expectedMappings: batch.pageMappings,
      pages: [],
      extractedPageCount: 0,
      missingOriginalPages: batch.pageMappings.map((m) => m.originalPageNumber),
      duplicateOriginalPages: [],
      outOfOrderDetected: false,
      ocrUsed: false,
      usedFilesApi,
      warnings: [quotaFriendlyError],
      error: quotaFriendlyError,
      errorCode: classified.code,
      retryable: classified.retryable,
    };
  } finally {
    if (uploadedGeminiFileName) {
      await safeDeleteGeminiFile(uploadedGeminiFileName, client);
      options.onGeminiFileDeleted?.(uploadedGeminiFileName);
    }
  }
}

/**
 * Extracts text / OCR from a validated single image (PNG, JPEG, WebP).
 */
export async function extractSingleImageDocument(params: {
  imageBytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  useOcr: boolean;
  originalPageNumber: number;
  fallbackChapter: string;
  signal?: AbortSignal;
  client?: PdfExtractionGeminiClient;
}): Promise<BatchExtractionResult> {
  const client = resolvePdfGeminiClient(params.client);
  const mapping: PageMapping = {
    pdfPageIndex: 1,
    originalPageNumber: params.originalPageNumber,
  };

  try {
    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: params.mimeType,
                data: Buffer.from(params.imageBytes).toString('base64'),
              },
            },
            {
              text: buildBatchExtractionPrompt({
                pageMappings: [mapping],
                useOcr: true,
                requiresOcrPageIndices: [1],
                fallbackChapter: params.fallbackChapter,
              }),
            },
          ],
        },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: PDF_BATCH_RESPONSE_SCHEMA,
        },
      },
      {
        client,
        maxRetries: 1,
        timeoutMs: 45_000,
        signal: params.signal,
        stopOnRateLimit: true,
      }
    );

    let rawPages: RawExtractedPageInput[] = [];
    try {
      const parsed = parseAiJson<GeminiBatchJsonResponse>(response.text, 'object');
      rawPages = Array.isArray(parsed.pages) ? parsed.pages : [];
    } catch {
      rawPages = salvagePagesFromMalformedJson(response.text);
      if (rawPages.length === 0) {
        rawPages = parseDelimitedPagesOutput(
          response.text,
          [mapping],
          params.fallbackChapter,
          true
        );
      }
      if (rawPages.length === 0 && !params.signal?.aborted) {
        const fallbackResponse = await generateWithRetry(
          {
            model: GEMINI_MODEL,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: params.mimeType,
                    data: Buffer.from(params.imageBytes).toString('base64'),
                  },
                },
                {
                  text: buildDelimitedBatchExtractionPrompt({
                    pageMappings: [mapping],
                    useOcr: true,
                    requiresOcrPageIndices: [1],
                    fallbackChapter: params.fallbackChapter,
                  }),
                },
              ],
            },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            },
          },
          {
            client,
            maxRetries: 1,
            timeoutMs: DEFAULT_PDF_AI_TIMEOUT_MS,
            signal: params.signal,
            stopOnRateLimit: true,
          }
        );
        rawPages = parseDelimitedPagesOutput(
          fallbackResponse.text,
          [mapping],
          params.fallbackChapter,
          true
        );
      }
    }

    return validateAndNormalizeBatchPages({
      batchIndex: 0,
      expectedMappings: [mapping],
      rawPages,
      fallbackChapter: params.fallbackChapter,
      useOcr: true,
      batchRequiresOcr: true,
      usedFilesApi: false,
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    const upstreamStatus = extractUpstreamStatus(error);
    const classified = classifyAiError(
      error,
      'ছবি থেকে OCR টেক্সট সংগ্রহ করা যায়নি।'
    );
    const errorMsg =
      upstreamStatus === 429
        ? 'ফ্রি-টিয়ার Gemini API কোটা সাময়িকভাবে শেষ হয়ে গেছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'
        : classified.error;

    return {
      batchIndex: 0,
      status: 'failed',
      expectedMappings: [mapping],
      pages: [],
      extractedPageCount: 0,
      missingOriginalPages: [params.originalPageNumber],
      duplicateOriginalPages: [],
      outOfOrderDetected: false,
      ocrUsed: false,
      usedFilesApi: false,
      warnings: [errorMsg],
      error: errorMsg,
      errorCode: classified.code,
      retryable: classified.retryable,
    };
  }
}
