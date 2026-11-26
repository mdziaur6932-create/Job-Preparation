import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasExamDocumentStructure,
  isVerticallyFragmentedText,
  normalizeExamDocumentFormatting,
  parseExamDocumentForDisplay,
  reconstructPdfPageTextFromTextItems,
  type PdfPositionedTextItem,
} from './exam-text-formatter';
import { evaluateLocalExtractedPageText, validateAndNormalizeBatchPages } from './pdf-rules';
import { parseAiJson, protectJsonLatexBackslashes } from './gemini';
import { repairCorruptedLatexControlChars } from './exam-math-and-answer-guard';

test('Test 1: Detects and cleanly reflows 1-word-per-line vertical fragmentation matching user Job Solution screenshot', () => {
  const brokenOneWordPerLine = [
    'মৎস্য',
    'অধিদপ্তর',
    'পদের',
    'নামঃ',
    'হ্যাচারি',
    'এটেন্ডেন্ট',
    'তারিখঃ',
    '১২.০১.২০২৪;',
    'সময়ঃ',
    '৩০',
    'মিনিট;',
    'পূর্ণমানঃ',
    '১০০',
    '01.',
    'সন্ধি',
    'বিচ্ছেদ',
    'করুন:',
    'a)',
    'নবান্ন',
    '=',
    'নব',
    '+',
    'অন্ন।',
    'b)',
    'হিমালয়',
    '=',
    'হিম',
    '+',
    'আলয়।',
    'c)',
    'সজ্জন',
    '=',
    'সৎ',
    '+',
    'জন।',
    'd)',
    'একচ্ছত্র',
    '=',
    'এক',
    '+',
    'ছত্র।',
    'e)',
    'স্বচ্ছন্দ',
    '=',
    'স্ব',
    '+',
    'ছন্দ।',
    '02.',
    'এক',
    'কথায়',
    'প্রকাশ',
    'করুন:',
    'a)',
    'যে',
    'সকল',
    'অত্যাচার',
    'সহ্য',
    'করে',
    '=',
    'সর্বসহা।',
    'b)',
    'যে',
    'বন',
    'হিংস্র',
    'জন্তুতে',
    'পরিপূর্ণ',
    '=',
    'শাপদসঙ্কুল।',
    '03.',
    'বিপরীত',
    'শব্দ',
    'লিখুন:',
    'a)',
    'সাকার',
    '=',
    'নিরাকার।',
    'b)',
    'উৎকর্ষ',
    '=',
    'অপকর্ষ।',
  ].join('\n');

  assert.equal(isVerticallyFragmentedText(brokenOneWordPerLine), true);

  const formatted = normalizeExamDocumentFormatting(brokenOneWordPerLine);
  assert.equal(isVerticallyFragmentedText(formatted), false);
  assert.equal(hasExamDocumentStructure(formatted), true);

  const lines = formatted.split('\n').filter(Boolean);
  assert.equal(lines[0], 'মৎস্য অধিদপ্তর');
  assert.equal(lines[1], 'পদের নাম: হ্যাচারি এটেন্ডেন্ট');
  assert.equal(lines[2], 'তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০');
  assert.equal(lines[3], '01. সন্ধি বিচ্ছেদ করুন:');
  assert.equal(lines[4], '    a) নবান্ন = নব + অন্ন।');
  assert.equal(lines[5], '    b) হিমালয় = হিম + আলয়।');
  assert.equal(lines[6], '    c) সজ্জন = সৎ + জন।');
  assert.equal(lines[7], '    d) একচ্ছত্র = এক + ছত্র।');
  assert.equal(lines[8], '    e) স্বচ্ছন্দ = স্ব + ছন্দ।');
  assert.equal(lines[9], '02. এক কথায় প্রকাশ করুন:');
  assert.equal(lines[10], '    a) যে সকল অত্যাচার সহ্য করে = সর্বসহা।');
  assert.equal(lines[11], '    b) যে বন হিংস্র জন্তুতে পরিপূর্ণ = শাপদসঙ্কুল।');
  assert.equal(lines[12], '03. বিপরীত শব্দ লিখুন:');
  assert.equal(lines[13], '    a) সাকার = নিরাকার।');
  assert.equal(lines[14], '    b) উৎকর্ষ = অপকর্ষ।');
});

