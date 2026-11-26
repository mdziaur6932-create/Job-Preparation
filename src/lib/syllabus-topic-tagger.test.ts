import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuestionSyllabusTopic,
  resolveCanonicalSyllabusTopic,
  parseDemoQuestionBlueprint,
  buildCrossBookTopicClusters,
  selectChunksForExamBlueprint,
  DEMO_QUESTION_TEMPLATES,
} from './syllabus-topic-tagger';
import type { Book, Question } from '../types/system';

test('classifyQuestionSyllabusTopic tags Sandhi Bicched, Right Form of Verbs, Math Geometry, Translation, and ICT accurately', () => {
  const sandhi = classifyQuestionSyllabusTopic(
    'সন্ধি বিচ্ছেদ করুন: নবান্ন = নব + অন্ন, হিমালয় = হিম + আলয়।'
  );
  assert.equal(sandhi.id, 'sandhi-bicched');
  assert.equal(sandhi.label, 'সন্ধি বিচ্ছেদ (Sandhi Bicched)');
  assert.equal(sandhi.subjectGroup, 'বাংলা');

  const verbs = classifyQuestionSyllabusTopic(
    'Use the Right Form of Verbs: He (go) to office before I arrived.'
  );
  assert.equal(verbs.id, 'right-form-of-verbs');
  assert.equal(verbs.label, 'Right Form of Verbs');
  assert.equal(verbs.subjectGroup, 'ইংরেজি');

  const geometry = classifyQuestionSyllabusTopic(
    'একটি সমকোণী ত্রিভুজের ভূমি ১২ সেমি ও উচ্চতা ৫ সেমি হলে ত্রিভুজের ক্ষেত্রফল ও কর্ণ কত?'
  );
  assert.equal(geometry.id, 'math-geometry');
  assert.equal(geometry.label, 'Math Geometry (জ্যামিতি)');
  assert.equal(geometry.subjectGroup, 'গণিত ও মানসিক দক্ষতা');

  const translation = classifyQuestionSyllabusTopic(
    'Translate into English: আমি যদি রাজা হতাম।'
  );
  assert.equal(translation.id, 'translation');

  const ict = classifyQuestionSyllabusTopic(
    'কোন protocol টি internet সংযোগের ক্ষেত্রে সর্বাধিক ব্যবহৃত হয়? TCP/IP'
  );
  assert.equal(ict.id, 'computer-ict');
  assert.equal(ict.subjectGroup, 'কম্পিউটার ও ICT');
});

test('classifyQuestionSyllabusTopic respects canonical topic embedded in chapter metadata', () => {
  const tagged = classifyQuestionSyllabusTopic('সাধারণ প্রশ্ন', {
    chapter: 'সন্ধি বিচ্ছেদ (Sandhi Bicched) · অধ্যায় ২',
    subject: 'বাংলা',
  });
  assert.equal(tagged.id, 'sandhi-bicched');
});

test('resolveCanonicalSyllabusTopic resolves IDs, labels, and keywords', () => {
  assert.equal(
    resolveCanonicalSyllabusTopic('sandhi-bicched')?.label,
    'সন্ধি বিচ্ছেদ (Sandhi Bicched)'
  );
  assert.equal(
    resolveCanonicalSyllabusTopic('Right Form of Verbs')?.id,
    'right-form-of-verbs'
  );
  assert.equal(
    resolveCanonicalSyllabusTopic('জ্যামিতি ও ত্রিভুজ')?.id,
    'math-geometry'
  );
  assert.equal(resolveCanonicalSyllabusTopic(''), null);
});

test('parseDemoQuestionBlueprint extracts Bengali/ASCII MCQ & Written counts and multiple topics', () => {
  const ministryDemo = parseDemoQuestionBlueprint(
    DEMO_QUESTION_TEMPLATES[0].text
  );
  assert.equal(ministryDemo.detectedMcqHintCount, 6);
  assert.equal(ministryDemo.detectedWrittenHintCount, 3);
  assert.equal(ministryDemo.hasMcqSection, true);
  assert.equal(ministryDemo.hasWrittenSection, true);
  assert.ok(
    ministryDemo.detectedTopics.includes('সন্ধি বিচ্ছেদ (Sandhi Bicched)')
  );
  assert.ok(ministryDemo.detectedTopics.includes('Right Form of Verbs'));
  assert.ok(ministryDemo.detectedTopics.includes('Math Geometry (জ্যামিতি)'));
  assert.ok(
    ministryDemo.detectedTopics.includes('Translation (বাংলা ↔ ইংরেজি)')
  );

  const asciiDemo = parseDemoQuestionBlueprint(
    'MCQ 10 টি প্রশ্ন এবং Written 4 টি প্রশ্ন: কারক ও বিভক্তি, TCP/IP protocol'
  );
  assert.equal(asciiDemo.detectedMcqHintCount, 10);
  assert.equal(asciiDemo.detectedWrittenHintCount, 4);
  assert.ok(asciiDemo.detectedTopics.includes('কারক ও বিভক্তি'));
  assert.ok(
    asciiDemo.detectedTopics.includes('কম্পিউটার ও তথ্যপ্রযুক্তি (ICT)')
  );
});

