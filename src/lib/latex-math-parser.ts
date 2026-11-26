/**
 * Pure LaTeX Math Segmenter & Equation Extractor for KaTeX Rendering.
 *
 * Splits mixed Bengali/English + LaTeX exam strings into plain text segments and
 * KaTeX-ready math segments, safely wrapping Bengali script runs inside `\text{...}`
 * so KaTeX renders Bangladeshi competitive exam fractions (e.g. `\frac{১০}{১০০}`)
 * without missing-glyph warnings or raw LaTeX leaks.
 */

export type KatexTextSegment =
  | { kind: 'text'; value: string }
  | { kind: 'math'; latex: string; raw: string; displayMode: boolean };

export interface ExtractedLatexEquation {
  id: string;
  questionLabel: string;
  latex: string;
  displayMode: boolean;
  sourceLine: string;
}

const DOUBLE_ESCAPED_LATEX_RE =
  /\\\\(?=(?:d|t)?frac\b|sqrt\b|times\b|cdot\b|div\b|therefore\b|Rightarrow\b|implies\b|pm\b|leq?\b|geq?\b|neq?\b|approx\b|pi\b|theta\b|alpha\b|beta\b|degree\b|infty\b|left\b|right\b|text\b|%|\(|\)|\[|\])/g;

const BARE_LATEX_INDICATOR_RE =
  /\\(?:d|t)?frac\{|\\sqrt\{|\[\[frac:|\\(?:times|cdot|div|therefore|Rightarrow|implies|pm|leq?|geq?|neq?|approx|pi|theta|alpha|beta|infty)\b|[A-Za-z0-9০-৯)\]}]\^(?:\{[^}\n]+\}|[0-9০-৯a-zA-Z+-])|[A-Za-z0-9)\]}]_\{[^}\n]+\}|[A-Za-z]_[0-9a-zA-Z](?![_\w])/;

/**
 * Collapses accidental double-escaped JSON LaTeX commands (`\\frac` -> `\frac`)
 * and normalizes legacy `[[frac:num|den]]` syntax to standard `\frac{num}{den}`.
 */
export function normalizeRawLatexInput(input: string): string {
  if (!input) return '';
  return input
    .replace(DOUBLE_ESCAPED_LATEX_RE, '\\')
    .replace(
      /\[\[frac:([^|\]]+)\|([^\]]+)\]\]/g,
      (_m, num: string, den: string) => `\\frac{${num.trim()}}{${den.trim()}}`
    );
}

/**
 * Prepares a LaTeX expression for KaTeX rendering:
 * - Converts `[[frac:a|b]]` -> `\frac{a}{b}`
 * - Converts `\degree` -> `^\circ`
 * - Wraps bare Bengali script runs (e.g. `১০`, `গ.সা.গু`) in `\text{...}` so KaTeX
 *   renders Bengali numerals/labels inside equations without strict-mode warnings.
 */
export function prepareLatexForKatex(rawLatex: string): string {
  let out = normalizeRawLatexInput(rawLatex).trim();
  if (!out) return '';

  out = out.replace(/\\degree\b/g, '^{\\circ}');
  out = out.replace(/⇒/g, '\\Rightarrow ').replace(/∴/g, '\\therefore ');
  out = out.replace(/×/g, '\\times ').replace(/÷/g, '\\div ');
  out = out.replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ').replace(/≠/g, '\\neq ');

  // Wrap contiguous Bengali runs not already inside \text{...}
  let result = '';
  let i = 0;
  while (i < out.length) {
    if (out.startsWith('\\text{', i)) {
      const endBrace = findMatchingBrace(out, i + 5);
      if (endBrace !== -1) {
        result += out.slice(i, endBrace + 1);
        i = endBrace + 1;
        continue;
      }
    }
    if (/[\u0980-\u09FF]/.test(out[i])) {
      let j = i;
      while (j < out.length && /[\u0980-\u09FF]/.test(out[j])) {
        j += 1;
      }
      result += `\\text{${out.slice(i, j)}}`;
      i = j;
      continue;
    }
    result += out[i];
    i += 1;
  }

  return result;
}