test('Test 2: Splits side-by-side 2-column sub-options while preserving inline English article answers like (a) and (the)', () => {
  const inlineOptionsPage = [
    '01. সন্ধি বিচ্ছেদ করুন:',
    'a) নবান্ন = নব + অন্ন। b) হিমালয় = হিম + আলয়।',
    'c) সজ্জন = সৎ + জন। d) একচ্ছত্র = এক + ছত্র।',
    '04. Fill in the gap using appropriate Article:',
    'a) ____ rich are not always happy. (the) বাক্যের অর্থঃ ধনীরা সর্বদা সুখী হয় না।',
    'b) You are ____ Nazrul, I see. (a) বাক্যের অর্থঃ তুমি তো দেখি একজন নজরুল।',
    'c) This is ____ very charming sight. (a) বাক্যের অর্থঃ এটি একটি অত্যন্ত মনোমুগ্ধকর দৃশ্য।',
    '06. MRT এর পূর্ণরূপ লিখুন। Solution: Mass Rapid Transit.',
    'Recent Publication 1',
  ].join('\n');

  const formatted = normalizeExamDocumentFormatting(inlineOptionsPage);

  assert.ok(formatted.includes('    a) নবান্ন = নব + অন্ন।\n    b) হিমালয় = হিম + আলয়।'));
  assert.ok(formatted.includes('    c) সজ্জন = সৎ + জন।\n    d) একচ্ছত্র = এক + ছত্র।'));
  // Inline English article "(a)" MUST stay on the same line as b) and c)
  assert.ok(
    formatted.includes(
      '    b) You are ____ Nazrul, I see. (a) বাক্যের অর্থ: তুমি তো দেখি একজন নজরুল।'
    )
  );
  assert.ok(
    formatted.includes(
      '    c) This is ____ very charming sight. (a) বাক্যের অর্থ: এটি একটি অত্যন্ত মনোমুগ্ধকর দৃশ্য।'
    )
  );
  // Solution must appear on its own line
  assert.ok(formatted.includes('06. MRT এর পূর্ণরূপ লিখুন।\nSolution: Mass Rapid Transit.'));
  // Footer watermark stripped
  assert.ok(!formatted.includes('Recent Publication 1'));
});

