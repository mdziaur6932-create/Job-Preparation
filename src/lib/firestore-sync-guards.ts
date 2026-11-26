export interface ProfileSnapshotGuardInput {
  exists: boolean;
  fromCache: boolean;
  emailVerified: boolean;
  email: string | null | undefined;
  createAttempted: boolean;
}

/**
 * Pure guard deciding whether subscribeUserPrivateProfile may create
 * `users/{uid}/private/profile`.
 *
 * CRITICAL: Never create a profile when `fromCache` is true — while Firestore
 * is offline or still completing its initial server handshake, a missing cache
 * entry does NOT mean the document is absent on the server. Calling `setDoc`
 * against an already-existing server profile attempts an `update` that mutates
 * immutable `createdAt` and fails with `Missing or insufficient permissions`.
 */
export function shouldCreatePrivateProfile(
  input: ProfileSnapshotGuardInput
): boolean {
  if (input.exists) return false;
  if (input.fromCache) return false;
  if (input.createAttempted) return false;
  if (!input.emailVerified) return false;
  if (!input.email || input.email.trim().length === 0) return false;
  return true;
}

export interface CollectionLoadSummary {
  docsCount: number;
  fromCache: boolean;
}

export type WorkspaceLoadAction = 'hydrate' | 'seed' | 'offline_empty';

/**
 * Pure decision function for authenticated workspace hydration vs first-time seeding.
 *
 * CRITICAL: Seeding writes deterministic IDs (`books/101..`, `questions/201..`, etc.)
 * via `batch.set()`. If Firestore is offline and `getDocs()` returned an empty local
 * cache (`fromCache: true`), seeding would queue `set()` writes over an existing user's
 * server documents — turning creates into updates and failing with `PERMISSION_DENIED`
 * on immutable fields (`createdAt`) and immutable collections (`bookChunks`, `questions`,
 * `attempts`). Therefore seeding is ONLY permitted when ALL collections are confirmed
 * empty directly from the server (`fromCache === false`).
 */
export function decideWorkspaceLoadAction(params: {
  collections: ReadonlyArray<CollectionLoadSummary>;
  emailVerified: boolean;
}): WorkspaceLoadAction {
  const hasAnyDocs = params.collections.some((c) => c.docsCount > 0);
  if (hasAnyDocs) {
    return 'hydrate';
  }

  const anyFromCache = params.collections.some((c) => c.fromCache);
  if (anyFromCache) {
    return 'offline_empty';
  }

  return params.emailVerified ? 'seed' : 'hydrate';
}

/**
 * Detects transient Firestore connectivity / offline errors so reads can safely
 * inspect local cache without misclassifying offline states as permission errors.
 */
export function isFirestoreOfflineOrUnavailableError(error: unknown): boolean {
  if (!error) return false;
  const code =
    typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '').toLowerCase()
      : '';
  if (code === 'unavailable' || code === 'deadline-exceeded') {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  return (
    message.includes('client is offline') ||
    message.includes('failed to get document from server') ||
    message.includes('could not reach cloud firestore backend') ||
    message.includes('network error') ||
    message.includes('unavailable')
  );
}
