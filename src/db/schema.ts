import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  vector,
} from 'drizzle-orm/pg-core';

// Users linked to Firebase Auth UID
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name').default(''),
  targetExam: text('target_exam').default('৪৭তম বিসিএস ও ব্যাংক প্রস্তুতি'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 01. Book Library
export const books = pgTable('books', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  author: text('author').notNull().default('অজানা লেখক'),
  subject: text('subject').notNull(),
  category: text('category').notNull().default('BCS'),
  totalPages: integer('total_pages').notNull().default(1),
  extractionMethod: text('extraction_method').notNull().default('text'),
  ocrCompleted: boolean('ocr_completed').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Knowledge Base Chunks with pgvector 768-dim embeddings for RAG
export const bookChunks = pgTable('book_chunks', {
  id: serial('id').primaryKey(),
  bookId: integer('book_id')
    .references(() => books.id, { onDelete: 'cascade' })
    .notNull(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  chapter: text('chapter').notNull(),
  pageNumber: integer('page_number').notNull().default(1),
  chunkIndex: integer('chunk_index').notNull().default(0),
  content: text('content').notNull(),
  embedding: vector('embedding', { dimensions: 768 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 03. Question Bank & AI Question Lab
export const questions = pgTable('questions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
  bookTitle: text('book_title').notNull().default(''),
  chapter: text('chapter').notNull().default('সাধারণ অধ্যায়'),
  pageNumber: integer('page_number').notNull().default(1),
  subject: text('subject').notNull(),
  questionType: text('question_type').notNull().default('MCQ'),
  difficulty: text('difficulty').notNull().default('Medium'),
  stem: text('stem').notNull(),
  options: jsonb('options').$type<string[]>().notNull().default([]),
  correctOptionIndex: integer('correct_option_index'),
  modelAnswer: text('model_answer').notNull().default(''),
  explanation: text('explanation').notNull().default(''),
  isPreviousYear: boolean('is_previous_year').notNull().default(false),
  examYear: text('exam_year'),
  examSource: text('exam_source'),
  importanceScore: integer('importance_score').notNull().default(75),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 04. Exam Center
export const exams = pgTable('exams', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  subject: text('subject').notNull(),
  examMode: text('exam_mode').notNull().default('Mixed'),
  durationMinutes: integer('duration_minutes').notNull().default(20),
  marksPerQuestion: real('marks_per_question').notNull().default(1),
  negativeMark: real('negative_mark').notNull().default(0.25),
  questionIds: jsonb('question_ids').$type<number[]>().notNull().default([]),
  status: text('status').notNull().default('draft'),
  draftAnswers: jsonb('draft_answers')
    .$type<Record<string, { selectedOption?: number; writtenText?: string }>>()
    .notNull()
    .default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 05. AI Evaluation & Exam Results
export const examAttempts = pgTable('exam_attempts', {
  id: serial('id').primaryKey(),
  examId: integer('exam_id').references(() => exams.id, { onDelete: 'set null' }),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  examTitle: text('exam_title').notNull(),
  subject: text('subject').notNull(),
  totalMarks: real('total_marks').notNull().default(0),
  obtainedMarks: real('obtained_marks').notNull().default(0),
  negativeDeduction: real('negative_deduction').notNull().default(0),
  correctCount: integer('correct_count').notNull().default(0),
  wrongCount: integer('wrong_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  mcqAccuracy: real('mcq_accuracy').notNull().default(0),
  writtenScore: real('written_score').notNull().default(0),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default({}),
  evaluations: jsonb('evaluations').$type<unknown[]>().notNull().default([]),
  weakTopics: jsonb('weak_topics').$type<string[]>().notNull().default([]),
  aiRecommendation: text('ai_recommendation').notNull().default(''),
  submittedAt: timestamp('submitted_at').defaultNow().notNull(),
});

// Mistake Notebook (Phase 1+2 integrated)
export const mistakes = pgTable('mistakes', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  questionId: integer('question_id').references(() => questions.id, {
    onDelete: 'set null',
  }),
  attemptId: integer('attempt_id').references(() => examAttempts.id, {
    onDelete: 'set null',
  }),
  questionStem: text('question_stem').notNull(),
  subject: text('subject').notNull(),
  chapter: text('chapter').notNull().default('সাধারণ অধ্যায়'),
  userAnswer: text('user_answer').notNull().default(''),
  correctAnswer: text('correct_answer').notNull().default(''),
  reason: text('reason').notNull().default(''),
  mastered: boolean('mastered').notNull().default(false),
  reviewCount: integer('review_count').notNull().default(0),
  nextReviewDate: text('next_review_date').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 06. Current GK
export const currentGkItems = pgTable('current_gk_items', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  category: text('category').notNull().default('জাতীয়'),
  eventDate: text('event_date').notNull(),
  source: text('source').notNull().default('দৈনিক সংবাদপত্র'),
  isArchived: boolean('is_archived').notNull().default(false),
  convertedToQuestions: boolean('converted_to_questions').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 07. Study Planner & Smart Revision
export const studyTasks = pgTable('study_tasks', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  subject: text('subject').notNull(),
  chapter: text('chapter').notNull().default(''),
  taskType: text('task_type').notNull().default('reading'),
  scheduledDate: text('scheduled_date').notNull(),
  durationMinutes: integer('duration_minutes').notNull().default(45),
  completed: boolean('completed').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  books: many(books),
  questions: many(questions),
  exams: many(exams),
  examAttempts: many(examAttempts),
  mistakes: many(mistakes),
  currentGkItems: many(currentGkItems),
  studyTasks: many(studyTasks),
}));

export const booksRelations = relations(books, ({ one, many }) => ({
  owner: one(users, {
    fields: [books.userId],
    references: [users.id],
  }),
  chunks: many(bookChunks),
  questions: many(questions),
}));

export const bookChunksRelations = relations(bookChunks, ({ one }) => ({
  book: one(books, {
    fields: [bookChunks.bookId],
    references: [books.id],
  }),
}));
