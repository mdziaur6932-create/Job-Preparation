import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBookOrSeriesQuestions,
  buildMergedBookChunks,
  classifyExamQuestionTopic,
  classifyQuestionFormat,
  groupBooksIntoSeries,
  parseBookSeriesIdentity,
} from './book-series-and-topic-analyzer';
import type { Book } from '../types/system';

function makePartBook(params: {
  id: number;
  title: string;
  totalPages: number;
  pages: Array<{ pageNumber: number; chapter: string; content: string }>;
}): Book {
  return {
    id: params.id,
    title: params.title,
    author: 'Recent Publication',
    subject: 'বাংলাদেশ বিষয়াবলি',
    category: 'রিসেন্ট জব সলুশন',
    totalPages: params.totalPages,
    extractionMethod: 'ocr',
    ocrCompleted: true,
    createdAt: '2026-01-10',
    chunks: params.pages.map((p, idx) => ({
      id: params.id * 1000 + idx + 1,
      bookId: params.id,
      bookTitle: params.title,
      chapter: p.chapter,
      pageNumber: p.pageNumber,
      chunkIndex: idx,
      content: p.content,
    })),
  };
}

test('parseBookSeriesIdentity and groupBooksIntoSeries unify multi-part books with continuous page offsets', () => {
  const id1 = parseBookSeriesIdentity('Recent Job SOLUTION Part 01');
  assert.equal(id1.seriesTitle, 'Recent Job SOLUTION');
  assert.equal(id1.partNumber, 1);

  const id2 = parseBookSeriesIdentity('Recent Job SOLUTION Part 02');
  assert.equal(id2.seriesTitle, 'Recent Job SOLUTION');
  assert.equal(id2.partNumber, 2);
  assert.equal(id1.seriesKey, id2.seriesKey);

  const idBn = parseBookSeriesIdentity('অগ্রদূত জব সলিউশন পর্ব ২');
  assert.equal(idBn.seriesTitle, 'অগ্রদূত জব সলিউশন');
  assert.equal(idBn.partNumber, 2);

  const part1 = makePartBook({
    id: 101,
    title: 'Recent Job SOLUTION Part 01',
    totalPages: 100,
    pages: [{ pageNumber: 1, chapter: 'মৎস্য অধিদপ্তর', content: 'মৎস্য অধিদপ্তর\n01. সন্ধি বিচ্ছেদ করুন:\n    a) নবান্ন = নব + অন্ন।' }],
  });
  const part2 = makePartBook({
    id: 102,
    title: 'Recent Job SOLUTION Part 02',
    totalPages: 100,
    pages: [{ pageNumber: 1, chapter: 'খাদ্য অধিদপ্তর', content: 'খাদ্য অধিদপ্তর\n01. সন্ধি বিচ্ছেদ করুন:\n    a) নবান্ন = নব + অন্ন।' }],
  });

  const groups = groupBooksIntoSeries([part2, part1]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isMultiPart, true);
  assert.equal(groups[0].seriesTitle, 'Recent Job SOLUTION');
  assert.equal(groups[0].totalPages, 200);
  // Part 1 comes before Part 2 and Part 2's page 1 is offset to 101 so no page collision occurs
  assert.equal(groups[0].combinedChunks[0].pageNumber, 1);
  assert.equal(groups[0].combinedChunks[1].pageNumber, 101);

  const merged = buildMergedBookChunks([part1, part2]);
  assert.equal(merged.totalPages, 200);
  assert.equal(merged.chunks.length, 2);
  assert.equal(merged.chunks[0].pageNumber, 1);
  assert.equal(merged.chunks[1].pageNumber, 101);
});

