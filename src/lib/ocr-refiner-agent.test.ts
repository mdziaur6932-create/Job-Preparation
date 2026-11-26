import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredExamJsonFromText,
  detachInlineOptionAnswer,
  refineExamPaperWithAgent,
  serializeRefinedExamPaperToText,
  type OcrRefinerGeminiClient,
} from './ocr-refiner-agent';
import {
  analyzeExamQuestionAnswers,
  formatMathForPlainText,
  parseMathRichTokens,
} from './exam-math-and-answer-guard';
import {
  normalizeExamDocumentFormatting,
  parseExamDocumentForDisplay,
} from './exam-text-formatter';
import {
  buildSafeExportFilename,
  formatExamPapersAsJson,
  formatExamPapersAsText,
} from './exam-paper-exporter';

test('detaches inline ans. A from MCQ option d) and places Answer: A cleanly below options', () => {
  const userScreenshotExam = `বাংলাদেশ সরকারি কর্ম কমিশন
পদের নাম: সহকারী প্রোগ্রামার
তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০

12. বাঘময়ের মধ্যে সবচেয়ে সচল ও সক্রিয় প্রত্যঙ্গ কোনটি?
a) জিহ্বা
b) শ্বাসনালী
c) ফুসফুস
d) ওষ্ঠans. A

13. 'ভুল করা মানুষের স্বভাব' বাক্যটির সঠিক ইংরেজি অনুবাদ হবে-
a) To err is human.
b) To err is a human.
c) To err is humans.
d) To err are human. ans. A`;

  const normalized = normalizeExamDocumentFormatting(userScreenshotExam);
  assert.doesNotMatch(normalized, /ওষ্ঠ\s*ans\.\s*A/i);
  assert.doesNotMatch(normalized, /To err are human\.\s*ans\.\s*A/i);
  assert.match(normalized, /d\)\s+ওষ্ঠ\nAnswer: A/);
  assert.match(normalized, /d\)\s+To err are human\.\nAnswer: A/);

  const parsed = parseExamDocumentForDisplay(normalized);
  assert.equal(parsed.isExam, true);

  const optionLines = parsed.bodyItems.filter((item) => item.kind === 'option');
  const dOptions = optionLines.filter((opt) => opt.marker === 'd)');
  assert.equal(dOptions.length, 2);
  assert.equal(dOptions[0].text, 'ওষ্ঠ');
  assert.equal(dOptions[1].text, 'To err are human.');

  const solutionLines = parsed.bodyItems.filter(
    (item) => item.kind === 'solution'
  );
  assert.equal(solutionLines.length, 2);
  assert.equal(solutionLines[0].label, 'Answer');
  assert.equal(solutionLines[0].text, 'A');
  assert.equal(solutionLines[1].label, 'Answer');
  assert.equal(solutionLines[1].text, 'A');

  // Ensure both questions are recognized as already answered (never overridden by AI)
  const analysis = analyzeExamQuestionAnswers(userScreenshotExam);
  assert.equal(analysis.answeredCount, 2);
  assert.equal(analysis.unansweredQuestions.length, 0);
});

test('detachInlineOptionAnswer handles spaced, unspaced, and Bengali answers while keeping fill-in-the-blank intact', () => {
  assert.deepEqual(detachInlineOptionAnswer('ওষ্ঠans. A'), {
    cleanOptionText: 'ওষ্ঠ',
    extractedAnswer: 'A',
  });
  assert.deepEqual(detachInlineOptionAnswer('To err are human. ans. a'), {
    cleanOptionText: 'To err are human.',
    extractedAnswer: 'A',
  });
  assert.deepEqual(detachInlineOptionAnswer('ঢাকা Ans: ক'), {
    cleanOptionText: 'ঢাকা',
    extractedAnswer: 'ক',
  });
  // Fill-in-the-blank with ___ must remain intact
  assert.deepEqual(
    detachInlineOptionAnswer('You are ___ Nazrul, I see. Answer: a'),
    {
      cleanOptionText: 'You are ___ Nazrul, I see. Answer: a',
      extractedAnswer: null,
    }
  );
});