test('Test 3: Reconstructs 2-column PDF text items in strict Left-Column then Right-Column order without 1-word-per-line breaks', () => {
  const items: PdfPositionedTextItem[] = [
    // Left column (x ~ 50..260), Y descending from 740 to 620
    { str: 'মৎস্য', x: 110, y: 740, width: 35, height: 12, fontSize: 12, hasEOL: true },
    { str: 'অধিদপ্তর', x: 150, y: 740, width: 45, height: 12, fontSize: 12, hasEOL: true },
    { str: 'পদের', x: 85, y: 722, width: 28, height: 10, fontSize: 10, hasEOL: true },
    { str: 'নামঃ', x: 118, y: 722, width: 24, height: 10, fontSize: 10, hasEOL: true },
    { str: 'হ্যাচারি', x: 147, y: 722, width: 35, height: 10, fontSize: 10, hasEOL: true },
    { str: 'এটেন্ডেন্ট', x: 187, y: 722, width: 45, height: 10, fontSize: 10, hasEOL: true },
    { str: '01.', x: 50, y: 700, width: 15, height: 10, fontSize: 10, hasEOL: true },
    { str: 'সন্ধি', x: 70, y: 700, width: 25, height: 10, fontSize: 10, hasEOL: true },
    { str: 'বিচ্ছেদ', x: 100, y: 700, width: 32, height: 10, fontSize: 10, hasEOL: true },
    { str: 'করুন:', x: 137, y: 700, width: 25, height: 10, fontSize: 10, hasEOL: true },
    { str: 'a)', x: 65, y: 682, width: 12, height: 10, fontSize: 10, hasEOL: true },
    { str: 'নবান্ন', x: 82, y: 682, width: 30, height: 10, fontSize: 10, hasEOL: true },
    { str: '=', x: 117, y: 682, width: 8, height: 10, fontSize: 10, hasEOL: true },
    { str: 'নব + অন্ন।', x: 130, y: 682, width: 55, height: 10, fontSize: 10, hasEOL: true },
    { str: 'b)', x: 65, y: 664, width: 12, height: 10, fontSize: 10, hasEOL: true },
    { str: 'হিমালয় = হিম + আলয়।', x: 82, y: 664, width: 115, height: 10, fontSize: 10, hasEOL: true },
    { str: '02.', x: 50, y: 644, width: 15, height: 10, fontSize: 10, hasEOL: true },
    { str: 'বিপরীত শব্দ লিখুন:', x: 70, y: 644, width: 95, height: 10, fontSize: 10, hasEOL: true },

    // Right column (x ~ 320..540), overlapping same Y range (740 to 644)
    { str: '08.', x: 320, y: 740, width: 15, height: 10, fontSize: 10, hasEOL: true },
    { str: 'দ্বাদশ জাতীয় সংসদ', x: 340, y: 740, width: 120, height: 10, fontSize: 10, hasEOL: true },
    { str: 'নির্বাচন কবে হয়?', x: 340, y: 722, width: 110, height: 10, fontSize: 10, hasEOL: true },
    { str: 'Solution:', x: 320, y: 700, width: 42, height: 10, fontSize: 10, hasEOL: true },
    { str: '৭ জানুয়ারি ২০২৪।', x: 368, y: 700, width: 95, height: 10, fontSize: 10, hasEOL: true },
    { str: '09.', x: 320, y: 682, width: 15, height: 10, fontSize: 10, hasEOL: true },
    { str: 'বঙ্গবন্ধুর জন্মদিন কবে?', x: 340, y: 682, width: 120, height: 10, fontSize: 10, hasEOL: true },
    { str: 'Solution:', x: 320, y: 664, width: 42, height: 10, fontSize: 10, hasEOL: true },
    { str: '১৭ মার্চ।', x: 368, y: 664, width: 45, height: 10, fontSize: 10, hasEOL: true },
    { str: '10.', x: 320, y: 644, width: 15, height: 10, fontSize: 10, hasEOL: true },
    { str: 'PG এর পূর্ণরূপ লিখুন।', x: 340, y: 644, width: 115, height: 10, fontSize: 10, hasEOL: true },
  ];

  const reconstructed = reconstructPdfPageTextFromTextItems(items);
  const formatted = normalizeExamDocumentFormatting(reconstructed);

  // Left column MUST appear completely before right column ("08.")
  const idxLeft01 = formatted.indexOf('01. সন্ধি বিচ্ছেদ করুন:');
  const idxLeft02 = formatted.indexOf('02. বিপরীত শব্দ লিখুন:');
  const idxRight08 = formatted.indexOf('08. দ্বাদশ জাতীয় সংসদ');
  const idxRight10 = formatted.indexOf('10. PG এর পূর্ণরূপ লিখুন।');

  assert.ok(idxLeft01 >= 0, 'Left Q01 found');
  assert.ok(idxLeft02 > idxLeft01, 'Left Q02 comes after Q01');
  assert.ok(idxRight08 > idxLeft02, 'Right Q08 comes AFTER entire left column');
  assert.ok(idxRight10 > idxRight08, 'Right Q10 comes after Q08');
  assert.ok(formatted.includes('মৎস্য অধিদপ্তর\nপদের নাম: হ্যাচারি এটেন্ডেন্ট'));
});

test('Test 4: Preserves ordinary multi-paragraph BCS/Bank textbook prose without altering structure', () => {
  const regularProse = [
    'বাংলাদেশের সংবিধানের অনুচ্ছেদ ৮১ অনুযায়ী অর্থবিল শুধুমাত্র জাতীয় সংসদে উত্থাপন করা যায়।',
    '',
    'অর্থবিল উত্থাপনের জন্য রাষ্ট্রপতির পূর্বানুমতি প্রয়োজন হয় এবং স্পিকারের সনদপত্র চূড়ান্ত বলে গণ্য হয়। দুঃখ ও অন্তঃপুর শব্দের বিসর্গ অক্ষুণ্ণ থাকবে।',
  ].join('\n');

  assert.equal(isVerticallyFragmentedText(regularProse), false);
  assert.equal(hasExamDocumentStructure(regularProse), false);

  const formatted = normalizeExamDocumentFormatting(regularProse);
  assert.equal(formatted, regularProse);
});

