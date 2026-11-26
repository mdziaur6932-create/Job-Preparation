import {
  ThinkingLevel,
  Type,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import {
  DEFAULT_AI_TIMEOUT_MS,
  GEMINI_MODEL,
  generateWithRetry,
  getGeminiClient,
  parseAiJson,
} from './gemini';
import {
  cleanDeterministicMathSymbols,
  hasCorruptedMathOcr,
} from './exam-math-and-answer-guard';
import {
  normalizeExamDocumentFormatting,
  parseExamDocumentForDisplay,
  stripPromotionalBookAds,
} from './exam-text-formatter';
import { serializeMarkdownTable } from './rich-text-and-table-parser';

export interface OcrRefinedExamHeader {
  institution: string;
  postName: string;
  metadata: string;
}

export interface OcrRefinedExamOption {
  marker: string;
  text: string;
}

export interface OcrRefinedExamQuestion {
  /** Exact preserved printed numbering (e.g. "12.", "১৬.", "০১।") */
  numberLabel: string;
  /** Cleaned question stem with mathematical expressions in LaTeX notation */
  questionText: string;
  /** Clean MCQ/sub-options with any trailing `ans. A` detached */
  options: OcrRefinedExamOption[];
  /** Extracted printed answer placed below the question/options (bold in UI & PDF). Empty string if book had no answer. */
  answer: string;
  /** Label such as "Answer", "উত্তর", "সমাধান", or "Solution" */
  answerLabel: string;
  /** Step-by-step LaTeX mathematical derivation lines (only if present in source) */
  solutionSteps: string[];
  /** Preserved red-lined highlights / critical emphasis notes */
  highlights: string[];
  /** True when LaTeX math notation is present/converted */
  hasMathLatex: boolean;
  /** True when question carries a red-lined highlight or critical review flag */
  isHighlighted: boolean;
}

export interface OcrRefinedExamPaperJson {
  schemaVersion: '1.0';
  examTitle: string;
  header: OcrRefinedExamHeader;
  questions: OcrRefinedExamQuestion[];
  refinementSummary: {
    totalQuestions: number;
    mathLatexConvertedCount: number;
    extractedInlineAnswersCount: number;
    preservedHighlightsCount: number;
  };
}

export interface OcrRefinerGeminiClient {
  models: {
    generateContent: (
      params: GenerateContentParameters
    ) => Promise<GenerateContentResponse>;
  };
}

export interface RefineExamPaperInput {
  rawContent: string;
  bookTitle?: string;
  examTitle?: string;
  highlightHints?: string[];
  signal?: AbortSignal;
  client?: OcrRefinerGeminiClient;
}

export interface RefineExamPaperResult {
  refinedJson: OcrRefinedExamPaperJson;
  formattedContent: string;
  usedAi: boolean;
}

/**
 * Strict Gemini Structured JSON Response Schema for the OCR Refiner Agent.
 * Guarantees deterministic JSON shape preserving numbering, LaTeX math,
 * separated bold answers below options, and red-lined highlights.
 */
export const OCR_REFINER_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    examTitle: { type: Type.STRING },
    header: {
      type: Type.OBJECT,
      properties: {
        institution: { type: Type.STRING },
        postName: { type: Type.STRING },
        metadata: { type: Type.STRING },
      },
      required: ['institution', 'postName', 'metadata'],
    },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          numberLabel: { type: Type.STRING },
          questionText: { type: Type.STRING },
          options: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                marker: { type: Type.STRING },
                text: { type: Type.STRING },
              },
              required: ['marker', 'text'],
            },
          },
          answer: { type: Type.STRING },
          answerLabel: { type: Type.STRING },
          solutionSteps: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          highlights: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          hasMathLatex: { type: Type.BOOLEAN },
          isHighlighted: { type: Type.BOOLEAN },
        },
        required: [
          'numberLabel',
          'questionText',
          'options',
          'answer',
          'answerLabel',
          'solutionSteps',
          'highlights',
          'hasMathLatex',
          'isHighlighted',
        ],
      },
    },
  },
  required: ['examTitle', 'header', 'questions'],
};

