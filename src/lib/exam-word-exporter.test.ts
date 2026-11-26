import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildStructuredExamDocxBytes } from './exam-word-exporter';

/**
 * Minimal ZIP entry extractor using Node's built-in `zlib` so we can verify the real
 * `word/document.xml` produced by `docx` with zero extra test dependencies.
 */
function extractZipEntryUtf8(zipBytes: Uint8Array, targetFilename: string): string | null {
  const buf = Buffer.from(zipBytes);
  let offset = 0;
  while (offset + 30 <= buf.length) {
    // Local file header signature 0x04034b50
    if (buf.readUInt32LE(offset) !== 0x04034b50) {
      break;
    }
    const compressionMethod = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const fileNameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.subarray(nameStart, nameStart + fileNameLen).toString('utf8');
    const dataStart = nameStart + fileNameLen + extraLen;
    const dataEnd = dataStart + compressedSize;

    if (name === targetFilename) {
      const slice = buf.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) return slice.toString('utf8');
      if (compressionMethod === 8) return zlib.inflateRawSync(slice).toString('utf8');
      return null;
    }

    // If data descriptor bit is set and compressedSize is 0, scan for next PK header
    if (compressedSize === 0) {
      const nextSig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataStart);
      if (nextSig === -1) break;
      offset = nextSig;
    } else {
      offset = dataEnd;
    }
  }
  return null;
}

