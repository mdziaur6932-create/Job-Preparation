import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import {
  authenticateRequest,
  extractBearerToken,
  verifyAuthRequest,
  type AuthDependencies,
} from './server-auth.ts';
import {
  AI_ENDPOINT_RATE_LIMITS,
  checkAiEndpointRateLimit,
  extractClientIp,
  InMemorySlidingWindowRateLimitStore,
  type AiRateLimitEndpoint,
} from './rate-limit.ts';
import {
  BENGALI_AUTH_REQUIRED_MESSAGE,
  BENGALI_AUTH_UNAVAILABLE_MESSAGE,
  guardAiApiRequest,
  setAiGuardTestOverrides,
} from './ai-api-guard.ts';
import { GEMINI_MODEL, setGeminiClientForTesting } from './gemini.ts';
import {
  formatAiResponseError,
  GUEST_AI_SIGNIN_MESSAGE,
} from './ai-client.ts';

import { POST as extractPdfPost } from '../../app/api/ai/extract-pdf/route.ts';
import { POST as readerPost } from '../../app/api/ai/reader/route.ts';
import { POST as questionsPost } from '../../app/api/ai/questions/route.ts';
import { POST as evaluatePost } from '../../app/api/ai/evaluate/route.ts';
import { POST as gkConvertPost } from '../../app/api/ai/gk-convert/route.ts';
import { POST as tutorPost } from '../../app/api/ai/tutor/route.ts';

function makeJsonRequest(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeFakePdfFormRequest(headers: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
  const file = new File([pdfBytes], 'bcs-guide.pdf', { type: 'application/pdf' });
  form.append('file', file);
  form.append('useOcr', 'false');

  return new NextRequest('http://localhost:3000/api/ai/extract-pdf', {
    method: 'POST',
    headers,
    body: form,
  });
}

function createMockAuthDeps(
  tokenMap: Record<string, { uid: string; email: string; name: string; dbUserId: number }>
): AuthDependencies {
  return {
    verifyIdToken: async (token: string) => {
      if (token === 'expired-token') {
        const err = new Error('Firebase ID token has expired') as Error & { code: string };
        err.code = 'auth/id-token-expired';
        throw err;
      }
      if (token === 'revoked-token') {
        const err = new Error('Firebase ID token has been revoked') as Error & { code: string };
        err.code = 'auth/id-token-revoked';
        throw err;
      }
      const match = tokenMap[token];
      if (!match) {
        const err = new Error('Decoding Firebase ID token failed') as Error & { code: string };
        err.code = 'auth/argument-error';
        throw err;
      }
      return {
        uid: match.uid,
        email: match.email,
        name: match.name,
      };
    },
    resolveUser: async (uid: string) => {
      const entry = Object.values(tokenMap).find((u) => u.uid === uid);
      return entry ? { id: entry.dbUserId } : null;
    },
  };
}

// ============================================================================
// 1. Authentication Unit Tests (extractBearerToken & authenticateRequest)
// ============================================================================

test('extractBearerToken rejects missing and malformed Authorization headers', () => {
  assert.deepEqual(extractBearerToken(null), { ok: false, reason: 'missing_header' });
  assert.deepEqual(extractBearerToken(''), { ok: false, reason: 'missing_header' });
  assert.deepEqual(extractBearerToken('   '), { ok: false, reason: 'missing_header' });
  assert.deepEqual(extractBearerToken('Basic dXNlcjpwYXNz'), {
    ok: false,
    reason: 'malformed_header',
  });
  assert.deepEqual(extractBearerToken('Bearer'), {
    ok: false,
    reason: 'malformed_header',
  });
  assert.deepEqual(extractBearerToken('Bearer   '), {
    ok: false,
    reason: 'malformed_header',
  });
  assert.deepEqual(extractBearerToken('Bearer token-a token-b'), {
    ok: false,
    reason: 'malformed_header',
  });
  assert.deepEqual(extractBearerToken('Bearer valid.jwt.token'), {
    ok: true,
    token: 'valid.jwt.token',
  });
});

test('authenticateRequest classifies missing, malformed, invalid, expired, revoked, and unmapped users', async () => {
  const deps = createMockAuthDeps({
    'valid-user-1': {
      uid: 'fb-uid-1',
      email: 'student1@example.com',
      name: 'Student One',
      dbUserId: 101,
    },
  });

  // Missing header
  const missingRes = await authenticateRequest(
    { headers: new Headers() },
    deps
  );
  assert.deepEqual(missingRes, { ok: false, reason: 'missing_header' });

  // Malformed header
  const malformedRes = await authenticateRequest(
    { headers: new Headers({ authorization: 'Token valid-user-1' }) },
    deps
  );
  assert.deepEqual(malformedRes, { ok: false, reason: 'malformed_header' });

  // Invalid token
  const invalidRes = await authenticateRequest(
    { headers: new Headers({ authorization: 'Bearer wrong-token' }) },
    deps
  );
  assert.deepEqual(invalidRes, { ok: false, reason: 'invalid_token' });

  // Expired token
  const expiredRes = await authenticateRequest(
    { headers: new Headers({ authorization: 'Bearer expired-token' }) },
    deps
  );
  assert.deepEqual(expiredRes, { ok: false, reason: 'expired_token' });

  // Revoked token
  const revokedRes = await authenticateRequest(
    { headers: new Headers({ authorization: 'Bearer revoked-token' }) },
    deps
  );
  assert.deepEqual(revokedRes, { ok: false, reason: 'revoked_token' });

  // Valid token -> VerifiedSession
  const okRes = await authenticateRequest(
    { headers: new Headers({ authorization: 'Bearer valid-user-1' }) },
    deps
  );
  assert.equal(okRes.ok, true);
  if (okRes.ok) {
    assert.deepEqual(okRes.session, {
      uid: 'fb-uid-1',
      email: 'student1@example.com',
      displayName: 'Student One',
      dbUserId: 101,
    });
  }

  // Unmapped user (resolveUser returns null) -> fail-closed
  const unmappedRes = await authenticateRequest(
    { headers: new Headers({ authorization: 'Bearer valid-user-1' }) },
    {
      verifyIdToken: deps.verifyIdToken,
      resolveUser: async () => null,
    }
  );
  assert.deepEqual(unmappedRes, { ok: false, reason: 'unmapped_user' });
});

async function withNodeEnv(
  envValue: string | undefined,
  fn: () => Promise<void>
): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  if (envValue === undefined) {
    delete env.NODE_ENV;
  } else {
    env.NODE_ENV = envValue;
  }
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = previous;
    }
  }
}

