/**
 * Exam Typography & Mixed-Script Segmentation Utility
 *
 * Implements the exact requested exam typography across Smart Reader, Topic Explorer,
 * and A4 PDF export:
 * - Exam Header (পরীক্ষার নাম, পদের নাম, সময়, তারিখ ও পূর্ণমান): 18pt, existing app font (`Hind Siliguri`)
 * - Bengali question/option/answer/explanation text: SolaimanLipi, 11pt
 * - English question/option/answer/explanation text: Times New Roman, 12pt
 */

export const EXAM_HEADER_FONT_SIZE_PT = 18;
export const EXAM_BN_FONT_SIZE_PT = 11;
export const EXAM_EN_FONT_SIZE_PT = 12;

export const EXAM_HEADER_FONT_STACK =
  '"Hind Siliguri", "Plus Jakarta Sans", "Noto Sans Bengali", ui-sans-serif, system-ui, sans-serif';
export const SOLAIMAN_LIPI_FONT_STACK =
  '"SolaimanLipi", "Hind Siliguri", "Noto Sans Bengali", sans-serif';
export const TIMES_NEW_ROMAN_FONT_STACK =
  '"Times New Roman", Times, Georgia, serif';

/**
 * Converts typographic points (pt) to pixels on our 150-DPI A4 canvas
 * (1 inch = 72pt = 150px => 1pt = 150 / 72 = 2.0833px).
 */
export function ptToCanvasPx(pt: number, dpi = 150): number {
  return Math.round((pt * dpi) / 72);
}

export interface MixedScriptSegment {
  text: string;
  script: 'bn' | 'en';
}

const BENGALI_CHAR_RE = /[\u0980-\u09FF]/;
const LATIN_LETTER_RE = /[A-Za-z]/;
const ASCII_DIGIT_RE = /[0-9]/;

/**
 * Segments a single line/string into contiguous Bengali (`bn`) and English (`en`)
 * runs so mixed sentences like:
 * - "০১. IDA স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?"
 * - "১১. Chancellor of Ex-chequer কোন দেশের অর্থমন্ত্রীর পদবী?"
 * - "'The 100' বইটি কার লেখা?"
 * - "a) To err is human."
 * render every English run in Times New Roman 12pt and every Bengali run in SolaimanLipi 11pt,
 * without splitting acronyms, hyphenated English words, parenthesized English abbreviations
 * like `(NDB)` or `(International Development Association)`, or ASCII digits attached to English words.
 */
export function splitMixedScriptSegments(text: string): MixedScriptSegment[] {
  if (!text) return [];

  const hasBengali = BENGALI_CHAR_RE.test(text);
  const hasLatin = LATIN_LETTER_RE.test(text);

  if (!hasBengali && hasLatin) {
    return [{ text, script: 'en' }];
  }
  if (!hasLatin) {
    // Pure Bengali (or Bengali + Bengali digits / pure digits in Bengali context)
    if (!hasBengali && ASCII_DIGIT_RE.test(text)) {
      return [{ text, script: 'en' }];
    }
    return [{ text, script: 'bn' }];
  }

  // Mixed Bengali + English text:
  // Capture contiguous English phrases: starts with a Latin letter and continues across
  // spaces, hyphens, apostrophes, dots, slashes, ampersands, commas, digits, and parens
  // as long as each extension connects to another Latin letter or ASCII digit.
  const englishRunRe =
    /(?:\([A-Za-z0-9][A-Za-z0-9\s.,'’\-/&:;+]*[A-Za-z0-9.]\)|[A-Za-z][A-Za-z0-9'’\-/.&]*(?:(?:\s+|,\s*|:\s*|\s*-\s*|\s*\/\s*|\s*&\s*)(?:\([A-Za-z0-9][A-Za-z0-9\s.,'’\-/&:;+]*\)|[A-Za-z0-9][A-Za-z0-9'’\-/.&]*))*)/g;

  const rawSegments: MixedScriptSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = englishRunRe.exec(text)) !== null) {
    const start = match.index;
    let value = match[0];

    // Do not swallow trailing sentence punctuation or spaces that belong to surrounding Bengali text
    // unless it is a genuine English abbreviation dot (like `U.S.A.` or `Mr.`) or closing paren of `(NDB)`.
    const trailingSpaceMatch = value.match(/(\s+)$/);
    if (trailingSpaceMatch) {
      value = value.slice(0, value.length - trailingSpaceMatch[1].length);
    }

    // Do not absorb a trailing closing quote (e.g. ‘The 100’) into the English run
    while (/[’']$/.test(value)) {
      value = value.slice(0, -1);
    }

    if (start > lastIndex) {
      rawSegments.push({
        text: text.slice(lastIndex, start),
        script: 'bn',
      });
    }

    if (value) {
      rawSegments.push({
        text: value,
        script: 'en',
      });
    }

    lastIndex = start + value.length;
  }

  if (lastIndex < text.length) {
    rawSegments.push({
      text: text.slice(lastIndex),
      script: 'bn',
    });
  }

  // Merge adjacent segments of the same script
  const merged: MixedScriptSegment[] = [];
  for (const seg of rawSegments) {
    if (!seg.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.script === seg.script) {
      prev.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}