test('parses LaTeX fractions, square roots, superscripts, subscripts, and symbols cleanly', () => {
  const latexExpr =
    '$\\frac{3x+7}{4} + \\sqrt{x^{2}+1} \\times a_{1} \\therefore y \\Rightarrow 5$';

  const tokens = parseMathRichTokens(latexExpr);
  assert.ok(tokens.some((t) => t.kind === 'frac' && t.num === '3x+7' && t.den === '4'));
  assert.ok(tokens.some((t) => t.kind === 'sqrt' && t.value === 'x^{2}+1'));
  assert.ok(tokens.some((t) => t.kind === 'sub' && t.value === '1'));
  const combinedTextTokens = tokens
    .filter((t): t is { kind: 'text'; value: string } => t.kind === 'text')
    .map((t) => t.value)
    .join('');
  assert.ok(combinedTextTokens.includes('×'));
  assert.ok(combinedTextTokens.includes('∴'));
  assert.ok(combinedTextTokens.includes('⇒'));

  const plain = formatMathForPlainText(latexExpr);
  assert.ok(!plain.includes('\\frac'));
  assert.ok(!plain.includes('\\sqrt'));
  assert.ok(!plain.includes('\\times'));
  assert.ok(plain.includes('(3x+7)/4'));
  assert.ok(plain.includes('√(x²+1)'));
  assert.ok(plain.includes('a₁'));
  assert.ok(plain.includes('∴'));
  assert.ok(plain.includes('⇒'));
});

test('refineExamPaperWithAgent enforces LaTeX math, structured JSON, red-lined highlights, separated bold answers, and strict non-fabrication', async () => {
  const rawInput = `মৎস্য অধিদপ্তর
পদের নাম: হ্যাচারি এটেন্ডেন্ট
তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০

12. বাঘময়ের মধ্যে সবচেয়ে সচল ও সক্রিয় প্রত্যঙ্গ কোনটি?
a) জিহ্বা
b) শ্বাসনালী
c) ফুসফুস
d) ওষ্ঠ ans. A
[হাইলাইট: লাল দাগ করা গুরুত্বপূর্ণ প্রশ্ন]

16. সমাধান করুন: 3x+7 4 + 5x-4 7 = x+3 2
সমাধান:
x = 5

17. বাংলাদেশের সংবিধানের কোন অনুচ্ছেদে শিক্ষার অধিকার রয়েছে?`;

  const mockClient: OcrRefinerGeminiClient = {
    models: {
      generateContent: async () =>
        ({
          text: JSON.stringify({
            examTitle: 'মৎস্য অধিদপ্তর',
            header: {
              institution: 'মৎস্য অধিদপ্তর',
              postName: 'পদের নাম: হ্যাচারি এটেন্ডেন্ট',
              metadata: 'তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০',
            },
            questions: [
              {
                numberLabel: '12.',
                questionText: 'বাঘময়ের মধ্যে সবচেয়ে সচল ও সক্রিয় প্রত্যঙ্গ কোনটি?',
                options: [
                  { marker: 'a)', text: 'জিহ্বা' },
                  { marker: 'b)', text: 'শ্বাসনালী' },
                  { marker: 'c)', text: 'ফুসফুস' },
                  { marker: 'd)', text: 'ওষ্ঠ ans. A' },
                ],
                answer: '',
                answerLabel: 'Ans',
                solutionSteps: [],
                highlights: ['লাল দাগ করা গুরুত্বপূর্ণ প্রশ্ন'],
                hasMathLatex: false,
                isHighlighted: true,
              },
              {
                numberLabel: '16.',
                questionText:
                  'সমাধান করুন: $\\frac{3x+7}{4} + \\frac{5x-4}{7} = \\frac{x+3}{2}$',
                options: [],
                answer: '$x = 5$',
                answerLabel: 'সমাধান',
                solutionSteps: [
                  '$\\Rightarrow \\frac{7(3x+7) + 4(5x-4)}{28} = \\frac{x+3}{2}$',
                  '$\\therefore x = 5$',
                ],
                highlights: [],
                hasMathLatex: true,
                isHighlighted: false,
              },
              {
                numberLabel: '17.',
                questionText:
                  'বাংলাদেশের সংবিধানের কোন অনুচ্ছেদে শিক্ষার অধিকার রয়েছে?',
                options: [],
                // Attempted AI fabrication on an originally unanswered question — MUST be stripped!
                answer: 'অনুচ্ছেদ ১৭',
                answerLabel: 'উত্তর',
                solutionSteps: ['এটি AI বানিয়ে দিয়েছে'],
                highlights: [],
                hasMathLatex: false,
                isHighlighted: false,
              },
            ],
          }),
        }) as unknown as Awaited<
          ReturnType<OcrRefinerGeminiClient['models']['generateContent']>
        >,
    },
  };

  const result = await refineExamPaperWithAgent({
    rawContent: rawInput,
    examTitle: 'মৎস্য অধিদপ্তর',
    client: mockClient,
  });

  assert.equal(result.usedAi, true);
  assert.equal(result.refinedJson.schemaVersion, '1.0');
  assert.equal(result.refinedJson.questions.length, 3);

  // Q12: inline `ans. A` stripped from d) and placed into answer; red-lined highlight preserved
  const q12 = result.refinedJson.questions[0];
  assert.equal(q12.numberLabel, '12.');
  assert.equal(q12.options[3].text, 'ওষ্ঠ');
  assert.equal(q12.answer, 'A');
  assert.equal(q12.answerLabel, 'Answer');
  assert.equal(q12.isHighlighted, true);
  assert.deepEqual(q12.highlights, ['লাল দাগ করা গুরুত্বপূর্ণ প্রশ্ন']);

  // Q16: LaTeX math preserved
  const q16 = result.refinedJson.questions[1];
  assert.equal(q16.numberLabel, '16.');
  assert.equal(q16.hasMathLatex, true);
  assert.match(q16.questionText, /\\frac\{3x\+7\}\{4\}/);

  // Q17: Strict non-fabrication guard stripped fabricated answer & steps
  const q17 = result.refinedJson.questions[2];
  assert.equal(q17.numberLabel, '17.');
  assert.equal(q17.answer, '');
  assert.deepEqual(q17.solutionSteps, []);

  // Serialized text puts Answer: A below d) ওষ্ঠ and keeps [হাইলাইট: ...]
  const serialized = serializeRefinedExamPaperToText(result.refinedJson);
  assert.match(serialized, /d\) ওষ্ঠ\nAnswer: A\n\[হাইলাইট: লাল দাগ করা গুরুত্বপূর্ণ প্রশ্ন\]/);
});

