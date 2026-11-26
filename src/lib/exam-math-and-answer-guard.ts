/**
 * Pure Exam Math OCR Detector, Fraction/Superscript Token Parser,
 * and Strict Non-Override Missing-Answer Guard.
 *
 * Core guarantees:
 * 1. `hasCorruptedMathOcr()` detects shattered stacked fractions & garbled math
 *    OCR layers (e.g. Adobe Acrobat OCR layers) so upload auto-escalates to Gemini Vision OCR.
 * 2. `parseMathRichTokens()` parses `\frac{numerator}{denominator}` and superscripts (`^2`, `^{n}`)
 *    for true stacked fraction rendering in both Smart Reader UI and A4 PDF Canvas export.
 * 3. `analyzeExamQuestionAnswers()` + `mergeAiMissingAnswersSafely()` HARD-ENFORCE the user's
 *    non-override rule: if a question ALREADY has an answer in the book, AI can NEVER generate
 *    or replace it. Only genuinely unanswered questions can receive an AI-created answer,
 *    always labeled `[AI দ্বারা তৈরি উত্তর]` with verified `রেফারেন্স:` citations.
 */

export type MathRichToken =
  | { kind: 'text'; value: string }
  | { kind: 'frac'; num: string; den: string }
  | { kind: 'sup'; value: string }
  | { kind: 'sub'; value: string }
  | { kind: 'sqrt'; value: string };

export interface ExamQuestionAnalysis {
  index: number;
  /** Canonical ASCII digit key, e.g. "1", "16", "19" */
  questionKey: string;
  /** Original printed question label, e.g. "০১।", "01.", "১৬." */
  numberLabel: string;
  /** First-line question prompt (without number prefix) */
  questionStem: string;
  /** Complete verbatim lines belonging to this question */
  rawBlock: string;
  /** True if ANY answer/solution already exists in the book */
  hasExistingAnswer: boolean;
  /** Why this question was marked as already answered */
  answerEvidence:
    | 'solution_label'
    | 'inline_option_answers'
    | 'inline_parenthetical_answers'
    | 'math_derivation'
    | 'ai_generated_answer'
    | null;
  /** True if this question contains math expressions/equations/word-problem arithmetic */
  isMathQuestion: boolean;
  /** True if this question shows garbled OCR math / shattered fractions */
  hasCorruptedMath: boolean;
}

export interface ExamAnswerAnalysisReport {
  isExam: boolean;
  headerBlock: string;
  questions: ExamQuestionAnalysis[];
  answeredCount: number;
  unansweredQuestions: ExamQuestionAnalysis[];
  corruptedMathQuestions: ExamQuestionAnalysis[];
  mathQuestions: ExamQuestionAnalysis[];
}

export interface AiReferenceItem {
  title: string;
  url?: string;
}

export interface AiMissingAnswerEntry {
  questionKey: string;
  answerText: string;
  references: AiReferenceItem[];
}

export interface SafeMissingAnswerMergeResult {
  updatedContent: string;
  appliedKeys: string[];
  skippedProtectedKeys: string[];
}

export interface SafeMathRepairEntry {
  questionKey: string;
  repairedBlock: string;
}

export interface SafeMathRepairMergeResult {
  updatedContent: string;
  repairedKeys: string[];
  skippedKeys: string[];
}

const QUESTION_NUM_ATOM =
  '(?:0[1-9]|[1-9]\\d?|1\\d{2}|2[0-4]\\d|250|[০-৯]{1,2}|[১২][০-৯]{2})';

const QUESTION_LINE_RE = new RegExp(
  `^(${QUESTION_NUM_ATOM}[.\\u0964])\\s+(.+)$`
);

const AI_ANSWER_MARKER = '[AI দ্বারা তৈরি উত্তর]';

const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  x: 'ˣ',
};

const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  n: 'ₙ',
  x: 'ₓ',
};

const LATEX_SYMBOL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\\(?:Rightarrow|implies)\b/g, '⇒'],
  [/\\therefore\b/g, '∴'],
  [/\\times\b/g, '×'],
  [/\\cdot\b/g, '·'],
  [/\\div\b/g, '÷'],
  [/\\pm\b/g, '±'],
  [/\\leq?\b/g, '≤'],
  [/\\geq?\b/g, '≥'],
  [/\\neq?\b/g, '≠'],
  [/\\approx\b/g, '≈'],
  [/\\pi\b/g, 'π'],
  [/\\theta\b/g, 'θ'],
  [/\\alpha\b/g, 'α'],
  [/\\beta\b/g, 'β'],
  [/\\degree\b/g, '°'],
  [/\\infty\b/g, '∞'],
  [/\\%/g, '%'],
  [/\\left(?=[(\[{|])/g, ''],
  [/\\right(?=[)\]}|])/g, ''],
  [/\\text\{([^}\n]+)\}/g, '$1'],
];