test('Test 5: Local PDF evaluation and Gemini batch validation both auto-normalize vertical fragmentation', () => {
  const fragmentedLocal = [
    'মৎস্য',
    'অধিদপ্তর',
    'পদের',
    'নামঃ',
    'হ্যাচারি',
    'এটেন্ডেন্ট',
    '01.',
    'সন্ধি',
    'বিচ্ছেদ',
    'করুন:',
    'a)',
    'নবান্ন',
    '=',
    'নব',
    '+',
    'অন্ন।',
    'b)',
    'হিমালয়',
    '=',
    'হিম',
    '+',
    'আলয়।',
  ].join('\n');

  const localEval = evaluateLocalExtractedPageText(fragmentedLocal);
  assert.equal(localEval.usable, true);
  assert.ok(localEval.cleanedText.includes('মৎস্য অধিদপ্তর\nপদের নাম: হ্যাচারি এটেন্ডেন্ট'));
  assert.ok(localEval.cleanedText.includes('    a) নবান্ন = নব + অন্ন।'));

  const batchResult = validateAndNormalizeBatchPages({
    batchIndex: 0,
    expectedMappings: [{ pdfPageIndex: 1, originalPageNumber: 1 }],
    rawPages: [
      {
        pdfPageIndex: 1,
        originalPageNumber: 1,
        chapter: 'মৎস্য অধিদপ্তর',
        content: fragmentedLocal,
        hasReadableText: true,
        ocrUsed: true,
      },
    ],
    fallbackChapter: 'অধ্যায় ১',
    useOcr: true,
    batchRequiresOcr: true,
    usedFilesApi: false,
  });

  assert.equal(batchResult.status, 'success');
  assert.ok(batchResult.pages[0].content.includes('01. সন্ধি বিচ্ছেদ করুন:\n    a) নবান্ন = নব + অন্ন।'));
});

test('Test 6: Image 1 MCQ — strips red-boxed page citations & prebd watermark, keeps 18pt header, hoists side উ. ক/উ. ঘ answers cleanly below all 4 options', () => {
  const image1Raw = `পদের নাম: সহকারী পরিচালক
সময়: ৬০ মিনিট পরীক্ষার তারিখ: ০৯.০১.২০২৬ পূর্ণমান: ১০০

১. ২০২৫ সালে কতজন নারী নোবেল পুরস্কার লাভ করেন?
ক. ২ জন খ. ১ জন উ. ক
গ. ৪ জন ঘ. ৩ জন
পৃষ্ঠা: ৫৮ (ক্রিম; জানুয়ারি- ২০২৫)

৩. ২০২৫ সালে কোন দেশ New Development Bank (NDB) এর সর্বশেষ সদস্য হিসেবে যোগদান করেছে?
ক. আলজেরিয়া খ. দক্ষিণ আফ্রিকা
গ. সংযুক্ত আরব আমিরাত ঘ. ব্রুনাই উ. ক
পৃষ্ঠা: ৫২ (ক্রিম; জানুয়ারি- ২০২৫)

৪. আন্তর্জাতিক অভিবাসী দিবস কত তারিখে?
ক. ১৫ ডিসেম্বর খ. ১৭ জানুয়ারি
গ. ১৮ ডিসেম্বর ঘ. ১৬ ফেব্রুয়ারি উ. গ
পৃষ্ঠা: ৩৪৭ (অগ্রদূত আন্তর্জাতিক বিষয়াবলি; ৮ম সংস্করণ)

১০.মার্কিন ডলারে কতজনের স্বাক্ষর থাকে?
ক. ১ জন খ. ২ জন
গ. ৩ জন ঘ. কারও স্বাক্ষর থাকে না উ. খ

১১.Chancellor of Ex-chequer কোন দেশের অর্থমন্ত্রীর পদবী?www.prebd.com
ক. জার্মানি খ. যুক্তরাষ্ট্র
গ. অস্ট্রিয়া ঘ. যুক্তরাজ্য উ. ঘ
পৃষ্ঠা: ৮৫ (অগ্রদূত আন্তর্জাতিক বিষয়াবলি; ৮ম সংস্করণ)`;

  const formatted = normalizeExamDocumentFormatting(image1Raw);
  const parsed = parseExamDocumentForDisplay(formatted);

  assert.equal(parsed.isExam, true);
  assert.deepEqual(parsed.headerLines, [
    'পদের নাম: সহকারী পরিচালক',
    'সময়: ৬০ মিনিট পরীক্ষার তারিখ: ০৯.০১.২০২৬ পূর্ণমান: ১০০',
  ]);

  // All red-boxed page citations & www.prebd.com watermark must be 100% stripped
  assert.ok(!formatted.includes('পৃষ্ঠা: ৫৮'));
  assert.ok(!formatted.includes('ক্রিম; জানুয়ারি'));
  assert.ok(!formatted.includes('অগ্রদূত আন্তর্জাতিক বিষয়াবলি'));
  assert.ok(!formatted.includes('prebd.com'));

  // All 5 questions including numeric starts (`১. ২০২৫`, `৩. ২০২৫`) and zero-space (`১০.মার্কিন`, `১১.Chancellor`) detected
  const questions = parsed.bodyItems.filter((i) => i.kind === 'question');
  assert.equal(questions.length, 5);
  assert.equal(questions[0].numberLabel, '১.');
  assert.equal(questions[3].numberLabel, '১০.');
  assert.equal(questions[4].numberLabel, '১১.');

  // Margin answer `উ. ক` next to option খ. in Q1 MUST be hoisted AFTER option ঘ. ৩ জন!
  assert.match(formatted, /ঘ\. ৩ জন\nউত্তর: ক/);
  assert.match(formatted, /ঘ\. কারও স্বাক্ষর থাকে না\nউত্তর: খ/);
  assert.match(formatted, /ঘ\. যুক্তরাজ্য\nউত্তর: ঘ/);
});

