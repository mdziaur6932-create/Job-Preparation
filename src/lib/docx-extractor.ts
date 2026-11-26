import JSZip from 'jszip';
import {
  LEGACY_DOC_UNSUPPORTED_ERROR,
  MAX_UPLOAD_BYTES,
  formatFileTooLargeError,
  isLegacyOleDocSignature,
  toBengaliNumber,
} from './file-validation';
import {
  evaluateLocalExtractedPageText,
  isMeaningfulPageContent,
  parseOriginalPageRangeSyntax,
  stripPageMarkersAndHeaders,
  type CombinedExtractionResult,
  type ExtractedSectionItem,
} from './pdf-rules';

const MAX_DOCX_XML_CHARS = 30_000_000; // 30 MB XML safety ceiling against zip bombs
const LOGICAL_PAGE_TARGET_CHARS = 1800;

export type DocxExtractionOutcome =
  | {
      ok: true;
      extraction: CombinedExtractionResult;
      headingCount: number;
      tableCount: number;
      usedExplicitPageBreaks: boolean;
    }
  | {
      ok: false;
      error: string;
      code:
        | 'EMPTY_FILE'
        | 'FILE_TOO_LARGE'
        | 'LEGACY_DOC_FORMAT'
        | 'INVALID_DOCX'
        | 'IMAGE_ONLY_DOCX'
        | 'GARBLED_ENCODING'
        | 'NO_READABLE_TEXT';
    };

interface ParsedDocxBlock {
  kind: 'heading' | 'paragraph' | 'table' | 'page_break';
  text: string;
}

function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          const code = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
        }
        if (entity.startsWith('#')) {
          const code = Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
        }
        return match;
      }
    }
  });
}

function hasZipMagicBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

function isHeadingParagraphXml(pXml: string): boolean {
  const pPrMatch = pXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/);
  if (!pPrMatch) return false;
  const pPr = pPrMatch[1];

  // Match Heading1..Heading6, Title, Subtitle, or localized style IDs containing "heading"
  const styleMatch = pPr.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/i);
  if (styleMatch) {
    const styleVal = styleMatch[1].trim().toLowerCase();
    if (
      /^heading\s*[1-6]$/.test(styleVal) ||
      styleVal === 'title' ||
      styleVal === 'subtitle' ||
      styleVal.includes('heading')
    ) {
      return true;
    }
  }

  // Also respect explicit OOXML outline levels 0..2 (Heading 1..3)
  const outlineMatch = pPr.match(/<w:outlineLvl\b[^>]*\bw:val="([0-2])"/i);
  return Boolean(outlineMatch);
}

function extractInlineTextAndPageBreaksFromParagraph(pXml: string): {
  segments: string[];
  hasPageBreak: boolean;
} {
  // Split around explicit page breaks inside runs while preserving text before/after the break
  const tokenRegex =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\b([^>]*)\/>|<w:cr\s*\/>|<w:lastRenderedPageBreak\s*\/>/g;

  const segments: string[] = [''];
  let hasPageBreak = false;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(pXml)) !== null) {
    const full = match[0];
    if (full.startsWith('<w:t')) {
      segments[segments.length - 1] += decodeXmlEntities(match[1] ?? '');
    } else if (full.startsWith('<w:tab')) {
      segments[segments.length - 1] += '  ';
    } else if (full.startsWith('<w:cr')) {
      segments[segments.length - 1] += '\n';
    } else if (full.startsWith('<w:lastRenderedPageBreak')) {
      hasPageBreak = true;
      segments.push('');
    } else if (full.startsWith('<w:br')) {
      const attrs = match[2] ?? '';
      if (/w:type="page"/i.test(attrs)) {
        hasPageBreak = true;
        segments.push('');
      } else {
        segments[segments.length - 1] += '\n';
      }
    }
  }

  // Also detect paragraph-level "pageBreakBefore" property
  const hasPageBreakBefore = /<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")/i.test(pXml);
  if (hasPageBreakBefore) {
    hasPageBreak = true;
    segments.unshift('');
  }

  return { segments, hasPageBreak };
}