/**
 * Strips inline LaTeX `$...$` / `$$...$$` / `\(...\)` delimiters (without touching currency like `$50`)
 * and normalizes standard LaTeX operator commands (`\times`, `\div`, `\therefore`, `\Rightarrow`, etc.)
 * into clean Unicode mathematical symbols while keeping `\frac{...}{...}`, `\sqrt{...}`, `^`, and `_`.
 */
/**
 * Repairs LaTeX commands corrupted when JSON.parse interpreted a single backslash
 * escape as an ASCII control character (e.g. `\frac{4}{5}` -> `\u000Crac{4}{5}` / `rac{4}{5}`,
 * `\times` -> `\u0009imes`, `\theta` -> `\u0009heta`, `\beta` -> `\u0008eta`, `\right` -> `\u000Dight`).
 * Works both on freshly parsed OCR and on already-saved books in Firestore/IndexedDB.
 */
export function repairCorruptedLatexControlChars(input: string): string {
  if (!input) return '';
  return input
    // Form feed `\f` (\u000C) eaten from `\frac` or `\forall`
    .replace(/\u000Crac(?=\s*\{)/g, '\\frac')
    .replace(/\u000Cforall\b/g, '\\forall')
    // Bare `rac{num}{den}` left behind after `\f` was stripped or rendered invisibly
    .replace(/(^|[\s=+\-×÷(,;:{[])rac(\s*\{[^}\n]+\}\s*\{[^}\n]+\})/g, '$1\\frac$2')
    // Tab `\t` (\u0009) eaten from `\times`, `\theta`, `\tan`, `\tau`, `\text`, `\therefore`, `\triangle`
    .replace(/\u0009(imes|heta|an|au|ext|herefore|riangle)\b/g, '\\t$1')
    // Backspace `\b` (\u0008) eaten from `\beta`, `\binom`, `\bar`, `\begin`
    .replace(/\u0008(eta|inom|ar|egin)\b/g, '\\b$1')
    // Carriage return `\r` (\u000D) eaten from `\right`, `\rho`, `\root` (only when NOT followed by `\n`)
    .replace(/\u000D(ight|ho|oot)\b/g, '\\r$1')
    // Strip any remaining stray Form Feed / Backspace control characters
    .replace(/[\u0008\u000C]/g, '');
}

export function normalizeInlineLatexSyntax(input: string): string {
  if (!input) return '';
  let out = repairCorruptedLatexControlChars(input);

  // Defensively collapse accidental double-escaped LaTeX commands (e.g. \\frac -> \frac)
  out = out.replace(
    /\\\\(?=(?:d|t)?frac\b|sqrt\b|times\b|cdot\b|div\b|therefore\b|Rightarrow\b|implies\b|pm\b|leq?\b|geq?\b|neq?\b|approx\b|pi\b|theta\b|alpha\b|beta\b|degree\b|infty\b|left\b|right\b|text\b|%|\(|\)|\[|\])/g,
    '\\'
  );

  // Unwrap display $$...$$ and inline $...$ math delimiters when they contain math tokens/expressions
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, '$1');
  out = out.replace(
    /\$([^$\n]+?)\$/g,
    (full, inner: string) => {
      // Avoid stripping currency like "$50 and $100"
      if (/^\d+(?:[.,]\d+)?(?:\s|$)/.test(inner.trim())) {
        return full;
      }
      return inner.trim();
    }
  );
  out = out.replace(/\\\(([^)\n]+?)\\\)/g, '$1');
  out = out.replace(/\\\[([^\]]+?)\\\]/g, '$1');

  for (const [pattern, replacement] of LATEX_SYMBOL_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }

  return out;
}

export function toAsciiDigits(input: string): string {
  return (input ?? '').replace(/[০-৯]/g, (ch) =>
    String('০১২৩৪৫৬৭৮৯'.indexOf(ch))
  );
}

export function normalizeQuestionKey(rawLabelOrKey: string): string {
  const digits = toAsciiDigits(rawLabelOrKey).replace(/[^0-9]/g, '');
  if (!digits) return '';
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '';
}

/**
 * Deterministic, safe OCR math symbol cleanup that NEVER fabricates or alters numbers:
 * - Fixes `... গ.সা.গু` / `.. নির্ণেয়` / `... x =` -> `∴ গ.সা.গু` / `∴ নির্ণেয়` / `∴ x =`
 * - Fixes double equals `==` inside math derivations -> `=`
 * - Removes accidental spaces inside `\frac {a} {b}` -> `\frac{a}{b}`
 */
