import { NextRequest, NextResponse } from 'next/server';
import { ThinkingLevel, Type } from '@google/genai';
import {
  DEFAULT_AI_TIMEOUT_MS,
  GEMINI_MODEL,
  generateWithRetry,
  mapAiErrorToHttpResponse,
  parseAiJson,
  parseJsonBody,
} from '@/src/lib/gemini';
import { deduplicateQuestions } from '@/src/lib/rag-engine';

interface SourceChunk {
  bookId: number;
  bookTitle: string;
  chapter: string;
  pageNumber: number;
  content: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const chunks: SourceChunk[] = Array.isArray(body.chunks)
      ? (body.chunks.slice(0, 8) as SourceChunk[])
      : [];
    const existingStems: string[] = Array.isArray(body.existingStems)
      ? body.existingStems.slice(0, 60).map(String)
      : [];
    const rawType = String(body.questionType || 'MCQ');
    const questionType: 'MCQ' | 'Written' | 'Short' =
      rawType === 'Written' || rawType === 'Short' ? rawType : 'MCQ';
    const rawDiff = String(body.difficulty || 'Medium');
    const difficulty: 'Easy' | 'Medium' | 'Hard' =
      rawDiff === 'Easy' || rawDiff === 'Hard' ? rawDiff : 'Medium';
    const count = Math.min(10, Math.max(1, Number(body.count || 4) || 4));
    const subject: string = String(body.subject || 'সাধারণ জ্ঞান');
    const topicHint: string = String(body.topicHint || '').trim();

    if (chunks.length === 0) {
      return NextResponse.json(
        {
          error: 'প্রশ্ন তৈরির জন্য অন্তত একটি বই বা অধ্যায় নির্বাচন করুন।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const contextText = chunks
      .map(
        (c, idx) =>
          `[উৎস ${idx + 1}: বই="${c.bookTitle}" | অধ্যায়="${c.chapter}" | পৃষ্ঠা=${c.pageNumber}]\n${c.content}`
      )
      .join('\n\n');

    const avoidList =
      existingStems.length > 0
        ? `\nনিচের বিদ্যমান প্রশ্নগুলোর পুনরাবৃত্তি করবে না:\n- ${existingStems.join('\n- ')}`
        : '';

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: `নিচের Knowledge Base অংশগুলো বিশ্লেষণ করে বাংলাদেশের চাকরি পরীক্ষার (BCS, Bank, Govt) মানসম্মত ${count}টি নতুন "${questionType}" প্রশ্ন তৈরি করো।
বিষয়: ${subject}
কঠিনতার মাত্রা: ${difficulty}
${topicHint ? `বিশেষ নির্দেশনা/টপিক: ${topicHint}` : ''}
${avoidList}

নিয়মাবলি:
- MCQ হলে অবশ্যই ৪টি মানসম্মত বাংলা বিকল্প (options) এবং সঠিক উত্তরের সূচক (correctOptionIndex: 0 থেকে 3) দিতে হবে।
- Written বা Short হলে options ফাঁকা অ্যারে [] এবং একটি সমৃদ্ধ মডেল উত্তর (modelAnswer) দিতে হবে।
- প্রতিটি প্রশ্নে সংশ্লিষ্ট উৎস বইয়ের নাম (bookTitle), অধ্যায় (chapter), পৃষ্ঠা নম্বর (pageNumber), ব্যাখ্যা (explanation), এবং পরীক্ষায় আসার সম্ভাব্যতা (importanceScore: 60-99) দিতে হবে।

উৎসসমূহ:
${contextText}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                stem: { type: Type.STRING },
                options: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                correctOptionIndex: { type: Type.INTEGER },
                modelAnswer: { type: Type.STRING },
                explanation: { type: Type.STRING },
                bookTitle: { type: Type.STRING },
                chapter: { type: Type.STRING },
                pageNumber: { type: Type.INTEGER },
                importanceScore: { type: Type.INTEGER },
              },
              required: [
                'stem',
                'options',
                'modelAnswer',
                'explanation',
                'bookTitle',
                'chapter',
                'pageNumber',
                'importanceScore',
              ],
            },
          },
        },
      },
      {
        timeoutMs: DEFAULT_AI_TIMEOUT_MS,
        signal: req.signal,
      }
    );

    const rawItems = parseAiJson<Array<Record<string, unknown>>>(
      response.text,
      'array'
    );

    const normalized = rawItems.map((item) => {
      const matchedChunk =
        chunks.find((c) => c.bookTitle === item.bookTitle) ?? chunks[0];
      const options =
        questionType === 'MCQ' && Array.isArray(item.options)
          ? item.options.slice(0, 4).map(String)
          : [];
      const correctIdx =
        questionType === 'MCQ'
          ? Math.max(0, Math.min(3, Number(item.correctOptionIndex ?? 0)))
          : null;

      return {
        bookId: matchedChunk.bookId,
        bookTitle: String(item.bookTitle || matchedChunk.bookTitle),
        chapter: String(item.chapter || matchedChunk.chapter),
        pageNumber: Number(item.pageNumber || matchedChunk.pageNumber || 1),
        subject,
        questionType,
        difficulty,
        stem: String(item.stem || '').trim(),
        options,
        correctOptionIndex: correctIdx,
        modelAnswer:
          String(item.modelAnswer || '').trim() ||
          (correctIdx !== null ? options[correctIdx] ?? '' : ''),
        explanation: String(item.explanation || '').trim(),
        isPreviousYear: false,
        examYear: null,
        examSource: null,
        importanceScore: Math.min(
          99,
          Math.max(55, Number(item.importanceScore || 82))
        ),
      };
    });

    const uniqueQuestions = deduplicateQuestions(
      normalized,
      existingStems.map((stem) => ({ stem }))
    );

    return NextResponse.json({
      questions: uniqueQuestions,
      filteredDuplicates: normalized.length - uniqueQuestions.length,
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/questions',
      'AI প্রশ্ন তৈরি করতে সমস্যা হয়েছে।'
    );
  }
}
