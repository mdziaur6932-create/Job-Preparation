import { NextRequest, NextResponse } from 'next/server';
import { ThinkingLevel, Type } from '@google/genai';
import {
  DEFAULT_AI_TIMEOUT_MS,
  GEMINI_FAST_OCR_MODEL,
  GEMINI_MODEL,
  generateWithRetry,
  mapAiErrorToHttpResponse,
  parseAiJson,
  parseJsonBody,
} from '@/src/lib/gemini';
import { guardAiApiRequest } from '@/src/lib/ai-api-guard';
import { encodeExplanationWithSource } from '@/src/lib/demo-paper-blueprint';

interface ExplainRequestItem {
  questionId: number;
  stem: string;
  correctAnswer: string;
  options: string[];
  bookTitle: string;
  bookExcerpt: string;
}

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'explain-answers');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    const items: ExplainRequestItem[] = [];
    for (const entry of rawItems.slice(0, 25)) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const questionId = Number(obj.questionId || 0);
      const stem = String(obj.stem || '').trim().slice(0, 1200);
      const correctAnswer = String(obj.correctAnswer || '').trim().slice(0, 1200);
      const bookTitle = String(obj.bookTitle || '').trim().slice(0, 140);
      const bookExcerpt = String(obj.bookExcerpt || '').trim().slice(0, 1200);
      const options = Array.isArray(obj.options)
        ? obj.options.slice(0, 6).map((o) => String(o || '').trim().slice(0, 200))
        : [];
      if (!questionId || !stem) continue;
      items.push({
        questionId,
        stem,
        correctAnswer,
        options,
        bookTitle,
        bookExcerpt,
      });
    }

    if (items.length === 0) {
      return NextResponse.json(
        {
          error: 'ব্যাখ্যা তৈরির জন্য অন্তত ১টি প্রশ্ন প্রয়োজন।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const promptItems = items
      .map(
        (it, idx) =>
          `${idx + 1}. questionId=${it.questionId}
প্রশ্ন: ${it.stem}
${it.options.length > 0 ? `বিকল্প: ${it.options.join(' | ')}\n` : ''}সঠিক উত্তর: ${it.correctAnswer}
উৎস বই (${it.bookTitle || 'অনির্ধারিত'}) প্রাসঙ্গিক অংশ: ${it.bookExcerpt || 'বইয়ে আলাদা ব্যাখ্যা নেই'}`
      )
      .join('\n\n');

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: `তুমি বাংলাদেশের বিসিএস ও সরকারি চাকরি পরীক্ষার একজন অভিজ্ঞ শিক্ষক।
নিচের প্রতিটি প্রশ্নের জন্য পরিষ্কার, নির্ভুল ও তথ্যবহুল বাংলা ব্যাখ্যা দাও।

গুরুত্বপূর্ণ নিয়ম:
১. যদি "উৎস বই প্রাসঙ্গিক অংশ"-এ এই প্রশ্নের ব্যাখ্যা বা সমাধান সরাসরি দেওয়া থাকে, তবে বইয়ের সেই ব্যাখ্যাটি সুন্দরভাবে উপস্থাপন করো এবং explanationSource="book" দাও।
২. যদি উৎস বইয়ের অংশে এই প্রশ্নের ব্যাখ্যা না থাকে, তবে নিজে নির্ভুল, সহজবোধ্য ও পরীক্ষায় কাজে লাগে এমন ব্যাখ্যা লেখো এবং অবশ্যই explanationSource="ai" দাও।
৩. গণিতের সূত্র বা হিসাব থাকলে পরিষ্কার LaTeX ($...$) ব্যবহার করো।

প্রশ্নসমূহ:
${promptItems}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                questionId: { type: Type.INTEGER },
                explanationSource: { type: Type.STRING },
                explanation: { type: Type.STRING },
              },
              required: ['questionId', 'explanationSource', 'explanation'],
            },
          },
        },
      },
      {
        timeoutMs: DEFAULT_AI_TIMEOUT_MS,
        fallbackModel: GEMINI_FAST_OCR_MODEL,
        signal: req.signal,
      }
    );

    const parsed = parseAiJson<Array<Record<string, unknown>>>(
      response.text,
      'array'
    );

    const validIds = new Set(items.map((it) => it.questionId));
    const explanations = parsed
      .map((row) => {
        const questionId = Number(row.questionId || 0);
        if (!validIds.has(questionId)) return null;
        const source: 'book' | 'ai' =
          String(row.explanationSource || '').toLowerCase() === 'book'
            ? 'book'
            : 'ai';
        const rawText = String(row.explanation || '').trim();
        if (!rawText) return null;
        return {
          questionId,
          explanationSource: source,
          explanation: encodeExplanationWithSource(rawText, source, 4000),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return NextResponse.json({ explanations });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/explain-answers',
      'AI দিয়ে প্রশ্নের ব্যাখ্যা তৈরি করা যায়নি।'
    );
  }
}