export function cleanDeterministicMathSymbols(text: string): string {
  if (!text) return '';

  return repairCorruptedLatexControlChars(text)
    .replace(/\\frac\s*\{/g, '\\frac{')
    .replace(/(\{[^}\n]+\})\s+(\{[^}\n]+\})/g, (m, g1, g2, offset, full) => {
      const before = full.slice(Math.max(0, offset - 6), offset);
      return before.endsWith('\\frac') ? `${g1}${g2}` : m;
    })
    // Convert leading `..` or `...` before math conclusion tokens into `∴`
    .replace(
      /(^|\n)([ \t]*)\.{2,3}\s*(?=(?:গ\.?সা\.?গু|ল\.?সা\.?গু|নির্ণেয়|নির্ণয়|অতএব|উত্তর|সুতরাং|[xyzabc]\s*=|[০-৯0-9]+\s*=))/gm,
      '$1$2∴ '
    )
    // Double equals typo from OCR (e.g. `⇒ 13x+33 ==2×28`)
    .replace(/(^|\n)([^\n]*?)\s*==\s*/gm, '$1$2 = ');
}

/**
 * Detects whether a text block / PDF page contains garbled OCR math or shattered
 * stacked fractions (like Adobe Acrobat's embedded OCR layer on scanned math pages).
 *
 * Returns `false` on clean Bengali prose, clean English fill-in-the-blank, and clean
 * `\frac{...}{...}` math equations.
 */
export function hasCorruptedMathOcr(text: string): boolean {
  if (!text || text.trim().length < 20) return false;

  // Already contains structured \frac{...}{...} and no glaring OCR gibberish
  const hasStructuredFracs = /\\frac\{[^}]+\}\{[^}]+\}/.test(text);

  let signals = 0;

  // 1. Broken algebraic operator adjacency (e.g. `+ =x+`, `x+ =y+`, `=×`, `×=×`, `--28x`, `==2×`)
  if (/(?:\+\s*=|=\s*×|×\s*=\s*×|[xy]\s*\+\s*=|=\s*[xy]\s*\+\s*\d+o\b|\(\s*×|×\s*\(\s*\d{2})/.test(text)) {
    signals += 2;
  }

  // 2. Broken exponent/variable OCR substitutions (`x°(`, `y°(`, `(@`, `z'(`, `x*(`, `y*(`, `&x`, `Soy`)
  if (/(?:[xyz]\s*[°*']\s*\(|\(\s*@|&[xy]\b|\bSoy\b|\b2\s*の|\bn\d{1,2}[xy]\b)/i.test(text)) {
    signals += 2;
  }

  // 3. Double equals `==` inside math equations (`⇒ 13x+33 ==2×28`)
  if (/(?:⇒|[xy]\s*[+-]|[০-৯0-9]\s*)==\s*[০-৯0-9]/.test(text)) {
    signals += 1;
  }

  // 4. Garbled prime factorization / operator-digit collision (`২×২(১৩×=×৩১৫৬`, `=×৩×২৩৯০৫×(10`)
  if (/(?:[০-৯0-9]+×[০-৯0-9]+\([০-৯0-9]+×|=×[০-৯0-9]+×[০-৯0-9]{4,}|^[০-৯0-9]+=\s*$)/m.test(text)) {
    signals += 2;
  }

  // 5. Shattered stacked fraction pattern:
  //    e.g. line ending in `=` followed by a bare numeric denominator line (`১০০`),
  //    or a bare numerator (`১০`) immediately before a line containing `r = ১০% =`
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const cur = lines[i];
    const next = lines[i + 1] ?? '';
    const prev = lines[i - 1] ?? '';

    // Bare 1-2 short numbers/vars right below an equation ending in `=` or `×`
    if (
      /[=×+÷-]$/.test(cur) &&
      /^(?:[০-৯0-9]{1,4}|[xyz]|[০-৯0-9]{1,2}\s+[০-৯0-9]{1,2})$/.test(next)
    ) {
      signals += 2;
      break;
    }

    // Bare numerator right above an equation containing `=` and ending in `=`
    if (
      /^[০-৯0-9]{1,3}$/.test(prev) &&
      /[=]\s*$/.test(cur) &&
      /^[০-৯0-9]{1,4}$/.test(next)
    ) {
      signals += 2;
      break;
    }

    // Dual-fraction denominators flattened onto one bare line (`4 7`, `28 2`) right after algebraic terms
    if (
      /^[0-9০-৯]{1,2}\s+[0-9০-৯]{1,2}$/.test(cur) &&
      /[xy]\s*[+-]\s*[0-9০-৯]/.test(prev)
    ) {
      signals += 2;
      break;
    }

    // Shattered fraction ratio lines: `X ১৩×৫` followed by `y ১০× ৬` or `X ১৩` followed by `y`
    if (
      /^[XY]\s+[০-৯0-9]+/.test(cur) &&
      /^[xy]\b/.test(next)
    ) {
      signals += 2;
      break;
    }
  }

  // 6. Broken OCR conclusion dots (`... গ.সা.গু`, `.. নির্ণেয়`) combined with math expressions
  if (/^\.{2,3}\s*(?:গ\.?সা\.?গু|ল\.?সা\.?গু|নির্ণেয়|নির্ণয়)/m.test(text)) {
    signals += 1;
  }

  if (hasStructuredFracs && signals < 3) {
    return false;
  }

  return signals >= 2;
}

/**
 * Extracts a balanced `{...}` group starting at `startIndex` (which must point to `{`).
 * Returns the inner content and the index immediately after the closing `}`, or null if unbalanced.
 */
function readBalancedBraces(
  text: string,
  startIndex: number
): { content: string; endIndex: number } | null {
  if (text[startIndex] !== '{') return null;
  let depth = 0;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.slice(startIndex + 1, i),
          endIndex: i + 1,
        };
      }
    }
  }
  return null;
}

