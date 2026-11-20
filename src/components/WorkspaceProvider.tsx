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
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, googleAuthProvider } from '@/src/lib/firebase';
import { createInitialSeedData } from '@/src/lib/seed-data';
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

const LOCAL_STORAGE_KEY = 'prostuti_ai_workspace_v1';

interface CreateBookInput {
  title: string;
  author: string;
  subject: string;
  category: BookCategory;
  totalPages: number;
  extractionMethod: 'text' | 'ocr' | 'manual';
  ocrCompleted: boolean;
  chunks: Array<Omit<BookChunk, 'id' | 'bookId' | 'bookTitle'>>;
}

interface WorkspaceContextValue {
  data: WorkspaceData;
  user: User | null;
  authLoading: boolean;
  syncing: boolean;
  syncError: string | null;
  activeModule: ModuleId;
  setActiveModule: (m: ModuleId) => void;
  selectedBookId: number | null;
  setSelectedBookId: (id: number | null) => void;
  activeExamId: number | null;
  setActiveExamId: (id: number | null) => void;
  selectedAttemptId: number | null;
  setSelectedAttemptId: (id: number | null) => void;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  addBook: (input: CreateBookInput) => Promise<Book>;
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
  saveExamDraft: (
    examId: number,
    draftAnswers: Record<string, ExamAnswerDraft>
  ) => Promise<void>;
  saveExamAttempt: (
    attempt: Omit<ExamAttempt, 'id' | 'submittedAt'>,
    newMistakes: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>>
  ) => Promise<ExamAttempt>;
  toggleMistakeMastered: (mistakeId: number) => Promise<void>;
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
  addStudyTask: (input: {
    title: string;
    subject: string;
    chapter: string;
    taskType: 'reading' | 'revision' | 'practice' | 'exam';
    scheduledDate: string;
    durationMinutes: number;
  }) => Promise<void>;
  toggleStudyTask: (taskId: number) => Promise<void>;
  deleteStudyTask: (taskId: number) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function nextIdFrom<T extends { id: number }>(items: T[], base: number): number {
  return items.reduce((max, item) => Math.max(max, item.id), base) + 1;
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<WorkspaceData>(() => createInitialSeedData());
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [activeModule, setActiveModule] = useState<ModuleId>('library');
  const [selectedBookId, setSelectedBookId] = useState<number | null>(101);
  const [activeExamId, setActiveExamId] = useState<number | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<number | null>(401);

  // Store Firebase ID Token strictly in memory (never localStorage)
  const idTokenRef = useRef<string | null>(null);
  const hydratedLocalRef = useRef(false);

  // Persist guest workspace edits locally when unauthenticated
  useEffect(() => {
    if (!hydratedLocalRef.current || user) return;
    try {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore quota errors
    }
  }, [data, user]);

  const fetchAuthenticatedWorkspace = useCallback(async (firebaseUser: User) => {
    setSyncing(true);
    setSyncError(null);
    try {
      const token = await firebaseUser.getIdToken();
      idTokenRef.current = token;
      const res = await fetch('/api/workspace', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error('ক্লাউড ডাটাবেস থেকে তথ্য লোড করা যায়নি।');
      }
      const json = await res.json();
      if (json.workspace) {
        setData(json.workspace);
        if (json.workspace.books?.[0]) {
          setSelectedBookId(json.workspace.books[0].id);
        }
        if (json.workspace.attempts?.[0]) {
          setSelectedAttemptId(json.workspace.attempts[0].id);
        }
      }
    } catch (err) {
      setSyncError(
        err instanceof Error ? err.message : 'ডাটাবেস সিঙ্ক ব্যর্থ হয়েছে।'
      );
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
      setUser(fbUser);
      setAuthLoading(false);
      if (fbUser) {
        hydratedLocalRef.current = true;
        void fetchAuthenticatedWorkspace(fbUser);
      } else {
        idTokenRef.current = null;
        if (!hydratedLocalRef.current) {
          hydratedLocalRef.current = true;
          try {
            const saved = window.localStorage.getItem(LOCAL_STORAGE_KEY);
            if (saved) {
              const parsed = JSON.parse(saved) as WorkspaceData;
              if (parsed && Array.isArray(parsed.books)) {
                setData(parsed);
                if (parsed.books[0]) setSelectedBookId(parsed.books[0].id);
                if (parsed.attempts[0]) {
                  setSelectedAttemptId(parsed.attempts[0].id);
                }
              }
            }
          } catch {
            // Ignore storage parsing issues
          }
        }
      }
    });
    return () => unsubscribe();
  }, [fetchAuthenticatedWorkspace]);