test('Test 7: Image 2 MCQ — extracts side ans. B / ans. C cleanly below options and preserves maroon Solution boxes as distinct ব্যাখ্যা: items', () => {
  const image2Raw = `দুর্নীতি দমন কমিশন
পদের নামঃ উপ সহকারী পরিচালক
তারিখঃ ০৩.০১.২০২৬; সময়ঃ ৬০ মিনিট; পূর্ণমানঃ ১০০

01. IDA স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?
a) মাইক্রোক্রেডিট b) সফট লোন ans. B
c) বাণিজ্যিক লোন d) পণ্য সাহায্য
Solution: IDA হলো বিশ্বব্যাংকের একটি অঙ্গসংস্থা। IDA (International Development Association) বা আন্তর্জাতিক উন্নয়ন সমিতি। যুক্তরাষ্ট্রের ওয়াশিংটন ডিসিতে এর সদর দপ্তর অবস্থিত। এটি IDA, Soft Loan Window নামেও পরিচিত।

06. পাপুয়া নিউগিনি কোন অঞ্চলের অন্তর্ভুক্ত?
a) পলিনেশিয়া b) মাইক্রোনেশিয়া
c) মেলানেশিয়া d) ওরিয়েন্টাল অঞ্চল ans. C
Solution: পাপুয়া নিউগিনির রাজধানী হলো পোর্ট মোর্সবি আর আইন সভার নাম হলো জাতীয় সংসদ।

07. ডোনাল্ড ট্রাম্প প্রথম মেয়াদে যুক্তরাষ্ট্রের কততম প্রেসিডেন্ট ছিলেন?
a) ৪৩তম b) ৪৪তম
c) ৪৫তম d) ৪৭তম ans. C
Solution: ডোনাল্ড ট্রাম্প মার্কিন যুক্তরাষ্ট্রের ৪৫তম প্রেসিডেন্ট। তিনি ২০১৭ সালের ২০ জানুয়ারি ৪৫তম প্রেসিডেন্ট হিসেবে শপথ গ্রহণ করেন।`;

  const formatted = normalizeExamDocumentFormatting(image2Raw);
  const parsed = parseExamDocumentForDisplay(formatted);

  assert.equal(parsed.isExam, true);
  assert.deepEqual(parsed.headerLines, [
    'দুর্নীতি দমন কমিশন',
    'পদের নাম: উপ সহকারী পরিচালক',
    'তারিখ: ০৩.০১.২০২৬; সময়: ৬০ মিনিট; পূর্ণমান: ১০০',
  ]);

  // Every MCQ Solution: must be converted to ব্যাখ্যা: (NOT Solution: or Explanation:)
  assert.ok(!/\bSolution\s*:/i.test(formatted));
  assert.match(formatted, /d\) পণ্য সাহায্য\nAnswer: B\nব্যাখ্যা: IDA হলো বিশ্বব্যাংকের/);
  assert.match(formatted, /d\) ওরিয়েন্টাল অঞ্চল\nAnswer: C\nব্যাখ্যা: পাপুয়া নিউগিনির/);
  assert.match(formatted, /d\) ৪৭তম\nAnswer: C\nব্যাখ্যা: ডোনাল্ড ট্রাম্প/);

  const solutions = parsed.bodyItems.filter((i) => i.kind === 'solution');
  const explanations = parsed.bodyItems.filter((i) => i.kind === 'explanation');
  assert.equal(solutions.length, 3);
  assert.deepEqual(
    solutions.map((s) => s.text),
    ['B', 'C', 'C']
  );
  assert.equal(explanations.length, 3);
  assert.equal(explanations[0].label, 'ব্যাখ্যা');
  assert.ok(explanations[0].text.includes('Soft Loan Window'));
});

