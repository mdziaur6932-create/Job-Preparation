import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getDocsFromServer,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  FIRESTORE_BLUEPRINT_LIMITS,
  handleFirestoreError,
  OperationType,
} from './firestore-errors';
import {
  decideWorkspaceLoadAction,
  isFirestoreOfflineOrUnavailableError,
} from './firestore-sync-guards';
import { createInitialSeedData } from './seed-data';
import type {
  Book,
  BookCategory,
  BookChunk,
  CurrentGkItem,
  DifficultyLevel,
  Exam,
  ExamAnswerDraft,
  ExamAttempt,
  ExamMode,
  MistakeItem,
  Question,
  QuestionEvaluation,
  QuestionType,
  StudyTask,
  WorkspaceData,
} from '@/src/types/system';

const VALID_BOOK_CATEGORIES = new Set<BookCategory>([
  'BCS',
  'Bank',
  'Primary',
  'Current GK',
  'Previous Year',
  'রিসেন্ট জব সলুশন',
  'বিষয়ভিত্তিক মূল বই',
  'অন্যান্য',
]);

const VALID_EXTRACTION_METHODS = new Set<Book['extractionMethod']>([
  'text',
  'ocr',
  'manual',
]);

const VALID_QUESTION_TYPES = new Set<QuestionType>([
  'MCQ',
  'Written',
  'Short',
]);

const VALID_DIFFICULTIES = new Set<DifficultyLevel>(['Easy', 'Medium', 'Hard']);

const VALID_EXAM_MODES = new Set<ExamMode>(['MCQ', 'Written', 'Mixed']);

const VALID_EXAM_STATUSES = new Set<Exam['status']>([
  'draft',
  'in_progress',
  'completed',
]);

const VALID_TASK_TYPES = new Set<StudyTask['taskType']>([
  'reading',
  'revision',
  'practice',
  'exam',
]);

const MAX_BATCH_OPS = 400;

function assertValidUid(uid: string): string {
  const clean = uid.trim();
  if (!FIRESTORE_BLUEPRINT_LIMITS.UID_PATTERN.test(clean)) {
    throw new Error('Invalid Firebase UID for Firestore workspace path.');
  }
  return clean;
}

function clampString(value: unknown, maxLen: number, fallback = ''): string {
  const raw = typeof value === 'string' ? value : fallback;
  return raw.trim().slice(0, maxLen);
}

function clampNonEmptyString(
  value: unknown,
  maxLen: number,
  fallback: string
): string {
  const trimmed = clampString(value, maxLen, '');
  return trimmed.length > 0 ? trimmed : fallback.slice(0, maxLen);
}

function clampNullableString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null;
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function clampPositiveInt(value: unknown, fallback = 1): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return n > 0 ? n : fallback;
}

function clampNullableInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function clampNonNegativeNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return n >= 0 ? n : fallback;
}

function clampFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeDraftAnswers(
  draftAnswers: Record<string, ExamAnswerDraft> | undefined
): Record<string, ExamAnswerDraft> {
  const result: Record<string, ExamAnswerDraft> = {};
  if (!draftAnswers || typeof draftAnswers !== 'object') return result;
  for (const [key, val] of Object.entries(draftAnswers)) {
    if (!val || typeof val !== 'object') continue;
    const cleanEntry: ExamAnswerDraft = {};
    if (typeof val.selectedOption === 'number' && Number.isFinite(val.selectedOption)) {
      cleanEntry.selectedOption = Math.round(val.selectedOption);
    }
    if (typeof val.writtenText === 'string') {
      cleanEntry.writtenText = val.writtenText.slice(0, 8000);
    }
    result[String(key).slice(0, 64)] = cleanEntry;
  }
  return result;
}

function sanitizeEvaluations(evaluations: QuestionEvaluation[]): QuestionEvaluation[] {
  return (Array.isArray(evaluations) ? evaluations : [])
    .slice(0, 300)
    .map((ev) => ({
      questionId: clampPositiveInt(ev.questionId, 1),
      questionType: VALID_QUESTION_TYPES.has(ev.questionType)
        ? ev.questionType
        : 'MCQ',
      stem: clampString(ev.stem, 4000),
      subject: clampString(ev.subject, 160),
      chapter: clampString(ev.chapter, 240),
      bookTitle: clampString(ev.bookTitle, 240),
      pageNumber: clampInt(ev.pageNumber, 1, 50000, 1),
      maxMarks: clampNonNegativeNumber(ev.maxMarks, 1),
      awardedMarks: clampFiniteNumber(ev.awardedMarks, 0),
      negativeApplied: clampNonNegativeNumber(ev.negativeApplied, 0),
      status:
        ev.status === 'correct' ||
        ev.status === 'wrong' ||
        ev.status === 'skipped' ||
        ev.status === 'partial'
          ? ev.status
          : 'skipped',
      userAnswer: clampString(ev.userAnswer, 4000),
      correctAnswer: clampString(ev.correctAnswer, 4000),
      modelAnswer: clampString(ev.modelAnswer, 4000),
      mistakeExplanation: clampString(ev.mistakeExplanation, 4000),
      improvementTip: clampString(ev.improvementTip, 4000),
    }));
}

