import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AUTH_INITIALIZING_WAIT_MESSAGE,
  AUTH_TOKEN_REFRESH_ERROR_MESSAGE,
  applySignInFailureUiState,
  applySignInSuccessUiState,
  formatFirebaseSignInError,
  isAuthStateResolving,
  resolveCurrentAuthenticatedUser,
  retrieveAiAuthHeaders,
  shouldDeferAiSignInPrompt,
  type FirebaseAuthUserLike,
  type FrontendAuthStatus,
} from './frontend-auth';
import {
  GUEST_WORKSPACE_STORAGE_KEY,
  applyCloudOptimisticEditState,
  applyCloudWorkspaceState,
  applyGuestEditState,
  applyResolvedGuestState,
  beginSignInTransitionState,
  beginSignOutTransitionState,
  cancelSignInTransitionState,
  createInitialWorkspaceLifecycleState,
  enterAuthenticatedState,
  persistGuestWorkspaceIfAllowed,
  resolveGuestWorkspace,
  type StorageLike,
} from './guest-workspace-storage';
import { createInitialSeedData } from './seed-data';
import type { WorkspaceData } from '@/src/types/system';

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function createMockUser(
  uid: string,
  tokenImpl: (forceRefresh?: boolean) => Promise<string>
): FirebaseAuthUserLike {
  return {
    uid,
    email: `${uid}@example.com`,
    displayName: `User ${uid}`,
    getIdToken: tokenImpl,
  };
}

function createCustomWorkspace(markerTitle: string): WorkspaceData {
  const seed = createInitialSeedData();
  return {
    ...seed,
    books: [
      {
        ...seed.books[0],
        id: 901,
        title: markerTitle,
      },
    ],
  };
}

/**
 * Lightweight state-machine harness mirroring WorkspaceProvider's sign-in and
 * modal synchronization flow so we can deterministically test popup resolution,
 * same-account re-authentication without onAuthStateChanged re-firing, and
 * failure handling without needing a live Google OAuth popup.
 */
function createAuthControllerHarness(initial: {
  authStatus: FrontendAuthStatus;
  user: FirebaseAuthUserLike | null;
  currentAuthUser: FirebaseAuthUserLike | null;
  aiAuthPrompt: { featureName: string; message: string } | null;
  phase?: 'hydrating' | 'guest' | 'signing_in' | 'authenticated' | 'signing_out';
}) {
  let authStatus: FrontendAuthStatus = initial.authStatus;
  let user: FirebaseAuthUserLike | null = initial.user;
  let currentAuthUser: FirebaseAuthUserLike | null = initial.currentAuthUser;
  let aiAuthPrompt = initial.aiAuthPrompt;
  let authError: string | null = null;
  let phase = initial.phase ?? (initial.user ? 'authenticated' : 'guest');
  let workspaceFetchCount = 0;
  let tokenRefreshCount = 0;
  let lastSyncedUid: string | null = initial.user?.uid ?? null;

  return {
    getState: () => ({
      authStatus,
      user,
      currentAuthUser,
      aiAuthPrompt,
      authError,
      phase,
      workspaceFetchCount,
      tokenRefreshCount,
    }),
    requestAiSignIn(featureName: string) {
      if (shouldDeferAiSignInPrompt(authStatus)) {
        return false;
      }
      aiAuthPrompt = {
        featureName,
        message: 'AI ফিচার ব্যবহার করতে Google দিয়ে সাইন-ইন করুন।',
      };
      return true;
    },
    async signInWithGoogle(
      signInPopupFn: () => Promise<{ user: FirebaseAuthUserLike | null }>,
      options?: { fireAuthStateChanged?: boolean }
    ) {
      authError = null;
      const wasAuthenticated = phase === 'authenticated';
      authStatus = 'signing_in';
      phase = 'signing_in';

      try {
        const credential = await signInPopupFn();
        const signedInUser = credential.user ?? currentAuthUser;
        if (!signedInUser) {
          throw new Error('Google sign-in completed without an active user.');
        }

        currentAuthUser = signedInUser;

        if (options?.fireAuthStateChanged) {
          phase = 'authenticated';
          lastSyncedUid = signedInUser.uid;
          workspaceFetchCount += 1;
        }

        const nextUi = applySignInSuccessUiState();
        user = signedInUser;
        authStatus = nextUi.authStatus;
        authError = nextUi.authError;
        aiAuthPrompt = nextUi.aiAuthPrompt;

        if (phase !== 'authenticated') {
          phase = 'authenticated';
          const needsWorkspaceFetch =
            !wasAuthenticated || lastSyncedUid !== signedInUser.uid;
          lastSyncedUid = signedInUser.uid;
          if (needsWorkspaceFetch) {
            workspaceFetchCount += 1;
          } else {
            await signedInUser.getIdToken(true);
            tokenRefreshCount += 1;
          }
        }
      } catch (err) {
        if (!currentAuthUser && phase === 'signing_in') {
          phase = 'guest';
        } else if (currentAuthUser && phase === 'signing_in') {
          phase = 'authenticated';
        }
        const nextUi = applySignInFailureUiState({
          error: err,
          currentPrompt: aiAuthPrompt,
          hasExistingAuthenticatedUser: Boolean(currentAuthUser),
        });
        authStatus = nextUi.authStatus;
        authError = nextUi.authError;
        aiAuthPrompt = nextUi.aiAuthPrompt;
      }
    },
  };
}

