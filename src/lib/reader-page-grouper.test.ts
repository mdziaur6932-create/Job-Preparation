import test from 'node:test';
import assert from 'node:assert/strict';
import type { Book, BookChunk } from '../types/system';
import type { CombinedExtractionResult } from './pdf-rules';
import {
  extractExamTitleFromText,
  normalizeExamDocumentFormatting,
} from './exam-text-formatter';
import {
  buildBookCardSummary,
  buildFullPageBookChunks,
  buildFullPageSearchChunks,
  buildSmartReaderViews,
  groupBookPagesIntoExams,
  mergeBookChunksByPage,
} from './reader-page-grouper';

function makeChunk(
  id: number,
  pageNumber: number,
  chunkIndex: number,
  content: string,
  chapter = 'অধ্যায় ১: মূল আলোচনা'
): BookChunk {
  return {
    id,
    bookId: 99,
    bookTitle: 'Recent Job SOLUTION Part 01',
    chapter,
    pageNumber,
    chunkIndex,
    content,
  };
}

test('Test 1: Reassembles 5 fragmented Page-1 chunks (Q01–Q14) into ONE single complete exam view matching user book page', () => {
  const fragmentedPage1Chunks: BookChunk[] = [
    makeChunk(
      1,
      1,
      0,
      [
        'মৎস্য অধিদপ্তর',
        'পদের নাম: হ্যাচারি এটেন্ডেন্ট',
        'তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০',
        '01. সন্ধি বিচ্ছেদ করুন:',
        'a) নবান্ন = নব + অন্ন',
        'b) হিমালয় = হিম + আলয়।',
        'c) সজ্জন = সৎ + জন d)একচ্ছত্র = এক + ছত্র।',
        'e) স্বচ্ছন্দ = স্ব + ছন্দ।',
        '02. এক কথায় প্রকাশ করুন:',
        'a) যে সকল অত্যাচার সহ্য করে = সর্বসহা।',
        '03. বিপরীত শব্দ লিখুন:',
        'a) সাকার = নিরাকার।',
      ].join('\n')
    ),
    makeChunk(
      2,
      1,
      1,
      [
        '04. Fill in the gap using appropriate Article:',
        'a) ____ rich are not always happy. (the)',
        'বাক্যের অর্থঃ ধনীরা সর্বদা সুখী হয় না।',
        '05. translate into English:',
        'a) আমি যদি রাজা হতাম। = I wish I were a',
        'king.',
        '06. MRT এর পূর্ণরূপ লিখুন।',
        'Solution: Mass Rapid Transit.',
        '07. হ্যাচারিতে মাছের প্রজননের জন্য কাঙ্ক্ষিত তাপমাত্রা',
        'কত?',
      ].join('\n')
    ),
    makeChunk(
      3,
      1,
      2,
      [
        'Solution: ২৮-৩১ ডিগ্রি সেন্টিগ্রেড।',
        '08. দ্বাদশ জাতীয় সংসদ নির্বাচনে মন্ত্রী পরিষদে কত জন',
        'সদস্য শপথ গ্রহণ করেছেন?',
        'Solution: প্রধানমন্ত্রী সহ মোট ৩৭ জন।',
        '09. হ্যাচারীতে ডিম ফোটানোর জন্য পানির গতিসীমা কত?',
        'Solution: পানির প্রবাহ মিনিটে ৮-১০ লিটার।',
        '10. বঙ্গবন্ধু শেখ মুজিবুর রহমানের জন্মদিন কবে?',
        'Solution: ১৭ মার্চ।',
        '11. PG এর পূর্ণরূপ লিখুন।',
        'Solution: Pituitary Gland.',
      ].join('\n')
    ),
    makeChunk(
      4,
      1,
      3,
      [
        '12. কাজল ১ লিটার দুধ কিনে তা থেকে ২৫০ মি. লি. পান',
        'করল। কাজলের কাছে কতটুকু দুধ অবশিষ্ট থাকল।',
        'Solution: আমরা জানি, ১ লিটার = ১০০০ মি.লি.',
        'অতএব অবশিষ্ট থাকল = ৭৫০ মি.লি.',
        '13. ৪০ কেজি মিশ্রণে বালি ও সিমেন্টের অনুপাত ৪: ১',
        'মিশ্রণটিতে বালি ও সিমেন্টের পরিমাণ কত?',
        'Solution: প্রশ্নমতে, ৪x + x = ৪০',
      ].join('\n')
    ),
    makeChunk(
      5,
      1,
      4,
      [
        '14. পাড়সহ একটি পুকুরের দৈর্ঘ্য ৮০ মিটার ও প্রস্থ ৫০',
        'মিটার। যদি পুকুরের প্রত্যেক পাড়ের বিস্তার ৪ মিটার হয়,',
        'তবে পুকুর পাড়ের ক্ষেত্রফল কত?',
        'Solution: পাড়সহ পুকুরের ক্ষেত্রফল = ৪,০০০ বর্গমিটার',
      ].join('\n')
    ),
  ];

  const result = buildSmartReaderViews(fragmentedPage1Chunks, 'exam');
  assert.equal(result.isExamBook, true);
  assert.equal(result.effectiveMode, 'exam');
  // ALL 5 chunks of Page 1 merge into ONE SINGLE view!
  assert.equal(result.views.length, 1);

  const view = result.views[0];
  assert.equal(view.title, 'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট');
  assert.equal(view.pageLabel, 'পৃষ্ঠা 1');
  assert.equal(view.questionCount, 14);
  assert.equal(view.sourceChunks.length, 5);

  // Zero-space option "d)একচ্ছত্র" split cleanly onto its own indented line
  assert.ok(view.content.includes('    c) সজ্জন = সৎ + জন\n    d) একচ্ছত্র = এক + ছত্র।'));
  // Multi-line wrapped questions 12, 13, 14 merged onto single clean question lines!
  assert.ok(
    view.content.includes(
      '12. কাজল ১ লিটার দুধ কিনে তা থেকে ২৫০ মি. লি. পান করল। কাজলের কাছে কতটুকু দুধ অবশিষ্ট থাকল।'
    )
  );
  assert.ok(
    view.content.includes(
      '13. ৪০ কেজি মিশ্রণে বালি ও সিমেন্টের অনুপাত ৪: ১ মিশ্রণটিতে বালি ও সিমেন্টের পরিমাণ কত?'
    )
  );
  assert.ok(
    view.content.includes(
      '14. পাড়সহ একটি পুকুরের দৈর্ঘ্য ৮০ মিটার ও প্রস্থ ৫০ মিটার। যদি পুকুরের প্রত্যেক পাড়ের বিস্তার ৪ মিটার হয়, তবে পুকুর পাড়ের ক্ষেত্রফল কত?'
    )
  );
  // Multi-line wrapped option 05 a) merged cleanly
  assert.ok(
    view.content.includes('    a) আমি যদি রাজা হতাম। = I wish I were a king.')
  );
  // Question 07 and its Solution from next chunk reunited cleanly
  assert.ok(
    view.content.includes(
      '07. হ্যাচারিতে মাছের প্রজননের জন্য কাঙ্ক্ষিত তাপমাত্রা কত?\nSolution: ২৮-৩১ ডিগ্রি সেন্টিগ্রেড।'
    )
  );
});

