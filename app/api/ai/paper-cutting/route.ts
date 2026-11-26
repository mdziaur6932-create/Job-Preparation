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
import { detectBinaryMimeFromMagicBytes } from '@/src/lib/file-validation';
import { normalizePaperCuttingAnalysis } from '@/src/lib/paper-cutting-parser';

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB strict server ceiling

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'paper-cutting');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const rawBase64 = String(body.imageBase64 || '')
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
      .replace(/\s+/g, '');
    const declaredMime = String(body.mimeType || '')
      .trim()
      .toLowerCase()
      .replace('image/jpg', 'image/jpeg');
    const fileName = String(body.fileName || '').trim().slice(0, 140);
    const newspaperHint = String(body.newspaperHint || '').trim().slice(0, 80);
    const eventDateHint = String(body.eventDateHint || '').trim().slice(0, 24);

    if (!rawBase64) {
      return NextResponse.json(
        {
          error: 'পত্রিকার কাটিংয়ের ছবির ডেটা পাওয়া যায়নি।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    if (!ALLOWED_IMAGE_MIMES.has(declaredMime)) {
      return NextResponse.json(
        {
          error: 'শুধু JPG, PNG অথবা WebP ছবি বিশ্লেষণ করা যাবে।',
          code: 'INVALID_FILE_TYPE',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const decodedBuffer = Buffer.from(rawBase64, 'base64');
    if (decodedBuffer.length === 0) {
      return NextResponse.json(
        {
          error: 'ছবির ডেটা সঠিক নয়। অনুগ্রহ করে পুনরায় ছবি আপলোড করুন।',
          code: 'INVALID_IMAGE_DATA',
          retryable: false,
        },
        { status: 400 }
      );
    }

    if (decodedBuffer.length > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        {
          error: 'ছবির আকার সর্বোচ্চ ১০ MB-এর বেশি হতে পারবে না।',
          code: 'FILE_TOO_LARGE',
          retryable: false,
        },
        { status: 413 }
      );
    }

    const detectedMime = detectBinaryMimeFromMagicBytes(
      new Uint8Array(
        decodedBuffer.buffer,
        decodedBuffer.byteOffset,
        Math.min(decodedBuffer.byteLength, 64)
      )
    );

    if (!detectedMime || !ALLOWED_IMAGE_MIMES.has(detectedMime)) {
      return NextResponse.json(
        {
          error:
            'আপলোড করা ফাইলটি বৈধ JPG, PNG বা WebP ছবি নয়। অনুগ্রহ করে সঠিক পেপার কাটিং ছবি দিন।',
          code: 'INVALID_IMAGE_SIGNATURE',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const prompt = `তুমি বাংলাদেশের বিসিএস (BCS), ব্যাংক ও সরকারি চাকরি পরীক্ষার একজন দক্ষ সাম্প্রতিক সাধারণ জ্ঞান (Current GK) সম্পাদক।
প্রদত্ত সংবাদপত্রের কাটিং (Paper Cutting) ছবিটি মনোযোগ দিয়ে পড়ো (বাংলা ও ইংরেজি উভয় টেক্সটই নির্ভুলভাবে পড়বে)।

তোমার কাজ:
১. ছবিটিতে থাকা সংবাদের মূল শিরোনাম (headline), পত্রিকার নাম (newspaperSource — ছবিতে না থাকলে "${newspaperHint || 'দৈনিক সংবাদপত্র'}"), ঘটনার তারিখ (eventDate YYYY-MM-DD ফরম্যাটে — ছবিতে তারিখ না থাকলে "${eventDateHint || new Date().toISOString().slice(0, 10)}"), এবং সঠিক ক্যাটাগরি ("জাতীয়", "অর্থনীতি", "আন্তর্জাতিক", অথবা "বিজ্ঞান ও প্রযুক্তি") নির্ণয় করো।
২. পরীক্ষার জন্য সবচেয়ে গুরুত্বপূর্ণ তথ্যগুলো ২-৩ বাক্যে স্পষ্ট ও নির্ভুল সারসংক্ষেপে (keySummary) লেখো।
৩. ছবিটি থেকে চাকরি পরীক্ষায় আসার মতো সকল গুরুত্বপূর্ণ তথ্য (তারিখ, পরিসংখ্যান, সূচক/র‍্যাংকিং, ব্যক্তি, পুরস্কার, সংস্থা, চুক্তি, প্রকল্প, সম্মেলন, সদর দপ্তর, পূর্ণরূপ ইত্যাদি) খুঁজে বের করে ৪ থেকে ১০টি সুনির্দিষ্ট **ছোট প্রশ্ন ও উত্তর (shortQAs)** তৈরি করো।
৪. প্রতিটি ছোট প্রশ্ন হবে সংক্ষিপ্ত, এক লাইনের ও সরাসরি পরীক্ষায় আসার উপযোগী, এবং প্রতিটি উত্তর হবে একদম সুনির্দিষ্ট, নির্ভুল ও তথ্যনির্ভর।
৫. ছবিতে কোনো বিজ্ঞাপন, পৃষ্ঠা নম্বর বা অপ্রাসঙ্গিক অংশ থাকলে তা সম্পূর্ণ এড়িয়ে যাবে। কোনো তথ্য মনগড়া যোগ করবে না—শুধু ছবিতে থাকা তথ্য থেকেই প্রশ্নোত্তর তৈরি করবে।`;

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: detectedMime,
                  data: rawBase64,
                },
              },
              { text: prompt },
            ],
          },
        ],
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              headline: { type: Type.STRING },
              category: { type: Type.STRING },
              eventDate: { type: Type.STRING },
              newspaperSource: { type: Type.STRING },
              keySummary: { type: Type.STRING },
              shortQAs: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    question: { type: Type.STRING },
                    answer: { type: Type.STRING },
                    topicTag: { type: Type.STRING },
                  },
                  required: ['question', 'answer'],
                },
              },
            },
            required: [
              'headline',
              'category',
              'eventDate',
              'newspaperSource',
              'keySummary',
              'shortQAs',
            ],
          },
        },
      },
      {
        timeoutMs: DEFAULT_AI_TIMEOUT_MS,
        fallbackModel: GEMINI_FAST_OCR_MODEL,
        signal: req.signal,
      }
    );

    const parsed = parseAiJson<Record<string, unknown>>(response.text, 'object');
    const analysis = normalizePaperCuttingAnalysis(parsed, {
      fileName,
      newspaperHint,
      eventDateHint,
    });

    if (analysis.shortQAs.length === 0) {
      return NextResponse.json(
        {
          error:
            'ছবিটিতে পরীক্ষার উপযোগী স্পষ্ট টেক্সট পাওয়া যায়নি। অনুগ্রহ করে আরও স্পষ্ট পেপার কাটিং ছবি দিন।',
          code: 'NO_READABLE_CONTENT',
          retryable: false,
        },
        { status: 422 }
      );
    }

    return NextResponse.json({ analysis });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/paper-cutting',
      'পেপার কাটিং ছবিটি বিশ্লেষণ করে ছোট প্রশ্ন তৈরি করা যায়নি।'
    );
  }
}