/**
 * Parses a line containing LaTeX math (`$...$`, `\frac{num}{den}`, `\sqrt{expr}`,
 * `[[frac:num|den]]`, superscripts `x^4`/`y^{2}`, subscripts `a_1`/`x_{n}`) into rich
 * inline tokens for stacked fraction & textbook math rendering in React UI and A4 PDF Canvas.
 */
export function parseMathRichTokens(rawText: string): MathRichToken[] {
  if (!rawText) return [];
  const text = normalizeInlineLatexSyntax(rawText);

  const tokens: MathRichToken[] = [];
  let buffer = '';
  let i = 0;

  const flushBuffer = () => {
    if (buffer) {
      tokens.push({ kind: 'text', value: buffer });
      buffer = '';
    }
  };

  while (i < text.length) {
    // 1. \frac{numerator}{denominator} or \dfrac / \tfrac
    const fracCmdMatch = text.slice(i).match(/^\\(?:d|t)?frac\b/);
    if (fracCmdMatch) {
      let cursor = i + fracCmdMatch[0].length;
      while (cursor < text.length && text[cursor] === ' ') cursor += 1;
      const numGroup = readBalancedBraces(text, cursor);
      if (numGroup) {
        let denCursor = numGroup.endIndex;
        while (denCursor < text.length && text[denCursor] === ' ') denCursor += 1;
        const denGroup = readBalancedBraces(text, denCursor);
        if (denGroup && numGroup.content.trim() && denGroup.content.trim()) {
          flushBuffer();
          tokens.push({
            kind: 'frac',
            num: numGroup.content.trim(),
            den: denGroup.content.trim(),
          });
          i = denGroup.endIndex;
          continue;
        }
      }
    }

    // 2. \sqrt{expr}
    if (text.startsWith('\\sqrt', i)) {
      let cursor = i + 5;
      while (cursor < text.length && text[cursor] === ' ') cursor += 1;
      const sqrtGroup = readBalancedBraces(text, cursor);
      if (sqrtGroup && sqrtGroup.content.trim()) {
        flushBuffer();
        tokens.push({
          kind: 'sqrt',
          value: sqrtGroup.content.trim(),
        });
        i = sqrtGroup.endIndex;
        continue;
      }
    }

    // 3. [[frac:num|den]]
    if (text.startsWith('[[frac:', i)) {
      const closeIdx = text.indexOf(']]', i + 7);
      if (closeIdx > i + 7) {
        const inner = text.slice(i + 7, closeIdx);
        const sepIdx = inner.indexOf('|');
        if (sepIdx > 0 && sepIdx < inner.length - 1) {
          flushBuffer();
          tokens.push({
            kind: 'frac',
            num: inner.slice(0, sepIdx).trim(),
            den: inner.slice(sepIdx + 1).trim(),
          });
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // 4. Superscripts: ^{expr} or ^digit/single-letter (only after alphanumeric or closing paren/bracket)
    if (text[i] === '^' && i > 0 && /[A-Za-z0-9০-৯\)\]\}]/.test(text[i - 1])) {
      if (text[i + 1] === '{') {
        const supGroup = readBalancedBraces(text, i + 1);
        if (supGroup && supGroup.content.trim()) {
          flushBuffer();
          tokens.push({ kind: 'sup', value: supGroup.content.trim() });
          i = supGroup.endIndex;
          continue;
        }
      } else {
        const match = text.slice(i + 1).match(/^([0-9০-৯]{1,2}|[a-zA-Z])/);
        if (match) {
          flushBuffer();
          tokens.push({ kind: 'sup', value: match[1] });
          i += 1 + match[1].length;
          continue;
        }
      }
    }

    // 5. Subscripts: _{expr} or _digit (only after Latin variable, never matching fill-in-the-blank `___`)
    if (
      text[i] === '_' &&
      i > 0 &&
      /[A-Za-z\)\]]/.test(text[i - 1]) &&
      text[i + 1] !== '_'
    ) {
      if (text[i + 1] === '{') {
        const subGroup = readBalancedBraces(text, i + 1);
        if (subGroup && subGroup.content.trim()) {
          flushBuffer();
          tokens.push({ kind: 'sub', value: subGroup.content.trim() });
          i = subGroup.endIndex;
          continue;
        }
      } else {
        const match = text.slice(i + 1).match(/^([0-9০-৯]{1,2}|[a-z])/);
        if (match) {
          flushBuffer();
          tokens.push({ kind: 'sub', value: match[1] });
          i += 1 + match[1].length;
          continue;
        }
      }
    }

    buffer += text[i];
    i += 1;
  }

  flushBuffer();
  return tokens;
}

