import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createInitialSeedData } from './seed-data';
import {
  GUEST_WORKSPACE_STORAGE_KEY,
  applyCloudOptimisticEditState,
  applyCloudWorkspaceState,
  applyGuestEditState,
  applyResolvedGuestState,
  beginSignInTransitionState,
  beginSignOutTransitionState,
  cancelSignInTransitionState,
  cancelSignOutTransitionState,
  createInitialWorkspaceLifecycleState,
  enterAuthenticatedState,
  isValidWorkspaceData,
  persistGuestWorkspaceIfAllowed,
  readGuestWorkspace,
  resolveGuestWorkspace,
  saveGuestWorkspace,
  shouldPersistGuestWorkspace,
  transitionToGuestState,
  type StorageLike,
  type WorkspaceLifecycleState,
} from './guest-workspace-storage';
import type { Book, StudyTask, WorkspaceData } from '../types/system';

class MemoryStorage implements StorageLike {
  private readonly store = new Map<string, string>();
  public writeCount = 0;
  public readCount = 0;

  getItem(key: string): string | null {
    this.readCount += 1;
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  setItem(key: string, value: string): void {
    this.writeCount += 1;
    this.store.set(key, value);
  }

  raw(key: string = GUEST_WORKSPACE_STORAGE_KEY): string | null {
    return this.store.get(key) ?? null;
  }

  seedRaw(value: string, key: string = GUEST_WORKSPACE_STORAGE_KEY): void {
    this.store.set(key, value);
  }
}

function makeCustomGuestBook(id: number, title: string): Book {
  return {
    id,
    title,
    author: 'Guest Author',
    subject: 'বাংলাদেশ বিষয়াবলি',
    category: 'BCS',
    totalPages: 240,
    extractionMethod: 'manual',
    ocrCompleted: false,
    createdAt: '2026-05-01',
    chunks: [],
  };
}

function makeCustomStudyTask(id: number, title: string): StudyTask {
  return {
    id,
    title,
    subject: 'আন্তর্জাতিক বিষয়াবলি',
    chapter: 'অধ্যায় ১',
    taskType: 'revision',
    scheduledDate: '2026-05-02',
    durationMinutes: 45,
    completed: false,
    createdAt: '2026-05-01',
  };
}

function makeCloudWorkspace(tag: string): WorkspaceData {
  return {
    books: [
      {
        id: 9001,
        title: `Cloud Book (${tag})`,
        author: 'Cloud Author',
        subject: 'গণিত',
        category: 'Bank',
        totalPages: 500,
        extractionMethod: 'text',
        ocrCompleted: true,
        createdAt: '2026-05-01',
        chunks: [],
      },
    ],
    questions: [],
    exams: [],
    attempts: [],
    mistakes: [],
    gkItems: [],
    studyTasks: [
      {
        id: 9701,
        title: `Cloud Task (${tag})`,
        subject: 'গণিত',
        chapter: 'জ্যামিতি',
        taskType: 'practice',
        scheduledDate: '2026-05-03',
        durationMinutes: 60,
        completed: true,
        createdAt: '2026-05-01',
      },
    ],
  };
}

/**
 * Mirrors WorkspaceProvider's persistence useEffect: runs after every state update.
 */
function runPersistenceEffect(
  state: WorkspaceLifecycleState,
  isAuthenticated: boolean,
  storage: StorageLike
): boolean {
  return persistGuestWorkspaceIfAllowed(state, isAuthenticated, storage);
}

test('Scenario 1: Guest edits data -> saved in LocalStorage', () => {
  const storage = new MemoryStorage();
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);

  // Before auth resolves, nothing is persisted
  assert.equal(runPersistenceEffect(state, false, storage), false);
  assert.equal(storage.writeCount, 0);

  // Initial unauthenticated load hydrates Guest Mode
  state = transitionToGuestState(state, storage, createInitialSeedData);
  assert.equal(state.phase, 'guest');
  assert.equal(state.owner, 'guest');
  assert.equal(state.lastGuestRestoreSource, 'seed');
  assert.equal(runPersistenceEffect(state, false, storage), false);

  // Guest adds a custom book and study task
  const guestBook = makeCustomGuestBook(555, 'আমার নিজস্ব বিসিএস নোটবুক');
  const guestTask = makeCustomStudyTask(888, 'সংবিধান অনুচ্ছেদ ১-৪৭ রিভিশন');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [guestBook, ...prev.books],
    studyTasks: [guestTask, ...prev.studyTasks],
  }));

  assert.equal(runPersistenceEffect(state, false, storage), true);
  assert.equal(storage.writeCount, 1);

  const stored = readGuestWorkspace(storage);
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.data.books[0]?.id, 555);
    assert.equal(stored.data.books[0]?.title, 'আমার নিজস্ব বিসিএস নোটবুক');
    assert.equal(stored.data.studyTasks[0]?.id, 888);
  }
});

