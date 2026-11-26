import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMarkdownTableLine,
  isMarkdownTableSeparatorLine,
  normalizeBrokenMarkdownTables,
  parseMarkdownTableBlock,
  serializeMarkdownTable,
  formatMarkdownTableAsPlainText,
  splitTextBlocksWithTables,
  parseInlineRichText,
  stripInlineRichMarkup,
} from './rich-text-and-table-parser';
import { parseExamDocumentForDisplay } from './exam-text-formatter';

test('parses standard GFM Markdown table with Bengali/English cells and alignments', () => {
  const lines = [
    '| ক্রমিক | প্রতিষ্ঠানের নাম | প্রতিষ্ঠাকাল |',
    '| :---: | :--- | ---: |',
    '| ১ | ঢাকা বিশ্ববিদ্যালয় | ১৯২১ |',
    '| ২ | বাংলা একাডেমি | ১৯৫৫ |',
  ];

  assert.equal(isMarkdownTableLine(lines[0]), true);
  assert.equal(isMarkdownTableSeparatorLine(lines[1]), true);

  const table = parseMarkdownTableBlock(lines);
  assert.ok(table);
  assert.deepEqual(table.headers, ['ক্রমিক', 'প্রতিষ্ঠানের নাম', 'প্রতিষ্ঠাকাল']);
  assert.deepEqual(table.alignments, ['center', 'left', 'right']);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0], ['১', 'ঢাকা বিশ্ববিদ্যালয়', '১৯২১']);
  assert.deepEqual(table.rows[1], ['২', 'বাংলা একাডেমি', '১৯৫৫']);

  const serialized = serializeMarkdownTable(table);
  assert.match(serialized, /\| ক্রমিক \| প্রতিষ্ঠানের নাম \| প্রতিষ্ঠাকাল \|/);
  assert.match(serialized, /\| :---: \| --- \| ---: \|/);

  const plain = formatMarkdownTableAsPlainText(table);
  assert.match(plain, /ঢাকা বিশ্ববিদ্যালয়/);
  assert.match(plain, /১৯৫৫/);
});

test('does NOT misclassify reference lines, exam metadata, or math fractions as tables', () => {
  assert.equal(
    isMarkdownTableLine('রেফারেন্স: বিসিএস প্রিলি (https://a.com) | ব্যাংক জব (https://b.com)'),
    false
  );
  assert.equal(
    isMarkdownTableLine('সময়: ১ ঘণ্টা | তারিখ: ১২/০৪/২০২৫ | পূর্ণমান: ১০০'),
    false
  );
  assert.equal(
    isMarkdownTableLine('১. [[frac:3x+7|4]] এর মান কত?'),
    false
  );
});

test('splits mixed textbook prose and Markdown tables cleanly', () => {
  const text = [
    'সংবিধানের গুরুত্বপূর্ণ অনুচ্ছেদ তালিকা:',
    '',
    '| অনুচ্ছেদ | বিষয়বস্তু |',
    '| --- | --- |',
    '| **২৭** | আইনের দৃষ্টিতে সমতা |',
    '| **২৮** | ধর্ম প্রভৃতি কারণে বৈষম্য |',
    '',
    'উপরের তালিকাটি বিসিএস পরীক্ষার জন্য অত্যন্ত গুরুত্বপূর্ণ।',
  ].join('\n');

  const blocks = splitTextBlocksWithTables(text);
  const tables = blocks.filter((b) => b.kind === 'table');
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].table.headers, ['অনুচ্ছেদ', 'বিষয়বস্তু']);
  assert.equal(tables[0].table.rows.length, 2);
});