test('Test 2: Multi-page exam (Pages 2–3) merges into ONE complete exam in Exam mode, while Page mode keeps 1 full page per view', () => {
  const chunks: BookChunk[] = [
    // Exam 1 on Page 1
    makeChunk(
      1,
      1,
      0,
      'মৎস্য অধিদপ্তর\nপদের নাম: হ্যাচারি এটেন্ডেন্ট\nতারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০\n01. সন্ধি বিচ্ছেদ করুন:\na) নবান্ন = নব + অন্ন।\n02. বিপরীত শব্দ:\na) সাকার = নিরাকার।'
    ),
    // Exam 2 starts on Page 2 (Q01–Q05)
    makeChunk(
      2,
      2,
      1,
      'খাদ্য অধিদপ্তর\nপদের নাম: উপখাদ্য পরিদর্শক\nতারিখ: ২০.০১.২০২৪; সময়: ৬০ মিনিট; পূর্ণমান: ১০০\n01. বাংলাদেশের রাজধানী কোথায়?\nSolution: ঢাকা।\n05. পদ্মা সেতুর দৈর্ঘ্য কত?\nSolution: ৬.১৫ কিমি।'
    ),
    // Exam 2 continues on Page 3 (Q06–Q10, no new exam header!)
    makeChunk(
      3,
      3,
      2,
      '06. সংবিধান দিবস কবে?\nSolution: ৪ নভেম্বর।\n10. বাংলাদেশের জাতীয় ফুল কী?\nSolution: শাপলা।'
    ),
    // Exam 3 starts on Page 4 (question resets to 01. with new header)
    makeChunk(
      4,
      4,
      3,
      'প্রাথমিক শিক্ষা অধিদপ্তর\nপদের নাম: সহকারী শিক্ষক\nতারিখ: ০২.০২.২০২৪; সময়: ৬০ মিনিট; পূর্ণমান: ৮০\n01. মুক্তিযুদ্ধ কত সালে শুরু হয়?\nSolution: ১৯৭১ সালে।'
    ),
  ];

  const examMode = buildSmartReaderViews(chunks, 'exam');
  assert.equal(examMode.views.length, 3);
  assert.equal(examMode.views[0].title, 'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট');
  assert.equal(examMode.views[0].pageLabel, 'পৃষ্ঠা 1');
  assert.equal(examMode.views[1].title, 'খাদ্য অধিদপ্তর — উপখাদ্য পরিদর্শক');
  assert.equal(examMode.views[1].pageLabel, 'পৃষ্ঠা 2–3');
  assert.ok(examMode.views[1].content.includes('01. বাংলাদেশের রাজধানী কোথায়?'));
  assert.ok(examMode.views[1].content.includes('10. বাংলাদেশের জাতীয় ফুল কী?'));
  assert.equal(examMode.views[2].title, 'প্রাথমিক শিক্ষা অধিদপ্তর — সহকারী শিক্ষক');
  assert.equal(examMode.views[2].pageLabel, 'পৃষ্ঠা 4');

  const pageMode = buildSmartReaderViews(chunks, 'page');
  assert.equal(pageMode.views.length, 4);
  assert.equal(pageMode.views[1].pageLabel, 'পৃষ্ঠা 2');
  assert.equal(pageMode.views[2].pageLabel, 'পৃষ্ঠা 3');
});

