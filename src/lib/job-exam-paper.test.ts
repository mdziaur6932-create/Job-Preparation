import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WRITTEN_BLUEPRINT,
  buildCurrentGkChunks,
  computeSubjectDistribution,
  formatStructuredWrittenAnswer,
  normalizeWrittenSections,
  orderQuestionsForExam,
  parseStructuredWrittenAnswer,
  parseWrittenQuestionStructure,
  summarizeWrittenBlueprint,
} from './job-exam-paper';
import type { DemoTopicWeight } from './demo-paper-blueprint';
import type { CurrentGkItem } from '../types/system';

test('DEFAULT_WRITTEN_BLUEPRINT matches 20 questions and exact 100 marks', () => {
  const summary = summarizeWrittenBlueprint(DEFAULT_WRITTEN_BLUEPRINT);
  assert.equal(summary.totalQuestions, 20);
  assert.equal(summary.totalMarks, 100);
});

test('computeSubjectDistribution aggregates topic weights to exact 100% in standard subject order', () => {
  const topics: DemoTopicWeight[] = [
    {
      topicId: 'math-algebra',
      topicLabel: 'Math Algebra (বীজগণিত ও সমীকরণ)',
      subjectGroup: 'গণিত ও মানসিক দক্ষতা',
      questionCountInDemo: 8,
      percentage: 13,
      questionTypes: ['MCQ'],
    },
    {
      topicId: 'math-arithmetic',
      topicLabel: 'Math Arithmetic (পাটিগণিত ও শতকরা)',
      subjectGroup: 'গণিত ও মানসিক দক্ষতা',
      questionCountInDemo: 7,
      percentage: 12,
      questionTypes: ['MCQ'],
    },
    {
      topicId: 'sandhi-bicched',
      topicLabel: 'সন্ধি বিচ্ছেদ (Sandhi Bicched)',
      subjectGroup: 'বাংলা',
      questionCountInDemo: 15,
      percentage: 25,
      questionTypes: ['MCQ'],
    },
    {
      topicId: 'right-form-of-verbs',
      topicLabel: 'Right Form of Verbs',
      subjectGroup: 'ইংরেজি',
      questionCountInDemo: 15,
      percentage: 25,
      questionTypes: ['MCQ'],
    },
    {
      topicId: 'bangladesh-constitution',
      topicLabel: 'বাংলাদেশ বিষয়াবলি ও সংবিধান',
      subjectGroup: 'সাধারণ জ্ঞান ও বিজ্ঞান',
      questionCountInDemo: 15,
      percentage: 25,
      questionTypes: ['MCQ'],
    },
  ];

  const subjects = computeSubjectDistribution(topics);
  assert.equal(subjects.length, 4);
  assert.deepEqual(
    subjects.map((s) => s.subjectGroup),
    ['বাংলা', 'ইংরেজি', 'সাধারণ জ্ঞান ও বিজ্ঞান', 'গণিত ও মানসিক দক্ষতা']
  );
  assert.equal(
    subjects.reduce((sum, s) => sum + s.percentage, 0),
    100
  );
  assert.deepEqual(
    subjects.map((s) => s.percentage),
    [25, 25, 25, 25]
  );
});

test('orderQuestionsForExam orders subject_serial cleanly (বাংলা → ইংরেজি → সাধারণ জ্ঞান → গণিত) and keeps Written after MCQ', () => {
  const sample = [
    {
      stem: 'x^2 + 5x + 6 = 0 এর উৎপাদক কী?',
      chapter: 'Math Algebra (বীজগণিত ও সমীকরণ)',
      subject: 'গণিত',
      questionType: 'MCQ' as const,
    },
    {
      stem: 'বাংলাদেশের সংবিধানের অনুচ্ছেদ ২৭ কী?',
      chapter: 'বাংলাদেশ বিষয়াবলি ও সংবিধান',
      subject: 'সাধারণ জ্ঞান',
      questionType: 'MCQ' as const,
    },
    {
      stem: 'সন্ধি বিচ্ছেদ করুন: নবান্ন',
      chapter: 'সন্ধি বিচ্ছেদ (Sandhi Bicched)',
      subject: 'বাংলা',
      questionType: 'Written' as const,
    },
    {
      stem: 'সন্ধি বিচ্ছেদ কোনটি সঠিক: নবান্ন?',
      chapter: 'সন্ধি বিচ্ছেদ (Sandhi Bicched)',
      subject: 'বাংলা',
      questionType: 'MCQ' as const,
    },
    {
      stem: 'Choose the correct Right Form of Verbs.',
      chapter: 'Right Form of Verbs',
      subject: 'ইংরেজি',
      questionType: 'MCQ' as const,
    },
  ];

  const ordered = orderQuestionsForExam(sample, 'subject_serial');
  assert.equal(ordered.length, 5);
  assert.equal(ordered[0].subject, 'বাংলা');
  assert.equal(ordered[0].questionType, 'MCQ');
  assert.equal(ordered[1].subject, 'ইংরেজি');
  assert.equal(ordered[2].subject, 'সাধারণ জ্ঞান');
  assert.equal(ordered[3].subject, 'গণিত');
  assert.equal(ordered[4].questionType, 'Written');

  const shuffled = orderQuestionsForExam(sample, 'shuffled', 42);
  assert.equal(shuffled.length, 5);
  assert.equal(shuffled[4].questionType, 'Written');
});

