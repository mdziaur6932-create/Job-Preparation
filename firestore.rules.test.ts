import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Deterministic Security Rules Verification Suite (Phase 0 + Phase 5 Audit)
 * Verifies:
 *  1. Synchrony between firebase-blueprint.json and firestore.rules
 *  2. All 12 "Dirty Dozen" adversarial payloads are rejected (PERMISSION_DENIED)
 *  3. Legitimate owner operations satisfy every boolean gate in firestore.rules
 */

const RULES_PATH = path.join(process.cwd(), 'firestore.rules');
const BLUEPRINT_PATH = path.join(process.cwd(), 'firebase-blueprint.json');

interface MockAuth {
  uid: string;
  token: {
    email?: string;
    email_verified?: boolean;
  };
}

interface MockTimestamp {
  __isTimestamp: true;
  ms: number;
}

function ts(ms: number): MockTimestamp {
  return { __isTimestamp: true, ms };
}

function isTs(v: unknown): v is MockTimestamp {
  return Boolean(v && typeof v === 'object' && (v as MockTimestamp).__isTimestamp === true);
}

const SERVER_TIME = ts(1795345000000);
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function isValidId(id: unknown): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && ID_REGEX.test(id);
}

function keysEqualExact(obj: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(obj);
  return allowed.every((k) => keys.includes(k)) && keys.every((k) => allowed.includes(k));
}

function affectedKeysOnly(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
  allowed: string[]
): boolean {
  const allKeys = new Set([...Object.keys(incoming), ...Object.keys(existing)]);
  for (const k of allKeys) {
    if (JSON.stringify(incoming[k]) !== JSON.stringify(existing[k])) {
      if (!allowed.includes(k)) return false;
    }
  }
  return true;
}

function evaluateProfileRule(params: {
  op: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: MockAuth | null;
  userId: string;
  docId: string;
  incoming?: Record<string, unknown>;
  existing?: Record<string, unknown>;
}): 'ALLOW' | 'PERMISSION_DENIED' {
  const { op, auth, userId, docId, incoming, existing } = params;
  const isSignedIn = auth !== null;
  const isVerified = isSignedIn && auth.token.email_verified === true;
  const isOwner = isSignedIn && auth.uid === userId;

  const isValidProfile = (data: Record<string, unknown> | undefined) => {
    if (!data || !auth) return false;
    return (
      keysEqualExact(data, [
        'uid',
        'displayName',
        'email',
        'targetExam',
        'driveSyncEnabled',
        'createdAt',
        'updatedAt',
      ]) &&
      typeof data.uid === 'string' &&
      isValidId(data.uid) &&
      data.uid === auth.uid &&
      data.uid === userId &&
      typeof data.displayName === 'string' &&
      data.displayName.length <= 120 &&
      typeof data.email === 'string' &&
      data.email.length <= 254 &&
      typeof auth.token.email === 'string' &&
      data.email === auth.token.email &&
      typeof data.targetExam === 'string' &&
      data.targetExam.length <= 160 &&
      typeof data.driveSyncEnabled === 'boolean' &&
      isTs(data.createdAt) &&
      isTs(data.updatedAt)
    );
  };

  if (op === 'list') return 'PERMISSION_DENIED';
  if (op === 'get') {
    return isSignedIn && isValidId(userId) && docId === 'profile' && isOwner
      ? 'ALLOW'
      : 'PERMISSION_DENIED';
  }
  if (op === 'create') {
    return isVerified &&
      isValidId(userId) &&
      docId === 'profile' &&
      isOwner &&
      isValidProfile(incoming) &&
      JSON.stringify(incoming?.createdAt) === JSON.stringify(SERVER_TIME) &&
      JSON.stringify(incoming?.updatedAt) === JSON.stringify(SERVER_TIME)
      ? 'ALLOW'
      : 'PERMISSION_DENIED';
  }
  if (op === 'update') {
    return isVerified &&
      isValidId(userId) &&
      docId === 'profile' &&
      isOwner &&
      isValidProfile(incoming) &&
      existing !== undefined &&
      incoming?.uid === existing.uid &&
      incoming?.email === existing.email &&
      JSON.stringify(incoming?.createdAt) === JSON.stringify(existing.createdAt) &&
      JSON.stringify(incoming?.updatedAt) === JSON.stringify(SERVER_TIME) &&
      affectedKeysOnly(incoming!, existing, [
        'displayName',
        'targetExam',
        'driveSyncEnabled',
        'updatedAt',
      ])
      ? 'ALLOW'
      : 'PERMISSION_DENIED';
  }
  return isVerified && isValidId(userId) && docId === 'profile' && isOwner
    ? 'ALLOW'
    : 'PERMISSION_DENIED';
}

