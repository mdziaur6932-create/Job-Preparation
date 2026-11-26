import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import { extractDocxDocument } from './docx-extractor';
import {
  DOCX_MIME_TYPE,
  MAX_UPLOAD_BYTES,
  validateDeclaredUploadMetadata,
  validateUploadedDocumentHeader,
} from './file-validation';
import { validateBookSaveReadiness } from './pdf-rules';

async function buildRealDocxBytes(bodyXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${bodyXml}</w:body>` +
      '</w:document>'
  );

  return zip.generateAsync({ type: 'uint8array' });
}

test('1: Extracts Bengali/English headings, paragraphs, XML entities, tables, and explicit page breaks from real .docx with optional starting page offset', async () => {
  const bodyXml = `
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>অধ্যায় ১: বাংলাদেশের সংবিধান</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>বাংলাদেশের সংবিধান ১৯৭২ সালের ৪ নভেম্বর গণপরিষদে গৃহীত হয় &amp; ১৬ ডিসেম্বর কার্যকর হয়।</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>অনুচ্ছেদ</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>বিষয়বস্তু</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>অনুচ্ছেদ ২৭</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>আইনের দৃষ্টিতে সমতা</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
      <w:r><w:t>অধ্যায় ২: মহান মুক্তিযুদ্ধ</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>১৯৭১ সালের মহান মুক্তিযুদ্ধের সময় বাংলাদেশকে ১১টি সেক্টরে বিভক্ত করা হয়েছিল।</w:t></w:r>
    </w:p>
  `;

  const bytes = await buildRealDocxBytes(bodyXml);
  const res = await extractDocxDocument({
    bytes,
    fileName: 'bcs-guide.docx',
    pageRangeInput: 'Page 37-38',
  });

  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.usedExplicitPageBreaks, true);
  assert.equal(res.headingCount, 2);
  assert.equal(res.tableCount, 1);

  const ex = res.extraction;
  assert.equal(ex.extractionStatus, 'success');
  assert.equal(ex.method, 'text');
  assert.equal(ex.ocrCompleted, false);
  assert.equal(ex.totalBatches, 0);
  assert.equal(ex.actualPageCount, 2);
  assert.equal(ex.extractedPageCount, 2);
  assert.equal(ex.originalPageRange, '37-38');

  assert.equal(ex.sections[0].pageNumber, 37);
  assert.equal(ex.sections[0].chapter, 'অধ্যায় ১: বাংলাদেশের সংবিধান');
  assert.ok(ex.sections[0].content.includes('& ১৬ ডিসেম্বর'));
  assert.ok(ex.sections[0].content.includes('অনুচ্ছেদ ২৭ | আইনের দৃষ্টিতে সমতা'));

  assert.equal(ex.sections[1].pageNumber, 38);
  assert.equal(ex.sections[1].chapter, 'অধ্যায় ২: মহান মুক্তিযুদ্ধ');
  assert.ok(ex.sections[1].content.includes('১১টি সেক্টরে'));

  const saveReadiness = validateBookSaveReadiness({
    title: 'বিসিএস গাইড (Word)',
    subject: 'বাংলাদেশ বিষয়াবলি',
    rawText: ex.rawText,
    extractionContext: {
      status: ex.extractionStatus,
      actualPageCount: ex.actualPageCount,
      extractedPageCount: ex.extractedPageCount,
      missingOriginalPages: ex.missingOriginalPages,
      sourceWasUploadedPdf: false,
    },
  });
  assert.equal(saveReadiness.ok, true);
  assert.equal(saveReadiness.computedTotalPages, 2);
});

test('2: Splits long .docx without explicit page breaks into structured logical pages along headings & paragraph boundaries', async () => {
  const longPara =
    'বাংলাদেশ ব্যাংক দেশের কেন্দ্রীয় ব্যাংক হিসেবে মুদ্রানীতি প্রণয়ন, বৈদেশিক মুদ্রার রিজার্ভ সংরক্ষণ এবং তফসিলি ব্যাংকসমূহ তদারকি করে। '.repeat(
      20
    );
  const bodyXml = `
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>অধ্যায় ১: কেন্দ্রীয় ব্যাংক</w:t></w:r></w:p>
    <w:p><w:r><w:t>${longPara}</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>অধ্যায় ২: আন্তর্জাতিক অর্থনীতি</w:t></w:r></w:p>
    <w:p><w:r><w:t>${longPara}</w:t></w:r></w:p>
  `;

  const bytes = await buildRealDocxBytes(bodyXml);
  const res = await extractDocxDocument({ bytes, fileName: 'banking-notes.docx' });

  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.usedExplicitPageBreaks, false);
  assert.ok(res.extraction.actualPageCount >= 2);
  assert.equal(res.extraction.sections[0].chapter, 'অধ্যায় ১: কেন্দ্রীয় ব্যাংক');
  assert.ok(
    res.extraction.sections.some((s) => s.chapter === 'অধ্যায় ২: আন্তর্জাতিক অর্থনীতি')
  );
});

test('3: Rejects scanned-image-only .docx with clear Bengali PDF-export OCR guidance', async () => {
  const bodyXml = `
    <w:p>
      <w:r>
        <w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId5"/></w:drawing>
      </w:r>
    </w:p>
  `;

  const bytes = await buildRealDocxBytes(bodyXml);
  const res = await extractDocxDocument({ bytes, fileName: 'scanned-pages.docx' });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'IMAGE_ONLY_DOCX');
  assert.ok(res.error.includes('PDF'));
});

test('4: Rejects arbitrary .zip renamed to .docx (missing word/document.xml) and corrupted files', async () => {
  const zip = new JSZip();
  zip.file('hello.txt', 'not a word file');
  const fakeDocxBytes = await zip.generateAsync({ type: 'uint8array' });

  const res = await extractDocxDocument({ bytes: fakeDocxBytes, fileName: 'spoofed.docx' });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'INVALID_DOCX');
  assert.ok(res.error.includes('word/document.xml'));
});

test('5: Rejects legacy binary .doc (OLE2 signature) with helpful Bengali .doc -> .docx guidance', async () => {
  const ole2Bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);

  const metaCheck = validateDeclaredUploadMetadata({
    fileName: 'old-book.doc',
    declaredMimeType: 'application/msword',
    fileSize: 4096,
  });
  assert.equal(metaCheck.ok, false);
  if (!metaCheck.ok) {
    assert.ok(metaCheck.error.includes('.docx'));
  }

  const headerCheck = validateUploadedDocumentHeader(
    'old-book.docx',
    DOCX_MIME_TYPE,
    ole2Bytes,
    ole2Bytes.byteLength
  );
  assert.equal(headerCheck.ok, false);
  if (!headerCheck.ok) {
    assert.ok(headerCheck.error.includes('.docx'));
  }

  const extractRes = await extractDocxDocument({ bytes: ole2Bytes, fileName: 'old-book.doc' });
  assert.equal(extractRes.ok, false);
  if (!extractRes.ok) {
    assert.equal(extractRes.code, 'LEGACY_DOC_FORMAT');
  }
});

test('6: Detects garbled legacy Bijoy/SutonnyMJ ANSI text inside .docx instead of saving gibberish', async () => {
  const bijoyXml = `
    <w:p>
      <w:r>
        <w:t>evsjv‡\`‡ki msweavb 1972 mv‡ji 4 b‡f¤^i MYcwil‡\` M„nxZ nq Ges 16 wW‡m¤^i Kvh©Ki nq|</w:t>
      </w:r>
    </w:p>
  `;
  const bytes = await buildRealDocxBytes(bijoyXml);
  const res = await extractDocxDocument({ bytes, fileName: 'bijoy-book.docx' });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'GARBLED_ENCODING');
  assert.ok(res.error.includes('Bijoy/ANSI'));
});