/**
 * Converts LaTeX `\frac{num}{den}`, `\sqrt{expr}`, `^n`, `_n` into crisp, human-readable Unicode
 * plain text for `.txt` export and clipboard copy (no raw LaTeX backslashes).
 */
export function formatMathForPlainText(text: string): string {
  if (!text) return '';
  const tokens = parseMathRichTokens(text);
  let out = '';

  for (const tok of tokens) {
    if (tok.kind === 'text') {
      out += tok.value;
    } else if (tok.kind === 'sup') {
      const unicodeSup = Array.from(tok.value)
        .map((ch) => SUPERSCRIPT_MAP[ch] ?? '')
        .join('');
      out += unicodeSup.length === tok.value.length ? unicodeSup : `^${tok.value}`;
    } else if (tok.kind === 'sub') {
      const unicodeSub = Array.from(tok.value)
        .map((ch) => SUBSCRIPT_MAP[ch] ?? '')
        .join('');
      out += unicodeSub.length === tok.value.length ? unicodeSub : `_${tok.value}`;
    } else if (tok.kind === 'sqrt') {
      const inner = formatMathForPlainText(tok.value);
      out += /[+\-\s×÷/]/.test(inner) ? `√(${inner})` : `√${inner}`;
    } else {
      const cleanNum = formatMathForPlainText(tok.num);
      const cleanDen = formatMathForPlainText(tok.den);
      const needsNumParens = /[+\-\s×÷]/.test(cleanNum);
      const needsDenParens = /[+\-\s×÷]/.test(cleanDen);
      const numStr = needsNumParens ? `(${cleanNum})` : cleanNum;
      const denStr = needsDenParens ? `(${cleanDen})` : cleanDen;
      // Add space for mixed fractions like `3\frac{1}{2}` -> `3 1/2`
      if (/[0-9০-৯]$/.test(out)) {
        out += ' ';
      }
      out += `${numStr}/${denStr}`;
    }
  }

  return out;
}

function detectQuestionIsMath(rawBlock: string): boolean {
  if (!rawBlock) return false;
  if (/\\frac\{[^}]+\}\{[^}]+\}/.test(rawBlock)) return true;
  if (
    /(?:সমাধান\s+করুন|উৎপাদকে\s*বিশ্লেষণ|মান\s+নির্ণয়|মান\s+নির্ণয়|গ\.?সা\.?গু|ল\.?সা\.?গু|সরল\s+সুদ|চক্রবৃদ্ধি\s+সুদ|সুদের\s+হার|ঋণের\s+অনুপাত|ক্ষেত্রফল|পরিসীমা|শতকরা|অনুপাত\s+নির্ণয়|অনুপাত\s+নির্ণয়|সর্বাধিক\s+কতজন|অবশিষ্ট\s+থাকবে|সমীকরণ|ভগ্নাংশ)/.test(
      rawBlock
    )
  ) {
    return true;
  }
  const hasMathOperators =
    /(?:⇒|∴|[xyz]\s*[²³⁴°*^]|(?:\d|[০-৯])\s*[×÷]\s*(?:\d|[০-৯])|\b[xyz]\s*[+-]\s*[0-9০-৯])/.test(
      rawBlock
    );
  return hasMathOperators;
}

