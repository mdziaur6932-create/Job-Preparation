export type TableAlignment = 'left' | 'center' | 'right';

export interface ParsedMarkdownTable {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

export type RichContentBlock =
  | { kind: 'line'; text: string }
  | { kind: 'blank' }
  | { kind: 'table'; table: ParsedMarkdownTable };

export interface InlineRichSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

const REFERENCE_LINE_PREFIX_RE = /^(?:রেফারেন্স|Reference|উৎস)\s*[:ঃ]/i;

/**
 * Splits a Markdown table row into trimmed cell strings while respecting
 * escaped pipes (`\|`) and internal math fraction markers (`[[frac:a|b]]`).
 */
export function splitMarkdownTableRow(line: string): string[] {
  let trimmed = (line ?? '').trim();
  if (!trimmed) return [];

  // Strip optional leading and trailing unescaped pipes
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';
  let bracketDepth = 0;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '[' && trimmed[i + 1] === '[') {
      bracketDepth += 1;
      current += '[[';
      i += 1;
      continue;
    }
    if (ch === ']' && trimmed[i + 1] === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      current += ']]';
      i += 1;
      continue;
    }
    if (ch === '|' && bracketDepth === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Returns true if the line is a Markdown table separator row such as
 * `| --- | :---: | ---: |` or `--- | ---`.
 */
export function isMarkdownTableSeparatorLine(line: string): boolean {
  const trimmed = (line ?? '').trim();
  if (!trimmed || !trimmed.includes('|') || !trimmed.includes('-')) {
    return false;
  }
  const cells = splitMarkdownTableRow(trimmed);
  if (cells.length < 2) return false;
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')));
}

/**
 * Returns true if a line looks like a Markdown pipe-table row (and NOT a reference
 * link list or a math fraction containing `[[frac:a|b]]`).
 */
export function isMarkdownTableLine(line: string): boolean {
  const trimmed = (line ?? '').trim();
  if (!trimmed) return false;
  if (REFERENCE_LINE_PREFIX_RE.test(trimmed)) return false;

  // Mask out `[[frac:a|b]]` so internal math pipes never look like tables
  const masked = trimmed.replace(/\[\[frac:[^\]\n]+\]\]/g, 'FRAC');
  if (!masked.includes('|')) return false;

  if (isMarkdownTableSeparatorLine(trimmed)) return true;

  const cells = splitMarkdownTableRow(trimmed);
  if (cells.length < 2) return false;

  // Strong table signal: bounded by outer pipes `| col1 | col2 |`
  if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
    return cells.some((c) => c.length > 0);
  }

  // Secondary signal: unenclosed table row with >= 2 pipes (3+ columns),
  // avoiding exam metadata lines like `সময়: ১ ঘণ্টা | পূর্ণমান: ১০০`
  const unescapedPipes = masked.replace(/\\\|/g, '').match(/\|/g) ?? [];
  if (unescapedPipes.length >= 2) {
    if (/(?:সময়|সময়|তারিখ|পূর্ণমান|মোট\s*নম্বর)\s*[:ঃ]/.test(trimmed)) {
      return false;
    }
    return cells.every((c) => c.length > 0);
  }

  return false;
}

function parseAlignments(separatorLine: string, colCount: number): TableAlignment[] {
  const cells = splitMarkdownTableRow(separatorLine);
  const alignments: TableAlignment[] = [];
  for (let i = 0; i < colCount; i += 1) {
    const raw = (cells[i] ?? '').replace(/\s+/g, '');
    const startsColon = raw.startsWith(':');
    const endsColon = raw.endsWith(':');
    if (startsColon && endsColon) {
      alignments.push('center');
    } else if (endsColon) {
      alignments.push('right');
    } else {
      alignments.push('left');
    }
  }
  return alignments;
}

function normalizeRowToColumnCount(cells: string[], colCount: number): string[] {
  if (cells.length === colCount) return cells;
  if (cells.length < colCount) {
    return [...cells, ...Array.from({ length: colCount - cells.length }, () => '')];
  }
  const head = cells.slice(0, colCount - 1);
  const tail = cells.slice(colCount - 1).join(' | ');
  return [...head, tail];
}