test('Test 8: Image 3 MCQ — detaches right-margin উত্তর: গ / উত্তর: খ / উত্তর: ঘ / উত্তর: ক cleanly below options including quoted stems', () => {
  const image3Raw = `৯৩. ‘হনুজ দিল্লি দূরঅন্ত (দিল্লি এখনো অনেক দূর)।’ -উক্তিটি কার?
ক. হযরত শেখ সাদী রহ.
খ. হযরত শাহজালাল রহ.
গ. হযরত নিজামুদ্দিন আউলিয়া রহ.
ঘ. হযরত খান জাহান আলী রহ. উত্তর: গ

৯৪. সুন্দরবনের কত শতাংশ বাংলাদেশে পড়েছে?
ক. ৪২ শতাংশ খ. ৬২ শতাংশ
গ. ৬৮ শতাংশ ঘ. ৫৮ শতাংশ উত্তর: খ

৯৬. ‘The 100’ বইটি কার লেখা?
ক. মাইকেল এইচ. হার্ট
খ. মরিস বুকাইলি
গ. নিকোলাস পি. এগনাইড্স
ঘ. এস. পি. হান্টিংটন উত্তর: ক`;

  const formatted = normalizeExamDocumentFormatting(image3Raw);
  const parsed = parseExamDocumentForDisplay(formatted);

  assert.equal(parsed.isExam, true);
  const questions = parsed.bodyItems.filter((i) => i.kind === 'question');
  assert.equal(questions.length, 3);
  assert.equal(questions[0].numberLabel, '৯৩.');
  assert.equal(questions[2].numberLabel, '৯৬.');

  const answers = parsed.bodyItems.filter((i) => i.kind === 'solution');
  assert.equal(answers.length, 3);
  assert.deepEqual(
    answers.map((a) => `${a.label}: ${a.text}`),
    ['উত্তর: গ', 'উত্তর: খ', 'উত্তর: ক']
  );
  assert.match(formatted, /ঘ\. হযরত খান জাহান আলী রহ\.\nউত্তর: গ/);
  assert.match(formatted, /ঘ\. এস\. পি\. হান্টিংটন\nউত্তর: ক/);
});

