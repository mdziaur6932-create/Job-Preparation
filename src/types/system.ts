export type ModuleId =
  | 'library'
  | 'reader'
  | 'question-lab'
  | 'exam-center'
  | 'evaluation'
  | 'current-gk'
  | 'planner'
  | 'performance'
  | 'ocr-studio';

export type BookCategory =
  | 'BCS'
  | 'Bank'
  | 'Primary'
  | 'Current GK'
  | 'Previous Year'
  | 'রিসেন্ট জব সলুশন'
  | 'বিষয়ভিত্তিক মূল বই'
  | 'অন্যান্য';

export type QuestionType = 'MCQ' | 'Written' | 'Short';
export type DifficultyLevel = 'Easy' | 'Medium' | 'Hard';
export type ExamMode = 'MCQ' | 'Written' | 'Mixed';

export interface BookChunk {
  id: number;
  bookId: number;
  bookTitle: string;
  chapter: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
  embedding?: number[] | null;
}

export interface Book {
  id: number;
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
  createdAt: string;
  chunks: BookChunk[];
}

export interface Question {
  id: number;
  bookId: number | null;
  bookTitle: string;
  chapter: string;
  pageNumber: number;
  subject: string;
  questionType: QuestionType;
  difficulty: DifficultyLevel;
  stem: string;
  options: string[];
  correctOptionIndex: number | null;
  modelAnswer: string;
  explanation: string;
  isPreviousYear: boolean;
  examYear: string | null;
  examSource: string | null;
  importanceScore: number;
  createdAt: string;
}

export interface ExamAnswerDraft {
  selectedOption?: number;
  writtenText?: string;
}

export interface Exam {
  id: number;
  title: string;
  subject: string;
  examMode: ExamMode;
  durationMinutes: number;
  marksPerQuestion: number;
  negativeMark: number;
  questionIds: number[];
  status: 'draft' | 'in_progress' | 'completed';
  draftAnswers: Record<string, ExamAnswerDraft>;
  createdAt: string;
}

export interface QuestionEvaluation {
  questionId: number;
  questionType: QuestionType;
  stem: string;
  subject: string;
  chapter: string;
  bookTitle: string;
  pageNumber: number;
  maxMarks: number;
  awardedMarks: number;
  negativeApplied: number;
  status: 'correct' | 'wrong' | 'skipped' | 'partial';
  userAnswer: string;
  correctAnswer: string;
  modelAnswer: string;
  mistakeExplanation: string;
  improvementTip: string;
}

export interface ExamAttempt {
  id: number;
  examId: number | null;
  examTitle: string;
  subject: string;
  totalMarks: number;
  obtainedMarks: number;
  negativeDeduction: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  mcqAccuracy: number;
  writtenScore: number;
  durationSeconds: number;
  evaluations: QuestionEvaluation[];
  weakTopics: string[];
  aiRecommendation: string;
  submittedAt: string;
}

export interface MistakeItem {
  id: number;
  questionId: number | null;
  attemptId: number | null;
  questionStem: string;
  subject: string;
  chapter: string;
  userAnswer: string;
  correctAnswer: string;
  reason: string;
  mastered: boolean;
  reviewCount: number;
  nextReviewDate: string;
  createdAt: string;
}

export interface CurrentGkItem {
  id: number;
  title: string;
  summary: string;
  category: string;
  eventDate: string;
  source: string;
  isArchived: boolean;
  convertedToQuestions: boolean;
  createdAt: string;
}

export interface StudyTask {
  id: number;
  title: string;
  subject: string;
  chapter: string;
  taskType: 'reading' | 'revision' | 'practice' | 'exam';
  scheduledDate: string;
  durationMinutes: number;
  completed: boolean;
  createdAt: string;
}

export interface WorkspaceData {
  books: Book[];
  questions: Question[];
  exams: Exam[];
  attempts: ExamAttempt[];
  mistakes: MistakeItem[];
  gkItems: CurrentGkItem[];
  studyTasks: StudyTask[];
}
