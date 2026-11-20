import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import { NextRequest, NextResponse } from 'next/server';

export const GEMINI_MODEL = 'gemini-4-hydrogen';
export const GEMINI_EMBED_MODEL = 'gemini-embedding-2';

export const DEFAULT_AI_TIMEOUT_MS = 90_000;
export const DEFAULT_PDF_AI_TIMEOUT_MS = 120_000;

let cachedClient: GoogleGenAI | null = null;

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

export class AiTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`AI request timed out after ${timeoutMs}ms`);
    this.name = 'AiTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class AiResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiResponseParseError';
  }
}

export class AiInvalidRequestError extends Error {
  public readonly bengaliMessage: string;

  constructor(
    bengaliMessage: string = 'অনুরোধের ডেটা সঠিক ফরম্যাটে নেই। অনুগ্রহ করে আবার চেষ্টা করুন।'
  ) {
    super(bengaliMessage);
    this.name = 'AiInvalidRequestError';
    this.bengaliMessage = bengaliMessage;
  }
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new AiConfigError(
      'GEMINI_API_KEY is not configured. Please verify your API key in Settings > Secrets.'
    );
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export async function parseJsonBody<T = Record<string, unknown>>(
  req: NextRequest
): Promise<T> {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AiInvalidRequestError();
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof AiInvalidRequestError) {
      throw error;
    }
    throw new AiInvalidRequestError();
  }
}

export function stripMarkdownCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }
  return trimmed;
}