function toBookRecordPayload(uid: string, book: Book) {
  const category: BookCategory = VALID_BOOK_CATEGORIES.has(book.category)
    ? book.category
    : 'BCS';
  const extractionMethod: Book['extractionMethod'] =
    VALID_EXTRACTION_METHODS.has(book.extractionMethod)
      ? book.extractionMethod
      : 'text';
  return {
    uid,
    id: clampPositiveInt(book.id, 1),
    title: clampNonEmptyString(book.title, 240, 'শিরোনামহীন বই'),
    author: clampString(book.author, 160, 'অজানা লেখক'),
    subject: clampNonEmptyString(book.subject, 160, 'সাধারণ প্রস্তুতি'),
    category,
    totalPages: clampInt(book.totalPages, 1, 10000, 1),
    extractionMethod,
    ocrCompleted: Boolean(book.ocrCompleted),
    driveFileId: clampNullableString(book.driveFileId, 200),
    driveWebViewLink: clampNullableString(book.driveWebViewLink, 500),
    driveFileName: clampNullableString(book.driveFileName, 200),
    createdDate: clampString(
      book.createdAt || new Date().toISOString().slice(0, 10),
      32
    ),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function toBookChunkRecordPayload(uid: string, chunk: BookChunk) {
  return {
    uid,
    id: clampPositiveInt(chunk.id, 1),
    bookId: clampPositiveInt(chunk.bookId, 1),
    bookTitle: clampString(chunk.bookTitle, 240),
    chapter: clampString(chunk.chapter, 240),
    pageNumber: clampInt(chunk.pageNumber, 1, 50000, 1),
    chunkIndex: clampInt(chunk.chunkIndex, 0, 50000, 0),
    content: clampNonEmptyString(chunk.content, 40000, ' '),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function toQuestionRecordPayload(uid: string, q: Question) {
  const questionType: QuestionType = VALID_QUESTION_TYPES.has(q.questionType)
    ? q.questionType
    : 'MCQ';
  const difficulty: DifficultyLevel = VALID_DIFFICULTIES.has(q.difficulty)
    ? q.difficulty
    : 'Medium';
  const cleanOptions = (Array.isArray(q.options) ? q.options : [])
    .slice(0, 10)
    .map((o) => clampString(o, 1000));
  return {
    uid,
    id: clampPositiveInt(q.id, 1),
    bookId: clampNullableInt(q.bookId),
    bookTitle: clampString(q.bookTitle, 240),
    chapter: clampString(q.chapter, 240),
    pageNumber: clampInt(q.pageNumber, 1, 50000, 1),
    subject: clampString(q.subject, 160),
    questionType,
    difficulty,
    stem: clampNonEmptyString(q.stem, 4000, 'প্রশ্ন'),
    options: cleanOptions,
    correctOptionIndex: clampNullableInt(q.correctOptionIndex),
    modelAnswer: clampString(q.modelAnswer, 8000),
    explanation: clampString(q.explanation, 8000),
    isPreviousYear: Boolean(q.isPreviousYear),
    examYear: clampNullableString(q.examYear, 40),
    examSource: clampNullableString(q.examSource, 160),
    importanceScore: clampInt(q.importanceScore, 0, 100, 80),
    createdDate: clampString(
      q.createdAt || new Date().toISOString().slice(0, 10),
      32
    ),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function toExamRecordPayload(uid: string, ex: Exam) {
  const examMode: ExamMode = VALID_EXAM_MODES.has(ex.examMode)
    ? ex.examMode
    : 'MCQ';
  const status: Exam['status'] = VALID_EXAM_STATUSES.has(ex.status)
    ? ex.status
    : 'draft';
  const questionIds = (Array.isArray(ex.questionIds) ? ex.questionIds : [])
    .slice(0, 300)
    .map((id) => clampPositiveInt(id, 1));
  return {
    uid,
    id: clampPositiveInt(ex.id, 1),
    title: clampNonEmptyString(ex.title, 240, 'মডেল টেস্ট'),
    subject: clampString(ex.subject, 160),
    examMode,
    durationMinutes: clampInt(ex.durationMinutes, 1, 600, 15),
    marksPerQuestion: clampNonNegativeNumber(ex.marksPerQuestion, 1),
    negativeMark: clampNonNegativeNumber(ex.negativeMark, 0),
    questionIds,
    status,
    draftAnswers: sanitizeDraftAnswers(ex.draftAnswers),
    createdDate: clampString(
      ex.createdAt || new Date().toISOString().slice(0, 10),
      32
    ),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function toExamAttemptRecordPayload(uid: string, a: ExamAttempt) {
  const weakTopics = (Array.isArray(a.weakTopics) ? a.weakTopics : [])
    .slice(0, 50)
    .map((t) => clampString(t, 240));
  return {
    uid,
    id: clampPositiveInt(a.id, 1),
    examId: clampNullableInt(a.examId),
    examTitle: clampNonEmptyString(a.examTitle, 240, 'পরীক্ষা'),
    subject: clampString(a.subject, 160),
    totalMarks: clampFiniteNumber(a.totalMarks, 0),
    obtainedMarks: clampFiniteNumber(a.obtainedMarks, 0),
    negativeDeduction: clampFiniteNumber(a.negativeDeduction, 0),
    correctCount: clampInt(a.correctCount, 0, 10000, 0),
    wrongCount: clampInt(a.wrongCount, 0, 10000, 0),
    skippedCount: clampInt(a.skippedCount, 0, 10000, 0),
    mcqAccuracy: clampFiniteNumber(a.mcqAccuracy, 0),
    writtenScore: clampFiniteNumber(a.writtenScore, 0),
    durationSeconds: clampInt(a.durationSeconds, 0, 86400, 0),
    evaluations: sanitizeEvaluations(a.evaluations),
    weakTopics,
    aiRecommendation: clampString(a.aiRecommendation, 8000),
    submittedAtIso: clampString(
      a.submittedAt || new Date().toISOString(),
      64
    ),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function toMistakeRecordPayload(uid: string, m: MistakeItem) {
  return {
    uid,
    id: clampPositiveInt(m.id, 1),
    questionId: clampNullableInt(m.questionId),
    attemptId: clampNullableInt(m.attemptId),
    questionStem: clampNonEmptyString(m.questionStem, 4000, 'প্রশ্ন'),
    subject: clampString(m.subject, 160),
    chapter: clampString(m.chapter, 240),
    userAnswer: clampString(m.userAnswer, 4000),
    correctAnswer: clampString(m.correctAnswer, 4000),
    reason: clampString(m.reason, 4000),
    mastered: Boolean(m.mastered),
    reviewCount: clampInt(m.reviewCount, 0, 100000, 0),
    nextReviewDate: clampString(
      m.nextReviewDate || new Date().toISOString().slice(0, 10),
      32
    ),
    createdDate: clampString(
      m.createdAt || new Date().toISOString().slice(0, 10),
      32
    ),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function toGkRecordPayload(uid: string, g: CurrentGkItem) {
  return {
    uid,
    id: clampPositiveInt(g.id, 1),
    title: clampNonEmptyString(g.title, 240, 'সাম্প্রতিক তথ্য'),
    summary: clampString(g.summary, 6000),
    category: clampString(g.category, 120),
    eventDate: clampString(g.eventDate, 32),
    source: clampString(g.source, 200),
    isArchived: Boolean(g.isArchived),
    convertedToQuestions: Boolean(g.convertedToQuestions),
    createdDate: clampString(
      g.createdAt || new Date().toISOString().slice(0, 10),
      32
    ),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function toStudyTaskRecordPayload(uid: string, t: StudyTask) {
  const taskType: StudyTask['taskType'] = VALID_TASK_TYPES.has(t.taskType)
    ? t.taskType
    : 'reading';
  return {
    uid,
    id: clampPositiveInt(t.id, 1),
    title: clampNonEmptyString(t.title, 240, 'অধ্যয়ন কাজ'),
    subject: clampString(t.subject, 160),
    chapter: clampString(t.chapter, 240),
    taskType,
    scheduledDate: clampString(
      t.scheduledDate || new Date().toISOString().slice(0, 10),
      32
    ),
    durationMinutes: clampInt(t.durationMinutes, 1, 1440, 30),
    completed: Boolean(t.completed),
    createdDate: clampString(
      t.createdAt || new Date().toISOString().slice(0, 10),
      32
    ),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

async function listUserCollection(
  uid: string,
  collectionName: string
): Promise<{ docs: DocumentData[]; fromCache: boolean }> {
  const path = `users/${uid}/${collectionName}`;
  const q = query(
    collection(db, 'users', uid, collectionName),
    where('uid', '==', uid)
  );
  try {
    const snap = await getDocsFromServer(q);
    return {
      docs: snap.docs.map((d) => d.data()),
      fromCache: false,
    };
  } catch (serverError) {
    if (isFirestoreOfflineOrUnavailableError(serverError)) {
      try {
        const cachedSnap = await getDocs(q);
        return {
          docs: cachedSnap.docs.map((d) => d.data()),
          fromCache: cachedSnap.metadata.fromCache,
        };
      } catch (cacheError) {
        if (isFirestoreOfflineOrUnavailableError(cacheError)) {
          return { docs: [], fromCache: true };
        }
        handleFirestoreError(cacheError, OperationType.LIST, path);
      }
    }
    handleFirestoreError(serverError, OperationType.LIST, path);
  }
}

async function commitBatchedWrites(
  operations: Array<{
    type: 'set' | 'delete';
    pathSegments: [string, string, string, string];
    payload?: Record<string, unknown>;
  }>,
  operationType: OperationType,
  errorPath: string
): Promise<void> {
  try {
    for (let i = 0; i < operations.length; i += MAX_BATCH_OPS) {
      const slice = operations.slice(i, i + MAX_BATCH_OPS);
      const batch = writeBatch(db);
      for (const op of slice) {
        const ref = doc(db, ...op.pathSegments);
        if (op.type === 'set' && op.payload) {
          batch.set(ref, op.payload);
        } else if (op.type === 'delete') {
          batch.delete(ref);
        }
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, operationType, errorPath);
  }
}

const seedingPromisesByUid = new Map<string, Promise<WorkspaceData>>();

async function seedWorkspaceInFirestore(uid: string): Promise<WorkspaceData> {
  const existingPromise = seedingPromisesByUid.get(uid);
  if (existingPromise) return existingPromise;

  const task = (async () => {
    const seed = createInitialSeedData();
    const ops: Array<{
      type: 'set';
      pathSegments: [string, string, string, string];
      payload: Record<string, unknown>;
    }> = [];

    for (const book of seed.books) {
      ops.push({
        type: 'set',
        pathSegments: ['users', uid, 'books', String(book.id)],
        payload: toBookRecordPayload(uid, book),
      });
      for (const chunk of book.chunks) {
        ops.push({
          type: 'set',
          pathSegments: ['users', uid, 'bookChunks', String(chunk.id)],
          payload: toBookChunkRecordPayload(uid, chunk),
        });
      }
    }
    for (const q of seed.questions) {
      ops.push({
        type: 'set',
        pathSegments: ['users', uid, 'questions', String(q.id)],
        payload: toQuestionRecordPayload(uid, q),
      });
    }
    for (const ex of seed.exams) {
      ops.push({
        type: 'set',
        pathSegments: ['users', uid, 'exams', String(ex.id)],
        payload: toExamRecordPayload(uid, ex),
      });
    }
    for (const a of seed.attempts) {
      ops.push({
        type: 'set',
        pathSegments: ['users', uid, 'attempts', String(a.id)],
        payload: toExamAttemptRecordPayload(uid, a),
      });
    }
    for (const m of seed.mistakes) {
      ops.push({
        type: 'set',
        pathSegments: ['users', uid, 'mistakes', String(m.id)],
        payload: toMistakeRecordPayload(uid, m),
      });
    }
    for (const g of seed.gkItems) {
      ops.push({
        type: 'set',
        pathSegments: ['users', uid, 'gkItems', String(g.id)],
        payload: toGkRecordPayload(uid, g),
      });
    }
    for (const t of seed.studyTasks) {
      ops.push({
        type: 'set',
        pathSegments: ['users', uid, 'studyTasks', String(t.id)],
        payload: toStudyTaskRecordPayload(uid, t),
      });
    }

    await commitBatchedWrites(ops, OperationType.CREATE, `users/${uid}/books`);
    return seed;
  })();

  seedingPromisesByUid.set(uid, task);
  try {
    return await task;
  } finally {
    seedingPromisesByUid.delete(uid);
  }
}

export async function loadWorkspaceFromFirestore(
  user: User
): Promise<WorkspaceData> {
  const uid = assertValidUid(user.uid);
  const [
    booksRes,
    chunksRes,
    questionsRes,
    examsRes,
    attemptsRes,
    mistakesRes,
    gkRes,
    tasksRes,
  ] = await Promise.all([
    listUserCollection(uid, 'books'),
    listUserCollection(uid, 'bookChunks'),
    listUserCollection(uid, 'questions'),
    listUserCollection(uid, 'exams'),
    listUserCollection(uid, 'attempts'),
    listUserCollection(uid, 'mistakes'),
    listUserCollection(uid, 'gkItems'),
    listUserCollection(uid, 'studyTasks'),
  ]);

  const loadAction = decideWorkspaceLoadAction({
    emailVerified: user.emailVerified,
    collections: [
      { docsCount: booksRes.docs.length, fromCache: booksRes.fromCache },
      { docsCount: chunksRes.docs.length, fromCache: chunksRes.fromCache },
      { docsCount: questionsRes.docs.length, fromCache: questionsRes.fromCache },
      { docsCount: examsRes.docs.length, fromCache: examsRes.fromCache },
      { docsCount: attemptsRes.docs.length, fromCache: attemptsRes.fromCache },
      { docsCount: mistakesRes.docs.length, fromCache: mistakesRes.fromCache },
      { docsCount: gkRes.docs.length, fromCache: gkRes.fromCache },
      { docsCount: tasksRes.docs.length, fromCache: tasksRes.fromCache },
    ],
  });

  if (loadAction === 'offline_empty') {
    throw new Error(
      'ক্লাউড ডাটাবেসে সংযোগ স্থাপন করা যায়নি (অফলাইন মোড)। ইন্টারনেট সংযোগ নিশ্চিত করে পুনরায় চেষ্টা করুন।'
    );
  }

  if (loadAction === 'seed') {
    return seedWorkspaceInFirestore(uid);
  }

  const bookDocs = booksRes.docs;
  const chunkDocs = chunksRes.docs;
  const questionDocs = questionsRes.docs;
  const examDocs = examsRes.docs;
  const attemptDocs = attemptsRes.docs;
  const mistakeDocs = mistakesRes.docs;
  const gkDocs = gkRes.docs;
  const taskDocs = tasksRes.docs;

  const chunksByBook = new Map<number, BookChunk[]>();
  for (const raw of chunkDocs) {
    const chunk: BookChunk = {
      id: Number(raw.id),
      bookId: Number(raw.bookId),
      bookTitle: String(raw.bookTitle ?? ''),
      chapter: String(raw.chapter ?? ''),
      pageNumber: Number(raw.pageNumber ?? 1),
      chunkIndex: Number(raw.chunkIndex ?? 0),
      content: String(raw.content ?? ''),
    };
    const arr = chunksByBook.get(chunk.bookId) ?? [];
    arr.push(chunk);
    chunksByBook.set(chunk.bookId, arr);
  }
  for (const arr of chunksByBook.values()) {
    arr.sort((a, b) => a.chunkIndex - b.chunkIndex || a.pageNumber - b.pageNumber);
  }

  const books: Book[] = bookDocs
    .map((raw) => {
      const id = Number(raw.id);
      return {
        id,
        title: String(raw.title ?? ''),
        author: String(raw.author ?? 'অজানা লেখক'),
        subject: String(raw.subject ?? ''),
        category: (raw.category as BookCategory) || 'BCS',
        totalPages: Number(raw.totalPages ?? 1),
        extractionMethod:
          (raw.extractionMethod as Book['extractionMethod']) || 'text',
        ocrCompleted: Boolean(raw.ocrCompleted),
        driveFileId: typeof raw.driveFileId === 'string' ? raw.driveFileId : null,
        driveWebViewLink:
          typeof raw.driveWebViewLink === 'string' ? raw.driveWebViewLink : null,
        driveFileName:
          typeof raw.driveFileName === 'string' ? raw.driveFileName : null,
        createdAt: String(raw.createdDate ?? new Date().toISOString().slice(0, 10)),
        chunks: chunksByBook.get(id) ?? [],
      };
    })
    .sort((a, b) => b.id - a.id);

  const questions: Question[] = questionDocs
    .map((raw) => ({
      id: Number(raw.id),
      bookId: typeof raw.bookId === 'number' ? raw.bookId : null,
      bookTitle: String(raw.bookTitle ?? ''),
      chapter: String(raw.chapter ?? ''),
      pageNumber: Number(raw.pageNumber ?? 1),
      subject: String(raw.subject ?? ''),
      questionType: (raw.questionType as QuestionType) || 'MCQ',
      difficulty: (raw.difficulty as DifficultyLevel) || 'Medium',
      stem: String(raw.stem ?? ''),
      options: Array.isArray(raw.options) ? raw.options.map(String) : [],
      correctOptionIndex:
        typeof raw.correctOptionIndex === 'number' ? raw.correctOptionIndex : null,
      modelAnswer: String(raw.modelAnswer ?? ''),
      explanation: String(raw.explanation ?? ''),
      isPreviousYear: Boolean(raw.isPreviousYear),
      examYear: typeof raw.examYear === 'string' ? raw.examYear : null,
      examSource: typeof raw.examSource === 'string' ? raw.examSource : null,
      importanceScore: Number(raw.importanceScore ?? 80),
      createdAt: String(raw.createdDate ?? new Date().toISOString().slice(0, 10)),
    }))
    .sort((a, b) => b.id - a.id);

  const exams: Exam[] = examDocs
    .map((raw) => ({
      id: Number(raw.id),
      title: String(raw.title ?? ''),
      subject: String(raw.subject ?? ''),
      examMode: (raw.examMode as ExamMode) || 'MCQ',
      durationMinutes: Number(raw.durationMinutes ?? 15),
      marksPerQuestion: Number(raw.marksPerQuestion ?? 1),
      negativeMark: Number(raw.negativeMark ?? 0),
      questionIds: Array.isArray(raw.questionIds)
        ? raw.questionIds.map(Number)
        : [],
      status: (raw.status as Exam['status']) || 'draft',
      draftAnswers:
        raw.draftAnswers && typeof raw.draftAnswers === 'object'
          ? (raw.draftAnswers as Record<string, ExamAnswerDraft>)
          : {},
      createdAt: String(raw.createdDate ?? new Date().toISOString().slice(0, 10)),
    }))
    .sort((a, b) => b.id - a.id);

  const attempts: ExamAttempt[] = attemptDocs
    .map((raw) => ({
      id: Number(raw.id),
      examId: typeof raw.examId === 'number' ? raw.examId : null,
      examTitle: String(raw.examTitle ?? ''),
      subject: String(raw.subject ?? ''),
      totalMarks: Number(raw.totalMarks ?? 0),
      obtainedMarks: Number(raw.obtainedMarks ?? 0),
      negativeDeduction: Number(raw.negativeDeduction ?? 0),
      correctCount: Number(raw.correctCount ?? 0),
      wrongCount: Number(raw.wrongCount ?? 0),
      skippedCount: Number(raw.skippedCount ?? 0),
      mcqAccuracy: Number(raw.mcqAccuracy ?? 0),
      writtenScore: Number(raw.writtenScore ?? 0),
      durationSeconds: Number(raw.durationSeconds ?? 0),
      evaluations: Array.isArray(raw.evaluations)
        ? (raw.evaluations as QuestionEvaluation[])
        : [],
      weakTopics: Array.isArray(raw.weakTopics)
        ? raw.weakTopics.map(String)
        : [],
      aiRecommendation: String(raw.aiRecommendation ?? ''),
      submittedAt: String(raw.submittedAtIso ?? new Date().toISOString()),
    }))
    .sort((a, b) => b.id - a.id);

  const mistakes: MistakeItem[] = mistakeDocs
    .map((raw) => ({
      id: Number(raw.id),
      questionId: typeof raw.questionId === 'number' ? raw.questionId : null,
      attemptId: typeof raw.attemptId === 'number' ? raw.attemptId : null,
      questionStem: String(raw.questionStem ?? ''),
      subject: String(raw.subject ?? ''),
      chapter: String(raw.chapter ?? ''),
      userAnswer: String(raw.userAnswer ?? ''),
      correctAnswer: String(raw.correctAnswer ?? ''),
      reason: String(raw.reason ?? ''),
      mastered: Boolean(raw.mastered),
      reviewCount: Number(raw.reviewCount ?? 0),
      nextReviewDate: String(
        raw.nextReviewDate ?? new Date().toISOString().slice(0, 10)
      ),
      createdAt: String(raw.createdDate ?? new Date().toISOString().slice(0, 10)),
    }))
    .sort((a, b) => b.id - a.id);

  const gkItems: CurrentGkItem[] = gkDocs
    .map((raw) => ({
      id: Number(raw.id),
      title: String(raw.title ?? ''),
      summary: String(raw.summary ?? ''),
      category: String(raw.category ?? ''),
      eventDate: String(raw.eventDate ?? ''),
      source: String(raw.source ?? ''),
      isArchived: Boolean(raw.isArchived),
      convertedToQuestions: Boolean(raw.convertedToQuestions),
      createdAt: String(raw.createdDate ?? new Date().toISOString().slice(0, 10)),
    }))
    .sort((a, b) => b.id - a.id);

  const studyTasks: StudyTask[] = taskDocs
    .map((raw) => ({
      id: Number(raw.id),
      title: String(raw.title ?? ''),
      subject: String(raw.subject ?? ''),
      chapter: String(raw.chapter ?? ''),
      taskType: (raw.taskType as StudyTask['taskType']) || 'reading',
      scheduledDate: String(
        raw.scheduledDate ?? new Date().toISOString().slice(0, 10)
      ),
      durationMinutes: Number(raw.durationMinutes ?? 30),
      completed: Boolean(raw.completed),
      createdAt: String(raw.createdDate ?? new Date().toISOString().slice(0, 10)),
    }))
    .sort((a, b) => b.id - a.id);

  return {
    books,
    questions,
    exams,
    attempts,
    mistakes,
    gkItems,
    studyTasks,
  };
}

export async function createBookInFirestore(
  user: User,
  book: Book
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const ops: Array<{
    type: 'set';
    pathSegments: [string, string, string, string];
    payload: Record<string, unknown>;
  }> = [
    {
      type: 'set',
      pathSegments: ['users', uid, 'books', String(book.id)],
      payload: toBookRecordPayload(uid, book),
    },
    ...book.chunks.map((chunk) => ({
      type: 'set' as const,
      pathSegments: ['users', uid, 'bookChunks', String(chunk.id)] as [
        string,
        string,
        string,
        string,
      ],
      payload: toBookChunkRecordPayload(uid, chunk),
    })),
  ];

  await commitBatchedWrites(
    ops,
    OperationType.CREATE,
    `users/${uid}/books/${book.id}`
  );
}

export async function updateBookDriveMetaInFirestore(
  user: User,
  bookId: number,
  drive: {
    driveFileId: string | null;
    driveWebViewLink: string | null;
    driveFileName: string | null;
  }
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/books/${bookId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'books', String(bookId)), {
      driveFileId: clampNullableString(drive.driveFileId, 200),
      driveWebViewLink: clampNullableString(drive.driveWebViewLink, 500),
      driveFileName: clampNullableString(drive.driveFileName, 200),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateBookChunksInFirestore(
  user: User,
  bookId: number,
  updatedChunks: BookChunk[],
  removedChunkIds: number[] = []
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const ops: Array<
    | {
        type: 'set';
        pathSegments: [string, string, string, string];
        payload: Record<string, unknown>;
      }
    | {
        type: 'delete';
        pathSegments: [string, string, string, string];
      }
  > = [
    ...updatedChunks.map((chunk) => ({
      type: 'set' as const,
      pathSegments: ['users', uid, 'bookChunks', String(chunk.id)] as [
        string,
        string,
        string,
        string,
      ],
      payload: toBookChunkRecordPayload(uid, chunk),
    })),
    ...removedChunkIds.map((cid) => ({
      type: 'delete' as const,
      pathSegments: ['users', uid, 'bookChunks', String(cid)] as [
        string,
        string,
        string,
        string,
      ],
    })),
  ];

  if (ops.length === 0) return;

  await commitBatchedWrites(
    ops,
    OperationType.UPDATE,
    `users/${uid}/books/${bookId}`
  );
}

export async function deleteBookInFirestore(
  user: User,
  bookId: number,
  chunkIds: number[]
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const ops: Array<{
    type: 'delete';
    pathSegments: [string, string, string, string];
  }> = [
    {
      type: 'delete',
      pathSegments: ['users', uid, 'books', String(bookId)],
    },
    ...chunkIds.map((cid) => ({
      type: 'delete' as const,
      pathSegments: ['users', uid, 'bookChunks', String(cid)] as [
        string,
        string,
        string,
        string,
      ],
    })),
  ];

  await commitBatchedWrites(
    ops,
    OperationType.DELETE,
    `users/${uid}/books/${bookId}`
  );
}

export async function saveQuestionsInFirestore(
  user: User,
  questions: Question[]
): Promise<void> {
  const uid = assertValidUid(user.uid);
  if (questions.length === 0) return;
  const ops = questions.map((q) => ({
    type: 'set' as const,
    pathSegments: ['users', uid, 'questions', String(q.id)] as [
      string,
      string,
      string,
      string,
    ],
    payload: toQuestionRecordPayload(uid, q),
  }));
  await commitBatchedWrites(ops, OperationType.CREATE, `users/${uid}/questions`);
}

export async function deleteQuestionInFirestore(
  user: User,
  questionId: number
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/questions/${questionId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'questions', String(questionId)));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createExamInFirestore(
  user: User,
  exam: Exam
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/exams/${exam.id}`;
  try {
    await setDoc(
      doc(db, 'users', uid, 'exams', String(exam.id)),
      toExamRecordPayload(uid, exam)
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteExamInFirestore(
  user: User,
  examId: number
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/exams/${examId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'exams', String(examId)));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveExamDraftInFirestore(
  user: User,
  examId: number,
  draftAnswers: Record<string, ExamAnswerDraft>
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/exams/${examId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'exams', String(examId)), {
      status: 'in_progress',
      draftAnswers: sanitizeDraftAnswers(draftAnswers),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function saveExamAttemptInFirestore(
  user: User,
  attempt: ExamAttempt,
  mistakes: MistakeItem[],
  examIdToComplete: number | null
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const ops: Array<{
    type: 'set';
    pathSegments: [string, string, string, string];
    payload: Record<string, unknown>;
  }> = [
    {
      type: 'set',
      pathSegments: ['users', uid, 'attempts', String(attempt.id)],
      payload: toExamAttemptRecordPayload(uid, attempt),
    },
    ...mistakes.map((m) => ({
      type: 'set' as const,
      pathSegments: ['users', uid, 'mistakes', String(m.id)] as [
        string,
        string,
        string,
        string,
      ],
      payload: toMistakeRecordPayload(uid, m),
    })),
  ];

  await commitBatchedWrites(
    ops,
    OperationType.CREATE,
    `users/${uid}/attempts/${attempt.id}`
  );

  if (examIdToComplete !== null && examIdToComplete > 0) {
    const examPath = `users/${uid}/exams/${examIdToComplete}`;
    try {
      await updateDoc(
        doc(db, 'users', uid, 'exams', String(examIdToComplete)),
        {
          status: 'completed',
          draftAnswers: {},
          updatedAt: serverTimestamp(),
        }
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, examPath);
    }
  }
}

export async function deleteExamAttemptInFirestore(
  user: User,
  attemptId: number
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/attempts/${attemptId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'attempts', String(attemptId)));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function toggleMistakeMasteredInFirestore(
  user: User,
  mistakeId: number,
  mastered: boolean,
  reviewCount: number
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/mistakes/${mistakeId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'mistakes', String(mistakeId)), {
      mastered: Boolean(mastered),
      reviewCount: clampInt(reviewCount, 0, 100000, 0),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteMistakeInFirestore(
  user: User,
  mistakeId: number
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/mistakes/${mistakeId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'mistakes', String(mistakeId)));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createMistakesInFirestore(
  user: User,
  mistakes: MistakeItem[]
): Promise<void> {
  if (mistakes.length === 0) return;
  const uid = assertValidUid(user.uid);
  for (const m of mistakes) {
    const path = `users/${uid}/mistakes/${m.id}`;
    try {
      await setDoc(
        doc(db, 'users', uid, 'mistakes', String(m.id)),
        toMistakeRecordPayload(uid, m)
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }
}

export async function createGkInFirestore(
  user: User,
  item: CurrentGkItem
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/gkItems/${item.id}`;
  try {
    await setDoc(
      doc(db, 'users', uid, 'gkItems', String(item.id)),
      toGkRecordPayload(uid, item)
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function toggleGkArchiveInFirestore(
  user: User,
  gkId: number,
  isArchived: boolean
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/gkItems/${gkId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'gkItems', String(gkId)), {
      isArchived: Boolean(isArchived),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function markGkConvertedInFirestore(
  user: User,
  gkId: number
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/gkItems/${gkId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'gkItems', String(gkId)), {
      convertedToQuestions: true,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteGkItemInFirestore(
  user: User,
  gkId: number
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/gkItems/${gkId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'gkItems', String(gkId)));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createStudyTaskInFirestore(
  user: User,
  task: StudyTask
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/studyTasks/${task.id}`;
  try {
    await setDoc(
      doc(db, 'users', uid, 'studyTasks', String(task.id)),
      toStudyTaskRecordPayload(uid, task)
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function toggleStudyTaskInFirestore(
  user: User,
  taskId: number,
  completed: boolean
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/studyTasks/${taskId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'studyTasks', String(taskId)), {
      completed: Boolean(completed),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateStudyTaskInFirestore(
  user: User,
  taskId: number,
  patch: Partial<
    Pick<
      StudyTask,
      'title' | 'subject' | 'chapter' | 'taskType' | 'scheduledDate' | 'durationMinutes'
    >
  >
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/studyTasks/${taskId}`;
  const payload: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };
  if (patch.title !== undefined) {
    payload.title = clampNonEmptyString(patch.title, 240, 'অধ্যয়ন কাজ');
  }
  if (patch.subject !== undefined) {
    payload.subject = clampString(patch.subject, 160);
  }
  if (patch.chapter !== undefined) {
    payload.chapter = clampString(patch.chapter, 240);
  }
  if (patch.taskType !== undefined && VALID_TASK_TYPES.has(patch.taskType)) {
    payload.taskType = patch.taskType;
  }
  if (patch.scheduledDate !== undefined) {
    payload.scheduledDate = clampString(
      patch.scheduledDate || new Date().toISOString().slice(0, 10),
      32
    );
  }
  if (patch.durationMinutes !== undefined) {
    payload.durationMinutes = clampInt(patch.durationMinutes, 1, 1440, 30);
  }
  try {
    await updateDoc(doc(db, 'users', uid, 'studyTasks', String(taskId)), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteStudyTaskInFirestore(
  user: User,
  taskId: number
): Promise<void> {
  const uid = assertValidUid(user.uid);
  const path = `users/${uid}/studyTasks/${taskId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'studyTasks', String(taskId)));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
