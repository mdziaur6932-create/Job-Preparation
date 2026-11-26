import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeExamQuestionAnswers,
  cleanDeterministicMathSymbols,
  formatMathForPlainText,
  hasCorruptedMathOcr,
  mergeAiMissingAnswersSafely,
  mergeRepairedMathSafely,
  parseMathRichTokens,
} from './exam-math-and-answer-guard';
import {
  normalizeExamDocumentFormatting,
  parseExamDocumentForDisplay,
} from './exam-text-formatter';
import { formatExamPapersAsText } from './exam-paper-exporter';
import { evaluateLocalExtractedPageText } from './pdf-rules';

test('hasCorruptedMathOcr catches all 3 user screenshot patterns (broken fractions, exponents, prime factorization)', () => {
  const screenshot1Q16Q17 = `১৬. সমাধান করুন: + =x+32 oC 4 7 3x+7 5x-4 1
সমাধান:
4 7 =x+32
3x+7 5x-4 x- 7
4 7
7(3x+7) +4(5x - 4) --28x 7
28 2
n13x +33 728 2の
⇒ 13x+33 ==2×28
⇒ x=5

১৭. উৎপাদকেবিশ্লেষণ করুন: x°(y²- z) +y°(@ -x²) +z'(x²-y)`;

  const screenshot2Q18 = `১৮. ৩টি ঝুড়ির ১ম, ২য় ও ৩য় টিতে যথাক্রমে ১৫৯টি আম, ২২৭টি জাম এবং ৪০১টি লিচু আছে। সর্বাধিক কতজনের মধ্যে ফলগুলো সমানভাবে ভাগ করে দিলে ৩টি আম, ৬টি জাম ও ১১টি লিচু অবশিষ্ট থাকবে?
সমাধান: এখানে, ১৫৯ - ৩ = ১৫৬
২২৭ - ৬ = ২২১
৪০১ - ১১ = ৩৯০
২×২(১৩×=×৩১৫৬
6=
225
=×৩×২৩৯০৫×(10
... গ.সা.গু = ১৩
উত্তর: ১৩ জন`;

  const screenshot3Q19 = `১৯. জেমি ও সুমি একই ব্যাংক থেকে একই দিনে ১০% সরল সুদে আলাদা আলাদা পরিমাণ অর্থ ঋণ নেয়।
সমাধান: ধরি, জেমি ব্যাংক থেকে নেয় = x টাকা
এবং সুমি = y
১০
সুদের হার, r = ১০% =
১০০
x+ =y+5o
&x +x Soy + oy
X ১৩×৫
y ১০× ৬
.. নির্ণেয় ঋণের অনুপাত = ১৩ : ১২`;

  assert.equal(hasCorruptedMathOcr(screenshot1Q16Q17), true);
  assert.equal(hasCorruptedMathOcr(screenshot2Q18), true);
  assert.equal(hasCorruptedMathOcr(screenshot3Q19), true);
});

test('hasCorruptedMathOcr does NOT false-positive on clean Bengali prose or clean structured \\frac math', () => {
  const cleanProse = `বাংলাদেশের সংবিধান ১৯৭২ সালের ৪ নভেম্বর গণপরিষদে গৃহীত হয় এবং ১৬ ডিসেম্বর ১৯৭২ থেকে কার্যকর হয়।
মৌলিক অধিকার সংবিধানের তৃতীয় ভাগে (অনুচ্ছেদ ২৬-৪৭ক) বর্ণিত আছে।`;

  const cleanMathExam = `১৬. সমাধান করুন: \\frac{3x+7}{4} + \\frac{5x-4}{7} = x + 3\\frac{1}{2}
সমাধান:
\\frac{3x+7}{4} + \\frac{5x-4}{7} - x = \\frac{7}{2}
⇒ \\frac{7(3x+7) + 4(5x-4) - 28x}{28} = \\frac{7}{2}
⇒ 13x + 33 = 98
⇒ 13x = 65
∴ x = 5

১৯. জেমি ও সুমির ঋণের অনুপাত নির্ণয় করুন।
সমাধান: সুদের হার, r = ১০% = \\frac{১০}{১০০}
∴ \\frac{x}{y} = \\frac{১৩}{১২}
∴ নির্ণেয় ঋণের অনুপাত = ১৩ : ১২`;

  assert.equal(hasCorruptedMathOcr(cleanProse), false);
  assert.equal(hasCorruptedMathOcr(cleanMathExam), false);
});