// 1. Initial Firebase loading does not show Guest sign-in modal
test('1. Initial Firebase loading (initializing) defers Guest sign-in modal and auth header returns initializing', async () => {
  assert.equal(isAuthStateResolving('initializing'), true);
  assert.equal(shouldDeferAiSignInPrompt('initializing'), true);
  assert.equal(shouldDeferAiSignInPrompt('signing_in'), true);
  assert.equal(shouldDeferAiSignInPrompt('guest'), false);
  assert.equal(shouldDeferAiSignInPrompt('error'), false);

  const harness = createAuthControllerHarness({
    authStatus: 'initializing',
    user: null,
    currentAuthUser: null,
    aiAuthPrompt: null,
    phase: 'hydrating',
  });

  const opened = harness.requestAiSignIn('PDF আপলোড ও AI OCR');
  assert.equal(opened, false);
  assert.equal(harness.getState().aiAuthPrompt, null);

  const tokenResult = await retrieveAiAuthHeaders({
    currentAuthUser: null,
    reactUser: null,
    authStatus: 'initializing',
  });
  assert.equal(tokenResult.ok, false);
  if (!tokenResult.ok) {
    assert.equal(tokenResult.reason, 'initializing');
    assert.equal(tokenResult.message, AUTH_INITIALIZING_WAIT_MESSAGE);
  }
});

// 2. Successful Google Sign-In updates authenticated state
test('2. Successful Google Sign-In updates authenticated state and clears prior auth errors', async () => {
  const signedInUser = createMockUser('uid-success-1', async () => 'valid-jwt-token');
  const harness = createAuthControllerHarness({
    authStatus: 'guest',
    user: null,
    currentAuthUser: null,
    aiAuthPrompt: {
      featureName: 'PDF আপলোড ও AI OCR',
      message: 'সাইন-ইন প্রয়োজন',
    },
    phase: 'guest',
  });

  await harness.signInWithGoogle(
    async () => ({ user: signedInUser }),
    { fireAuthStateChanged: true }
  );

  const state = harness.getState();
  assert.equal(state.authStatus, 'authenticated');
  assert.equal(state.user?.uid, 'uid-success-1');
  assert.equal(state.phase, 'authenticated');
  assert.equal(state.authError, null);
  assert.equal(state.workspaceFetchCount, 1);
});

// 3. Successful Sign-In closes the modal
test('3. Successful Google Sign-In explicitly closes the Sign-In Required modal', async () => {
  const nextUi = applySignInSuccessUiState();
  assert.equal(nextUi.aiAuthPrompt, null);
  assert.equal(nextUi.authStatus, 'authenticated');
  assert.equal(nextUi.authError, null);

  const signedInUser = createMockUser('uid-modal-close', async () => 'fresh-token');
  const harness = createAuthControllerHarness({
    authStatus: 'guest',
    user: null,
    currentAuthUser: null,
    aiAuthPrompt: {
      featureName: 'PDF আপলোড ও AI OCR',
      message: 'সাইন-ইন করুন',
    },
  });

  await harness.signInWithGoogle(async () => ({ user: signedInUser }), {
    fireAuthStateChanged: true,
  });

  assert.equal(harness.getState().aiAuthPrompt, null);
  assert.equal(harness.getState().authStatus, 'authenticated');
});