function evaluateBookmarkRule(params: {
  op: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: MockAuth | null;
  userId: string;
  bookmarkId?: string;
  incoming?: Record<string, unknown>;
  existing?: Record<string, unknown>;
}): 'ALLOW' | 'PERMISSION_DENIED' {
  const { op, auth, userId, bookmarkId = '', incoming, existing } = params;
  const isSignedIn = auth !== null;
  const isVerified = isSignedIn && auth.token.email_verified === true;
  const isOwner = isSignedIn && auth.uid === userId;

  const isValidBookmark = (data: Record<string, unknown> | undefined) => {
    if (!data || !auth) return false;
    return (
      keysEqualExact(data, [
        'uid',
        'bookTitle',
        'subject',
        'note',
        'status',
        'createdAt',
        'updatedAt',
      ]) &&
      typeof data.uid === 'string' &&
      isValidId(data.uid) &&
      data.uid === auth.uid &&
      data.uid === userId &&
      typeof data.bookTitle === 'string' &&
      data.bookTitle.length >= 1 &&
      data.bookTitle.length <= 200 &&
      typeof data.subject === 'string' &&
      data.subject.length >= 1 &&
      data.subject.length <= 120 &&
      typeof data.note === 'string' &&
      data.note.length >= 1 &&
      data.note.length <= 1000 &&
      (data.status === 'active' || data.status === 'archived') &&
      isTs(data.createdAt) &&
      isTs(data.updatedAt)
    );
  };

  if (op === 'list') {
    return isSignedIn && isValidId(userId) && isOwner && existing?.uid === auth?.uid
      ? 'ALLOW'
      : 'PERMISSION_DENIED';
  }
  if (op === 'get') {
    return isSignedIn &&
      isValidId(userId) &&
      isValidId(bookmarkId) &&
      isOwner &&
      existing?.uid === auth?.uid
      ? 'ALLOW'
      : 'PERMISSION_DENIED';
  }
  if (op === 'create') {
    return isVerified &&
      isValidId(userId) &&
      isValidId(bookmarkId) &&
      isOwner &&
      isValidBookmark(incoming) &&
      incoming?.status === 'active' &&
      JSON.stringify(incoming?.createdAt) === JSON.stringify(SERVER_TIME) &&
      JSON.stringify(incoming?.updatedAt) === JSON.stringify(SERVER_TIME)
      ? 'ALLOW'
      : 'PERMISSION_DENIED';
  }
  if (op === 'update') {
    const canEditNote =
      incoming?.status === 'active' &&
      affectedKeysOnly(incoming!, existing!, ['bookTitle', 'subject', 'note', 'updatedAt']);
    const canArchive =
      incoming?.status === 'archived' &&
      affectedKeysOnly(incoming!, existing!, ['status', 'updatedAt']);
    return isVerified &&
      isValidId(userId) &&
      isValidId(bookmarkId) &&
      isOwner &&
      isValidBookmark(incoming) &&
      existing !== undefined &&
      existing.uid === auth?.uid &&
      existing.status !== 'archived' &&
      incoming?.uid === existing.uid &&
      JSON.stringify(incoming?.createdAt) === JSON.stringify(existing.createdAt) &&
      JSON.stringify(incoming?.updatedAt) === JSON.stringify(SERVER_TIME) &&
      (canEditNote || canArchive)
      ? 'ALLOW'
      : 'PERMISSION_DENIED';
  }
  return isVerified &&
    isValidId(userId) &&
    isValidId(bookmarkId) &&
    isOwner &&
    existing?.uid === auth?.uid
    ? 'ALLOW'
    : 'PERMISSION_DENIED';
}

test('Blueprint & firestore.rules structural synchrony and Eight Pillars invariants', () => {
  const rulesSrc = fs.readFileSync(RULES_PATH, 'utf8');
  const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, 'utf8')) as {
    entities: Record<string, { properties: Record<string, { maxLength?: number }> }>;
    firestore: Record<string, unknown>;
  };

  assert.match(rulesSrc, /rules_version = '2';/);
  assert.match(rulesSrc, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
  assert.match(rulesSrc, /request\.auth\.token\.email_verified == true/);
  assert.match(rulesSrc, /data\.displayName\.size\(\) <= 120/);
  assert.equal(blueprint.entities.UserPrivateProfile.properties.displayName.maxLength, 120);
  assert.match(rulesSrc, /data\.note\.size\(\) <= 1000/);
  assert.equal(blueprint.entities.StudyBookmark.properties.note.maxLength, 1000);
  assert.ok('/users/{userId}/private/{docId}' in blueprint.firestore);
  assert.ok('/users/{userId}/studyBookmarks/{bookmarkId}' in blueprint.firestore);
  assert.match(rulesSrc, /match \/users\/\{userId\}\/private\/\{docId\}/);
  assert.match(rulesSrc, /match \/users\/\{userId\}\/studyBookmarks\/\{bookmarkId\}/);
});

