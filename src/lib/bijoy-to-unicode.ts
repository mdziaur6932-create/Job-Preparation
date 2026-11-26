import { evaluateLocalExtractedPageText } from './pdf-rules';

/**
 * Known legacy Bangladeshi ANSI / Bijoy font families commonly embedded in
 * BCS, Bank, Primary, and Recent Job Solution PDFs.
 */
const BIJOY_FONT_NAME_PATTERN =
  /sutonny|bijoy|tonny|sulekha|adarsha|bangla(?:mj|omj)|boishakhi|chandrabati|dhansiri|ekushey.*ansi|kongsho|proshika|rupali.*ansi|shonar.*ansi/i;

export function isBijoyFontName(fontName: string | null | undefined): boolean {
  if (!fontName) return false;
  return BIJOY_FONT_NAME_PATTERN.test(fontName);
}

/**
 * Checks whether raw PDF-extracted text exhibits strong Bijoy / SutonnyMJ ANSI encoding
 * signatures (e.g., `evsjv‡`k`, `cÖkœ`, `msweavb`) while containing virtually no Unicode Bengali.
 */
export function looksLikeBijoyAnsiText(rawText: string): boolean {
  const trimmed = (rawText ?? '').trim();
  if (trimmed.length < 20) return false;

  const nonWs = trimmed.replace(/\s+/g, '');
  if (nonWs.length < 20) return false;

  const unicodeBengali = nonWs.match(/[\u0980-\u09FF]/g) ?? [];
  if (unicodeBengali.length / nonWs.length >= 0.15) {
    return false;
  }

  // Signature Bijoy ANSI tokens: kar markers (†, ‡, „, ¤, ©, Ö, œ, ÿ, †K, Av, ev, mv, cÖ, wb, wi)
  const bijoySpecialChars =
    nonWs.match(/[†‡„¤©Öœÿš›žŸŠ‹ŒŽ¡¢£¥¦§¨ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿À-ÖØ-öø-ÿ`~^|]/g) ?? [];
  const bijoyTokenPairs =
    trimmed.match(
      /\b(?:Av|ev|mv|cÖ|ms|wb|wi|Kv|Zv|bv|gv|jv|iv|hv|cv|dv|†K|†Z|†b|†g|†j|‡K|‡Z|‡`)[a-zA-Z†‡„¤©Öœÿ`~^|]*/g
    ) ?? [];

  const specialRatio = bijoySpecialChars.length / nonWs.length;
  return (
    (specialRatio >= 0.04 && bijoyTokenPairs.length >= 2) ||
    specialRatio >= 0.08 ||
    bijoyTokenPairs.length >= 5
  );
}

// Multi-character sequences MUST be replaced before single-character mappings.
// Ordered longest-first for deterministic conversion.
const BIJOY_MULTI_CHAR_MAP: ReadonlyArray<readonly [string, string]> = [
  // Independent vowels formed by base + kar
  ['Av', 'আ'],
  ['A¨', 'অ্যা'],
  ['C`', 'ঈদ'],
  // Compound conjuncts & special glyphs
  ['¶', 'ক্ষ'],
  ['ÿ', 'ক্ষ'],
  ['¼', 'ঙ্ক'],
  ['½', 'ঙ্গ'],
  ['¾', 'জ্জ'],
  ['¿', 'ত্র'],
  ['À', 'দ্ভ'],
  ['Á', 'জ্ঞ'],
  ['Â', 'ঞ্চ'],
  ['Ã', 'ঞ্ছ'],
  ['Ä', 'ঞ্জ'],
  ['Å', 'ঞ্ঝ'],
  ['Æ', 'ট্ট'],
  ['Ç', 'ড্ড'],
  ['È', 'ণ্ট'],
  ['É', 'ণ্ঠ'],
  ['Ê', 'ণ্ড'],
  ['Ë', 'ত্ত'],
  ['Ì', 'ত্থ'],
  ['Í', 'দ্ম'],
  ['Î', 'ত্র'],
  ['Ï', 'দ্দ'],
  ['Ð', 'দ্ধ'],
  ['Ñ', 'দ্ব'],
  ['Ò', 'দ্ম'],
  ['Ó', 'ন্ত'],
  ['Ô', 'ন্থ'],
  ['Õ', 'ন্দ'],
  ['Ö', '্র'],
  ['×', 'ন্ধ'],
  ['Ø', 'দ্ব'],
  ['Ù', 'ত্ম'],
  ['Ú', 'ত্র'],
  ['Û', 'ব্দ'],
  ['Ü', 'ব্ধ'],
  ['Ý', 'ন্দ'],
  ['Þ', 'প্ত'],
  ['ß', 'প্প'],
  ['à', 'প্র'],
  ['á', 'ফ্ল'],
  ['â', 'ম্ব'],
  ['ã', 'ম্ভ'],
  ['ä', 'ম্ম'],
  ['å', 'ম্প'],
  ['æ', '্র'],
  ['ç', 'ল্ক'],
  ['è', 'ল্গ'],
  ['é', 'ল্ট'],
  ['ê', 'ল্ড'],
  ['ë', 'ল্প'],
  ['ì', 'ল্ব'],
  ['í', 'ল্ম'],
  ['î', 'ল্ল'],
  ['ï', 'শ্চ'],
  ['ð', 'শ্ছ'],
  ['ñ', 'ষ্ণ'],
  ['ò', 'ষ্ট'],
  ['ó', 'ষ্ঠ'],
  ['ô', 'ষ্প'],
  ['õ', 'স্ফ'],
  ['ö', 'স্ক'],
  ['÷', 'স্ট'],
  ['ø', 'স্ত'],
  ['ù', 'স্থ'],
  ['ú', 'স্প'],
  ['û', 'স্ফ'],
  ['ü', 'স্ব'],
  ['ý', 'স্ম'],
  ['þ', 'হ্ম'],
  ['Š', 'ক্ত'],
  ['‹', 'ক্ল'],
  ['Œ', 'ক্র'],
  ['Ž', 'ক্ষ'],
  ['š', 'শ'],
  ['›', 'স'],
  ['œ', '্ন'],
  ['ž', 'জ'],
  ['Ÿ', 'ব'],
  ['¡', '্ণ'],
  ['¢', '্ত'],
  ['£', '্র'],
  ['¤', '্ম'],
  ['¥', '্য'],
  ['¦', '্ব'],
  ['§', '্ম'],
  ['¨', '্যা'],
  ['ª', '্র'],
  ['«', '্র'],
  ['¬', '্ল'],
  ['®', 'ষ্'],
  ['¯', 'স্'],
  ['°', 'ক্ক'],
  ['±', 'ক্ট'],
  ['²', 'ক্ত'],
  ['³', 'ক্ত'],
  ['´', 'ক্ন'],
  ['µ', 'ক্র'],
  ['¶', 'ক্ষ'],
  ['·', 'ক্স'],
  ['¸', 'গ্ধ'],
  ['¹', 'গ্ন'],
  ['º', 'গ্ম'],
  ['»', 'গ্ল'],
  ['&', '্'],
];

const BIJOY_SINGLE_CHAR_MAP: Readonly<Record<string, string>> = {
  // Independent vowels
  A: 'অ',
  B: 'ই',
  C: 'ঈ',
  D: 'উ',
  E: 'ঊ',
  F: 'ঋ',
  G: 'এ',
  H: 'ঐ',
  I: 'ও',
  J: 'ঔ',

  // Consonants
  K: 'ক',
  L: 'খ',
  M: 'গ',
  N: 'ঘ',
  O: 'ঙ',
  P: 'চ',
  Q: 'ছ',
  R: 'জ',
  S: 'ঝ',
  T: 'ঞ',
  U: 'ট',
  V: 'ঠ',
  W: 'ড',
  X: 'ঢ',
  Y: 'ণ',
  Z: 'ত',
  _: 'থ',
  '`': 'দ',
  a: 'ধ',
  b: 'ন',
  c: 'প',
  d: 'ফ',
  e: 'ব',
  f: 'ভ',
  g: 'ম',
  h: 'য',
  i: 'র',
  j: 'ল',
  k: 'শ',
  l: 'ষ',
  m: 'স',
  n: 'হ',
  o: 'ড়',
  p: 'ঢ়',
  q: 'য়',
  r: 'ৎ',
  s: 'ং',
  t: 'ঃ',
  u: 'ঁ',

  // Post-base vowel signs (kars)
  v: 'া',
  x: 'ী',
  y: 'ু',
  z: 'ূ',
  '~': 'ূ',
  '„': 'ৃ',
  '…': 'ৃ',
  '‚': 'ু',
  'ƒ': 'ূ',
  '—': 'ু',
  '˜': 'ূ',

  // Pre-base vowel signs (handled during reordering pass)
  w: 'ি',
  '†': 'ে',
  '‡': 'ে',
  '‰': 'ৈ',
  'ˆ': 'ৈ',

  // Ref (repositioned before base consonant cluster)
  '©': 'র্',

  // Juktakkhor helpers & punctuation
  '^': '্ব',
  '|': '।',
  '\\': '্',
};

const BENGALI_CONSONANT_SET = new Set(
  'কখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়'.split('')
);
const PRE_BASE_KARS = new Set(['ি', 'ে', 'ৈ']);

/**
 * Reorders pre-base Bijoy vowel signs (`ি`, `ে`, `ৈ`), combines `ে + া -> ো` and `ে + ৗ -> ৌ`,
 * and repositions trailing reph (`র্`) before the preceding consonant cluster.
 */
function reorderBijoyKarsAndReph(input: string): string {
  const chars = Array.from(input);
  const out: string[] = [];

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];

    // Pre-base kar (ি, ে, ৈ) in Bijoy precedes the consonant/conjunct cluster.
    if (PRE_BASE_KARS.has(ch) && i + 1 < chars.length && BENGALI_CONSONANT_SET.has(chars[i + 1])) {
      let j = i + 1;
      // Consume full consonant conjunct cluster: C (্ C)*
      while (j + 2 < chars.length && chars[j + 1] === '্' && BENGALI_CONSONANT_SET.has(chars[j + 2])) {
        j += 2;
      }
      // Also include trailing fola (্য, ্র, ্ব, ্ল, ্ম, ্ন) if already attached via hasanta
      if (j + 2 < chars.length && chars[j + 1] === '্') {
        j += 2;
      }

      // Emit consonant cluster first
      for (let k = i + 1; k <= j; k += 1) {
        out.push(chars[k]);
      }

      // Combine ে + া => ো  or  ে + ৗ => ৌ
      if (ch === 'ে' && j + 1 < chars.length && chars[j + 1] === 'া') {
        out.push('ো');
        i = j + 2;
        continue;
      }
      if (ch === 'ে' && j + 1 < chars.length && chars[j + 1] === 'ৗ') {
        out.push('ৌ');
        i = j + 2;
        continue;
      }

      out.push(ch);
      i = j + 1;
      continue;
    }

    out.push(ch);
    i += 1;
  }

  let result = out.join('');

  // Reposition Bijoy post-base reph marker (`©` -> `র্`) before the immediately preceding consonant cluster
  // e.g. `ক©` -> `র্ক`, `কর্` when emitted as `K©` -> `ক` + `র্` -> `র্ক`
  result = result.replace(
    /([ক-হড়-য়](?:্[ক-হড়-য়])*)([া-ৌঁংঃ]?)র্(?!্)/g,
    'র্$1$2'
  );

  // Normalize redundant double hasanta or ে+া combinations that emerged after reph move
  result = result.replace(/ো/g, 'ো').replace(/ৌ/g, 'ৌ').replace(/্{2,}/g, '্');

  return result;
}