async function captureConsoleOutput(
  fn: () => Promise<void>
): Promise<{ warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.info = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '));
  };

  try {
    await fn();
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }

  return { warnings, errors };
}

function makeFirebaseError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// ============================================================================
// 1B. Firebase Revocation Security Tests (Tests A - I)
// ============================================================================

test('Test A — Production success: verifies with checkRevoked=true only and succeeds', async () => {
  await withNodeEnv('production', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const authDeps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        return { uid: 'prod-uid-1', email: 'prod@example.com', name: 'Prod User' };
      },
      resolveUser: async () => ({ id: 301 }),
    };

    const authRes = await authenticateRequest(
      { headers: new Headers({ authorization: 'Bearer valid-prod-token' }) },
      authDeps
    );
    assert.equal(authRes.ok, true);
    if (authRes.ok) {
      assert.equal(authRes.session.dbUserId, 301);
      assert.equal(authRes.session.uid, 'prod-uid-1');
    }
    assert.deepEqual(calls, [{ checkRevoked: true }]);

    calls.length = 0;
    const req = makeJsonRequest(
      'http://localhost:3000/api/ai/tutor',
      { message: 'hello' },
      { authorization: 'Bearer valid-prod-token' }
    );
    const guardRes = await guardAiApiRequest(req, 'tutor', {
      authDeps,
      rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
    });
    assert.equal(guardRes.ok, true);
    assert.deepEqual(calls, [{ checkRevoked: true }]);
  });
});

test('Test B — Production IAM failure: fails closed with HTTP 503 and never calls verifyIdToken(token, false)', async () => {
  await withNodeEnv('production', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const authDeps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        throw makeFirebaseError(
          'auth/insufficient-permission',
          'Insufficient permission to access the requested resource.'
        );
      },
      resolveUser: async () => ({ id: 302 }),
    };

    const { warnings, errors } = await captureConsoleOutput(async () => {
      const authRes = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer prod-iam-token' }) },
        authDeps
      );
      assert.deepEqual(authRes, { ok: false, reason: 'verification_unavailable' });
      assert.deepEqual(calls, [{ checkRevoked: true }]);

      // Backward-compatible verifyAuthRequest also fails closed
      calls.length = 0;
      const req = makeJsonRequest(
        'http://localhost:3000/api/workspace',
        {},
        { authorization: 'Bearer prod-iam-token' }
      );
      const workspaceSession = await verifyAuthRequest(req, authDeps);
      assert.equal(workspaceSession, null);
      assert.deepEqual(calls, [{ checkRevoked: true }]);

      // AI guard returns sanitized HTTP 503 without falling back
      calls.length = 0;
      const aiReq = makeJsonRequest(
        'http://localhost:3000/api/ai/tutor',
        { message: 'test' },
        { authorization: 'Bearer prod-iam-token' }
      );
      const guardRes = await guardAiApiRequest(aiReq, 'tutor', {
        authDeps,
        rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
      });
      assert.equal(guardRes.ok, false);
      if (!guardRes.ok) {
        assert.equal(guardRes.response.status, 503);
        const body = (await guardRes.response.json()) as Record<string, unknown>;
        assert.equal(body.code, 'AUTH_VERIFICATION_UNAVAILABLE');
        assert.equal(body.error, BENGALI_AUTH_UNAVAILABLE_MESSAGE);
        assert.equal(body.retryable, true);
      }
      assert.deepEqual(calls, [{ checkRevoked: true }]);
    });

    assert.equal(warnings.length, 0, 'Production must not emit development fallback warning');
    assert.ok(errors.length >= 1, 'Production must log sanitized verification unavailable error');
  });
});