test('Test 3: Regular non-exam BCS textbook keeps clean per-chapter page views without forcing exam mode', () => {
  const textbookChunks: BookChunk[] = [
    makeChunk(
      10,
      14,
      0,
      'বাংলাদেশের সংবিধান ১৯৭২ সালের ৪ নভেম্বর গণপরিষদে গৃহীত হয় এবং ১৬ ডিসেম্বর কার্যকর হয়।',
      'অধ্যায় ১: সংবিধান প্রণয়নের ইতিহাস ও মূলনীতি'
    ),
    makeChunk(
      11,
      42,
      1,
      'অনুচ্ছেদ ২৬ থেকে ৪৭ক পর্যন্ত মৌলিক অধিকারের বিধানাবলি সন্নিবেশিত আছে।',
      'অধ্যায় ২: মৌলিক অধিকার (অনুচ্ছেদ ২৬–৪৭ক)'
    ),
  ];

  const res = buildSmartReaderViews(textbookChunks, 'exam');
  assert.equal(res.isExamBook, false);
  assert.equal(res.effectiveMode, 'page');
  assert.equal(res.views.length, 2);
  assert.equal(res.views[0].title, 'অধ্যায় ১: সংবিধান প্রণয়নের ইতিহাস ও মূলনীতি');
  assert.equal(res.views[0].pageLabel, 'পৃষ্ঠা 14');
  assert.equal(res.views[1].pageLabel, 'পৃষ্ঠা 42');
});