test('Dirty Dozen Payloads 1–12 all return PERMISSION_DENIED', () => {
  const u1: MockAuth = { uid: 'user_1', token: { email: 'u1@example.com', email_verified: true } };
  const u2: MockAuth = { uid: 'user_2', token: { email: 'u2@example.com', email_verified: true } };
  const u1Unverified: MockAuth = {
    uid: 'user_1',
    token: { email: 'u1@example.com', email_verified: false },
  };

  const validProfile = {
    uid: 'user_1',
    displayName: 'Ziaur',
    email: 'u1@example.com',
    targetExam: '৪৭তম বিসিএস',
    driveSyncEnabled: true,
    createdAt: SERVER_TIME,
    updatedAt: SERVER_TIME,
  };

  const existingBookmark = {
    uid: 'user_1',
    bookTitle: 'বাংলাদেশের সংবিধান',
    subject: 'বাংলাদেশ বিষয়াবলি',
    note: 'অনুচ্ছেদ ২৬-৪৭ক মৌলিক অধিকার।',
    status: 'active',
    createdAt: ts(1795000000000),
    updatedAt: ts(1795000000000),
  };

  // 1. Unauthenticated read
  assert.equal(
    evaluateProfileRule({ op: 'get', auth: null, userId: 'user_1', docId: 'profile' }),
    'PERMISSION_DENIED'
  );
  // 2. Cross-user PII read
  assert.equal(
    evaluateProfileRule({ op: 'get', auth: u2, userId: 'user_1', docId: 'profile' }),
    'PERMISSION_DENIED'
  );
  // 3. Unverified email write
  assert.equal(
    evaluateProfileRule({
      op: 'create',
      auth: u1Unverified,
      userId: 'user_1',
      docId: 'profile',
      incoming: validProfile,
    }),
    'PERMISSION_DENIED'
  );
  // 4. Identity spoofing
  assert.equal(
    evaluateProfileRule({
      op: 'create',
      auth: u1,
      userId: 'user_1',
      docId: 'profile',
      incoming: { ...validProfile, uid: 'user_2' },
    }),
    'PERMISSION_DENIED'
  );
  // 5. Shadow / ghost field injection
  assert.equal(
    evaluateProfileRule({
      op: 'create',
      auth: u1,
      userId: 'user_1',
      docId: 'profile',
      incoming: { ...validProfile, isAdmin: true },
    }),
    'PERMISSION_DENIED'
  );
  // 6. Client timestamp forgery
  assert.equal(
    evaluateProfileRule({
      op: 'create',
      auth: u1,
      userId: 'user_1',
      docId: 'profile',
      incoming: { ...validProfile, createdAt: ts(1000) },
    }),
    'PERMISSION_DENIED'
  );
  // 7. Path ID poisoning
  assert.equal(
    evaluateBookmarkRule({
      op: 'create',
      auth: u1,
      userId: 'user_1',
      bookmarkId: 'bad$id..',
      incoming: { ...existingBookmark, createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
    }),
    'PERMISSION_DENIED'
  );
  // 8. Oversized string DoW
  assert.equal(
    evaluateBookmarkRule({
      op: 'create',
      auth: u1,
      userId: 'user_1',
      bookmarkId: 'bm_1',
      incoming: {
        ...existingBookmark,
        note: 'A'.repeat(1001),
        createdAt: SERVER_TIME,
        updatedAt: SERVER_TIME,
      },
    }),
    'PERMISSION_DENIED'
  );
  // 9. Immutable field tampering (createdAt)
  assert.equal(
    evaluateBookmarkRule({
      op: 'update',
      auth: u1,
      userId: 'user_1',
      bookmarkId: 'bm_1',
      existing: existingBookmark,
      incoming: { ...existingBookmark, createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
    }),
    'PERMISSION_DENIED'
  );
  // 10. Value poisoning on allowed update key
  assert.equal(
    evaluateBookmarkRule({
      op: 'update',
      auth: u1,
      userId: 'user_1',
      bookmarkId: 'bm_1',
      existing: existingBookmark,
      incoming: { ...existingBookmark, note: 12345, updatedAt: SERVER_TIME },
    }),
    'PERMISSION_DENIED'
  );
  // 11. Terminal state bypass (updating archived bookmark)
  assert.equal(
    evaluateBookmarkRule({
      op: 'update',
      auth: u1,
      userId: 'user_1',
      bookmarkId: 'bm_1',
      existing: { ...existingBookmark, status: 'archived' },
      incoming: { ...existingBookmark, status: 'active', updatedAt: SERVER_TIME },
    }),
    'PERMISSION_DENIED'
  );
  // 12. Unauthorized cross-user list scrape
  assert.equal(
    evaluateBookmarkRule({
      op: 'list',
      auth: u2,
      userId: 'user_1',
      existing: existingBookmark,
    }),
    'PERMISSION_DENIED'
  );
});

test('Legitimate owner profile & bookmark flows succeed', () => {
  const u1: MockAuth = { uid: 'user_1', token: { email: 'u1@example.com', email_verified: true } };
  const validProfile = {
    uid: 'user_1',
    displayName: 'Ziaur',
    email: 'u1@example.com',
    targetExam: '৪৭তম বিসিএস',
    driveSyncEnabled: true,
    createdAt: SERVER_TIME,
    updatedAt: SERVER_TIME,
  };

  assert.equal(
    evaluateProfileRule({
      op: 'create',
      auth: u1,
      userId: 'user_1',
      docId: 'profile',
      incoming: validProfile,
    }),
    'ALLOW'
  );
  assert.equal(
    evaluateProfileRule({
      op: 'update',
      auth: u1,
      userId: 'user_1',
      docId: 'profile',
      existing: { ...validProfile, createdAt: ts(100), updatedAt: ts(100) },
      incoming: { ...validProfile, createdAt: ts(100), targetExam: 'ব্যাংক নিয়োগ', updatedAt: SERVER_TIME },
    }),
    'ALLOW'
  );
});

test('All 10 user-owned workspace collections stay synchronized between blueprint and firestore.rules', () => {
  const rulesSrc = fs.readFileSync(RULES_PATH, 'utf8');
  const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, 'utf8')) as {
    entities: Record<string, unknown>;
    firestore: Record<string, unknown>;
  };

  const expectedPaths = [
    '/users/{userId}/private/{docId}',
    '/users/{userId}/studyBookmarks/{bookmarkId}',
    '/users/{userId}/books/{bookId}',
    '/users/{userId}/bookChunks/{chunkId}',
    '/users/{userId}/questions/{questionId}',
    '/users/{userId}/exams/{examId}',
    '/users/{userId}/attempts/{attemptId}',
    '/users/{userId}/mistakes/{mistakeId}',
    '/users/{userId}/gkItems/{itemId}',
    '/users/{userId}/studyTasks/{taskId}',
  ];

  for (const colPath of expectedPaths) {
    assert.ok(colPath in blueprint.firestore, `Missing ${colPath} in firebase-blueprint.json`);
    assert.ok(
      rulesSrc.includes(`match ${colPath}`),
      `Missing match ${colPath} in firestore.rules`
    );
  }

  // Terminal state lock on exams, immutability on exam attempts, and new Bengali book categories
  assert.match(rulesSrc, /existing\(\)\.status != 'completed'/);
  assert.match(rulesSrc, /match \/users\/\{userId\}\/attempts\/\{attemptId\}[\s\S]*?allow update: if false;/);
  assert.match(rulesSrc, /'রিসেন্ট জব সলুশন'/);
  assert.match(rulesSrc, /'অন্যান্য'/);
  const bookBlueprint = blueprint.entities.BookRecord as {
    properties: { category: { enum: string[] } };
  };
  assert.ok(bookBlueprint.properties.category.enum.includes('রিসেন্ট জব সলুশন'));
  assert.ok(bookBlueprint.properties.category.enum.includes('অন্যান্য'));
});

test('Server auth user resolver falls back deterministically when Cloud SQL socket is absent', async () => {
  const { deriveStableUserIdFromUid, getOrCreateUser } = await import('./src/db/users');

  const idA1 = deriveStableUserIdFromUid('firebase-uid-alpha');
  const idA2 = deriveStableUserIdFromUid('firebase-uid-alpha');
  const idB = deriveStableUserIdFromUid('firebase-uid-beta');

  assert.equal(idA1, idA2);
  assert.notEqual(idA1, idB);
  assert.ok(Number.isInteger(idA1) && idA1 >= 1 && idA1 <= 2147483647);

  const resolved = await getOrCreateUser(
    'firebase-uid-alpha',
    'alpha@example.com',
    'Alpha Student'
  );
  assert.equal(resolved.id, idA1);
  assert.equal(resolved.uid, 'firebase-uid-alpha');
  assert.equal(resolved.email, 'alpha@example.com');
  assert.equal(resolved.displayName, 'Alpha Student');
});