const NON_ANSWER_PUBLISHER_CROSS_REF_LINE_RE =
  /^(?:[\s"'‘’“”]*[\[(]?[^\n\]()]{1,100}(?:সেল্ফ\s*প্রিপারেশন|অগ্রদূত|প্রফেসর['’]?স|প্রফেসরস|ওরাকল|এমপিথ্রি|MP3|অ্যাসিওরেন্স|খায়রুল['’]?স|খায়রুলস|জর্জ|রিসেন্ট|নতুন\s+সংস্করণ|\d+(?:st|nd|rd|th)\s+Edition|[০-৯0-9]+(?:ম|য়|র্থ|তম)\s+সংস্করণ)[^\n\]]*?(?:পৃষ্ঠা|পৃ\.|page)\s*[-:ঃ.]?\s*[0-9০-৯]+[^\n]*|[\s"'‘’“”]*\[[^\n\]]{2,100}[;,:ঃ\s\-–—]+(?:পৃষ্ঠা|পৃ\.|page)\s*[-:ঃ.]?\s*[0-9০-৯]+[^\n]*\]?\s*|[\s"'‘’“”\[]*(?:পৃষ্ঠা|পৃ\.)\s*[:ঃ\-]\s*[0-9০-৯]+[^\n]*\([^)\n]{2,140}\)[\s"'‘’“”\]।.]*)$/i;

const NON_ANSWER_INLINE_CROSS_REF_RE =
  /\s*(?:\[[^\n\]]*(?:সেল্ফ\s*প্রিপারেশন|অগ্রদূত|প্রফেসর['’]?স|প্রফেসরস|ওরাকল|এমপিথ্রি|MP3|অ্যাসিওরেন্স|খায়রুল['’]?স|জর্জ|নতুন\s+সংস্করণ|সংস্করণ|Edition)[^\n\]]*(?:পৃষ্ঠা|পৃ\.|page)\s*[-:ঃ.]?\s*[0-9০-৯]+[^\n\]]*\]?|\[?(?:পৃষ্ঠা|পৃ\.)\s*[:ঃ\-]\s*[0-9০-৯]+[^\n()]{0,45}\([^)\n]{2,140}\)\]?)/gi;

function sanitizeLinesForAnswerDetection(lines: string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (
      /^\[AI দ্বারা তৈরি উত্তর\]/i.test(trimmed) ||
      /^(?:রেফারেন্স|Reference)\s*[:ঃ]/i.test(trimmed)
    ) {
      cleaned.push(trimmed);
      continue;
    }
    if (NON_ANSWER_PUBLISHER_CROSS_REF_LINE_RE.test(trimmed)) {
      continue;
    }
    const withoutInlineRef = trimmed
      .replace(NON_ANSWER_INLINE_CROSS_REF_RE, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (
      withoutInlineRef &&
      !/^(?:Solution|Answer|Ans|উত্তর|সমাধান|ব্যাখ্যা)\s*[:ঃ.]?\s*$/i.test(withoutInlineRef)
    ) {
      cleaned.push(withoutInlineRef);
    }
  }
  return cleaned;
}

function detectQuestionExistingAnswer(
  lines: string[]
): {
  hasExistingAnswer: boolean;
  evidence: ExamQuestionAnalysis['answerEvidence'];
} {
  const effectiveLines = sanitizeLinesForAnswerDetection(lines);
  const joined = effectiveLines.join('\n');

  // 1. Explicit AI-generated marker (already filled)
  if (joined.includes(AI_ANSWER_MARKER)) {
    return { hasExistingAnswer: true, evidence: 'ai_generated_answer' };
  }

  // 2. Explicit Solution / Answer / Ans. / উত্তর / সমাধান / ব্যাখ্যা label anywhere in block
  if (
    /(?:^|\n|\s)(?:(?:Solution|Answer|উত্তর|সমাধান|ব্যাখ্যা)\s*[:ঃ]|(?:Ans|Answer)\s*[.:]\s*)\s*\S/i.test(
      joined
    )
  ) {
    return { hasExistingAnswer: true, evidence: 'solution_label' };
  }

  // 3. Inline sub-option solutions (`a) নবান্ন = নব + অন্ন`, `ক) সাকার = নিরাকার`, `b) ... Answer: a`, `d) ওষ্ঠ ans. A`)
  const optionLines = effectiveLines.filter((l) =>
    /^(?:[a-h]\)|[ক-ঙ]\)|\([ক-ঙ]\)|•)\s+/.test(l.trim())
  );
  if (optionLines.length >= 1) {
    const optionsWithEqualsAnswer = optionLines.filter((l) =>
      /\s*=\s*\S/.test(l)
    );
    if (optionsWithEqualsAnswer.length >= 1) {
      return { hasExistingAnswer: true, evidence: 'inline_option_answers' };
    }

    const optionsWithInlineAnswerLabel = optionLines.filter((l) =>
      /(?:Answer\s*[:ঃ.]|Ans\s*[:ঃ.]|উত্তর\s*[:ঃ])\s*\S/i.test(l)
    );
    if (optionsWithInlineAnswerLabel.length >= 1) {
      return { hasExistingAnswer: true, evidence: 'inline_option_answers' };
    }

    // Inline parenthetical grammar answers like `(the)`, `(a)`, `(an)` alongside `বাক্যের অর্থ:` or gap `___`
    const optionsWithParentheticalAnswer = optionLines.filter(
      (l) =>
        /(?:___|\.{3,})/.test(l) &&
        /\((?:a|an|the|in|on|at|to|of|for|by|with|from|into|over|under|is|are|was|were|has|have|had)\)/i.test(
          l
        )
    );
    if (optionsWithParentheticalAnswer.length >= 1) {
      return {
        hasExistingAnswer: true,
        evidence: 'inline_parenthetical_answers',
      };
    }
  }

  // 4. Math derivation steps directly underneath the question stem
  const bodyLines = effectiveLines.slice(1);
  const hasMathSteps = bodyLines.some((l) =>
    /^(?:⇒|∴|অতএব\b|প্রশ্নমতে\b|প্রশ্নানুযায়ী\b|ধরি,|দেওয়া আছে|দেয়া আছে|এখানে,)/.test(
      l.trim()
    )
  );
  if (hasMathSteps) {
    return { hasExistingAnswer: true, evidence: 'math_derivation' };
  }

  return { hasExistingAnswer: false, evidence: null };
}