test('buildStructuredExamDocxBytes generates valid A4 Narrow Word (.docx) with Justify, Underline, Bold, Italic, 2-col layout & native Word Table', async () => {
  const sampleExam = [
    'বাংলাদেশ সরকারি কর্ম কমিশন (BPSC)',
    'পদের নাম: সিনিয়র স্টাফ নার্স',
    'সময়: ৬০ মিনিট   তারিখ: ১২/০৪/২০২৫   পূর্ণমান: ১০০',
    '',
    '01. I know <u>where he lives</u>. Here the **underlined** *part* is—',
    '    a) Noun clause',
    '    b) Adjective clause',
    '    c) Adverbial clause',
    '    d) Principal clause',
    'Answer: A',
    'ব্যাখ্যা: এখানে <u>where he lives</u> অংশটি know verb-এর object হিসেবে বসেছে।',
    '',
    '02. বলশেভিক বিপ্লব কত সালে সংগঠিত হয়?',
    '    a) ১৯২৭',
    '    b) ১৯৪৯',
    '    c) ১৯৭৯',
    '    d) ১৯১৭',
    'Answer: D',
    'ব্যাখ্যা: কিছু আলোচিত বিপ্লব:',
    '| বিপ্লবের নাম | সময়কাল | দেশ |',
    '| --- | --- | --- |',
    '| অরেঞ্জ বিপ্লব | ২০০৪ | ইউক্রেন |',
    '| ভেলভেট বিপ্লব | ১৯৮৯ | চেকোস্লোভাকিয়া |',
  ].join('\n');

  const bytes = await buildStructuredExamDocxBytes(
    [
      {
        id: 'exam-1',
        kind: 'exam',
        bookTitle: 'রিসেন্ট জব সলুশন',
        title: 'সিনিয়র স্টাফ নার্স',
        chapter: 'সাম্প্রতিক প্রশ্ন',
        pageLabel: 'পৃষ্ঠা ১',
        startPage: 1,
        endPage: 1,
        content: sampleExam,
        questionCount: 2,
        sourceChunks: [],
      },
    ],
    {
      bookTitle: 'রিসেন্ট জব সলুশন',
      numberingStyle: 'original',
      includeHeader: true,
      includeSolutions: true,
      layoutColumns: 2,
      justifyText: true,
    }
  );

  // Verify valid PK ZIP container
  assert.ok(bytes.length > 2000, `Expected substantial docx bytes, got ${bytes.length}`);
  assert.equal(bytes[0], 0x50); // 'P'
  assert.equal(bytes[1], 0x4b); // 'K'

  const docXml = extractZipEntryUtf8(bytes, 'word/document.xml');
  const settingsXml = extractZipEntryUtf8(bytes, 'word/settings.xml');
  assert.ok(docXml, 'word/document.xml must exist inside generated .docx');

  // Verify exact MCQ Letter 8.5" x 11" dimensions (12240 x 15840 twips)
  assert.ok(docXml.includes('12240'), 'Expected 8.5in Letter width 12240 twips for MCQ');
  assert.ok(docXml.includes('15840'), 'Expected 11in Letter height 15840 twips for MCQ');

  // Verify exact MCQ Margins: Top/Bottom 0.5" (720), Left/Right 0.8" (1152), Header/Footer 0.45" (648)
  assert.ok(docXml.includes('w:top="720"'), 'Expected 0.5in top margin (720 twips)');
  assert.ok(docXml.includes('w:bottom="720"'), 'Expected 0.5in bottom margin (720 twips)');
  assert.ok(docXml.includes('w:left="1152"'), 'Expected 0.8in left margin (1152 twips)');
  assert.ok(docXml.includes('w:right="1152"'), 'Expected 0.8in right margin (1152 twips)');
  assert.ok(docXml.includes('w:header="648"'), 'Expected 0.45in header from edge (648 twips)');
  assert.ok(docXml.includes('w:footer="648"'), 'Expected 0.45in footer from edge (648 twips)');

  // Verify exact MCQ 2-Column setup: 2 columns, 0.2" spacing (288 twips), Line between (sep="1")
  assert.ok(docXml.includes('w:num="2"'), 'Expected 2 columns for MCQ');
  assert.ok(docXml.includes('w:space="288"'), 'Expected 0.2in column spacing (288 twips)');
  assert.ok(docXml.includes('w:sep="1"') || docXml.includes('w:sep="true"'), 'Expected Line between columns');

  // Verify exact MCQ Paragraph settings: Hanging 0.35" (504), Multiple 1.2 (line="288"), WidowControl & KeepNext
  assert.ok(docXml.includes('w:hanging="504"'), 'Expected 0.35in hanging indent (504 twips)');
  assert.ok(docXml.includes('w:line="288"'), 'Expected Multiple 1.2 line spacing (288)');
  assert.ok(docXml.includes('<w:widowControl'), 'Expected Widow/Orphan control');
  assert.ok(docXml.includes('<w:keepNext'), 'Expected Keep with next');

  // Verify exact MCQ Tab Stops: 0.35" L (504), 1" L (1440), 1.75" L (2520), 2.5" L (3600), 3.35" R (4824) & Default 0.5" (720)
  assert.ok(docXml.includes('w:val="left" w:pos="504"'), 'Expected 0.35in Left tab stop');
  assert.ok(docXml.includes('w:val="left" w:pos="1440"'), 'Expected 1in Left tab stop');
  assert.ok(docXml.includes('w:val="left" w:pos="2520"'), 'Expected 1.75in Left tab stop');
  assert.ok(docXml.includes('w:val="left" w:pos="3600"'), 'Expected 2.5in Left tab stop');
  assert.ok(docXml.includes('w:val="right" w:pos="4824"'), 'Expected 3.35in Right tab stop');
  assert.ok(
    settingsXml && settingsXml.includes('w:val="720"'),
    'Expected 0.5in default tab stop (720 twips) in word/settings.xml'
  );

  // Verify Justify alignment (`w:jc w:val="both"`)
  assert.ok(docXml.includes('w:val="both"'), 'Expected Word Justify alignment');

  // Verify rich formatting: underline (`w:u`), bold (`w:b`), italic (`w:i`), mixed fonts
  assert.ok(docXml.includes('<w:u '), 'Expected real Word underline tag');
  assert.ok(docXml.includes('<w:b'), 'Expected real Word bold tag');
  assert.ok(docXml.includes('<w:i'), 'Expected real Word italic tag');
  assert.ok(docXml.includes('SolaimanLipi'), 'Expected Bengali SolaimanLipi font');
  assert.ok(docXml.includes('Times New Roman'), 'Expected English Times New Roman font');

  // Verify native Word table (`<w:tbl>`) containing the recovered table cells
  assert.ok(docXml.includes('<w:tbl>'), 'Expected native Word <w:tbl> table');
  assert.ok(docXml.includes('অরেঞ্জ বিপ্লব'), 'Expected table cell content');
  assert.ok(docXml.includes('চেকোস্লোভাকিয়া'), 'Expected table cell content');
  assert.ok(docXml.includes('where he lives'), 'Expected underlined clause text');
});

