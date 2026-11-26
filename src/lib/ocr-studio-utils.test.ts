import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFigureMarkdownSnippet,
  buildOcrStudioExportUnit,
  computePixelCropBox,
  convertGeminiBox2dToNormalizedCropRect,
  insertBlockSnippetIntoText,
  mergeOcrStudioSections,
  normalizeCropRect,
  parseOcrStudioStructuredOutput,
  replaceDiagramMarkersWithEmbeddedFigures,
} from './ocr-studio-utils';
import { parseExamDocumentForDisplay } from './exam-text-formatter';
import { buildStructuredExamDocxBytes } from './exam-word-exporter';

test('normalizeCropRect handles reverse drags, clamps out-of-bounds, and ignores accidental clicks', () => {
  const tiny = normalizeCropRect(0.5, 0.5, 0.505, 0.505);
  assert.equal(tiny, null);

  const reversed = normalizeCropRect(0.85, 0.7, 0.25, 0.2);
  assert.ok(reversed);
  assert.equal(Number(reversed.x.toFixed(2)), 0.25);
  assert.equal(Number(reversed.y.toFixed(2)), 0.2);
  assert.equal(Number(reversed.width.toFixed(2)), 0.6);
  assert.equal(Number(reversed.height.toFixed(2)), 0.5);

  const clamped = normalizeCropRect(-0.2, -0.1, 1.4, 1.3);
  assert.deepEqual(clamped, { x: 0, y: 0, width: 1, height: 1 });
});