test('Test 4: extractExamTitleFromText and normalizeExamDocumentFormatting handle zero-space options cleanly', () => {
  const raw =
    'মৎস্য অধিদপ্তর\nপদের নামঃ হ্যাচারি এটেন্ডেন্ট\n01. সন্ধি বিচ্ছেদ করুন:\na) নবান্ন = নব + অন্ন। b)হিমালয় = হিম + আলয়।\nc) সজ্জন = সৎ + জন d)একচ্ছত্র = এক + ছত্র।';
  const formatted = normalizeExamDocumentFormatting(raw);
  assert.equal(
    extractExamTitleFromText(formatted),
    'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট'
  );
  assert.ok(formatted.includes('    b) হিমালয় = হিম + আলয়।'));
  assert.ok(formatted.includes('    d) একচ্ছত্র = এক + ছত্র।'));

  const pages = mergeBookChunksByPage([makeChunk(1, 1, 0, raw)]);
  const exams = groupBookPagesIntoExams(pages);
  assert.equal(exams.length, 1);
  assert.equal(exams[0].title, 'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট');
});

test('Test 5: buildFullPageBookChunks keeps a large (>7,000 char) extracted exam page as ONE intact full-page chunk and auto-labels exam title', () => {
  const repeatedQuestions = Array.from({ length: 45 }, (_, idx) => {
    const qNo = String(idx + 1).padStart(2, '0');
    return `${qNo}. বাংলাদেশের প্রশাসনিক ও অর্থনৈতিক উন্নয়ন সংক্রান্ত বিস্তারিত প্রশ্ন নম্বর ${qNo} কী?\nSolution: এটি একটি দীর্ঘ ও বিস্তারিত ব্যাখ্যাসহ পূর্ণাঙ্গ উত্তর যেখানে মূল পয়েন্ট, সাল, তারিখ এবং রেফারেন্স সংযুক্ত আছে (${qNo})।`;
  }).join('\n');

  const fullExamPageContent = [
    'মৎস্য অধিদপ্তর',
    'পদের নাম: হ্যাচারি এটেন্ডেন্ট',
    'তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০',
    repeatedQuestions,
  ].join('\n');

  assert.ok(fullExamPageContent.length > 7000, 'Expected test page content > 7,000 chars');

  const extractionResult: CombinedExtractionResult = {
    totalDocumentPages: 1,
    totalExtractedPages: 1,
    completedPages: [1],
    missingPages: [],
    isComplete: true,
    combinedText: fullExamPageContent,
    sections: [
      {
        chapter: 'অধ্যায় ১: মূল আলোচনা',
        pageNumber: 1,
        content: fullExamPageContent,
      },
    ],
  };

  const savedChunks = buildFullPageBookChunks({
    bookTitle: 'Recent Job SOLUTION Part 01',
    fallbackChapter: 'অধ্যায় ১: মূল আলোচনা',
    rawText: fullExamPageContent,
    extractionResult,
    rawTextModifiedByUser: false,
  });

  // Zero mid-page slicing: 1 full page in -> 1 full page out!
  assert.equal(savedChunks.length, 1);
  assert.equal(savedChunks[0].pageNumber, 1);
  assert.equal(savedChunks[0].chapter, 'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট');
  assert.ok(savedChunks[0].content.includes('01. বাংলাদেশের'));
  assert.ok(savedChunks[0].content.includes('45. বাংলাদেশের'));
});