  const syncToCloud = useCallback(
    async (action: string, payload: Record<string, unknown>) => {
      if (!user) return null;
      setSyncing(true);
      setSyncError(null);
      try {
        const token = await user.getIdToken();
        idTokenRef.current = token;
        const res = await fetch('/api/workspace', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action, payload }),
        });
        if (!res.ok) {
          throw new Error('সার্ভারে তথ্য সংরক্ষণ করা যায়নি।');
        }
        const json = await res.json();
        if (json.workspace) {
          setData(json.workspace);
          return json.workspace as WorkspaceData;
        }
        return null;
      } catch (err) {
        setSyncError(
          err instanceof Error ? err.message : 'ডাটাবেস আপডেট ব্যর্থ হয়েছে।'
        );
        return null;
      } finally {
        setSyncing(false);
      }
    },
    [user]
  );

  const signInWithGoogle = useCallback(async () => {
    setSyncError(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err) {
      setSyncError(
        err instanceof Error
          ? err.message
          : 'Google সাইন-ইন সম্পন্ন করা যায়নি।'
      );
    }
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
    idTokenRef.current = null;
    setData(createInitialSeedData());
  }, []);

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

      if (user) {
        const updated = await syncToCloud('create_book', {
          ...input,
        });
        const created = updated?.books[0] ?? newBook;
        setSelectedBookId(created.id);
        return created;
      }

      setData((prev) => ({
        ...prev,
        books: [newBook, ...prev.books],
      }));
      setSelectedBookId(newBook.id);
      return newBook;
    },
    [data.books, user, syncToCloud]
  );

  const deleteBook = useCallback(
    async (bookId: number) => {
      if (user) {
        await syncToCloud('delete_book', { id: bookId });
        return;
      }
      setData((prev) => ({
        ...prev,
        books: prev.books.filter((b) => b.id !== bookId),
      }));
      if (selectedBookId === bookId) {
        setSelectedBookId(null);
      }
    },
    [user, syncToCloud, selectedBookId]
  );

  const addQuestions = useCallback(
    async (
      items: Array<Omit<Question, 'id' | 'createdAt'>>
    ): Promise<Question[]> => {
      const today = new Date().toISOString().slice(0, 10);
      if (user) {
        const updated = await syncToCloud('save_questions', { items });
        return updated?.questions.slice(0, items.length) ?? [];
      }

      let nextId = nextIdFrom(data.questions, 200);
      const created: Question[] = items.map((item) => ({
        ...item,
        id: nextId++,
        createdAt: today,
      }));
      setData((prev) => ({
        ...prev,
        questions: [...created, ...prev.questions],
      }));
      return created;
    },
    [data.questions, user, syncToCloud]
  );

  const deleteQuestion = useCallback(
    async (questionId: number) => {
      if (user) {
        await syncToCloud('delete_question', { id: questionId });
        return;
      }
      setData((prev) => ({
        ...prev,
        questions: prev.questions.filter((q) => q.id !== questionId),
      }));
    },
    [user, syncToCloud]
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
      if (user) {
        const updated = await syncToCloud('create_exam', input);
        return (
          updated?.exams[0] ?? {
            ...input,
            id: Date.now(),
            status: 'draft',
            draftAnswers: {},
            createdAt: today,
          }
        );
      }

      const newExam: Exam = {
        ...input,
        id: nextIdFrom(data.exams, 300),
        status: 'draft',
        draftAnswers: {},
        createdAt: today,
      };
      setData((prev) => ({
        ...prev,
        exams: [newExam, ...prev.exams],
      }));
      return newExam;
    },
    [data.exams, user, syncToCloud]
  );

  const saveExamDraft = useCallback(
    async (examId: number, draftAnswers: Record<string, ExamAnswerDraft>) => {
      setData((prev) => ({
        ...prev,
        exams: prev.exams.map((ex) =>
          ex.id === examId
            ? { ...ex, status: 'in_progress', draftAnswers }
            : ex
        ),
      }));
      if (user) {
        await syncToCloud('save_exam_draft', { examId, draftAnswers });
      }
    },
    [user, syncToCloud]
  );

  const saveExamAttempt = useCallback(
    async (
      attempt: Omit<ExamAttempt, 'id' | 'submittedAt'>,
      newMistakes: Array<Omit<MistakeItem, 'id' | 'attemptId' | 'createdAt'>>
    ): Promise<ExamAttempt> => {
      const nowIso = new Date().toISOString();
      const today = nowIso.slice(0, 10);

      if (user) {
        const updated = await syncToCloud('save_attempt', {
          ...attempt,
          mistakes: newMistakes,
        });
        const saved = updated?.attempts[0] ?? {
          ...attempt,
          id: Date.now(),
          submittedAt: nowIso,
        };
        setSelectedAttemptId(saved.id);
        return saved;
      }

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

      setData((prev) => ({
        ...prev,
        exams: prev.exams.map((ex) =>
          ex.id === attempt.examId
            ? { ...ex, status: 'completed', draftAnswers: {} }
            : ex
        ),
        attempts: [createdAttempt, ...prev.attempts],
        mistakes: [...createdMistakes, ...prev.mistakes],
      }));
      setSelectedAttemptId(attemptId);
      return createdAttempt;
    },
    [data.attempts, data.mistakes, user, syncToCloud]
  );

  const toggleMistakeMastered = useCallback(
    async (mistakeId: number) => {
      const target = data.mistakes.find((m) => m.id === mistakeId);
      if (!target) return;
      const nextMastered = !target.mastered;
      const nextReviewCount = target.reviewCount + 1;

      if (user) {
        await syncToCloud('toggle_mistake', {
          id: mistakeId,
          mastered: nextMastered,
          reviewCount: nextReviewCount,
        });
        return;
      }

      setData((prev) => ({
        ...prev,
        mistakes: prev.mistakes.map((m) =>
          m.id === mistakeId
            ? { ...m, mastered: nextMastered, reviewCount: nextReviewCount }
            : m
        ),
      }));
    },
    [data.mistakes, user, syncToCloud]
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
      if (user) {
        await syncToCloud('create_gk', input);
        return;
      }
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
      setData((prev) => ({
        ...prev,
        gkItems: [item, ...prev.gkItems],
      }));
    },
    [data.gkItems, user, syncToCloud]
  );

  const toggleGkArchive = useCallback(
    async (gkId: number) => {
      const target = data.gkItems.find((g) => g.id === gkId);
      if (!target) return;
      if (user) {
        await syncToCloud('toggle_gk_archive', {
          id: gkId,
          isArchived: !target.isArchived,
        });
        return;
      }
      setData((prev) => ({
        ...prev,
        gkItems: prev.gkItems.map((g) =>
          g.id === gkId ? { ...g, isArchived: !g.isArchived } : g
        ),
      }));
    },
    [data.gkItems, user, syncToCloud]
  );

  const markGkConverted = useCallback((gkId: number) => {
    setData((prev) => ({
      ...prev,
      gkItems: prev.gkItems.map((g) =>
        g.id === gkId ? { ...g, convertedToQuestions: true } : g
      ),
    }));
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
      if (user) {
        await syncToCloud('create_task', input);
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const task: StudyTask = {
        id: nextIdFrom(data.studyTasks, 700),
        ...input,
        completed: false,
        createdAt: today,
      };
      setData((prev) => ({
        ...prev,
        studyTasks: [task, ...prev.studyTasks],
      }));
    },
    [data.studyTasks, user, syncToCloud]
  );

  const toggleStudyTask = useCallback(
    async (taskId: number) => {
      const target = data.studyTasks.find((t) => t.id === taskId);
      if (!target) return;
      if (user) {
        await syncToCloud('toggle_task', {
          id: taskId,
          completed: !target.completed,
        });
        return;
      }
      setData((prev) => ({
        ...prev,
        studyTasks: prev.studyTasks.map((t) =>
          t.id === taskId ? { ...t, completed: !t.completed } : t
        ),
      }));
    },
    [data.studyTasks, user, syncToCloud]
  );

  const deleteStudyTask = useCallback(
    async (taskId: number) => {
      if (user) {
        await syncToCloud('delete_task', { id: taskId });
        return;
      }
      setData((prev) => ({
        ...prev,
        studyTasks: prev.studyTasks.filter((t) => t.id !== taskId),
      }));
    },
    [user, syncToCloud]
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      data,
      user,
      authLoading,
      syncing,
      syncError,
      activeModule,
      setActiveModule,
      selectedBookId,
      setSelectedBookId,
      activeExamId,
      setActiveExamId,
      selectedAttemptId,
      setSelectedAttemptId,
      signInWithGoogle,
      signOutUser,
      addBook,
      deleteBook,
      addQuestions,
      deleteQuestion,
      createExam,
      saveExamDraft,
      saveExamAttempt,
      toggleMistakeMastered,
      addGkItem,
      toggleGkArchive,
      markGkConverted,
      addStudyTask,
      toggleStudyTask,
      deleteStudyTask,
    }),
    [
      data,
      user,
      authLoading,
      syncing,
      syncError,
      activeModule,
      selectedBookId,
      activeExamId,
      selectedAttemptId,
      signInWithGoogle,
      signOutUser,
      addBook,
      deleteBook,
      addQuestions,
      deleteQuestion,
      createExam,
      saveExamDraft,
      saveExamAttempt,
      toggleMistakeMastered,
      addGkItem,
      toggleGkArchive,
      markGkConverted,
      addStudyTask,
      toggleStudyTask,
      deleteStudyTask,
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