test('buildStructuredExamJsonFromText and formatExamPapersAsJson produce schema v1.0 JSON honoring export options', () => {
  const sampleExam = `বাংলাদেশ ব্যাংক
পদের নাম: সহকারী পরিচালক
তারিখ: ১৫.০৩.২০২৫; পূর্ণমান: ১০০

12. মান নির্ণয় করুন: $\\frac{3x+7}{4} + \\sqrt{x^{2}+1}$
a) ১০
b) ১২
c) ১৪
d) ১৬ ans. B
[হাইলাইট: লাল দাগ করা প্রশ্ন]`;

  const structured = buildStructuredExamJsonFromText(sampleExam, 'বাংলাদেশ ব্যাংক');
  assert.equal(structured.schemaVersion, '1.0');
  assert.equal(structured.questions.length, 1);
  assert.equal(structured.questions[0].answer, 'B');
  assert.equal(structured.questions[0].hasMathLatex, true);
  assert.equal(structured.questions[0].isHighlighted, true);

  const exportedJsonStr = formatExamPapersAsJson(
    [
      {
        id: 'exam-1',
        bookId: 1,
        bookTitle: 'Recent Job Solution',
        title: 'বাংলাদেশ ব্যাংক',
        pageLabel: 'পৃষ্ঠা 1',
        startPage: 1,
        endPage: 1,
        content: sampleExam,
        sourceChunks: [],
        questionCount: 1,
      },
    ],
    {
      bookTitle: 'Recent Job Solution',
      numberingStyle: 'bengali',
      includeHeader: true,
      includeSolutions: true,
    }
  );

  const parsedJson = JSON.parse(exportedJsonStr) as {
    schemaVersion: string;
    questions: Array<{ numberLabel: string; answer: string; highlights: string[] }>;
  };
  assert.equal(parsedJson.schemaVersion, '1.0');
  assert.equal(parsedJson.questions[0].numberLabel, '১২।');
  assert.equal(parsedJson.questions[0].answer, 'B');
  assert.deepEqual(parsedJson.questions[0].highlights, ['লাল দাগ করা প্রশ্ন']);

  // Also check .txt export preserves highlight and clean math
  const txt = formatExamPapersAsText(
    [
      {
        id: 'exam-1',
        bookId: 1,
        bookTitle: 'Recent Job Solution',
        title: 'বাংলাদেশ ব্যাংক',
        pageLabel: 'পৃষ্ঠা 1',
        startPage: 1,
        endPage: 1,
        content: sampleExam,
        sourceChunks: [],
        questionCount: 1,
      },
    ],
    {
      bookTitle: 'Recent Job Solution',
      numberingStyle: 'original',
      includeHeader: true,
      includeSolutions: true,
    }
  );
  assert.match(txt, /Answer: B/);
  assert.match(txt, /\[হাইলাইট: লাল দাগ করা প্রশ্ন\]/);
  assert.match(txt, /\(3x\+7\)\/4/);
  assert.match(txt, /√\(x²\+1\)/);

  assert.equal(buildSafeExportFilename('Exam Paper 1', 'json'), 'Exam-Paper-1.json');
});
