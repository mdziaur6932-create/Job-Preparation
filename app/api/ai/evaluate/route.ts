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

interface WrittenEvalInput {
  questionId: number;
  stem: string;
  modelAnswer: string;
  userAnswer: string;
  maxMarks: number;
  bookTitle: string;
  pageNumber: number;
}

interface EvaluateAiResponse {
  writtenGrades?: Array<{
    questionId: number;
    awardedMarks: number;
    mistakeExplanation: string;
    improvementTip: string;
    modelAnswer: string;
  }>;
  aiRecommendation?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const writtenItems: WrittenEvalInput[] = Array.isArray(body.writtenItems)
      ? (body.writtenItems as WrittenEvalInput[])
      : [];
    const examTitle = String(body.examTitle || 'পরীক্ষা');
    const weakTopics: string[] = Array.isArray(body.weakTopics)
      ? body.weakTopics.map(String)
      : [];
    const mcqAccuracy = Number(body.mcqAccuracy ?? 0);

    if (writtenItems.length === 0) {
      const recRes = await generateWithRetry(
        {
          model: GEMINI_MODEL,
          contents: `পরীক্ষার নাম: ${examTitle}
MCQ নির্ভুলতা: ${mcqAccuracy}%
দুর্বল অধ্যায়সমূহ: ${weakTopics.length > 0 ? weakTopics.join(', ') : 'কোনো বড় দুর্বলতা নেই'}

বাংলাদেশের বিসিএস ও ব্যাংক পরীক্ষার একজন অভিজ্ঞ পরামর্শদাতা হিসেবে ২-৩ বাক্যে সুনির্দিষ্ট পরবর্তী প্রস্তুতি পরামর্শ দিন।`,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        },
        {
          timeoutMs: DEFAULT_AI_TIMEOUT_MS,
          signal: req.signal,
        }
      );
      return NextResponse.json({
        writtenGrades: [],
        aiRecommendation: (recRes.text ?? '').trim(),
      });
    }

    const promptItems = writtenItems
      .map(
        (item, idx) =>
          `[${idx + 1}] questionId=${item.questionId} | সর্বোচ্চ নম্বর=${item.maxMarks} | উৎস=${item.bookTitle} (পৃষ্ঠা ${item.pageNumber})
প্রশ্ন: ${item.stem}
আদর্শ মডেল উত্তর: ${item.modelAnswer}
পরীক্ষার্থীর উত্তর: ${item.userAnswer}`
      )
      .join('\n\n');

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: `তুমি একজন কঠোর ও ন্যায়নিষ্ঠ বিসিএস/ব্যাংক লিখিত পরীক্ষার পরীক্ষক। নিচের লিখিত উত্তরগুলো মূল্যায়ন করো এবং প্রতিটি প্রশ্নের জন্য নম্বর (0 থেকে maxMarks), কোথায় ভুল বা ঘাটতি হয়েছে (mistakeExplanation), কীভাবে উত্তর আরও ভালো করা যাবে (improvementTip), এবং একটি সংক্ষিপ্ত উন্নত মডেল উত্তর (modelAnswer) দাও। পাশাপাশি সামগ্রিক পরামর্শ (aiRecommendation) দাও।

${promptItems}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              writtenGrades: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    questionId: { type: Type.INTEGER },
                    awardedMarks: { type: Type.NUMBER },
                    mistakeExplanation: { type: Type.STRING },
                    improvementTip: { type: Type.STRING },
                    modelAnswer: { type: Type.STRING },
                  },
                  required: [
                    'questionId',
                    'awardedMarks',
                    'mistakeExplanation',
                    'improvementTip',
                    'modelAnswer',
                  ],
                },
              },
              aiRecommendation: { type: Type.STRING },
            },
            required: ['writtenGrades', 'aiRecommendation'],
          },
        },
      },
      {
        timeoutMs: DEFAULT_AI_TIMEOUT_MS,
        signal: req.signal,
      }
    );

    const parsed = parseAiJson<EvaluateAiResponse>(response.text, 'object');
    return NextResponse.json({
      writtenGrades: Array.isArray(parsed.writtenGrades)
        ? parsed.writtenGrades
        : [],
      aiRecommendation: String(parsed.aiRecommendation || '').trim(),
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/evaluate',
      'AI লিখিত মূল্যায়ন সম্পন্ন করতে সমস্যা হয়েছে।'
    );
  }
}
