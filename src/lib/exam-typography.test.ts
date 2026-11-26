import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXAM_BN_FONT_SIZE_PT,
  EXAM_EN_FONT_SIZE_PT,
  EXAM_HEADER_FONT_SIZE_PT,
  ptToCanvasPx,
  splitMixedScriptSegments,
} from './exam-typography';

test('defines exact requested point sizes and 150-DPI A4 canvas conversions', () => {
  assert.equal(EXAM_HEADER_FONT_SIZE_PT, 18);
  assert.equal(EXAM_BN_FONT_SIZE_PT, 11);
  assert.equal(EXAM_EN_FONT_SIZE_PT, 12);

  assert.equal(ptToCanvasPx(18, 150), 38);
  assert.equal(ptToCanvasPx(11, 150), 23);
  assert.equal(ptToCanvasPx(12, 150), 25);
});

test('keeps pure Bengali and pure English text as single script runs', () => {
  assert.deepEqual(
    splitMixedScriptSegments('২০২৫ সালে কতজন নারী নোবেল পুরস্কার লাভ করেন?'),
    [{ text: '২০২৫ সালে কতজন নারী নোবেল পুরস্কার লাভ করেন?', script: 'bn' }]
  );

  assert.deepEqual(splitMixedScriptSegments('To err is human.'), [
    { text: 'To err is human.', script: 'en' },
  ]);

  assert.deepEqual(splitMixedScriptSegments('01.'), [
    { text: '01.', script: 'en' },
  ]);
});

test('segments mixed Bengali and English sentences from user screenshots accurately', () => {
  const ida = splitMixedScriptSegments(
    'IDA স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?'
  );
  assert.deepEqual(ida, [
    { text: 'IDA', script: 'en' },
    { text: ' স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?', script: 'bn' },
  ]);

  const ndb = splitMixedScriptSegments(
    '২০২৫ সালে কোন দেশ New Development Bank (NDB) এর সর্বশেষ সদস্য হিসেবে যোগদান করেছে?'
  );
  assert.deepEqual(ndb, [
    { text: '২০২৫ সালে কোন দেশ ', script: 'bn' },
    { text: 'New Development Bank (NDB)', script: 'en' },
    { text: ' এর সর্বশেষ সদস্য হিসেবে যোগদান করেছে?', script: 'bn' },
  ]);

  const exchequer = splitMixedScriptSegments(
    'Chancellor of Ex-chequer কোন দেশের অর্থমন্ত্রীর পদবী?'
  );
  assert.deepEqual(exchequer, [
    { text: 'Chancellor of Ex-chequer', script: 'en' },
    { text: ' কোন দেশের অর্থমন্ত্রীর পদবী?', script: 'bn' },
  ]);

  const the100 = splitMixedScriptSegments("‘The 100’ বইটি কার লেখা?");
  assert.deepEqual(the100, [
    { text: '‘', script: 'bn' },
    { text: 'The 100', script: 'en' },
    { text: '’ বইটি কার লেখা?', script: 'bn' },
  ]);

  const explanation = splitMixedScriptSegments(
    'IDA হলো বিশ্বব্যাংকের একটি অঙ্গসংস্থা। IDA (International Development Association) বা আন্তর্জাতিক উন্নয়ন সমিতি। এটি IDA, Soft Loan Window নামেও পরিচিত।'
  );
  assert.ok(
    explanation.some(
      (s) => s.script === 'en' && s.text === 'IDA (International Development Association)'
    )
  );
  assert.ok(
    explanation.some((s) => s.script === 'en' && s.text === 'IDA, Soft Loan Window')
  );
  assert.ok(
    explanation.some((s) => s.script === 'bn' && s.text.includes('বিশ্বব্যাংকের একটি অঙ্গসংস্থা'))
  );
});