test('Scenario 2 & 3: Guest signs in and cloud data loads -> Guest LocalStorage remains preserved and untouched', () => {
  const storage = new MemoryStorage();
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);
  state = transitionToGuestState(state, storage, createInitialSeedData);

  // Guest makes an edit
  const guestBook = makeCustomGuestBook(556, 'গেস্ট নোট - সাইন-ইন পূর্ববর্তী');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [guestBook, ...prev.books],
  }));
  assert.equal(runPersistenceEffect(state, false, storage), true);
  const rawBeforeSignIn = storage.raw();
  const writesBeforeSignIn = storage.writeCount;
  assert.ok(rawBeforeSignIn);

  // Guest initiates sign-in
  state = beginSignInTransitionState(state, storage);
  assert.equal(state.phase, 'signing_in');
  assert.equal(runPersistenceEffect(state, false, storage), false);

  // Firebase Auth resolves with authenticated user
  state = enterAuthenticatedState(state, storage);
  assert.equal(state.phase, 'authenticated');
  assert.equal(runPersistenceEffect(state, true, storage), false);

  // Cloud workspace loads into React state
  const cloudData = makeCloudWorkspace('primary-cloud');
  state = applyCloudWorkspaceState(state, cloudData, state.sessionSeq);
  assert.equal(state.owner, 'cloud');
  assert.equal(state.data.books[0]?.id, 9001);
  assert.equal(runPersistenceEffect(state, true, storage), false);

  // LocalStorage must remain byte-for-byte identical to pre-sign-in Guest data
  assert.equal(storage.raw(), rawBeforeSignIn);
  assert.equal(storage.writeCount, writesBeforeSignIn);
});

test('Scenario 2b: Rapid Guest edit followed immediately by Sign-In flushes dirty edit before auth transition', () => {
  const storage = new MemoryStorage();
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);
  state = transitionToGuestState(state, storage, createInitialSeedData);

  // Guest edits, and Sign-In is invoked BEFORE persistence effect even fires
  const rapidBook = makeCustomGuestBook(557, 'র‍্যাপিড গেস্ট এডিট');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [rapidBook, ...prev.books],
  }));
  assert.equal(storage.writeCount, 0);

  state = beginSignInTransitionState(state, storage);
  assert.equal(storage.writeCount, 1);

  const stored = readGuestWorkspace(storage);
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.data.books[0]?.id, 557);
  }
});

test('Scenario 4: User signs out -> original Guest data is restored (never overwritten by seed or cloud)', () => {
  const storage = new MemoryStorage();
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);
  state = transitionToGuestState(state, storage, createInitialSeedData);

  // Guest edits and persists
  const guestBook = makeCustomGuestBook(558, 'গেস্টের সংরক্ষিত বই');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [guestBook, ...prev.books],
  }));
  runPersistenceEffect(state, false, storage);
  const savedGuestRaw = storage.raw();
  const writesAfterGuestEdit = storage.writeCount;

  // Sign in + load cloud workspace
  state = beginSignInTransitionState(state, storage);
  state = enterAuthenticatedState(state, storage);
  state = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('signed-in-cloud'),
    state.sessionSeq
  );
  assert.equal(state.data.books[0]?.title, 'Cloud Book (signed-in-cloud)');

  // Begin sign-out BEFORE auth signOut resolves
  state = beginSignOutTransitionState(state);
  assert.equal(state.phase, 'signing_out');
  // Even if persistence effect runs while user=null during signing_out, cloud data MUST NOT be written
  assert.equal(runPersistenceEffect(state, false, storage), false);
  assert.equal(storage.raw(), savedGuestRaw);

  // Complete sign-out -> restore Guest workspace
  state = transitionToGuestState(state, storage, createInitialSeedData);
  assert.equal(state.phase, 'guest');
  assert.equal(state.owner, 'guest');
  assert.equal(state.lastGuestRestoreSource, 'storage');
  assert.equal(state.data.books[0]?.id, 558);
  assert.equal(state.data.books[0]?.title, 'গেস্টের সংরক্ষিত বই');

  // Persistence effect right after restore must NOT overwrite LocalStorage
  assert.equal(runPersistenceEffect(state, false, storage), false);
  assert.equal(storage.writeCount, writesAfterGuestEdit);
  assert.equal(storage.raw(), savedGuestRaw);
});

