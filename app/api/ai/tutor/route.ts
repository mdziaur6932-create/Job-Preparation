import { NextRequest, NextResponse } from 'next/server';
import { ThinkingLevel } from '@google/genai';
import {
  DEFAULT_AI_TIMEOUT_MS,
  GEMINI_FAST_OCR_MODEL,
  GEMINI_MODEL,
  generateWithRetry,
  mapAiErrorToHttpResponse,
  parseJsonBody,
} from '@/src/lib/gemini';
import { guardAiApiRequest } from '@/src/lib/ai-api-guard';

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'tutor');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const message = String(body.message || '').trim();
    const mode: 'tutor' | 'viva' = body.mode === 'viva' ? 'viva' : 'tutor';
    const history: Array<{ role: 'user' | 'assistant'; text: string }> =
      Array.isArray(body.history)
        ? (body.history.slice(-8) as Array<{
            role: 'user' | 'assistant';
            text: string;
          }>)
        : [];
    const chunks: Array<{
      bookTitle: string;
      chapter: string;
      pageNumber: number;
      content: string;
    }> = Array.isArray(body.chunks)
      ? (body.chunks.slice(0, 5) as Array<{
          bookTitle: string;
          chapter: string;
          pageNumber: number;
          content: string;
        }>)
      : [];

    if (!message) {
      return NextResponse.json(
        {
          error: 'অনুগ্রহ করে আপনার প্রশ্ন বা উত্তর লিখুন।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const ragContext =
      chunks.length > 0
        ? `\n\nশিক্ষার্থীর লাইব্রেরি থেকে সংগৃহীত প্রাসঙ্গিক তথ্য:\n${chunks
            .map(
              (c) =>
                `[${c.bookTitle}, ${c.chapter}, পৃষ্ঠা ${c.pageNumber}]: ${c.content}`
            )
            .join('\n')}`
        : '';

    const transcript = history
      .map((h) => `${h.role === 'user' ? 'শিক্ষার্থী' : 'AI শিক্ষক'}: ${h.text}`)
      .join('\n');

    const systemInstruction =
      mode === 'viva'
        ? 'You are a formal, encouraging BCS & Bank Viva Board Examiner in Bangladesh. Evaluate the candidate’s previous answer briefly (strength + correction) and then ask ONE sharp, realistic follow-up viva question in Bengali grounded in the candidate’s library excerpts when available.'
        : 'You are a personal AI Study Assistant for Bangladeshi job exams (BCS, Bank, Primary, Govt). Answer concisely in clear Bengali, cite [বইয়ের নাম, পৃষ্ঠা নং] when using provided excerpts, and conclude with 1 quick practice tip.';

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: `${transcript ? `পূর্ববর্তী কথোপকথন:\n${transcript}\n\n` : ''}বর্তমান বার্তা: ${message}${ragContext}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction,
        },
      },
      {
        timeoutMs: DEFAULT_AI_TIMEOUT_MS,
        fallbackModel: GEMINI_FAST_OCR_MODEL,
        signal: req.signal,
      }
    );

    return NextResponse.json({
      reply: (response.text ?? '').trim(),
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/tutor',
      'AI শিক্ষক উত্তর তৈরি করতে পারেনি।'
    );
  }
}
