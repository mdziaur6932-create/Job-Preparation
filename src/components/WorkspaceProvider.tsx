'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, googleAuthProvider } from '@/src/lib/firebase';
import {
  saveUserDriveSyncPreference,
  subscribeUserPrivateProfile,
} from '@/src/lib/firestore-profile';
import {
  createBookInFirestore,
  createExamInFirestore,
  createGkInFirestore,
  createMistakesInFirestore,
  createStudyTaskInFirestore,
  deleteBookInFirestore,
  deleteExamAttemptInFirestore,
  deleteExamInFirestore,
  deleteGkItemInFirestore,
  deleteMistakeInFirestore,
  deleteQuestionInFirestore,
  deleteStudyTaskInFirestore,
  loadWorkspaceFromFirestore,
  markGkConvertedInFirestore,
  saveExamAttemptInFirestore,
  saveExamDraftInFirestore,
  saveQuestionsInFirestore,
  toggleGkArchiveInFirestore,
  toggleMistakeMasteredInFirestore,
  toggleStudyTaskInFirestore,
  updateBookChunksInFirestore,
  updateBookDriveMetaInFirestore,
  updateStudyTaskInFirestore,
} from '@/src/lib/firestore-workspace';
import {
  EXISTING_LIBRARY_DRIVE_FOLDER_ID,
  EXISTING_LIBRARY_DRIVE_FOLDER_URL,
  resolveUploadDriveTarget,
} from '@/src/lib/google-drive';
import { GUEST_AI_SIGNIN_MESSAGE } from '@/src/lib/ai-client';
import {
  applySignInFailureUiState,
  applySignInSuccessUiState,
  retrieveAiAuthHeaders,
  shouldDeferAiSignInPrompt,
  type FrontendAuthStatus,
} from '@/src/lib/frontend-auth';
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
  cloneWorkspaceData,
  createInitialWorkspaceLifecycleState,
  enterAuthenticatedState,
  persistGuestWorkspaceIfAllowed,
  resolveGuestWorkspace,
  type AuthTransitionPhase,
  type StorageLike,
  type WorkspaceLifecycleState,
} from '@/src/lib/guest-workspace-storage';
import { createInitialSeedData } from '@/src/lib/seed-data';
import { findDuplicateBookMatch } from '@/src/lib/pdf-rules';
import {
  buildMergedBookChunks,
  parseBookSeriesIdentity,
} from '@/src/lib/book-series-and-topic-analyzer';
import { resolveOfflineScopeKey } from '@/src/lib/offline-cache-policy';
import {
  offlineLibraryStore,
  warmCurrentAppAssetsInSw,
  type OfflinePdfBlobRecord,
  type OfflinePdfMeta,
  type ServiceWorkerCacheStatus,
} from '@/src/lib/offline-library-cache';
import type {
  Book,
  BookCategory,
  BookChunk,
  CurrentGkItem,
  Exam,
  ExamAnswerDraft,
  ExamAttempt,
  ExamMode,
  MistakeItem,
  ModuleId,
  Question,
  StudyTask,
  WorkspaceData,
} from '@/src/types/system';

function getBrowserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface CreateBookInput {
  title: string;
  author: string;
  subject: string;
  category: BookCategory;
  totalPages: number;
  extractionMethod: 'text' | 'ocr' | 'manual';
  ocrCompleted: boolean;
  driveFileId?: string | null;
  driveWebViewLink?: string | null;
  driveFileName?: string | null;
  chunks: Array<Omit<BookChunk, 'id' | 'bookId' | 'bookTitle'>>;
}

export interface BookDriveMeta {
  driveFileId: string | null;
  driveWebViewLink: string | null;
  driveFileName: string | null;
}

export interface AiAuthPromptState {
  featureName: string;
  message: string;
}

export interface ReaderJumpTarget {
  bookId: number;
  pageNumber: number;
  examId?: string | null;
  questionText?: string | null;
  nonce: number;
}

