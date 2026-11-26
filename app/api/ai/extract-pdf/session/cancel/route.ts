import { NextRequest, NextResponse } from 'next/server';
import { guardPdfSessionRequest } from '@/src/lib/ai-api-guard';
import { mapAiErrorToHttpResponse, parseJsonBody } from '@/src/lib/gemini';
import { safeDeleteGeminiFile } from '@/src/lib/pdf-extractor-service';
import {
  cleanupAndDeletePdfSession,
  getOwnedPdfSession,
} from '@/src/lib/pdf-session-store';

interface CancelBody {
  sessionId?: string;
}

export async function POST(req: NextRequest) {
  const guard = await guardPdfSessionRequest(req, 'session-control');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<CancelBody>(req);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';

    const lookup = getOwnedPdfSession(sessionId, guard.session.dbUserId);
    if (!lookup.ok) {
      if (lookup.status === 404) {
        return NextResponse.json({
          ok: true,
          cancelled: true,
          alreadyCleaned: true,
        });
      }
      return NextResponse.json(
        {
          error: lookup.error,
          code: lookup.code,
          retryable: false,
        },
        { status: lookup.status }
      );
    }

    await cleanupAndDeletePdfSession(lookup.session.sessionId, safeDeleteGeminiFile);

    return NextResponse.json({
      ok: true,
      cancelled: true,
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/extract-pdf/session/cancel',
      'আপলোড সেশন বাতিল করতে সমস্যা হয়েছে।'
    );
  }
}
