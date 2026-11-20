import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateContentResponse } from '@google/genai';
import {
  AiConfigError,
  AiInvalidRequestError,
  AiResponseParseError,
  AiTimeoutError,
  GEMINI_MODEL,
  classifyAiError,
  extractRetryDelayMs,
  extractUpstreamStatus,
  generateWithRetry,
  parseAiJson,
  stripMarkdownCodeFences,
} from './gemini';
import {
  detectBinaryMimeFromMagicBytes,
  validateUploadedDocument,
} from './file-validation';

test('default Gemini model remains gemini-4-hydrogen', () => {
  assert.equal(GEMINI_MODEL, 'gemini-4-hydrogen');
});

test('detectBinaryMimeFromMagicBytes recognizes PDF, PNG, JPEG, and WebP', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  const unknown = new TextEncoder().encode('<html>not a pdf</html>');

  assert.equal(detectBinaryMimeFromMagicBytes(pdf), 'application/pdf');
  assert.equal(detectBinaryMimeFromMagicBytes(png), 'image/png');
  assert.equal(detectBinaryMimeFromMagicBytes(jpg), 'image/jpeg');
  assert.equal(detectBinaryMimeFromMagicBytes(webp), 'image/webp');
  assert.equal(detectBinaryMimeFromMagicBytes(unknown), null);
});

test('validateUploadedDocument accepts valid PDF, images, and UTF-8 text/md', () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  const pdfRes = validateUploadedDocument('notes.pdf', 'application/pdf', pdfBytes);
  assert.equal(pdfRes.ok, true);
  if (pdfRes.ok) {
    assert.equal(pdfRes.kind, 'binary');
    assert.equal(pdfRes.mimeType, 'application/pdf');
  }

  const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const jpgRes = validateUploadedDocument('scan.jpg', 'image/jpg', jpgBytes);
  assert.equal(jpgRes.ok, true);
  if (jpgRes.ok) {
    assert.equal(jpgRes.kind, 'binary');
    assert.equal(jpgRes.mimeType, 'image/jpeg');
  }

  const txtBytes = new TextEncoder().encode('বাংলাদেশের সংবিধান ১৯৭২ সালে প্রণীত হয়।');
  const txtRes = validateUploadedDocument('chapter1.txt', 'text/plain', txtBytes);
  assert.equal(txtRes.ok, true);
  if (txtRes.ok) {
    assert.equal(txtRes.kind, 'text');
    assert.equal(txtRes.mimeType, 'text/plain');
  }

  const mdRes = validateUploadedDocument('summary.md', '', txtBytes);
  assert.equal(mdRes.ok, true);
  if (mdRes.ok) {
    assert.equal(mdRes.kind, 'text');
    assert.equal(mdRes.mimeType, 'text/markdown');
  }
});

test('validateUploadedDocument rejects disguised PDFs, mismatched types, binary .txt, empty and oversized files', () => {
  const fakePdfBytes = new TextEncoder().encode('This is plain text pretending to be PDF');
  const fakePdf = validateUploadedDocument('fake.pdf', 'application/pdf', fakePdfBytes);
  assert.equal(fakePdf.ok, false);
  if (!fakePdf.ok) assert.equal(fakePdf.code, 'INVALID_FILE_TYPE');

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mismatched = validateUploadedDocument('wrong.pdf', 'application/pdf', pngBytes);
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.code, 'INVALID_FILE_TYPE');

  const exeAsTxt = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
  const badTxt = validateUploadedDocument('payload.txt', 'text/plain', exeAsTxt);
  assert.equal(badTxt.ok, false);
  if (!badTxt.ok) assert.equal(badTxt.code, 'INVALID_FILE_TYPE');

  const empty = validateUploadedDocument('empty.pdf', 'application/pdf', new Uint8Array(0));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, 'EMPTY_FILE');

  const oversized = validateUploadedDocument(
    'big.txt',
    'text/plain',
    new Uint8Array([0x41, 0x42, 0x43, 0x44]),
    2
  );
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, 'FILE_TOO_LARGE');
});

test('stripMarkdownCodeFences and parseAiJson handle fenced JSON and reject malformed output', () => {
  const fenced = '```json\n{"totalPages": 2, "sections": []}\n```';
  assert.equal(stripMarkdownCodeFences(fenced), '{"totalPages": 2, "sections": []}');

  const obj = parseAiJson<{ totalPages: number }>(fenced, 'object');
  assert.equal(obj.totalPages, 2);

  const arr = parseAiJson<number[]>('```\n[1, 2, 3]\n```', 'array');
  assert.deepEqual(arr, [1, 2, 3]);

  assert.throws(() => parseAiJson('', 'object'), AiResponseParseError);
  assert.throws(() => parseAiJson('{broken json', 'object'), AiResponseParseError);
  assert.throws(() => parseAiJson('[]', 'object'), AiResponseParseError);
  assert.throws(() => parseAiJson('{}', 'array'), AiResponseParseError);
});