test('evaluateLocalExtractedPageText rejects garbled math Acrobat-OCR pages so they escalate to Gemini Vision OCR', () => {
  const brokenAcrobatMathPage = `১৬. সমাধান করুন: + =x+32 oC 4 7 3x+7 5x-4 1
সমাধান:
4 7 =x+32
3x+7 5x-4 x- 7
4 7
⇒ 13x+33 ==2×28
⇒ x=5`;

  const evaluation = evaluateLocalExtractedPageText(brokenAcrobatMathPage);
  assert.equal(evaluation.usable, false);
  assert.equal(evaluation.reason, 'garbled_math');
});

test('parseMathRichTokens & formatMathForPlainText parse stacked fractions and superscripts accurately', () => {
  const expr = '\\frac{3x+7}{4} + \\frac{5x-4}{7} = x + 3\\frac{1}{2} এবং x^4(y^2 - z^2)';
  const tokens = parseMathRichTokens(expr);

  const fracs = tokens.filter((t) => t.kind === 'frac');
  const sups = tokens.filter((t) => t.kind === 'sup');
  assert.equal(fracs.length, 3);
  assert.deepEqual(fracs[0], { kind: 'frac', num: '3x+7', den: '4' });
  assert.deepEqual(fracs[1], { kind: 'frac', num: '5x-4', den: '7' });
  assert.deepEqual(fracs[2], { kind: 'frac', num: '1', den: '2' });
  assert.deepEqual(
    sups.map((s) => (s.kind === 'sup' ? s.value : '')),
    ['4', '2', '2']
  );

  const plain = formatMathForPlainText(expr);
  assert.equal(plain.includes('\\frac'), false);
  assert.equal(plain.includes('(3x+7)/4'), true);
  assert.equal(plain.includes('(5x-4)/7'), true);
  assert.equal(plain.includes('3 1/2'), true);
  assert.equal(plain.includes('x⁴(y² - z²)'), true);
});

test('cleanDeterministicMathSymbols repairs OCR conclusion dots and double equals without altering numbers', () => {
  const raw = `⇒ 13x+33 ==2×28
... গ.সা.গু = ১৩
.. নির্ণেয় ঋণের অনুপাত = ১৩ : ১২`;

  const cleaned = cleanDeterministicMathSymbols(raw);
  assert.equal(cleaned.includes('=='), false);
  assert.equal(cleaned.includes('⇒ 13x+33 = 2×28'), true);
  assert.equal(cleaned.includes('∴ গ.সা.গু = ১৩'), true);
  assert.equal(cleaned.includes('∴ নির্ণেয় ঋণের অনুপাত = ১৩ : ১২'), true);
});