// 4. Repeated Sign-In with the same Google account does not get stuck in stale UI state
test('4. Repeated Sign-In with same Google account closes modal and recovers phase even when onAuthStateChanged does not re-fire', async () => {
  let refreshCalls = 0;
  const sameUser = createMockUser('uid-same-account', async (forceRefresh) => {
    if (forceRefresh) refreshCalls += 1;
    return 'refreshed-id-token';
  });

  const harness = createAuthControllerHarness({
    authStatus: 'authenticated',
    user: sameUser,
    currentAuthUser: sameUser,
    aiAuthPrompt: {
      featureName: 'PDF আপলোড ও AI OCR',
      message: 'পুনরায় সাইন-ইন প্রয়োজন',
    },
    phase: 'authenticated',
  });

  // Simulate Firebase popup resolving with the SAME account without re-firing onAuthStateChanged
  await harness.signInWithGoogle(async () => ({ user: sameUser }), {
    fireAuthStateChanged: false,
  });

  const state = harness.getState();
  assert.equal(state.authStatus, 'authenticated');
  assert.equal(state.phase, 'authenticated');
  assert.equal(state.aiAuthPrompt, null);
  assert.equal(state.authError, null);
  assert.equal(state.workspaceFetchCount, 0);
  assert.equal(refreshCalls, 1);
  assert.equal(state.tokenRefreshCount, 1);
});

// 5. Failed popup authentication displays a sanitized Bengali error and keeps modal open
test('5. Failed popup authentication displays sanitized Bengali error without stack trace and keeps modal open', async () => {
  const prompt = {
    featureName: 'PDF আপলোড ও AI OCR',
    message: 'Google দিয়ে সাইন-ইন করুন',
  };
  const rawInternalError = new Error(
    'Internal SDK failure token=eyJhbGciOiJSUzI1NiJ9 at /app/internal/auth.ts:99'
  );

  const harness = createAuthControllerHarness({
    authStatus: 'guest',
    user: null,
    currentAuthUser: null,
    aiAuthPrompt: prompt,
    phase: 'guest',
  });

  await harness.signInWithGoogle(async () => {
    throw rawInternalError;
  });

  const state = harness.getState();
  assert.equal(state.authStatus, 'error');
  assert.equal(state.phase, 'guest');
  assert.deepEqual(state.aiAuthPrompt, prompt);
  assert.ok(state.authError && state.authError.length > 10);
  assert.doesNotMatch(state.authError, /eyJhbGciOi|\/app\/internal|Internal SDK/i);
});

// 6. auth/popup-blocked error is handled cleanly
test('6. auth/popup-blocked error returns clear Bengali guidance and keeps modal open', () => {
  const err = Object.assign(new Error('Firebase: Error (auth/popup-blocked).'), {
    code: 'auth/popup-blocked',
  });
  const formatted = formatFirebaseSignInError(err);
  assert.equal(formatted.category, 'popup_blocked');
  assert.equal(formatted.code, 'auth/popup-blocked');
  assert.match(formatted.message, /পপ-আপ ব্লক/);

  const prompt = { featureName: 'PDF আপলোড ও AI OCR', message: 'সাইন-ইন প্রয়োজন' };
  const nextUi = applySignInFailureUiState({
    error: err,
    currentPrompt: prompt,
    hasExistingAuthenticatedUser: false,
  });
  assert.equal(nextUi.authStatus, 'error');
  assert.deepEqual(nextUi.aiAuthPrompt, prompt);
  assert.equal(nextUi.authError, formatted.message);
});