/**
 * Parses a contiguous block of Markdown table lines into headers, alignments, and rows.
 * Supports standard GFM tables (header + separator + body) as well as pipe-bounded OCR
 * tables where the separator row was omitted.
 */
export function parseMarkdownTableBlock(rawLines: string[]): ParsedMarkdownTable | null {
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const headerCells = splitMarkdownTableRow(lines[0]);
  if (headerCells.length < 2) return null;

  // Standard GFM table with separator on line 1
  if (isMarkdownTableSeparatorLine(lines[1])) {
    const rawBodyRows: string[][] = [];
    for (let i = 2; i < lines.length; i += 1) {
      if (isMarkdownTableSeparatorLine(lines[i])) continue;
      const cells = splitMarkdownTableRow(lines[i]);
      if (cells.length === 0) continue;
      rawBodyRows.push(cells);
    }
    const maxObservedCols = rawBodyRows.reduce(
      (max, cells) => Math.max(max, Math.min(cells.length, headerCells.length + 3)),
      headerCells.length
    );
    const colCount = Math.max(headerCells.length, maxObservedCols);
    const paddedHeaders = normalizeRowToColumnCount(headerCells, colCount);
    const alignments = parseAlignments(lines[1], colCount);
    const rows = rawBodyRows.map((cells) => normalizeRowToColumnCount(cells, colCount));
    return {
      headers: paddedHeaders,
      alignments,
      rows,
    };
  }

  // Fallback for pipe-bounded tables missing a `| --- | --- |` separator row
  const allPipeBounded = lines.every((l) => l.startsWith('|') && l.endsWith('|'));
  if (!allPipeBounded) return null;

  const colCount = headerCells.length;
  const bodyRows: string[][] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitMarkdownTableRow(lines[i]);
    if (cells.length !== colCount) return null;
    bodyRows.push(cells);
  }

  return {
    headers: headerCells,
    alignments: Array.from({ length: colCount }, () => 'left' as TableAlignment),
    rows: bodyRows,
  };
}

/**
 * Serializes a parsed table back into canonical GitHub-Flavored Markdown table syntax.
 */
export function serializeMarkdownTable(table: ParsedMarkdownTable): string {
  const escapeCell = (val: string) => (val ?? '').replace(/\|/g, '\\|').trim();
  const headerLine = `| ${table.headers.map(escapeCell).join(' | ')} |`;
  const sepLine = `| ${table.headers
    .map((_, idx) => {
      const align = table.alignments[idx] ?? 'left';
      if (align === 'center') return ':---:';
      if (align === 'right') return '---:';
      return '---';
    })
    .join(' | ')} |`;
  const rowLines = table.rows.map(
    (row) => `| ${normalizeRowToColumnCount(row, table.headers.length).map(escapeCell).join(' | ')} |`
  );
  return [headerLine, sepLine, ...rowLines].join('\n');
}

/**
 * Renders a Markdown table into clean, column-aligned plain text for `.txt` export.
 */
export function formatMarkdownTableAsPlainText(table: ParsedMarkdownTable): string {
  const colCount = table.headers.length;
  const cleanHeaders = table.headers.map((h) => stripInlineRichMarkup(h));
  const cleanRows = table.rows.map((row) =>
    normalizeRowToColumnCount(row, colCount).map((c) => stripInlineRichMarkup(c))
  );

  const widths = cleanHeaders.map((h, idx) => {
    const maxCell = Math.max(
      Array.from(h).length,
      ...cleanRows.map((r) => Array.from(r[idx] ?? '').length)
    );
    return Math.min(40, Math.max(3, maxCell));
  });

  const padCell = (value: string, width: number) => {
    const len = Array.from(value).length;
    return len >= width ? value : `${value}${' '.repeat(width - len)}`;
  };

  const formatRow = (cells: string[]) =>
    `| ${cells.map((c, idx) => padCell(c, widths[idx])).join(' | ')} |`;
  const sep = `|-${widths.map((w) => '-'.repeat(w)).join('-|-')}-|`;

  return [formatRow(cleanHeaders), sep, ...cleanRows.map(formatRow)].join('\n');
}

const INLINE_TABLE_SEPARATOR_RE =
  /\|\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)+\s*\|/;