function findMatchingBrace(text: string, openIdx: number): number {
  if (text[openIdx] !== '{') return -1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readBalancedCommand(
  text: string,
  startIdx: number,
  argCount: 1 | 2
): { expr: string; endIdx: number } | null {
  const braceStart = text.indexOf('{', startIdx);
  if (braceStart === -1) return null;
  let cursor = braceStart;
  for (let a = 0; a < argCount; a += 1) {
    while (cursor < text.length && text[cursor] === ' ') cursor += 1;
    if (text[cursor] !== '{') return null;
    const closeIdx = findMatchingBrace(text, cursor);
    if (closeIdx === -1) return null;
    cursor = closeIdx + 1;
  }
  return {
    expr: text.slice(startIdx, cursor),
    endIdx: cursor,
  };
}

/**
 * Parses bare (undelimited) LaTeX math atoms inside a plain-text chunk, such as
 * `\frac{3x+7}{4}`, `\sqrt{x^2+1}`, `x^{4}`, `a_{1}`, `\times`, `\therefore`, `\Rightarrow`.
 */
function parseBareLatexInPlainText(chunk: string): KatexTextSegment[] {
  if (!chunk || !BARE_LATEX_INDICATOR_RE.test(chunk)) {
    return chunk ? [{ kind: 'text', value: chunk }] : [];
  }

  const segments: KatexTextSegment[] = [];
  let textBuf = '';
  let i = 0;

  const flushText = () => {
    if (textBuf) {
      segments.push({ kind: 'text', value: textBuf });
      textBuf = '';
    }
  };

  while (i < chunk.length) {
    // 1. \frac{...}{...}, \dfrac{...}{...}, \tfrac{...}{...}
    const fracPrefix = chunk.slice(i).match(/^\\(?:d|t)?frac(?=\s*\{)/);
    if (fracPrefix) {
      const parsed = readBalancedCommand(chunk, i, 2);
      if (parsed) {
        flushText();
        segments.push({
          kind: 'math',
          latex: parsed.expr,
          raw: parsed.expr,
          displayMode: false,
        });
        i = parsed.endIdx;
        continue;
      }
    }

    // 2. \sqrt[n]{...} or \sqrt{...}
    const sqrtPrefix = chunk.slice(i).match(/^\\sqrt(?:\[[^\]]+\])?(?=\s*\{)/);
    if (sqrtPrefix) {
      const parsed = readBalancedCommand(chunk, i, 1);
      if (parsed) {
        flushText();
        segments.push({
          kind: 'math',
          latex: parsed.expr,
          raw: parsed.expr,
          displayMode: false,
        });
        i = parsed.endIdx;
        continue;
      }
    }

    // 3. Standalone LaTeX operator/symbol commands (\times, \div, \therefore, \Rightarrow, etc.)
    const symMatch = chunk
      .slice(i)
      .match(
        /^\\(?:times|cdot|div|therefore|Rightarrow|implies|pm|leq?|geq?|neq?|approx|pi|theta|alpha|beta|infty)\b/
      );
    if (symMatch) {
      flushText();
      segments.push({
        kind: 'math',
        latex: symMatch[0],
        raw: symMatch[0],
        displayMode: false,
      });
      i += symMatch[0].length;
      continue;
    }

    // 4. Base with exponent or subscript: e.g. x^{4}, y^2, a_{1}, (x+1)^{2}
    const scriptMatch = chunk
      .slice(i)
      .match(
        /^([A-Za-z0-9০-৯]+|\([^()\n]{1,24}\))((?:\^(?:\{[^}\n]+\}|[0-9০-৯a-zA-Z+-])|_(?:\{[^}\n]+\}|[0-9a-zA-Z](?![_\w])))+)/
      );
    if (scriptMatch) {
      // Skip fill-in-the-blank underscores
      const fullExpr = scriptMatch[0];
      if (!fullExpr.includes('__')) {
        flushText();
        segments.push({
          kind: 'math',
          latex: fullExpr,
          raw: fullExpr,
          displayMode: false,
        });
        i += fullExpr.length;
        continue;
      }
    }

    textBuf += chunk[i];
    i += 1;
  }

  flushText();
  return segments;
}

/**
 * Splits a text line containing mixed Bengali/English prose and LaTeX math
 * (`$$...$$`, `$...$`, `\(...\)`, `\[...\]`, or bare `\frac` / `\sqrt` / `x^2`)
 * into ordered plain-text and KaTeX math segments.
 */