test('Test C — Production ADC failure: fails closed with HTTP 503 and never calls verifyIdToken(token, false)', async () => {
  await withNodeEnv('production', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const authDeps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        throw makeFirebaseError(
          'app/invalid-credential',
          'Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started'
        );
      },
      resolveUser: async () => ({ id: 303 }),
    };

    await captureConsoleOutput(async () => {
      const authRes = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer prod-adc-token' }) },
        authDeps
      );
      assert.deepEqual(authRes, { ok: false, reason: 'verification_unavailable' });
      assert.deepEqual(calls, [{ checkRevoked: true }]);

      calls.length = 0;
      const aiReq = makeJsonRequest(
        'http://localhost:3000/api/ai/reader',
        { mode: 'summary' },
        { authorization: 'Bearer prod-adc-token' }
      );
      const guardRes = await guardAiApiRequest(aiReq, 'reader', {
        authDeps,
        rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
      });
      assert.equal(guardRes.ok, false);
      if (!guardRes.ok) {
        assert.equal(guardRes.response.status, 503);
        const body = (await guardRes.response.json()) as Record<string, unknown>;
        assert.equal(body.code, 'AUTH_VERIFICATION_UNAVAILABLE');
        assert.equal(body.error, BENGALI_AUTH_UNAVAILABLE_MESSAGE);
        assert.equal(body.retryable, true);
      }
      assert.deepEqual(calls, [{ checkRevoked: true }]);
    });
  });
});

test('Test D — Development fallback: logs clear warning and falls back to verifyIdToken(token, false) only for recognized IAM/ADC errors', async () => {
  await withNodeEnv('development', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const devToken = 'dev-only-token-value-123';
    const authDeps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        if (checkRevoked) {
          throw makeFirebaseError(
            'app/invalid-credential',
            'Could not load the default credentials'
          );
        }
        return { uid: 'dev-uid', email: 'dev@example.com', name: 'Dev User' };
      },
      resolveUser: async () => ({ id: 55 }),
    };

    const { warnings } = await captureConsoleOutput(async () => {
      const res = await authenticateRequest(
        { headers: new Headers({ authorization: `Bearer ${devToken}` }) },
        authDeps
      );
      assert.equal(res.ok, true);
      if (res.ok) {
        assert.equal(res.session.dbUserId, 55);
      }
    });

    assert.deepEqual(calls, [{ checkRevoked: true }, { checkRevoked: false }]);
    assert.equal(warnings.length, 1);
    assert.ok(
      warnings[0].includes('Development-only fallback') &&
        warnings[0].includes('without revocation checking'),
      `Expected explicit development-only fallback warning, got: ${warnings[0]}`
    );
    assert.ok(
      !warnings[0].includes(devToken),
      'Warning log must never include the raw ID token'
    );
  });
});

test('Test E — Invalid token: rejected with HTTP 401 and NO fallback in production or development', async () => {
  for (const envName of ['production', 'development'] as const) {
    await withNodeEnv(envName, async () => {
      const calls: Array<{ checkRevoked?: boolean }> = [];
      const authDeps: AuthDependencies = {
        verifyIdToken: async (_token, checkRevoked) => {
          calls.push({ checkRevoked });
          throw makeFirebaseError(
            'auth/argument-error',
            'Decoding Firebase ID token failed.'
          );
        },
        resolveUser: async () => ({ id: 304 }),
      };

      await captureConsoleOutput(async () => {
        const authRes = await authenticateRequest(
          { headers: new Headers({ authorization: 'Bearer malformed.jwt.value' }) },
          authDeps
        );
        assert.deepEqual(authRes, { ok: false, reason: 'invalid_token' });
        assert.deepEqual(calls, [{ checkRevoked: true }]);

        calls.length = 0;
        const req = makeJsonRequest(
          'http://localhost:3000/api/ai/tutor',
          { message: 'test' },
          { authorization: 'Bearer malformed.jwt.value' }
        );
        const guardRes = await guardAiApiRequest(req, 'tutor', {
          authDeps,
          rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
        });
        assert.equal(guardRes.ok, false);
        if (!guardRes.ok) {
          assert.equal(guardRes.response.status, 401);
          const body = (await guardRes.response.json()) as Record<string, unknown>;
          assert.equal(body.code, 'AUTH_REQUIRED');
          assert.equal(body.retryable, false);
        }
        assert.deepEqual(calls, [{ checkRevoked: true }]);
      });
    });
  }
});

test('Test F — Expired token: rejected with HTTP 401 and NO fallback in production or development', async () => {
  for (const envName of ['production', 'development'] as const) {
    await withNodeEnv(envName, async () => {
      const calls: Array<{ checkRevoked?: boolean }> = [];
      const authDeps: AuthDependencies = {
        verifyIdToken: async (_token, checkRevoked) => {
          calls.push({ checkRevoked });
          throw makeFirebaseError(
            'auth/id-token-expired',
            'Firebase ID token has expired.'
          );
        },
        resolveUser: async () => ({ id: 305 }),
      };

      await captureConsoleOutput(async () => {
        const authRes = await authenticateRequest(
          { headers: new Headers({ authorization: 'Bearer expired-jwt' }) },
          authDeps
        );
        assert.deepEqual(authRes, { ok: false, reason: 'expired_token' });
        assert.deepEqual(calls, [{ checkRevoked: true }]);

        calls.length = 0;
        const req = makeJsonRequest(
          'http://localhost:3000/api/ai/questions',
          {},
          { authorization: 'Bearer expired-jwt' }
        );
        const guardRes = await guardAiApiRequest(req, 'questions', {
          authDeps,
          rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
        });
        assert.equal(guardRes.ok, false);
        if (!guardRes.ok) {
          assert.equal(guardRes.response.status, 401);
          const body = (await guardRes.response.json()) as Record<string, unknown>;
          assert.equal(body.code, 'AUTH_REQUIRED');
          assert.equal(body.retryable, false);
        }
        assert.deepEqual(calls, [{ checkRevoked: true }]);
      });
    });
  }
});