/**
 * Recovers two common OCR/LLM Markdown table defects deterministically:
 * 1. Flattened single-line tables glued onto prose or `ব্যাখ্যা:` lines:
 *    `ব্যাখ্যা: ... আসে। | নাম | বর্ণ | | --- | --- | | মৌলিক স্বরবর্ণ | অ, আ |`
 *    -> detaches prose onto its own line and splits every `| |` row boundary onto new lines.
 * 2. Blank lines inserted between every Markdown table row:
 *    `| বিপ্লবের নাম | সময়কাল |\n\n| --- | --- |\n\n| ফরাসি বিপ্লব | ১৭৮৯ |`
 *    -> collapses inter-row blank lines so the table parses as one contiguous GFM block.
 *
 * Strictly protects `রেফারেন্স:` lines and `[[frac:a|b]]` math markers.
 */
export function normalizeBrokenMarkdownTables(text: string): string {
  if (!text || !text.includes('|')) {
    return text ?? '';
  }

  // Pass 1: Split inline flattened multi-row pipe tables onto separate lines
  const expandedLines: string[] = [];
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed || REFERENCE_LINE_PREFIX_RE.test(trimmed)) {
      expandedLines.push(rawLine);
      continue;
    }

    // Mask `[[frac:...]]` so internal math pipes never interfere
    const fracTokens: string[] = [];
    const masked = rawLine.replace(/\[\[frac:[^\]\n]+\]\]/g, (m) => {
      const key = `@@FRACTOK${fracTokens.length}@@`;
      fracTokens.push(m);
      return key;
    });

    const restoreFracs = (s: string) =>
      fracTokens.length === 0
        ? s
        : s.replace(/@@FRACTOK(\d+)@@/g, (_m, i) => fracTokens[Number(i)] ?? '');

    const hasInlineSep = INLINE_TABLE_SEPARATOR_RE.test(masked);
    const doublePipeBoundaries = masked.match(/\|[ \t]*\|(?![ \t]*\|)/g) ?? [];
    const looksLikeFlattenedMultiRowTable =
      hasInlineSep ||
      (doublePipeBoundaries.length >= 2 &&
        masked.trim().endsWith('|') &&
        /(?:^|\s)\|[^|\n]+\|[^|\n]+\|/.test(masked));

    if (!looksLikeFlattenedMultiRowTable) {
      expandedLines.push(rawLine);
      continue;
    }

    // Find where the inline table begins on this line
    const firstPipeIdx = masked.indexOf('|');
    const prefix = firstPipeIdx > 0 ? masked.slice(0, firstPipeIdx).trim() : '';
    const tablePart = masked.slice(Math.max(0, firstPipeIdx)).trim();

    if (prefix) {
      expandedLines.push(restoreFracs(prefix));
    }

    // Split row boundaries `| |` AND zero-space `||` into separate lines while keeping empty cells (`| | |`) intact
    const splitRows = tablePart
      .replace(/\|[ \t]*\|(?![ \t]*\|)/g, '|\n|')
      .split('\n')
      .map((r) => restoreFracs(r.trim()))
      .filter((r) => r.length > 0 && r !== '|');

    expandedLines.push(...splitRows);
  }

  // Pass 2: Collapse blank lines sitting strictly BETWEEN consecutive Markdown table rows
  const isTableishLine = (line: string): boolean => {
    const t = line.trim();
    if (!t) return false;
    return isMarkdownTableLine(t) || isMarkdownTableSeparatorLine(t);
  };

  const collapsedLines: string[] = [];
  for (let i = 0; i < expandedLines.length; i += 1) {
    const current = expandedLines[i];
    if (current.trim() !== '') {
      collapsedLines.push(current);
      continue;
    }

    // Look backward for last non-blank line and forward for next non-blank line
    let prevNonBlank = '';
    for (let p = collapsedLines.length - 1; p >= 0; p -= 1) {
      if (collapsedLines[p].trim() !== '') {
        prevNonBlank = collapsedLines[p];
        break;
      }
    }
    let nextNonBlank = '';
    for (let n = i + 1; n < expandedLines.length; n += 1) {
      if (expandedLines[n].trim() !== '') {
        nextNonBlank = expandedLines[n];
        break;
      }
    }

    const prevLooksTable =
      isTableishLine(prevNonBlank) ||
      (prevNonBlank.includes('|') && isMarkdownTableSeparatorLine(nextNonBlank));
    const nextLooksTable = isTableishLine(nextNonBlank);

    if (prevLooksTable && nextLooksTable) {
      // Drop blank gap between rows of the same table
      continue;
    }

    collapsedLines.push(current);
  }

  return collapsedLines.join('\n');
}