test('parseWrittenQuestionStructure extracts variable marks, sub-questions (ক–ঙ), and OR-choice', () => {
  const subQStem = `[নম্বর: ১×৫ = ৫] সন্ধি বিচ্ছেদ করুন:
ক. নবান্ন
খ. হিমালয়
গ. সজ্জন
ঘ. একচ্ছত্র
ঙ. স্বচ্ছন্দ`;

  const parsedSub = parseWrittenQuestionStructure(subQStem, 5);
  assert.equal(parsedSub.marks, 5);
  assert.equal(parsedSub.hasExplicitMarks, true);
  assert.equal(parsedSub.isChoiceOne, false);
  assert.equal(parsedSub.subItems.length, 5);
  assert.equal(parsedSub.subItems[0].label, 'ক');
  assert.equal(parsedSub.subItems[0].prompt, 'নবান্ন');
  assert.equal(parsedSub.subItems[4].label, 'ঙ');

  const choiceStem = `[নম্বর: ৪] [যেকোনো ১টি উত্তর দিন] Write a paragraph on any one of the following:
ক. Tourism in Cox's Bazar
খ. Digital Bangladesh`;

  const parsedChoice = parseWrittenQuestionStructure(choiceStem, 5);
  assert.equal(parsedChoice.marks, 4);
  assert.equal(parsedChoice.hasExplicitMarks, true);
  assert.equal(parsedChoice.isChoiceOne, true);
  assert.equal(parsedChoice.subItems.length, 2);
  assert.equal(parsedChoice.subItems[0].prompt, "Tourism in Cox's Bazar");
  assert.equal(parsedChoice.subItems[1].prompt, 'Digital Bangladesh');
});

test('formatStructuredWrittenAnswer and parseStructuredWrittenAnswer round-trip sub-questions & OR-choices', () => {
  const subItems = [
    { label: 'ক', prompt: 'নবান্ন' },
    { label: 'খ', prompt: 'হিমালয়' },
  ];

  const serializedSub = formatStructuredWrittenAnswer(
    {
      selectedChoiceLabel: '',
      subAnswers: { ক: 'নব + অন্ন', খ: 'হিম + আলয়' },
      freeText: '',
    },
    subItems,
    false
  );
  assert.equal(serializedSub, 'ক) নব + অন্ন\nখ) হিম + আলয়');

  const parsedBackSub = parseStructuredWrittenAnswer(
    serializedSub,
    subItems,
    false
  );
  assert.equal(parsedBackSub.subAnswers['ক'], 'নব + অন্ন');
  assert.equal(parsedBackSub.subAnswers['খ'], 'হিম + আলয়');

  const serializedChoice = formatStructuredWrittenAnswer(
    {
      selectedChoiceLabel: 'খ',
      subAnswers: {},
      freeText: 'Digital Bangladesh has transformed public services.',
    },
    subItems,
    true
  );
  const parsedBackChoice = parseStructuredWrittenAnswer(
    serializedChoice,
    subItems,
    true
  );
  assert.equal(parsedBackChoice.selectedChoiceLabel, 'খ');
  assert.equal(
    parsedBackChoice.freeText,
    'Digital Bangladesh has transformed public services.'
  );
});

test('buildCurrentGkChunks converts active GK items and excludes archived items', () => {
  const gkItems: CurrentGkItem[] = [
    {
      id: 1,
      title: 'এমআরটি লাইন-৫ উত্তর রুট',
      summary: 'হেমায়েতপুর থেকে ভাটারা পর্যন্ত ২০ কিমি মেট্রোরেল প্রকল্প।',
      category: 'জাতীয়',
      eventDate: '2026-11-10',
      source: 'পেপার কাটিং',
      isArchived: false,
      convertedToQuestions: false,
      createdAt: '2026-11-10',
    },
    {
      id: 2,
      title: 'পুরোনো আর্কাইভ তথ্য',
      summary: 'এটি আর্কাইভ করা হয়েছে।',
      category: 'আন্তর্জাতিক',
      eventDate: '2024-01-01',
      source: 'আর্কাইভ',
      isArchived: true,
      convertedToQuestions: false,
      createdAt: '2024-01-01',
    },
  ];

  const chunks = buildCurrentGkChunks(gkItems);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /এমআরটি লাইন-৫/);
  assert.doesNotMatch(chunks[0].content, /পুরোনো আর্কাইভ তথ্য/);
});

test('normalizeWrittenSections clamps bounds and assigns valid subject groups', () => {
  const normalized = normalizeWrittenSections([
    {
      subjectGroup: 'Math',
      title: 'গাণিতিক সমস্যা',
      questionCount: 5,
      subQuestionsPerItem: 0,
      marksPerQuestion: 5,
      isChoiceOne: false,
      itemStyle: 'step_math',
    },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].subjectGroup, 'গণিত ও মানসিক দক্ষতা');
  assert.equal(normalized[0].marksPerQuestion, 5);
});