test('Test G — Revoked token: rejected with HTTP 401 and NO fallback in production or development', async () => {
  for (const envName of ['production', 'development'] as const) {
    await withNodeEnv(envName, async () => {
      const calls: Array<{ checkRevoked?: boolean }> = [];
      const authDeps: AuthDependencies = {
        verifyIdToken: async (_token, checkRevoked) => {
          calls.push({ checkRevoked });
          throw makeFirebaseError(
            'auth/id-token-revoked',
            'Firebase ID token has been revoked.'
          );
        },
        resolveUser: async () => ({ id: 306 }),
      };

      await captureConsoleOutput(async () => {
        const authRes = await authenticateRequest(
          { headers: new Headers({ authorization: 'Bearer revoked-jwt' }) },
          authDeps
        );
        assert.deepEqual(authRes, { ok: false, reason: 'revoked_token' });
        assert.deepEqual(calls, [{ checkRevoked: true }]);

        calls.length = 0;
        const req = makeJsonRequest(
          'http://localhost:3000/api/ai/evaluate',
          {},
          { authorization: 'Bearer revoked-jwt' }
        );
        const guardRes = await guardAiApiRequest(req, 'evaluate', {
          authDeps,
          rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
        });
        assert.equal(guardRes.ok, false);
        if (!guardRes.ok) {
          assert.equal(guardRes.response.status, 401);
          const body = (await guardRes.response.json()) as Record<string, unknown>;
          assert.equal(body.code, 'AUTH_REQUIRED');
          assert.equal(body.retryable, false);
        }
        assert.deepEqual(calls, [{ checkRevoked: true }]);
      });
    });
  }
});

test('Test H — Unrelated Firebase error: fails closed with HTTP 401 and NO fallback in production or development', async () => {
  const unrelatedErrors = [
    makeFirebaseError('auth/internal-error', 'Unexpected internal auth service error.'),
    new Error('Network socket hang up while reaching identitytoolkit'),
  ];

  for (const envName of ['production', 'development'] as const) {
    for (const simulatedError of unrelatedErrors) {
      await withNodeEnv(envName, async () => {
        const calls: Array<{ checkRevoked?: boolean }> = [];
        const authDeps: AuthDependencies = {
          verifyIdToken: async (_token, checkRevoked) => {
            calls.push({ checkRevoked });
            throw simulatedError;
          },
          resolveUser: async () => ({ id: 307 }),
        };

        await captureConsoleOutput(async () => {
          const authRes = await authenticateRequest(
            { headers: new Headers({ authorization: 'Bearer some-jwt' }) },
            authDeps
          );
          assert.deepEqual(authRes, { ok: false, reason: 'invalid_token' });
          assert.deepEqual(calls, [{ checkRevoked: true }]);

          calls.length = 0;
          const req = makeJsonRequest(
            'http://localhost:3000/api/ai/gk-convert',
            {},
            { authorization: 'Bearer some-jwt' }
          );
          const guardRes = await guardAiApiRequest(req, 'gk-convert', {
            authDeps,
            rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
          });
          assert.equal(guardRes.ok, false);
          if (!guardRes.ok) {
            assert.equal(guardRes.response.status, 401);
            const body = (await guardRes.response.json()) as Record<string, unknown>;
            assert.equal(body.code, 'AUTH_REQUIRED');
            assert.equal(body.retryable, false);
          }
          assert.deepEqual(calls, [{ checkRevoked: true }]);
        });
      });
    }
  }
});

test('Test I — No token, credential, raw message, or stack leakage in logs or HTTP responses', async () => {
  const secretToken = 'eyJhbGciOiJSUzI1NiJ9.SECRET_ID_TOKEN_DO_NOT_LEAK_999.signature';
  const fakePrivateKey = '-----BEGIN PRIVATE KEY-----SUPER_SECRET_CREDENTIAL';
  const rawMessageMarker = 'RAW_INTERNAL_DETAIL_MARKER_888';
  const stackMarker = 'UNIQUE_STACK_TRACE_MARKER_777';

  const makeLeakyError = (code: string, prefix: string): Error & { code: string } => {
    const err = makeFirebaseError(
      code,
      `${prefix} ${rawMessageMarker} token=${secretToken} key=${fakePrivateKey}`
    );
    err.stack = `Error: ${rawMessageMarker}\n    at ${stackMarker} (/internal/secret.ts:42:10)`;
    return err;
  };

  const forbiddenStrings = [
    secretToken,
    fakePrivateKey,
    rawMessageMarker,
    stackMarker,
  ];

  const assertSanitized = (label: string, text: string) => {
    for (const secret of forbiddenStrings) {
      assert.ok(
        !text.includes(secret),
        `${label} must never leak "${secret}". Actual output: ${text}`
      );
    }
  };

  // 1. Production IAM/ADC failure -> 503 + console.error
  await withNodeEnv('production', async () => {
    const authDeps: AuthDependencies = {
      verifyIdToken: async () => {
        throw makeLeakyError('auth/insufficient-permission', 'Insufficient permission');
      },
      resolveUser: async () => ({ id: 308 }),
    };

    const { warnings, errors } = await captureConsoleOutput(async () => {
      const req = makeJsonRequest(
        'http://localhost:3000/api/ai/tutor',
        { message: 'test' },
        { authorization: `Bearer ${secretToken}` }
      );
      const res = await guardAiApiRequest(req, 'tutor', {
        authDeps,
        rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.response.status, 503);
        const bodyText = await res.response.text();
        assertSanitized('Production 503 response body', bodyText);
      }
    });

    assertSanitized('Production console.error', errors.join('\n'));
    assertSanitized('Production console.warn', warnings.join('\n'));
  });

  // 2. Development fallback -> console.warn
  await withNodeEnv('development', async () => {
    const authDeps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        if (checkRevoked) {
          throw makeLeakyError(
            'app/invalid-credential',
            'Could not load the default credentials'
          );
        }
        return { uid: 'dev-uid', email: 'dev@example.com', name: 'Dev' };
      },
      resolveUser: async () => ({ id: 309 }),
    };

    const { warnings, errors } = await captureConsoleOutput(async () => {
      const authRes = await authenticateRequest(
        { headers: new Headers({ authorization: `Bearer ${secretToken}` }) },
        authDeps
      );
      assert.equal(authRes.ok, true);
    });

    assert.equal(warnings.length, 1);
    assertSanitized('Development console.warn', warnings.join('\n'));
    assertSanitized('Development console.error', errors.join('\n'));
  });

  // 3. Invalid token -> 401 + console.error
  await withNodeEnv('production', async () => {
    const authDeps: AuthDependencies = {
      verifyIdToken: async () => {
        throw makeLeakyError('auth/argument-error', 'Decoding Firebase ID token failed');
      },
      resolveUser: async () => ({ id: 310 }),
    };

    const { warnings, errors } = await captureConsoleOutput(async () => {
      const req = makeJsonRequest(
        'http://localhost:3000/api/ai/tutor',
        { message: 'test' },
        { authorization: `Bearer ${secretToken}` }
      );
      const res = await guardAiApiRequest(req, 'tutor', {
        authDeps,
        rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.response.status, 401);
        const bodyText = await res.response.text();
        assertSanitized('Production 401 response body', bodyText);
      }
    });

    assertSanitized('Invalid token console.error', errors.join('\n'));
    assertSanitized('Invalid token console.warn', warnings.join('\n'));
  });
});