// 7. auth/popup-closed-by-user is handled without falsely reporting success
test('7. auth/popup-closed-by-user and auth/cancelled-popup-request never falsely report success', async () => {
  for (const code of ['auth/popup-closed-by-user', 'auth/cancelled-popup-request']) {
    const err = Object.assign(new Error(`Firebase: Error (${code}).`), { code });
    const formatted = formatFirebaseSignInError(err);
    assert.equal(formatted.category, 'popup_closed');
    assert.match(formatted.message, /বন্ধ হয়ে গেছে/);

    const prompt = { featureName: 'PDF আপলোড ও AI OCR', message: 'সাইন-ইন করুন' };
    const harness = createAuthControllerHarness({
      authStatus: 'guest',
      user: null,
      currentAuthUser: null,
      aiAuthPrompt: prompt,
      phase: 'guest',
    });

    await harness.signInWithGoogle(async () => {
      throw err;
    });

    const state = harness.getState();
    assert.notEqual(state.authStatus, 'authenticated');
    assert.equal(state.authStatus, 'error');
    assert.equal(state.user, null);
    assert.deepEqual(state.aiAuthPrompt, prompt);
    assert.equal(state.authError, formatted.message);
  }
});

// 8. auth/unauthorized-domain error is clearly reported (plus network failure & message-only code fallback)
test('8. auth/unauthorized-domain and auth/network-request-failed errors are clearly reported in Bengali', () => {
  const domainErr = new Error('Firebase: Error (auth/unauthorized-domain).');
  const domainFormatted = formatFirebaseSignInError(domainErr);
  assert.equal(domainFormatted.category, 'unauthorized_domain');
  assert.equal(domainFormatted.code, 'auth/unauthorized-domain');
  assert.match(domainFormatted.message, /Authorized Domains|অনুমোদিত নয়/);

  const networkErr = Object.assign(new Error('Network error'), {
    code: 'auth/network-request-failed',
  });
  const networkFormatted = formatFirebaseSignInError(networkErr);
  assert.equal(networkFormatted.category, 'network_error');
  assert.match(networkFormatted.message, /নেটওয়ার্ক/);
});

// 9. Authenticated user receives a valid Authorization: Bearer <token> header
test('9. Authenticated user receives valid Authorization: Bearer <token> header and supports forceRefresh', async () => {
  let receivedForceRefresh: boolean | undefined;
  const authUser = createMockUser('uid-bearer-1', async (forceRefresh) => {
    receivedForceRefresh = forceRefresh;
    return '  mock-firebase-id-token-123  ';
  });

  const result = await retrieveAiAuthHeaders({
    currentAuthUser: authUser,
    reactUser: authUser,
    authStatus: 'authenticated',
    forceRefresh: true,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.token, 'mock-firebase-id-token-123');
    assert.deepEqual(result.headers, {
      Authorization: 'Bearer mock-firebase-id-token-123',
    });
  }
  assert.equal(receivedForceRefresh, true);
});

// 10. Guest user receives no Bearer header
test('10. Guest user receives no Bearer header and returns reason unauthenticated', async () => {
  const result = await retrieveAiAuthHeaders({
    currentAuthUser: null,
    reactUser: null,
    authStatus: 'guest',
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'unauthenticated');
    assert.equal('headers' in result, false);
  }
});

// 11. Token retrieval uses the current Firebase user
test('11. Token retrieval prefers live auth.currentUser over lagging React state and respects signing_out', async () => {
  const staleReactUser = createMockUser('uid-stale', async () => 'stale-token');
  const liveAuthUser = createMockUser('uid-live', async () => 'live-current-user-token');

  // Even if React state is still null or stale immediately after signInWithPopup, auth.currentUser wins
  const resolved = resolveCurrentAuthenticatedUser({
    currentAuthUser: liveAuthUser,
    reactUser: null,
    authStatus: 'authenticated',
  });
  assert.equal(resolved?.uid, 'uid-live');

  const headerFromLive = await retrieveAiAuthHeaders({
    currentAuthUser: liveAuthUser,
    reactUser: staleReactUser,
    authStatus: 'authenticated',
  });
  assert.equal(headerFromLive.ok, true);
  if (headerFromLive.ok) {
    assert.equal(headerFromLive.headers.Authorization, 'Bearer live-current-user-token');
  }

  // During active sign-out, must NOT return any user or token
  const signingOutHeader = await retrieveAiAuthHeaders({
    currentAuthUser: liveAuthUser,
    reactUser: liveAuthUser,
    authStatus: 'signing_out',
  });
  assert.equal(signingOutHeader.ok, false);
  if (!signingOutHeader.ok) {
    assert.equal(signingOutHeader.reason, 'unauthenticated');
  }
});