test('classifyQuestionFormat separates MCQ from Written questions cleanly', () => {
  const mcq = classifyQuestionFormat({
    questionText: 'বাঘময়ের মধ্যে সবচেয়ে সচল ও সক্রিয় প্রত্যঙ্গ কোনটি?',
    options: [
      { marker: 'a)', text: 'জিহ্বা' },
      { marker: 'b)', text: 'শ্বাসনালী' },
      { marker: 'c)', text: 'ফুসফুস' },
      { marker: 'd)', text: 'ওষ্ঠ' },
    ],
    answerText: 'A',
    solutionSteps: [],
  });
  assert.equal(mcq, 'MCQ');

  const writtenSandhi = classifyQuestionFormat({
    questionText: 'সন্ধি বিচ্ছেদ করুন:',
    options: [
      { marker: 'a)', text: 'নবান্ন = নব + অন্ন।' },
      { marker: 'b)', text: 'হিমালয় = হিম + আলয়।' },
      { marker: 'c)', text: 'সজ্জন = সৎ + জন।' },
    ],
    answerText: '',
    solutionSteps: [],
  });
  assert.equal(writtenSandhi, 'Written');

  const writtenArticle = classifyQuestionFormat({
    questionText: 'Fill in the gap using appropriate Article:',
    options: [
      { marker: 'a)', text: '___ rich are not always happy. (the)' },
      { marker: 'b)', text: 'You are ___ Nazrul, I see. (a)' },
    ],
    answerText: '',
    solutionSteps: [],
  });
  assert.equal(writtenArticle, 'Written');

  const writtenMath = classifyQuestionFormat({
    questionText: '৪০ কেজি মিশ্রণে বালি ও সিমেন্টের অনুপাত ৪ : ১। মিশ্রণটিতে বালি ও সিমেন্টের পরিমাণ কত?',
    options: [],
    answerText: 'বালি ৩২ কেজি এবং সিমেন্ট ৮ কেজি',
    solutionSteps: ['প্রশ্নমতে, ৪x + x = ৪০', '⇒ ৫x = ৪০', '∴ x = ৮'],
  });
  assert.equal(writtenMath, 'Written');
});

test('classifyExamQuestionTopic maps Bengali, English, Math, and GK questions accurately', () => {
  assert.equal(classifyExamQuestionTopic('সন্ধি বিচ্ছেদ করুন:').topic, 'সন্ধি বিচ্ছেদ');
  assert.equal(classifyExamQuestionTopic('এক কথায় প্রকাশ করুন:').topic, 'এক কথায় প্রকাশ');
  assert.equal(classifyExamQuestionTopic('বিপরীত শব্দ লিখুন:').topic, 'বিপরীত শব্দ');
  assert.equal(
    classifyExamQuestionTopic("'ভুল করা মানুষের স্বভাব' বাক্যটির সঠিক ইংরেজি অনুবাদ হবে-").topic,
    'Translation (অনুবাদ)'
  );
  assert.equal(
    classifyExamQuestionTopic('পাড়সহ একটি পুকুরের দৈর্ঘ্য ৮০ মিটার ও প্রস্থ ৫০ মিটার। পুকুর পাড়ের ক্ষেত্রফল কত?').topic,
    'জ্যামিতি ও পরিমিতি'
  );
});