// ============================================================================
// 2. Rate Limiter Unit Tests
// ============================================================================

test('AI_ENDPOINT_RATE_LIMITS enforces S1-T2 conservative defaults for all 6 endpoints', () => {
  assert.equal(AI_ENDPOINT_RATE_LIMITS['extract-pdf'].limit, 5);
  assert.equal(AI_ENDPOINT_RATE_LIMITS.reader.limit, 20);
  assert.equal(AI_ENDPOINT_RATE_LIMITS.questions.limit, 10);
  assert.equal(AI_ENDPOINT_RATE_LIMITS.evaluate.limit, 10);
  assert.equal(AI_ENDPOINT_RATE_LIMITS['gk-convert'].limit, 10);
  assert.equal(AI_ENDPOINT_RATE_LIMITS.tutor.limit, 20);
});

test('InMemorySlidingWindowRateLimitStore enforces inclusive boundary, rejects excess with Retry-After, and recovers after window expiry', () => {
  const store = new InMemorySlidingWindowRateLimitStore({ maxKeys: 100 });
  const t0 = 1_700_000_000_000;
  const windowMs = 60_000;

  // Below limit
  const r1 = store.consume('u:1', 3, windowMs, t0);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 2);

  const r2 = store.consume('u:1', 3, windowMs, t0 + 5_000);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 1);

  // At inclusive boundary
  const r3 = store.consume('u:1', 3, windowMs, t0 + 10_000);
  assert.equal(r3.allowed, true);
  assert.equal(r3.remaining, 0);

  // Above limit -> rejected
  const r4 = store.consume('u:1', 3, windowMs, t0 + 15_000);
  assert.equal(r4.allowed, false);
  assert.equal(r4.remaining, 0);
  assert.ok((r4.retryAfterSeconds ?? 0) >= 45);

  // After oldest timestamp expires -> allowed again
  const r5 = store.consume('u:1', 3, windowMs, t0 + 60_001);
  assert.equal(r5.allowed, true);
  assert.equal(r5.remaining, 0);

  // Cleanup removes fully expired entries
  const removed = store.cleanup(t0 + 200_000);
  assert.equal(removed, 1);
  assert.equal(store.size(), 0);
});

test('InMemorySlidingWindowRateLimitStore enforces maxKeys bound and reset()', () => {
  const store = new InMemorySlidingWindowRateLimitStore({
    maxKeys: 3,
    cleanupIntervalMs: 60_000,
  });
  const base = 1_700_000_000_000;

  store.consume('k1', 5, 60_000, base + 1);
  store.consume('k2', 5, 60_000, base + 2);
  store.consume('k3', 5, 60_000, base + 3);
  store.consume('k4', 5, 60_000, base + 4);

  assert.ok(store.size() <= 3, `Expected size <= 3, got ${store.size()}`);
  store.reset();
  assert.equal(store.size(), 0);
});