/**
 * Converts a single Bijoy / SutonnyMJ ANSI string into Unicode Bengali.
 */
export function convertBijoyToUnicode(ansiText: string): string {
  if (!ansiText) return '';

  let working = ansiText;

  // Step 1: Replace multi-char and special Bijoy sequences
  for (const [src, dst] of BIJOY_MULTI_CHAR_MAP) {
    if (working.includes(src)) {
      working = working.split(src).join(dst);
    }
  }

  // Step 2: Map single-character Bijoy ANSI glyphs
  let mapped = '';
  for (let i = 0; i < working.length; i += 1) {
    const ch = working[i];
    const replacement = BIJOY_SINGLE_CHAR_MAP[ch];
    mapped += replacement !== undefined ? replacement : ch;
  }

  // Step 3: Reorder pre-base kars (ি, ে, ৈ, ো, ৌ) and reph (র্)
  return reorderBijoyKarsAndReph(mapped);
}

export interface BijoyConversionOutcome {
  converted: boolean;
  text: string;
  substantiveLength: number;
}

/**
 * Safely attempts Bijoy -> Unicode Bengali conversion ONLY when a page either declares a
 * known Bijoy/Sutonny font OR strongly matches Bijoy ANSI encoding signatures.
 * Verifies post-conversion quality so English/corrupt pages are never mangled.
 */
export function tryConvertBijoyPageText(
  rawText: string,
  hasBijoyFontHint: boolean
): BijoyConversionOutcome {
  if (!rawText || (!hasBijoyFontHint && !looksLikeBijoyAnsiText(rawText))) {
    return { converted: false, text: rawText, substantiveLength: 0 };
  }

  const convertedText = convertBijoyToUnicode(rawText);
  const evaluation = evaluateLocalExtractedPageText(convertedText);
  if (!evaluation.usable) {
    return { converted: false, text: rawText, substantiveLength: 0 };
  }

  const nonWs = evaluation.cleanedText.replace(/\s+/g, '');
  const bengaliChars = nonWs.match(/[\u0980-\u09FF]/g) ?? [];
  if (nonWs.length === 0 || bengaliChars.length / nonWs.length < 0.35) {
    return { converted: false, text: rawText, substantiveLength: 0 };
  }

  return {
    converted: true,
    text: evaluation.cleanedText,
    substantiveLength: evaluation.substantiveLength,
  };
}
