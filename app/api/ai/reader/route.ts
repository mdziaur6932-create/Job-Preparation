import { NextRequest, NextResponse } from 'next/server';
import { ThinkingLevel } from '@google/genai';
import {
  DEFAULT_AI_TIMEOUT_MS,
  GEMINI_MODEL,
  generateWithRetry,
  mapAiErrorToHttpResponse,
  parseJsonBody,
} from '@/src/lib/gemini';

interface ChunkPayload {
  bookTitle: string;
  chapter: string;
  pageNumber: number;
  content: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const rawMode = String(body.mode || 'summary');
    const mode: 'summary' | 'facts' | 'explain' | 'compare' =
      rawMode === 'facts' || rawMode === 'explain' || rawMode === 'compare'
        ? rawMode
        : 'summary';
    const topic: string = String(body.topic || '').trim();
    const chunks: ChunkPayload[] = Array.isArray(body.chunks)
      ? (body.chunks.slice(0, 8) as ChunkPayload[])
      : [];

    if (chunks.length === 0) {
      return NextResponse.json(
        {
          error: 'বিশ্লেষণের জন্য অন্তত একটি অধ্যায় বা বইয়ের অংশ নির্বাচন করুন।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const contextBlock = chunks
      .map(
        (c, i) =>
          `[উৎস ${i + 1}: ${c.bookTitle} | ${c.chapter} | পৃষ্ঠা ${c.pageNumber}]\n${c.content}`
      )
      .join('\n\n');

    const modeInstruction: Record<typeof mode, string> = {
      summary:
        'প্রদত্ত উৎসগুলোর আলোকে চাকরির পরীক্ষার উপযোগী একটি সুসংগঠিত সারাংশ (Summary) বাংলায় লিখুন। প্রতিটি গুরুত্বপূর্ণ তথ্যের পাশে [বইয়ের নাম, পৃষ্ঠা নং] উল্লেখ করুন।',
      facts:
        'প্রদত্ত উৎসগুলো থেকে পরীক্ষার জন্য সর্বোচ্চ গুরুত্বপূর্ণ তথ্য, সাল, অনুচ্ছেদ, সংখ্যা ও মূল সংজ্ঞাসমূহ বুলেট পয়েন্টে বের করে দিন। প্রতিটি পয়েন্টে [বইয়ের নাম, পৃষ্ঠা নং] উল্লেখ করুন।',
      explain:
        'প্রদত্ত কঠিন বিষয়টি একজন ব্যক্তিগত AI শিক্ষকের মতো অত্যন্ত সহজ বাংলা ভাষায় ধাপে ধাপে ও বাস্তব উদাহরণসহ ব্যাখ্যা করুন। প্রতিটি তথ্যের উৎস [বইয়ের নাম, পৃষ্ঠা নং] উল্লেখ করুন।',
      compare:
        'একাধিক বইয়ের প্রদত্ত অংশগুলো বিশ্লেষণ করে একই টপিকের তথ্য একত্রিত ও তুলনা করুন। কোন বইয়ে কোন অতিরিক্ত বা বিশেষ তথ্য আছে তা স্পষ্টভাবে [বইয়ের নাম, পৃষ্ঠা নং] রেফারেন্সসহ উপস্থাপন করুন।',
    };

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: `টপিক / প্রশ্ন: ${topic || 'নির্বাচিত অধ্যায়সমূহ'}\n\nনির্দেশনা: ${modeInstruction[mode]}\n\nসংগৃহীত Knowledge Base অংশ:\n${contextBlock}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction:
            'You are an expert Bangladeshi job preparation teacher (BCS, Bank, Govt exams). Answer strictly from the provided RAG source excerpts in crisp, well-structured Bengali with exact [Book Name, পৃষ্ঠা X] citations. Never fabricate facts outside the provided excerpts.',
        },
      },
      {
        timeoutMs: DEFAULT_AI_TIMEOUT_MS,
        signal: req.signal,
      }
    );

    return NextResponse.json({
      result: (response.text ?? '').trim(),
      citations: chunks.map((c) => ({
        bookTitle: c.bookTitle,
        chapter: c.chapter,
        pageNumber: c.pageNumber,
      })),
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/reader',
      'স্মার্ট রিডার বিশ্লেষণ তৈরি করতে সমস্যা হয়েছে।'
    );
  }
}