test('analyzeBookOrSeriesQuestions aggregates topics and detects repeated questions across multi-part books with exam & post metadata', () => {
  const part1 = makePartBook({
    id: 201,
    title: 'Recent Job SOLUTION Part 01',
    totalPages: 2,
    pages: [
      {
        pageNumber: 1,
        chapter: 'মৎস্য অধিদপ্তর',
        content: `মৎস্য অধিদপ্তর
পদের নাম: হ্যাচারি এটেন্ডেন্ট
তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০

01. সন্ধি বিচ্ছেদ করুন:
    a) নবান্ন = নব + অন্ন।
    b) হিমালয় = হিম + আলয়।

02. এক কথায় প্রকাশ করুন:
    a) যে সকল অত্যাচার সহ্য করে = সর্বসহা।`,
      },
      {
        pageNumber: 2,
        chapter: 'প্রাথমিক শিক্ষা অধিদপ্তর',
        content: `প্রাথমিক শিক্ষা অধিদপ্তর
পদের নাম: সহকারী শিক্ষক
তারিখ: ০৮.১২.২০২৩; সময়: ৬০ মিনিট; পূর্ণমান: ৭৫

01. 'ভুল করা মানুষের স্বভাব' বাক্যটির সঠিক ইংরেজি অনুবাদ হবে-
    a) To err is human.
    b) To err is a human.
    c) To err is humans.
    d) To err are human.
Answer: A

02. বাঘময়ের মধ্যে সবচেয়ে সচল ও সক্রিয় প্রত্যঙ্গ কোনটি?
    a) জিহ্বা
    b) শ্বাসনালী
    c) ফুসফুস
    d) ওষ্ঠ
Answer: A`,
      },
    ],
  });

  const part2 = makePartBook({
    id: 202,
    title: 'Recent Job SOLUTION Part 02',
    totalPages: 2,
    pages: [
      {
        pageNumber: 1,
        chapter: 'খাদ্য অধিদপ্তর',
        content: `খাদ্য অধিদপ্তর
পদের নাম: উপ-খাদ্য পরিদর্শক
তারিখ: ১৯.০১.২০২৪; সময়: ৬০ মিনিট; পূর্ণমান: ১০০

01. সন্ধি বিচ্ছেদ করুন:
    a) নবান্ন = নব + অন্ন।
    b) সজ্জন = সৎ + জন।`,
      },
      {
        pageNumber: 2,
        chapter: 'স্বাস্থ্য অধিদপ্তর',
        content: `স্বাস্থ্য অধিদপ্তর
পদের নাম: অফিস সহকারী কাম কম্পিউটার মুদ্রাক্ষরিক
তারিখ: ২৬.০১.২০২৪; সময়: ৬০ মিনিট; পূর্ণমান: ৭০

01. 'ভুল করা মানুষের স্বভাব' বাক্যটির সঠিক ইংরেজি অনুবাদ হবে-
    a) To err is human.
    b) To err is a human.
    c) To err is humans.
    d) To err are human.
Answer: A`,
      },
    ],
  });

  const report = analyzeBookOrSeriesQuestions([part1, part2]);

  assert.equal(report.isMultiPart, true);
  assert.equal(report.partCount, 2);
  assert.equal(report.totalExams, 4);
  assert.equal(report.mcqExamCount, 2);
  assert.equal(report.writtenExamCount, 2);
  assert.equal(report.mcqQuestionCount, 3);
  assert.equal(report.writtenQuestionCount, 3);

  // Topic-wise check: সন্ধি বিচ্ছেদ appears in BOTH Part 01 (মৎস্য অধিদপ্তর) and Part 02 (খাদ্য অধিদপ্তর)
  const sandhiBucket = report.topicBuckets.find((b) => b.topic === 'সন্ধি বিচ্ছেদ');
  assert.ok(sandhiBucket, 'Expected সন্ধি বিচ্ছেদ topic bucket');
  assert.equal(sandhiBucket.totalCount, 2);
  assert.equal(sandhiBucket.writtenCount, 2);
  const institutions = sandhiBucket.items.map((it) => it.institution);
  assert.ok(institutions.includes('মৎস্য অধিদপ্তর'));
  assert.ok(institutions.includes('খাদ্য অধিদপ্তর'));
  const posts = sandhiBucket.items.map((it) => it.postName);
  assert.ok(posts.includes('হ্যাচারি এটেন্ডেন্ট'));
  assert.ok(posts.includes('উপ-খাদ্য পরিদর্শক'));

  // Repeat check: BOTH the MCQ translation AND the atomic written sandhi item (নবান্ন = নব + অন্ন) are detected!
  const repeatedTranslation = report.repeatedQuestions.find((r) =>
    r.canonicalQuestion.includes('ভুল করা মানুষের স্বভাব')
  );
  assert.ok(repeatedTranslation, 'Expected repeated MCQ translation across Part 01 and Part 02');
  assert.equal(repeatedTranslation.repeatCount, 2);
  assert.equal(repeatedTranslation.format, 'MCQ');
  assert.equal(repeatedTranslation.priorityTier, 'high');
  assert.equal(repeatedTranslation.occurrences.length, 2);
  assert.ok(
    repeatedTranslation.occurrences.some((o) => o.institution === 'প্রাথমিক শিক্ষা অধিদপ্তর')
  );
  assert.ok(
    repeatedTranslation.occurrences.some((o) => o.institution === 'স্বাস্থ্য অধিদপ্তর')
  );

  const repeatedSandhi = report.repeatedQuestions.find((r) =>
    r.canonicalQuestion.includes('নবান্ন')
  );
  assert.ok(repeatedSandhi, 'Expected repeated written sub-item নবান্ন across Part 01 and Part 02');
  assert.equal(repeatedSandhi.repeatCount, 2);
  assert.equal(repeatedSandhi.answerText, 'নব + অন্ন।');
  assert.equal(repeatedSandhi.occurrences.length, 2);
});