test('Scenario 5: No previous Guest data exists -> valid seed data is initialized on Guest load and sign-out', () => {
  const storage = new MemoryStorage();
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);

  // Cold start directly authenticated (no Guest LocalStorage data at all)
  state = enterAuthenticatedState(state, storage);
  state = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('first-login-cloud'),
    state.sessionSeq
  );
  assert.equal(storage.raw(), null);

  // User signs out with empty Guest LocalStorage
  state = beginSignOutTransitionState(state);
  state = transitionToGuestState(state, storage, createInitialSeedData);

  assert.equal(state.phase, 'guest');
  assert.equal(state.owner, 'guest');
  assert.equal(state.lastGuestRestoreSource, 'seed');
  assert.equal(isValidWorkspaceData(state.data), true);
  assert.ok(state.data.books.length > 0);
  // Seed initialization itself does not pollute storage until guest edits
  assert.equal(runPersistenceEffect(state, false, storage), false);
  assert.equal(storage.writeCount, 0);
});

test('Scenario 6: Guest reloads application -> previously saved Guest data is restored', () => {
  const storage = new MemoryStorage();

  // Session 1: Guest edits and persists
  let session1 = createInitialWorkspaceLifecycleState(createInitialSeedData);
  session1 = transitionToGuestState(session1, storage, createInitialSeedData);
  const reloadedBook = makeCustomGuestBook(559, 'রিলোডের পর টিকে থাকা বই');
  session1 = applyGuestEditState(session1, (prev) => ({
    ...prev,
    books: [reloadedBook, ...prev.books],
  }));
  assert.equal(runPersistenceEffect(session1, false, storage), true);

  // Session 2: Fresh app boot (empty in-memory state, same LocalStorage)
  let session2 = createInitialWorkspaceLifecycleState(createInitialSeedData);
  session2 = transitionToGuestState(session2, storage, createInitialSeedData);

  assert.equal(session2.phase, 'guest');
  assert.equal(session2.owner, 'guest');
  assert.equal(session2.lastGuestRestoreSource, 'storage');
  assert.equal(session2.data.books[0]?.id, 559);
  assert.equal(session2.data.books[0]?.title, 'রিলোডের পর টিকে থাকা বই');
});

test('Scenario 7: Multiple sign-in / sign-out cycles -> Guest data remains unchanged and subsequent edits persist', () => {
  const storage = new MemoryStorage();
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);
  state = transitionToGuestState(state, storage, createInitialSeedData);

  // Initial Guest edit
  const guestBook1 = makeCustomGuestBook(560, 'সাইকেল-১ গেস্ট বই');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [guestBook1, ...prev.books],
  }));
  runPersistenceEffect(state, false, storage);
  const snapshotAfterEdit1 = storage.raw();

  // Run 3 full sign-in -> cloud load -> sign-out cycles without Guest edits
  for (let cycle = 1; cycle <= 3; cycle++) {
    state = beginSignInTransitionState(state, storage);
    state = enterAuthenticatedState(state, storage);
    state = applyCloudWorkspaceState(
      state,
      makeCloudWorkspace(`cycle-${cycle}`),
      state.sessionSeq
    );
    assert.equal(state.data.books[0]?.title, `Cloud Book (cycle-${cycle})`);
    assert.equal(storage.raw(), snapshotAfterEdit1);

    state = beginSignOutTransitionState(state);
    state = transitionToGuestState(state, storage, createInitialSeedData);
    assert.equal(state.data.books[0]?.id, 560);
    assert.equal(state.data.books[0]?.title, 'সাইকেল-১ গেস্ট বই');
    assert.equal(runPersistenceEffect(state, false, storage), false);
    assert.equal(storage.raw(), snapshotAfterEdit1);
  }

  // Guest makes a second edit after cycle 3, then signs in and signs out again
  const guestBook2 = makeCustomGuestBook(561, 'সাইকেল-৪ নতুন গেস্ট বই');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [guestBook2, ...prev.books],
  }));
  assert.equal(runPersistenceEffect(state, false, storage), true);

  state = beginSignInTransitionState(state, storage);
  state = enterAuthenticatedState(state, storage);
  state = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('cycle-4'),
    state.sessionSeq
  );
  state = beginSignOutTransitionState(state);
  state = transitionToGuestState(state, storage, createInitialSeedData);

  assert.equal(state.data.books[0]?.id, 561);
  assert.equal(state.data.books[1]?.id, 560);
});

