import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/src/db/index.ts';
import {
  bookChunks,
  books,
  currentGkItems,
  examAttempts,
  exams,
  mistakes,
  questions,
  studyTasks,
} from '@/src/db/schema.ts';
import { verifyAuthRequest } from '@/src/lib/server-auth.ts';
import { createInitialSeedData } from '@/src/lib/seed-data';
import { generateEmbedding768 } from '@/src/lib/gemini';
import {
  MIN_MEANINGFUL_TEXT_CHARS,
  findDuplicateBookMatch,
  isPageRangeOnlyText,
  stripPageMarkersAndHeaders,
} from '@/src/lib/pdf-rules';
import {
  isValidDriveId,
  isValidDriveWebViewLink,
} from '@/src/lib/google-drive';
import type {
  BookCategory,
  DifficultyLevel,
  ExamMode,
  QuestionEvaluation,
  QuestionType,
  WorkspaceData,
} from '@/src/types/system';

async function loadUserWorkspace(userId: number): Promise<WorkspaceData> {
  try {
    const [
      userBooks,
      userChunks,
      userQuestions,
      userExams,
      userAttempts,
      userMistakes,
      userGk,
      userTasks,
    ] = await Promise.all([
      db.select().from(books).where(eq(books.userId, userId)).orderBy(desc(books.id)),
      db.select().from(bookChunks).where(eq(bookChunks.userId, userId)),
      db.select().from(questions).where(eq(questions.userId, userId)).orderBy(desc(questions.id)),
      db.select().from(exams).where(eq(exams.userId, userId)).orderBy(desc(exams.id)),
      db.select().from(examAttempts).where(eq(examAttempts.userId, userId)).orderBy(desc(examAttempts.id)),
      db.select().from(mistakes).where(eq(mistakes.userId, userId)).orderBy(desc(mistakes.id)),
      db.select().from(currentGkItems).where(eq(currentGkItems.userId, userId)).orderBy(desc(currentGkItems.id)),
      db.select().from(studyTasks).where(eq(studyTasks.userId, userId)).orderBy(desc(studyTasks.id)),
    ]);

    const bookTitleMap = new Map<number, string>();
    for (const b of userBooks) {
      bookTitleMap.set(b.id, b.title);
    }

    const chunksByBook = new Map<number, WorkspaceData['books'][number]['chunks']>();
    for (const ch of userChunks) {
      const list = chunksByBook.get(ch.bookId) ?? [];
      list.push({
        id: ch.id,
        bookId: ch.bookId,
        bookTitle: bookTitleMap.get(ch.bookId) ?? '',
        chapter: ch.chapter,
        pageNumber: ch.pageNumber,
        chunkIndex: ch.chunkIndex,
        content: ch.content,
      });
      chunksByBook.set(ch.bookId, list);
    }

    return {
      books: userBooks.map((b) => ({
        id: b.id,
        title: b.title,
        author: b.author,
        subject: b.subject,
        category: (b.category as BookCategory) || 'BCS',
        totalPages: b.totalPages,
        extractionMethod:
          b.extractionMethod === 'ocr' || b.extractionMethod === 'manual'
            ? b.extractionMethod
            : 'text',
        ocrCompleted: b.ocrCompleted,
        driveFileId: b.driveFileId ?? null,
        driveWebViewLink: b.driveWebViewLink ?? null,
        driveFileName: b.driveFileName ?? null,
        createdAt: b.createdAt.toISOString().slice(0, 10),
        chunks: (chunksByBook.get(b.id) ?? []).sort(
          (a, z) => a.pageNumber - z.pageNumber || a.chunkIndex - z.chunkIndex
        ),
      })),
      questions: userQuestions.map((q) => ({
        id: q.id,
        bookId: q.bookId,
        bookTitle: q.bookTitle,
        chapter: q.chapter,
        pageNumber: q.pageNumber,
        subject: q.subject,
        questionType: (q.questionType as QuestionType) || 'MCQ',
        difficulty: (q.difficulty as DifficultyLevel) || 'Medium',
        stem: q.stem,
        options: Array.isArray(q.options) ? q.options : [],
        correctOptionIndex: q.correctOptionIndex,
        modelAnswer: q.modelAnswer,
        explanation: q.explanation,
        isPreviousYear: q.isPreviousYear,
        examYear: q.examYear,
        examSource: q.examSource,
        importanceScore: q.importanceScore,
        createdAt: q.createdAt.toISOString().slice(0, 10),
      })),
      exams: userExams.map((e) => ({
        id: e.id,
        title: e.title,
        subject: e.subject,
        examMode: (e.examMode as ExamMode) || 'Mixed',
        durationMinutes: e.durationMinutes,
        marksPerQuestion: e.marksPerQuestion,
        negativeMark: e.negativeMark,
        questionIds: Array.isArray(e.questionIds) ? e.questionIds : [],
        status:
          e.status === 'in_progress' || e.status === 'completed'
            ? e.status
            : 'draft',
        draftAnswers: e.draftAnswers ?? {},
        createdAt: e.createdAt.toISOString().slice(0, 10),
      })),
      attempts: userAttempts.map((a) => ({
        id: a.id,
        examId: a.examId,
        examTitle: a.examTitle,
        subject: a.subject,
        totalMarks: a.totalMarks,
        obtainedMarks: a.obtainedMarks,
        negativeDeduction: a.negativeDeduction,
        correctCount: a.correctCount,
        wrongCount: a.wrongCount,
        skippedCount: a.skippedCount,
        mcqAccuracy: a.mcqAccuracy,
        writtenScore: a.writtenScore,
        durationSeconds: a.durationSeconds,
        evaluations: Array.isArray(a.evaluations)
          ? (a.evaluations as QuestionEvaluation[])
          : [],
        weakTopics: Array.isArray(a.weakTopics) ? a.weakTopics : [],
        aiRecommendation: a.aiRecommendation,
        submittedAt: a.submittedAt.toISOString(),
      })),
      mistakes: userMistakes.map((m) => ({
        id: m.id,
        questionId: m.questionId,
        attemptId: m.attemptId,
        questionStem: m.questionStem,
        subject: m.subject,
        chapter: m.chapter,
        userAnswer: m.userAnswer,
        correctAnswer: m.correctAnswer,
        reason: m.reason,
        mastered: m.mastered,
        reviewCount: m.reviewCount,
        nextReviewDate: m.nextReviewDate,
        createdAt: m.createdAt.toISOString().slice(0, 10),
      })),
      gkItems: userGk.map((g) => ({
        id: g.id,
        title: g.title,
        summary: g.summary,
        category: g.category,
        eventDate: g.eventDate,
        source: g.source,
        isArchived: g.isArchived,
        convertedToQuestions: g.convertedToQuestions,
        createdAt: g.createdAt.toISOString().slice(0, 10),
      })),
      studyTasks: userTasks.map((t) => ({
        id: t.id,
        title: t.title,
        subject: t.subject,
        chapter: t.chapter,
        taskType:
          t.taskType === 'revision' ||
          t.taskType === 'practice' ||
          t.taskType === 'exam'
            ? t.taskType
            : 'reading',
        scheduledDate: t.scheduledDate,
        durationMinutes: t.durationMinutes,
        completed: t.completed,
        createdAt: t.createdAt.toISOString().slice(0, 10),
      })),
    };
  } catch (error) {
    console.error('Failed to load workspace from PostgreSQL:', error);
    throw new Error('Failed to load study workspace from database.', {
      cause: error,
    });
  }
}