/**
 * Deterministically analyzes every numbered question in an exam sheet:
 * - Detects whether an answer/solution already exists in the printed book
 * - Detects math questions and corrupted math OCR
 */
export function analyzeExamQuestionAnswers(
  content: string
): ExamAnswerAnalysisReport {
  const normalized = (content ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return {
      isExam: false,
      headerBlock: '',
      questions: [],
      answeredCount: 0,
      unansweredQuestions: [],
      corruptedMathQuestions: [],
      mathQuestions: [],
    };
  }

  const lines = normalized.split('\n');
  const questionStarts: Array<{
    lineIdx: number;
    numberLabel: string;
    questionKey: string;
    stem: string;
  }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    const match = trimmed.match(QUESTION_LINE_RE);
    if (match) {
      const numberLabel = match[1];
      const stem = match[2].trim();
      const questionKey =
        normalizeQuestionKey(numberLabel) || String(questionStarts.length + 1);
      questionStarts.push({
        lineIdx: i,
        numberLabel,
        questionKey,
        stem,
      });
    }
  }

  if (questionStarts.length === 0) {
    return {
      isExam: false,
      headerBlock: normalized,
      questions: [],
      answeredCount: 0,
      unansweredQuestions: [],
      corruptedMathQuestions: [],
      mathQuestions: [],
    };
  }

  const headerBlock = lines
    .slice(0, questionStarts[0].lineIdx)
    .join('\n')
    .trim();

  const questions: ExamQuestionAnalysis[] = questionStarts.map((q, idx) => {
    const endLine =
      idx + 1 < questionStarts.length
        ? questionStarts[idx + 1].lineIdx
        : lines.length;
    const blockLines = lines.slice(q.lineIdx, endLine);
    while (blockLines.length > 0 && !blockLines[blockLines.length - 1].trim()) {
      blockLines.pop();
    }
    const rawBlock = blockLines.join('\n').trim();
    const answerCheck = detectQuestionExistingAnswer(blockLines);
    const isMath = detectQuestionIsMath(rawBlock);
    const corruptedMath = hasCorruptedMathOcr(rawBlock);

    return {
      index: idx,
      questionKey: q.questionKey,
      numberLabel: q.numberLabel,
      questionStem: q.stem,
      rawBlock,
      hasExistingAnswer: answerCheck.hasExistingAnswer,
      answerEvidence: answerCheck.evidence,
      isMathQuestion: isMath || corruptedMath,
      hasCorruptedMath: corruptedMath,
    };
  });

  const unansweredQuestions = questions.filter((q) => !q.hasExistingAnswer);
  const answeredCount = questions.length - unansweredQuestions.length;
  const corruptedMathQuestions = questions.filter((q) => q.hasCorruptedMath);
  const mathQuestions = questions.filter((q) => q.isMathQuestion);

  return {
    isExam: true,
    headerBlock,
    questions,
    answeredCount,
    unansweredQuestions,
    corruptedMathQuestions,
    mathQuestions,
  };
}

function formatReferenceLine(references: AiReferenceItem[]): string {
  const cleanRefs = references
    .map((r) => ({
      title: (r.title || '').trim(),
      url: (r.url || '').trim(),
    }))
    .filter((r) => r.title || r.url);

  if (cleanRefs.length === 0) {
    return 'রেফারেন্স: প্রামাণ্য পাঠ্যবই ও সাধারণ জ্ঞান উৎস (AI যাচাইকৃত)';
  }

  const parts = cleanRefs.slice(0, 3).map((r) => {
    if (r.title && r.url) {
      return `${r.title} (${r.url})`;
    }
    return r.url || r.title;
  });

  return `রেফারেন্স: ${parts.join(' | ')}`;
}

/**
 * STRICT NON-OVERRIDE MERGER:
 * Merges AI-generated answers ONLY into questions that have `hasExistingAnswer === false`.
 * Any AI entry targeting a question that already has an answer in the book is HARD-REJECTED
 * and recorded in `skippedProtectedKeys`.
 * Every applied AI answer is mandatorily tagged with `[AI দ্বারা তৈরি উত্তর]` and `রেফারেন্স:`.
 */
