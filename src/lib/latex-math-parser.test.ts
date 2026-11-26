import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import {
  extractLatexEquationsFromText,
  parseTextIntoKatexSegments,
  prepareLatexForKatex,
} from './latex-math-parser';
import {
  isPromotionalBookAdLine,
  normalizeExamDocumentFormatting,
  stripPromotionalBookAds,
} from './exam-text-formatter';
import { buildStructuredExamJsonFromText } from './ocr-refiner-agent';

test('parseTextIntoKatexSegments parses inline, display, bare LaTeX, and double-escaped math while protecting currency', () => {
  const mixed =
    'সমাধান করুন: $\\frac{3x+7}{4} + \\sqrt{x^{2}+1}$ এবং দাম $50 থেকে $100।';
  const segs = parseTextIntoKatexSegments(mixed);

  const mathSegs = segs.filter((s) => s.kind === 'math');
  assert.equal(mathSegs.length, 1);
  assert.equal(mathSegs[0].latex, '\\frac{3x+7}{4} + \\sqrt{x^{2}+1}');

  const textCombined = segs
    .filter((s) => s.kind === 'text')
    .map((s) => s.value)
    .join('');
  assert.ok(textCombined.includes('$50'));
  assert.ok(textCombined.includes('$100'));

  // Bare undelimited LaTeX + double-escaped backslashes
  const bareSegs = parseTextIntoKatexSegments(
    'মান: \\\\frac{১০}{১০০} + \\\\sqrt{x^{2}+1} \\\\times a_{1}'
  );
  const bareMath = bareSegs.filter((s) => s.kind === 'math');
  assert.ok(bareMath.some((m) => m.latex === '\\frac{১০}{১০০}'));
  assert.ok(bareMath.some((m) => m.latex === '\\sqrt{x^{2}+1}'));
  assert.ok(bareMath.some((m) => m.latex === '\\times'));
  assert.ok(bareMath.some((m) => m.latex === 'a_{1}'));

  // Standalone numeric LaTeX tokens in MCQ options & Written math stems must render via KaTeX
  const numericOptionSegs = parseTextIntoKatexSegments('$7$');
  assert.equal(numericOptionSegs.length, 1);
  assert.equal(numericOptionSegs[0].kind, 'math');
  assert.equal(numericOptionSegs[0].latex, '7');

  const writtenMathSegs = parseTextIntoKatexSegments(
    'বার্ষিক $10\\%$ হারে $4$ বছরে $2800$ টাকা এবং $5 + 3 = 8$।'
  );
  const writtenMathVals = writtenMathSegs
    .filter((s) => s.kind === 'math')
    .map((s) => s.latex);
  assert.deepEqual(writtenMathVals, ['10\\%', '4', '2800', '5 + 3 = 8']);
});

test('prepareLatexForKatex wraps Bengali numerals in \\text{} and compiles cleanly in real KaTeX', () => {
  const bengaliFrac = prepareLatexForKatex('\\frac{১০}{১০০} \\times \\sqrt{x^{2}+1}');
  assert.equal(bengaliFrac, '\\frac{\\text{১০}}{\\text{১০০}} \\times \\sqrt{x^{2}+1}');

  const html = katex.renderToString(bengaliFrac, {
    throwOnError: true,
    strict: false,
    trust: false,
  });
  assert.ok(html.includes('katex'));
  assert.ok(html.includes('mfrac'));
  assert.ok(html.includes('msqrt'));
});

test('extractLatexEquationsFromText extracts question-tagged LaTeX equations for Question Lab verifier', () => {
  const exam = `বাংলাদেশ সরকারি কর্ম কমিশন
পদের নাম: সহকারী প্রোগ্রামার

14. সমাধান করুন: $\\frac{3x+7}{4} + \\frac{5x-4}{7} = \\frac{x+3}{2}$
সমাধান: $x = 5$

15. মান নির্ণয় করুন: \\sqrt{x^{2}+1} \\times a_{1}`;

  const eqs = extractLatexEquationsFromText(exam);
  assert.equal(eqs.length, 3);
  assert.equal(eqs[0].questionLabel, '14.');
  assert.equal(eqs[0].latex, '\\frac{3x+7}{4} + \\frac{5x-4}{7} = \\frac{x+3}{2}');
  assert.equal(eqs[1].questionLabel, '14.');
  assert.equal(eqs[1].latex, 'x = 5');
  assert.equal(eqs[2].questionLabel, '15.');
  assert.equal(eqs[2].latex, '\\sqrt{x^{2}+1} \\times a_{1}');
});