test('getAvailableSubjects, getAvailableTopicsForSubject, and filterExamViewsByFormat cascade cleanly in serial page order', async () => {
  const {
    getAvailableSubjects,
    getAvailableTopicsForSubject,
    filterExamViewsByFormat,
  } = await import('./book-series-and-topic-analyzer');
  const { buildSmartReaderViews } = await import('./reader-page-grouper');

  const part1 = makePartBook({
    id: 301,
    title: 'Recent Job SOLUTION Part 01',
    totalPages: 2,
    pages: [
      {
        pageNumber: 1,
        chapter: 'মৎস্য অধিদপ্তর',
        content: `মৎস্য অধিদপ্তর
পদের নাম: হ্যাচারি এটেন্ডেন্ট
তারিখ: ১২.০১.২০২৪

01. সন্ধি বিচ্ছেদ করুন:
    a) নবান্ন = নব + অন্ন।

02. এক কথায় প্রকাশ করুন:
    a) যে সকল অত্যাচার সহ্য করে = সর্বসহা।`,
      },
      {
        pageNumber: 2,
        chapter: 'প্রাথমিক শিক্ষা অধিদপ্তর',
        content: `প্রাথমিক শিক্ষা অধিদপ্তর
পদের নাম: সহকারী শিক্ষক
তারিখ: ০৮.১২.২০২৩

01. 'ভুল করা মানুষের স্বভাব' বাক্যটির সঠিক ইংরেজি অনুবাদ হবে-
    a) To err is human.
    b) To err is a human.
    c) To err is humans.
    d) To err are human.
Answer: A

02. ৪৫ টাকায় একটি কলম বিক্রি করায় ১০% ক্ষতি হলো। ক্রয়মূল্য কত?
    a) ৫০ টাকা
    b) ৫৫ টাকা
    c) ৬০ টাকা
    d) ৪৮ টাকা
Answer: A`,
      },
    ],
  });

  const report = analyzeBookOrSeriesQuestions([part1]);

  // All subjects should appear in canonical order: বাংলা, ইংরেজি, গণিত
  const allSubjects = getAvailableSubjects(report, 'all').map((s) => s.subject);
  assert.deepEqual(allSubjects, ['বাংলা', 'ইংরেজি', 'গণিত']);

  // Cascading topics under 'বাংলা' must ONLY include Bengali topics (no English or Math!)
  const bnTopics = getAvailableTopicsForSubject(report, 'বাংলা', 'all').map((t) => t.topic);
  assert.ok(bnTopics.includes('সন্ধি বিচ্ছেদ'));
  assert.ok(bnTopics.includes('এক কথায় প্রকাশ'));
  assert.equal(bnTopics.includes('Translation (অনুবাদ)'), false);
  assert.equal(bnTopics.some((t) => t.includes('পাটিগণিত')), false);

  // Format filter 'MCQ' should exclude Written-only subject 'বাংলা' here and keep ইংরেজি & গণিত
  const mcqSubjects = getAvailableSubjects(report, 'MCQ').map((s) => s.subject);
  assert.deepEqual(mcqSubjects, ['ইংরেজি', 'গণিত']);

  // Exam view filtering must preserve serial page order and separate MCQ vs Written exams
  const { views } = buildSmartReaderViews(part1.chunks, 'exam');
  const allOrdered = filterExamViewsByFormat(views, report.examFormatByViewId, 'all');
  assert.equal(allOrdered.length, 2);
  assert.equal(allOrdered[0].startPage, 1);
  assert.equal(allOrdered[1].startPage, 2);

  const mcqOnly = filterExamViewsByFormat(views, report.examFormatByViewId, 'MCQ');
  assert.equal(mcqOnly.length, 1);
  assert.ok(mcqOnly[0].title.includes('প্রাথমিক শিক্ষা'));

  const writtenOnly = filterExamViewsByFormat(views, report.examFormatByViewId, 'Written');
  assert.equal(writtenOnly.length, 1);
  assert.ok(writtenOnly[0].title.includes('মৎস্য অধিদপ্তর'));
});