test('Test 9: preserves Markdown tables and **bold**/*italic*/<u>underlined</u> formatting inside exam papers', () => {
  const richExam = `বাংলাদেশ সরকারি কর্ম কমিশন
পদের নাম: সহকারী পরিচালক
সময়: ৬০ মিনিট; তারিখ: ২০.০৪.২০২৬; পূর্ণমান: ১০০

১. He ran <u>fast</u>. Here the **underlined** word is an *example* of—
ক. Noun খ. Verb
গ. Adverb ঘ. Adjective উত্তর: গ
ব্যাখ্যা: এখানে <u>fast</u> শব্দটি **ran** (*verb*)-কে modify করায় এটি **Adverb**।

২. নিচের ছকটি লক্ষ্য করুন এবং সঠিক তথ্য মিলিয়ে নিন:
| ক্রমিক | প্রতিষ্ঠানের নাম | প্রতিষ্ঠাকাল |
| :---: | :--- | ---: |
| ১ | **ঢাকা বিশ্ববিদ্যালয়** | ১৯২১ |
| ২ | *বাংলা একাডেমি* | ১৯৫৫ |
ক. ১ ও ২ উভয়ই সঠিক খ. কেবল ১ সঠিক
গ. কেবল ২ সঠিক ঘ. কোনোটিই নয় উত্তর: ক
ব্যাখ্যা: ছকের উভয় তথ্যই ঐতিহাসিকভাবে সঠিক।`;

  const formatted = normalizeExamDocumentFormatting(richExam);
  const parsed = parseExamDocumentForDisplay(formatted);

  assert.equal(parsed.isExam, true);
  const questions = parsed.bodyItems.filter((i) => i.kind === 'question');
  assert.equal(questions.length, 2);
  assert.ok(questions[0].text.includes('<u>fast</u>'));
  assert.ok(questions[0].text.includes('**underlined**'));
  assert.ok(questions[0].text.includes('*example*'));

  const tables = parsed.bodyItems.filter((i) => i.kind === 'table');
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, ['ক্রমিক', 'প্রতিষ্ঠানের নাম', 'প্রতিষ্ঠাকাল']);
  assert.deepEqual(tables[0].alignments, ['center', 'left', 'right']);
  assert.equal(tables[0].rows.length, 2);
  assert.equal(tables[0].rows[0][1], '**ঢাকা বিশ্ববিদ্যালয়**');
  assert.equal(tables[0].rows[1][1], '*বাংলা একাডেমি*');
});

