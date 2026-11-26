import type { WorkspaceData } from '@/src/types/system';

export const GUEST_WORKSPACE_STORAGE_KEY = 'prostuti_ai_workspace_v1';

export type WorkspaceDataOwner = 'initial' | 'guest' | 'cloud';

export type AuthTransitionPhase =
  | 'hydrating'
  | 'guest'
  | 'signing_in'
  | 'authenticated'
  | 'signing_out';

export type GuestRestoreSource = 'storage' | 'snapshot' | 'seed';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceLifecycleState {
  phase: AuthTransitionPhase;
  owner: WorkspaceDataOwner;
  data: WorkspaceData;
  guestDirty: boolean;
  guestSnapshot: WorkspaceData | null;
  sessionSeq: number;
  lastGuestRestoreSource: GuestRestoreSource | null;
}

export type ReadGuestWorkspaceResult =
  | { ok: true; data: WorkspaceData }
  | {
      ok: false;
      reason: 'unavailable' | 'empty' | 'malformed' | 'storage_error';
    };

export interface ResolveGuestWorkspaceResult {
  data: WorkspaceData;
  source: GuestRestoreSource;
  storageFailureReason?: 'unavailable' | 'empty' | 'malformed' | 'storage_error';
}

const REQUIRED_WORKSPACE_ARRAY_KEYS: ReadonlyArray<keyof WorkspaceData> = [
  'books',
  'questions',
  'exams',
  'attempts',
  'mistakes',
  'gkItems',
  'studyTasks',
];

/**
 * Strictly validates that an unknown parsed JSON payload conforms to the
 * top-level WorkspaceData shape so malformed or partial LocalStorage entries
 * never crash hydration or overwrite valid state.
 */
