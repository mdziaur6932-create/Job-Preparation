import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAPER_CUTTING_DRIVE_FOLDER_ID,
  PAPER_CUTTING_DRIVE_FOLDER_URL,
  extractGoogleDriveFolderId,
} from './google-drive';
import {
  buildShortQuestionsFromPaperCutting,
  extractImportedPaperCuttingDriveIds,
  formatPaperCuttingClipboardText,
  formatPaperCuttingForBookChunk,
  isPaperCuttingGkItem,
  normalizePaperCuttingAnalysis,
  parsePaperCuttingFromGkItem,
  serializePaperCuttingToGkInput,
} from './paper-cutting-parser';

test('PAPER_CUTTING_DRIVE_FOLDER_URL extracts exact requested folder ID', () => {
  assert.equal(
    extractGoogleDriveFolderId(PAPER_CUTTING_DRIVE_FOLDER_URL),
    PAPER_CUTTING_DRIVE_FOLDER_ID
  );
  assert.equal(
    PAPER_CUTTING_DRIVE_FOLDER_ID,
    '1WZlt8I7B0pISMEkaYOxv_36gvs-kdsNW'
  );
});

test('normalizePaperCuttingAnalysis cleans prefixes, deduplicates questions, and maps categories', () => {
  const analysis = normalizePaperCuttingAnalysis(
    {
      headline: 'বাংলাদেশে প্রথম গভীর সমুদ্রবন্দর মাতারবাড়ী প্রকল্পের অগ্রগতি',
      category: 'Economy & Trade',
      eventDate: '2026-11-22',
      newspaperSource: 'প্রথম আলো',
      keySummary: 'মাতারবাড়ী গভীর সমুদ্রবন্দর ২০২৯ সালের মধ্যে পূর্ণাঙ্গভাবে চালু হবে।',
      shortQAs: [
        {
          question: '১. বাংলাদেশের প্রথম গভীর সমুদ্রবন্দর কোথায় নির্মিত হচ্ছে?',
          answer: 'উত্তর: কক্সবাজারের মহেশখালী উপজেলার মাতারবাড়ীতে।',
          topicTag: 'মেগা প্রকল্প',
        },
        {
          question: '1. বাংলাদেশের প্রথম গভীর সমুদ্রবন্দর কোথায় নির্মিত হচ্ছে?',
          answer: 'মাতারবাড়ী (ডুপ্লিকেট)',
        },
        {
          question: 'মাতারবাড়ী গভীর সমুদ্রবন্দর প্রকল্পে প্রধান অর্থায়নকারী সংস্থা কোনটি?',
          answer: 'জাইকা (JICA)।',
          topicTag: 'অর্থায়ন',
        },
      ],
    },
    { fileName: 'matarbari_clipping.jpg' }
  );

  assert.equal(analysis.category, 'অর্থনীতি');
  assert.equal(analysis.eventDate, '2026-11-22');
  assert.equal(analysis.newspaperSource, 'প্রথম আলো');
  assert.equal(analysis.shortQAs.length, 2);
  assert.equal(
    analysis.shortQAs[0].question,
    'বাংলাদেশের প্রথম গভীর সমুদ্রবন্দর কোথায় নির্মিত হচ্ছে?'
  );
  assert.equal(
    analysis.shortQAs[0].answer,
    'কক্সবাজারের মহেশখালী উপজেলার মাতারবাড়ীতে।'
  );
});

test('serializePaperCuttingToGkInput and parsePaperCuttingFromGkItem round-trip cleanly within Firestore limits', () => {
  const analysis = normalizePaperCuttingAnalysis({
    headline: 'বিশ্ব জলবায়ু সম্মেলন COP31 ও বাংলাদেশের অবস্থান',
    category: 'আন্তর্জাতিক',
    eventDate: '2026-11-18',
    newspaperSource: 'বণিক বার্তা',
    keySummary: 'COP31 সম্মেলনে লস অ্যান্ড ড্যামেজ তহবিলে নতুন প্রতিশ্রুতি ঘোষণা করা হয়েছে।',
    shortQAs: [
      {
        question: 'লস অ্যান্ড ড্যামেজ তহবিল কোন খাতের জন্য গঠিত?',
        answer: 'জলবায়ু পরিবর্তনে ক্ষতিগ্রস্ত উন্নয়নশীল দেশগুলোর সহায়তার জন্য।',
        topicTag: 'জলবায়ু',
      },
      {
        question: 'UNFCCC-এর পূর্ণরূপ কী?',
        answer: 'United Nations Framework Convention on Climate Change।',
      },
    ],
  });

  const payload = serializePaperCuttingToGkInput(analysis, {
    fileName: 'cop31_news.jpg',
    driveFileId: '1AbCdEfGhIjKlMnOpQrStUvWx',
  });

  assert.ok(payload.title.length <= 240);
  assert.ok(payload.summary.length <= 6000);
  assert.ok(payload.source.length <= 200);
  assert.equal(isPaperCuttingGkItem(payload), true);

  const parsed = parsePaperCuttingFromGkItem(payload);
  assert.equal(parsed.isPaperCutting, true);
  assert.equal(parsed.newspaperName, 'বণিক বার্তা');
  assert.equal(parsed.driveFileId, '1AbCdEfGhIjKlMnOpQrStUvWx');
  assert.equal(parsed.shortQAs.length, 2);
  assert.equal(parsed.shortQAs[0].topicTag, 'জলবায়ু');
  assert.equal(
    parsed.shortQAs[1].answer,
    'United Nations Framework Convention on Climate Change।'
  );
});