function extractParagraphPlainText(pXml: string): string {
  const { segments } = extractInlineTextAndPageBreaksFromParagraph(pXml);
  return segments
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTableText(tblXml: string): string {
  const rowMatches = tblXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
  const rowLines: string[] = [];

  for (const rowXml of rowMatches) {
    const cellMatches = rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [];
    const cellTexts: string[] = [];
    for (const cellXml of cellMatches) {
      const pMatches = cellXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
      const joinedCell = pMatches
        .map((p) => extractParagraphPlainText(p))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (joinedCell) {
        cellTexts.push(joinedCell);
      }
    }
    if (cellTexts.length > 0) {
      rowLines.push(cellTexts.join(' | '));
    }
  }

  return rowLines.join('\n').trim();
}

/**
 * Parses `word/document.xml` body blocks in strict document order without requiring
 * browser DOMParser or native Node XML extensions.
 */
function parseDocumentXmlBlocks(documentXml: string): {
  blocks: ParsedDocxBlock[];
  headingCount: number;
  tableCount: number;
  hasEmbeddedImages: boolean;
} {
  const bodyMatch = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  const bodyXml = bodyMatch ? bodyMatch[1] : documentXml;

  const hasEmbeddedImages =
    /<w:drawing\b|<a:blip\b|<v:imagedata\b|<w:pict\b/i.test(bodyXml);

  const blocks: ParsedDocxBlock[] = [];
  let headingCount = 0;
  let tableCount = 0;

  // Match top-level tables first (so paragraphs inside tables are not double-parsed),
  // otherwise match standalone paragraphs.
  const blockRegex = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(bodyXml)) !== null) {
    const chunk = match[0];
    if (chunk.startsWith('<w:tbl')) {
      const tableText = extractTableText(chunk);
      if (tableText) {
        tableCount += 1;
        blocks.push({ kind: 'table', text: tableText });
      }
      continue;
    }

    const isHeading = isHeadingParagraphXml(chunk);
    const { segments, hasPageBreak } = extractInlineTextAndPageBreaksFromParagraph(chunk);

    if (!hasPageBreak) {
      const text = segments
        .join('\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!text) continue;

      if (isHeading && text.length <= 160) {
        headingCount += 1;
        blocks.push({ kind: 'heading', text });
      } else {
        blocks.push({ kind: 'paragraph', text });
      }
    } else {
      for (let i = 0; i < segments.length; i += 1) {
        if (i > 0) {
          blocks.push({ kind: 'page_break', text: '' });
        }
        const segText = segments[i]
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (!segText) continue;
        if (isHeading && segText.length <= 160 && i === segments.length - 1) {
          headingCount += 1;
          blocks.push({ kind: 'heading', text: segText });
        } else {
          blocks.push({ kind: 'paragraph', text: segText });
        }
      }
    }
  }

  return {
    blocks,
    headingCount,
    tableCount,
    hasEmbeddedImages,
  };
}

interface RawDocxPageBucket {
  chapter: string;
  parts: string[];
}

function buildDocxPages(
  blocks: ParsedDocxBlock[],
  fallbackChapter: string
): { pages: Array<{ chapter: string; content: string }>; usedExplicitPageBreaks: boolean } {
  const explicitPageBreaksCount = blocks.filter((b) => b.kind === 'page_break').length;

  // Strategy A: Respect explicit Word page breaks if they divide the document into 2+ readable pages
  if (explicitPageBreaksCount > 0) {
    const buckets: RawDocxPageBucket[] = [];
    let currentChapter = fallbackChapter;
    let currentParts: string[] = [];
    let pageChapter = currentChapter;

    const flush = () => {
      const joined = currentParts.join('\n\n').trim();
      if (joined && isMeaningfulPageContent(joined)) {
        buckets.push({ chapter: pageChapter, parts: [joined] });
      }
      currentParts = [];
      pageChapter = currentChapter;
    };

    for (const block of blocks) {
      if (block.kind === 'page_break') {
        flush();
        continue;
      }
      if (block.kind === 'heading') {
        currentChapter = block.text;
        if (currentParts.length === 0) {
          pageChapter = currentChapter;
        }
        currentParts.push(block.text);
      } else if (block.text) {
        currentParts.push(block.text);
      }
    }
    flush();

    if (buckets.length >= 2) {
      return {
        pages: buckets.map((b) => ({
          chapter: b.chapter,
          content: b.parts.join('\n\n').trim(),
        })),
        usedExplicitPageBreaks: true,
      };
    }
  }

  // Strategy B: No meaningful explicit page breaks — split cleanly by headings & ~1800-char logical pages
  const pages: Array<{ chapter: string; content: string }> = [];
  let currentChapter = fallbackChapter;
  let pageChapter = fallbackChapter;
  let currentParts: string[] = [];
  let currentChars = 0;

  const flush = () => {
    const joined = currentParts.join('\n\n').trim();
    if (joined && isMeaningfulPageContent(joined)) {
      pages.push({ chapter: pageChapter, content: joined });
    }
    currentParts = [];
    currentChars = 0;
    pageChapter = currentChapter;
  };

  for (const block of blocks) {
    if (block.kind === 'page_break') continue;

    if (block.kind === 'heading') {
      // Start a fresh section when a new heading arrives after substantial text
      if (currentChars >= 350) {
        flush();
      }
      currentChapter = block.text;
      if (currentParts.length === 0) {
        pageChapter = currentChapter;
      }
      currentParts.push(block.text);
      currentChars += block.text.length;
      continue;
    }

    if (!block.text) continue;

    if (currentChars > 0 && currentChars + block.text.length > LOGICAL_PAGE_TARGET_CHARS) {
      flush();
    }

    if (currentParts.length === 0) {
      pageChapter = currentChapter;
    }
    currentParts.push(block.text);
    currentChars += block.text.length + 2;
  }
  flush();

  return {
    pages,
    usedExplicitPageBreaks: false,
  };
}