test('checkAiEndpointRateLimit isolates user buckets and applies secondary IP safeguard', () => {
  const store = new InMemorySlidingWindowRateLimitStore();
  const now = 1_700_000_000_000;

  // User 1 exhausts extract-pdf limit (5)
  for (let i = 0; i < 5; i += 1) {
    const res = checkAiEndpointRateLimit({
      endpoint: 'extract-pdf',
      dbUserId: 1,
      clientIp: '203.0.113.10',
      nowMs: now + i * 100,
      store,
    });
    assert.equal(res.allowed, true);
  }

  // User 1's 6th request is blocked
  const user1Blocked = checkAiEndpointRateLimit({
    endpoint: 'extract-pdf',
    dbUserId: 1,
    clientIp: '203.0.113.10',
    nowMs: now + 600,
    store,
  });
  assert.equal(user1Blocked.allowed, false);

  // User 2 on a separate bucket is NOT blocked by User 1
  const user2Allowed = checkAiEndpointRateLimit({
    endpoint: 'extract-pdf',
    dbUserId: 2,
    clientIp: '203.0.113.10',
    nowMs: now + 700,
    store,
  });
  assert.equal(user2Allowed.allowed, true);

  // Secondary IP safeguard (3x = 15 for extract-pdf) blocks multi-account IP flooding
  for (let i = 0; i < 4; i += 1) {
    assert.equal(
      checkAiEndpointRateLimit({
        endpoint: 'extract-pdf',
        dbUserId: 2,
        clientIp: '203.0.113.10',
        nowMs: now + 800 + i,
        store,
      }).allowed,
      true
    );
  }
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      checkAiEndpointRateLimit({
        endpoint: 'extract-pdf',
        dbUserId: 3,
        clientIp: '203.0.113.10',
        nowMs: now + 900 + i,
        store,
      }).allowed,
      true
    );
  }
  // 16th total request from 203.0.113.10 (even from fresh User 4) hits secondary IP cap
  const ipFloodBlocked = checkAiEndpointRateLimit({
    endpoint: 'extract-pdf',
    dbUserId: 4,
    clientIp: '203.0.113.10',
    nowMs: now + 1_000,
    store,
  });
  assert.equal(ipFloodBlocked.allowed, false);
  assert.ok((ipFloodBlocked.retryAfterSeconds ?? 0) >= 1);
});

