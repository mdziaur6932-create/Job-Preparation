export type AiRateLimitEndpoint =
  | 'extract-pdf'
  | 'reader'
  | 'questions'
  | 'evaluate'
  | 'gk-convert'
  | 'paper-cutting'
  | 'topic-tag'
  | 'analyze-demo-paper'
  | 'explain-answers'
  | 'tutor';

export interface EndpointRateLimitConfig {
  /** Maximum allowed requests per user inside the sliding window. */
  limit: number;
  /** Sliding window duration in milliseconds. */
  windowMs: number;
  /** Secondary per-IP safeguard multiplier (protects against multi-account flooding from one IP). */
  ipLimitMultiplier: number;
}

export const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Centralized application-level rate-limit configuration for all AI endpoints.
 * NOTE: These are conservative application-level defaults, not official Google Gemini quotas.
 */
export const AI_ENDPOINT_RATE_LIMITS: Record<
  AiRateLimitEndpoint,
  EndpointRateLimitConfig
> = {
  'extract-pdf': {
    limit: 5,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  reader: {
    limit: 20,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  questions: {
    limit: 30,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  evaluate: {
    limit: 10,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  'gk-convert': {
    limit: 10,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  'paper-cutting': {
    limit: 25,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  'topic-tag': {
    limit: 20,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  'analyze-demo-paper': {
    limit: 20,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  'explain-answers': {
    limit: 20,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  tutor: {
    limit: 20,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
};

export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds?: number;
}

/**
 * Storage adapter contract so a future distributed store (e.g. Redis/DB)
 * can replace the in-memory store without modifying any AI route handlers.
 */
export interface RateLimitStore {
  consume(
    key: string,
    limit: number,
    windowMs: number,
    nowMs?: number
  ): RateLimitCheckResult;
  cleanup(nowMs?: number): number;
  reset(): void;
  size(): number;
}

export interface InMemoryRateLimitOptions {
  maxKeys?: number;
  cleanupIntervalMs?: number;
}

/**
 * Process-local in-memory sliding-window rate limiter (zero-cost, no external paid services).
 *
 * IMPORTANT LIMITATIONS:
 * - State is process-local and resets on server restart or cold start.
 * - Multiple serverless instances do not share counters.
 * - Not a globally synchronized production rate limiter across distributed workers.
 */
export class InMemorySlidingWindowRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<
    string,
    { timestamps: number[]; windowMs: number; lastSeenMs: number }
  >();
  private readonly maxKeys: number;
  private readonly cleanupIntervalMs: number;
  private lastCleanupMs = 0;

  constructor(options: InMemoryRateLimitOptions = {}) {
    this.maxKeys = options.maxKeys ?? 5_000;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
  }

  consume(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number = Date.now()
  ): RateLimitCheckResult {
    if (
      nowMs - this.lastCleanupMs >= this.cleanupIntervalMs ||
      this.buckets.size >= this.maxKeys
    ) {
      this.cleanup(nowMs);
    }

    const cutoff = nowMs - windowMs;
    const existing = this.buckets.get(key);
    const activeTimestamps = existing
      ? existing.timestamps.filter((ts) => ts > cutoff)
      : [];

    if (activeTimestamps.length >= limit) {
      const oldestActive = activeTimestamps[0] ?? nowMs;
      const retryMs = Math.max(1_000, oldestActive + windowMs - nowMs);
      const retryAfterSeconds = Math.max(1, Math.ceil(retryMs / 1000));

      this.buckets.set(key, {
        timestamps: activeTimestamps,
        windowMs,
        lastSeenMs: nowMs,
      });

      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    activeTimestamps.push(nowMs);
    this.buckets.set(key, {
      timestamps: activeTimestamps,
      windowMs,
      lastSeenMs: nowMs,
    });

    // Enforce hard upper bound on tracked keys to prevent unbounded memory growth
    if (this.buckets.size > this.maxKeys) {
      this.evictOldestKeys(this.buckets.size - this.maxKeys);
    }

    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - activeTimestamps.length),
    };
  }

  cleanup(nowMs: number = Date.now()): number {
    this.lastCleanupMs = nowMs;
    let removed = 0;

    for (const [key, entry] of this.buckets.entries()) {
      const cutoff = nowMs - entry.windowMs;
      const active = entry.timestamps.filter((ts) => ts > cutoff);
      if (active.length === 0) {
        this.buckets.delete(key);
        removed += 1;
      } else if (active.length !== entry.timestamps.length) {
        entry.timestamps = active;
      }
    }

    return removed;
  }

  reset(): void {
    this.buckets.clear();
    this.lastCleanupMs = 0;
  }

  size(): number {
    return this.buckets.size;
  }

  private evictOldestKeys(countToEvict: number): void {
    if (countToEvict <= 0) return;
    const ordered = Array.from(this.buckets.entries()).sort(
      (a, b) => a[1].lastSeenMs - b[1].lastSeenMs
    );
    for (let i = 0; i < Math.min(countToEvict, ordered.length); i += 1) {
      this.buckets.delete(ordered[i][0]);
    }
  }
}

export const defaultRateLimitStore = new InMemorySlidingWindowRateLimitStore();

/**
 * Extracts a normalized client IP address from standard proxy headers for secondary IP throttling.
 */
export function extractClientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first && first.length <= 64) {
      return first;
    }
  }

  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp && realIp.length <= 64) {
    return realIp;
  }

  return null;
}

export interface AiRateLimitCheckParams {
  endpoint: AiRateLimitEndpoint;
  dbUserId: number;
  clientIp?: string | null;
  nowMs?: number;
  store?: RateLimitStore;
  limits?: Record<AiRateLimitEndpoint, EndpointRateLimitConfig>;
}

/**
 * Evaluates primary verified-user rate limit and secondary IP safeguard for an AI endpoint.
 * Primary key ALWAYS uses the authenticated server-side `dbUserId`.
 */
export function checkAiEndpointRateLimit(
  params: AiRateLimitCheckParams
): RateLimitCheckResult {
  const {
    endpoint,
    dbUserId,
    clientIp = null,
    nowMs = Date.now(),
    store = defaultRateLimitStore,
    limits = AI_ENDPOINT_RATE_LIMITS,
  } = params;

  const config = limits[endpoint];
  const userKey = `ai:user:${dbUserId}:ep:${endpoint}`;
  const userResult = store.consume(userKey, config.limit, config.windowMs, nowMs);

  if (!userResult.allowed) {
    return userResult;
  }

  if (clientIp) {
    const ipLimit = Math.max(config.limit, config.limit * config.ipLimitMultiplier);
    const ipKey = `ai:ip:${clientIp}:ep:${endpoint}`;
    const ipResult = store.consume(ipKey, ipLimit, config.windowMs, nowMs);
    if (!ipResult.allowed) {
      return {
        allowed: false,
        limit: config.limit,
        remaining: 0,
        retryAfterSeconds: ipResult.retryAfterSeconds,
      };
    }
  }

  return userResult;
}

export type PdfSessionRateLimitAction =
  | 'session-init'
  | 'session-chunk'
  | 'session-batch'
  | 'session-control';

export const PDF_SESSION_RATE_LIMITS: Record<
  PdfSessionRateLimitAction,
  EndpointRateLimitConfig
> = {
  'session-init': {
    limit: 15,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  'session-chunk': {
    limit: 160,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  'session-batch': {
    limit: 300,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
  'session-control': {
    limit: 60,
    windowMs: DEFAULT_WINDOW_MS,
    ipLimitMultiplier: 3,
  },
};

export interface PdfSessionRateLimitCheckParams {
  action: PdfSessionRateLimitAction;
  dbUserId: number;
  clientIp?: string | null;
  nowMs?: number;
  store?: RateLimitStore;
  limits?: Record<PdfSessionRateLimitAction, EndpointRateLimitConfig>;
}

/**
 * Evaluates verified-user and secondary-IP sliding-window rate limits for
 * resumable PDF upload session transfer/control operations.
 */
export function checkPdfSessionRateLimit(
  params: PdfSessionRateLimitCheckParams
): RateLimitCheckResult {
  const {
    action,
    dbUserId,
    clientIp = null,
    nowMs = Date.now(),
    store = defaultRateLimitStore,
    limits = PDF_SESSION_RATE_LIMITS,
  } = params;

  const config = limits[action];
  const userKey = `pdf-session:user:${dbUserId}:act:${action}`;
  const userResult = store.consume(userKey, config.limit, config.windowMs, nowMs);

  if (!userResult.allowed) {
    return userResult;
  }

  if (clientIp) {
    const ipLimit = Math.max(config.limit, config.limit * config.ipLimitMultiplier);
    const ipKey = `pdf-session:ip:${clientIp}:act:${action}`;
    const ipResult = store.consume(ipKey, ipLimit, config.windowMs, nowMs);
    if (!ipResult.allowed) {
      return {
        allowed: false,
        limit: config.limit,
        remaining: 0,
        retryAfterSeconds: ipResult.retryAfterSeconds,
      };
    }
  }

  return userResult;
}