function makeMockBooks(): Book[] {
  return [
    {
      id: 101,
      title: 'Recent Job Solution Part 01',
      subject: 'বাংলা ও ইংরেজি',
      author: 'অগ্রদূত',
      fileType: 'PDF',
      totalPages: 2,
      uploadedAt: '2026-11-20',
      chunks: [
        {
          id: 1001,
          bookId: 101,
          bookTitle: 'Recent Job Solution Part 01',
          chapter: 'মৎস্য অধিদপ্তর — লিখিত পরীক্ষা',
          pageNumber: 1,
          content: `মৎস্য অধিদপ্তর
পদের নাম: হ্যাচারি এটেনডেন্ট
০১. সন্ধি বিচ্ছেদ করুন:
a) নবান্ন = নব + অন্ন।
b) হিমালয় = হিম + আলয়।

০২. Use Right Form of Verbs:
a) He (go) to school every day. = goes`,
          keywords: ['সন্ধি বিচ্ছেদ', 'Right Form of Verbs'],
        },
      ],
    },
    {
      id: 102,
      title: 'Recent Job Solution Part 02',
      subject: 'গণিত ও সাধারণ জ্ঞান',
      author: 'অগ্রদূত',
      fileType: 'PDF',
      totalPages: 2,
      uploadedAt: '2026-11-21',
      chunks: [
        {
          id: 2001,
          bookId: 102,
          bookTitle: 'Recent Job Solution Part 02',
          chapter: 'বাণিজ্য মন্ত্রণালয় — প্রিলি ও লিখিত',
          pageNumber: 5,
          content: `বাণিজ্য মন্ত্রণালয়
১. একটি ত্রিভুজের তিন কোণের সমষ্টি কত ডিগ্রি?
ক) ৯০° খ) ১৮০° গ) ২৭০° ঘ) ৩৬০°
উত্তর: খ) ১৮০°

২. সন্ধি বিচ্ছেদ করুন: 'বিদ্যালয়' এর সঠিক সন্ধি বিচ্ছেদ কোনটি?
ক) বিদ্যা + আলয় খ) বিদ্য + আলয় গ) বিদ + আলয় ঘ) বিদ্যা + লয়
উত্তর: ক) বিদ্যা + আলয়`,
          keywords: ['ত্রিভুজ', 'জ্যামিতি', 'সন্ধি বিচ্ছেদ'],
        },
      ],
    },
  ];
}

test('buildCrossBookTopicClusters aggregates questions across multiple books and Question Bank with AI overrides', () => {
  const books = makeMockBooks();
  const bankQuestions: Question[] = [
    {
      id: 501,
      bookId: 102,
      bookTitle: 'Recent Job Solution Part 02',
      subject: 'গণিত',
      chapter: 'জ্যামিতি অধ্যায়',
      pageNumber: 8,
      questionType: 'Written',
      difficulty: 'Medium',
      stem: 'একটি আয়তক্ষেত্রের দৈর্ঘ্য ২০ মিটার ও প্রস্থ ১০ মিটার হলে ক্ষেত্রফল কত?',
      options: [],
      modelAnswer: 'ক্ষেত্রফল = ২০ × ১০ = ২০০ বর্গমিটার।',
      explanation: 'আয়তক্ষেত্রের ক্ষেত্রফল = দৈর্ঘ্য × প্রস্থ।',
      isPreviousYear: true,
      createdAt: '2026-11-22',
    },
  ];

  const { entries, clusters } = buildCrossBookTopicClusters({
    books,
    questions: bankQuestions,
    aiTagOverrides: {
      'bank:501': {
        topicLabel: 'Math Geometry (জ্যামিতি)',
        subjectGroup: 'গণিত ও মানসিক দক্ষতা',
        confidence: 0.98,
      },
    },
  });

  assert.ok(entries.length >= 3, 'Should extract entries from both books + bank');

  const sandhiCluster = clusters.find((c) => c.topicId === 'sandhi-bicched');
  assert.ok(sandhiCluster, 'Sandhi Bicched cluster should exist');
  assert.ok(
    sandhiCluster.bookTitles.includes('Recent Job Solution Part 01') &&
      sandhiCluster.bookTitles.includes('Recent Job Solution Part 02'),
    'Sandhi Bicched cluster should span both imported books'
  );

  const geometryCluster = clusters.find((c) => c.topicId === 'math-geometry');
  assert.ok(geometryCluster, 'Math Geometry cluster should exist');
  assert.ok(geometryCluster.totalCount >= 2);
  const overriddenBankEntry = entries.find((e) => e.uid === 'bank:501');
  assert.equal(overriddenBankEntry?.taggedBy, 'ai');
  assert.equal(overriddenBankEntry?.confidence, 0.98);
});

test('selectChunksForExamBlueprint ensures multi-book balanced chunk selection', () => {
  const books = makeMockBooks();
  const selected = selectChunksForExamBlueprint({
    books,
    selectedBookIds: [101, 102],
    demoText: DEMO_QUESTION_TEMPLATES[0].text,
    selectedTopics: ['সন্ধি বিচ্ছেদ (Sandhi Bicched)', 'Math Geometry (জ্যামিতি)'],
    topK: 4,
  });

  assert.equal(selected.length, 2);
  const selectedBookIds = new Set(selected.map((c) => c.bookId));
  assert.ok(selectedBookIds.has(101), 'Must include chunk from Book 101');
  assert.ok(selectedBookIds.has(102), 'Must include chunk from Book 102');
});