export function isValidWorkspaceData(value: unknown): value is WorkspaceData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of REQUIRED_WORKSPACE_ARRAY_KEYS) {
    if (!Array.isArray(record[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Produces an isolated deep copy of WorkspaceData so React state mutations,
 * in-memory guest snapshots, and cloud data can never alias each other.
 */
export function cloneWorkspaceData(data: WorkspaceData): WorkspaceData {
  return JSON.parse(JSON.stringify(data)) as WorkspaceData;
}

/**
 * Safely reads and validates persisted Guest Mode workspace data from storage.
 * Never throws on malformed JSON, wrong shapes, or blocked storage access.
 */
export function readGuestWorkspace(
  storage: StorageLike | null | undefined,
  storageKey: string = GUEST_WORKSPACE_STORAGE_KEY
): ReadGuestWorkspaceResult {
  if (!storage) {
    return { ok: false, reason: 'unavailable' };
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return { ok: false, reason: 'storage_error' };
  }

  if (raw === null || raw.trim() === '') {
    return { ok: false, reason: 'empty' };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidWorkspaceData(parsed)) {
      return { ok: false, reason: 'malformed' };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * Safely writes validated Guest Mode workspace data to storage.
 * Never throws on QuotaExceededError or restricted storage environments.
 */
export function saveGuestWorkspace(
  storage: StorageLike | null | undefined,
  data: WorkspaceData,
  storageKey: string = GUEST_WORKSPACE_STORAGE_KEY
): boolean {
  if (!storage || !isValidWorkspaceData(data)) {
    return false;
  }
  try {
    const serialized = JSON.stringify(data);
    try {
      if (storage.getItem(storageKey) === serialized) {
        return true;
      }
    } catch {
      // Ignore read error and proceed to attempt write
    }
    storage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the Guest Mode workspace to hydrate or restore using strict priority:
 *   1. Valid persisted Guest data in LocalStorage
 *   2. Valid in-memory Guest snapshot (e.g., if LocalStorage was temporarily unavailable)
 *   3. Fresh seed data fallback (ONLY when neither valid stored data nor snapshot exists)
 */
export function resolveGuestWorkspace(
  storage: StorageLike | null | undefined,
  createSeedData: () => WorkspaceData,
  guestSnapshot: WorkspaceData | null = null,
  storageKey: string = GUEST_WORKSPACE_STORAGE_KEY
): ResolveGuestWorkspaceResult {
  const fromStorage = readGuestWorkspace(storage, storageKey);
  if (fromStorage.ok) {
    return {
      data: cloneWorkspaceData(fromStorage.data),
      source: 'storage',
    };
  }

  if (guestSnapshot && isValidWorkspaceData(guestSnapshot)) {
    return {
      data: cloneWorkspaceData(guestSnapshot),
      source: 'snapshot',
      storageFailureReason: fromStorage.reason,
    };
  }

  return {
    data: createSeedData(),
    source: 'seed',
    storageFailureReason: fromStorage.reason,
  };
}

/**
 * Strict persistence guard: Guest LocalStorage may ONLY be written when:
 * - auth phase is strictly 'guest' (never 'hydrating', 'signing_in', 'authenticated', or 'signing_out')
 * - user is unauthenticated
 * - current state data is explicitly owned by 'guest' (never 'initial' or 'cloud')
 * - guest data has actually been modified in Guest Mode (guestDirty === true)
 */
export function shouldPersistGuestWorkspace(params: {
  phase: AuthTransitionPhase;
  isAuthenticated: boolean;
  owner: WorkspaceDataOwner;
  guestDirty: boolean;
}): boolean {
  return (
    params.phase === 'guest' &&
    !params.isAuthenticated &&
    params.owner === 'guest' &&
    params.guestDirty
  );
}

/**
 * Creates the initial unhydrated lifecycle state before Firebase Auth settles.
 * Persistence is strictly disabled in this state.
 */
export function createInitialWorkspaceLifecycleState(
  createSeedData: () => WorkspaceData
): WorkspaceLifecycleState {
  return {
    phase: 'hydrating',
    owner: 'initial',
    data: createSeedData(),
    guestDirty: false,
    guestSnapshot: null,
    sessionSeq: 0,
    lastGuestRestoreSource: null,
  };
}

/**
 * Applies an already-resolved Guest workspace payload into lifecycle state
 * without performing any storage side effects inside a state updater.
 */
export function applyResolvedGuestState(
  prev: WorkspaceLifecycleState,
  resolved: ResolveGuestWorkspaceResult,
  nextSessionSeq?: number
): WorkspaceLifecycleState {
  const nextSnapshot =
    resolved.source === 'storage' || resolved.source === 'snapshot'
      ? cloneWorkspaceData(resolved.data)
      : prev.guestSnapshot;

  return {
    phase: 'guest',
    owner: 'guest',
    data: resolved.data,
    guestDirty: false,
    guestSnapshot: nextSnapshot,
    sessionSeq: nextSessionSeq ?? prev.sessionSeq + 1,
    lastGuestRestoreSource: resolved.source,
  };
}

/**
 * Transitions the lifecycle state into Guest Mode (initial unauthenticated load,
 * sign-out completion, or external auth revocation), atomically restoring saved
 * Guest data without writing seed or cloud data to LocalStorage.
 */
export function transitionToGuestState(
  prev: WorkspaceLifecycleState,
  storage: StorageLike | null | undefined,
  createSeedData: () => WorkspaceData,
  storageKey: string = GUEST_WORKSPACE_STORAGE_KEY,
  nextSessionSeq?: number
): WorkspaceLifecycleState {
  const resolved = resolveGuestWorkspace(
    storage,
    createSeedData,
    prev.guestSnapshot,
    storageKey
  );
  return applyResolvedGuestState(prev, resolved, nextSessionSeq);
}

/**
 * Applies a Guest Mode mutation atomically.
 * Refuses to relabel cloud data as guest data or mark writes during auth transitions.
 */
export function applyGuestEditState(
  prev: WorkspaceLifecycleState,
  updater: (data: WorkspaceData) => WorkspaceData
): WorkspaceLifecycleState {
  if (prev.phase !== 'guest' || prev.owner !== 'guest') {
    return prev;
  }
  const nextData = updater(prev.data);
  return {
    ...prev,
    owner: 'guest',
    data: nextData,
    guestDirty: true,
    guestSnapshot: cloneWorkspaceData(nextData),
  };
}

/**
 * Transitions into 'signing_in' before starting Google Sign-In.
 * Freezes LocalStorage writes and flushes any dirty Guest edits beforehand so
 * nothing is lost across the auth boundary.
 */
export function beginSignInTransitionState(
  prev: WorkspaceLifecycleState,
  storage: StorageLike | null | undefined,
  storageKey: string = GUEST_WORKSPACE_STORAGE_KEY
): WorkspaceLifecycleState {
  let nextSnapshot = prev.guestSnapshot;
  if (prev.phase === 'guest' && prev.owner === 'guest') {
    if (prev.guestDirty) {
      saveGuestWorkspace(storage, prev.data, storageKey);
      nextSnapshot = cloneWorkspaceData(prev.data);
    } else if (!nextSnapshot) {
      const existing = readGuestWorkspace(storage, storageKey);
      if (existing.ok) {
        nextSnapshot = cloneWorkspaceData(existing.data);
      }
    }
  }

  return {
    ...prev,
    phase: 'signing_in',
    guestDirty: false,
    guestSnapshot: nextSnapshot,
  };
}

/**
 * Recovers cleanly to Guest Mode if sign-in popup is cancelled or fails.
 */
export function cancelSignInTransitionState(
  prev: WorkspaceLifecycleState
): WorkspaceLifecycleState {
  if (prev.phase !== 'signing_in') {
    return prev;
  }
  return {
    ...prev,
    phase: prev.owner === 'guest' ? 'guest' : 'hydrating',
  };
}

/**
 * Marks the session as authenticated. Never writes to Guest LocalStorage and
 * preserves any existing Guest snapshot for future sign-out restoration.
 */
export function enterAuthenticatedState(
  prev: WorkspaceLifecycleState,
  storage: StorageLike | null | undefined,
  storageKey: string = GUEST_WORKSPACE_STORAGE_KEY,
  nextSessionSeq?: number
): WorkspaceLifecycleState {
  let nextSnapshot = prev.guestSnapshot;
  if (prev.phase === 'guest' && prev.owner === 'guest' && prev.guestDirty) {
    saveGuestWorkspace(storage, prev.data, storageKey);
    nextSnapshot = cloneWorkspaceData(prev.data);
  }

  return {
    ...prev,
    phase: 'authenticated',
    guestDirty: false,
    guestSnapshot: nextSnapshot,
    sessionSeq: nextSessionSeq ?? prev.sessionSeq + 1,
  };
}

/**
 * Applies cloud workspace data returned from `/api/workspace`.
 * Strictly checks `expectedSessionSeq` and `phase === 'authenticated'` so late
 * in-flight cloud responses after sign-out are safely discarded.
 */
export function applyCloudWorkspaceState(
  prev: WorkspaceLifecycleState,
  cloudWorkspace: WorkspaceData,
  expectedSessionSeq: number
): WorkspaceLifecycleState {
  if (
    prev.phase !== 'authenticated' ||
    prev.sessionSeq !== expectedSessionSeq ||
    !isValidWorkspaceData(cloudWorkspace)
  ) {
    return prev;
  }

  return {
    ...prev,
    owner: 'cloud',
    data: cloudWorkspace,
    guestDirty: false,
  };
}

/**
 * Applies an optimistic cloud mutation (e.g. exam draft or GK converted flag)
 * strictly within authenticated cloud state without ever touching Guest storage.
 */
export function applyCloudOptimisticEditState(
  prev: WorkspaceLifecycleState,
  updater: (data: WorkspaceData) => WorkspaceData
): WorkspaceLifecycleState {
  if (prev.phase !== 'authenticated') {
    return prev;
  }
  return {
    ...prev,
    owner: 'cloud',
    data: updater(prev.data),
    guestDirty: false,
  };
}

/**
 * Transitions into 'signing_out' BEFORE invoking Firebase `signOut(auth)`.
 * Immediately invalidates in-flight cloud requests and blocks any LocalStorage
 * write while transitioning from authenticated cloud data back to Guest Mode.
 */
export function beginSignOutTransitionState(
  prev: WorkspaceLifecycleState,
  nextSessionSeq?: number
): WorkspaceLifecycleState {
  return {
    ...prev,
    phase: 'signing_out',
    guestDirty: false,
    sessionSeq: nextSessionSeq ?? prev.sessionSeq + 1,
  };
}

/**
 * Recovers to 'authenticated' if Firebase `signOut(auth)` throws an error while
 * the user remains signed in.
 */
export function cancelSignOutTransitionState(
  prev: WorkspaceLifecycleState
): WorkspaceLifecycleState {
  if (prev.phase !== 'signing_out') {
    return prev;
  }
  return {
    ...prev,
    phase: 'authenticated',
  };
}

/**
 * Persists the current workspace to Guest LocalStorage ONLY if all lifecycle
 * isolation guards pass.
 */
export function persistGuestWorkspaceIfAllowed(
  state: WorkspaceLifecycleState,
  isAuthenticated: boolean,
  storage: StorageLike | null | undefined,
  storageKey: string = GUEST_WORKSPACE_STORAGE_KEY
): boolean {
  if (
    !shouldPersistGuestWorkspace({
      phase: state.phase,
      isAuthenticated,
      owner: state.owner,
      guestDirty: state.guestDirty,
    })
  ) {
    return false;
  }
  return saveGuestWorkspace(storage, state.data, storageKey);
}
