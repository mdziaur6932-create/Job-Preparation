import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideOptionColumnLayout,
  EDITORIAL_1COL_OPTION_MAX_CHARS,
  EDITORIAL_2COL_OPTION_MAX_CHARS,
  groupDisplayItemsWithOptionBlocks,
  isExamSubjectHeadingLine,
  parseStructuredExamHeader,
} from './exam-option-layout';
import type { ParsedExamDisplayLine } from './exam-text-formatter';

test('decideOptionColumnLayout places short MCQ options in 2 columns per row', () => {
  const layout = decideOptionColumnLayout(
    [
      { marker: 'ক.', text: '২ জন' },
      { marker: 'খ.', text: '১ জন' },
      { marker: 'গ.', text: '৪ জন' },
      { marker: 'ঘ.', text: '৩ জন' },
    ],
    34
  );

  assert.equal(layout.columns, 2);
  assert.equal(layout.rows.length, 2);
  assert.deepEqual(
    layout.rows.map((r) => r.map((o) => o.marker)),
    [
      ['ক.', 'খ.'],
      ['গ.', 'ঘ.'],
    ]
  );
});

test('decideOptionColumnLayout pairs medium-length Bangla names using EDITORIAL_2COL_OPTION_MAX_CHARS', () => {
  assert.equal(EDITORIAL_2COL_OPTION_MAX_CHARS, 24);
  assert.equal(EDITORIAL_1COL_OPTION_MAX_CHARS, 44);

  const layout = decideOptionColumnLayout(
    [
      { marker: 'ক.', text: 'শরৎচন্দ্র চট্টোপাধ্যায়' },
      { marker: 'খ.', text: 'কাজী নজরুল ইসলাম' },
      { marker: 'গ.', text: 'রবীন্দ্রনাথ ঠাকুর' },
      { marker: 'ঘ.', text: 'বঙ্কিমচন্দ্র চট্টোপাধ্যায়' },
    ],
    EDITORIAL_2COL_OPTION_MAX_CHARS
  );

  assert.equal(layout.columns, 2);
  assert.equal(layout.rows.length, 2);
});

test('decideOptionColumnLayout switches to 1 column per row when any option is long', () => {
  const layout = decideOptionColumnLayout(
    [
      {
        marker: 'ক.',
        text: '২০২৬ পুরুষ টি-২০ বিশ্বকাপ ক্রিকেটের অফিশিয়াল বলের নাম',
      },
      {
        marker: 'খ.',
        text: '২০২৬ বিশ্বকাপ ফুটবলের অফিশিয়াল বলের নাম',
      },
      {
        marker: 'গ.',
        text: '২০২৬ এশিয়ান গেমসের মূল লোগোর নাম',
      },
      { marker: 'ঘ.', text: 'কোনটি নয়' },
    ],
    34
  );

  assert.equal(layout.columns, 1);
  assert.equal(layout.rows.length, 4);
  assert.equal(layout.rows[0].length, 1);
});

test('groupDisplayItemsWithOptionBlocks groups consecutive options while preserving question, solution, and explanation order', () => {
  const items: ParsedExamDisplayLine[] = [
    { kind: 'question', numberLabel: '১.', questionNumber: 1, text: 'বিলিরুবিন কোথায় তৈরি হয়?' },
    { kind: 'option', marker: 'ক.', text: 'প্লীহায়' },
    { kind: 'option', marker: 'খ.', text: 'পিত্তথলিতে' },
    { kind: 'option', marker: 'গ.', text: 'যকৃতে' },
    { kind: 'option', marker: 'ঘ.', text: 'কিডনিতে' },
    { kind: 'solution', label: 'উত্তর', text: 'গ. যকৃতে' },
    { kind: 'explanation', label: 'ব্যাখ্যা', text: 'বিলিরুবিন যকৃতে তৈরি হয় এবং পিত্তথলিতে জমা থাকে।' },
  ];

  const blocks = groupDisplayItemsWithOptionBlocks(items, 34);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].kind, 'question');
  assert.equal(blocks[1].kind, 'option_group');
  if (blocks[1].kind === 'option_group') {
    assert.equal(blocks[1].columns, 2);
    assert.equal(blocks[1].rows.length, 2);
  }
  assert.equal(blocks[2].kind, 'solution');
  assert.equal(blocks[3].kind, 'explanation');
});

test('parseStructuredExamHeader cleanly splits Post Name, Time, Exam Date, and Full Marks', () => {
  const header = parseStructuredExamHeader([
    'বাংলাদেশ ব্যাংক',
    'পদের নাম: সহকারী পরিচালক',
    'সময়: ৬০ মিনিট   পরীক্ষার তারিখ: ০৯.০১.২০২৬   পূর্ণমান: ১০০',
  ]);

  assert.deepEqual(header.titleLines, ['বাংলাদেশ ব্যাংক']);
  assert.equal(header.postLine, 'পদের নাম: সহকারী পরিচালক');
  assert.equal(header.timeText, 'সময়: ৬০ মিনিট');
  assert.equal(header.dateText, 'পরীক্ষার তারিখ: ০৯.০১.২০২৬');
  assert.equal(header.marksText, 'পূর্ণমান: ১০০');
});

test('isExamSubjectHeadingLine detects Bangladeshi exam subject subheadings and rejects normal lines', () => {
  assert.equal(isExamSubjectHeadingLine('বাংলা'), true);
  assert.equal(isExamSubjectHeadingLine('**English**'), true);
  assert.equal(isExamSubjectHeadingLine('সাধারণ জ্ঞান'), true);
  assert.equal(isExamSubjectHeadingLine('গণিত ও মানসিক দক্ষতা'), true);
  assert.equal(isExamSubjectHeadingLine('সাধারণ বিজ্ঞান ও কম্পিউটার'), true);
  assert.equal(isExamSubjectHeadingLine('১. বলশেভিক বিপ্লব কত সালে সংগঠিত হয়?'), false);
  assert.equal(isExamSubjectHeadingLine('কিছু আলোচিত বিপ্লব'), false);
  assert.equal(isExamSubjectHeadingLine('Read the following passage carefully and answer question 1-5'), false);
});

