import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFLINE_SCOPE_GUEST,
  classifyServiceWorkerRequest,
  collectWarmableAssetUrls,
  formatOfflineBytes,
  resolveOfflineScopeKey,
  summarizeOfflineStudyMaterials,
} from './offline-cache-policy';
import { createInitialSeedData } from './seed-data';

test('resolveOfflineScopeKey isolates guest vs authenticated user UIDs cleanly', () => {
  assert.equal(resolveOfflineScopeKey(null), OFFLINE_SCOPE_GUEST);
  assert.equal(resolveOfflineScopeKey(undefined), OFFLINE_SCOPE_GUEST);
  assert.equal(resolveOfflineScopeKey('   '), OFFLINE_SCOPE_GUEST);
  assert.equal(resolveOfflineScopeKey('uid_abc_123'), 'user:uid_abc_123');
});

test('classifyServiceWorkerRequest routes navigation, assets, PDFs, fonts, and bypasses API/auth/writes', () => {
  const origin = 'http://localhost:3000';

  assert.equal(
    classifyServiceWorkerRequest({
      url: 'http://localhost:3000/',
      origin,
      method: 'GET',
      mode: 'navigate',
    }),
    'navigation'
  );

  assert.equal(
    classifyServiceWorkerRequest({
      url: 'http://localhost:3000/_next/static/chunks/main-app.js',
      origin,
      method: 'GET',
    }),
    'asset'
  );

  assert.equal(
    classifyServiceWorkerRequest({
      url: 'http://localhost:3000/manifest.webmanifest',
      origin,
      method: 'GET',
    }),
    'asset'
  );

  assert.equal(
    classifyServiceWorkerRequest({
      url: 'http://localhost:3000/assets/aistudio/sample-exam.pdf',
      origin,
      method: 'GET',
    }),
    'pdf'
  );

  assert.equal(
    classifyServiceWorkerRequest({
      url: 'https://fonts.gstatic.com/s/hindsiliguri/v12/abc.woff2',
      origin,
      method: 'GET',
    }),
    'font'
  );

  // Strict bypasses: API routes, POST requests, sw.js, Firestore & Google Auth
  assert.equal(
    classifyServiceWorkerRequest({
      url: 'http://localhost:3000/api/ai/questions',
      origin,
      method: 'POST',
    }),
    'bypass'
  );
  assert.equal(
    classifyServiceWorkerRequest({
      url: 'http://localhost:3000/api/workspace',
      origin,
      method: 'GET',
    }),
    'bypass'
  );
  assert.equal(
    classifyServiceWorkerRequest({
      url: 'http://localhost:3000/sw.js',
      origin,
      method: 'GET',
    }),
    'bypass'
  );
  assert.equal(
    classifyServiceWorkerRequest({
      url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel',
      origin,
      method: 'GET',
    }),
    'bypass'
  );
  assert.equal(
    classifyServiceWorkerRequest({
      url: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
      origin,
      method: 'GET',
    }),
    'bypass'
  );
});

test('collectWarmableAssetUrls deduplicates and filters strictly to cacheable static/font URLs', () => {
  const origin = 'http://localhost:3000';
  const urls = collectWarmableAssetUrls(
    [
      '/_next/static/chunks/app/page.js',
      '/_next/static/chunks/app/page.js',
      '/_next/static/css/app.css',
      'https://fonts.googleapis.com/css2?family=Hind+Siliguri',
      'http://localhost:3000/api/ai/evaluate',
      'https://firestore.googleapis.com/v1/projects/foo',
      '/sw.js',
    ],
    origin
  );

  assert.ok(urls.includes('/'));
  assert.ok(urls.includes('http://localhost:3000/_next/static/chunks/app/page.js'));
  assert.ok(urls.includes('http://localhost:3000/_next/static/css/app.css'));
  assert.ok(
    urls.includes('https://fonts.googleapis.com/css2?family=Hind+Siliguri')
  );
  assert.equal(
    urls.some((u) => u.includes('/api/') || u.includes('firestore') || u.endsWith('/sw.js')),
    false
  );
});

test('summarizeOfflineStudyMaterials & formatOfflineBytes compute accurate counts and human sizes', () => {
  const seed = createInitialSeedData();
  const summary = summarizeOfflineStudyMaterials(seed);

  assert.equal(summary.booksCount, seed.books.length);
  assert.ok(summary.chunksCount >= 10);
  assert.equal(summary.questionsCount, seed.questions.length);
  assert.equal(summary.examsCount, seed.exams.length);
  assert.ok(summary.estimatedTextBytes > 1024);

  assert.equal(formatOfflineBytes(0), '0 KB');
  assert.equal(formatOfflineBytes(512), '512 B');
  assert.equal(formatOfflineBytes(2048), '2.0 KB');
  assert.equal(formatOfflineBytes(2.5 * 1024 * 1024), '2.50 MB');
});