test('extractClientIp parses x-forwarded-for and x-real-ip safely', () => {
  assert.equal(
    extractClientIp(new Headers({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' })),
    '198.51.100.2'
  );
  assert.equal(
    extractClientIp(new Headers({ 'x-real-ip': '198.51.100.9' })),
    '198.51.100.9'
  );
  assert.equal(extractClientIp(new Headers()), null);
});

// ============================================================================
// 3. Integration Tests for ALL SIX Real AI API Route Handlers
// ============================================================================

interface RouteCase {
  endpoint: AiRateLimitEndpoint;
  handler: (req: NextRequest) => Promise<Response>;
  buildRequest: (headers?: Record<string, string>, extraBody?: Record<string, unknown>) => NextRequest;
  mockAiText: string;
  assertSuccessPayload: (json: Record<string, unknown>) => void;
}

const ALL_SIX_ROUTE_CASES: RouteCase[] = [
  {
    endpoint: 'extract-pdf',
    handler: extractPdfPost,
    buildRequest: (headers) => makeFakePdfFormRequest(headers),
    mockAiText: JSON.stringify({
      totalPages: 2,
      sections: [
        { chapter: 'অধ্যায় ১', pageNumber: 1, content: 'বাংলাদেশের সংবিধান ১৯৭২ সালে প্রণীত হয়।' },
      ],
    }),
    assertSuccessPayload: (json) => {
      assert.equal(json.ocrCompleted, true);
      assert.equal(json.totalPages, 2);
      assert.ok(String(json.rawText).includes('বাংলাদেশের সংবিধান'));
    },
  },
  {
    endpoint: 'reader',
    handler: readerPost,
    buildRequest: (headers, extraBody) =>
      makeJsonRequest(
        'http://localhost:3000/api/ai/reader',
        {
          mode: 'summary',
          topic: 'সংবিধান',
          chunks: [
            {
              bookTitle: 'বিসিএস গাইড',
              chapter: 'অধ্যায় ১',
              pageNumber: 5,
              content: 'অনুচ্ছেদ ৮১ অর্থবিল সংক্রান্ত।',
            },
          ],
          ...extraBody,
        },
        headers
      ),
    mockAiText: 'সারাংশ: অনুচ্ছেদ ৮১ অর্থবিল সংক্রান্ত [বিসিএস গাইড, পৃষ্ঠা ৫]।',
    assertSuccessPayload: (json) => {
      assert.ok(String(json.result).includes('অর্থবিল'));
      assert.ok(Array.isArray(json.citations));
    },
  },
  {
    endpoint: 'questions',
    handler: questionsPost,
    buildRequest: (headers, extraBody) =>
      makeJsonRequest(
        'http://localhost:3000/api/ai/questions',
        {
          chunks: [
            {
              bookId: 101,
              bookTitle: 'বিসিএস গাইড',
              chapter: 'অধ্যায় ১',
              pageNumber: 5,
              content: 'অনুচ্ছেদ ৮১ অর্থবিল সংক্রান্ত।',
            },
          ],
          subject: 'বাংলাদেশ বিষয়াবলি',
          questionType: 'MCQ',
          difficulty: 'Medium',
          count: 1,
          ...extraBody,
        },
        headers
      ),
    mockAiText: JSON.stringify([
      {
        stem: 'সংবিধানের কোন অনুচ্ছেদে অর্থবিলের সংজ্ঞা আছে?',
        options: ['৮০', '৮১', '৮২', '৮৭'],
        correctOptionIndex: 1,
        modelAnswer: '৮১',
        explanation: 'অনুচ্ছেদ ৮১-এ অর্থবিলের সংজ্ঞা দেওয়া আছে।',
        bookTitle: 'বিসিএস গাইড',
        chapter: 'অধ্যায় ১',
        pageNumber: 5,
        importanceScore: 90,
      },
    ]),
    assertSuccessPayload: (json) => {
      assert.ok(Array.isArray(json.questions));
      assert.equal((json.questions as unknown[]).length, 1);
    },
  },
  {
    endpoint: 'evaluate',
    handler: evaluatePost,
    buildRequest: (headers, extraBody) =>
      makeJsonRequest(
        'http://localhost:3000/api/ai/evaluate',
        {
          examTitle: 'সংবিধান টেস্ট',
          writtenItems: [],
          weakTopics: ['অর্থবিল'],
          mcqAccuracy: 80,
          ...extraBody,
        },
        headers
      ),
    mockAiText: 'অর্থবিল অধ্যায়টি পুনরায় অনুশীলন করুন।',
    assertSuccessPayload: (json) => {
      assert.ok(Array.isArray(json.writtenGrades));
      assert.ok(String(json.aiRecommendation).includes('অর্থবিল'));
    },
  },
  {
    endpoint: 'gk-convert',
    handler: gkConvertPost,
    buildRequest: (headers, extraBody) =>
      makeJsonRequest(
        'http://localhost:3000/api/ai/gk-convert',
        {
          title: 'বাংলাদেশ ব্যাংকের নতুন মুদ্রানীতি',
          summary: 'রেপো রেট ১০% নির্ধারণ করা হয়েছে।',
          category: 'অর্থনীতি',
          eventDate: '2026-11-20',
          source: 'বাংলাদেশ ব্যাংক',
          ...extraBody,
        },
        headers
      ),
    mockAiText: JSON.stringify([
      {
        questionType: 'MCQ',
        difficulty: 'Medium',
        stem: 'নতুন মুদ্রানীতিতে রেপো রেট কত নির্ধারণ করা হয়েছে?',
        options: ['৮%', '৯%', '১০%', '১১%'],
        correctOptionIndex: 2,
        modelAnswer: '১০%',
        explanation: 'বাংলাদেশ ব্যাংক রেপো রেট ১০% নির্ধারণ করেছে।',
      },
    ]),
    assertSuccessPayload: (json) => {
      assert.ok(Array.isArray(json.questions));
      assert.equal((json.questions as unknown[]).length, 1);
    },
  },
  {
    endpoint: 'tutor',
    handler: tutorPost,
    buildRequest: (headers, extraBody) =>
      makeJsonRequest(
        'http://localhost:3000/api/ai/tutor',
        {
          mode: 'tutor',
          message: 'অনুচ্ছেদ ৮১ কী?',
          history: [],
          chunks: [],
          ...extraBody,
        },
        headers
      ),
    mockAiText: 'অনুচ্ছেদ ৮১ অনুযায়ী অর্থবিল জাতীয় সংসদে উত্থাপিত হয়।',
    assertSuccessPayload: (json) => {
      assert.ok(String(json.reply).includes('অনুচ্ছেদ ৮১'));
    },
  },
];

test('All 6 AI routes reject unauthenticated, expired, and revoked requests with 401 BEFORE invoking Gemini or parsing uploads', async () => {
  const authDeps = createMockAuthDeps({
    'token-a': { uid: 'uid-a', email: 'a@test.local', name: 'User A', dbUserId: 10 },
  });

  let geminiCallCount = 0;
  setGeminiClientForTesting({
    models: {
      generateContent: async () => {
        geminiCallCount += 1;
        return { text: 'should-not-be-called' } as never;
      },
    },
  });

  const store = new InMemorySlidingWindowRateLimitStore();
  setAiGuardTestOverrides({ authDeps, rateLimitStore: store });

  try {
    for (const routeCase of ALL_SIX_ROUTE_CASES) {
      // 1. Missing Authorization header (even if client forges userId/uid/email in body)
      const unauthReq = routeCase.buildRequest({}, {
        userId: 10,
        uid: 'uid-a',
        email: 'a@test.local',
      });
      const unauthRes = await routeCase.handler(unauthReq);
      assert.equal(unauthRes.status, 401, `${routeCase.endpoint}: expected 401 when unauthenticated`);
      const unauthBody = (await unauthRes.json()) as Record<string, unknown>;
      assert.equal(unauthBody.code, 'AUTH_REQUIRED');
      assert.equal(unauthBody.error, BENGALI_AUTH_REQUIRED_MESSAGE);
      assert.equal(unauthBody.retryable, false);

      // 2. Expired token
      const expRes = await routeCase.handler(
        routeCase.buildRequest({ authorization: 'Bearer expired-token' })
      );
      assert.equal(expRes.status, 401, `${routeCase.endpoint}: expected 401 for expired token`);

      // 3. Revoked token
      const revRes = await routeCase.handler(
        routeCase.buildRequest({ authorization: 'Bearer revoked-token' })
      );
      assert.equal(revRes.status, 401, `${routeCase.endpoint}: expected 401 for revoked token`);
    }

    // Extra verification: extract-pdf rejects BEFORE req.formData() is ever touched
    let formDataCalled = false;
    const rawUnauthPdfReq = new NextRequest('http://localhost:3000/api/ai/extract-pdf', {
      method: 'POST',
    });
    rawUnauthPdfReq.formData = async () => {
      formDataCalled = true;
      throw new Error('formData should never be called for unauthenticated requests');
    };
    const pdfEarlyReject = await extractPdfPost(rawUnauthPdfReq);
    assert.equal(pdfEarlyReject.status, 401);
    assert.equal(formDataCalled, false);

    assert.equal(geminiCallCount, 0, 'Gemini must never be invoked for unauthenticated requests');
  } finally {
    setAiGuardTestOverrides(null);
    setGeminiClientForTesting(null);
  }
});

test('All 6 AI routes accept valid Firebase tokens, enforce per-user rate limits with 429 + Retry-After, and keep gemini-4-hydrogen as default model', async () => {
  const authDeps = createMockAuthDeps({
    'token-a': { uid: 'uid-a', email: 'a@test.local', name: 'User A', dbUserId: 201 },
    'token-b': { uid: 'uid-b', email: 'b@test.local', name: 'User B', dbUserId: 202 },
  });

  const store = new InMemorySlidingWindowRateLimitStore();
  // Use a tight test limit of 2 per endpoint so we exercise boundary + 429 cleanly across all 6 routes
  const tightLimits = {
    'extract-pdf': { limit: 2, windowMs: 60_000, ipLimitMultiplier: 5 },
    reader: { limit: 2, windowMs: 60_000, ipLimitMultiplier: 5 },
    questions: { limit: 2, windowMs: 60_000, ipLimitMultiplier: 5 },
    evaluate: { limit: 2, windowMs: 60_000, ipLimitMultiplier: 5 },
    'gk-convert': { limit: 2, windowMs: 60_000, ipLimitMultiplier: 5 },
    tutor: { limit: 2, windowMs: 60_000, ipLimitMultiplier: 5 },
  };

  let mockText = '';
  const invokedModels: string[] = [];
  let geminiCalls = 0;

  setGeminiClientForTesting({
    models: {
      generateContent: async (params) => {
        geminiCalls += 1;
        invokedModels.push(String(params.model));
        return { text: mockText } as never;
      },
    },
  });

  setAiGuardTestOverrides({
    authDeps,
    rateLimitStore: store,
    rateLimits: tightLimits,
    now: () => 1_700_000_000_000,
  });

  try {
    for (const routeCase of ALL_SIX_ROUTE_CASES) {
      mockText = routeCase.mockAiText;
      const callsBefore = geminiCalls;

      // Request 1 & 2 for User A succeed (even if body tries to spoof User B's ID)
      const res1 = await routeCase.handler(
        routeCase.buildRequest(
          { authorization: 'Bearer token-a' },
          { userId: 202, uid: 'uid-b' }
        )
      );
      assert.equal(res1.status, 200, `${routeCase.endpoint}: request 1 should succeed`);
      const json1 = (await res1.json()) as Record<string, unknown>;
      routeCase.assertSuccessPayload(json1);

      const res2 = await routeCase.handler(
        routeCase.buildRequest({ authorization: 'Bearer token-a' })
      );
      assert.equal(res2.status, 200, `${routeCase.endpoint}: request 2 at boundary should succeed`);

      // Request 3 for User A is rate limited (429) BEFORE invoking Gemini
      const res3 = await routeCase.handler(
        routeCase.buildRequest({ authorization: 'Bearer token-a' })
      );
      assert.equal(res3.status, 429, `${routeCase.endpoint}: request 3 should return 429`);
      const retryHeader = Number(res3.headers.get('retry-after'));
      assert.ok(Number.isFinite(retryHeader) && retryHeader >= 1);
      const json3 = (await res3.json()) as Record<string, unknown>;
      assert.equal(json3.code, 'RATE_LIMIT_EXCEEDED');
      assert.equal(json3.retryable, true);
      assert.ok(Number(json3.retryAfterSeconds) >= 1);

      // Verify Gemini was called exactly twice for User A (NOT on the 429)
      assert.equal(geminiCalls - callsBefore, 2);

      // User B's independent quota is completely unaffected (even though User A forged userId: 202)
      const resB = await routeCase.handler(
        routeCase.buildRequest({ authorization: 'Bearer token-b' })
      );
      assert.equal(resB.status, 200, `${routeCase.endpoint}: User B must remain unaffected`);
    }

    assert.ok(invokedModels.length > 0);
    assert.ok(
      invokedModels.every((m) => m === GEMINI_MODEL && m === 'gemini-4-hydrogen'),
      `Expected all routes to preserve gemini-4-hydrogen, got: ${invokedModels.join(', ')}`
    );
  } finally {
    setAiGuardTestOverrides(null);
    setGeminiClientForTesting(null);
  }
});

// ============================================================================
// 4. Client Error Formatting Helper Tests
// ============================================================================

test('formatAiResponseError returns Bengali guidance for 401 and 429 responses', () => {
  assert.equal(
    formatAiResponseError(401, { code: 'AUTH_REQUIRED' }, 'fallback'),
    GUEST_AI_SIGNIN_MESSAGE
  );

  const secMsg = formatAiResponseError(
    429,
    { code: 'RATE_LIMIT_EXCEEDED', error: 'সীমা অতিক্রম', retryAfterSeconds: 45 },
    'fallback'
  );
  assert.ok(secMsg.includes('৪৫') || secMsg.includes('45 সেকেন্ড'));

  const minMsg = formatAiResponseError(
    429,
    { code: 'RATE_LIMIT_EXCEEDED', error: 'সীমা অতিক্রম', retryAfterSeconds: 180 },
    'fallback'
  );
  assert.ok(minMsg.includes('3 মিনিট'));
});