export function parseTextIntoKatexSegments(input: string): KatexTextSegment[] {
  const normalized = normalizeRawLatexInput(input);
  if (!normalized) return [];

  const segments: KatexTextSegment[] = [];
  // Match explicit LaTeX delimiters first: $$...$$, \[...\], \(...\), $...$
  const delimiterRe =
    /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|\$([^$\n]+?)\$/g;

  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = delimiterRe.exec(normalized)) !== null) {
    const start = match.index;
    const full = match[0];

    // Protect currency spans like "$50 থেকে $100" or "$50 to $100" from being treated as inline LaTeX,
    // while allowing genuine numeric LaTeX tokens like "$5$", "$7$", "$2800$", or "$5 + 3 = 8$".
    if (match[4] !== undefined) {
      const innerTrim = match[4].trim();
      if (
        !innerTrim ||
        /^\d+(?:[.,]\d+)?\s+[A-Za-z\u0980-\u09FF]/.test(innerTrim)
      ) {
        continue;
      }
    }

    if (start > lastIdx) {
      segments.push(...parseBareLatexInPlainText(normalized.slice(lastIdx, start)));
    }

    const displayMode = match[1] !== undefined || match[2] !== undefined;
    const latex = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();

    if (latex) {
      segments.push({
        kind: 'math',
        latex,
        raw: full,
        displayMode,
      });
    }

    lastIdx = start + full.length;
  }

  if (lastIdx < normalized.length) {
    segments.push(...parseBareLatexInPlainText(normalized.slice(lastIdx)));
  }

  return segments;
}

/**
 * Extracts all unique LaTeX equations from an exam paper for side-by-side visual
 * verification inside Question Lab's KaTeX Equation Verifier.
 */
export function extractLatexEquationsFromText(
  content: string
): ExtractedLatexEquation[] {
  const normalized = normalizeRawLatexInput(content);
  if (!normalized.trim()) return [];

  const lines = normalized.split('\n');
  const results: ExtractedLatexEquation[] = [];
  const seen = new Set<string>();
  let currentQLabel = 'সাধারণ';

  const qHeaderRe = /^((?:0?[1-9]|[1-9]\d{1,2}|[০-৯]{1,3})[.\u0964])\s+/;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx].trim();
    if (!line) continue;

    const qMatch = line.match(qHeaderRe);
    if (qMatch) {
      currentQLabel = qMatch[1];
    }

    const segments = parseTextIntoKatexSegments(line);
    const mathSegs = segments.filter(
      (s): s is Extract<KatexTextSegment, { kind: 'math' }> => s.kind === 'math'
    );

    if (mathSegs.length === 0) continue;

    // If the line had explicit delimited math ($...$ / $$...$$), extract each equation directly.
    const hasExplicitDelimited = mathSegs.some(
      (m) => m.raw.startsWith('$') || m.raw.startsWith('\\(') || m.raw.startsWith('\\[')
    );

    if (hasExplicitDelimited) {
      for (const m of mathSegs) {
        const key = `${currentQLabel}::${m.latex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          id: `eq-${results.length + 1}`,
          questionLabel: currentQLabel,
          latex: m.latex,
          displayMode: m.displayMode,
          sourceLine: line,
        });
      }
    } else {
      // Combine bare math line cleanly (strip leading question/solution prefix for verification)
      const cleanedExpr = line
        .replace(qHeaderRe, '')
        .replace(/^(?:সমাধান\s+করুন|মান\s+নির্ণয়\s+করুন|উৎপাদকে\s*বিশ্লেষণ\s+করুন|সমাধান|উত্তর|Solution|Answer)\s*[:ঃ]\s*/i, '')
        .trim();

      if (!cleanedExpr) continue;
      // Only include expressions that actually contain LaTeX structure
      if (!BARE_LATEX_INDICATOR_RE.test(cleanedExpr)) continue;

      const key = `${currentQLabel}::${cleanedExpr}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        id: `eq-${results.length + 1}`,
        questionLabel: currentQLabel,
        latex: cleanedExpr,
        displayMode: false,
        sourceLine: line,
      });
    }
  }

  return results;
}