test('serializePaperCuttingToGkInput strictly enforces Firestore 6000-char summary ceiling even for huge inputs', () => {
  const longText = 'বাংলাদেশের সাম্প্রতিক অর্থনৈতিক ও অবকাঠামোগত উন্নয়ন তথ্য '.repeat(
    60
  );
  const analysis = normalizePaperCuttingAnalysis({
    headline: 'দীর্ঘ প্রতিবেদন শিরোনাম '.repeat(30),
    category: 'জাতীয়',
    eventDate: '2026-11-24',
    newspaperSource: 'দৈনিক ইত্তেফাক',
    keySummary: longText,
    shortQAs: Array.from({ length: 15 }, (_, idx) => ({
      question: `গুরুত্বপূর্ণ প্রশ্ন নম্বর ${idx + 1}: ${longText}`,
      answer: `সুনির্দিষ্ট উত্তর নম্বর ${idx + 1}: ${longText}`,
    })),
  });

  const payload = serializePaperCuttingToGkInput(analysis, {
    fileName: 'very_long_newspaper_cutting_file_name_for_stress_test_2026.jpeg',
    driveFileId: '1ZzYyXxWwVvUuTtSsRrQqPpOoNn',
  });

  assert.ok(payload.title.length <= 240);
  assert.ok(payload.summary.length <= 6000);
  assert.ok(payload.source.length <= 200);
});

test('buildShortQuestionsFromPaperCutting generates Short Question Bank records', () => {
  const analysis = normalizePaperCuttingAnalysis({
    headline: 'ডিজিটাল ব্যাংক লাইসেন্স নীতিমালা',
    category: 'অর্থনীতি',
    eventDate: '2026-11-15',
    newspaperSource: 'প্রথম আলো',
    keySummary: 'বাংলাদেশ ব্যাংক নতুন ডিজিটাল ব্যাংক নীতিমালা প্রকাশ করেছে।',
    shortQAs: [
      {
        question: 'ডিজিটাল ব্যাংকের ন্যূনতম পরিশোধিত মূলধন কত কোটি টাকা?',
        answer: '১২৫ কোটি টাকা।',
        topicTag: 'ব্যাংকিং',
      },
    ],
  });

  const gkPayload = serializePaperCuttingToGkInput(analysis);
  const questions = buildShortQuestionsFromPaperCutting(gkPayload);

  assert.equal(questions.length, 1);
  assert.equal(questions[0].questionType, 'Short');
  assert.equal(questions[0].subject, 'সাম্প্রতিক সাধারণ জ্ঞান');
  assert.equal(questions[0].modelAnswer, '১২৫ কোটি টাকা।');
  assert.ok(questions[0].bookTitle.includes('প্রথম আলো'));
});

test('formatPaperCuttingForBookChunk, clipboard formatter, and Drive ID extractor work cleanly', () => {
  const analysis = normalizePaperCuttingAnalysis({
    headline: 'বঙ্গবন্ধু স্যাটেলাইট-২ ও মহাকাশ গবেষণা',
    category: 'বিজ্ঞান ও প্রযুক্তি',
    eventDate: '2026-11-21',
    newspaperSource: 'সমকাল',
    keySummary: 'দ্বিতীয় স্যাটেলাইট প্রকল্পের কারিগরি সমীক্ষা সম্পন্ন হয়েছে।',
    shortQAs: [
      {
        question: 'বাংলাদেশের প্রথম কৃত্রিম উপগ্রহ কবে উৎক্ষেপণ করা হয়?',
        answer: '১১ মে ২০১৮।',
      },
    ],
  });

  const chunk = formatPaperCuttingForBookChunk(analysis, {
    fileName: 'sat2.png',
  });
  assert.ok(chunk.includes('শিরোনাম: বঙ্গবন্ধু স্যাটেলাইট-২ ও মহাকাশ গবেষণা'));
  assert.ok(chunk.includes('১. বাংলাদেশের প্রথম কৃত্রিম উপগ্রহ কবে উৎক্ষেপণ করা হয়?'));
  assert.ok(chunk.includes('উত্তর: ১১ মে ২০১৮।'));

  const gkItem = serializePaperCuttingToGkInput(analysis, {
    driveFileId: '1DrivePhotoId987654321',
  });
  const clipText = formatPaperCuttingClipboardText(gkItem);
  assert.ok(clipText.includes('উত্তর: ১১ মে ২০১৮।'));

  const importedSet = extractImportedPaperCuttingDriveIds(
    [gkItem],
    [{ driveFileId: '1BookDriveId123456789' }]
  );
  assert.equal(importedSet.has('1DrivePhotoId987654321'), true);
  assert.equal(importedSet.has('1BookDriveId123456789'), true);
});
