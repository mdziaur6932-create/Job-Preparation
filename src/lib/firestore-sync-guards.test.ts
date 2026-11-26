import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideWorkspaceLoadAction,
  isFirestoreOfflineOrUnavailableError,
  shouldCreatePrivateProfile,
} from './firestore-sync-guards';

test('shouldCreatePrivateProfile blocks creation when snapshot is from offline cache', () => {
  assert.equal(
    shouldCreatePrivateProfile({
      exists: false,
      fromCache: true,
      emailVerified: true,
      email: 'user@example.com',
      createAttempted: false,
    }),
    false
  );
});

test('shouldCreatePrivateProfile blocks creation when profile already exists or already attempted', () => {
  assert.equal(
    shouldCreatePrivateProfile({
      exists: true,
      fromCache: false,
      emailVerified: true,
      email: 'user@example.com',
      createAttempted: false,
    }),
    false
  );

  assert.equal(
    shouldCreatePrivateProfile({
      exists: false,
      fromCache: false,
      emailVerified: true,
      email: 'user@example.com',
      createAttempted: true,
    }),
    false
  );
});

test('shouldCreatePrivateProfile allows creation only on authoritative empty server snapshot for verified user', () => {
  assert.equal(
    shouldCreatePrivateProfile({
      exists: false,
      fromCache: false,
      emailVerified: true,
      email: 'user@example.com',
      createAttempted: false,
    }),
    true
  );

  assert.equal(
    shouldCreatePrivateProfile({
      exists: false,
      fromCache: false,
      emailVerified: false,
      email: 'user@example.com',
      createAttempted: false,
    }),
    false
  );
});

test('decideWorkspaceLoadAction refuses to seed when empty results came from offline cache', () => {
  const action = decideWorkspaceLoadAction({
    emailVerified: true,
    collections: [
      { docsCount: 0, fromCache: true },
      { docsCount: 0, fromCache: true },
      { docsCount: 0, fromCache: true },
      { docsCount: 0, fromCache: true },
      { docsCount: 0, fromCache: true },
      { docsCount: 0, fromCache: true },
      { docsCount: 0, fromCache: true },
      { docsCount: 0, fromCache: true },
    ],
  });
  assert.equal(action, 'offline_empty');
});

test('decideWorkspaceLoadAction hydrates whenever any collection has docs (even from cache)', () => {
  const action = decideWorkspaceLoadAction({
    emailVerified: true,
    collections: [
      { docsCount: 2, fromCache: true },
      { docsCount: 0, fromCache: true },
      { docsCount: 0, fromCache: true },
    ],
  });
  assert.equal(action, 'hydrate');
});

test('decideWorkspaceLoadAction seeds ONLY when all collections are confirmed empty from server for verified user', () => {
  const verifiedEmpty = decideWorkspaceLoadAction({
    emailVerified: true,
    collections: [
      { docsCount: 0, fromCache: false },
      { docsCount: 0, fromCache: false },
      { docsCount: 0, fromCache: false },
    ],
  });
  assert.equal(verifiedEmpty, 'seed');

  const unverifiedEmpty = decideWorkspaceLoadAction({
    emailVerified: false,
    collections: [
      { docsCount: 0, fromCache: false },
      { docsCount: 0, fromCache: false },
    ],
  });
  assert.equal(unverifiedEmpty, 'hydrate');
});

test('isFirestoreOfflineOrUnavailableError distinguishes offline errors from permission errors', () => {
  assert.equal(
    isFirestoreOfflineOrUnavailableError(
      new Error('Failed to get document because the client is offline.')
    ),
    true
  );
  assert.equal(
    isFirestoreOfflineOrUnavailableError({ code: 'unavailable', message: 'Backend timeout' }),
    true
  );
  assert.equal(
    isFirestoreOfflineOrUnavailableError(
      new Error('Missing or insufficient permissions.')
    ),
    false
  );
});