test('Scenario 8: Cloud workspace mutations (sync + optimistic edits) -> Guest LocalStorage remains strictly isolated', () => {
  const storage = new MemoryStorage();
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);
  state = transitionToGuestState(state, storage, createInitialSeedData);

  const guestTask = makeCustomStudyTask(890, 'গেস্ট স্টাডি প্ল্যান');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    studyTasks: [guestTask, ...prev.studyTasks],
  }));
  runPersistenceEffect(state, false, storage);
  const rawGuestBeforeCloud = storage.raw();
  const writesBeforeCloud = storage.writeCount;

  // Sign in and perform multiple cloud updates + optimistic exam/GK updates
  state = beginSignInTransitionState(state, storage);
  state = enterAuthenticatedState(state, storage);
  state = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('initial'),
    state.sessionSeq
  );
  assert.equal(runPersistenceEffect(state, true, storage), false);

  state = applyCloudOptimisticEditState(state, (prev) => ({
    ...prev,
    studyTasks: [
      makeCustomStudyTask(9999, 'ক্লাউড অপটিমিস্টিক টাস্ক'),
      ...prev.studyTasks,
    ],
  }));
  assert.equal(state.owner, 'cloud');
  assert.equal(state.guestDirty, false);
  assert.equal(runPersistenceEffect(state, true, storage), false);

  state = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('after-cloud-mutation'),
    state.sessionSeq
  );
  assert.equal(runPersistenceEffect(state, true, storage), false);

  // Even if applyGuestEditState is mistakenly called while authenticated, it refuses to mutate or mark dirty
  const attemptedLeak = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [],
  }));
  assert.equal(attemptedLeak, state);
  assert.equal(runPersistenceEffect(attemptedLeak, false, storage), false);

  // Guest storage untouched
  assert.equal(storage.raw(), rawGuestBeforeCloud);
  assert.equal(storage.writeCount, writesBeforeCloud);
});

test('Scenario 9: Auth transition races -> zero seed or cloud overwrite under out-of-order callbacks and stale fetches', () => {
  const storage = new MemoryStorage();
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);
  state = transitionToGuestState(state, storage, createInitialSeedData);

  const guestBook = makeCustomGuestBook(562, 'রেস-কন্ডিশন সুরক্ষিত গেস্ট বই');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [guestBook, ...prev.books],
  }));
  runPersistenceEffect(state, false, storage);
  const guestRaw = storage.raw();
  const writesBeforeRaces = storage.writeCount;

  // 9a: Sign-in popup cancelled -> cleanly returns to guest without altering storage
  state = beginSignInTransitionState(state, storage);
  assert.equal(state.phase, 'signing_in');
  state = cancelSignInTransitionState(state);
  assert.equal(state.phase, 'guest');
  assert.equal(state.data.books[0]?.id, 562);
  assert.equal(storage.writeCount, writesBeforeRaces);

  // 9b: User signs in, cloud fetch starts with seq=N, user signs out BEFORE cloud fetch resolves
  state = beginSignInTransitionState(state, storage);
  state = enterAuthenticatedState(state, storage);
  const staleCloudSeq = state.sessionSeq;

  // User signs out while cloud fetch is still in flight
  state = beginSignOutTransitionState(state);
  state = transitionToGuestState(state, storage, createInitialSeedData);
  assert.equal(state.phase, 'guest');
  assert.equal(state.data.books[0]?.id, 562);

  // Late in-flight cloud response arrives with staleCloudSeq -> MUST be ignored
  const afterStaleCloud = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('late-stale-response'),
    staleCloudSeq
  );
  assert.equal(afterStaleCloud, state);
  assert.equal(afterStaleCloud.owner, 'guest');
  assert.equal(afterStaleCloud.data.books[0]?.id, 562);
  assert.equal(storage.raw(), guestRaw);

  // 9c: External sign-out / token revocation directly from authenticated cloud state
  state = enterAuthenticatedState(state, storage);
  state = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('active-before-revoke'),
    state.sessionSeq
  );
  // Suppose React transiently renders user=null BEFORE transitionToGuestState runs:
  assert.equal(
    shouldPersistGuestWorkspace({
      phase: state.phase,
      isAuthenticated: false,
      owner: state.owner,
      guestDirty: state.guestDirty,
    }),
    false
  );
  assert.equal(runPersistenceEffect(state, false, storage), false);

  // Then external sign-out restores Guest workspace
  state = transitionToGuestState(state, storage, createInitialSeedData);
  assert.equal(state.data.books[0]?.id, 562);
  assert.equal(storage.raw(), guestRaw);
  assert.equal(storage.writeCount, writesBeforeRaces);

  // 9d: Failed sign-out recovers cleanly to authenticated without touching Guest storage
  state = enterAuthenticatedState(state, storage);
  state = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('still-signed-in'),
    state.sessionSeq
  );
  state = beginSignOutTransitionState(state);
  state = cancelSignOutTransitionState(state);
  assert.equal(state.phase, 'authenticated');
  assert.equal(state.owner, 'cloud');
  assert.equal(storage.raw(), guestRaw);
});

