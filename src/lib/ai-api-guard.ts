import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateRequest,
  type AuthDependencies,
  type VerifiedSession,
} from './server-auth';
import {
  checkAiEndpointRateLimit,
  checkPdfSessionRateLimit,
  extractClientIp,
  type AiRateLimitEndpoint,
  type EndpointRateLimitConfig,
  type PdfSessionRateLimitAction,
  type RateLimitStore,
} from './rate-limit';

export const BENGALI_AUTH_REQUIRED_MESSAGE =
  'এই AI ফিচারটি ব্যবহার করতে Google অ্যাকাউন্ট দিয়ে সাইন ইন করুন। আপনার Guest Mode-এর স্থানীয় তথ্য অক্ষত থাকবে।';

export const BENGALI_AUTH_UNAVAILABLE_MESSAGE =
  'নিরাপত্তা যাচাইকরণ সেবা সাময়িকভাবে অনুপলব্ধ রয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।';

export const BENGALI_USER_RESOLUTION_UNAVAILABLE_MESSAGE =
  'ব্যবহারকারীর প্রোফাইল ডাটাবেস সেবা সাময়িকভাবে অনুপলব্ধ রয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।';

export const BENGALI_RATE_LIMIT_MESSAGE =
  'আপনি অল্প সময়ে অনেকগুলো AI অনুরোধ করেছেন। কিছুক্ষণ অপেক্ষা করে আবার চেষ্টা করুন।';

export type AiGuardResult =
  | { ok: true; session: VerifiedSession }
  | { ok: false; response: NextResponse };

export interface AiGuardOverrides {
  authDeps?: AuthDependencies;
  rateLimitStore?: RateLimitStore;
  rateLimits?: Record<AiRateLimitEndpoint, EndpointRateLimitConfig>;
  now?: () => number;
}

let testOverrides: AiGuardOverrides | null = null;

/**
 * Test-only hook allowing automated tests to mock Firebase Auth and rate-limit stores
 * when exercising the real Next.js AI route handlers.
 */
export function setAiGuardTestOverrides(overrides: AiGuardOverrides | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setAiGuardTestOverrides can only be used in test environments.');
  }
  testOverrides = overrides;
}

/**
 * Centralized security gate for all six AI endpoints:
 * 1. Verifies Firebase Bearer token (with strict fail-closed revocation checking in production
 *    and non-development environments) and resolves PostgreSQL user identity.
 * 2. Applies per-user (+ secondary IP) sliding-window rate limiting BEFORE expensive AI work.
 * 3. Returns sanitized Bengali 401 / 503 / 429 responses matching S1-T1 conventions.
 */
export async function guardAiApiRequest(
  req: NextRequest,
  endpoint: AiRateLimitEndpoint,
  overrides?: AiGuardOverrides
): Promise<AiGuardResult> {
  const activeOverrides = overrides ?? testOverrides ?? undefined;

  const authResult = await authenticateRequest(req, activeOverrides?.authDeps);
  if (!authResult.ok) {
    if (authResult.reason === 'verification_unavailable') {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: BENGALI_AUTH_UNAVAILABLE_MESSAGE,
            code: 'AUTH_VERIFICATION_UNAVAILABLE',
            retryable: true,
          },
          { status: 503 }
        ),
      };
    }

    if (authResult.reason === 'user_resolution_unavailable') {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: BENGALI_USER_RESOLUTION_UNAVAILABLE_MESSAGE,
            code: 'AUTH_USER_RESOLUTION_UNAVAILABLE',
            retryable: true,
          },
          { status: 503 }
        ),
      };
    }

    return {
      ok: false,
      response: NextResponse.json(
        {
          error: BENGALI_AUTH_REQUIRED_MESSAGE,
          code: 'AUTH_REQUIRED',
          retryable: false,
        },
        { status: 401 }
      ),
    };
  }

  const clientIp = extractClientIp(req.headers);
  const rateResult = checkAiEndpointRateLimit({
    endpoint,
    dbUserId: authResult.session.dbUserId,
    clientIp,
    nowMs: activeOverrides?.now?.(),
    store: activeOverrides?.rateLimitStore,
    limits: activeOverrides?.rateLimits,
  });

  if (!rateResult.allowed) {
    const retryAfterSeconds = Math.max(1, rateResult.retryAfterSeconds ?? 60);
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: BENGALI_RATE_LIMIT_MESSAGE,
          code: 'RATE_LIMIT_EXCEEDED',
          retryable: true,
          retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfterSeconds),
          },
        }
      ),
    };
  }

  return {
    ok: true,
    session: authResult.session,
  };
}

/**
 * Security gate for resumable PDF upload session endpoints (init, chunk, batch, finalize, cancel).
 * Enforces the exact same Firebase Bearer token verification and per-user + IP rate limiting
 * without consuming the 5/10min document extraction quota per individual 4 MB transfer chunk.
 */
export async function guardPdfSessionRequest(
  req: NextRequest,
  action: PdfSessionRateLimitAction,
  overrides?: AiGuardOverrides
): Promise<AiGuardResult> {
  const activeOverrides = overrides ?? testOverrides ?? undefined;

  const authResult = await authenticateRequest(req, activeOverrides?.authDeps);
  if (!authResult.ok) {
    if (authResult.reason === 'verification_unavailable') {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: BENGALI_AUTH_UNAVAILABLE_MESSAGE,
            code: 'AUTH_VERIFICATION_UNAVAILABLE',
            retryable: true,
          },
          { status: 503 }
        ),
      };
    }

    if (authResult.reason === 'user_resolution_unavailable') {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: BENGALI_USER_RESOLUTION_UNAVAILABLE_MESSAGE,
            code: 'AUTH_USER_RESOLUTION_UNAVAILABLE',
            retryable: true,
          },
          { status: 503 }
        ),
      };
    }

    return {
      ok: false,
      response: NextResponse.json(
        {
          error: BENGALI_AUTH_REQUIRED_MESSAGE,
          code: 'AUTH_REQUIRED',
          retryable: false,
        },
        { status: 401 }
      ),
    };
  }

  const clientIp = extractClientIp(req.headers);
  const rateResult = checkPdfSessionRateLimit({
    action,
    dbUserId: authResult.session.dbUserId,
    clientIp,
    nowMs: activeOverrides?.now?.(),
    store: activeOverrides?.rateLimitStore,
  });

  if (!rateResult.allowed) {
    const retryAfterSeconds = Math.max(1, rateResult.retryAfterSeconds ?? 60);
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: BENGALI_RATE_LIMIT_MESSAGE,
          code: 'RATE_LIMIT_EXCEEDED',
          retryable: true,
          retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfterSeconds),
          },
        }
      ),
    };
  }

  return {
    ok: true,
    session: authResult.session,
  };
}