// 12. Token refresh failure does not throw an unhandled exception
test('12. Token refresh failure or empty token returns controlled token_refresh_failed without throwing', async () => {
  const failingUser = createMockUser('uid-token-fail', async () => {
    throw new Error('Firebase: Network error during securetoken.googleapis.com refresh');
  });

  const failedResult = await retrieveAiAuthHeaders({
    currentAuthUser: failingUser,
    reactUser: failingUser,
    authStatus: 'authenticated',
    forceRefresh: true,
  });

  assert.equal(failedResult.ok, false);
  if (!failedResult.ok) {
    assert.equal(failedResult.reason, 'token_refresh_failed');
    assert.equal(failedResult.message, AUTH_TOKEN_REFRESH_ERROR_MESSAGE);
  }

  const emptyTokenUser = createMockUser('uid-empty-token', async () => '   ');
  const emptyResult = await retrieveAiAuthHeaders({
    currentAuthUser: emptyTokenUser,
    reactUser: emptyTokenUser,
    authStatus: 'authenticated',
  });

  assert.equal(emptyResult.ok, false);
  if (!emptyResult.ok) {
    assert.equal(emptyResult.reason, 'token_refresh_failed');
    assert.equal(emptyResult.message, AUTH_TOKEN_REFRESH_ERROR_MESSAGE);
  }
});

// 13. Guest LocalStorage survives sign-in and sign-out
test('13. Guest LocalStorage data survives failed sign-in, successful sign-in, and subsequent sign-out', () => {
  const storage = new MemoryStorage();
  let lifecycle = createInitialWorkspaceLifecycleState(createInitialSeedData);

  // Hydrate initial Guest workspace
  const initialGuest = resolveGuestWorkspace(
    storage,
    createInitialSeedData,
    null,
    GUEST_WORKSPACE_STORAGE_KEY
  );
  lifecycle = applyResolvedGuestState(lifecycle, initialGuest, 1);

  // Guest creates a custom book
  lifecycle = applyGuestEditState(lifecycle, (prev) => ({
    ...prev,
    books: [
      {
        ...prev.books[0],
        id: 777,
        title: 'গেস্ট মোডের সংরক্ষিত বই',
      },
      ...prev.books,
    ],
  }));
  const persistedGuest = persistGuestWorkspaceIfAllowed(
    lifecycle,
    false,
    storage,
    GUEST_WORKSPACE_STORAGE_KEY
  );
  assert.equal(persistedGuest, true);

  // Failed sign-in attempt cancels cleanly without damaging Guest LocalStorage
  lifecycle = beginSignInTransitionState(lifecycle, storage, GUEST_WORKSPACE_STORAGE_KEY);
  lifecycle = cancelSignInTransitionState(lifecycle);
  assert.equal(lifecycle.phase, 'guest');

  // Successful sign-in transitions to authenticated and loads cloud workspace
  lifecycle = beginSignInTransitionState(lifecycle, storage, GUEST_WORKSPACE_STORAGE_KEY);
  lifecycle = enterAuthenticatedState(lifecycle, storage, GUEST_WORKSPACE_STORAGE_KEY, 2);
  const cloudData = createCustomWorkspace('ক্লাউড অ্যাকাউন্টের বই');
  lifecycle = applyCloudWorkspaceState(lifecycle, cloudData, 2);
  assert.equal(lifecycle.data.books[0]?.title, 'ক্লাউড অ্যাকাউন্টের বই');

  // Sign-out restores original Guest LocalStorage data intact
  lifecycle = beginSignOutTransitionState(lifecycle, 3);
  assert.equal(
    persistGuestWorkspaceIfAllowed(lifecycle, false, storage, GUEST_WORKSPACE_STORAGE_KEY),
    false
  );
  const restored = resolveGuestWorkspace(
    storage,
    createInitialSeedData,
    lifecycle.guestSnapshot,
    GUEST_WORKSPACE_STORAGE_KEY
  );
  lifecycle = applyResolvedGuestState(lifecycle, restored, 4);
  assert.equal(lifecycle.data.books[0]?.title, 'গেস্ট মোডের সংরক্ষিত বই');
});