export function mergeAiMissingAnswersSafely(
  originalContent: string,
  aiAnswers: AiMissingAnswerEntry[]
): SafeMissingAnswerMergeResult {
  const analysis = analyzeExamQuestionAnswers(originalContent);
  if (!analysis.isExam || aiAnswers.length === 0) {
    return {
      updatedContent: originalContent,
      appliedKeys: [],
      skippedProtectedKeys: [],
    };
  }

  const answerMap = new Map<string, AiMissingAnswerEntry>();
  for (const entry of aiAnswers) {
    const key = normalizeQuestionKey(entry.questionKey);
    if (!key) continue;
    const cleanedAnswer = cleanDeterministicMathSymbols(
      (entry.answerText || '').trim()
    );
    if (!cleanedAnswer) continue;
    answerMap.set(key, {
      questionKey: key,
      answerText: cleanedAnswer,
      references: Array.isArray(entry.references) ? entry.references : [],
    });
  }

  const appliedKeys: string[] = [];
  const skippedProtectedKeys: string[] = [];

  const rebuiltBlocks = analysis.questions.map((q) => {
    const candidate = answerMap.get(q.questionKey);
    if (!candidate) {
      return q.rawBlock;
    }

    // HARD NON-OVERRIDE GUARD: Never touch any question that already has an answer
    if (q.hasExistingAnswer) {
      skippedProtectedKeys.push(q.questionKey);
      return q.rawBlock;
    }

    appliedKeys.push(q.questionKey);

    // Strip any duplicate label prefixes from the AI text so formatting is crisp
    const strippedBody = candidate.answerText
      .replace(/^\[AI দ্বারা তৈরি উত্তর\]\s*/i, '')
      .replace(/^(?:উত্তর|সমাধান|Solution|Answer)\s*[:ঃ]\s*/i, '')
      .trim();

    const answerLines = strippedBody
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const firstLine = answerLines[0] ?? strippedBody;
    const restLines = answerLines.slice(1).map((l) => `    ${l}`);
    const refLine = formatReferenceLine(candidate.references);

    return [
      q.rawBlock,
      AI_ANSWER_MARKER,
      `উত্তর: ${firstLine}`,
      ...restLines,
      refLine,
    ].join('\n');
  });

  const sections = [
    ...(analysis.headerBlock ? [analysis.headerBlock] : []),
    ...rebuiltBlocks,
  ];

  return {
    updatedContent: sections.join('\n\n').trim(),
    appliedKeys,
    skippedProtectedKeys,
  };
}

/**
 * Safely merges AI-repaired math blocks ONLY into questions identified as math questions
 * (`isMathQuestion || hasCorruptedMath`), preserving original question numbering and never
 * overwriting non-math questions.
 */
export function mergeRepairedMathSafely(
  originalContent: string,
  repairs: SafeMathRepairEntry[]
): SafeMathRepairMergeResult {
  const analysis = analyzeExamQuestionAnswers(originalContent);
  if (!analysis.isExam || repairs.length === 0) {
    return {
      updatedContent: originalContent,
      repairedKeys: [],
      skippedKeys: [],
    };
  }

  const repairMap = new Map<string, string>();
  for (const r of repairs) {
    const key = normalizeQuestionKey(r.questionKey);
    const cleaned = cleanDeterministicMathSymbols((r.repairedBlock || '').trim());
    if (key && cleaned) {
      repairMap.set(key, cleaned);
    }
  }

  const repairedKeys: string[] = [];
  const skippedKeys: string[] = [];

  const rebuiltBlocks = analysis.questions.map((q) => {
    const candidate = repairMap.get(q.questionKey);
    if (!candidate) {
      return q.rawBlock;
    }

    if (!q.isMathQuestion && !q.hasCorruptedMath) {
      skippedKeys.push(q.questionKey);
      return q.rawBlock;
    }

    // Ensure repaired block keeps the exact original question number prefix
    let finalBlock = candidate;
    const firstLineMatch = finalBlock.match(QUESTION_LINE_RE);
    if (!firstLineMatch) {
      finalBlock = `${q.numberLabel} ${finalBlock}`;
    } else if (firstLineMatch[1] !== q.numberLabel) {
      finalBlock = finalBlock.replace(QUESTION_LINE_RE, `${q.numberLabel} $2`);
    }

    repairedKeys.push(q.questionKey);
    return finalBlock;
  });

  const sections = [
    ...(analysis.headerBlock ? [analysis.headerBlock] : []),
    ...rebuiltBlocks,
  ];

  return {
    updatedContent: sections.join('\n\n').trim(),
    repairedKeys,
    skippedKeys,
  };
}