test('strict MCQ vs Written classification matches user screenshots 1, 2, and 3 without Written leaking into MCQ', async () => {
  const { filterExamViewsByFormat } = await import('./book-series-and-topic-analyzer');
  const { buildSmartReaderViews } = await import('./reader-page-grouper');

  const mixedBook = makePartBook({
    id: 401,
    title: 'Recent Job SOLUTION Part 01',
    totalPages: 3,
    pages: [
      {
        // Screenshot 1: Real MCQ (বাংলাদেশ সরকারি কর্মকমিশন — সিনিয়র স্টাফ নার্স with ক.–ঘ. and উ. খ / উ. গ)
        pageNumber: 1,
        chapter: 'বাংলাদেশ সরকারি কর্মকমিশন — সিনিয়র স্টাফ নার্স',
        content: `বাংলাদেশ সরকারি কর্মকমিশন
পদের নাম: সিনিয়র স্টাফ নার্স
সময়: ৬০ মিনিট; পরীক্ষার তারিখ: ১৮.০১.২০২৪; পূর্ণমান: ১০০

১. 'It's too soon to say if he'll survive'. Here 'too' is a/an-
ক. verb খ. adverb গ. adjective ঘ. preposition উ. খ

২. 'বনফুল' কোন লেখকের ছদ্মনাম?
ক. সুনীল গঙ্গোপাধ্যায় খ. বিনয়কৃষ্ণ মুখোপাধ্যায় গ. বলাইচাঁদ মুখোপাধ্যায় ঘ. বিভূতিভূষণ বন্দ্যোপাধ্যায় উ. গ
পৃষ্ঠা: ৮৪ (অগ্রদূত বাংলা; ১৩তম সংস্করণ)

৬. বাংলাদেশের জলসীমায় উৎপত্তি ও সমাপ্তি কোন নদীর?
ক. মেঘনা খ. পদ্মা গ. যমুনা ঘ. হালদা উ. ঘ
পৃষ্ঠা: ২০২ (অগ্রদূত বাংলাদেশ বিষয়াবলি; ৭ম সংস্করণ)`,
      },
      {
        // Screenshot 2: Real Written (মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট)
        pageNumber: 2,
        chapter: 'মৎস্য অধিদপ্তর — হ্যাচারি এটেন্ডেন্ট',
        content: `মৎস্য অধিদপ্তর
পদের নাম: হ্যাচারি এটেন্ডেন্ট
তারিখ: ১২.০১.২০২৪; সময়: ৩০ মিনিট; পূর্ণমান: ১০০

01. সন্ধি বিচ্ছেদ করুন:
    a) নবান্ন = নব + অন্ন।
    b) হিমালয় = হিম + আলয়।
    c) সজ্জন = সৎ + জন।
    d) একচ্ছত্র = এক + ছত্র।
    e) স্বচ্ছন্দ = স্ব + ছন্দ।

04. Fill in the gap using appropriate Article:
    a) ___ rich are not always happy. (the) বাক্যের অর্থঃ ধনীরা সর্বদা সুখী হয় না।
    b) You are ___ Nazrul, I see. (a)

06. MRT এর পূর্ণরূপ লিখুন।
Solution: Mass Rapid Transit.`,
      },
      {
        // Screenshot 3: Real Written (বাণিজ্য মন্ত্রণালয় — ডাটা এন্ট্রি/কন্ট্রোল অপারেটর)
        // Includes a 4-item written sub-question WITHOUT `=` signs that previously triggered false MCQ (1) + Written (33)!
        pageNumber: 3,
        chapter: 'বাণিজ্য মন্ত্রণালয় — ডাটা এন্ট্রি/কন্ট্রোল অপারেটর',
        content: `বাণিজ্য মন্ত্রণালয়
জাতীয় ভোক্তা-অধিকার সংরক্ষণ অধিদপ্তর
পদের নাম: ডাটা এন্ট্রি/কন্ট্রোল অপারেটর
তারিখ: ১৩.০১.২০২৪; সময়: ৯০ মিনিট; পূর্ণমান: ৯০

01. সন্ধি বিচ্ছেদ করুন
    a) মহর্ষি = মহা + ঋষি।
    b) শীতার্ত = শীত + ঋত।

02. কারক ও বিভক্তি নির্ণয় করুন-
    a) বুলবুলিতে ধান খেয়েছে।
    b) আকাশে চাঁদ উঠেছে।
    c) তিলে তৈল হয়।
    d) গুরুজনে কর নতি।

03. অর্থসহ বাক্য রচনা করুন:
    a) অরণ্যে রোদন
    b) ডুমুরের ফুল
    c) শাঁখের করাত
    d) হাতটান

04. নিচের প্রশ্নগুলোর সংক্ষেপে উত্তর লিখুন:
    a) পদ্মা সেতুর দৈর্ঘ্য কত?
    b) বাংলাদেশের প্রথম প্রধানমন্ত্রী কে?
    c) বাংলাদেশের জাতীয় সংসদের আসন কয়টি?
    d) ভাষা আন্দোলন কত সালে হয়?

05. একটি আয়তক্ষেত্রের দৈর্ঘ্য ২০ মিটার এবং প্রস্থ ১৫ মিটার হলে ক্ষেত্রফল কত?
Solution: ক্ষেত্রফল = ২০ × ১৫ = ৩০০ বর্গমিটার।`,
      },
    ],
  });

  const report = analyzeBookOrSeriesQuestions([mixedBook]);
  const { views } = buildSmartReaderViews(mixedBook.chunks, 'exam');

  assert.equal(report.totalExams, 3);
  assert.equal(report.mcqExamCount, 1, 'Only PSC Senior Staff Nurse should be MCQ');
  assert.equal(report.writtenExamCount, 2, 'Both মৎস্য অধিদপ্তর and বাণিজ্য মন্ত্রণালয় must be pure Written');
  assert.equal(report.mixedExamCount, 0, 'No exam should be falsely marked Mixed');

  const pscExam = report.exams.find((e) => e.institution.includes('কর্মকমিশন'));
  assert.ok(pscExam);
  assert.equal(pscExam.format, 'MCQ');
  assert.equal(pscExam.mcqCount, 3);
  assert.equal(pscExam.writtenCount, 0);

  const commerceExam = report.exams.find((e) => e.institution.includes('বাণিজ্য'));
  assert.ok(commerceExam);
  assert.equal(commerceExam.format, 'Written');
  assert.equal(commerceExam.mcqCount, 0, 'বাণিজ্য মন্ত্রণালয় must have 0 MCQ questions');
  assert.equal(commerceExam.writtenCount, 5);

  // Filtering by MCQ must return ONLY PSC Senior Staff Nurse — NEVER বাণিজ্য মন্ত্রণালয় or মৎস্য অধিদপ্তর!
  const mcqViews = filterExamViewsByFormat(views, report.examFormatByViewId, 'MCQ');
  assert.equal(mcqViews.length, 1);
  assert.ok(mcqViews[0].title.includes('কর্মকমিশন'));

  // Filtering by Written must return ONLY মৎস্য অধিদপ্তর & বাণিজ্য মন্ত্রণালয় — NEVER PSC MCQ!
  const writtenViews = filterExamViewsByFormat(views, report.examFormatByViewId, 'Written');
  assert.equal(writtenViews.length, 2);
  assert.ok(writtenViews.some((v) => v.title.includes('মৎস্য')));
  assert.ok(writtenViews.some((v) => v.title.includes('বাণিজ্য')));
  assert.equal(
    writtenViews.some((v) => v.title.includes('কর্মকমিশন')),
    false
  );
});

