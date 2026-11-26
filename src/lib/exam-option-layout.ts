import type { ParsedExamDisplayLine } from './exam-text-formatter';
import { stripInlineRichMarkup } from './rich-text-and-table-parser';

export interface OptionItem {
  marker: string;
  text: string;
}

export type ExamDisplayBlock =
  | ParsedExamDisplayLine
  | {
      kind: 'option_group';
      options: OptionItem[];
      columns: 1 | 2;
      rows: OptionItem[][];
    };

export interface StructuredExamHeader {
  titleLines: string[];
  postLine: string | null;
  timeText: string | null;
  dateText: string | null;
  marksText: string | null;
  otherMetaLines: string[];
}

/**
 * Computes approximate visual character length of an option text after stripping
 * LaTeX wrappers so stacked fractions / equations don't misestimate width.
 */
export function estimateOptionVisualLength(rawText: string): number {
  if (!rawText) return 0;
  const cleaned = stripInlineRichMarkup(rawText)
    .replace(/\\(?:d|t)?frac\{([^}]*)\}\{([^}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^}]*)\}/g, '√$1')
    .replace(/\[\[frac:([^|]*)\|([^\]]*)\]\]/g, '$1/$2')
    .replace(/\\[a-zA-Z]+/g, 'x')
    .replace(/[\${}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // In Bangla script, hasanta (্) + conjuncts and vertical/diacritic marks (ু, ূ, ৃ, ঁ, ়)
  // visually stack without adding full horizontal glyph width. Weight them accurately
  // so conjunct-heavy Bangla names (e.g. "বঙ্কিমচন্দ্র চট্টোপাধ্যায়") aren't overestimated.
  let visualUnits = 0;
  for (const ch of Array.from(cleaned)) {
    if (/[\u09CD\u09BC\u0981\u09C1-\u09C4\u200C\u200D]/.test(ch)) {
      visualUnits += 0.15;
    } else if (/[\u09BE-\u09C0\u09C7-\u09CC\u09D7]/.test(ch)) {
      visualUnits += 0.55;
    } else {
      visualUnits += 1;
    }
  }
  return Math.ceil(visualUnits);
}

function hasComplexMultilineMath(text: string): boolean {
  return /\\(?:d|t)?frac\{|\[\[frac:|\\begin\{/.test(text);
}

/**
 * Decides whether a question's MCQ options should render 2-per-row (original compact
 * exam paper style) or 1-per-row (when options are long and cannot fit two-across cleanly).
 *
 * - `maxCharsPerHalfRow`: max visual characters per option to comfortably fit 2-across
 *   without awkward mid-word or multi-line wrapping.
 *   - Default for A4 single-column paper (`~185mm` printable width): `34` chars
 *   - Recommended for A4 two-column exam sheet (`~88mm` per column): `24` chars
 */
export function decideOptionColumnLayout(
  options: OptionItem[],
  maxCharsPerHalfRow = 34
): { columns: 1 | 2; rows: OptionItem[][] } {
  if (options.length < 2) {
    return {
      columns: 1,
      rows: options.map((opt) => [opt]),
    };
  }

  const fitsTwoColumns = options.every((opt) => {
    const text = (opt.text || '').trim();
    if (!text) return true;
    if (text.includes('\n')) return false;
    if (hasComplexMultilineMath(text)) {
      return estimateOptionVisualLength(text) <= Math.floor(maxCharsPerHalfRow * 0.72);
    }
    return estimateOptionVisualLength(text) <= maxCharsPerHalfRow;
  });

  if (!fitsTwoColumns) {
    return {
      columns: 1,
      rows: options.map((opt) => [opt]),
    };
  }

  const rows: OptionItem[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(options.slice(i, i + 2));
  }
  return { columns: 2, rows };
}

/**
 * Groups consecutive `option` display items into `option_group` blocks with an
 * automatically calculated 2-column or 1-column layout so Smart Reader, Printable
 * Exam Sheets, and A4 PDF Export all share identical original exam typography.
 */
export function groupDisplayItemsWithOptionBlocks(
  items: ParsedExamDisplayLine[],
  maxCharsPerHalfRow = 34
): ExamDisplayBlock[] {
  const result: ExamDisplayBlock[] = [];
  let pendingOptions: OptionItem[] = [];

  const flushOptions = () => {
    if (pendingOptions.length === 0) return;
    const layout = decideOptionColumnLayout(pendingOptions, maxCharsPerHalfRow);
    result.push({
      kind: 'option_group',
      options: pendingOptions,
      columns: layout.columns,
      rows: layout.rows,
    });
    pendingOptions = [];
  };

  for (const item of items) {
    if (item.kind === 'option') {
      pendingOptions.push({ marker: item.marker, text: item.text });
      continue;
    }
    flushOptions();
    result.push(item);
  }
  flushOptions();

  return result;
}

export const EDITORIAL_2COL_OPTION_MAX_CHARS = 24;
export const EDITORIAL_1COL_OPTION_MAX_CHARS = 44;

const SUBJECT_SUBHEADING_PATTERNS: RegExp[] = [
  /^(?:বাংলা|বাংলা\s+ভাষা(?:\s+ও\s+সাহিত্য)?|বাংলা\s+সাহিত্য|বাংলা\s+ব্যাকরণ)$/i,
  /^(?:ইংরেজি|ইংরেজি\s+ভাষা(?:\s+ও\s+সাহিত্য)?|English(?:\s+Language(?:\s+&\s+Literature)?)?|English\s+Grammar)$/i,
  /^(?:গণিত|গাণিতিক\s+যুক্তি|পাটিগণিত|বীজগণিত|জ্যামিতি|Mathematics|Math)(?:\s*(?:ও|এবং|&|and)\s*(?:মানসিক\s+দক্ষতা|Mental\s+Ability|Analytical\s+Ability))?$/i,
  /^(?:সাধারণ\s+জ্ঞান|বাংলাদেশ\s+বিষয়াবলি|আন্তর্জাতিক\s+বিষয়াবলি|বাংলাদেশ\s+ও\s+আন্তর্জাতিক\s+বিষয়াবলি|General\s+Knowledge|Bangladesh\s+Affairs|International\s+Affairs)(?:\s*(?:ও|এবং|&)\s*(?:কম্পিউটার|আইসিটি|বিজ্ঞান|ICT))?$/i,
  /^(?:মানসিক\s+দক্ষতা|Mental\s+Ability|Analytical\s+Ability)$/i,
  /^(?:সাধারণ\s+বিজ্ঞান|বিজ্ঞান|General\s+Science|Science)(?:\s*(?:ও|এবং|&|and)\s*(?:কম্পিউটার|তথ্যপ্রযুক্তি|কম্পিউটার\s+ও\s+তথ্যপ্রযুক্তি|আইসিটি|ICT|Computer|Technology))?$/i,
  /^(?:কম্পিউটার\s+ও\s+তথ্যপ্রযুক্তি|কম্পিউটার|তথ্যপ্রযুক্তি|আইসিটি|ICT|Computer(?:\s*(?:&|and)\s*(?:IT|Information\s+Technology))?)$/i,
  /^(?:ভূগোল(?:\s+ও\s+পরিবেশ)?|নৈতিকতা,?\s*মূল্যবোধ\s+ও\s+সুশাসন|Geography|Ethics)$/i,
  /^(?:অংশ\s*[-–—:]?\s*[কখগঘঙচ১-৯A-F]|Part\s*[-–—:]?\s*[A-F1-6])$/i,
];

/**
 * Detects standalone subject section headings (e.g. `বাংলা`, `English`, `সাধারণ জ্ঞান`, `গণিত`)
 * so Smart Reader, A4 PDF, and Word `.docx` center and bold them cleanly inside the column
 * just like professional Bangladeshi job-solution publications.
 */
export function isExamSubjectHeadingLine(rawText: string): boolean {
  const cleaned = stripInlineRichMarkup(rawText || '')
    .replace(/^[-–—•*:\s]+|[-–—•*:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > 48) return false;
  if (/[?!।]$/.test(cleaned)) return false;
  return SUBJECT_SUBHEADING_PATTERNS.some((pattern) => pattern.test(cleaned));
}

/**
 * Extracts structured institutional exam header lines (Organization/Exam Name, Post Name,
 * Time, Exam Date, Full Marks) so Smart Reader & A4 PDF can render an authentic
 * Bangladeshi government job exam paper masthead with balanced 3-zone metadata bar.
 */
export function parseStructuredExamHeader(
  headerLines: string[]
): StructuredExamHeader {
  const titleLines: string[] = [];
  let postLine: string | null = null;
  let timeText: string | null = null;
  let dateText: string | null = null;
  let marksText: string | null = null;
  const otherMetaLines: string[] = [];

  for (const raw of headerLines) {
    const line = (raw || '').replace(/\s+/g, ' ').trim();
    if (!line) continue;

    // Extract inline Time / Date / Marks segments if combined on a single header row
    const timeMatch = line.match(
      /(?:সময়|সময়|Time)\s*[:ঃ-]?\s*([০-৯0-9]+\s*(?:মিনিট|ঘণ্টা|ঘন্টা|min(?:utes?)?|hours?|hrs?)[^|,·]*?)(?=\s+(?:পরীক্ষার\s*তারিখ|তারিখ|Date|পূর্ণমান|মোট\s*নম্বর|Full\s*Marks|Total\s*Marks)|[|,·]|$)/i
    );
    const dateMatch = line.match(
      /(?:পরীক্ষার\s*তারিখ|তারিখ|Date)\s*[:ঃ-]?\s*([০-৯0-9./\-–—]+(?:\s+[অ-হA-Za-z]+(?:\s+[০-৯0-9]{4})?)?)(?=\s+(?:পূর্ণমান|সময়|সময়|Time|মোট\s*নম্বর|Full\s*Marks)|[|,·]|$)/i
    );
    const marksMatch = line.match(
      /(?:পূর্ণমান|মোট\s*নম্বর|Full\s*Marks|Total\s*Marks)\s*[:ঃ-]?\s*([০-৯0-9]+(?:\s*(?:নম্বর|marks?))?)/i
    );

    if (timeMatch || dateMatch || marksMatch) {
      if (timeMatch && !timeText) {
        timeText = `সময়: ${timeMatch[1].trim()}`;
      }
      if (dateMatch && !dateText) {
        dateText = `পরীক্ষার তারিখ: ${dateMatch[1].trim()}`;
      }
      if (marksMatch && !marksText) {
        marksText = `পূর্ণমান: ${marksMatch[1].trim()}`;
      }
      continue;
    }

    if (/^(?:পদের\s*নাম|পদ|Post(?:\s*Name)?)\s*[:ঃ-]/i.test(line) && !postLine) {
      postLine = line;
      continue;
    }

    if (titleLines.length < 2) {
      titleLines.push(line);
    } else {
      otherMetaLines.push(line);
    }
  }

  return {
    titleLines,
    postLine,
    timeText,
    dateText,
    marksText,
    otherMetaLines,
  };
}