async function seedNewUserWorkspace(userId: number) {
  const seed = createInitialSeedData();
  const bookIdMap = new Map<number, number>();
  const questionIdMap = new Map<number, number>();

  for (const b of seed.books) {
    const [insertedBook] = await db
      .insert(books)
      .values({
        userId,
        title: b.title,
        author: b.author,
        subject: b.subject,
        category: b.category,
        totalPages: b.totalPages,
        extractionMethod: b.extractionMethod,
        ocrCompleted: b.ocrCompleted,
      })
      .returning();
    bookIdMap.set(b.id, insertedBook.id);

    for (const ch of b.chunks) {
      await db.insert(bookChunks).values({
        bookId: insertedBook.id,
        userId,
        chapter: ch.chapter,
        pageNumber: ch.pageNumber,
        chunkIndex: ch.chunkIndex,
        content: ch.content,
      });
    }
  }

  for (const q of seed.questions) {
    const [insertedQ] = await db
      .insert(questions)
      .values({
        userId,
        bookId: q.bookId ? (bookIdMap.get(q.bookId) ?? null) : null,
        bookTitle: q.bookTitle,
        chapter: q.chapter,
        pageNumber: q.pageNumber,
        subject: q.subject,
        questionType: q.questionType,
        difficulty: q.difficulty,
        stem: q.stem,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        modelAnswer: q.modelAnswer,
        explanation: q.explanation,
        isPreviousYear: q.isPreviousYear,
        examYear: q.examYear,
        examSource: q.examSource,
        importanceScore: q.importanceScore,
      })
      .returning();
    questionIdMap.set(q.id, insertedQ.id);
  }

  for (const ex of seed.exams) {
    const mappedQIds = ex.questionIds
      .map((id) => questionIdMap.get(id))
      .filter((id): id is number => typeof id === 'number');
    await db.insert(exams).values({
      userId,
      title: ex.title,
      subject: ex.subject,
      examMode: ex.examMode,
      durationMinutes: ex.durationMinutes,
      marksPerQuestion: ex.marksPerQuestion,
      negativeMark: ex.negativeMark,
      questionIds: mappedQIds,
      status: ex.status,
      draftAnswers: ex.draftAnswers,
    });
  }

  for (const att of seed.attempts) {
    await db.insert(examAttempts).values({
      userId,
      examId: null,
      examTitle: att.examTitle,
      subject: att.subject,
      totalMarks: att.totalMarks,
      obtainedMarks: att.obtainedMarks,
      negativeDeduction: att.negativeDeduction,
      correctCount: att.correctCount,
      wrongCount: att.wrongCount,
      skippedCount: att.skippedCount,
      mcqAccuracy: att.mcqAccuracy,
      writtenScore: att.writtenScore,
      durationSeconds: att.durationSeconds,
      evaluations: att.evaluations,
      weakTopics: att.weakTopics,
      aiRecommendation: att.aiRecommendation,
    });
  }

  for (const m of seed.mistakes) {
    await db.insert(mistakes).values({
      userId,
      questionId: m.questionId ? (questionIdMap.get(m.questionId) ?? null) : null,
      attemptId: null,
      questionStem: m.questionStem,
      subject: m.subject,
      chapter: m.chapter,
      userAnswer: m.userAnswer,
      correctAnswer: m.correctAnswer,
      reason: m.reason,
      mastered: m.mastered,
      reviewCount: m.reviewCount,
      nextReviewDate: m.nextReviewDate,
    });
  }

  for (const g of seed.gkItems) {
    await db.insert(currentGkItems).values({
      userId,
      title: g.title,
      summary: g.summary,
      category: g.category,
      eventDate: g.eventDate,
      source: g.source,
      isArchived: g.isArchived,
      convertedToQuestions: g.convertedToQuestions,
    });
  }

  for (const t of seed.studyTasks) {
    await db.insert(studyTasks).values({
      userId,
      title: t.title,
      subject: t.subject,
      chapter: t.chapter,
      taskType: t.taskType,
      scheduledDate: t.scheduledDate,
      durationMinutes: t.durationMinutes,
      completed: t.completed,
    });
  }
}