/**
 * Splits general multi-line text (e.g. non-exam textbook pages) into paragraphs
 * and structured Markdown tables.
 */
export function splitTextBlocksWithTables(text: string): RichContentBlock[] {
  const repaired = normalizeBrokenMarkdownTables(text ?? '');
  const lines = repaired.replace(/\r\n/g, '\n').split('\n');
  const blocks: RichContentBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      blocks.push({ kind: 'blank' });
      i += 1;
      continue;
    }

    if (
      isMarkdownTableLine(trimmed) ||
      (i + 1 < lines.length &&
        trimmed.includes('|') &&
        isMarkdownTableSeparatorLine(lines[i + 1]))
    ) {
      const tableLines: string[] = [];
      let j = i;
      while (
        j < lines.length &&
        lines[j].trim() &&
        (isMarkdownTableLine(lines[j]) ||
          (j === i &&
            i + 1 < lines.length &&
            isMarkdownTableSeparatorLine(lines[i + 1])))
      ) {
        tableLines.push(lines[j]);
        j += 1;
      }

      const parsedTable = parseMarkdownTableBlock(tableLines);
      if (parsedTable) {
        blocks.push({ kind: 'table', table: parsedTable });
        i = j;
        continue;
      }
    }

    blocks.push({ kind: 'line', text: line });
    i += 1;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Safe Inline Rich-Text Parser (**bold**, *italic*, ***bold italic***, <u>underline</u>)
// Zero `dangerouslySetInnerHTML`, strictly preserves `_____` fill-in-the-blanks
// and spaced math operators like `2 * 3 * 5`.
// ---------------------------------------------------------------------------

interface StyleState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

function findMatchingHtmlClose(
  input: string,
  tagName: string,
  fromIndex: number
): { closeStart: number; closeEnd: number } | null {
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'gi');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  let depth = 1;
  let pos = fromIndex;

  while (pos < input.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const nextOpen = openRe.exec(input);
    const nextClose = closeRe.exec(input);

    if (!nextClose) return null;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      pos = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      if (depth === 0) {
        return {
          closeStart: nextClose.index,
          closeEnd: nextClose.index + nextClose[0].length,
        };
      }
      pos = nextClose.index + nextClose[0].length;
    }
  }
  return null;
}