test('7: File validation accepts valid .docx (including generic ZIP browser MIME) and blocks arbitrary .zip/.xlsx and >100 MB .docx', async () => {
  const bytes = await buildRealDocxBytes(
    '<w:p><w:r><w:t>বাংলাদেশ বিষয়াবলি সংক্ষিপ্ত নোট এবং গুরুত্বপূর্ণ প্রশ্নোত্তর।</w:t></w:r></w:p>'
  );

  // Standard .docx MIME
  const validStd = validateUploadedDocumentHeader(
    'guide.docx',
    DOCX_MIME_TYPE,
    bytes,
    bytes.byteLength
  );
  assert.equal(validStd.ok, true);
  if (validStd.ok) {
    assert.equal(validStd.kind, 'binary');
    assert.equal(validStd.mimeType, DOCX_MIME_TYPE);
  }

  // Generic application/zip MIME reported by some OS/browsers for .docx
  const validZipMime = validateUploadedDocumentHeader(
    'guide.docx',
    'application/zip',
    bytes,
    bytes.byteLength
  );
  assert.equal(validZipMime.ok, true);

  // Arbitrary .zip or .xlsx MUST be rejected
  const blockedZip = validateUploadedDocumentHeader(
    'archive.zip',
    'application/zip',
    bytes,
    bytes.byteLength
  );
  assert.equal(blockedZip.ok, false);

  const blockedXlsx = validateUploadedDocumentHeader(
    'sheet.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes,
    bytes.byteLength
  );
  assert.equal(blockedXlsx.ok, false);

  // Oversized > 100 MB .docx rejected with actual size + 100 MB limit
  const overLimit = validateDeclaredUploadMetadata({
    fileName: 'huge-book.docx',
    declaredMimeType: DOCX_MIME_TYPE,
    fileSize: MAX_UPLOAD_BYTES + 2 * 1024 * 1024,
  });
  assert.equal(overLimit.ok, false);
  if (!overLimit.ok) {
    assert.equal(overLimit.code, 'FILE_TOO_LARGE');
    assert.ok(overLimit.error.includes('100 MB'));
  }
});