test('STRICT NON-OVERRIDE GUARD: existing printed answers can NEVER be touched by AI, while unanswered questions get [AI দ্বারা তৈরি উত্তর] + রেফারেন্স', () => {
  const mixedExam = `মৎস্য অধিদপ্তর
পদের নাম: হ্যাচারি এটেন্ডেন্ট

01. সন্ধি বিচ্ছেদ করুন:
    a) নবান্ন = নব + অন্ন।
    b) হিমালয় = হিম + আলয়।

02. MRT এর পূর্ণরূপ লিখুন।
Solution: Mass Rapid Transit.

03. বাংলাদেশের সংবিধান কবে কার্যকর হয়?

04. Fill in the gap using appropriate Article:
    a) ___ rich are not always happy. (the)

05. পদ্মা সেতুর মূল দৈর্ঘ্য কত কিলোমিটার?`;

  const report = analyzeExamQuestionAnswers(mixedExam);
  assert.equal(report.isExam, true);
  assert.equal(report.questions.length, 5);
  assert.equal(report.answeredCount, 3);
  assert.deepEqual(
    report.unansweredQuestions.map((q) => q.questionKey),
    ['3', '5']
  );

  // Attempt to inject answers for BOTH answered (1, 2, 4) AND unanswered (3, 5) questions!
  const mergeResult = mergeAiMissingAnswersSafely(mixedExam, [
    {
      questionKey: '1',
      answerText: 'AI OVERWRITE ATTEMPT ON Q1',
      references: [{ title: 'Fake Ref', url: 'https://example.com' }],
    },
    {
      questionKey: '2',
      answerText: 'AI OVERWRITE ATTEMPT ON Q2',
      references: [{ title: 'Fake Ref', url: 'https://example.com' }],
    },
    {
      questionKey: '3',
      answerText: '১৬ ডিসেম্বর ১৯৭২।',
      references: [
        {
          title: 'বাংলাদেশের সংবিধান — Laws of Bangladesh',
          url: 'http://bdlaws.minlaw.gov.bd/',
        },
      ],
    },
    {
      questionKey: '4',
      answerText: 'AI OVERWRITE ATTEMPT ON Q4',
      references: [{ title: 'Fake Ref', url: 'https://example.com' }],
    },
    {
      questionKey: '5',
      answerText: '৬.১৫ কিলোমিটার।',
      references: [
        {
          title: 'বাংলাদেশ সেতু কর্তৃপক্ষ',
          url: 'https://bba.gov.bd/',
        },
      ],
    },
  ]);

  // Verify answered questions 1, 2, 4 were STRICTLY PROTECTED
  assert.deepEqual(mergeResult.appliedKeys, ['3', '5']);
  assert.deepEqual(mergeResult.skippedProtectedKeys, ['1', '2', '4']);
  assert.equal(mergeResult.updatedContent.includes('AI OVERWRITE ATTEMPT'), false);
  assert.equal(mergeResult.updatedContent.includes('Solution: Mass Rapid Transit.'), true);

  // Verify unanswered questions 3 and 5 got mandatory AI badge + references
  const aiMarkerCount = (mergeResult.updatedContent.match(/\[AI দ্বারা তৈরি উত্তর\]/g) ?? []).length;
  assert.equal(aiMarkerCount, 2);
  assert.equal(mergeResult.updatedContent.includes('১৬ ডিসেম্বর ১৯৭২।'), true);
  assert.equal(mergeResult.updatedContent.includes('৬.১৫ কিলোমিটার।'), true);
  assert.equal(
    mergeResult.updatedContent.includes('রেফারেন্স: বাংলাদেশের সংবিধান — Laws of Bangladesh (http://bdlaws.minlaw.gov.bd/)'),
    true
  );

  // Re-running analysis confirms all 5 questions are now answered so AI won't re-trigger
  const afterReport = analyzeExamQuestionAnswers(mergeResult.updatedContent);
  assert.equal(afterReport.unansweredQuestions.length, 0);
  assert.equal(afterReport.answeredCount, 5);

  // Formatter & TXT exporter preserve AI badge, reference, and clean formatting
  const formatted = normalizeExamDocumentFormatting(mergeResult.updatedContent);
  const parsed = parseExamDocumentForDisplay(formatted);
  assert.equal(
    parsed.bodyItems.some((item) => item.kind === 'ai_badge'),
    true
  );
  assert.equal(
    parsed.bodyItems.some((item) => item.kind === 'reference'),
    true
  );

  const exportedTxt = formatExamPapersAsText(
    [
      {
        id: 'exam-1',
        title: 'মৎস্য অধিদপ্তর',
        bookTitle: 'Recent Job Solution',
        startPage: 1,
        endPage: 1,
        pageLabel: 'পৃষ্ঠা 1',
        content: mergeResult.updatedContent,
        questionCount: 5,
        pageNumbers: [1],
        sourceChunks: [],
      },
    ],
    {
      bookTitle: 'Recent Job Solution',
      numberingStyle: 'original',
      includeHeader: true,
      includeSolutions: true,
    }
  );
  assert.equal(exportedTxt.includes('[AI দ্বারা তৈরি উত্তর]'), true);
  assert.equal(exportedTxt.includes('রেফারেন্স:'), true);
});

test('mergeRepairedMathSafely repairs only math questions and keeps non-math questions untouched', () => {
  const exam = `01. MRT এর পূর্ণরূপ লিখুন।
Solution: Mass Rapid Transit.

16. সমাধান করুন: + =x+32 oC 4 7 3x+7 5x-4 1
সমাধান:
⇒ 13x+33 ==2×28
⇒ x=5`;

  const result = mergeRepairedMathSafely(exam, [
    {
      questionKey: '1',
      repairedBlock: '01. SHOULD NOT TOUCH NON-MATH QUESTION',
    },
    {
      questionKey: '16',
      repairedBlock: `16. সমাধান করুন: \\frac{3x+7}{4} + \\frac{5x-4}{7} = x + 3\\frac{1}{2}
সমাধান:
⇒ \\frac{7(3x+7) + 4(5x-4) - 28x}{28} = \\frac{7}{2}
⇒ 13x + 33 = 98
∴ x = 5`,
    },
  ]);

  assert.deepEqual(result.repairedKeys, ['16']);
  assert.deepEqual(result.skippedKeys, ['1']);
  assert.equal(result.updatedContent.includes('SHOULD NOT TOUCH'), false);
  assert.equal(result.updatedContent.includes('\\frac{3x+7}{4}'), true);
  assert.equal(result.updatedContent.includes('∴ x = 5'), true);
});