test('Test 6: buildFullPageBookChunks preserves explicit page markers intact and keeps un-marked pasted exam papers unfragmented', () => {
  const multiPageRaw = [
    '--- পৃষ্ঠা 1 ---',
    '[অধ্যায় ১: মূল আলোচনা]',
    'মৎস্য অধিদপ্তর',
    'পদের নাম: হ্যাচারি এটেন্ডেন্ট',
    '01. সন্ধি বিচ্ছেদ করুন:',
    'a) নবান্ন = নব + অন্ন।',
    '',
    '--- পৃষ্ঠা 2 ---',
    'খাদ্য অধিদপ্তর',
    'পদের নাম: উপখাদ্য পরিদর্শক',
    '01. বাংলাদেশের রাজধানী কোথায়?',
    'Solution: ঢাকা।',
  ].join('\n');

  const explicitChunks = buildFullPageBookChunks({
    bookTitle: 'Job Solution TXT',
    fallbackChapter: 'অধ্যায় ১: মূল আলোচনা',
    rawText: multiPageRaw,
    extractionResult: null,
    rawTextModifiedByUser: true,
  });

  assert.equal(explicitChunks.length, 2);
  assert.equal(explicitChunks[0].pageNumber, 1);
  assert.equal(explicitChunks[0].chapter, 'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট');
  assert.equal(explicitChunks[1].pageNumber, 2);
  assert.equal(explicitChunks[1].chapter, 'খাদ্য অধিদপ্তর — উপখাদ্য পরিদর্শক');

  const unmarkedExam = [
    'মৎস্য অধিদপ্তর',
    'পদের নাম: হ্যাচারি এটেন্ডেন্ট',
    'তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০',
    ...Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(2, '0')}. প্রশ্ন নম্বর ${i + 1}?\nSolution: উত্তর ${i + 1}।`),
  ].join('\n');

  const unmarkedChunks = buildFullPageBookChunks({
    bookTitle: 'Pasted Exam',
    fallbackChapter: 'অধ্যায় ১: মূল আলোচনা',
    rawText: unmarkedExam,
    extractionResult: null,
    rawTextModifiedByUser: false,
  });

  assert.equal(unmarkedChunks.length, 1);
  assert.equal(unmarkedChunks[0].chapter, 'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট');
  assert.ok(unmarkedChunks[0].content.includes('20. প্রশ্ন নম্বর 20?'));
});

test('Test 7: buildBookCardSummary and buildFullPageSearchChunks deduplicate fragmented Page-1 chunks into 1 exam summary and 1 intact searchable page', () => {
  const fragmentedChunks: BookChunk[] = [
    makeChunk(1, 1, 0, 'মৎস্য অধিদপ্তর\nপদের নাম: হ্যাচারি এটেন্ডেন্ট\n01. সন্ধি বিচ্ছেদ করুন:\na) নবান্ন = নব + অন্ন।'),
    makeChunk(2, 1, 1, '02. বিপরীত শব্দ:\na) সাকার = নিরাকার।'),
    makeChunk(3, 1, 2, '03. MRT এর পূর্ণরূপ লিখুন।\nSolution: Mass Rapid Transit.'),
    makeChunk(4, 1, 3, '04. বঙ্গবন্ধু শেখ মুজিবুর রহমানের জন্মদিন কবে?\nSolution: ১৭ মার্চ।'),
    makeChunk(5, 1, 4, '05. পাড়সহ পুকুরের ক্ষেত্রফল কত?\nSolution: ৯৭৬ বর্গমিটার।'),
  ];

  const summary = buildBookCardSummary(fragmentedChunks);
  assert.equal(summary.isExamBook, true);
  assert.equal(summary.unitCount, 1);
  assert.equal(summary.unitLabel, '1টি পরীক্ষা');
  assert.deepEqual(summary.previewLabels, [
    'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট (পৃষ্ঠা 1)',
  ]);

  const fakeBook: Book = {
    id: 99,
    title: 'Recent Job SOLUTION Part 01',
    subject: 'বাংলাদেশ বিষয়াবলি',
    category: 'রিসেন্ট জব সলুশন',
    author: 'Recent Publication',
    totalPages: 1,
    extractionMethod: 'ocr',
    uploadedAt: '2026-01-01',
    chunks: fragmentedChunks,
  };

  const searchChunks = buildFullPageSearchChunks([fakeBook]);
  assert.equal(searchChunks.length, 1);
  assert.equal(searchChunks[0].pageNumber, 1);
  assert.equal(searchChunks[0].chapter, 'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট');
  assert.ok(searchChunks[0].content.includes('01. সন্ধি বিচ্ছেদ করুন:'));
  assert.ok(searchChunks[0].content.includes('05. পাড়সহ পুকুরের ক্ষেত্রফল কত?'));
});

