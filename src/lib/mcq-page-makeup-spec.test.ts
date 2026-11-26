import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachInlineAnswersToOptionGroups,
  canPlaceAnswerOnLastOptionRow,
  computeMcqTabCountToTargetStop,
  isMcqExamDocument,
  MCQ_PAGE_MAKEUP_SPEC,
} from './mcq-page-makeup-spec';
import { parseExamDocumentForDisplay } from './exam-text-formatter';
import { groupDisplayItemsWithOptionBlocks } from './exam-option-layout';

test('MCQ_PAGE_MAKEUP_SPEC matches every exact Word Page Setup, Paragraph, Column, and Tab value', () => {
  // Paper: 8.5" x 11" Portrait
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paper.widthIn, 8.5);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paper.heightIn, 11.0);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paper.widthTwips, 12240);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paper.heightTwips, 15840);

  // Margins: Top 0.5", Bottom 0.5", Left 0.8", Right 0.8", Gutter 0", Header/Footer 0.45"
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.topIn, 0.5);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.bottomIn, 0.5);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.leftIn, 0.8);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.rightIn, 0.8);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.gutterIn, 0);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.headerFromEdgeIn, 0.45);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.footerFromEdgeIn, 0.45);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.leftTwips, 1152);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.margins.headerFromEdgeTwips, 648);

  // Columns: 2 columns, 3.35" width each, 0.2" spacing, Line between ON, Equal width ON
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.columns.count, 2);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.columns.widthIn, 3.35);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.columns.spacingIn, 0.2);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.columns.equalWidth, true);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.columns.lineBetween, true);
  // Exact geometric identity: Left + Col1 + Gap + Col2 + Right === Paper Width
  assert.equal(
    Number(
      (
        MCQ_PAGE_MAKEUP_SPEC.margins.leftIn +
        MCQ_PAGE_MAKEUP_SPEC.columns.widthIn * 2 +
        MCQ_PAGE_MAKEUP_SPEC.columns.spacingIn +
        MCQ_PAGE_MAKEUP_SPEC.margins.rightIn
      ).toFixed(2)
    ),
    8.5
  );

  // Paragraph: Left 0", Right 0", Hanging 0.35", Before 0pt, After 0pt, Multiple 1.2, Widow/Orphan + Keep with next
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.indentLeftIn, 0);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.indentRightIn, 0);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.hangingIndentIn, 0.35);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.hangingIndentTwips, 504);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.spaceBeforePt, 0);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.spaceAfterPt, 0);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.lineSpacingMultiple, 1.2);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.lineSpacingWordAuto, 288);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.widowOrphanControl, true);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.paragraph.keepWithNext, true);

  // Tabs: Default 0.5", Stops: 0.35" L, 1" L, 1.75" L, 2.5" L, 3.35" R
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.tabs.defaultTabStopIn, 0.5);
  assert.equal(MCQ_PAGE_MAKEUP_SPEC.tabs.defaultTabStopTwips, 720);
  assert.deepEqual(
    MCQ_PAGE_MAKEUP_SPEC.tabs.stops.map((s) => ({
      pos: s.positionIn,
      twips: s.positionTwips,
      align: s.alignment,
    })),
    [
      { pos: 0.35, twips: 504, align: 'left' },
      { pos: 1.0, twips: 1440, align: 'left' },
      { pos: 1.75, twips: 2520, align: 'left' },
      { pos: 2.5, twips: 3600, align: 'left' },
      { pos: 3.35, twips: 4824, align: 'right' },
    ]
  );
});

test('isMcqExamDocument returns true ONLY for MCQ papers and false for Written papers or prose', () => {
  const mcqDoc = parseExamDocumentForDisplay(
    [
      'দুর্নীতি দমন কমিশন',
      'পদের নাম: উপ সহকারী পরিচালক',
      '০১. বলশেভিক বিপ্লব কত সালে সংগঠিত হয়?',
      'a) ১৯২৭',
      'b) ১৯৪৯',
      'c) ১৯৭৯',
      'd) ১৯১৭',
      'Answer: D',
    ].join('\n')
  );
  assert.equal(isMcqExamDocument(mcqDoc), true);

  const writtenDoc = parseExamDocumentForDisplay(
    [
      '৪৫তম বিসিএস লিখিত পরীক্ষা',
      'বিষয়: বাংলা',
      'সময়: ৪ ঘণ্টা   পূর্ণমান: ২০০',
      '১. সন্ধি বিচ্ছেদ করুন: ইত্যাদি, পরীক্ষা, বিদ্যালয়, নাবিক, গায়ক।',
      '২. ভাবসম্প্রসারণ লিখুন: দুর্নীতি উন্নয়নের প্রধান অন্তরায়।',
      '৩. বাংলায় অনুবাদ করুন: Honesty is the best policy in human life.',
    ].join('\n')
  );
  assert.equal(isMcqExamDocument(writtenDoc, '৪৫তম বিসিএস (Written)'), false);
});