test('recovers Screenshot 2 defect: blank lines between every Markdown table row', () => {
  const screenshot2Raw = [
    '05. বলশেভিক বিপ্লব কত সালে সংগঠিত হয়?',
    '    a) ১৯২৭',
    '    b) ১৯৪৯',
    '    c) ১৯৭৯',
    '    d) ১৯১৭',
    'Answer: D',
    'Solution: কিছু আলোচিত বিপ্লবঃ',
    '',
    '| বিপ্লবের নাম | সময়কাল | দেশ |',
    '',
    '| --- | --- | --- |',
    '',
    '| অরেঞ্জ বিপ্লব | ২০০৪ | ইউক্রেন |',
    '',
    '| রুশ/অক্টোবর/বলশেভিক বিপ্লব | ১৯১৭ | রাশিয়া |',
    '',
    '| ফরাসি বিপ্লব | ১৭৮৯-১৭৯৯ | ফ্রান্স |',
    '',
    '| ভেলভেট বিপ্লব | ১৯৮৯ | চেকোস্লোভাকিয়া |',
  ].join('\n');

  const parsed = parseExamDocumentForDisplay(screenshot2Raw);
  assert.equal(parsed.isExam, true);
  const explanation = parsed.bodyItems.find((b) => b.kind === 'explanation');
  assert.ok(explanation && explanation.kind === 'explanation');
  assert.match(explanation.text, /কিছু আলোচিত বিপ্লব/);

  const tableItem = parsed.bodyItems.find((b) => b.kind === 'table');
  assert.ok(tableItem && tableItem.kind === 'table', 'Expected a structured table block');
  assert.deepEqual(tableItem.headers, ['বিপ্লবের নাম', 'সময়কাল', 'দেশ']);
  assert.equal(tableItem.rows.length, 4);
  assert.deepEqual(tableItem.rows[0], ['অরেঞ্জ বিপ্লব', '২০০৪', 'ইউক্রেন']);
  assert.deepEqual(tableItem.rows[3], ['ভেলভেট বিপ্লব', '১৯৮৯', 'চেকোস্লোভাকিয়া']);
});

test('recovers Screenshot 4 defect: flattened inline single-line table glued onto ব্যাখ্যা: with 2-col header and 3-col body rows', () => {
  const screenshot4Raw = [
    "99. 'ড়, ঢ়' কোন ধরনের বর্ণ?",
    '    a) পার্শ্বিক',
    '    b) কম্পনজাত',
    '    c) তাড়নজাত',
    '    d) অযোগবাহ',
    'Answer: C',
    "ব্যাখ্যা: 'ড়, ঢ়' কে তাড়নজাত বর্ণ বলে। উল্লেখ্য, ধ্বনি সম্পর্কে খুঁটিনাটি কিছু তথ্য দেয়া হলো যেগুলো বিভিন্ন প্রতিযোগিতামূলক পরীক্ষায় আসে। | নাম | বর্ণ | | --- | --- | | মৌলিক স্বরধ্বনি | ৭টি | অ, আ, ই, উ, এ, ও, অ্যা | | স্বরবর্ণ | ১১টি | | অর্ধমাত্রা | ৮টি | ঋ, খ, গ, ণ, থ, ধ, প, শ | | শিসধ্বনি | ৩টি | শ, ষ, স |",
  ].join('\n');

  const repaired = normalizeBrokenMarkdownTables(screenshot4Raw);
  assert.ok(repaired.includes('\n| নাম | বর্ণ |\n| --- | --- |\n'));

  const parsed = parseExamDocumentForDisplay(screenshot4Raw);
  const explanation = parsed.bodyItems.find((b) => b.kind === 'explanation');
  assert.ok(explanation && explanation.kind === 'explanation');
  assert.equal(
    explanation.text.includes('| --- |'),
    false,
    'Explanation text must NOT contain raw Markdown table pipes'
  );

  const tableItem = parsed.bodyItems.find((b) => b.kind === 'table');
  assert.ok(tableItem && tableItem.kind === 'table', 'Expected extracted structured table');
  assert.equal(tableItem.headers.length, 3, 'Should expand column count to match 3-column body rows');
  assert.equal(tableItem.rows.length, 4);
  assert.deepEqual(tableItem.rows[0], ['মৌলিক স্বরধ্বনি', '৭টি', 'অ, আ, ই, উ, এ, ও, অ্যা']);
  assert.deepEqual(tableItem.rows[3], ['শিসধ্বনি', '৩টি', 'শ, ষ, স']);
});