test('buildStructuredExamDocxBytes keeps Written exam papers strictly on 1-column A4 without MCQ 8.5x11 tab layout', async () => {
  const sampleWritten = [
    '৪৫তম বিসিএস লিখিত পরীক্ষা',
    'বিষয়: বাংলা',
    'সময়: ৪ ঘণ্টা   পূর্ণমান: ২০০',
    '',
    '১. সন্ধি বিচ্ছেদ করুন: ইত্যাদি, পরীক্ষা, বিদ্যালয়, নাবিক।',
    '২. ভাবসম্প্রসারণ লিখুন: দুর্নীতি উন্নয়নের প্রধান অন্তরায়।',
    '৩. বাংলায় অনুবাদ করুন: Honesty is the best policy in human life.',
  ].join('\n');

  const bytes = await buildStructuredExamDocxBytes(
    [
      {
        id: 'written-1',
        kind: 'exam',
        bookTitle: '৪৫তম বিসিএস (Written)',
        title: 'বাংলা লিখিত',
        chapter: 'লিখিত প্রশ্ন',
        pageLabel: 'পৃষ্ঠা ১',
        startPage: 1,
        endPage: 1,
        content: sampleWritten,
        questionCount: 3,
        sourceChunks: [],
      },
    ],
    {
      bookTitle: '৪৫তম বিসিএস (Written)',
      numberingStyle: 'original',
      includeHeader: true,
      includeSolutions: true,
      layoutColumns: 2, // Even if 2-col is selected globally, Written MUST stay 1-col A4!
      justifyText: true,
    }
  );

  const docXml = extractZipEntryUtf8(bytes, 'word/document.xml');
  assert.ok(docXml, 'word/document.xml must exist for Written paper');
  assert.ok(docXml.includes('11906'), 'Expected ISO A4 width 11906 twips for Written paper');
  assert.ok(docXml.includes('16838'), 'Expected ISO A4 height 16838 twips for Written paper');
  assert.ok(!docXml.includes('w:num="2"'), 'Written paper must NOT use 2-column MCQ layout');
  assert.ok(!docXml.includes('w:pos="4824"'), 'Written paper must NOT inject 3.35in MCQ tab stops');
});

test('buildStructuredExamDocxBytes applies adaptive per-column line spacing [1.00, 1.50] and column breaks on 70-question MCQ exam', async () => {
  const lines = [
    'সংস্কৃতি বিষয়ক মন্ত্রণালয়-২০২৫',
    'পদের নাম: বুকস্টার্টার; তারিখ: ১০.০৯.২৫',
    'সময়: ১ ঘণ্টা   পূর্ণমান: ৭০',
    '',
    'বাংলা',
  ];
  for (let i = 1; i <= 70; i += 1) {
    if (i === 21) lines.push('English');
    if (i === 61) lines.push('সাধারণ জ্ঞান');
    lines.push(`${String(i).padStart(2, '0')}. বাংলাদেশের সাংবিধানিক ও ঐতিহাসিক প্রশ্ন নম্বর ${i} কোনটি সঠিক?`);
    lines.push('ক. প্রথম বিকল্প উত্তর');
    lines.push('খ. দ্বিতীয় বিকল্প উত্তর');
    lines.push('গ. তৃতীয় বিকল্প উত্তর');
    lines.push('ঘ. চতুর্থ বিকল্প উত্তর');
    lines.push('উত্তর: ক');
  }

  const bytes = await buildStructuredExamDocxBytes(
    [
      {
        id: 'exam-70',
        kind: 'exam',
        bookTitle: 'MATRIX',
        title: 'সংস্কৃতি বিষয়ক মন্ত্রণালয়-২০২৫',
        chapter: 'সাম্প্রতিক প্রশ্ন',
        pageLabel: 'পৃষ্ঠা ১–৩',
        startPage: 1,
        endPage: 3,
        content: lines.join('\n'),
        questionCount: 70,
        sourceChunks: [],
      },
    ],
    {
      bookTitle: 'MATRIX',
      numberingStyle: 'original',
      includeHeader: true,
      includeSolutions: true,
      layoutColumns: 2,
      justifyText: true,
    }
  );

  const docXml = extractZipEntryUtf8(bytes, 'word/document.xml');
  assert.ok(docXml, 'word/document.xml must exist');
  // Must emit column breaks between balanced columns
  assert.ok(docXml.includes('w:type="column"'), 'Expected explicit Word column breaks between balanced columns');
  // Every MCQ body paragraph line spacing must remain strictly inside [240, 360] (1.00 to 1.50)
  const lineVals = Array.from(docXml.matchAll(/w:line="(\d+)"/g)).map((m) => Number(m[1]));
  assert.ok(lineVals.length > 70, 'Expected line spacing entries across all 70 questions');
  for (const val of lineVals) {
    assert.ok(
      val >= 240 && val <= 360,
      `Expected Word line spacing in [240..360] (1.00..1.50), got ${val}`
    );
  }
});