test('computeMcqTabCountToTargetStop jumps accurately across intermediate stops to 1.75" and 3.35" Right', () => {
  // Short option "a) ১৯২৭" starting at 0.35" finishes before 1.0", so reaching 1.75" takes 2 tabs (0.35 -> 1.0 -> 1.75)
  assert.equal(computeMcqTabCountToTargetStop(0.35, 'a) ১৯২৭', 1.75), 2);
  // Medium option "a) মাইক্রোক্রেডিট" starting at 0.35" crosses 1.0", so reaching 1.75" takes 1 tab
  assert.equal(computeMcqTabCountToTargetStop(0.35, 'a) মাইক্রোক্রেডিট', 1.75), 1);
  // Short option 4 "d) ১৯১৭" starting at 1.75" finishes before 2.5", so reaching 3.35" Right takes 2 tabs
  assert.equal(computeMcqTabCountToTargetStop(1.75, 'd) ১৯১৭', 3.35), 2);
  // Wider option 4 "d) পণ্য সাহায্য" starting at 1.75" crosses 2.5", so reaching 3.35" Right takes 1 tab
  assert.equal(computeMcqTabCountToTargetStop(1.75, 'd) পণ্য সাহায্য', 3.35), 1);
});

test('attachInlineAnswersToOptionGroups places compact answers flush-right on last option row without duplicating', () => {
  const parsed = parseExamDocumentForDisplay(
    [
      '০১. বলশেভিক বিপ্লব কত সালে সংগঠিত হয়?',
      'a) ১৯২৭',
      'b) ১৯৪৯',
      'c) ১৯৭৯',
      'd) ১৯১৭',
      'Answer: D',
      '০২. ‘শ্রীকৃষ্ণকীর্তন’ কাব্যের রচয়িতা কে?',
      'ক. শরৎচন্দ্র চট্টোপাধ্যায়',
      'খ. বড়ু চণ্ডীদাস',
      'গ. কাজী নজরুল ইসলাম',
      'ঘ. বঙ্কিমচন্দ্র চট্টোপাধ্যায়',
      'উত্তর: খ. বড়ু চণ্ডীদাস',
    ].join('\n')
  );
  const grouped = groupDisplayItemsWithOptionBlocks(parsed.bodyItems, 24);
  const enhanced = attachInlineAnswersToOptionGroups(grouped, 2);

  const nonSpacer = enhanced.filter((b) => b.kind !== 'spacer');

  // Q01 short options + short "Answer: D" attaches inline on Row 2 -> no separate solution block after Q01
  assert.equal(nonSpacer[1].kind, 'option_group');
  if (nonSpacer[1].kind === 'option_group') {
    assert.deepEqual(nonSpacer[1].inlineAnswer, { label: 'Answer', text: 'D' });
  }
  assert.equal(nonSpacer[2].kind, 'question'); // Q02 follows immediately without duplicate solution!

  // Q02 long option 4 ("ঘ. বঙ্কিমচন্দ্র চট্টোপাধ্যায়") + longer answer ("উত্তর: খ. বড়ু চণ্ডীদাস") stays on its own line below
  assert.equal(
    canPlaceAnswerOnLastOptionRow({
      lastRowOptions: [
        { marker: 'গ.', text: 'কাজী নজরুল ইসলাম' },
        { marker: 'ঘ.', text: 'বঙ্কিমচন্দ্র চট্টোপাধ্যায়' },
      ],
      columns: 2,
      answerLabel: 'উত্তর',
      answerText: 'খ. বড়ু চণ্ডীদাস',
      layoutColumns: 2,
    }),
    false
  );
  const q2OptGroup = nonSpacer[3];
  assert.equal(q2OptGroup.kind, 'option_group');
  if (q2OptGroup.kind === 'option_group') {
    assert.equal(q2OptGroup.inlineAnswer, undefined);
  }
  assert.equal(nonSpacer[4].kind, 'solution');

  // Regression guard: 9-char English option "d) Acomodate" + "Answer: A" must drop to own line
  // to prevent mid-word wrapping ("Acomoda / te"), while short "d) Weak" + "Answer: A" stays inline
  assert.equal(
    canPlaceAnswerOnLastOptionRow({
      lastRowOptions: [
        { marker: 'c)', text: 'Accomodate' },
        { marker: 'd)', text: 'Acomodate' },
      ],
      columns: 2,
      answerLabel: 'Answer',
      answerText: 'A',
      layoutColumns: 2,
    }),
    false
  );
  assert.equal(
    canPlaceAnswerOnLastOptionRow({
      lastRowOptions: [
        { marker: 'c)', text: 'Angry' },
        { marker: 'd)', text: 'Weak' },
      ],
      columns: 2,
      answerLabel: 'Answer',
      answerText: 'A',
      layoutColumns: 2,
    }),
    true
  );
});
