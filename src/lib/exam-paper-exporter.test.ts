import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeExamDocumentFormatting,
  parseExamDocumentForDisplay,
} from './exam-text-formatter';
import {
  applyExamExportOptionsToDocument,
  buildSafeExportFilename,
  formatExamPapersAsText,
} from './exam-paper-exporter';
import { buildSmartReaderViews } from './reader-page-grouper';
import type { BookChunk } from '../types/system';

const USER_SCREENSHOT_BROKEN_OCR = [
  'প্রশ্ন সমাধান।। মৎস্য অধিদপ্তর',
  'পদের নাম: হ্যাচারি অ্যাটেনডেন্ট',
  'পরীক্ষার তারিখ: ১২/০১/২০২৪',
  '১। সন্ধি বিচ্ছেদ করুন:',
  'ক) নবান্ন = নব + অন্ন',
  'খ) হিমালয় = হিম + আলয়',
  'গ) সজ্জন = সৎ + জন',
  'ঘ) একচ্ছত্র = এক + ছত্র',
  'ঙ) স্বচ্ছন্দ = স্ব + ছন্দ ২। এক কথায় প্রকাশ করুন:',
  'ক) যে সকল অত্যাচারই সয়েযায় = সর্বসহা',
  'খ) যে বন হিংস্র জন্তুতে পরিপূর্ণ = শাপদসঙ্কুল',
  'গ) যার অন্য উপায় নেই = অনন্যোপায়',
  'ঘ) একই মাতার উদরে জাত যে = সহোদর',
  'ঙ) কোনভাবেই যা নিবারণ করা যায় না = অনিবার্য ৩। বিপরীত শব্দ লিখুন: প্রদত্ত শব্দ বিপরীতশব্দ সাকার নিরাকার উৎকর্ষ অপকর্ষ স্বতন্ত্র পরতন্ত্র দুর্গম সুগম ইহকাল পরকাল ৪ Fill in the gap using Article: a)....... rich are not always happy. Answer: the',
  'b) You are...... Nazrul, I see. Answer: a',
  'c) This is ...... very charming sight. Answer: a',
  'd) Palash is....... artist. Answer: an',
  'e) Honesty is..... bestpolicy. Answer: the | Translate into English:',
  'ক) আমি যদি রাজা হতাম = I wish I were a king.',
  '[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৬২',
  '[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৬২',
].join('\n');

test('Test 1: Repairs all formatting & numbering defects from user screenshot (header, ১।–৫।, bare ৪, pipe |, inline antonym table, dotted a)...)', () => {
  const formatted = normalizeExamDocumentFormatting(USER_SCREENSHOT_BROKEN_OCR);
  const parsed = parseExamDocumentForDisplay(formatted);

  assert.equal(parsed.isExam, true);
  // Header lines must be extracted for centered bold rendering
  assert.deepEqual(parsed.headerLines, [
    'প্রশ্ন সমাধান।। মৎস্য অধিদপ্তর',
    'পদের নাম: হ্যাচারি অ্যাটেনডেন্ট',
    'পরীক্ষার তারিখ: ১২/০১/২০২৪',
  ]);

  const questions = parsed.bodyItems.filter((i) => i.kind === 'question');
  assert.equal(questions.length, 5);
  assert.equal(questions[0].numberLabel, '১।');
  assert.equal(questions[0].text, 'সন্ধি বিচ্ছেদ করুন:');
  assert.equal(questions[1].numberLabel, '২।');
  assert.equal(questions[1].text, 'এক কথায় প্রকাশ করুন:');
  assert.equal(questions[2].numberLabel, '৩।');
  assert.equal(questions[2].text, 'বিপরীত শব্দ লিখুন:');
  assert.equal(questions[3].numberLabel, '৪।');
  assert.equal(questions[3].text, 'Fill in the gap using Article:');
  assert.equal(questions[4].numberLabel, '৫।');
  assert.equal(questions[4].text, 'Translate into English:');

  // Flattened antonym word-pair table expanded cleanly into 5 indented option rows
  assert.ok(formatted.includes('    ক) সাকার = নিরাকার'));
  assert.ok(formatted.includes('    ঙ) ইহকাল = পরকাল'));

  // Dotted fill-in-the-blank option `a).......` split onto its own indented line
  assert.ok(formatted.includes('    a) ....... rich are not always happy. Answer: the'));

  // Publisher self-preparation cross-reference lines are NOT answers and must be stripped completely
  const citationMatches = formatted.match(/পৃষ্ঠা-৬২/g) ?? [];
  assert.equal(citationMatches.length, 0);
  assert.ok(!formatted.includes('সেল্ফ প্রিপারেশন'));

  // SmartReader grouper also counts all 5 Bengali-numbered questions accurately
  const chunk: BookChunk = {
    id: 1,
    bookId: 10,
    bookTitle: 'Recent Job SOLUTION Part 01',
    chapter: 'অধ্যায় ১: মূল আলোচনা',
    pageNumber: 2,
    chunkIndex: 0,
    content: USER_SCREENSHOT_BROKEN_OCR,
  };
  const views = buildSmartReaderViews([chunk], 'exam');
  assert.equal(views.isExamBook, true);
  assert.equal(views.views.length, 1);
  assert.equal(views.views[0].questionCount, 5);
});