test('computePixelCropBox scales large crops cleanly while preserving aspect ratio', () => {
  const box = computePixelCropBox(
    { x: 0.25, y: 0.2, width: 0.5, height: 0.4 },
    1600,
    1000,
    400
  );
  assert.deepEqual(box, {
    sx: 400,
    sy: 200,
    sw: 800,
    sh: 400,
    destWidth: 400,
    destHeight: 200,
  });

  // Small crop should NOT be upscaled
  const smallBox = computePixelCropBox(
    { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    500,
    500,
    440
  );
  assert.deepEqual(smallBox, {
    sx: 50,
    sy: 50,
    sw: 100,
    sh: 100,
    destWidth: 100,
    destHeight: 100,
  });
});

test('convertGeminiBox2dToNormalizedCropRect converts 0..1000 & 0..1 boxes and rejects full-page false positives', () => {
  const diceBox = convertGeminiBox2dToNormalizedCropRect([220, 710, 575, 815], 0.01);
  assert.ok(diceBox);
  assert.equal(Number(diceBox.x.toFixed(3)), 0.7);
  assert.equal(Number(diceBox.y.toFixed(3)), 0.21);
  assert.equal(Number(diceBox.width.toFixed(3)), 0.125);
  assert.equal(Number(diceBox.height.toFixed(3)), 0.375);

  // Supports 0..1 coordinates defensively
  const unitBox = convertGeminiBox2dToNormalizedCropRect([0.2, 0.3, 0.5, 0.6], 0);
  assert.ok(unitBox);
  assert.equal(Number(unitBox.x.toFixed(2)), 0.3);
  assert.equal(Number(unitBox.y.toFixed(2)), 0.2);

  // Rejects accidental full-page box [0, 0, 1000, 1000]
  assert.equal(convertGeminiBox2dToNormalizedCropRect([0, 0, 1000, 1000]), null);
  assert.equal(convertGeminiBox2dToNormalizedCropRect([500, 500, 505, 505]), null);
});

test('parseOcrStudioStructuredOutput parses JSON with diagrams, repairs LaTeX backslashes, and falls back to plain text', () => {
  const structuredJson = JSON.stringify({
    content: '৯৯. প্রদত্ত চিত্রটি ভাঁজ করে একটি ঘনক তৈরি করলে কতটি বিন্দু থাকে?\n[[DIAGRAM_1]]\nক. ২\nখ. ৫\nগ. ৪\nঘ. ৬\nউত্তর: ঘ',
    diagrams: [
      {
        id: 'DIAGRAM_1',
        label: '৯৯ নং ঘনকের চিত্র',
        box_2d: [220, 710, 575, 815],
      },
      {
        id: 'BAD_FULL_PAGE',
        label: 'পুরো পৃষ্ঠা',
        box_2d: [0, 0, 1000, 1000],
      },
    ],
  });

  const parsed = parseOcrStudioStructuredOutput(structuredJson);
  assert.ok(parsed.content.includes('[[DIAGRAM_1]]'));
  assert.equal(parsed.diagrams.length, 1);
  assert.equal(parsed.diagrams[0].id, 'DIAGRAM_1');
  assert.equal(parsed.diagrams[0].label, '৯৯ নং ঘনকের চিত্র');

  // Malformed JSON containing raw LaTeX \frac backslash
  const malformedLatexJson =
    '{"content":"৯৭. মান কত? $\\frac{1}{2}$ এবং $\\sqrt{9}$","diagrams":[]}';
  const repaired = parseOcrStudioStructuredOutput(malformedLatexJson);
  assert.ok(repaired.content.includes('\\frac{1}{2}') || repaired.content.includes('frac{1}{2}'));

  // Plain text fallback
  const plain = parseOcrStudioStructuredOutput('৯৫. (৫, ২১) বিন্দুটির মধ্যবিন্দু কোনটি?');
  assert.equal(plain.content, '৯৫. (৫, ২১) বিন্দুটির মধ্যবিন্দু কোনটি?');
  assert.deepEqual(plain.diagrams, []);
});

test('replaceDiagramMarkersWithEmbeddedFigures replaces [[DIAGRAM_1]] cleanly with Markdown data-image figure', () => {
  const sampleDataUrl =
    'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
  const source = [
    '৯৯. প্রদত্ত চিত্রটি ভাঁজ করে একটি ঘনক তৈরি করলে, তিনটি বিন্দু বিশিষ্ট পৃষ্ঠের বিপরীতে কতটি বিন্দু থাকে?',
    '[[DIAGRAM_1]]',
    'ক. ২',
    'খ. ৫',
    'গ. ৪',
    'ঘ. ৬',
    'উত্তর: ঘ',
  ].join('\n');

  const replaced = replaceDiagramMarkersWithEmbeddedFigures(source, [
    { id: 'DIAGRAM_1', label: '৯৯ নং ঘনকের চিত্র', dataUrl: sampleDataUrl },
  ]);

  assert.ok(!replaced.includes('[[DIAGRAM_1]]'));
  assert.ok(replaced.includes(`![৯৯ নং ঘনকের চিত্র](${sampleDataUrl})`));

  const parsed = parseExamDocumentForDisplay(replaced);
  assert.equal(parsed.isExam, true);
  const imgItem = parsed.bodyItems.find((b) => b.kind === 'image');
  assert.ok(imgItem && imgItem.kind === 'image');
  assert.equal(imgItem.alt, '৯৯ নং ঘনকের চিত্র');
});

test('buildFigureMarkdownSnippet + insertBlockSnippetIntoText embeds cropped Q94/Q99 figure cleanly for parser & Word export', async () => {
  // Valid minimal 1x1 transparent PNG data URL
  const sampleDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const figureLine = buildFigureMarkdownSnippet(sampleDataUrl, '৯৪ নং ত্রিভুজের চিত্র');
  assert.equal(figureLine, `![৯৪ নং ত্রিভুজের চিত্র](${sampleDataUrl})`);

  const existingQuestion = [
    '৯৪. নিচের ছবিতে মোট কয়টি ত্রিভুজ (Triangle) আছে?',
    '    ক. ১০',
    '    খ. ৭',
    '    গ. ৫',
    '    ঘ. ৯',
    'উত্তর: ক',
  ].join('\n');

  const insertPos = existingQuestion.indexOf('\n    ক. ১০');
  const { nextText } = insertBlockSnippetIntoText(
    existingQuestion,
    figureLine,
    insertPos,
    insertPos
  );

  const parsed = parseExamDocumentForDisplay(nextText);
  assert.equal(parsed.isExam, true);
  const imgItem = parsed.bodyItems.find((b) => b.kind === 'image');
  assert.ok(imgItem && imgItem.kind === 'image');
  assert.equal(imgItem.alt, '৯৪ নং ত্রিভুজের চিত্র');
  assert.equal(imgItem.src, sampleDataUrl);

  // Verify Word (.docx) export succeeds with embedded cropped figure in 2-column mode
  const unit = buildOcrStudioExportUnit(nextText, 'OCR Studio টেস্ট');
  const docxBytes = await buildStructuredExamDocxBytes([unit], {
    bookTitle: 'OCR Studio টেস্ট',
    numberingStyle: 'original',
    includeHeader: true,
    includeSolutions: true,
    layoutColumns: 2,
    justifyText: true,
  });
  assert.ok(docxBytes.byteLength > 2000);
  assert.equal(docxBytes[0], 0x50); // 'P'
  assert.equal(docxBytes[1], 0x4b); // 'K' (ZIP / DOCX magic)
});

test('mergeOcrStudioSections normalizes and repairs broken LaTeX & tables from OCR API response', () => {
  const merged = mergeOcrStudioSections([
    {
      pageNumber: 1,
      content:
        '৪৭. ΔABC-এ cosA = rac{4}{5}, cosB = rac{5}{13} নিচের কোনটি সঠিক?\nক. সূক্ষ্মকোণী\nখ. সমকোণী\nউ. ঘ',
    },
    {
      pageNumber: 2,
      content:
        '৯৬. নিচের সংখ্যাছকের গুপ্ত সংখ্যাটি বের করুন? | ৮ | ১ | ৬ || --- | --- | --- || ৩ | ? | ৭ || ৪ | ৯ | ২ |\nক. ২\nখ. ৫\nউ. খ',
    },
  ]);

  assert.ok(merged.includes('\\frac{4}{5}'));
  assert.ok(merged.includes('\\frac{5}{13}'));
  assert.ok(merged.includes('| ৮ | ১ | ৬ |\n| --- | --- | --- |'));
  assert.ok(merged.includes('উত্তর: ঘ'));
  assert.ok(merged.includes('উত্তর: খ'));
});

test('POST /api/ai/ocr-studio recovers from empty/RECITATION Tier 1 response via Tier 2 with diagrams, and reports OCR_CONTENT_FILTERED if all 3 tiers are blocked', async () => {
  const { NextRequest } = await import('next/server');
  const { POST: ocrStudioPost } = await import('../../app/api/ai/ocr-studio/route');
  const { setAiGuardTestOverrides } = await import('./ai-api-guard');
  const { setGeminiClientForTesting, GEMINI_FAST_OCR_MODEL } = await import('./gemini');
  const { InMemorySlidingWindowRateLimitStore } = await import('./rate-limit');

  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  setAiGuardTestOverrides({
    authDeps: {
      verifyIdToken: async () => ({
        uid: 'ocr-studio-test-uid',
        email: 'tester@example.com',
        name: 'Tester',
      }),
      resolveDbUser: async () => ({
        id: 1,
        firebaseUid: 'ocr-studio-test-uid',
        email: 'tester@example.com',
        displayName: 'Tester',
      }),
    },
    rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
  });

  let callCount = 0;
  setGeminiClientForTesting({
    models: {
      generateContent: async (params) => {
        callCount += 1;
        if (String(params.model) !== GEMINI_FAST_OCR_MODEL) {
          // Simulate Tier 1 returning 200 OK with EMPTY text & RECITATION finishReason (exact bug from screenshot!)
          return {
            text: '',
            candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }],
          } as never;
        }
        return {
          text: JSON.stringify({
            content: [
              '৯৬. নিচের সংখ্যাছকের গুপ্ত সংখ্যাটি বের করুন?',
              '| ৮ | ১ | ৬ |',
              '| --- | --- | --- |',
              '| ৩ | ? | ৭ |',
              '| ৪ | ৯ | ২ |',
              'ক. ২',
              'খ. ৫',
              'গ. ৬',
              'ঘ. ৮',
              'উ. খ',
              '',
              '৯৯. প্রদত্ত চিত্রটি ভাঁজ করে একটি ঘনক তৈরি করলে, তিনটি বিন্দু বিশিষ্ট পৃষ্ঠের বিপরীতে কতটি বিন্দু থাকে?',
              '[[DIAGRAM_1]]',
              'ক. ২',
              'খ. ৫',
              'গ. ৪',
              'ঘ. ৬',
              'উ. ঘ',
            ].join('\n'),
            diagrams: [
              {
                id: 'DIAGRAM_1',
                label: '৯৯ নং ঘনকের চিত্র',
                box_2d: [220, 710, 575, 815],
              },
            ],
          }),
        } as never;
      },
    },
  });

  try {
    // 1. Valid PNG recovers cleanly from Tier 1 empty/RECITATION into Tier 2 with both table & diagram box_2d
    const req = new NextRequest('http://localhost:3000/api/ai/ocr-studio', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        imageBase64: pngBase64,
        mimeType: 'image/png',
        fileName: 'screenshot-test.png',
        fallbackChapter: 'OCR Studio',
      }),
    });

    const res = await ocrStudioPost(req);
    assert.equal(res.status, 200);
    assert.equal(callCount, 2);
    assert.match(res.headers.get('content-type') || '', /application\/json/i);
    const json = (await res.json()) as {
      ok: boolean;
      model: string;
      text: string;
      diagrams: Array<{ id: string; label: string; box_2d: number[] }>;
      sections: Array<{ content: string }>;
    };
    assert.equal(json.ok, true);
    assert.equal(json.model, GEMINI_FAST_OCR_MODEL);
    assert.ok(json.text.includes('| ৮ | ১ | ৬ |'));
    assert.ok(json.text.includes('উত্তর: খ'));
    assert.ok(json.text.includes('[[DIAGRAM_1]]'));
    assert.equal(json.diagrams.length, 1);
    assert.equal(json.diagrams[0].label, '৯৯ নং ঘনকের চিত্র');
    assert.equal(json.sections.length, 1);

    // 2. When ALL 3 tiers are blocked by RECITATION, return truthful OCR_CONTENT_FILTERED instead of claiming no text exists
    let blockedCalls = 0;
    setGeminiClientForTesting({
      models: {
        generateContent: async () => {
          blockedCalls += 1;
          return {
            text: '',
            candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }],
          } as never;
        },
      },
    });
    const blockedReq = new NextRequest('http://localhost:3000/api/ai/ocr-studio', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        imageBase64: pngBase64,
        mimeType: 'image/png',
      }),
    });
    const blockedRes = await ocrStudioPost(blockedReq);
    assert.equal(blockedRes.status, 422);
    assert.equal(blockedCalls, 3);
    const blockedJson = (await blockedRes.json()) as { code: string; error: string };
    assert.equal(blockedJson.code, 'OCR_CONTENT_FILTERED');

    // 3. Non-image/corrupted payload is rejected cleanly with JSON 400
    const badReq = new NextRequest('http://localhost:3000/api/ai/ocr-studio', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        imageBase64: Buffer.from('not-a-real-png').toString('base64'),
        mimeType: 'image/png',
      }),
    });
    const badRes = await ocrStudioPost(badReq);
    assert.equal(badRes.status, 400);
    const badJson = (await badRes.json()) as { code: string; error: string };
    assert.equal(badJson.code, 'INVALID_FILE_SIGNATURE');
  } finally {
    setGeminiClientForTesting(null);
    setAiGuardTestOverrides(null);
  }
});