export async function GET(req: NextRequest) {
  const session = await verifyAuthRequest(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized: Valid Google Sign-In session required.' },
      { status: 401 }
    );
  }

  try {
    let data = await loadUserWorkspace(session.dbUserId);
    if (data.books.length === 0 && data.questions.length === 0) {
      await seedNewUserWorkspace(session.dbUserId);
      data = await loadUserWorkspace(session.dbUserId);
    }
    return NextResponse.json({
      user: {
        uid: session.uid,
        email: session.email,
        displayName: session.displayName,
      },
      workspace: data,
    });
  } catch (error) {
    console.error('GET /api/workspace failed:', error);
    return NextResponse.json(
      { error: 'Could not load study workspace. Please try again.' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const session = await verifyAuthRequest(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized: Valid Google Sign-In session required.' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const { action, payload } = body ?? {};

    switch (action) {
      case 'create_book': {
        const cleanTitle = String(payload.title || '').trim();
        const cleanSubject = String(payload.subject || '').trim();
        const cleanAuthor = String(payload.author || 'অজানা লেখক').trim();
        const cleanCategory = String(payload.category || 'BCS').trim();
        const cleanTotalPages = Math.max(1, Math.trunc(Number(payload.totalPages || 1)));

        const rawChunks: Array<{
          chapter: string;
          pageNumber: number;
          chunkIndex: number;
          content: string;
        }> = Array.isArray(payload.chunks) ? payload.chunks : [];

        const combinedChunkText = rawChunks
          .map((ch) => String(ch.content || '').trim())
          .filter(Boolean)
          .join('\n\n');

        if (!cleanTitle || !cleanSubject) {
          return NextResponse.json(
            { error: 'বইয়ের নাম এবং বিষয় অবশ্যই উল্লেখ করতে হবে।' },
            { status: 400 }
          );
        }

        if (
          rawChunks.length === 0 ||
          isPageRangeOnlyText(combinedChunkText) ||
          stripPageMarkersAndHeaders(combinedChunkText).length < MIN_MEANINGFUL_TEXT_CHARS
        ) {
          return NextResponse.json(
            {
              error:
                'বইয়ের মূল পাঠ্য অসম্পূর্ণ বা শুধুমাত্র পৃষ্ঠা রেঞ্জ (যেমন: "Page 37-44") হিসেবে পাওয়া গেছে। প্রকৃত বিষয়বস্তু ছাড়া সংরক্ষণ করা যাবে না।',
            },
            { status: 400 }
          );
        }

        // Prevent duplicate Knowledge Base book records on retry/double-submit
        const existingWorkspace = await loadUserWorkspace(session.dbUserId);
        const duplicateBook = findDuplicateBookMatch(existingWorkspace.books, {
          title: cleanTitle,
          subject: cleanSubject,
          totalPages: cleanTotalPages,
          chunks: rawChunks.map((ch) => ({
            pageNumber: Number(ch.pageNumber || 1),
            content: String(ch.content || ''),
          })),
        });
        if (duplicateBook) {
          return NextResponse.json({
            workspace: existingWorkspace,
            duplicateSkipped: true,
            bookId: duplicateBook.id,
          });
        }

        const safeDriveFileId = isValidDriveId(payload.driveFileId)
          ? String(payload.driveFileId).trim()
          : null;
        const safeDriveWebViewLink = isValidDriveWebViewLink(
          payload.driveWebViewLink
        )
          ? String(payload.driveWebViewLink).trim()
          : null;
        const safeDriveFileName =
          safeDriveFileId && typeof payload.driveFileName === 'string'
            ? payload.driveFileName.trim().slice(0, 180) || null
            : null;

        const [insertedBook] = await db
          .insert(books)
          .values({
            userId: session.dbUserId,
            title: cleanTitle,
            author: cleanAuthor,
            subject: cleanSubject,
            category: cleanCategory,
            totalPages: cleanTotalPages,
            extractionMethod: String(payload.extractionMethod || 'text'),
            ocrCompleted: Boolean(payload.ocrCompleted),
            driveFileId: safeDriveFileId,
            driveWebViewLink: safeDriveWebViewLink,
            driveFileName: safeDriveFileName,
          })
          .returning();

        // Store chunks with real 768-dim pgvector embeddings (best-effort embedding)
        for (let i = 0; i < rawChunks.length; i++) {
          const ch = rawChunks[i];
          const emb =
            i < 6 ? await generateEmbedding768(`${ch.chapter}\n${ch.content}`) : null;
          await db.insert(bookChunks).values({
            bookId: insertedBook.id,
            userId: session.dbUserId,
            chapter: ch.chapter,
            pageNumber: Number(ch.pageNumber || 1),
            chunkIndex: Number(ch.chunkIndex ?? i),
            content: ch.content,
            embedding: emb,
          });
        }
        break;
      }

      case 'update_book_drive': {
        const bookId = Number(payload.id);
        if (!Number.isInteger(bookId) || bookId <= 0) {
          return NextResponse.json(
            { error: 'সঠিক বইয়ের আইডি পাওয়া যায়নি।' },
            { status: 400 }
          );
        }
        const safeDriveFileId = isValidDriveId(payload.driveFileId)
          ? String(payload.driveFileId).trim()
          : null;
        const safeDriveWebViewLink = isValidDriveWebViewLink(
          payload.driveWebViewLink
        )
          ? String(payload.driveWebViewLink).trim()
          : null;
        const safeDriveFileName =
          safeDriveFileId && typeof payload.driveFileName === 'string'
            ? payload.driveFileName.trim().slice(0, 180) || null
            : null;

        await db
          .update(books)
          .set({
            driveFileId: safeDriveFileId,
            driveWebViewLink: safeDriveWebViewLink,
            driveFileName: safeDriveFileName,
          })
          .where(
            and(eq(books.id, bookId), eq(books.userId, session.dbUserId))
          );
        break;
      }

      case 'delete_book': {
        await db
          .delete(books)
          .where(
            and(
              eq(books.id, Number(payload.id)),
              eq(books.userId, session.dbUserId)
            )
          );
        break;
      }

      case 'save_questions': {
        const items: Array<Record<string, unknown>> = Array.isArray(payload.items)
          ? payload.items
          : [];
        for (const q of items) {
          await db.insert(questions).values({
            userId: session.dbUserId,
            bookId: typeof q.bookId === 'number' ? q.bookId : null,
            bookTitle: String(q.bookTitle || ''),
            chapter: String(q.chapter || 'সাধারণ অধ্যায়'),
            pageNumber: Number(q.pageNumber || 1),
            subject: String(q.subject || 'সাধারণ জ্ঞান'),
            questionType: String(q.questionType || 'MCQ'),
            difficulty: String(q.difficulty || 'Medium'),
            stem: String(q.stem || ''),
            options: Array.isArray(q.options) ? (q.options as string[]) : [],
            correctOptionIndex:
              typeof q.correctOptionIndex === 'number'
                ? q.correctOptionIndex
                : null,
            modelAnswer: String(q.modelAnswer || ''),
            explanation: String(q.explanation || ''),
            isPreviousYear: Boolean(q.isPreviousYear),
            examYear: q.examYear ? String(q.examYear) : null,
            examSource: q.examSource ? String(q.examSource) : null,
            importanceScore: Number(q.importanceScore || 80),
          });
        }
        break;
      }

      case 'delete_question': {
        await db
          .delete(questions)
          .where(
            and(
              eq(questions.id, Number(payload.id)),
              eq(questions.userId, session.dbUserId)
            )
          );
        break;
      }

      case 'create_exam': {
        await db.insert(exams).values({
          userId: session.dbUserId,
          title: String(payload.title || 'কাস্টম পরীক্ষা'),
          subject: String(payload.subject || 'সমন্বিত'),
          examMode: String(payload.examMode || 'Mixed'),
          durationMinutes: Number(payload.durationMinutes || 15),
          marksPerQuestion: Number(payload.marksPerQuestion || 1),
          negativeMark: Number(payload.negativeMark ?? 0.25),
          questionIds: Array.isArray(payload.questionIds)
            ? payload.questionIds.map(Number)
            : [],
          status: 'draft',
          draftAnswers: {},
        });
        break;
      }

      case 'save_exam_draft': {
        await db
          .update(exams)
          .set({
            status: 'in_progress',
            draftAnswers: payload.draftAnswers ?? {},
          })
          .where(
            and(
              eq(exams.id, Number(payload.examId)),
              eq(exams.userId, session.dbUserId)
            )
          );
        break;
      }

      case 'save_attempt': {
        const [insertedAttempt] = await db
          .insert(examAttempts)
          .values({
            userId: session.dbUserId,
            examId: typeof payload.examId === 'number' ? payload.examId : null,
            examTitle: String(payload.examTitle || 'পরীক্ষা'),
            subject: String(payload.subject || 'সমন্বিত'),
            totalMarks: Number(payload.totalMarks || 0),
            obtainedMarks: Number(payload.obtainedMarks || 0),
            negativeDeduction: Number(payload.negativeDeduction || 0),
            correctCount: Number(payload.correctCount || 0),
            wrongCount: Number(payload.wrongCount || 0),
            skippedCount: Number(payload.skippedCount || 0),
            mcqAccuracy: Number(payload.mcqAccuracy || 0),
            writtenScore: Number(payload.writtenScore || 0),
            durationSeconds: Number(payload.durationSeconds || 0),
            evaluations: Array.isArray(payload.evaluations)
              ? payload.evaluations
              : [],
            weakTopics: Array.isArray(payload.weakTopics)
              ? payload.weakTopics
              : [],
            aiRecommendation: String(payload.aiRecommendation || ''),
          })
          .returning();

        const newMistakes: Array<Record<string, unknown>> = Array.isArray(
          payload.mistakes
        )
          ? payload.mistakes
          : [];
        for (const m of newMistakes) {
          await db.insert(mistakes).values({
            userId: session.dbUserId,
            questionId: typeof m.questionId === 'number' ? m.questionId : null,
            attemptId: insertedAttempt.id,
            questionStem: String(m.questionStem || ''),
            subject: String(m.subject || ''),
            chapter: String(m.chapter || 'সাধারণ অধ্যায়'),
            userAnswer: String(m.userAnswer || ''),
            correctAnswer: String(m.correctAnswer || ''),
            reason: String(m.reason || ''),
            mastered: false,
            reviewCount: 0,
            nextReviewDate: String(m.nextReviewDate || ''),
          });
        }
        break;
      }

      case 'toggle_mistake': {
        await db
          .update(mistakes)
          .set({
            mastered: Boolean(payload.mastered),
            reviewCount: Number(payload.reviewCount || 1),
          })
          .where(
            and(
              eq(mistakes.id, Number(payload.id)),
              eq(mistakes.userId, session.dbUserId)
            )
          );
        break;
      }

      case 'create_gk': {
        await db.insert(currentGkItems).values({
          userId: session.dbUserId,
          title: String(payload.title || ''),
          summary: String(payload.summary || ''),
          category: String(payload.category || 'জাতীয়'),
          eventDate: String(payload.eventDate || new Date().toISOString().slice(0, 10)),
          source: String(payload.source || 'দৈনিক সংবাদপত্র'),
          isArchived: Boolean(payload.isArchived),
          convertedToQuestions: false,
        });
        break;
      }

      case 'toggle_gk_archive': {
        await db
          .update(currentGkItems)
          .set({ isArchived: Boolean(payload.isArchived) })
          .where(
            and(
              eq(currentGkItems.id, Number(payload.id)),
              eq(currentGkItems.userId, session.dbUserId)
            )
          );
        break;
      }

      case 'create_task': {
        await db.insert(studyTasks).values({
          userId: session.dbUserId,
          title: String(payload.title || ''),
          subject: String(payload.subject || 'সাধারণ'),
          chapter: String(payload.chapter || ''),
          taskType: String(payload.taskType || 'reading'),
          scheduledDate: String(
            payload.scheduledDate || new Date().toISOString().slice(0, 10)
          ),
          durationMinutes: Number(payload.durationMinutes || 45),
          completed: false,
        });
        break;
      }

      case 'toggle_task': {
        await db
          .update(studyTasks)
          .set({ completed: Boolean(payload.completed) })
          .where(
            and(
              eq(studyTasks.id, Number(payload.id)),
              eq(studyTasks.userId, session.dbUserId)
            )
          );
        break;
      }

      case 'delete_task': {
        await db
          .delete(studyTasks)
          .where(
            and(
              eq(studyTasks.id, Number(payload.id)),
              eq(studyTasks.userId, session.dbUserId)
            )
          );
        break;
      }

      default:
        return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }

    const updated = await loadUserWorkspace(session.dbUserId);
    return NextResponse.json({ workspace: updated });
  } catch (error) {
    console.error('POST /api/workspace failed:', error);
    return NextResponse.json(
      { error: 'Database update failed. Please try again.' },
      { status: 500 }
    );
  }
}