test('Scenario 10: Malformed LocalStorage data and storage exceptions -> safe fallback without crash', () => {
  const malformedPayloads = [
    '{invalid-json',
    'null',
    '12345',
    '"just-a-string"',
    '[]',
    JSON.stringify({ books: [] }), // Missing attempts, questions, exams, mistakes, gkItems, studyTasks
    JSON.stringify({
      books: 'not-an-array',
      questions: [],
      exams: [],
      attempts: [],
      mistakes: [],
      gkItems: [],
      studyTasks: [],
    }),
  ];

  for (const payload of malformedPayloads) {
    const storage = new MemoryStorage();
    storage.seedRaw(payload);

    const readResult = readGuestWorkspace(storage);
    assert.equal(readResult.ok, false);
    if (!readResult.ok) {
      assert.equal(readResult.reason, 'malformed');
    }

    const resolved = resolveGuestWorkspace(storage, createInitialSeedData);
    assert.equal(resolved.source, 'seed');
    assert.equal(isValidWorkspaceData(resolved.data), true);
    assert.ok(resolved.data.books.length > 0);
    assert.ok(Array.isArray(resolved.data.attempts));

    let state = createInitialWorkspaceLifecycleState(createInitialSeedData);
    state = applyResolvedGuestState(state, resolved, 1);
    assert.equal(state.phase, 'guest');
    assert.equal(state.owner, 'guest');
    assert.equal(state.guestDirty, false);
  }

  // Storage throwing SecurityError / QuotaExceededError never crashes
  const throwingStorage: StorageLike = {
    getItem() {
      throw new Error('SecurityError: storage denied');
    },
    setItem() {
      throw new Error('QuotaExceededError: storage full');
    },
  };

  const readErr = readGuestWorkspace(throwingStorage);
  assert.deepEqual(readErr, { ok: false, reason: 'storage_error' });
  assert.equal(saveGuestWorkspace(throwingStorage, createInitialSeedData()), false);

  // If guest edited in memory while storage throws QuotaExceededError, in-memory snapshot still survives sign-in/sign-out
  let state = createInitialWorkspaceLifecycleState(createInitialSeedData);
  state = transitionToGuestState(state, throwingStorage, createInitialSeedData);
  const snapshotBook = makeCustomGuestBook(563, 'ইন-মেমরি স্ন্যাপশট বই');
  state = applyGuestEditState(state, (prev) => ({
    ...prev,
    books: [snapshotBook, ...prev.books],
  }));
  state = beginSignInTransitionState(state, throwingStorage);
  state = enterAuthenticatedState(state, throwingStorage);
  state = applyCloudWorkspaceState(
    state,
    makeCloudWorkspace('cloud-with-broken-storage'),
    state.sessionSeq
  );
  state = beginSignOutTransitionState(state);
  state = transitionToGuestState(state, throwingStorage, createInitialSeedData);

  assert.equal(state.lastGuestRestoreSource, 'snapshot');
  assert.equal(state.data.books[0]?.id, 563);
  assert.equal(state.data.books[0]?.title, 'ইন-মেমরি স্ন্যাপশট বই');
});

test('Static Regression Guard: WorkspaceProvider uses lifecycle isolation and never resets signOutUser to seed data', () => {
  const providerPath = path.resolve(
    process.cwd(),
    'src/components/WorkspaceProvider.tsx'
  );
  const source = fs.readFileSync(providerPath, 'utf8');

  assert.match(source, /from ['"]@\/src\/lib\/guest-workspace-storage['"]/);
  assert.match(source, /persistGuestWorkspaceIfAllowed/);
  assert.match(source, /beginSignOutTransitionState/);
  assert.match(source, /resolveGuestWorkspace/);
  assert.doesNotMatch(source, /hydratedLocalRef/);
  assert.doesNotMatch(source, /setData\s*\(\s*createInitialSeedData\s*\(\s*\)\s*\)/);
});