test('Test 8: MCQ exams with side answers (ans. B / উ. ক / উত্তর: গ) and multi-line ব্যাখ্যা: (Solution boxes) classify 100% as MCQ — NEVER Written', () => {
  const januaryMcqBook = makePartBook({
    id: 99,
    title: 'January Job Solution MCQ 2026',
    totalPages: 2,
    pages: [
      {
        chapter: 'দুর্নীতি দমন কমিশন',
        pageNumber: 1,
        content: `দুর্নীতি দমন কমিশন
পদের নামঃ উপ সহকারী পরিচালক
তারিখঃ ০৩.০১.২০২৬; সময়ঃ ৬০ মিনিট; পূর্ণমানঃ ১০০

01. IDA স্বল্পোন্নত দেশগুলোকে কোন জাতীয় ঋণ দিয়ে থাকে?
a) মাইক্রোক্রেডিট b) সফট লোন ans. B
c) বাণিজ্যিক লোন d) পণ্য সাহায্য
Solution: IDA হলো বিশ্বব্যাংকের একটি অঙ্গসংস্থা। IDA (International Development Association) বা আন্তর্জাতিক উন্নয়ন সমিতি। যুক্তরাষ্ট্রের ওয়াশিংটন ডিসিতে এর সদর দপ্তর অবস্থিত। এটি IDA, Soft Loan Window নামেও পরিচিত।

02. ‘নাভাইয়া’ পারমাণবিক পরীক্ষা স্থানটি কোন দেশে অবস্থিত?
a) রাশিয়া b) ভারত
c) যুক্তরাষ্ট্র d) ফ্রান্স ans. A

06. পাপুয়া নিউগিনি কোন অঞ্চলের অন্তর্ভুক্ত?
a) পলিনেশিয়া b) মাইক্রোনেশিয়া
c) মেলানেশিয়া d) ওরিয়েন্টাল অঞ্চল ans. C
Solution: পাপুয়া নিউগিনির রাজধানী হলো পোর্ট মোর্সবি আর আইন সভার নাম হলো জাতীয় সংসদ।

07. ডোনাল্ড ট্রাম্প প্রথম মেয়াদে যুক্তরাষ্ট্রের কততম প্রেসিডেন্ট ছিলেন?
a) ৪৩তম b) ৪৪তম
c) ৪৫তম d) ৪৭তম
Solution: ডোনাল্ড ট্রাম্প মার্কিন যুক্তরাষ্ট্রের ৪৫তম প্রেসিডেন্ট। তিনি ২০১৭ সালের ২০ জানুয়ারি ৪৫তম প্রেসিডেন্ট হিসেবে শপথ গ্রহণ করেন।`,
      },
      {
        chapter: 'সহকারী পরিচালক',
        pageNumber: 2,
        content: `পদের নাম: সহকারী পরিচালক
সময়: ৬০ মিনিট পরীক্ষার তারিখ: ০৯.০১.২০২৬ পূর্ণমান: ১০০

১. ২০২৫ সালে কতজন নারী নোবেল পুরস্কার লাভ করেন?
ক. ২ জন খ. ১ জন উ. ক
গ. ৪ জন ঘ. ৩ জন
পৃষ্ঠা: ৫৮ (ক্রিম; জানুয়ারি- ২০২৫)

৩. ২০২৫ সালে কোন দেশ New Development Bank (NDB) এর সর্বশেষ সদস্য হিসেবে যোগদান করেছে?
ক. আলজেরিয়া খ. দক্ষিণ আফ্রিকা
গ. সংযুক্ত আরব আমিরাত ঘ. ব্রুনাই উ. ক
পৃষ্ঠা: ৫২ (ক্রিম; জানুয়ারি- ২০২৫)

৯৩. ‘হনুজ দিল্লি দূরঅন্ত (দিল্লি এখনো অনেক দূর)।’ -উক্তিটি কার?
ক. হযরত শেখ সাদী রহ.
খ. হযরত শাহজালাল রহ.
গ. হযরত নিজামুদ্দিন আউলিয়া রহ.
ঘ. হযরত খান জাহান আলী রহ. উত্তর: গ`,
      },
    ],
  });

  const report = analyzeBookOrSeriesQuestions([januaryMcqBook]);

  assert.equal(report.totalExams, 2);
  assert.equal(report.mcqExamCount, 2, 'Both exams MUST classify as pure MCQ');
  assert.equal(report.writtenExamCount, 0, 'Zero exams may be misclassified as Written');
  assert.equal(report.mixedExamCount, 0);
  assert.equal(report.writtenQuestionCount, 0, 'Every single MCQ with ব্যাখ্যা: must stay MCQ');
  assert.equal(report.mcqQuestionCount, 7);

  // Verify Q01 keeps Answer = B and Explanation = IDA হলো... strictly separated!
  const q1 = report.questions.find((q) => q.questionText.includes('IDA'));
  assert.ok(q1);
  assert.equal(q1.format, 'MCQ');
  assert.equal(q1.answerText, 'B');
  assert.ok(q1.explanation && q1.explanation.includes('Soft Loan Window'));
  assert.ok(!q1.answerText.includes('বিশ্বব্যাংকের'), 'Explanation must NOT pollute answerText');

  // Verify Q07 (4 MCQ options + ব্যাখ্যা:, even without side ans key) still classifies as MCQ!
  const q7 = report.questions.find((q) => q.questionText.includes('ডোনাল্ড ট্রাম্প'));
  assert.ok(q7);
  assert.equal(q7.format, 'MCQ');
  assert.ok(q7.explanation && q7.explanation.includes('৪৫তম প্রেসিডেন্ট'));
});