export function parseAiJson<T>(
  rawText: string | undefined,
  expectedType?: 'object' | 'array'
): T {
  const cleaned = stripMarkdownCodeFences(rawText ?? '');
  if (!cleaned) {
    throw new AiResponseParseError('AI returned an empty JSON payload.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new AiResponseParseError('AI returned malformed JSON.');
  }

  if (expectedType === 'array' && !Array.isArray(parsed)) {
    throw new AiResponseParseError('Expected JSON array from AI response.');
  }

  if (
    expectedType === 'object' &&
    (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
  ) {
    throw new AiResponseParseError('Expected JSON object from AI response.');
  }

  return parsed as T;
}

export function extractUpstreamStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;

  const rec = error as Record<string, unknown>;
  const directStatus = rec.status ?? rec.statusCode ?? rec.code;
  if (typeof directStatus === 'number' && directStatus >= 100 && directStatus < 600) {
    return directStatus;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof rec.message === 'string'
        ? rec.message
        : '';

  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit/i.test(message)) {
    return 429;
  }
  if (/UNAVAILABLE|\b503\b|high demand|overloaded/i.test(message)) {
    return 503;
  }
  if (/DEADLINE_EXCEEDED|\b504\b|timed?\s*out/i.test(message)) {
    return 504;
  }
  if (/PERMISSION_DENIED|API_KEY_INVALID|UNAUTHENTICATED|\b403\b|\b401\b/i.test(message)) {
    return 403;
  }
  if (/NOT_FOUND|\b404\b/i.test(message)) {
    return 404;
  }
  if (/INVALID_ARGUMENT|\b400\b/i.test(message)) {
    return 400;
  }
  if (/INTERNAL|\b500\b|\b502\b/i.test(message)) {
    return 500;
  }

  return null;
}

export function extractRetryDelayMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;

  const rec = error as Record<string, unknown>;
  if (typeof rec.retryAfterMs === 'number' && rec.retryAfterMs > 0) {
    return Math.round(rec.retryAfterMs);
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof rec.message === 'string'
        ? rec.message
        : '';

  const retryDelayMatch =
    message.match(/retryDelay["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)s/i) ||
    message.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (retryDelayMatch) {
    const seconds = Number(retryDelayMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  return null;
}

export function isRetryableAiError(error: unknown): boolean {
  if (error instanceof AiTimeoutError) return false;
  if (error instanceof AiConfigError) return false;
  if (error instanceof AiInvalidRequestError) return false;

  const status = extractUpstreamStatus(error);
  if (status === 429 || status === 503 || status === 502) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(message)) {
    return true;
  }

  return false;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export interface GenerateWithRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional explicit fallback model; not used unless provided by caller. */
  fallbackModel?: string;
  /** Dependency injection hook for unit tests. */
  client?: {
    models: {
      generateContent: (
        params: GenerateContentParameters
      ) => Promise<GenerateContentResponse>;
    };
  };
  /** Dependency injection hook for deterministic backoff unit tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function runSingleAttemptWithTimeout(
  client: NonNullable<GenerateWithRetryOptions['client']>,
  params: GenerateContentParameters,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  if (externalSignal?.aborted) {
    throw externalSignal.reason ?? new Error('Request aborted by caller');
  }

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason ?? new Error('Request aborted'));
  };

  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const timeoutErr = new AiTimeoutError(timeoutMs);
      controller.abort(timeoutErr);
      reject(timeoutErr);
    }, timeoutMs);
  });

  try {
    const mergedParams: GenerateContentParameters = {
      ...params,
      config: {
        ...params.config,
        abortSignal: controller.signal,
      },
    };

    return await Promise.race([
      client.models.generateContent(mergedParams),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut || error instanceof AiTimeoutError) {
      throw new AiTimeoutError(timeoutMs);
    }
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' ||
        (error.name === 'AbortError' && timedOut))
    ) {
      throw new AiTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function generateWithRetry(
  params: GenerateContentParameters,
  options: GenerateWithRetryOptions = {}
): Promise<GenerateContentResponse> {
  const {
    maxRetries = 2,
    baseDelayMs = 1500,
    maxDelayMs = 10_000,
    timeoutMs = DEFAULT_AI_TIMEOUT_MS,
    signal,
    fallbackModel,
    client = getGeminiClient(),
    sleep = defaultSleep,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await runSingleAttemptWithTimeout(client, params, timeoutMs, signal);
    } catch (error) {
      lastError = error;

      if (signal?.aborted) {
        throw error;
      }

      const canRetry = attempt < maxRetries && isRetryableAiError(error);
      if (!canRetry) {
        break;
      }

      const hintedDelay = extractRetryDelayMs(error);
      if (hintedDelay !== null && hintedDelay > maxDelayMs) {
        break;
      }
      const exponentialDelay = baseDelayMs * 2 ** attempt;
      const delayMs = Math.min(
        maxDelayMs,
        Math.max(baseDelayMs, hintedDelay ?? exponentialDelay)
      );

      await sleep(delayMs, signal);
    }
  }

  // Optional fallback model is only used if explicitly passed by caller
  if (
    fallbackModel &&
    fallbackModel !== params.model &&
    !signal?.aborted &&
    (isRetryableAiError(lastError) || lastError instanceof AiTimeoutError)
  ) {
    return runSingleAttemptWithTimeout(
      client,
      { ...params, model: fallbackModel },
      timeoutMs,
      signal
    );
  }

  throw lastError;
}

export type AiErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'AI_RATE_LIMITED'
  | 'AI_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_INVALID_RESPONSE'
  | 'AI_CONFIG_ERROR'
  | 'AI_INTERNAL_ERROR';

export interface SanitizedAiError {
  status: number;
  code: AiErrorCode;
  error: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export function classifyAiError(
  error: unknown,
  fallbackBengaliMessage: string = 'AI সেবা সাময়িকভাবে প্রক্রিয়াটি সম্পন্ন করতে পারেনি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'
): SanitizedAiError {
  if (error instanceof AiInvalidRequestError) {
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      error: error.bengaliMessage,
      retryable: false,
    };
  }

  if (error instanceof AiTimeoutError) {
    return {
      status: 504,
      code: 'AI_TIMEOUT',
      error:
        'AI উত্তর তৈরি করতে নির্ধারিত সময়ের বেশি সময় নিচ্ছে। অনুগ্রহ করে ছোট অংশ দিয়ে অথবা কিছুক্ষণ পর আবার চেষ্টা করুন।',
      retryable: true,
    };
  }

  if (error instanceof AiResponseParseError) {
    return {
      status: 502,
      code: 'AI_INVALID_RESPONSE',
      error:
        'AI থেকে অপ্রত্যাশিত ফরম্যাটের উত্তর পাওয়া গেছে। অনুগ্রহ করে আবার চেষ্টা করুন।',
      retryable: true,
    };
  }

  if (error instanceof AiConfigError) {
    return {
      status: 503,
      code: 'AI_CONFIG_ERROR',
      error:
        'AI সেবা বর্তমানে সঠিকভাবে কনফিগার করা নেই। অনুগ্রহ করে অ্যাডমিনিস্ট্রেটরকে জানান বা কিছুক্ষণ পর চেষ্টা করুন।',
      retryable: false,
    };
  }

  const upstreamStatus = extractUpstreamStatus(error);
  const retryDelayMs = extractRetryDelayMs(error);
  const retryAfterSeconds = retryDelayMs
    ? Math.max(1, Math.ceil(retryDelayMs / 1000))
    : undefined;

  if (upstreamStatus === 429) {
    return {
      status: 429,
      code: 'AI_RATE_LIMITED',
      error:
        'AI সেবার অনুরোধের সীমা সাময়িকভাবে পূর্ণ হয়ে গেছে। অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করে আবার চেষ্টা করুন।',
      retryable: true,
      retryAfterSeconds,
    };
  }

  if (upstreamStatus === 503) {
    return {
      status: 503,
      code: 'AI_UNAVAILABLE',
      error:
        'AI সার্ভার বর্তমানে অতিরিক্ত ব্যস্ত রয়েছে। অনুগ্রহ করে কয়েক সেকেন্ড পর আবার চেষ্টা করুন।',
      retryable: true,
      retryAfterSeconds,
    };
  }

  if (upstreamStatus === 504) {
    return {
      status: 504,
      code: 'AI_TIMEOUT',
      error:
        'AI উত্তর তৈরি করতে নির্ধারিত সময়ের বেশি সময় নিচ্ছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
      retryable: true,
    };
  }

  if (upstreamStatus === 403 || upstreamStatus === 401) {
    return {
      status: 503,
      code: 'AI_CONFIG_ERROR',
      error:
        'AI সেবায় সংযোগ অনুমোদন করা যায়নি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
      retryable: false,
    };
  }

  if (upstreamStatus === 400) {
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      error:
        'প্রদত্ত ফাইল বা তথ্য AI প্রক্রিয়াকরণের জন্য উপযুক্ত নয়। অনুগ্রহ করে তথ্য যাচাই করে আবার চেষ্টা করুন।',
      retryable: false,
    };
  }

  return {
    status: 500,
    code: 'AI_INTERNAL_ERROR',
    error: fallbackBengaliMessage,
    retryable: true,
  };
}

export function mapAiErrorToHttpResponse(
  error: unknown,
  routeLabel: string,
  fallbackBengaliMessage?: string
): NextResponse {
  console.error(`[${routeLabel}] failed:`, error);
  const sanitized = classifyAiError(error, fallbackBengaliMessage);

  const headers: HeadersInit = {};
  if (sanitized.retryAfterSeconds) {
    headers['Retry-After'] = String(sanitized.retryAfterSeconds);
  }

  return NextResponse.json(
    {
      error: sanitized.error,
      code: sanitized.code,
      retryable: sanitized.retryable,
      ...(sanitized.retryAfterSeconds
        ? { retryAfterSeconds: sanitized.retryAfterSeconds }
        : {}),
    },
    { status: sanitized.status, headers }
  );
}

export async function generateEmbedding768(
  text: string
): Promise<number[] | null> {
  try {
    const ai = getGeminiClient();
    const res = await ai.models.embedContent({
      model: GEMINI_EMBED_MODEL,
      contents: text.slice(0, 3500),
      config: {
        outputDimensionality: 768,
      },
    });
    const values = res.embeddings?.[0]?.values;
    if (Array.isArray(values) && values.length === 768) {
      return values;
    }
    return null;
  } catch (error) {
    console.error('Embedding generation failed:', error);
    return null;
  }
}