test('buildStructuredExamDocxBytes always renders Answer directly below options (never inline) and aligns 1-col options at 3.50in', async () => {
  const sampleMcq = [
    'দুর্নীতি দমন কমিশন',
    'পদের নাম: উপ সহকারী পরিচালক',
    'সময়: ৬০ মিনিট   পূর্ণমান: ১০০',
    '',
    '০১. নাউরুয়া পারমাণবিক পরীক্ষা কেন্দ্রটি কোন দেশে অবস্থিত?',
    'a) রাশিয়া',
    'b) ভারত',
    'c) যুক্তরাষ্ট্র',
    'd) ফ্রান্স',
    'Answer: A',
    '',
    '০২. কোন দেশটি ইউরোপীয় ইউনিয়নের সদস্য নয়?',
    'a) সুইজারল্যান্ড',
    'b) ডেনমার্ক',
    'c) নরওয়ে',
    'd) বুলগেরিয়া',
    'Answer: A, C',
  ].join('\n');

  for (const cols of [1, 2] as const) {
    const bytes = await buildStructuredExamDocxBytes(
      [
        {
          id: `exam-ans-below-${cols}`,
          kind: 'exam',
          bookTitle: '01. Job Solution',
          title: 'দুর্নীতি দমন কমিশন',
          chapter: 'সাম্প্রতিক প্রশ্ন',
          pageLabel: 'পৃষ্ঠা ১',
          startPage: 1,
          endPage: 1,
          content: sampleMcq,
          questionCount: 2,
          sourceChunks: [],
        },
      ],
      {
        bookTitle: '01. Job Solution',
        numberingStyle: 'original',
        includeHeader: true,
        includeSolutions: true,
        layoutColumns: cols,
        justifyText: true,
      }
    );

    const docXml = extractZipEntryUtf8(bytes, 'word/document.xml');
    assert.ok(docXml, `word/document.xml must exist for ${cols}-col export`);

    // Extract every <w:p> paragraph and verify NO paragraph contains BOTH an option marker (c)/d)) AND "Answer:"
    const paragraphs = Array.from(docXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)).map((m) => m[0]);
    const answerParagraphs = paragraphs.filter((p) => p.includes('Answer:'));
    assert.equal(answerParagraphs.length, 2, `Expected 2 standalone Answer paragraphs in ${cols}-col export`);
    for (const ap of answerParagraphs) {
      assert.ok(
        !ap.includes('c)') && !ap.includes('d)'),
        `Answer must sit in its own paragraph below options, never inline with c)/d) in ${cols}-col export`
      );
    }

    if (cols === 1) {
      assert.ok(
        docXml.includes('w:val="left" w:pos="5040"'),
        'Expected 3.50in (5040 twips) Left tab stop for exact b)/d) alignment in 1-col Word export'
      );
    }
  }
});