test('Test 10: Q47 LaTeX JSON escape guard prevents \\frac -> form-feed corruption AND heals already-saved rac{4}{5}', () => {
  // 1) Raw Gemini JSON where \frac was single-escaped (\f would normally turn into \u000C in JSON.parse)
  const rawAiJson = '{"content":"৪৭. ΔABC-এ cosA = \\frac{4}{5}, cosB = \\frac{5}{13} এবং 2 \\times \\theta \\neq 0"}';
  const protectedJson = protectJsonLatexBackslashes(rawAiJson);
  assert.ok(protectedJson.includes('\\\\frac{4}{5}'));

  const parsedJson = parseAiJson<{ content: string }>(rawAiJson, 'object');
  assert.ok(parsedJson.content.includes('\\frac{4}{5}'));
  assert.ok(parsedJson.content.includes('\\frac{5}{13}'));
  assert.ok(parsedJson.content.includes('\\times'));
  assert.ok(parsedJson.content.includes('\\theta'));
  assert.equal(parsedJson.content.includes('\u000c'), false);

  // 2) Retroactive repair of already-saved corrupted text with form-feed or bare `rac{4}{5}`
  const corruptedSaved =
    '৪৭. ΔABC-এ cosA = \u000crac{4}{5}, cosB = rac{5}{13} নিচের কোনটি সঠিক?\nক. সূক্ষ্মকোণী\nখ. সমকোণী\nউত্তর: ঘ';
  const healed = repairCorruptedLatexControlChars(corruptedSaved);
  assert.ok(healed.includes('\\frac{4}{5}'));
  assert.ok(healed.includes('\\frac{5}{13}'));

  const formatted = normalizeExamDocumentFormatting(corruptedSaved);
  assert.ok(formatted.includes('\\frac{4}{5}'));
  assert.ok(formatted.includes('\\frac{5}{13}'));
  assert.equal(/\brac\{/.test(formatted), false);
});

test('Test 11: UGC exam header before reading passage promotes cleanly to 1-column headerLines and strips ক্রিম ad box', () => {
  const ugcExam = [
    'বিশ্ববিদ্যালয় মঞ্জুরী কমিশন',
    "সাম্প্রতিক সাধারণ জ্ঞানের অসাধারণ নির্যাস 'ক্রিম' লাইব্রেরিতে পাওয়া যাচ্ছে।",
    'পদের নাম: সহকারী পরিচালক',
    'সময়: ৬০ মিনিট',
    'পরীক্ষার তারিখ: ১৬.০১.২০২৬',
    'পূর্ণমান: ১০০',
    'Read the following passage carefully and answer question 1-5',
    'Throughout history, people have tried to understand the meaning of time. Some view time as a straight path, where moments pass once and never return.',
    '',
    '১. What idea does the passage present about the value of time?',
    'ক. Time is valuable only when used for work',
    'খ. Time should be measured strictly by hours and days',
    'গ. The value of time depends on how rich and meaningful moments are',
    'ঘ. A long life is always a meaningful one',
    'উত্তর: গ',
  ].join('\n');

  const parsed = parseExamDocumentForDisplay(ugcExam);
  assert.equal(parsed.isExam, true);
  assert.equal(
    parsed.formatted.includes('ক্রিম'),
    false,
    'Promotional ক্রিম notice must be stripped'
  );
  assert.deepEqual(parsed.headerLines, [
    'বিশ্ববিদ্যালয় মঞ্জুরী কমিশন',
    'পদের নাম: সহকারী পরিচালক',
    'সময়: ৬০ মিনিট',
    'পরীক্ষার তারিখ: ১৬.০১.২০২৬',
    'পূর্ণমান: ১০০',
  ]);
  // Reading passage must stay in bodyItems, NOT get swallowed into headerLines
  const textItems = parsed.bodyItems.filter((i) => i.kind === 'text');
  assert.ok(
    textItems.some((t) => t.text.includes('Read the following passage')),
    'Reading passage directive must remain in bodyItems'
  );
  assert.ok(
    textItems.some((t) => t.text.includes('Throughout history')),
    'Reading passage paragraph must remain in bodyItems'
  );
});

test('Test 12: manual <center> 1-column blocks, [চিত্র: ...] diagrams, and embedded figure images parse cleanly', () => {
  const customCenteredExam = [
    '<center>',
    'বাংলাদেশ ব্যাংক নিয়োগ পরীক্ষা',
    'পদের নাম: অ্যাসিস্ট্যান্ট ডিরেক্টর',
    '</center>',
    '',
    '৯৯. প্রদত্ত চিত্রটি ভাঁজ করে একটি ঘনক তৈরি করলে, তিনটি বিন্দু বিশিষ্ট পৃষ্ঠের বিপরীতে কতটি বিন্দু থাকবে?',
    '[চিত্র: ৬টি বর্গাকার তলের ঘনক-জাল যেখানে ৩ বিন্দুর বিপরীতে ৬ বিন্দু রয়েছে]',
    '![ঘনকের চিত্র](data:image/png;base64,AAAA)',
    '    ক. ২',
    '    খ. ৫',
    '    গ. ৪',
    '    ঘ. ৬',
    'উত্তর: ঘ',
    '',
    '<center>',
    'অংশ ২: সাধারণ জ্ঞান',
    '</center>',
    '',
    '১০০. বাংলাদেশের রাজধানী কোথায়?',
    '    ক. ঢাকা',
    '    খ. চট্টগ্রাম',
    'উত্তর: ক',
  ].join('\n');

  const parsed = parseExamDocumentForDisplay(customCenteredExam);
  assert.equal(parsed.isExam, true);
  assert.deepEqual(parsed.headerLines, [
    'বাংলাদেশ ব্যাংক নিয়োগ পরীক্ষা',
    'পদের নাম: অ্যাসিস্ট্যান্ট ডিরেক্টর',
  ]);

  const diagramItem = parsed.bodyItems.find((b) => b.kind === 'diagram');
  assert.ok(diagramItem && diagramItem.kind === 'diagram');
  assert.ok(diagramItem.caption.includes('ঘনক-জাল'));

  const imageItem = parsed.bodyItems.find((b) => b.kind === 'image');
  assert.ok(imageItem && imageItem.kind === 'image');
  assert.equal(imageItem.alt, 'ঘনকের চিত্র');

  const midCenter = parsed.bodyItems.find((b) => b.kind === 'center_block');
  assert.ok(midCenter && midCenter.kind === 'center_block');
  assert.deepEqual(midCenter.lines, ['অংশ ২: সাধারণ জ্ঞান']);
});