test('parses **bold**, *italic*, ***bold italic***, <u>underlined</u>, and nested styles safely', () => {
  const spans = parseInlineRichText(
    'He ran <u>fast</u>. Here **bold**, *italic*, ***both***, and **<u>nested</u>** appear.'
  );

  const underlined = spans.find((s) => s.text === 'fast');
  assert.deepEqual(underlined, {
    text: 'fast',
    bold: false,
    italic: false,
    underline: true,
  });

  const bold = spans.find((s) => s.text === 'bold');
  assert.deepEqual(bold, {
    text: 'bold',
    bold: true,
    italic: false,
    underline: false,
  });

  const italic = spans.find((s) => s.text === 'italic');
  assert.deepEqual(italic, {
    text: 'italic',
    bold: false,
    italic: true,
    underline: false,
  });

  const both = spans.find((s) => s.text === 'both');
  assert.deepEqual(both, {
    text: 'both',
    bold: true,
    italic: true,
    underline: false,
  });

  const nested = spans.find((s) => s.text === 'nested');
  assert.deepEqual(nested, {
    text: 'nested',
    bold: true,
    italic: false,
    underline: true,
  });

  assert.equal(
    stripInlineRichMarkup('Identify the <u>underlined</u> **word** in *context*.'),
    'Identify the underlined word in context.'
  );
});

test('preserves fill-in-the-blank underscores and spaced math multiplication untouched', () => {
  const blankText = 'He is _____ honest man and 2 * 3 * 5 = 30.';
  const spans = parseInlineRichText(blankText);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0], {
    text: blankText,
    bold: false,
    italic: false,
    underline: false,
  });
});

test('recovers Q96 defect: zero-space || row delimiters glued onto question stem into a 3x3 Markdown table', () => {
  const q96Raw = [
    '৯৬. নিচের সংখ্যাছকের গুপ্ত সংখ্যাটি বের করুন? | ৮ | ১ | ৬ || --- | --- | --- || ৩ | ? | ৭ || ৪ | ৯ | ২ |',
    '    ক. ২',
    '    খ. ৫',
    '    গ. ৬',
    '    ঘ. ৮',
    'উত্তর: খ',
  ].join('\n');

  const normalized = normalizeBrokenMarkdownTables(q96Raw);
  assert.ok(normalized.includes('\n| ৮ | ১ | ৬ |\n| --- | --- | --- |\n| ৩ | ? | ৭ |\n| ৪ | ৯ | ২ |'));

  const parsed = parseExamDocumentForDisplay(q96Raw);
  assert.equal(parsed.isExam, true);
  const question = parsed.bodyItems.find((b) => b.kind === 'question');
  assert.ok(question && question.kind === 'question');
  assert.equal(question.text.includes('|'), false, 'Question stem must not retain raw pipe grid');

  const tableItem = parsed.bodyItems.find((b) => b.kind === 'table');
  assert.ok(tableItem && tableItem.kind === 'table', 'Expected a structured 3x3 table block');
  assert.deepEqual(tableItem.headers, ['৮', '১', '৬']);
  assert.equal(tableItem.rows.length, 2);
  assert.deepEqual(tableItem.rows[0], ['৩', '?', '৭']);
  assert.deepEqual(tableItem.rows[1], ['৪', '৯', '২']);

  const options = parsed.bodyItems.filter((b) => b.kind === 'option');
  assert.equal(options.length, 4);
  assert.deepEqual(
    options.map((o) => `${o.marker} ${o.text}`),
    ['ক. ২', 'খ. ৫', 'গ. ৬', 'ঘ. ৮']
  );
});