interface WorkspaceContextValue {
  data: WorkspaceData;
  user: User | null;
  authLoading: boolean;
  authStatus: FrontendAuthStatus;
  authError: string | null;
  clearAuthError: () => void;
  syncing: boolean;
  syncError: string | null;
  retryCloudSync: () => Promise<void>;
  aiAuthPrompt: AiAuthPromptState | null;
  requestAiSignIn: (featureName: string) => void;
  dismissAiAuthPrompt: () => void;
  getAiAuthHeaders: (options?: {
    forceRefresh?: boolean;
  }) => Promise<Record<string, string> | null>;
  driveConnected: boolean;
  driveSyncEnabled: boolean;
  setDriveSyncEnabled: (enabled: boolean) => void;
  driveFolderId: string;
  driveFolderUrl: string;
  driveFolderLabel: string;
  isOwnerDriveFolder: boolean;
  driveImportFolderId: string;
  driveImportFolderUrl: string;
  getDriveAccessToken: () => string | null;
  clearDriveSession: () => void;
  connectGoogleDrive: () => Promise<string | null>;
  activeModule: ModuleId;
  setActiveModule: (m: ModuleId) => void;
  selectedBookId: number | null;
  setSelectedBookId: (id: number | null) => void;
  activeExamId: number | null;
  setActiveExamId: (id: number | null) => void;
  selectedAttemptId: number | null;
  setSelectedAttemptId: (id: number | null) => void;
  readerJumpTarget: ReaderJumpTarget | null;
  openSourceQuestionInReader: (target: {
    bookId: number;
    pageNumber: number;
    examId?: string | null;
    questionText?: string | null;
  }) => void;
  clearReaderJumpTarget: () => void;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  addBook: (input: CreateBookInput) => Promise<Book>;
  mergeBooksIntoSeries: (
    bookIds: number[],
    mergedTitle?: string
  ) => Promise<Book | null>;
  appendPartToBook: (
    targetBookId: number,
    partInput: {
      totalPages: number;
      chunks: Array<Omit<BookChunk, 'id' | 'bookId' | 'bookTitle'>>;
      extractionMethod?: 'text' | 'ocr' | 'manual';
      ocrCompleted?: boolean;
    }
  ) => Promise<Book | null>;
  updateBookDriveMeta: (bookId: number, drive: BookDriveMeta) => Promise<void>;
  updateBookViewContent: (
    bookId: number,
    sourceChunkIds: number[],
    updatedContent: string
  ) => Promise<void>;
  deleteBook: (bookId: number) => Promise<void>;
  addQuestions: (
    items: Array<Omit<Question, 'id' | 'createdAt'>>
  ) => Promise<Question[]>;
  deleteQuestion: (questionId: number) => Promise<void>;
  createExam: (input: {
    title: string;
    subject: string;
    examMode: ExamMode;
    durationMinutes: number;
    marksPerQuestion: number;
    negativeMark: number;
    questionIds: number[];
  }) => Promise<Exam>;
  deleteExam: (examId: number) => Promise<void>;
  saveExamDraft: (
    examId: number,
    draftAnswers: Record<string, ExamAnswerDraft>
  ) => Promise<void>;
  saveExamAttempt: (
    attempt: Omit<ExamAttempt, 'id' | 'submittedAt'>,
    newMistakes: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>>
  ) => Promise<ExamAttempt>;
  deleteExamAttempt: (attemptId: number) => Promise<void>;
  toggleMistakeMastered: (mistakeId: number) => Promise<void>;
  deleteMistake: (mistakeId: number) => Promise<void>;
  addMistakeItems: (
    items: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>>
  ) => Promise<void>;
  addGkItem: (input: {
    title: string;
    summary: string;
    category: string;
    eventDate: string;
    source: string;
    isArchived?: boolean;
  }) => Promise<void>;
  toggleGkArchive: (gkId: number) => Promise<void>;
  markGkConverted: (gkId: number) => void;
  deleteGkItem: (gkId: number) => Promise<void>;
  addStudyTask: (input: {
    title: string;
    subject: string;
    chapter: string;
    taskType: 'reading' | 'revision' | 'practice' | 'exam';
    scheduledDate: string;
    durationMinutes: number;
  }) => Promise<void>;
  addStudyTasksBatch: (
    inputs: Array<{
      title: string;
      subject: string;
      chapter: string;
      taskType: 'reading' | 'revision' | 'practice' | 'exam';
      scheduledDate: string;
      durationMinutes: number;
    }>
  ) => Promise<number>;
  updateStudyTask: (
    taskId: number,
    patch: Partial<
      Pick<
        StudyTask,
        | 'title'
        | 'subject'
        | 'chapter'
        | 'taskType'
        | 'scheduledDate'
        | 'durationMinutes'
      >
    >
  ) => Promise<void>;
  toggleStudyTask: (taskId: number) => Promise<void>;
  deleteStudyTask: (taskId: number) => Promise<void>;
  offlineScopeKey: string;
  offlineSavedAt: string | null;
  usingOfflineSnapshot: boolean;
  cachedPdfsMeta: OfflinePdfMeta[];
  cacheBookPdfOffline: (
    bookId: number,
    bookTitle: string,
    file: Blob,
    fileName: string
  ) => Promise<OfflinePdfMeta | null>;
  getCachedBookPdf: (bookId: number) => Promise<OfflinePdfBlobRecord | null>;
  removeCachedBookPdf: (bookId: number) => Promise<void>;
  syncAllOfflineMaterials: () => Promise<{
    savedAt: string | null;
    swStatus: ServiceWorkerCacheStatus;
  }>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function nextIdFrom<T extends { id: number }>(items: T[], base: number): number {
  return items.reduce((max, item) => Math.max(max, item.id), base) + 1;
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [lifecycle, setLifecycle] = useState<WorkspaceLifecycleState>(() =>
    createInitialWorkspaceLifecycleState(createInitialSeedData)
  );
  const data = lifecycle.data;
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authStatus, setAuthStatus] = useState<FrontendAuthStatus>('initializing');
  const [authError, setAuthError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [aiAuthPrompt, setAiAuthPrompt] = useState<AiAuthPromptState | null>(null);
  const [activeModule, setActiveModule] = useState<ModuleId>('library');
  const [selectedBookId, setSelectedBookId] = useState<number | null>(101);
  const [activeExamId, setActiveExamId] = useState<number | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<number | null>(401);
  const [readerJumpTarget, setReaderJumpTarget] =
    useState<ReaderJumpTarget | null>(null);
  const [driveConnected, setDriveConnected] = useState(false);
  const [driveSyncEnabledState, setDriveSyncEnabledState] = useState(true);
  const offlineScopeKey = resolveOfflineScopeKey(user?.uid);
  const [offlineSavedAt, setOfflineSavedAt] = useState<string | null>(null);
  const [usingOfflineSnapshot, setUsingOfflineSnapshot] = useState(false);
  const [cachedPdfsMeta, setCachedPdfsMeta] = useState<OfflinePdfMeta[]>([]);

  // Store Firebase ID Token & Google Drive OAuth Access Token strictly in memory (never localStorage/sessionStorage)
  const idTokenRef = useRef<string | null>(null);
  const driveAccessTokenRef = useRef<string | null>(null);
  // Monotonic sequence token to discard stale in-flight cloud responses after sign-out
  const sessionSeqRef = useRef(0);
  // Tracks the latest auth phase synchronously across rapid auth callbacks
  const currentPhaseRef = useRef<AuthTransitionPhase>('hydrating');
  // Tracks the latest distinct frontend auth status synchronously
  const authStatusRef = useRef<FrontendAuthStatus>('initializing');
  // Tracks active modal prompt synchronously for sign-in error preservation
  const aiAuthPromptRef = useRef<AiAuthPromptState | null>(null);
  // Prevents duplicate concurrent Google Sign-In popup invocations
  const signInInFlightRef = useRef<Promise<void> | null>(null);
  // Tracks last UID synced to avoid redundant workspace fetches on repeated same-account sign-in
  const lastSyncedUidRef = useRef<string | null>(null);
  // In-memory backup snapshot of the latest valid Guest Mode workspace
  const guestSnapshotRef = useRef<WorkspaceData | null>(null);

  const updateAuthStatus = useCallback((next: FrontendAuthStatus) => {
    authStatusRef.current = next;
    setAuthStatus(next);
  }, []);

  const updateAiAuthPrompt = useCallback((next: AiAuthPromptState | null) => {
    aiAuthPromptRef.current = next;
    setAiAuthPrompt(next);
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
    if (authStatusRef.current === 'error' && !auth.currentUser) {
      updateAuthStatus('guest');
    }
  }, [updateAuthStatus]);

  const applyGuestMutation = useCallback(
    (updater: (prev: WorkspaceData) => WorkspaceData) => {
      setLifecycle((prev) => {
        const next = applyGuestEditState(prev, updater);
        if (next.guestSnapshot) {
          guestSnapshotRef.current = next.guestSnapshot;
        }
        return next;
      });
    },
    []
  );

  const restoreGuestWorkspace = useCallback((restoreSeq: number) => {
    const resolved = resolveGuestWorkspace(
      getBrowserStorage(),
      createInitialSeedData,
      guestSnapshotRef.current,
      GUEST_WORKSPACE_STORAGE_KEY
    );
    if (resolved.source === 'storage' || resolved.source === 'snapshot') {
      guestSnapshotRef.current = cloneWorkspaceData(resolved.data);
    }
    currentPhaseRef.current = 'guest';
    setLifecycle((prev) => applyResolvedGuestState(prev, resolved, restoreSeq));
    setSelectedBookId(resolved.data.books[0]?.id ?? null);
    setSelectedAttemptId(resolved.data.attempts[0]?.id ?? null);
    setActiveExamId(null);
    setUsingOfflineSnapshot(false);

    // If LocalStorage was unavailable or exceeded quota for large PDFs, recover Guest Mode snapshot from IndexedDB
    if (resolved.source === 'seed') {
      const guestScope = resolveOfflineScopeKey(null);
      void offlineLibraryStore.loadWorkspaceSnapshot(guestScope).then((snap) => {
        if (
          !snap ||
          sessionSeqRef.current !== restoreSeq ||
          currentPhaseRef.current !== 'guest'
        ) {
          return;
        }
        guestSnapshotRef.current = cloneWorkspaceData(snap.data);
        setLifecycle((prev) =>
          prev.owner === 'guest' && prev.phase === 'guest'
            ? prev
            : applyResolvedGuestState(
                prev,
                { data: snap.data, source: 'snapshot' },
                restoreSeq
              )
        );
        setSelectedBookId(snap.data.books[0]?.id ?? null);
        setSelectedAttemptId(snap.data.attempts[0]?.id ?? null);
        setOfflineSavedAt(snap.savedAt);
      });
    }
  }, []);

  // Persist guest workspace edits ONLY when strictly in Guest Mode with guest-owned edits
  useEffect(() => {
    const persisted = persistGuestWorkspaceIfAllowed(
      lifecycle,
      Boolean(user),
      getBrowserStorage(),
      GUEST_WORKSPACE_STORAGE_KEY
    );
    if (persisted) {
      guestSnapshotRef.current = cloneWorkspaceData(lifecycle.data);
    }
  }, [lifecycle, user]);

  // Load cached PDFs metadata and last offline snapshot timestamp for the active scope
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      offlineLibraryStore.listCachedPdfs(offlineScopeKey),
      offlineLibraryStore.loadWorkspaceSnapshot(offlineScopeKey),
    ]).then(([pdfs, snapshot]) => {
      if (cancelled) return;
      setCachedPdfsMeta(pdfs);
      setOfflineSavedAt(snapshot?.savedAt ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [offlineScopeKey]);

  // Mirror verified workspace data into the scope-isolated IndexedDB Offline Vault
  useEffect(() => {
    const isGuestOwned = lifecycle.owner === 'guest' && !user;
    const isCloudOwned = lifecycle.owner === 'cloud' && Boolean(user);
    if (!isGuestOwned && !isCloudOwned) return;
    const targetScope = isCloudOwned
      ? resolveOfflineScopeKey(user?.uid)
      : resolveOfflineScopeKey(null);
    let cancelled = false;
    void offlineLibraryStore
      .saveWorkspaceSnapshot(targetScope, lifecycle.data)
      .then((record) => {
        if (!cancelled && record) {
          setOfflineSavedAt(record.savedAt);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [lifecycle, user]);

  // Attach real-time Firestore private profile listener ONLY when auth is ready and user is authenticated
  useEffect(() => {
    if (authLoading || !user) return;
    const unsubscribeProfile = subscribeUserPrivateProfile({
      user,
      onProfile: (profile) => {
        setDriveSyncEnabledState(profile.driveSyncEnabled);
      },
    });
    return () => unsubscribeProfile();
  }, [authLoading, user]);

  const setDriveSyncEnabled = useCallback(
    (enabled: boolean) => {
      setDriveSyncEnabledState(enabled);
      const activeUser = auth.currentUser ?? user;
      if (activeUser) {
        void saveUserDriveSyncPreference(activeUser, enabled).catch(() => {
          // Structured error already logged by handleFirestoreError
        });
      }
    },
    [user]
  );

  const fetchAuthenticatedWorkspace = useCallback(
    async (firebaseUser: User, expectedSessionSeq: number) => {
      setSyncing(true);
      setSyncError(null);
      try {
        const token = await firebaseUser.getIdToken();
        if (sessionSeqRef.current !== expectedSessionSeq) return;
        idTokenRef.current = token;
        const workspace = await loadWorkspaceFromFirestore(firebaseUser);
        if (sessionSeqRef.current !== expectedSessionSeq) return;
        setUsingOfflineSnapshot(false);
        setLifecycle((prev) =>
          applyCloudWorkspaceState(prev, workspace, expectedSessionSeq)
        );
        setSelectedBookId(workspace.books?.[0]?.id ?? null);
        setSelectedAttemptId(workspace.attempts?.[0]?.id ?? null);
      } catch (err) {
        if (sessionSeqRef.current !== expectedSessionSeq) return;
        const userScope = resolveOfflineScopeKey(firebaseUser.uid);
        const cachedSnapshot =
          await offlineLibraryStore.loadWorkspaceSnapshot(userScope);
        if (sessionSeqRef.current !== expectedSessionSeq) return;
        if (cachedSnapshot) {
          setLifecycle((prev) =>
            applyCloudWorkspaceState(
              prev,
              cachedSnapshot.data,
              expectedSessionSeq
            )
          );
          setSelectedBookId(cachedSnapshot.data.books?.[0]?.id ?? null);
          setSelectedAttemptId(cachedSnapshot.data.attempts?.[0]?.id ?? null);
          setOfflineSavedAt(cachedSnapshot.savedAt);
          setUsingOfflineSnapshot(true);
          setSyncError(null);
          return;
        }
        setSyncError(
          err instanceof Error && !err.message.startsWith('{')
            ? err.message
            : 'ক্লাউড ডাটাবেস থেকে তথ্য লোড করা যায়নি।'
        );
      } finally {
        if (sessionSeqRef.current === expectedSessionSeq) {
          setSyncing(false);
        }
      }
    },
    []
  );

  const retryCloudSync = useCallback(async () => {
    const activeUser = auth.currentUser ?? user;
    if (!activeUser) return;
    await fetchAuthenticatedWorkspace(activeUser, sessionSeqRef.current);
  }, [user, fetchAuthenticatedWorkspace]);

  // Single authoritative Firebase authentication observer
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser) {
        const authSeq = sessionSeqRef.current + 1;
        sessionSeqRef.current = authSeq;
        currentPhaseRef.current = 'authenticated';
        lastSyncedUidRef.current = fbUser.uid;
        const storage = getBrowserStorage();
        setUser(fbUser);
        setAuthLoading(false);
        updateAuthStatus('authenticated');
        setAuthError(null);
        updateAiAuthPrompt(null);
        setLifecycle((prev) => {
          const next = enterAuthenticatedState(
            prev,
            storage,
            GUEST_WORKSPACE_STORAGE_KEY,
            authSeq
          );
          if (next.guestSnapshot) {
            guestSnapshotRef.current = next.guestSnapshot;
          }
          return next;
        });
        void fetchAuthenticatedWorkspace(fbUser, authSeq);
      } else {
        idTokenRef.current = null;
        driveAccessTokenRef.current = null;
        setDriveConnected(false);
        lastSyncedUidRef.current = null;
        setUser(null);
        setAuthLoading(false);
        setSyncing(false);
        if (currentPhaseRef.current !== 'guest') {
          const restoreSeq = sessionSeqRef.current + 1;
          sessionSeqRef.current = restoreSeq;
          restoreGuestWorkspace(restoreSeq);
        }
        if (authStatusRef.current !== 'error') {
          updateAuthStatus('guest');
        }
      }
    });
    return () => unsubscribe();
  }, [
    fetchAuthenticatedWorkspace,
    restoreGuestWorkspace,
    updateAiAuthPrompt,
    updateAuthStatus,
  ]);

  const runFirestoreMutation = useCallback(
    async (mutation: (activeUser: User) => Promise<void>): Promise<boolean> => {
      const activeUser = auth.currentUser ?? user;
      if (!activeUser) return false;
      const expectedSeq = sessionSeqRef.current;
      setSyncing(true);
      setSyncError(null);
      try {
        await mutation(activeUser);
        return sessionSeqRef.current === expectedSeq;
      } catch (err) {
        if (sessionSeqRef.current !== expectedSeq) return false;
        setSyncError(
          err instanceof Error && !err.message.startsWith('{')
            ? err.message
            : 'ক্লাউড ডাটাবেসে তথ্য সংরক্ষণ করা যায়নি।'
        );
        return false;
      } finally {
        if (sessionSeqRef.current === expectedSeq) {
          setSyncing(false);
        }
      }
    },
    [user]
  );

  const signInWithGoogle = useCallback(async () => {
    if (signInInFlightRef.current) {
      return signInInFlightRef.current;
    }

    const runSignIn = (async () => {
      setSyncError(null);
      setAuthError(null);
      const storage = getBrowserStorage();
      const wasAuthenticated = currentPhaseRef.current === 'authenticated';
      updateAuthStatus('signing_in');
      currentPhaseRef.current = 'signing_in';
      setLifecycle((prev) => {
        const next = beginSignInTransitionState(
          prev,
          storage,
          GUEST_WORKSPACE_STORAGE_KEY
        );
        if (next.guestSnapshot) {
          guestSnapshotRef.current = next.guestSnapshot;
        }
        return next;
      });

      const readCurrentPhase = (): AuthTransitionPhase => currentPhaseRef.current;

      try {
        const credential = await signInWithPopup(auth, googleAuthProvider);
        const signedInUser = credential?.user ?? auth.currentUser;

        if (!signedInUser) {
          throw new Error('Google sign-in completed without an active user.');
        }

        const oauthCred = GoogleAuthProvider.credentialFromResult(credential);
        if (oauthCred?.accessToken) {
          driveAccessTokenRef.current = oauthCred.accessToken;
          setDriveConnected(true);
        }

        const nextUi = applySignInSuccessUiState();
        setUser(signedInUser);
        setAuthLoading(false);
        updateAuthStatus(nextUi.authStatus);
        setAuthError(nextUi.authError);
        updateAiAuthPrompt(nextUi.aiAuthPrompt);

        // Explicitly synchronize lifecycle if onAuthStateChanged did not re-fire
        // (for example, repeated Google Sign-In with the same already-signed-in account)
        if (readCurrentPhase() !== 'authenticated') {
          const authSeq = sessionSeqRef.current + 1;
          sessionSeqRef.current = authSeq;
          currentPhaseRef.current = 'authenticated';
          const needsWorkspaceFetch =
            !wasAuthenticated || lastSyncedUidRef.current !== signedInUser.uid;
          lastSyncedUidRef.current = signedInUser.uid;
          setLifecycle((prev) => {
            const next = enterAuthenticatedState(
              prev,
              storage,
              GUEST_WORKSPACE_STORAGE_KEY,
              authSeq
            );
            if (next.guestSnapshot) {
              guestSnapshotRef.current = next.guestSnapshot;
            }
            return next;
          });
          if (needsWorkspaceFetch) {
            void fetchAuthenticatedWorkspace(signedInUser, authSeq);
          } else {
            // Refresh in-memory token after re-authentication without failing the UI
            void signedInUser
              .getIdToken(true)
              .then((freshToken) => {
                if (sessionSeqRef.current === authSeq && freshToken) {
                  idTokenRef.current = freshToken;
                }
              })
              .catch(() => {
                // Handled on next authenticated API call if token refresh fails
              });
          }
        }
      } catch (err) {
        const existingUser = auth.currentUser;
        const phaseOnError = readCurrentPhase();
        if (!existingUser && phaseOnError === 'signing_in') {
          setLifecycle((prev) => {
            const next = cancelSignInTransitionState(prev);
            currentPhaseRef.current = next.phase;
            return next;
          });
        } else if (existingUser && phaseOnError === 'signing_in') {
          const authSeq = sessionSeqRef.current + 1;
          sessionSeqRef.current = authSeq;
          currentPhaseRef.current = 'authenticated';
          setLifecycle((prev) =>
            enterAuthenticatedState(
              prev,
              storage,
              GUEST_WORKSPACE_STORAGE_KEY,
              authSeq
            )
          );
        }

        const nextUi = applySignInFailureUiState({
          error: err,
          currentPrompt: aiAuthPromptRef.current,
          hasExistingAuthenticatedUser: Boolean(existingUser),
        });
        updateAuthStatus(nextUi.authStatus);
        setAuthError(nextUi.authError);
        updateAiAuthPrompt(nextUi.aiAuthPrompt);
      } finally {
        signInInFlightRef.current = null;
      }
    })();

    signInInFlightRef.current = runSignIn;
    return runSignIn;
  }, [fetchAuthenticatedWorkspace, updateAiAuthPrompt, updateAuthStatus]);

  const signOutUser = useCallback(async () => {
    setSyncError(null);
    setAuthError(null);
    updateAiAuthPrompt(null);
    setActiveExamId(null);
    const signOutSeq = sessionSeqRef.current + 1;
    sessionSeqRef.current = signOutSeq;
    currentPhaseRef.current = 'signing_out';
    updateAuthStatus('signing_out');
    idTokenRef.current = null;
    driveAccessTokenRef.current = null;
    setDriveConnected(false);
    lastSyncedUidRef.current = null;
    setLifecycle((prev) => beginSignOutTransitionState(prev, signOutSeq));
    try {
      await signOut(auth);
      // Restore Guest Mode immediately if onAuthStateChanged(null) has not already fired
      if (sessionSeqRef.current === signOutSeq) {
        const restoreSeq = sessionSeqRef.current + 1;
        sessionSeqRef.current = restoreSeq;
        setUser(null);
        restoreGuestWorkspace(restoreSeq);
        updateAuthStatus('guest');
      }
    } catch (err) {
      if (auth.currentUser && currentPhaseRef.current === 'signing_out') {
        currentPhaseRef.current = 'authenticated';
        updateAuthStatus('authenticated');
        setLifecycle((prev) => cancelSignOutTransitionState(prev));
      }
      setSyncError(
        err instanceof Error ? err.message : 'সাইন-আউট সম্পন্ন করা যায়নি।'
      );
    }
  }, [restoreGuestWorkspace, updateAiAuthPrompt, updateAuthStatus]);

  const requestAiSignIn = useCallback(
    (featureName: string) => {
      if (shouldDeferAiSignInPrompt(authStatusRef.current)) {
        return;
      }
      updateAiAuthPrompt({
        featureName,
        message: GUEST_AI_SIGNIN_MESSAGE,
      });
    },
    [updateAiAuthPrompt]
  );

  const dismissAiAuthPrompt = useCallback(() => {
    updateAiAuthPrompt(null);
    setAuthError(null);
    if (authStatusRef.current === 'error' && !auth.currentUser) {
      updateAuthStatus('guest');
    }
  }, [updateAiAuthPrompt, updateAuthStatus]);

  const getAiAuthHeaders = useCallback(
    async (options?: {
      forceRefresh?: boolean;
    }): Promise<Record<string, string> | null> => {
      const result = await retrieveAiAuthHeaders({
        currentAuthUser: auth.currentUser,
        reactUser: user,
        authStatus: authStatusRef.current,
        forceRefresh: options?.forceRefresh,
      });

      if (!result.ok) {
        if (result.reason === 'token_refresh_failed' && result.message) {
          setAuthError(result.message);
        }
        return null;
      }

      idTokenRef.current = result.token;
      return result.headers;
    },
    [user]
  );

  const addBook = useCallback(
    async (input: CreateBookInput): Promise<Book> => {
      const today = new Date().toISOString().slice(0, 10);
      const localBookId = nextIdFrom(data.books, 100);
      let chunkId = nextIdFrom(
        data.books.flatMap((b) => b.chunks),
        1000
      );

      const newBook: Book = {
        id: localBookId,
        title: input.title,
        author: input.author || 'অজানা লেখক',
        subject: input.subject,
        category: input.category,
        totalPages: input.totalPages,
        extractionMethod: input.extractionMethod,
        ocrCompleted: input.ocrCompleted,
        driveFileId: input.driveFileId ?? null,
        driveWebViewLink: input.driveWebViewLink ?? null,
        driveFileName: input.driveFileName ?? null,
        createdAt: today,
        chunks: input.chunks.map((c, idx) => ({
          id: chunkId++,
          bookId: localBookId,
          bookTitle: input.title,
          chapter: c.chapter,
          pageNumber: c.pageNumber,
          chunkIndex: c.chunkIndex ?? idx,
          content: c.content,
        })),
      };

      const duplicateExisting = findDuplicateBookMatch(data.books, {
        title: input.title,
        subject: input.subject,
        totalPages: input.totalPages,
        chunks: input.chunks.map((c) => ({
          pageNumber: c.pageNumber,
          content: c.content,
        })),
      });
      if (duplicateExisting) {
        setSelectedBookId(duplicateExisting.id);
        return duplicateExisting;
      }

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            books: [newBook, ...ws.books],
          }))
        );
        setSelectedBookId(newBook.id);
        await runFirestoreMutation((activeUser) =>
          createBookInFirestore(activeUser, newBook)
        );
        return newBook;
      }

      applyGuestMutation((prev) => {
        const alreadyExists = findDuplicateBookMatch(prev.books, {
          title: newBook.title,
          subject: newBook.subject,
          totalPages: newBook.totalPages,
          chunks: newBook.chunks,
        });
        if (alreadyExists) {
          return prev;
        }
        return {
          ...prev,
          books: [newBook, ...prev.books],
        };
      });
      setSelectedBookId(newBook.id);
      return newBook;
    },
    [data.books, user, runFirestoreMutation, applyGuestMutation]
  );

  const mergeBooksIntoSeries = useCallback(
    async (bookIds: number[], mergedTitle?: string): Promise<Book | null> => {
      const idSet = new Set(bookIds);
      const targets = data.books.filter((b) => idSet.has(b.id));
      if (targets.length < 2) return null;

      // Sort parts logically by part number -> createdAt -> id
      const sortedTargets = [...targets].sort((a, b) => {
        const ia = parseBookSeriesIdentity(a.title);
        const ib = parseBookSeriesIdentity(b.title);
        const pa = ia.partNumber ?? Number.MAX_SAFE_INTEGER;
        const pb = ib.partNumber ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
        return a.id - b.id;
      });

      const primary = sortedTargets[0];
      const canonicalTitle =
        mergedTitle?.trim() ||
        parseBookSeriesIdentity(primary.title).seriesTitle ||
        primary.title;

      const mergedPayload = buildMergedBookChunks(
        sortedTargets.map((b) => ({
          title: b.title,
          totalPages: b.totalPages,
          chunks: b.chunks.map((c) => ({
            chapter: c.chapter,
            pageNumber: c.pageNumber,
            chunkIndex: c.chunkIndex,
            content: c.content,
          })),
        }))
      );

      const newBookId = nextIdFrom(data.books, 100);
      let nextChunkId = nextIdFrom(
        data.books.flatMap((b) => b.chunks),
        1000
      );

      const mergedBook: Book = {
        id: newBookId,
        title: canonicalTitle,
        author: primary.author || 'ব্যক্তিগত নোট / গাইড',
        subject: primary.subject,
        category: primary.category,
        totalPages: mergedPayload.totalPages,
        extractionMethod: sortedTargets.some((b) => b.extractionMethod === 'ocr')
          ? 'ocr'
          : primary.extractionMethod,
        ocrCompleted: sortedTargets.some((b) => b.ocrCompleted),
        driveFileId: null,
        driveWebViewLink: null,
        driveFileName: null,
        createdAt: new Date().toISOString().slice(0, 10),
        chunks: mergedPayload.chunks.map((c, idx) => ({
          id: nextChunkId++,
          bookId: newBookId,
          bookTitle: canonicalTitle,
          chapter: c.chapter,
          pageNumber: c.pageNumber,
          chunkIndex: idx,
          content: c.content,
        })),
      };

      const applyMerge = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        books: [mergedBook, ...prev.books.filter((b) => !idSet.has(b.id))],
      });

      if (user) {
        setLifecycle((prev) => applyCloudOptimisticEditState(prev, applyMerge));
        setSelectedBookId(mergedBook.id);
        // Create consolidated book first, then remove redundant split parts (100% compliant with firestore.rules)
        await runFirestoreMutation(async (activeUser) => {
          await createBookInFirestore(activeUser, mergedBook);
          for (const oldBook of sortedTargets) {
            await deleteBookInFirestore(
              activeUser,
              oldBook.id,
              oldBook.chunks.map((c) => c.id)
            );
          }
        });
        return mergedBook;
      }

      applyGuestMutation(applyMerge);
      setSelectedBookId(mergedBook.id);
      return mergedBook;
    },
    [data.books, user, runFirestoreMutation, applyGuestMutation]
  );

  const appendPartToBook = useCallback(
    async (
      targetBookId: number,
      partInput: {
        totalPages: number;
        chunks: Array<Omit<BookChunk, 'id' | 'bookId' | 'bookTitle'>>;
        extractionMethod?: 'text' | 'ocr' | 'manual';
        ocrCompleted?: boolean;
      }
    ): Promise<Book | null> => {
      const existing = data.books.find((b) => b.id === targetBookId);
      if (!existing || partInput.chunks.length === 0) return null;

      const canonicalTitle =
        parseBookSeriesIdentity(existing.title).seriesTitle || existing.title;

      const mergedPayload = buildMergedBookChunks([
        {
          title: existing.title,
          totalPages: existing.totalPages,
          chunks: existing.chunks.map((c) => ({
            chapter: c.chapter,
            pageNumber: c.pageNumber,
            chunkIndex: c.chunkIndex,
            content: c.content,
          })),
        },
        {
          title: `${canonicalTitle} (নতুন পার্ট)`,
          totalPages: partInput.totalPages,
          chunks: partInput.chunks,
        },
      ]);

      const newBookId = nextIdFrom(data.books, 100);
      let nextChunkId = nextIdFrom(
        data.books.flatMap((b) => b.chunks),
        1000
      );

      const updatedBook: Book = {
        id: newBookId,
        title: canonicalTitle,
        author: existing.author || 'ব্যক্তিগত নোট / গাইড',
        subject: existing.subject,
        category: existing.category,
        totalPages: mergedPayload.totalPages,
        extractionMethod:
          partInput.extractionMethod === 'ocr' || existing.extractionMethod === 'ocr'
            ? 'ocr'
            : existing.extractionMethod,
        ocrCompleted: Boolean(existing.ocrCompleted || partInput.ocrCompleted),
        driveFileId: null,
        driveWebViewLink: null,
        driveFileName: null,
        createdAt: existing.createdAt || new Date().toISOString().slice(0, 10),
        chunks: mergedPayload.chunks.map((c, idx) => ({
          id: nextChunkId++,
          bookId: newBookId,
          bookTitle: canonicalTitle,
          chapter: c.chapter,
          pageNumber: c.pageNumber,
          chunkIndex: idx,
          content: c.content,
        })),
      };

      const applyAppend = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        books: [updatedBook, ...prev.books.filter((b) => b.id !== existing.id)],
      });

      if (user) {
        setLifecycle((prev) => applyCloudOptimisticEditState(prev, applyAppend));
        setSelectedBookId(updatedBook.id);
        await runFirestoreMutation(async (activeUser) => {
          await createBookInFirestore(activeUser, updatedBook);
          await deleteBookInFirestore(
            activeUser,
            existing.id,
            existing.chunks.map((c) => c.id)
          );
        });
        return updatedBook;
      }

      applyGuestMutation(applyAppend);
      setSelectedBookId(updatedBook.id);
      return updatedBook;
    },
    [data.books, user, runFirestoreMutation, applyGuestMutation]
  );

  const getDriveAccessToken = useCallback(
    () => driveAccessTokenRef.current,
    []
  );

  const clearDriveSession = useCallback(() => {
    driveAccessTokenRef.current = null;
    setDriveConnected(false);
  }, []);

  const connectGoogleDrive = useCallback(async (): Promise<string | null> => {
    if (driveAccessTokenRef.current) {
      return driveAccessTokenRef.current;
    }
    await signInWithGoogle();
    return driveAccessTokenRef.current;
  }, [signInWithGoogle]);

  const updateBookDriveMeta = useCallback(
    async (bookId: number, drive: BookDriveMeta) => {
      const applyDriveMeta = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        books: prev.books.map((b) =>
          b.id === bookId
            ? {
                ...b,
                driveFileId: drive.driveFileId,
                driveWebViewLink: drive.driveWebViewLink,
                driveFileName: drive.driveFileName,
              }
            : b
        ),
      });

      if (user) {
        setLifecycle((prev) => applyCloudOptimisticEditState(prev, applyDriveMeta));
        await runFirestoreMutation((activeUser) =>
          updateBookDriveMetaInFirestore(activeUser, bookId, drive)
        );
        return;
      }

      applyGuestMutation(applyDriveMeta);
    },
    [user, runFirestoreMutation, applyGuestMutation]
  );

  const updateBookViewContent = useCallback(
    async (bookId: number, sourceChunkIds: number[], updatedContent: string) => {
      const targetBook = data.books.find((b) => b.id === bookId);
      if (!targetBook || sourceChunkIds.length === 0) return;

      const primaryId = sourceChunkIds[0];
      const redundantIds = sourceChunkIds.slice(1);
      const redundantSet = new Set(redundantIds);
      const primaryChunk = targetBook.chunks.find((c) => c.id === primaryId);
      if (!primaryChunk) return;

      const nextPrimaryChunk = {
        ...primaryChunk,
        content: updatedContent,
      };

      const applyContentUpdate = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        books: prev.books.map((b) => {
          if (b.id !== bookId) return b;
          const nextChunks = b.chunks
            .filter((c) => !redundantSet.has(c.id))
            .map((c) => (c.id === primaryId ? nextPrimaryChunk : c));
          return {
            ...b,
            chunks: nextChunks,
          };
        }),
      });

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, applyContentUpdate)
        );
        await runFirestoreMutation((activeUser) =>
          updateBookChunksInFirestore(
            activeUser,
            bookId,
            [nextPrimaryChunk],
            redundantIds
          )
        );
        return;
      }

      applyGuestMutation(applyContentUpdate);
    },
    [data.books, user, runFirestoreMutation, applyGuestMutation]
  );

  const deleteBook = useCallback(
    async (bookId: number) => {
      const targetBook = data.books.find((b) => b.id === bookId);
      const chunkIds = targetBook?.chunks.map((c) => c.id) ?? [];

      void offlineLibraryStore.removePdfForBook(offlineScopeKey, bookId);
      setCachedPdfsMeta((prev) => prev.filter((item) => item.bookId !== bookId));

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            books: ws.books.filter((b) => b.id !== bookId),
          }))
        );
        if (selectedBookId === bookId) {
          setSelectedBookId(null);
        }
        await runFirestoreMutation((activeUser) =>
          deleteBookInFirestore(activeUser, bookId, chunkIds)
        );
        return;
      }
      applyGuestMutation((prev) => ({
        ...prev,
        books: prev.books.filter((b) => b.id !== bookId),
      }));
      if (selectedBookId === bookId) {
        setSelectedBookId(null);
      }
    },
    [
      data.books,
      user,
      offlineScopeKey,
      runFirestoreMutation,
      selectedBookId,
      applyGuestMutation,
    ]
  );

  const addQuestions = useCallback(
    async (
      items: Array<Omit<Question, 'id' | 'createdAt'>>
    ): Promise<Question[]> => {
      const today = new Date().toISOString().slice(0, 10);
      let nextId = nextIdFrom(data.questions, 200);
      const created: Question[] = items.map((item) => ({
        ...item,
        id: nextId++,
        createdAt: today,
      }));

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            questions: [...created, ...ws.questions],
          }))
        );
        await runFirestoreMutation((activeUser) =>
          saveQuestionsInFirestore(activeUser, created)
        );
        return created;
      }

      applyGuestMutation((prev) => ({
        ...prev,
        questions: [...created, ...prev.questions],
      }));
      return created;
    },
    [data.questions, user, runFirestoreMutation, applyGuestMutation]
  );

  const deleteQuestion = useCallback(
    async (questionId: number) => {
      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            questions: ws.questions.filter((q) => q.id !== questionId),
          }))
        );
        await runFirestoreMutation((activeUser) =>
          deleteQuestionInFirestore(activeUser, questionId)
        );
        return;
      }
      applyGuestMutation((prev) => ({
        ...prev,
        questions: prev.questions.filter((q) => q.id !== questionId),
      }));
    },
    [user, runFirestoreMutation, applyGuestMutation]
  );

  const createExam = useCallback(
    async (input: {
      title: string;
      subject: string;
      examMode: ExamMode;
      durationMinutes: number;
      marksPerQuestion: number;
      negativeMark: number;
      questionIds: number[];
    }): Promise<Exam> => {
      const today = new Date().toISOString().slice(0, 10);
      const newExam: Exam = {
        ...input,
        id: nextIdFrom(data.exams, 300),
        status: 'draft',
        draftAnswers: {},
        createdAt: today,
      };

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            exams: [newExam, ...ws.exams],
          }))
        );
        await runFirestoreMutation((activeUser) =>
          createExamInFirestore(activeUser, newExam)
        );
        return newExam;
      }

      applyGuestMutation((prev) => ({
        ...prev,
        exams: [newExam, ...prev.exams],
      }));
      return newExam;
    },
    [data.exams, user, runFirestoreMutation, applyGuestMutation]
  );

  const deleteExam = useCallback(
    async (examId: number) => {
      const removeExam = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        exams: prev.exams.filter((ex) => ex.id !== examId),
      });
      setActiveExamId((prev) => (prev === examId ? null : prev));

      if (user) {
        setLifecycle((prev) => applyCloudOptimisticEditState(prev, removeExam));
        await runFirestoreMutation((activeUser) =>
          deleteExamInFirestore(activeUser, examId)
        );
        return;
      }

      applyGuestMutation(removeExam);
    },
    [user, runFirestoreMutation, applyGuestMutation]
  );

  const saveExamDraft = useCallback(
    async (examId: number, draftAnswers: Record<string, ExamAnswerDraft>) => {
      const targetExam = data.exams.find((ex) => ex.id === examId);
      const updateExams = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        exams: prev.exams.map((ex) =>
          ex.id === examId && ex.status !== 'completed'
            ? { ...ex, status: 'in_progress', draftAnswers }
            : ex
        ),
      });
      if (user) {
        setLifecycle((prev) => applyCloudOptimisticEditState(prev, updateExams));
        if (targetExam && targetExam.status !== 'completed') {
          await runFirestoreMutation((activeUser) =>
            saveExamDraftInFirestore(activeUser, examId, draftAnswers)
          );
        }
        return;
      }
      applyGuestMutation(updateExams);
    },
    [data.exams, user, runFirestoreMutation, applyGuestMutation]
  );

  const saveExamAttempt = useCallback(
    async (
      attempt: Omit<ExamAttempt, 'id' | 'submittedAt'>,
      newMistakes: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>>
    ): Promise<ExamAttempt> => {
      const nowIso = new Date().toISOString();
      const today = nowIso.slice(0, 10);
      const attemptId = nextIdFrom(data.attempts, 400);
      const createdAttempt: ExamAttempt = {
        ...attempt,
        id: attemptId,
        submittedAt: nowIso,
      };
      let nextMistakeId = nextIdFrom(data.mistakes, 500);
      const createdMistakes: MistakeItem[] = newMistakes.map((m) => ({
        ...m,
        id: nextMistakeId++,
        attemptId,
        createdAt: today,
      }));
      const matchingExam =
        attempt.examId !== null
          ? data.exams.find((ex) => ex.id === attempt.examId)
          : undefined;
      const examIdToComplete =
        matchingExam && matchingExam.status !== 'completed'
          ? matchingExam.id
          : null;

      const applyAttemptState = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        exams: prev.exams.map((ex) =>
          ex.id === attempt.examId
            ? { ...ex, status: 'completed', draftAnswers: {} }
            : ex
        ),
        attempts: [createdAttempt, ...prev.attempts],
        mistakes: [...createdMistakes, ...prev.mistakes],
      });

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, applyAttemptState)
        );
        setSelectedAttemptId(attemptId);
        await runFirestoreMutation((activeUser) =>
          saveExamAttemptInFirestore(
            activeUser,
            createdAttempt,
            createdMistakes,
            examIdToComplete
          )
        );
        return createdAttempt;
      }

      applyGuestMutation(applyAttemptState);
      setSelectedAttemptId(attemptId);
      return createdAttempt;
    },
    [
      data.attempts,
      data.exams,
      data.mistakes,
      user,
      runFirestoreMutation,
      applyGuestMutation,
    ]
  );

  const deleteExamAttempt = useCallback(
    async (attemptId: number) => {
      const remainingAttempts = data.attempts.filter((a) => a.id !== attemptId);
      const removeAttempt = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        attempts: prev.attempts.filter((a) => a.id !== attemptId),
      });

      setSelectedAttemptId((prev) =>
        prev === attemptId ? remainingAttempts[0]?.id ?? null : prev
      );

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, removeAttempt)
        );
        await runFirestoreMutation((activeUser) =>
          deleteExamAttemptInFirestore(activeUser, attemptId)
        );
        return;
      }

      applyGuestMutation(removeAttempt);
    },
    [data.attempts, user, runFirestoreMutation, applyGuestMutation]
  );

  const toggleMistakeMastered = useCallback(
    async (mistakeId: number) => {
      const target = data.mistakes.find((m) => m.id === mistakeId);
      if (!target) return;
      const nextMastered = !target.mastered;
      const nextReviewCount = target.reviewCount + 1;

      const updateMistakes = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        mistakes: prev.mistakes.map((m) =>
          m.id === mistakeId
            ? { ...m, mastered: nextMastered, reviewCount: nextReviewCount }
            : m
        ),
      });

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, updateMistakes)
        );
        await runFirestoreMutation((activeUser) =>
          toggleMistakeMasteredInFirestore(
            activeUser,
            mistakeId,
            nextMastered,
            nextReviewCount
          )
        );
        return;
      }

      applyGuestMutation(updateMistakes);
    },
    [data.mistakes, user, runFirestoreMutation, applyGuestMutation]
  );

  const deleteMistake = useCallback(
    async (mistakeId: number) => {
      const removeMistake = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        mistakes: prev.mistakes.filter((m) => m.id !== mistakeId),
      });

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, removeMistake)
        );
        await runFirestoreMutation((activeUser) =>
          deleteMistakeInFirestore(activeUser, mistakeId)
        );
        return;
      }

      applyGuestMutation(removeMistake);
    },
    [user, runFirestoreMutation, applyGuestMutation]
  );

  const addMistakeItems = useCallback(
    async (
      items: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>>
    ) => {
      if (items.length === 0) return;
      const today = new Date().toISOString().slice(0, 10);
      let nextId = nextIdFrom(data.mistakes, 500);
      const created: MistakeItem[] = items.map((item) => ({
        ...item,
        id: nextId++,
        attemptId: null,
        createdAt: today,
      }));
      const appendMistakes = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        mistakes: [...created, ...prev.mistakes],
      });

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, appendMistakes)
        );
        await runFirestoreMutation((activeUser) =>
          createMistakesInFirestore(activeUser, created)
        );
        return;
      }

      applyGuestMutation(appendMistakes);
    },
    [data.mistakes, user, runFirestoreMutation, applyGuestMutation]
  );

  const addGkItem = useCallback(
    async (input: {
      title: string;
      summary: string;
      category: string;
      eventDate: string;
      source: string;
      isArchived?: boolean;
    }) => {
      const today = new Date().toISOString().slice(0, 10);
      const item: CurrentGkItem = {
        id: nextIdFrom(data.gkItems, 600),
        title: input.title,
        summary: input.summary,
        category: input.category,
        eventDate: input.eventDate,
        source: input.source,
        isArchived: Boolean(input.isArchived),
        convertedToQuestions: false,
        createdAt: today,
      };
      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            gkItems: [item, ...ws.gkItems],
          }))
        );
        await runFirestoreMutation((activeUser) =>
          createGkInFirestore(activeUser, item)
        );
        return;
      }
      applyGuestMutation((prev) => ({
        ...prev,
        gkItems: [item, ...prev.gkItems],
      }));
    },
    [data.gkItems, user, runFirestoreMutation, applyGuestMutation]
  );

  const toggleGkArchive = useCallback(
    async (gkId: number) => {
      const target = data.gkItems.find((g) => g.id === gkId);
      if (!target) return;
      const nextArchived = !target.isArchived;
      const updateGk = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        gkItems: prev.gkItems.map((g) =>
          g.id === gkId ? { ...g, isArchived: nextArchived } : g
        ),
      });
      if (user) {
        setLifecycle((prev) => applyCloudOptimisticEditState(prev, updateGk));
        await runFirestoreMutation((activeUser) =>
          toggleGkArchiveInFirestore(activeUser, gkId, nextArchived)
        );
        return;
      }
      applyGuestMutation(updateGk);
    },
    [data.gkItems, user, runFirestoreMutation, applyGuestMutation]
  );

  const markGkConverted = useCallback(
    (gkId: number) => {
      const updateGk = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        gkItems: prev.gkItems.map((g) =>
          g.id === gkId ? { ...g, convertedToQuestions: true } : g
        ),
      });
      if (user) {
        setLifecycle((prev) => applyCloudOptimisticEditState(prev, updateGk));
        void runFirestoreMutation((activeUser) =>
          markGkConvertedInFirestore(activeUser, gkId)
        );
        return;
      }
      applyGuestMutation(updateGk);
    },
    [user, runFirestoreMutation, applyGuestMutation]
  );

  const deleteGkItem = useCallback(
    async (gkId: number) => {
      const removeGk = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        gkItems: prev.gkItems.filter((g) => g.id !== gkId),
      });

      if (user) {
        setLifecycle((prev) => applyCloudOptimisticEditState(prev, removeGk));
        await runFirestoreMutation((activeUser) =>
          deleteGkItemInFirestore(activeUser, gkId)
        );
        return;
      }

      applyGuestMutation(removeGk);
    },
    [user, runFirestoreMutation, applyGuestMutation]
  );

  const openSourceQuestionInReader = useCallback(
    (target: {
      bookId: number;
      pageNumber: number;
      examId?: string | null;
      questionText?: string | null;
    }) => {
      setSelectedBookId(target.bookId);
      setReaderJumpTarget({
        bookId: target.bookId,
        pageNumber: Math.max(1, target.pageNumber || 1),
        examId: target.examId ?? null,
        questionText: target.questionText ?? null,
        nonce: Date.now(),
      });
      setActiveModule('reader');
    },
    []
  );

  const clearReaderJumpTarget = useCallback(() => {
    setReaderJumpTarget(null);
  }, []);

  const addStudyTask = useCallback(
    async (input: {
      title: string;
      subject: string;
      chapter: string;
      taskType: 'reading' | 'revision' | 'practice' | 'exam';
      scheduledDate: string;
      durationMinutes: number;
    }) => {
      const today = new Date().toISOString().slice(0, 10);
      const task: StudyTask = {
        id: nextIdFrom(data.studyTasks, 700),
        ...input,
        completed: false,
        createdAt: today,
      };
      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            studyTasks: [task, ...ws.studyTasks],
          }))
        );
        await runFirestoreMutation((activeUser) =>
          createStudyTaskInFirestore(activeUser, task)
        );
        return;
      }
      applyGuestMutation((prev) => ({
        ...prev,
        studyTasks: [task, ...prev.studyTasks],
      }));
    },
    [data.studyTasks, user, runFirestoreMutation, applyGuestMutation]
  );

  const addStudyTasksBatch = useCallback(
    async (
      inputs: Array<{
        title: string;
        subject: string;
        chapter: string;
        taskType: 'reading' | 'revision' | 'practice' | 'exam';
        scheduledDate: string;
        durationMinutes: number;
      }>
    ): Promise<number> => {
      if (inputs.length === 0) return 0;
      const today = new Date().toISOString().slice(0, 10);
      let nextId = nextIdFrom(data.studyTasks, 700);
      const createdTasks: StudyTask[] = inputs.map((input) => ({
        id: nextId++,
        ...input,
        completed: false,
        createdAt: today,
      }));

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            studyTasks: [...createdTasks, ...ws.studyTasks],
          }))
        );
        await runFirestoreMutation(async (activeUser) => {
          for (const task of createdTasks) {
            await createStudyTaskInFirestore(activeUser, task);
          }
        });
        return createdTasks.length;
      }

      applyGuestMutation((prev) => ({
        ...prev,
        studyTasks: [...createdTasks, ...prev.studyTasks],
      }));
      return createdTasks.length;
    },
    [data.studyTasks, user, runFirestoreMutation, applyGuestMutation]
  );

  const updateStudyTask = useCallback(
    async (
      taskId: number,
      patch: Partial<
        Pick<
          StudyTask,
          | 'title'
          | 'subject'
          | 'chapter'
          | 'taskType'
          | 'scheduledDate'
          | 'durationMinutes'
        >
      >
    ) => {
      const updateTasks = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        studyTasks: prev.studyTasks.map((t) =>
          t.id === taskId ? { ...t, ...patch } : t
        ),
      });

      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, updateTasks)
        );
        await runFirestoreMutation((activeUser) =>
          updateStudyTaskInFirestore(activeUser, taskId, patch)
        );
        return;
      }

      applyGuestMutation(updateTasks);
    },
    [user, runFirestoreMutation, applyGuestMutation]
  );

  const toggleStudyTask = useCallback(
    async (taskId: number) => {
      const target = data.studyTasks.find((t) => t.id === taskId);
      if (!target) return;
      const nextCompleted = !target.completed;
      const updateTasks = (prev: WorkspaceData): WorkspaceData => ({
        ...prev,
        studyTasks: prev.studyTasks.map((t) =>
          t.id === taskId ? { ...t, completed: nextCompleted } : t
        ),
      });
      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, updateTasks)
        );
        await runFirestoreMutation((activeUser) =>
          toggleStudyTaskInFirestore(activeUser, taskId, nextCompleted)
        );
        return;
      }
      applyGuestMutation(updateTasks);
    },
    [data.studyTasks, user, runFirestoreMutation, applyGuestMutation]
  );

  const deleteStudyTask = useCallback(
    async (taskId: number) => {
      if (user) {
        setLifecycle((prev) =>
          applyCloudOptimisticEditState(prev, (ws) => ({
            ...ws,
            studyTasks: ws.studyTasks.filter((t) => t.id !== taskId),
          }))
        );
        await runFirestoreMutation((activeUser) =>
          deleteStudyTaskInFirestore(activeUser, taskId)
        );
        return;
      }
      applyGuestMutation((prev) => ({
        ...prev,
        studyTasks: prev.studyTasks.filter((t) => t.id !== taskId),
      }));
    },
    [user, runFirestoreMutation, applyGuestMutation]
  );

  const cacheBookPdfOffline = useCallback(
    async (
      bookId: number,
      bookTitle: string,
      file: Blob,
      fileName: string
    ): Promise<OfflinePdfMeta | null> => {
      try {
        const meta = await offlineLibraryStore.savePdfForBook({
          scopeKey: offlineScopeKey,
          bookId,
          bookTitle,
          file,
          fileName,
        });
        setCachedPdfsMeta((prev) => [
          meta,
          ...prev.filter((item) => item.bookId !== bookId),
        ]);
        return meta;
      } catch {
        return null;
      }
    },
    [offlineScopeKey]
  );

  const getCachedBookPdf = useCallback(
    async (bookId: number): Promise<OfflinePdfBlobRecord | null> => {
      return offlineLibraryStore.getPdfForBook(offlineScopeKey, bookId);
    },
    [offlineScopeKey]
  );

  const removeCachedBookPdf = useCallback(
    async (bookId: number): Promise<void> => {
      await offlineLibraryStore.removePdfForBook(offlineScopeKey, bookId);
      setCachedPdfsMeta((prev) => prev.filter((item) => item.bookId !== bookId));
    },
    [offlineScopeKey]
  );

  const syncAllOfflineMaterials = useCallback(async () => {
    const [record, swStatus] = await Promise.all([
      offlineLibraryStore.saveWorkspaceSnapshot(offlineScopeKey, data),
      warmCurrentAppAssetsInSw(),
    ]);
    if (record) {
      setOfflineSavedAt(record.savedAt);
    }
    return {
      savedAt: record?.savedAt ?? offlineSavedAt,
      swStatus,
    };
  }, [offlineScopeKey, data, offlineSavedAt]);

  const uploadDriveTarget = useMemo(
    () => resolveUploadDriveTarget(user?.email),
    [user?.email]
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      data,
      user,
      authLoading,
      authStatus,
      authError,
      clearAuthError,
      syncing,
      syncError,
      retryCloudSync,
      aiAuthPrompt,
      requestAiSignIn,
      dismissAiAuthPrompt,
      getAiAuthHeaders,
      driveConnected,
      driveSyncEnabled: driveSyncEnabledState,
      setDriveSyncEnabled,
      driveFolderId: uploadDriveTarget.folderId,
      driveFolderUrl: uploadDriveTarget.folderUrl,
      driveFolderLabel: uploadDriveTarget.label,
      isOwnerDriveFolder: uploadDriveTarget.isOwnerFolder,
      driveImportFolderId: EXISTING_LIBRARY_DRIVE_FOLDER_ID,
      driveImportFolderUrl: EXISTING_LIBRARY_DRIVE_FOLDER_URL,
      getDriveAccessToken,
      clearDriveSession,
      connectGoogleDrive,
      activeModule,
      setActiveModule,
      selectedBookId,
      setSelectedBookId,
      activeExamId,
      setActiveExamId,
      selectedAttemptId,
      setSelectedAttemptId,
      readerJumpTarget,
      openSourceQuestionInReader,
      clearReaderJumpTarget,
      signInWithGoogle,
      signOutUser,
      addBook,
      mergeBooksIntoSeries,
      appendPartToBook,
      updateBookDriveMeta,
      updateBookViewContent,
      deleteBook,
      addQuestions,
      deleteQuestion,
      createExam,
      deleteExam,
      saveExamDraft,
      saveExamAttempt,
      deleteExamAttempt,
      toggleMistakeMastered,
      deleteMistake,
      addMistakeItems,
      addGkItem,
      toggleGkArchive,
      markGkConverted,
      deleteGkItem,
      addStudyTask,
      addStudyTasksBatch,
      updateStudyTask,
      toggleStudyTask,
      deleteStudyTask,
      offlineScopeKey,
      offlineSavedAt,
      usingOfflineSnapshot,
      cachedPdfsMeta,
      cacheBookPdfOffline,
      getCachedBookPdf,
      removeCachedBookPdf,
      syncAllOfflineMaterials,
    }),
    [
      data,
      user,
      authLoading,
      authStatus,
      authError,
      clearAuthError,
      syncing,
      syncError,
      retryCloudSync,
      aiAuthPrompt,
      requestAiSignIn,
      dismissAiAuthPrompt,
      getAiAuthHeaders,
      driveConnected,
      driveSyncEnabledState,
      setDriveSyncEnabled,
      uploadDriveTarget,
      getDriveAccessToken,
      clearDriveSession,
      connectGoogleDrive,
      activeModule,
      selectedBookId,
      activeExamId,
      selectedAttemptId,
      readerJumpTarget,
      openSourceQuestionInReader,
      clearReaderJumpTarget,
      signInWithGoogle,
      signOutUser,
      addBook,
      mergeBooksIntoSeries,
      appendPartToBook,
      updateBookDriveMeta,
      updateBookViewContent,
      deleteBook,
      addQuestions,
      deleteQuestion,
      createExam,
      deleteExam,
      saveExamDraft,
      saveExamAttempt,
      deleteExamAttempt,
      toggleMistakeMastered,
      deleteMistake,
      addMistakeItems,
      addGkItem,
      toggleGkArchive,
      markGkConverted,
      deleteGkItem,
      addStudyTask,
      addStudyTasksBatch,
      updateStudyTask,
      toggleStudyTask,
      deleteStudyTask,
      offlineScopeKey,
      offlineSavedAt,
      usingOfflineSnapshot,
      cachedPdfsMeta,
      cacheBookPdfOffline,
      getCachedBookPdf,
      removeCachedBookPdf,
      syncAllOfflineMaterials,
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used inside WorkspaceProvider');
  }
  return ctx;
}