const LATEX_DETECTION_RE =
  /\\frac\{|\\sqrt\{|\\times|\\div|\\therefore|\\Rightarrow|\$[^$\n]+\$|\^\{?[0-9০-৯a-zA-Z]+\}?/;

/**
 * Strips any stray trailing `ans. A` / `Ans: ক` from an option's text and returns
 * both the clean option text and the extracted answer (if any).
 */
export function detachInlineOptionAnswer(optionText: string): {
  cleanOptionText: string;
  extractedAnswer: string | null;
} {
  const trimmed = (optionText ?? '').trim();
  if (!trimmed) {
    return { cleanOptionText: '', extractedAnswer: null };
  }

  // Match `ওষ্ঠ ans. A`, `ওষ্ঠans. A`, `To err are human. ans. A`, `ঢাকা Ans: ক`
  const ansMatch = trimmed.match(
    /^(.*?)\s*(?:ans\.|ans:)\s*([A-Ha-h]|[ক-ঙ])(?:\s*\.?\s*)$/i
  );
  if (ansMatch) {
    const clean = ansMatch[1].trim();
    const val = /[a-h]/.test(ansMatch[2])
      ? ansMatch[2].toUpperCase()
      : ansMatch[2];
    return { cleanOptionText: clean, extractedAnswer: val };
  }

  // Match Bengali margin MCQ answers (`উ. ক`, `উঃ ঘ`, `উত্তর: গ`, `উত্তর. খ`)
  const bnAnsMatch = trimmed.match(
    /^(.*?)\s+(?:উ\.|উ[:ঃ]|উত্তর\s*[.:ঃ])\s*([ক-ঙ])(?:\s*\.?\s*)$/
  );
  if (bnAnsMatch) {
    return {
      cleanOptionText: bnAnsMatch[1].trim(),
      extractedAnswer: bnAnsMatch[2],
    };
  }

  // Match non-fill-in-the-blank `Answer: A` / `Answer: ক`
  if (!/(?:___|(?:\.{3,}))/.test(trimmed)) {
    const fullAnsMatch = trimmed.match(
      /^(.*?)\s+Answer\s*[:.]\s*([A-H]|[ক-ঙ])(?:\s*\.?\s*)$/
    );
    if (fullAnsMatch) {
      return {
        cleanOptionText: fullAnsMatch[1].trim(),
        extractedAnswer: fullAnsMatch[2],
      };
    }
  }

  return { cleanOptionText: trimmed, extractedAnswer: null };
}

/**
 * Deterministically converts any raw/formatted exam paper text into a canonical
 * `OcrRefinedExamPaperJson` object (used both as a fallback and for instant JSON export).
 */
export function buildStructuredExamJsonFromText(
  content: string,
  fallbackTitle = 'Exam Paper'
): OcrRefinedExamPaperJson {
  const normalized = normalizeExamDocumentFormatting(content);
  const parsed = parseExamDocumentForDisplay(normalized);

  const header: OcrRefinedExamHeader = {
    institution: parsed.headerLines[0] ?? '',
    postName:
      parsed.headerLines.find((l) => /^পদের\s+নাম\s*:/i.test(l)) ??
      parsed.headerLines[1] ??
      '',
    metadata:
      parsed.headerLines.find((l) => /(?:তারিখ|সময়|সময়|পূর্ণমান)\s*:/i.test(l)) ??
      parsed.headerLines[2] ??
      '',
  };

  const questions: OcrRefinedExamQuestion[] = [];
  let current: OcrRefinedExamQuestion | null = null;
  let extractedInlineAnswersCount = 0;

  const finalizeCurrent = () => {
    if (!current) return;
    const combinedText = [
      current.questionText,
      ...current.options.map((o) => o.text),
      current.answer,
      ...current.solutionSteps,
    ].join(' ');
    current.hasMathLatex =
      current.hasMathLatex || LATEX_DETECTION_RE.test(combinedText);
    current.isHighlighted =
      current.isHighlighted || current.highlights.length > 0;
    questions.push(current);
    current = null;
  };

  for (const item of parsed.bodyItems) {
    if (item.kind === 'question') {
      finalizeCurrent();
      current = {
        numberLabel: item.numberLabel,
        questionText: cleanDeterministicMathSymbols(item.text),
        options: [],
        answer: '',
        answerLabel: 'Answer',
        solutionSteps: [],
        highlights: [],
        hasMathLatex: LATEX_DETECTION_RE.test(item.text),
        isHighlighted: false,
      };
      continue;
    }

    if (!current) continue;

    if (item.kind === 'option') {
      const { cleanOptionText, extractedAnswer } = detachInlineOptionAnswer(
        item.text
      );
      current.options.push({
        marker: item.marker,
        text: cleanDeterministicMathSymbols(cleanOptionText),
      });
      if (extractedAnswer && !current.answer) {
        current.answer = extractedAnswer;
        current.answerLabel = 'Answer';
        extractedInlineAnswersCount += 1;
      }
      continue;
    }

    if (item.kind === 'highlight') {
      current.highlights.push(item.text);
      current.isHighlighted = true;
      continue;
    }

    if (item.kind === 'explanation') {
      const cleanedExp = cleanDeterministicMathSymbols(item.text);
      if (cleanedExp) {
        current.solutionSteps.push(`ব্যাখ্যা: ${cleanedExp}`);
      }
      continue;
    }

    if (item.kind === 'solution') {
      const cleanedSol = cleanDeterministicMathSymbols(item.text);
      if (!current.answer) {
        current.answerLabel = item.label;
        current.answer = cleanedSol;
      } else if (cleanedSol) {
        current.solutionSteps.push(`${item.label}: ${cleanedSol}`);
      }
      continue;
    }

    if (item.kind === 'math') {
      current.solutionSteps.push(cleanDeterministicMathSymbols(item.text));
      continue;
    }

    if (item.kind === 'ai_badge') {
      current.highlights.push(item.text);
      continue;
    }

    if (item.kind === 'reference') {
      current.solutionSteps.push(`${item.label}: ${item.text}`);
      continue;
    }

    if (item.kind === 'diagram') {
      const diagLine = `[চিত্র: ${item.caption}]`;
      if (current.answer || current.solutionSteps.length > 0) {
        current.solutionSteps.push(diagLine);
      } else {
        current.questionText = `${current.questionText}\n${diagLine}`.trim();
      }
      continue;
    }

    if (item.kind === 'image') {
      const imgLine = `![${item.alt}](${item.src})`;
      if (current.answer || current.solutionSteps.length > 0) {
        current.solutionSteps.push(imgLine);
      } else {
        current.questionText = `${current.questionText}\n${imgLine}`.trim();
      }
      continue;
    }

    if (item.kind === 'table') {
      const serializedTable = serializeMarkdownTable({
        headers: item.headers,
        alignments: item.alignments,
        rows: item.rows,
      });
      if (current.answer || current.solutionSteps.length > 0) {
        current.solutionSteps.push(serializedTable);
      } else {
        current.questionText = `${current.questionText}\n${serializedTable}`.trim();
      }
      continue;
    }

    if (item.kind === 'text') {
      const cleaned = cleanDeterministicMathSymbols(item.text);
      if (current.answer || current.solutionSteps.length > 0) {
        current.solutionSteps.push(cleaned);
      } else {
        current.questionText = `${current.questionText} ${cleaned}`.trim();
      }
    }
  }

  finalizeCurrent();

  const mathLatexConvertedCount = questions.filter((q) => q.hasMathLatex).length;
  const preservedHighlightsCount = questions.filter((q) => q.isHighlighted).length;

  return {
    schemaVersion: '1.0',
    examTitle: header.institution || fallbackTitle,
    header,
    questions,
    refinementSummary: {
      totalQuestions: questions.length,
      mathLatexConvertedCount,
      extractedInlineAnswersCount,
      preservedHighlightsCount,
    },
  };
}

/**
 * Validates and sanitizes raw AI JSON output into a clean, guaranteed-valid
 * `OcrRefinedExamPaperJson` while enforcing:
 * - Preserved question numbering
 * - Trailing `ans. A` detached from options into `answer` below the question
 * - Zero fabricated answers when original question had no answer
 * - Preserved red-lined highlights
 */
export function sanitizeRefinedExamJson(
  raw: unknown,
  originalBaseline: OcrRefinedExamPaperJson
): OcrRefinedExamPaperJson {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const rawHeader = (
    obj.header && typeof obj.header === 'object' ? obj.header : {}
  ) as Record<string, unknown>;

  const header: OcrRefinedExamHeader = {
    institution:
      String(rawHeader.institution ?? '').trim() ||
      originalBaseline.header.institution,
    postName:
      String(rawHeader.postName ?? '').trim() ||
      originalBaseline.header.postName,
    metadata:
      String(rawHeader.metadata ?? '').trim() ||
      originalBaseline.header.metadata,
  };

  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  let extractedInlineAnswersCount = 0;

  const questions: OcrRefinedExamQuestion[] = rawQuestions
    .map((item, idx): OcrRefinedExamQuestion | null => {
      if (!item || typeof item !== 'object') return null;
      const q = item as Record<string, unknown>;
      const baselineQ = originalBaseline.questions[idx];

      const numberLabel =
        String(q.numberLabel ?? '').trim() ||
        baselineQ?.numberLabel ||
        `${idx + 1}.`;
      const questionText = cleanDeterministicMathSymbols(
        stripPromotionalBookAds(
          String(q.questionText ?? '').trim() || baselineQ?.questionText || ''
        ).cleaned.trim()
      );
      if (!questionText) return null;

      let answer = cleanDeterministicMathSymbols(
        stripPromotionalBookAds(String(q.answer ?? '').trim()).cleaned.trim()
      );
      let answerLabel = String(q.answerLabel ?? '').trim() || 'Answer';

      const rawOptions = Array.isArray(q.options) ? q.options : [];
      const options: OcrRefinedExamOption[] = rawOptions
        .map((opt): OcrRefinedExamOption | null => {
          if (!opt || typeof opt !== 'object') return null;
          const o = opt as Record<string, unknown>;
          const marker = String(o.marker ?? '').trim();
          const rawText = String(o.text ?? '').trim();
          if (!marker || !rawText) return null;
          const { cleanOptionText, extractedAnswer } =
            detachInlineOptionAnswer(rawText);
          if (extractedAnswer && !answer) {
            answer = extractedAnswer;
            answerLabel = 'Answer';
            extractedInlineAnswersCount += 1;
          }
          return {
            marker,
            text: cleanDeterministicMathSymbols(cleanOptionText),
          };
        })
        .filter((o): o is OcrRefinedExamOption => o !== null);

      const solutionSteps = (
        Array.isArray(q.solutionSteps) ? q.solutionSteps : []
      )
        .map((s) =>
          cleanDeterministicMathSymbols(
            stripPromotionalBookAds(String(s ?? '').trim()).cleaned.trim()
          )
        )
        .filter(Boolean);

      // STRICT NON-FABRICATION GUARD:
      // If the original exam paper had NO answer and NO solution steps for this question,
      // do NOT let the OCR Refiner invent one! (Missing answers belong to the grounded AI finder.)
      const baselineHadAnswer = Boolean(
        baselineQ &&
          (baselineQ.answer ||
            baselineQ.solutionSteps.length > 0 ||
            baselineQ.options.some((o) => /=/.test(o.text)))
      );
      if (baselineQ && !baselineHadAnswer) {
        answer = '';
        solutionSteps.length = 0;
      }

      const highlights = (Array.isArray(q.highlights) ? q.highlights : [])
        .map((h) => String(h ?? '').trim())
        .filter(Boolean);

      // Merge any baseline highlights so red-lined highlights are never dropped
      if (baselineQ?.highlights?.length) {
        for (const bh of baselineQ.highlights) {
          if (!highlights.includes(bh)) {
            highlights.push(bh);
          }
        }
      }

      const combined = [
        questionText,
        ...options.map((o) => o.text),
        answer,
        ...solutionSteps,
      ].join(' ');
      const hasMathLatex =
        Boolean(q.hasMathLatex) || LATEX_DETECTION_RE.test(combined);
      const isHighlighted =
        Boolean(q.isHighlighted) || highlights.length > 0;

      // Normalize `Ans` -> `Answer`
      if (answerLabel.toLowerCase() === 'ans') {
        answerLabel = 'Answer';
      }

      return {
        numberLabel,
        questionText,
        options,
        answer,
        answerLabel,
        solutionSteps,
        highlights,
        hasMathLatex,
        isHighlighted,
      };
    })
    .filter((q): q is OcrRefinedExamQuestion => q !== null);

  const finalQuestions =
    questions.length > 0 ? questions : originalBaseline.questions;

  return {
    schemaVersion: '1.0',
    examTitle:
      String(obj.examTitle ?? '').trim() ||
      header.institution ||
      originalBaseline.examTitle,
    header,
    questions: finalQuestions,
    refinementSummary: {
      totalQuestions: finalQuestions.length,
      mathLatexConvertedCount: finalQuestions.filter((q) => q.hasMathLatex)
        .length,
      extractedInlineAnswersCount:
        extractedInlineAnswersCount +
        originalBaseline.refinementSummary.extractedInlineAnswersCount,
      preservedHighlightsCount: finalQuestions.filter((q) => q.isHighlighted)
        .length,
    },
  };
}

/**
 * Serializes a structured `OcrRefinedExamPaperJson` back into canonical formatted
 * exam text so Smart Reader & Question Lab render:
 * - Preserved numbering
 * - LaTeX math rendered as stacked fractions/roots/exponents
 * - Every `Answer:` / `সমাধান:` cleanly placed BELOW the question/options (rendered BOLD)
 * - Every red-lined highlight preserved as `[হাইলাইট: ...]`
 */
export function serializeRefinedExamPaperToText(
  paper: OcrRefinedExamPaperJson
): string {
  const lines: string[] = [];

  const headerLines = [
    paper.header.institution,
    paper.header.postName,
    paper.header.metadata,
  ]
    .map((h) => h.trim())
    .filter(Boolean);

  if (headerLines.length > 0) {
    lines.push(...headerLines);
    lines.push('');
  }

  for (const q of paper.questions) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }

    lines.push(`${q.numberLabel} ${q.questionText}`);

    for (const opt of q.options) {
      lines.push(`    ${opt.marker} ${opt.text}`);
    }

    // Always place Answer / Solution cleanly BELOW the question & options
    if (q.answer) {
      const label = q.answerLabel || 'Answer';
      lines.push(`${label}: ${q.answer}`);
    }

    for (const step of q.solutionSteps) {
      if (
        /^\[AI দ্বারা তৈরি উত্তর\]/i.test(step) ||
        /^(?:রেফারেন্স|Reference|উত্তর|সমাধান|ব্যাখ্যা|Solution|Answer)\s*:/i.test(step)
      ) {
        lines.push(step);
      } else {
        lines.push(`    ${step}`);
      }
    }

    // Preserve red-lined highlights
    for (const h of q.highlights) {
      if (!/^AI দ্বারা তৈরি উত্তর/i.test(h)) {
        lines.push(`[হাইলাইট: ${h}]`);
      }
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * OCR Refiner Agent Function:
 * Converts detected exam OCR text into strict JSON (`OcrRefinedExamPaperJson`):
 * 1. Converts all mathematical expressions, broken fractions, roots, and exponents into LaTeX (`\frac{num}{den}`, `\sqrt{...}`, `x^{4}`).
 * 2. Enforces structured JSON output preserving exact question numbering (`12.`, `১৬.`, `০১।`) and red-lined highlights.
 * 3. Extracts inline MCQ answers (e.g. `d) ওষ্ঠ ans. A`) onto a dedicated `answer` field rendered BELOW the question in BOLD.
 * 4. Strictly preserves existing book answers and NEVER invents answers for unanswered questions.
 */
export async function refineExamPaperWithAgent(
  input: RefineExamPaperInput
): Promise<RefineExamPaperResult> {
  const rawContent = stripPromotionalBookAds((input.rawContent ?? '').trim()).cleaned.trim();
  const baseline = buildStructuredExamJsonFromText(
    rawContent,
    input.examTitle || input.bookTitle || 'Exam Paper'
  );

  if (!rawContent || baseline.questions.length === 0) {
    return {
      refinedJson: baseline,
      formattedContent: normalizeExamDocumentFormatting(rawContent),
      usedAi: false,
    };
  }

  const highlightContext =
    input.highlightHints && input.highlightHints.length > 0
      ? `\nRED-LINED / CRITICAL HIGHLIGHTS TO PRESERVE:\n${input.highlightHints.map((h) => `- ${h}`).join('\n')}\n`
      : '';

  const needsMathRepairHint = hasCorruptedMathOcr(rawContent)
    ? '\nALERT: Corrupted OCR math / shattered fractions detected in this exam paper. Carefully reconstruct every equation and fraction in valid LaTeX (\\frac{numerator}{denominator}) matching the printed answer.'
    : '';

  const prompt = `You are the "OCR Refiner" Agent for Bangladeshi competitive exam papers (BCS, Bank, Govt Jobs).

Transform the OCR exam text below into STRICT structured JSON matching the response schema.

MANDATORY RULES:
1. MATHEMATICAL NOTATION -> LATEX (DOUBLE-ESCAPED IN JSON):
   - Convert ALL mathematical fractions (including broken "rac{4}{5}" fragments!) into valid LaTeX: \\frac{numerator}{denominator} (e.g., cosA = \\frac{4}{5}, cosB = \\frac{5}{13}, \\frac{3x+7}{4}, \\frac{১০}{১০০}, \\frac{x}{y} = \\frac{১৩}{১২}, 3\\frac{1}{2}). Always double-escape backslashes inside JSON strings ("\\\\frac{4}{5}", "\\\\times", "\\\\theta") so JSON parsing never corrupts "\\f" or "\\t".
   - Convert ALL square roots into \\sqrt{...}, exponents into x^{4} / y^{2}, subscripts into a_{1}, and operators into \\times, \\div, \\therefore, \\Rightarrow (or clean ∴, ⇒, ×, ÷).
   - Fix garbled OCR math typos (e.g., rac{4}{5} -> \\frac{4}{5}, x°( -> x^{4}(, ... গ.সা.গু -> ∴ গ.সা.গু, == -> =, shattered numerators/denominators) while keeping mathematical derivation steps accurate in "solutionSteps".
2. PRESERVE EXACT NUMBERING:
   - Keep every question's exact printed numberLabel ("12.", "13.", "১৬.", "০১।", etc.) in order. NEVER renumber, drop, or merge questions.
3. EXTRACT MARGIN & INLINE MCQ ANSWERS BELOW OPTIONS + PRESERVE MCQ EXPLANATIONS AS "ব্যাখ্যা:":
   - If an MCQ option has a side/margin/inline answer like "d) ওষ্ঠ ans. A", "b) সফট লোন ans. B", "ঘ. কারও স্বাক্ষর থাকে না উ. খ", or "ঘ. হযরত খান জাহান আলী রহ. উত্তর: গ", REMOVE the answer key from the option text and place ONLY the option key ("A", "B", "খ", "গ") in the question's "answer" field (with answerLabel: "Answer" for A-D or "উত্তর" for ক-ঘ).
   - If an MCQ question has an explanatory box printed under "Solution:" or "Explanation:" (e.g. "Solution: IDA হলো বিশ্বব্যাংকের একটি অঙ্গসংস্থা..."), DO NOT treat it as the MCQ answer and DO NOT drop it — keep it inside "solutionSteps" prefixed with "ব্যাখ্যা: " (e.g. "ব্যাখ্যা: IDA হলো বিশ্বব্যাংকের একটি অঙ্গসংস্থা..."). NEVER label MCQ explanations as "Solution:" or "Explanation:".
   - NEVER fabricate or invent an answer if the original OCR text has NO answer for that question—leave "answer": "" and "solutionSteps": [].
4. PRESERVE RED-LINED HIGHLIGHTS & DIAGRAMS:
   - Preserve any explicit highlight tags ([হাইলাইট: ...]), marked errors, or red-lined review notes inside "highlights" and set "isHighlighted": true.
   - Preserve any "[চিত্র: ...]" visual diagram callouts or "![...](data:image/...)" figures intact inside "questionText" or "solutionSteps" — NEVER strip them!
5. REMOVE PUBLISHER ADVERTISEMENTS, RUNNING HEADERS & BOOK PAGE CROSS-REFERENCES (NOT ANSWERS):
   - Completely omit any book release announcements, boxed promo notices, or library availability notices (e.g. "সাম্প্রতিক সাধারণ জ্ঞানের অসাধারণ নির্যাস 'ক্রিম' লাইব্রেরিতে পাওয়া যাচ্ছে।", "জুলাই, ২০২৩ থেকে জানুয়ারি, ২০২৪ ... বইটি আগামী সপ্তাহ থেকে লাইব্রেরিতে পাওয়া যাবে।", "শতভাগ কমনের জন্য পড়ুন ..."), and standalone publisher running headers/footers (e.g. "অগ্রদূত Recent Job Solution", "অগ্রদূত রিসেন্ট লিখিত জব সলিউশন").
   - Completely omit publisher guide-book cross-reference notes and page citations — NEVER treat them as answers or explanations (e.g. "পৃষ্ঠা: ৫৮ (ক্রিম; জানুয়ারি- ২০২৫)", "পৃষ্ঠা: ৫২ (ক্রিম; জানুয়ারি- ২০২৫)", "পৃষ্ঠা: ৩৪৭ (অগ্রদূত আন্তর্জাতিক বিষয়াবলি; ৮ম সংস্করণ)", "পৃষ্ঠা: ২৬৪ (অগ্রদূত বিজ্ঞান; ২য় সংস্করণ)", "[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫০", "পৃষ্ঠা: ৬৬২ এর ৯৪৬ নম্বর (অগ্রদূত Basic Math, 2nd Edition, January-2024)").
6. CLEAN BENGALI & ENGLISH SPELLING, TABLES & RICH EMPHASIS (CRITICAL):
   - Carefully correct obvious OCR spelling errors in Bengali (যুক্তবর্ণ, ি/ী, ু/ূ, ড়/ঢ়/য়, শ/ষ/স, ন/ণ, watermark-garbled table words like "ব্যঞ্জনবর্ণ", "স্বরবর্ণ", "খুঁটিনাটি") and English words (e.g., "I thoughout" -> "Throughout", "moents" -> "moments", "paggage" -> "passage") while keeping original meaning untouched without summarizing.
   - PRESERVE all Markdown tables and 3×3 number grids as contiguous newline-separated rows (| ৮ | ১ | ৬ |\n| --- | --- | --- |\n| ৩ | ? | ৭ |\n| ৪ | ৯ | ২ |) inside questionText or solutionSteps — NEVER flatten multiple table rows onto one line (no "||"), NEVER add blank lines between table rows, and keep table rows separate from question stems or "ব্যাখ্যা:" prose.
   - PRESERVE all inline rich-text emphasis markers (**bold**, *italic*, <u>underlined</u>) intact — NEVER strip <u>...</u>, **...**, or *...* formatting. If a grammar question explicitly asks about an "underlined part/word/clause" or "নিম্নরেখ/রেখাঙ্কিত শব্দ" and the <u>...</u> tag was dropped during OCR, restore <u>...</u> around the exact target word/phrase when unambiguously identified by the question and explanation.
${highlightContext}${needsMathRepairHint}

EXAM TITLE: ${input.examTitle || input.bookTitle || baseline.examTitle}

RAW OCR EXAM TEXT:
${rawContent}`;

  const client = input.client ?? (getGeminiClient() as unknown as OcrRefinerGeminiClient);

  const response = input.client
    ? await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: OCR_REFINER_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          systemInstruction:
            'You are the OCR Refiner agent. Always return valid JSON strictly matching the schema. Fix Bengali/English OCR typos, convert all mathematical notation into clean LaTeX, preserve Markdown tables and inline **bold**/*italic*/<u>underline</u> formatting, separate inline MCQ answers (ans. A) into the answer field below options, preserve exact question numbering and red-lined highlights, and NEVER fabricate missing answers.',
        },
      })
    : await generateWithRetry(
        {
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: OCR_REFINER_RESPONSE_SCHEMA,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            systemInstruction:
              'You are the OCR Refiner agent. Always return valid JSON strictly matching the schema. Fix Bengali/English OCR typos, convert all mathematical notation into clean LaTeX, preserve Markdown tables and inline **bold**/*italic*/<u>underline</u> formatting, separate inline MCQ answers (ans. A) into the answer field below options, preserve exact question numbering and red-lined highlights, and NEVER fabricate missing answers.',
          },
        },
        {
          timeoutMs: DEFAULT_AI_TIMEOUT_MS,
          signal: input.signal,
        }
      );

  const parsedJson = parseAiJson<Record<string, unknown>>(response.text ?? '');
  const refinedJson = sanitizeRefinedExamJson(parsedJson, baseline);
  const formattedContent = serializeRefinedExamPaperToText(refinedJson);

  return {
    refinedJson,
    formattedContent,
    usedAi: true,
  };
}