// 14. Cloud Workspace data is NOT written into Guest LocalStorage
test('14. Cloud Workspace data and cloud optimistic edits are never written into Guest LocalStorage', () => {
  const storage = new MemoryStorage();
  const originalGuest = createCustomWorkspace('গেস্টের নিজস্ব নোট');
  storage.setItem(GUEST_WORKSPACE_STORAGE_KEY, JSON.stringify(originalGuest));

  let lifecycle = createInitialWorkspaceLifecycleState(createInitialSeedData);
  lifecycle = enterAuthenticatedState(lifecycle, storage, GUEST_WORKSPACE_STORAGE_KEY, 1);

  const cloudData = createCustomWorkspace('প্রাইভেট ক্লাউড ডকুমেন্ট');
  lifecycle = applyCloudWorkspaceState(lifecycle, cloudData, 1);

  // Even if persistence effect runs while authenticated or during optimistic edit, storage must reject writes
  assert.equal(
    persistGuestWorkspaceIfAllowed(lifecycle, true, storage, GUEST_WORKSPACE_STORAGE_KEY),
    false
  );
  assert.equal(
    persistGuestWorkspaceIfAllowed(lifecycle, false, storage, GUEST_WORKSPACE_STORAGE_KEY),
    false
  );

  lifecycle = applyCloudOptimisticEditState(lifecycle, (prev) => ({
    ...prev,
    books: [
      {
        ...prev.books[0],
        id: 999,
        title: 'অপ্টিমিস্টিক ক্লাউড এডিট',
      },
    ],
  }));
  assert.equal(
    persistGuestWorkspaceIfAllowed(lifecycle, false, storage, GUEST_WORKSPACE_STORAGE_KEY),
    false
  );

  const storedAfterCloud = JSON.parse(
    storage.getItem(GUEST_WORKSPACE_STORAGE_KEY) || '{}'
  ) as WorkspaceData;
  assert.equal(storedAfterCloud.books[0]?.title, 'গেস্টের নিজস্ব নোট');
});

// 15. No duplicate Firebase auth listeners are introduced
test('15. WorkspaceProvider maintains a single onAuthStateChanged listener with unsubscribe and single-flight sign-in guard', () => {
  const workspaceProviderPath = path.join(
    process.cwd(),
    'src/components/WorkspaceProvider.tsx'
  );
  const appShellPath = path.join(process.cwd(), 'src/components/AppShell.tsx');
  const bookLibraryPath = path.join(
    process.cwd(),
    'src/components/modules/BookLibraryView.tsx'
  );

  const providerSrc = fs.readFileSync(workspaceProviderPath, 'utf8');
  const appShellSrc = fs.readFileSync(appShellPath, 'utf8');
  const bookLibrarySrc = fs.readFileSync(bookLibraryPath, 'utf8');

  const providerCodeWithoutComments = providerSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  // Exactly ONE onAuthStateChanged subscription call in executable code
  const authListenerCalls =
    providerCodeWithoutComments.match(/\bonAuthStateChanged\s*\(/g) ?? [];
  assert.equal(
    authListenerCalls.length,
    1,
    `Expected exactly 1 onAuthStateChanged() call, found ${authListenerCalls.length}`
  );

  // Clean unmount unsubscribe
  assert.match(providerSrc, /return\s*\(\)\s*=>\s*unsubscribe\(\);/);

  // No competing onIdTokenChanged listener
  assert.equal(
    (providerSrc.match(/\bonIdTokenChanged\s*\(/g) ?? []).length,
    0,
    'Expected zero onIdTokenChanged() calls'
  );

  // Duplicate concurrent sign-in prevention via signInInFlightRef
  assert.match(providerSrc, /if\s*\(\s*signInInFlightRef\.current\s*\)\s*\{\s*return\s+signInInFlightRef\.current;/);

  // AppShell renders modal error inside the Sign-In modal dialog
  assert.match(appShellSrc, /data-testid="signin-modal-error"/);

  // BookLibraryView defers Sign-In prompt while auth is resolving
  assert.match(bookLibrarySrc, /isAuthStateResolving\(authStatus\)/);
});