function findClosingDelimiter(
  input: string,
  delim: '***' | '**' | '*',
  fromIndex: number
): number {
  const len = delim.length;
  // Opening delimiter must be immediately followed by a non-whitespace, non-asterisk character
  const firstChar = input[fromIndex];
  if (!firstChar || /\s/.test(firstChar) || firstChar === '*') {
    return -1;
  }

  let i = fromIndex;
  while (i <= input.length - len) {
    if (input[i] === '\\') {
      i += 2;
      continue;
    }
    if (input.slice(i, i + len) === delim) {
      const prevChar = input[i - 1];
      const nextChar = input[i + len];
      // For single `*`, avoid matching inside `**`
      if (delim === '*' && (prevChar === '*' || nextChar === '*')) {
        i += 1;
        continue;
      }
      // Closing delimiter must be immediately preceded by a non-whitespace character
      if (prevChar && !/\s/.test(prevChar)) {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

function parseRichSpansRecursive(
  input: string,
  style: StyleState,
  out: InlineRichSpan[]
): void {
  const pushText = (text: string, s: StyleState) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === s.bold &&
      last.italic === s.italic &&
      last.underline === s.underline
    ) {
      last.text += text;
    } else {
      out.push({
        text,
        bold: s.bold,
        italic: s.italic,
        underline: s.underline,
      });
    }
  };

  let buffer = '';
  let i = 0;

  const flushBuffer = () => {
    if (buffer) {
      pushText(buffer, style);
      buffer = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // 1. HTML emphasis tags: <u>, <b>, <strong>, <i>, <em> (and stray closing tags)
    if (ch === '<') {
      const openTagMatch = input
        .slice(i)
        .match(/^<(u|b|strong|i|em)(?:\s[^>]*)?>/i);
      if (openTagMatch) {
        const tag = openTagMatch[1].toLowerCase();
        const innerStart = i + openTagMatch[0].length;
        const closing = findMatchingHtmlClose(input, tag, innerStart);
        if (closing) {
          flushBuffer();
          const inner = input.slice(innerStart, closing.closeStart);
          const nextStyle: StyleState = {
            bold: style.bold || tag === 'b' || tag === 'strong',
            italic: style.italic || tag === 'i' || tag === 'em',
            underline: style.underline || tag === 'u',
          };
          parseRichSpansRecursive(inner, nextStyle, out);
          i = closing.closeEnd;
          continue;
        }
      }
    }

    // 2. Markdown bold+italic `***...***`, bold `**...**`, italic `*...*`
    if (ch === '*') {
      // Avoid triggering italic on bullet `* item` or spaced multiplication `2 * 3`
      if (input.startsWith('***', i)) {
        const closeIdx = findClosingDelimiter(input, '***', i + 3);
        if (closeIdx !== -1) {
          flushBuffer();
          const inner = input.slice(i + 3, closeIdx);
          parseRichSpansRecursive(
            inner,
            { ...style, bold: true, italic: true },
            out
          );
          i = closeIdx + 3;
          continue;
        }
      }

      if (input.startsWith('**', i) && !input.startsWith('***', i)) {
        const closeIdx = findClosingDelimiter(input, '**', i + 2);
        if (closeIdx !== -1) {
          flushBuffer();
          const inner = input.slice(i + 2, closeIdx);
          parseRichSpansRecursive(inner, { ...style, bold: true }, out);
          i = closeIdx + 2;
          continue;
        }
      }

      if (!input.startsWith('**', i)) {
        const prev = i > 0 ? input[i - 1] : '';
        // Do not start italic mid-word unless preceded by boundary/punctuation/opening tag
        const validStartBoundary =
          i === 0 || /[\s([{"'‘’“”\-–—:;,।/\\>]/.test(prev);
        if (validStartBoundary) {
          const closeIdx = findClosingDelimiter(input, '*', i + 1);
          if (closeIdx !== -1) {
            const afterClose = input[closeIdx + 1] ?? '';
            const validEndBoundary =
              !afterClose || /[\s)\]}"'‘’“”.,;:!?।\-–—/<]/.test(afterClose);
            if (validEndBoundary) {
              flushBuffer();
              const inner = input.slice(i + 1, closeIdx);
              parseRichSpansRecursive(inner, { ...style, italic: true }, out);
              i = closeIdx + 1;
              continue;
            }
          }
        }
      }
    }

    buffer += ch;
    i += 1;
  }

  flushBuffer();
}

/**
 * Parses inline OCR rich-text emphasis (`**bold**`, `*italic*`, `***bold italic***`,
 * `<u>underlined</u>`, `<b>`, `<strong>`, `<i>`, `<em>`) into flat styled spans.
 * Strictly preserves fill-in-the-blank underscores (`_____`) and spaced math (`2 * 3`).
 */
export function parseInlineRichText(text: string): InlineRichSpan[] {
  if (!text) return [];
  // Fast path when no rich markers exist
  if (!text.includes('*') && !text.includes('<')) {
    return [{ text, bold: false, italic: false, underline: false }];
  }
  const spans: InlineRichSpan[] = [];
  parseRichSpansRecursive(
    text,
    { bold: false, italic: false, underline: false },
    spans
  );
  return spans;
}

/**
 * Returns plain readable text with `**`, `*`, `<u>`, `<b>`, `<i>`, etc. stripped,
 * useful for visual width estimation and plain-text `.txt` export.
 */
export function stripInlineRichMarkup(text: string): string {
  if (!text) return '';
  if (!text.includes('*') && !text.includes('<')) return text;
  return parseInlineRichText(text)
    .map((span) => span.text)
    .join('');
}
