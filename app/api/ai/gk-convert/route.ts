import { NextRequest, NextResponse } from 'next/server';
import { Type } from '@google/genai';
import { GEMINI_MODEL, getGeminiClient } from '@/src/lib/gemini';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const title = String(body.title || '').trim();
    const summary = String(body.summary || '').trim();
    const category = String(body.category || 'সাম্প্রতিক সাধারণ জ্ঞান');
    const eventDate = String(body.eventDate || '');
    const source = String(body.source || '');

    if (!title || !summary) {
      return NextResponse.json(
        { error: 'ঘটনার শিরোনাম ও সারসংক্ষেপ প্রয়োজন।' },
        { status: 400 }
      );
    }

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `নিচের সাম্প্রতিক ঘটনাটিকে বাংলাদেশের চাকরি পরীক্ষার (BCS, Bank, Govt) উপযোগী ২টি MCQ এবং ১টি Short লিখিত প্রশ্নে রূপান্তর করো।
ঘটনার শিরোনাম: ${title}
তারিখ: ${eventDate}
উৎস: ${source}
ক্যাটাগরি: ${category}
বিস্তারিত: ${summary}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              questionType: { type: Type.STRING },
              difficulty: { type: Type.STRING },
              stem: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              correctOptionIndex: { type: Type.INTEGER },
              modelAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: [
              'questionType',
              'difficulty',
              'stem',
              'options',
              'modelAnswer',
              'explanation',
            ],
          },
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '[]').trim());
    const items = (Array.isArray(parsed) ? parsed : []).map(
      (q: Record<string, unknown>) => {
        const qType =
          q.questionType === 'Short' || q.questionType === 'Written'
            ? q.questionType
            : 'MCQ';
        const options =
          qType === 'MCQ' && Array.isArray(q.options)
            ? q.options.slice(0, 4).map(String)
            : [];
        return {
          bookId: null,
          bookTitle: `সাম্প্রতিক GK (${source || 'সংবাদ উৎস'})`,
          chapter: `${category} · ${eventDate}`,
          pageNumber: 1,
          subject: 'সাম্প্রতিক সাধারণ জ্ঞান',
          questionType: qType,
          difficulty:
            q.difficulty === 'Easy' || q.difficulty === 'Hard'
              ? q.difficulty
              : 'Medium',
          stem: String(q.stem || ''),
          options,
          correctOptionIndex:
            qType === 'MCQ'
              ? Math.max(0, Math.min(3, Number(q.correctOptionIndex ?? 0)))
              : null,
          modelAnswer: String(q.modelAnswer || ''),
          explanation: String(q.explanation || ''),
          isPreviousYear: false,
          examYear: null,
          examSource: null,
          importanceScore: 88,
        };
      }
    );

    return NextResponse.json({ questions: items });
  } catch (error) {
    console.error('POST /api/ai/gk-convert failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'সাম্প্রতিক ঘটনা থেকে প্রশ্ন তৈরি করা যায়নি।',
      },
      { status: 500 }
    );
  }
}