test('classifyAiError maps upstream errors to sanitized Bengali responses without leaking internals', () => {
  const raw429 = new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"34s"}]}}'
  );
  assert.equal(extractUpstreamStatus(raw429), 429);
  assert.equal(extractRetryDelayMs(raw429), 34_000);

  const c429 = classifyAiError(raw429);
  assert.equal(c429.status, 429);
  assert.equal(c429.code, 'AI_RATE_LIMITED');
  assert.equal(c429.retryable, true);
  assert.equal(c429.retryAfterSeconds, 34);
  assert.equal(c429.error.includes('RESOURCE_EXHAUSTED'), false);
  assert.equal(c429.error.includes('quota'), false);

  const c503 = classifyAiError(new Error('503 UNAVAILABLE: model overloaded'));
  assert.equal(c503.status, 503);
  assert.equal(c503.code, 'AI_UNAVAILABLE');
  assert.equal(c503.error.includes('UNAVAILABLE'), false);

  const cTimeout = classifyAiError(new AiTimeoutError(90_000));
  assert.equal(cTimeout.status, 504);
  assert.equal(cTimeout.code, 'AI_TIMEOUT');

  const cParse = classifyAiError(new AiResponseParseError('bad json'));
  assert.equal(cParse.status, 502);
  assert.equal(cParse.code, 'AI_INVALID_RESPONSE');

  const cConfig = classifyAiError(new AiConfigError('GEMINI_API_KEY missing'));
  assert.equal(cConfig.status, 503);
  assert.equal(cConfig.code, 'AI_CONFIG_ERROR');
  assert.equal(cConfig.error.includes('GEMINI_API_KEY'), false);

  const cBadReq = classifyAiError(new AiInvalidRequestError());
  assert.equal(cBadReq.status, 400);
  assert.equal(cBadReq.code, 'INVALID_REQUEST');

  const cUnknown = classifyAiError(
    new Error('Internal secret postgres://user:pass@host/db crash'),
    'কাস্টম ফ fallback বার্তা।'
  );
  assert.equal(cUnknown.status, 500);
  assert.equal(cUnknown.code, 'AI_INTERNAL_ERROR');
  assert.equal(cUnknown.error, 'কাস্টম ফ fallback বার্তা।');
  assert.equal(cUnknown.error.includes('postgres'), false);
});

test('generateWithRetry retries transient 429/503 errors with bounded backoff and succeeds', async () => {
  let attempts = 0;
  const delays: number[] = [];

  const mockClient = {
    models: {
      generateContent: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('429 RESOURCE_EXHAUSTED retryDelay: "2s"');
        }
        if (attempts === 2) {
          throw new Error('503 UNAVAILABLE');
        }
        return { text: 'সফল উত্তর' } as GenerateContentResponse;
      },
    },
  };

  const res = await generateWithRetry(
    { model: GEMINI_MODEL, contents: 'test' },
    {
      client: mockClient,
      maxRetries: 2,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }
  );

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2000, 1000]);
  assert.equal(res.text, 'সফল উত্তর');
});

test('generateWithRetry does not retry non-retryable 400 errors', async () => {
  let attempts = 0;
  const mockClient = {
    models: {
      generateContent: async () => {
        attempts += 1;
        const err = new Error('400 INVALID_ARGUMENT: bad mime');
        throw err;
      },
    },
  };

  await assert.rejects(
    () =>
      generateWithRetry(
        { model: GEMINI_MODEL, contents: 'test' },
        {
          client: mockClient,
          maxRetries: 2,
          sleep: async () => {},
        }
      ),
    /INVALID_ARGUMENT/
  );
  assert.equal(attempts, 1);
});

test('generateWithRetry aborts hanging calls and throws AiTimeoutError', async () => {
  let sawAbortSignal = false;
  const mockClient = {
    models: {
      generateContent: (params: { config?: { abortSignal?: AbortSignal } }) =>
        new Promise<GenerateContentResponse>((_, reject) => {
          params.config?.abortSignal?.addEventListener('abort', () => {
            sawAbortSignal = true;
            reject(new Error('aborted'));
          });
        }),
    },
  };

  await assert.rejects(
    () =>
      generateWithRetry(
        { model: GEMINI_MODEL, contents: 'slow' },
        {
          client: mockClient,
          maxRetries: 0,
          timeoutMs: 30,
        }
      ),
    AiTimeoutError
  );
  assert.equal(sawAbortSignal, true);
});

test('generateWithRetry uses fallbackModel only when explicitly configured', async () => {
  const calledModels: string[] = [];
  const mockClient = {
    models: {
      generateContent: async (params: { model: string }) => {
        calledModels.push(params.model);
        if (params.model === GEMINI_MODEL) {
          throw new Error('503 UNAVAILABLE');
        }
        return { text: 'fallback ok' } as GenerateContentResponse;
      },
    },
  };

  const res = await generateWithRetry(
    { model: GEMINI_MODEL, contents: 'test' },
    {
      client: mockClient,
      maxRetries: 1,
      fallbackModel: 'gemini-3.1-flash-lite',
      sleep: async () => {},
    }
  );

  assert.deepEqual(calledModels, [
    'gemini-4-hydrogen',
    'gemini-4-hydrogen',
    'gemini-3.1-flash-lite',
  ]);
  assert.equal(res.text, 'fallback ok');
});

test('generateWithRetry fails fast when upstream 429 retryDelay exceeds maxDelayMs', async () => {
  let attempts = 0;
  let sleepCalls = 0;

  const mockClient = {
    models: {
      generateContent: async () => {
        attempts += 1;
        throw new Error('429 RESOURCE_EXHAUSTED retryDelay: "68429s"');
      },
    },
  };

  await assert.rejects(
    () =>
      generateWithRetry(
        { model: GEMINI_MODEL, contents: 'test' },
        {
          client: mockClient,
          maxRetries: 2,
          maxDelayMs: 10_000,
          sleep: async () => {
            sleepCalls += 1;
          },
        }
      ),
    /RESOURCE_EXHAUSTED/
  );

  assert.equal(attempts, 1);
  assert.equal(sleepCalls, 0);
});