test('Test 2: applyExamExportOptionsToDocument converts numbering styles and strips solutions/headers cleanly', () => {
  const sampleWithSolution = [
    USER_SCREENSHOT_BROKEN_OCR,
    '৬। MRT এর পূর্ণরূপ লিখুন।',
    'Solution: Mass Rapid Transit.',
  ].join('\n');

  const englishDoc = applyExamExportOptionsToDocument(sampleWithSolution, {
    numberingStyle: 'english',
    includeHeader: true,
    includeSolutions: true,
  });
  const enQuestions = englishDoc.bodyItems.filter((i) => i.kind === 'question');
  assert.equal(enQuestions[0].numberLabel, '01.');
  assert.equal(enQuestions[3].numberLabel, '04.');
  assert.equal(enQuestions[4].numberLabel, '05.');
  assert.equal(enQuestions[5].numberLabel, '06.');

  const bengaliPracticeSheet = applyExamExportOptionsToDocument(sampleWithSolution, {
    numberingStyle: 'bengali',
    includeHeader: false,
    includeSolutions: false,
  });
  assert.equal(bengaliPracticeSheet.headerLines.length, 0);
  const bnQuestions = bengaliPracticeSheet.bodyItems.filter((i) => i.kind === 'question');
  assert.equal(bnQuestions[0].numberLabel, '০১।');
  assert.equal(bnQuestions[5].numberLabel, '০৬।');
  assert.ok(!bengaliPracticeSheet.formatted.includes('Mass Rapid Transit'));
  assert.ok(!bengaliPracticeSheet.formatted.includes('Answer: the'));
});

test('Test 3: formatExamPapersAsText and buildSafeExportFilename produce clean structured TXT output and safe filenames', () => {
  const chunk: BookChunk = {
    id: 1,
    bookId: 10,
    bookTitle: 'Recent Job SOLUTION Part 01',
    chapter: 'অধ্যায় ১: মূল আলোচনা',
    pageNumber: 2,
    chunkIndex: 0,
    content: USER_SCREENSHOT_BROKEN_OCR,
  };
  const { views } = buildSmartReaderViews([chunk], 'exam');

  const txt = formatExamPapersAsText(views, {
    bookTitle: 'Recent Job SOLUTION Part 01',
    numberingStyle: 'english',
    includeHeader: true,
    includeSolutions: true,
  });

  assert.ok(txt.includes('================================================================'));
  assert.ok(txt.includes('প্রশ্ন সমাধান।। মৎস্য অধিদপ্তর'));
  assert.ok(txt.includes('01. সন্ধি বিচ্ছেদ করুন:'));
  assert.ok(txt.includes('04. Fill in the gap using Article:'));
  assert.ok(txt.includes('05. Translate into English:'));
  assert.ok(txt.includes('    ক) সাকার = নিরাকার'));

  assert.equal(
    buildSafeExportFilename('মৎস্য অধিদপ্তর: হ্যাচারি/এটেন্ডেন্ট', 'pdf'),
    'মৎস্য-অধিদপ্তর-হ্যাচারি-এটেন্ডেন্ট.pdf'
  );
  assert.equal(
    buildSafeExportFilename('Recent Job SOLUTION Part 01', 'txt'),
    'Recent-Job-SOLUTION-Part-01.txt'
  );
});