test('stripPromotionalBookAds removes exact user book-ad sentences & standalone book banners without harming exam questions', () => {
  const userAdFull =
    'জুলাই, ২০২৩ থেকে জানুয়ারি, ২০২৪ পর্যন্ত অনুষ্ঠিত সকল চাকরির লিখিত পরীক্ষায় আসা প্রশ্নের নির্ভুল সমাধান সম্বলিত ‘অগ্রদূত রিসেন্ট লিখিত জব সলিউশন’ বইটি আগামী সপ্তাহ থেকে লাইব্রেরিতে পাওয়া যাবে।';
  const userAdBrand = 'অগ্রদূত রিসেন্ট লিখিত জব সলিউশন';

  assert.equal(isPromotionalBookAdLine(userAdFull), true);
  assert.equal(isPromotionalBookAdLine(userAdBrand), true);
  assert.equal(
    isPromotionalBookAdLine('১৪. কাজী নজরুল ইসলামের প্রথম কাব্যগ্রন্থের নাম কী?'),
    false
  );

  const pollutedExam = `মৎস্য অধিদপ্তর
পদের নাম: হ্যাচারি এটেন্ডেন্ট
তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০
${userAdBrand}

12. বাঘময়ের মধ্যে সবচেয়ে সচল ও সক্রিয় প্রত্যঙ্গ কোনটি?
a) জিহ্বা
b) শ্বাসনালী
c) ফুসফুস
d) ওষ্ঠ ans. A

${userAdFull}

13. কাজী নজরুল ইসলামের প্রথম কাব্যগ্রন্থ কোনটি?
a) অগ্নিবীণা
b) বিষের বাঁশি
Answer: A ${userAdFull}

${userAdBrand} - ১২`;

  const stripped = stripPromotionalBookAds(pollutedExam);
  assert.ok(stripped.removedCount >= 4);
  assert.ok(!stripped.cleaned.includes('অগ্রদূত রিসেন্ট লিখিত জব সলিউশন'));
  assert.ok(!stripped.cleaned.includes('লাইব্রেরিতে পাওয়া যাবে'));
  assert.ok(stripped.cleaned.includes('12. বাঘময়ের মধ্যে সবচেয়ে সচল'));
  assert.ok(stripped.cleaned.includes('13. কাজী নজরুল ইসলামের প্রথম কাব্যগ্রন্থ কোনটি?'));

  // Full normalizeExamDocumentFormatting + Structured JSON must also stay 100% ad-free
  const normalized = normalizeExamDocumentFormatting(pollutedExam);
  assert.ok(!normalized.includes('অগ্রদূত'));
  assert.ok(!normalized.includes('লাইব্রেরিতে পাওয়া যাবে'));
  assert.ok(normalized.includes('Answer: A'));

  const json = buildStructuredExamJsonFromText(pollutedExam, 'মৎস্য অধিদপ্তর');
  const serializedJson = JSON.stringify(json);
  assert.ok(!serializedJson.includes('অগ্রদূত'));
  assert.ok(!serializedJson.includes('লাইব্রেরিতে পাওয়া যাবে'));
  assert.equal(json.questions.length, 2);
});