/**
 * Extracts structured chapters, paragraphs, tables, and logical/explicit pages from a `.docx`
 * Word file completely locally (0 Gemini API calls, 0 quota cost).
 * Works identically in the browser, Next.js server routes, and Node.js unit tests.
 */
export async function extractDocxDocument(params: {
  bytes: Uint8Array;
  fileName?: string;
  fallbackChapter?: string;
  pageRangeInput?: string | null;
  maxBytes?: number;
}): Promise<DocxExtractionOutcome> {
  const maxBytes = params.maxBytes ?? MAX_UPLOAD_BYTES;
  const bytes = params.bytes;

  if (!bytes || bytes.byteLength === 0) {
    return {
      ok: false,
      code: 'EMPTY_FILE',
      error: 'নির্বাচিত Word (.docx) ফাইলটি খালি। অনুগ্রহ করে একটি বৈধ .docx ফাইল আপলোড করুন।',
    };
  }

  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: formatFileTooLargeError(bytes.byteLength, maxBytes),
    };
  }

  if (isLegacyOleDocSignature(bytes)) {
    return {
      ok: false,
      code: 'LEGACY_DOC_FORMAT',
      error: LEGACY_DOC_UNSUPPORTED_ERROR,
    };
  }

  if (!hasZipMagicBytes(bytes)) {
    return {
      ok: false,
      code: 'INVALID_DOCX',
      error:
        'ফাইলটি বৈধ Word (.docx) ফরম্যাটে নেই। অনুগ্রহ করে সঠিক .docx ফাইল নির্বাচন করুন।',
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return {
      ok: false,
      code: 'INVALID_DOCX',
      error:
        'Word (.docx) ফাইলটি ত্রুটিপূর্ণ বা পাসওয়ার্ড-সুরক্ষিত। অনুগ্রহ করে একটি বৈধ ও আনলকড .docx ফাইল আপলোড করুন।',
    };
  }

  const documentEntry = zip.file('word/document.xml');
  if (!documentEntry) {
    return {
      ok: false,
      code: 'INVALID_DOCX',
      error:
        'এই ফাইলটিতে বৈধ Word ডকুমেন্ট (word/document.xml) পাওয়া যায়নি। অনুগ্রহ করে সঠিক .docx ফাইল আপলোড করুন।',
    };
  }

  let documentXml: string;
  try {
    documentXml = await documentEntry.async('string');
  } catch {
    return {
      ok: false,
      code: 'INVALID_DOCX',
      error:
        'Word (.docx) ফাইলটির ভেতরের টেক্সট পড়া সম্ভব হয়নি। অনুগ্রহ করে ফাইলটি পুনরায় সেভ করে চেষ্টা করুন।',
    };
  }

  if (documentXml.length > MAX_DOCX_XML_CHARS) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error:
        'Word (.docx) ফাইলটির ভেতরের XML ডেটা নিরাপদ সীমার চেয়ে অতিরিক্ত বড়। অনুগ্রহ করে ফাইলটি ছোট অংশে ভাগ করে আপলোড করুন।',
    };
  }

  const fallbackChapter = params.fallbackChapter?.trim() || 'অধ্যায় ১: মূল আলোচনা';
  const parsed = parseDocumentXmlBlocks(documentXml);
  const { pages, usedExplicitPageBreaks } = buildDocxPages(parsed.blocks, fallbackChapter);

  const combinedSampleText = pages.map((p) => p.content).join('\n\n').trim();
  const substantiveText = stripPageMarkersAndHeaders(combinedSampleText);

  if (!substantiveText || pages.length === 0) {
    if (parsed.hasEmbeddedImages) {
      return {
        ok: false,
        code: 'IMAGE_ONLY_DOCX',
        error:
          'এই Word (.docx) ফাইলটিতে সরাসরি কোনো টেক্সট নেই—শুধু স্ক্যান করা ছবি রয়েছে। স্বয়ংক্রিয় AI OCR-এর জন্য ফাইলটি Word/Google Docs থেকে PDF হিসেবে সেভ করে আপলোড করুন।',
      };
    }
    return {
      ok: false,
      code: 'NO_READABLE_TEXT',
      error:
        'Word (.docx) ফাইলটিতে সংরক্ষণযোগ্য কোনো পাঠ্য পাওয়া যায়নি। অনুগ্রহ করে লেখাযুক্ত একটি .docx ফাইল আপলোড করুন।',
    };
  }

  // Detect garbled legacy Bijoy / SutonnyMJ ANSI mojibake before saving gibberish
  const encodingCheck = evaluateLocalExtractedPageText(substantiveText, 12);
  if (!encodingCheck.usable && encodingCheck.reason === 'garbled_encoding') {
    return {
      ok: false,
      code: 'GARBLED_ENCODING',
      error:
        'এই Word (.docx) ফাইলটির বাংলা লেখা পুরোনো Bijoy/ANSI ফন্টে (অ-ইউনিকোড) রয়েছে, যা সরাসরি পড়লে ভেঙে যায়। অনুগ্রহ করে লেখাটি Unicode বাংলায় রূপান্তর করুন অথবা Word থেকে PDF হিসেবে Export করে আপলোড করুন (PDF আপলোড করলে স্বয়ংক্রিয় AI OCR দিয়ে পরিষ্কার বাংলা সংগ্রহ হবে)।',
    };
  }

  // Apply optional starting page offset if the user provided a page range in Advanced Options
  let startPageNumber = 1;
  if (params.pageRangeInput && params.pageRangeInput.trim().length > 0) {
    const parsedRange = parseOriginalPageRangeSyntax(params.pageRangeInput);
    if (parsedRange.ok && !parsedRange.empty && parsedRange.startPage !== null) {
      startPageNumber = parsedRange.startPage;
    }
  }

  const sections: ExtractedSectionItem[] = pages.map((page, idx) => ({
    pdfPageIndex: idx + 1,
    pageNumber: startPageNumber + idx,
    chapter: page.chapter,
    content: page.content,
  }));

  const rawText = sections
    .map((s) => `--- পৃষ্ঠা ${s.pageNumber} ---\n[${s.chapter}]\n${s.content}`)
    .join('\n\n');
  const meaningfulCharCount = stripPageMarkersAndHeaders(rawText).length;
  const endPageNumber = startPageNumber + sections.length - 1;
  const originalPageRange =
    sections.length === 1 ? `${startPageNumber}` : `${startPageNumber}-${endPageNumber}`;

  const warnings: string[] = [];
  if (parsed.hasEmbeddedImages) {
    warnings.push(
      'এই Word ফাইলে টেক্সটের পাশাপাশি কিছু ছবিও রয়েছে—সব টেক্সট তাৎক্ষণিকভাবে সংগৃহীত হয়েছে।'
    );
  }
  if (!usedExplicitPageBreaks && sections.length > 1) {
    warnings.push(
      `Word ফাইলে নির্ধারিত Page Break না থাকায় বিষয়বস্তু ${toBengaliNumber(sections.length)}টি সুবিন্যস্ত অংশে ভাগ করা হয়েছে।`
    );
  }

  return {
    ok: true,
    headingCount: parsed.headingCount,
    tableCount: parsed.tableCount,
    usedExplicitPageBreaks,
    extraction: {
      extractionStatus: 'success',
      actualPageCount: sections.length,
      expectedPageCount: sections.length,
      extractedPageCount: sections.length,
      originalPageRange,
      totalBatches: 0,
      completedBatches: 0,
      failedBatches: 0,
      missingOriginalPages: [],
      duplicateOriginalPages: [],
      outOfOrderDetected: false,
      ocrCompleted: false,
      method: 'text',
      sections,
      rawText,
      meaningfulCharCount,
      warnings,
    },
  };
}
