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

interface HandwrittenImageInput {
  mimeType: string;
  base64: string;
}

interface WrittenEvalInput {
  questionId: number;
  stem: string;
  modelAnswer: string;
  userAnswer: string;
  maxMarks: number;
  bookTitle: string;
  pageNumber: number;
  handwrittenImages?: HandwrittenImageInput[];
}

interface EvaluateAiResponse {
  writtenGrades?: Array<{
    questionId: number;
    awardedMarks: number;
    mistakeExplanation: string;
    improvementTip: string;
    modelAnswer: string;
    transcribedAnswer?: string;
  }>;
  aiRecommendation?: string;
}

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGES_PER_QUESTION = 2;
const MAX_TOTAL_IMAGES = 8;
const MAX_IMAGE_BYTES = 2.6 * 1024 * 1024;

function isValidImageMagic(buf: Buffer, mimeType: string): boolean {
  if (buf.length < 4) return false;
  if (mimeType === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8;
  }
  if (mimeType === 'image/png') {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'evaluate');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const writtenItems: WrittenEvalInput[] = Array.isArray(body.writtenItems)
      ? (body.writtenItems.slice(0, 20) as WrittenEvalInput[])
      : [];
    const examTitle = String(body.examTitle || 'পরীক্ষা').slice(0, 180);
    const weakTopics: string[] = Array.isArray(body.weakTopics)
      ? body.weakTopics.slice(0, 15).map(String)
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
          fallbackModel: GEMINI_FAST_OCR_MODEL,
          signal: req.signal,
        }
      );
      return NextResponse.json({
        writtenGrades: [],
        aiRecommendation: (recRes.text ?? '').trim(),
      });
    }

    // Validate optional handwritten answer-sheet photos strictly
    let totalAttachedImages = 0;
    const contentParts: Array<
      { text: string } | { inlineData: { mimeType: string; data: string } }
    > = [];

    contentParts.push({
      text: `তুমি একজন কঠোর ও ন্যায়নিষ্ঠ বাংলাদেশের সরকারি চাকরি (বিসিএস/ব্যাংক/মন্ত্রণালয়) লিখিত পরীক্ষার পরীক্ষক।
নিচের প্রতিটি লিখিত প্রশ্নের উত্তর (টাইপ করা উত্তর এবং সংযুক্ত থাকলে হাতে লেখা খাতার ছবি) মনোযোগ দিয়ে মূল্যায়ন করো:
- প্রতিটি প্রশ্নের উপ-প্রশ্ন (ক, খ, গ...) বা গণিতের প্রতিটি ধাপ যাচাই করে 0 থেকে সর্বোচ্চ নম্বর (maxMarks)-এর মধ্যে ন্যায্য নম্বর (awardedMarks) দাও।
- হাতে লেখা খাতার ছবি সংযুক্ত থাকলে প্রথমে ছবিটি পড়ে পরীক্ষার্থী কী লিখেছে তা transcribedAnswer-এ সংক্ষেপে লেখো এবং সেই লেখা অনুযায়ী ধাপে ধাপে নম্বর দাও।
- কোথায় ভুল বা ঘাটতি হয়েছে (mistakeExplanation), কীভাবে উত্তর আরও ভালো করা যাবে (improvementTip), এবং একটি নির্ভুল মডেল উত্তর (modelAnswer) দাও। পাশাপাশি সামগ্রিক পরামর্শ (aiRecommendation) দাও।`,
    });

    for (let idx = 0; idx < writtenItems.length; idx += 1) {
      const item = writtenItems[idx];
      const maxMarks = Math.max(1, Math.min(50, Number(item.maxMarks || 5)));
      const safeUserAns = String(item.userAnswer || '').trim().slice(0, 6000);
      const validImgs: HandwrittenImageInput[] = [];

      if (Array.isArray(item.handwrittenImages)) {
        for (const img of item.handwrittenImages.slice(0, MAX_IMAGES_PER_QUESTION)) {
          if (totalAttachedImages >= MAX_TOTAL_IMAGES) break;
          if (!img || typeof img !== 'object') continue;
          const mimeType = String(img.mimeType || '').trim().toLowerCase();
          const base64 = String(img.base64 || '').trim();
          if (!ALLOWED_IMAGE_MIMES.has(mimeType) || !base64) continue;
          const estBytes = Math.floor((base64.length * 3) / 4);
          if (estBytes > MAX_IMAGE_BYTES) {
            return NextResponse.json(
              {
                error: 'হাতে লেখা খাতার ছবির আকার নির্ধারিত সীমার বেশি।',
                code: 'PAYLOAD_TOO_LARGE',
                retryable: false,
              },
              { status: 413 }
            );
          }
          const headBuf = Buffer.from(base64.slice(0, 64), 'base64');
          if (!isValidImageMagic(headBuf, mimeType)) {
            return NextResponse.json(
              {
                error: 'সংযুক্ত হাতে লেখা খাতার ফাইলটি সঠিক ছবি (JPG/PNG/WebP) নয়।',
                code: 'INVALID_REQUEST',
                retryable: false,
              },
              { status: 400 }
            );
          }
          validImgs.push({ mimeType, base64 });
          totalAttachedImages += 1;
        }
      }

      contentParts.push({
        text: `\n[${idx + 1}] questionId=${Number(item.questionId)} | সর্বোচ্চ নম্বর=${maxMarks} | উৎস=${String(item.bookTitle || '').slice(0, 140)} (পৃষ্ঠা ${Number(item.pageNumber || 1)})
প্রশ্ন: ${String(item.stem || '').slice(0, 3500)}
আদর্শ মডেল উত্তর: ${String(item.modelAnswer || '').slice(0, 5000)}
পরীক্ষার্থীর টাইপ করা উত্তর: ${safeUserAns || (validImgs.length > 0 ? '(নিচের সংযুক্ত হাতে লেখা খাতার ছবিতে উত্তর দেওয়া আছে)' : '(ফাঁকা)')}`,
      });

      for (let imgIdx = 0; imgIdx < validImgs.length; imgIdx += 1) {
        contentParts.push({
          text: `[প্রশ্ন questionId=${Number(item.questionId)}-এর হাতে লেখা খাতার ছবি #${imgIdx + 1}]`,
        });
        contentParts.push({
          inlineData: {
            mimeType: validImgs[imgIdx].mimeType,
            data: validImgs[imgIdx].base64,
          },
        });
      }
    }

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: { parts: contentParts },
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
                    transcribedAnswer: { type: Type.STRING },
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
        timeoutMs: Math.max(
          DEFAULT_AI_TIMEOUT_MS,
          totalAttachedImages > 0 ? 50_000 : DEFAULT_AI_TIMEOUT_MS
        ),
        fallbackModel: GEMINI_FAST_OCR_MODEL,
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