test('stripPromotionalBookAds & analyzeExamQuestionAnswers exclude Screenshot 1 self-preparation cross-references (NOT answers) and Screenshot 2 red-boxed headers & page citations', async () => {
  const { analyzeExamQuestionAnswers } = await import('./exam-math-and-answer-guard');
  const { extractExamTitleFromText } = await import('./exam-text-formatter');

  // Screenshot 1: Publisher self-preparation guide cross-references (missing closing `]`, NOT real answers)
  const screenshot1CrossRefs = [
    '[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫০',
    '[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫',
    '[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৭',
    '[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫৪',
    '[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৬২',
    '[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫৭০',
    '[সেল্ফ প্রিপারেশন ইংরেজি (নতুন সংস্করণ); পৃষ্ঠা-20',
    '[সেল্ফ প্রিপারেশন ইংরেজি (নতুন সংস্করণ); পৃষ্ঠা-13/rule',
    '[সেল্ফ প্রিপারেশন ইংরেজি (নতুন সংস্করণ); পৃষ্ঠা-14',
  ];

  for (const line of screenshot1CrossRefs) {
    assert.equal(
      isPromotionalBookAdLine(line),
      true,
      `Expected cross-reference to be stripped: ${line}`
    );
  }

  const unansweredWithCrossRefs = `বাংলাদেশ সরকারি কর্মকমিশন
পদের নাম: উপ-সহকারী প্রকৌশলী

১. 'কবর' কবিতাটির রচয়িতা কে?
[সেল্ফ প্রিপারেশন বাংলা (নতুন সংস্করণ); পৃষ্ঠা-৫০

২. Choose the correct passive form of "Who did it?"
উত্তর: [সেল্ফ প্রিপারেশন ইংরেজি (নতুন সংস্করণ); পৃষ্ঠা-13/rule`;

  // Even on raw text (before normalization), analyzeExamQuestionAnswers MUST treat both as unanswered!
  const rawReport = analyzeExamQuestionAnswers(unansweredWithCrossRefs);
  assert.equal(rawReport.questions.length, 2);
  assert.equal(rawReport.answeredCount, 0);
  assert.equal(rawReport.unansweredQuestions.length, 2);

  const normalizedCrossRefExam = normalizeExamDocumentFormatting(unansweredWithCrossRefs);
  assert.ok(!normalizedCrossRefExam.includes('সেল্ফ প্রিপারেশন'));
  assert.ok(!normalizedCrossRefExam.includes('পৃষ্ঠা-৫০'));
  assert.ok(!normalizedCrossRefExam.includes('পৃষ্ঠা-13/rule'));
  assert.ok(normalizedCrossRefExam.includes("১. 'কবর' কবিতাটির রচয়িতা কে?"));
  assert.ok(normalizedCrossRefExam.includes('২. Choose the correct passive form'));

  // Screenshot 2: Red-boxed mixed Bengali+English running header & book page-citation lines
  const screenshot2Exam = `অগ্রদূত Recent Job Solution
নর্দান ইলেকট্রিসিটি সাপ্লাই কোম্পানি লি.
পদের নাম: সহকারী শিক্ষক (মাধ্যমিক)
সময়: ৬০ মিনিট
পরীক্ষার তারিখ: ২০.০৫.২০২৪
পূর্ণমান: ৭০

১. কোন সংখ্যাটি পরে আসবে? ৮, ৪, ২, ১, ১/২, ১/৪
ক) ১/৮
খ) ১/৪
গ) ১/৫
ঘ) ১/৬
উত্তর: ক
পৃষ্ঠা: ৬৬২ এর ৯৪৬ নম্বর (অগ্রদূত Basic Math, 2nd Edition, January-2024)

২. কোন protocol টি internet সংযোগের ক্ষেত্রে সর্বাধিক ব্যবহৃত হয়?
ক) TCP/IP
খ) Nobel Network
গ) Net BEVI
ঘ) Linux
উত্তর: ক
পৃষ্ঠা: ২১১ (অগ্রদূত কম্পিউটার ও তথ্য প্রযুক্তি)

৩. 'বনফুল' কোন লেখকের ছদ্মনাম?
[AI দ্বারা তৈরি উত্তর]
উত্তর: বলাইচাঁদ মুখোপাধ্যায়
রেফারেন্স: জাতীয় শিক্ষাক্রম ও পাঠ্যপুস্তক বোর্ড (NCTB বাংলা সাহিত্য, পৃষ্ঠা-৪৫)

বিসিএস ও ব্যাংকসহ সকল চাকরির পরীক্ষায় বাংলাদেশ বিষয়াবলিতে শতভাগ কমনের জন্য পড়ুন
‘অগ্রদূত বাংলাদেশ বিষয়াবলি’`;

  const cleanedScreenshot2 = normalizeExamDocumentFormatting(screenshot2Exam);
  assert.ok(!cleanedScreenshot2.includes('অগ্রদূত Recent Job Solution'));
  assert.ok(!cleanedScreenshot2.includes('পৃষ্ঠা: ৬৬২'));
  assert.ok(!cleanedScreenshot2.includes('Basic Math'));
  assert.ok(!cleanedScreenshot2.includes('পৃষ্ঠা: ২১১'));
  assert.ok(!cleanedScreenshot2.includes('কম্পিউটার ও তথ্য প্রযুক্তি'));
  assert.ok(!cleanedScreenshot2.includes('শতভাগ কমনের জন্য পড়ুন'));
  assert.ok(!cleanedScreenshot2.includes('অগ্রদূত বাংলাদেশ বিষয়াবলি'));

  // Preserve real exam header, questions, bold answers, AND genuine AI-generated reference!
  assert.equal(
    extractExamTitleFromText(cleanedScreenshot2),
    'নর্দান ইলেকট্রিসিটি সাপ্লাই কোম্পানি লি. — সহকারী শিক্ষক (মাধ্যমিক)'
  );
  assert.ok(cleanedScreenshot2.includes('১. কোন সংখ্যাটি পরে আসবে?'));
  assert.ok(cleanedScreenshot2.includes('২. কোন protocol টি internet'));
  assert.ok(cleanedScreenshot2.includes('উত্তর: ক'));
  assert.ok(cleanedScreenshot2.includes('[AI দ্বারা তৈরি উত্তর]'));
  assert.ok(
    cleanedScreenshot2.includes(
      'রেফারেন্স: জাতীয় শিক্ষাক্রম ও পাঠ্যপুস্তক বোর্ড (NCTB বাংলা সাহিত্য, পৃষ্ঠা-৪৫)'
    )
  );
});

