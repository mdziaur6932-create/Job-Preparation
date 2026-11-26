import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import {
  authenticateRequest,
  isRevocationCheckUnsupportedError,
  type AuthDependencies,
} from './server-auth.ts';
import {
  BENGALI_AUTH_REQUIRED_MESSAGE,
  BENGALI_AUTH_UNAVAILABLE_MESSAGE,
  BENGALI_USER_RESOLUTION_UNAVAILABLE_MESSAGE,
  guardAiApiRequest,
} from './ai-api-guard.ts';
import { InMemorySlidingWindowRateLimitStore } from './rate-limit.ts';

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

async function captureLogs(
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

function makeCodedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function makeApiRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (authHeader !== undefined) {
    headers.authorization = authHeader;
  }
  return new NextRequest('http://localhost:3000/api/ai/extract-pdf', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
}

// Exact live-runtime Identity Toolkit disabled error observed in AI Studio container
const LIVE_TRUNCATED_IDENTITY_TOOLKIT_ERROR = () =>
  makeCodedError(
    'auth/internal-error',
    '//console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=883291891152 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.'
  );

const FULL_IDENTITY_TOOLKIT_DISABLED_ERROR = () =>
  makeCodedError(
    'auth/internal-error',
    'Identity Toolkit API has not been used in project 883291891152 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/identitytoolkit.googleapis.com/overview?project=883291891152 then retry.'
  );

// ============================================================================
// Test Group A — Development Revocation Infrastructure Failure (Tests 1 - 5)
// ============================================================================

test('Test 1 (Group A): Development verifyIdToken(token, true) succeeds -> resolves session without fallback', async () => {
  await withNodeEnv('development', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const deps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        return { uid: 'dev-ok-uid', email: 'dev@example.com', name: 'Dev Student' };
      },
      resolveUser: async () => ({ id: 401 }),
    };

    const { warnings, errors } = await captureLogs(async () => {
      const res = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer dev-valid-jwt' }) },
        deps
      );
      assert.equal(res.ok, true);
      if (res.ok) {
        assert.deepEqual(res.session, {
          uid: 'dev-ok-uid',
          email: 'dev@example.com',
          displayName: 'Dev Student',
          dbUserId: 401,
        });
      }
    });

    assert.deepEqual(calls, [{ checkRevoked: true }]);
    assert.equal(warnings.length, 0);
    assert.equal(errors.length, 0);
  });
});

test('Test 2 (Group A): Development recognized Identity Toolkit failure -> uses verifyIdToken(token, false), succeeds for valid token, logs sanitized warning', async () => {
  await withNodeEnv('development', async () => {
    const secretToken = 'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.secret-payload.sig';
    for (const makeErr of [
      LIVE_TRUNCATED_IDENTITY_TOOLKIT_ERROR,
      FULL_IDENTITY_TOOLKIT_DISABLED_ERROR,
    ]) {
      const calls: Array<{ checkRevoked?: boolean }> = [];
      const deps: AuthDependencies = {
        verifyIdToken: async (_token, checkRevoked) => {
          calls.push({ checkRevoked });
          if (checkRevoked) {
            throw makeErr();
          }
          return {
            uid: 'dev-fallback-uid',
            email: 'student@example.com',
            name: 'BCS Candidate',
          };
        },
        resolveUser: async (uid) => {
          assert.equal(uid, 'dev-fallback-uid');
          return { id: 402 };
        },
      };

      const { warnings, errors } = await captureLogs(async () => {
        const res = await authenticateRequest(
          { headers: new Headers({ authorization: `Bearer ${secretToken}` }) },
          deps
        );
        assert.equal(res.ok, true);
        if (res.ok) {
          assert.equal(res.session.uid, 'dev-fallback-uid');
          assert.equal(res.session.dbUserId, 402);
        }
      });

      assert.deepEqual(calls, [{ checkRevoked: true }, { checkRevoked: false }]);
      assert.equal(errors.length, 0);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Development-only fallback/i);
      assert.match(warnings[0], /revocation lookup unavailable/i);
      assert.match(warnings[0], /without revocation checking/i);
      assert.ok(!warnings[0].includes(secretToken), 'Warning must never contain raw token');
      assert.ok(
        !warnings[0].includes('883291891152'),
        'Warning must not expose raw Google project details or raw error message'
      );
    }
  });
});

test('Test 3 (Group A): Development fallback receives expired token -> authentication fails with expired_token', async () => {
  await withNodeEnv('development', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const deps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        if (checkRevoked) {
          throw LIVE_TRUNCATED_IDENTITY_TOOLKIT_ERROR();
        }
        throw makeCodedError('auth/id-token-expired', 'Firebase ID token has expired.');
      },
      resolveUser: async () => ({ id: 403 }),
    };

    await captureLogs(async () => {
      const res = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer dev-expired-jwt' }) },
        deps
      );
      assert.deepEqual(res, { ok: false, reason: 'expired_token' });
    });

    assert.deepEqual(calls, [{ checkRevoked: true }, { checkRevoked: false }]);
  });
});

test('Test 4 (Group A): Development fallback receives invalid token -> authentication fails with invalid_token', async () => {
  await withNodeEnv('development', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const deps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        if (checkRevoked) {
          throw FULL_IDENTITY_TOOLKIT_DISABLED_ERROR();
        }
        throw makeCodedError('auth/argument-error', 'Decoding Firebase ID token failed.');
      },
      resolveUser: async () => ({ id: 404 }),
    };

    await captureLogs(async () => {
      const res = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer dev-invalid-jwt' }) },
        deps
      );
      assert.deepEqual(res, { ok: false, reason: 'invalid_token' });
    });

    assert.deepEqual(calls, [{ checkRevoked: true }, { checkRevoked: false }]);
  });
});

test('Test 5 (Group A): Development fallback limitation documented -> checkRevoked=false cannot independently detect revocation', async () => {
  /**
   * Security note explicitly documented by this test:
   * When Firebase Admin falls back to `verifyIdToken(token, false)` strictly in
   * `NODE_ENV === 'development'`, signature and expiration ARE verified, but
   * `checkRevoked: false` does NOT query Identity Toolkit and therefore CANNOT
   * independently detect server-side token revocation.
   * This test verifies:
   *  (a) the warning log explicitly states "without revocation checking", and
   *  (b) if the verification mock explicitly throws `auth/id-token-revoked`, it is rejected.
   */
  await withNodeEnv('development', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const deps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        if (checkRevoked) {
          throw LIVE_TRUNCATED_IDENTITY_TOOLKIT_ERROR();
        }
        throw makeCodedError('auth/id-token-revoked', 'Firebase ID token has been revoked.');
      },
      resolveUser: async () => ({ id: 405 }),
    };

    const { warnings } = await captureLogs(async () => {
      const res = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer dev-revoked-jwt' }) },
        deps
      );
      assert.deepEqual(res, { ok: false, reason: 'revoked_token' });
    });

    assert.deepEqual(calls, [{ checkRevoked: true }, { checkRevoked: false }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /without revocation checking/i);
  });
});

// ============================================================================
// Test Group B — Production & Unknown-Env Security (Tests 6 - 10)
// ============================================================================

test('Test 6 (Group B): Production revocation verification succeeds -> checkRevoked=true only, no fallback', async () => {
  await withNodeEnv('production', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const deps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        return { uid: 'prod-uid-6', email: 'prod6@example.com', name: 'Prod User' };
      },
      resolveUser: async () => ({ id: 501 }),
    };

    const res = await authenticateRequest(
      { headers: new Headers({ authorization: 'Bearer prod-valid-jwt' }) },
      deps
    );
    assert.equal(res.ok, true);
    assert.deepEqual(calls, [{ checkRevoked: true }]);
  });
});

test('Test 7 (Group B): Production Identity Toolkit API failure -> returns verification_unavailable and NEVER calls verifyIdToken(token, false)', async () => {
  await withNodeEnv('production', async () => {
    for (const makeErr of [
      LIVE_TRUNCATED_IDENTITY_TOOLKIT_ERROR,
      FULL_IDENTITY_TOOLKIT_DISABLED_ERROR,
    ]) {
      const calls: Array<{ checkRevoked?: boolean }> = [];
      const deps: AuthDependencies = {
        verifyIdToken: async (_token, checkRevoked) => {
          calls.push({ checkRevoked });
          throw makeErr();
        },
        resolveUser: async () => ({ id: 502 }),
      };

      const { warnings, errors } = await captureLogs(async () => {
        const res = await authenticateRequest(
          { headers: new Headers({ authorization: 'Bearer prod-valid-jwt' }) },
          deps
        );
        assert.deepEqual(res, { ok: false, reason: 'verification_unavailable' });
      });

      assert.deepEqual(calls, [{ checkRevoked: true }]);
      assert.equal(warnings.length, 0, 'Production must never emit dev fallback warning');
      assert.equal(errors.length, 1);
      assert.ok(!errors[0].includes('883291891152'));
    }
  });
});

test('Test 8 (Group B): Production ADC/IAM failure and unknown environments fail closed without non-revocation fallback', async () => {
  const nonDevEnvs: Array<string | undefined> = ['production', 'staging', 'test', undefined];

  for (const envName of nonDevEnvs) {
    await withNodeEnv(envName, async () => {
      const calls: Array<{ checkRevoked?: boolean }> = [];
      const deps: AuthDependencies = {
        verifyIdToken: async (_token, checkRevoked) => {
          calls.push({ checkRevoked });
          throw makeCodedError(
            'app/invalid-credential',
            'Could not load the default credentials.'
          );
        },
        resolveUser: async () => ({ id: 503 }),
      };

      const { warnings } = await captureLogs(async () => {
        const res = await authenticateRequest(
          { headers: new Headers({ authorization: 'Bearer strict-env-jwt' }) },
          deps
        );
        assert.deepEqual(res, { ok: false, reason: 'verification_unavailable' });
      });

      assert.deepEqual(
        calls,
        [{ checkRevoked: true }],
        `Environment "${String(envName)}" must fail closed and never call verifyIdToken(token, false)`
      );
      assert.equal(warnings.length, 0);
    });
  }
});

test('Test 9 (Group B): Production invalid token -> returns invalid_token without fallback', async () => {
  await withNodeEnv('production', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const deps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        throw makeCodedError('auth/argument-error', 'Invalid signature on Firebase ID token.');
      },
      resolveUser: async () => ({ id: 504 }),
    };

    await captureLogs(async () => {
      const res = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer bad.signature.jwt' }) },
        deps
      );
      assert.deepEqual(res, { ok: false, reason: 'invalid_token' });
    });

    assert.deepEqual(calls, [{ checkRevoked: true }]);
  });
});

test('Test 10 (Group B): Production expired or revoked token -> rejected without fallback', async () => {
  await withNodeEnv('production', async () => {
    const cases = [
      {
        err: makeCodedError('auth/id-token-expired', 'Firebase ID token has expired.'),
        expectedReason: 'expired_token',
      },
      {
        err: makeCodedError('auth/id-token-revoked', 'Firebase ID token has been revoked.'),
        expectedReason: 'revoked_token',
      },
    ] as const;

    for (const c of cases) {
      const calls: Array<{ checkRevoked?: boolean }> = [];
      const deps: AuthDependencies = {
        verifyIdToken: async (_token, checkRevoked) => {
          calls.push({ checkRevoked });
          throw c.err;
        },
        resolveUser: async () => ({ id: 505 }),
      };

      await captureLogs(async () => {
        const res = await authenticateRequest(
          { headers: new Headers({ authorization: 'Bearer prod-token' }) },
          deps
        );
        assert.deepEqual(res, { ok: false, reason: c.expectedReason });
      });

      assert.deepEqual(calls, [{ checkRevoked: true }]);
    }
  });
});

// ============================================================================
// Test Group C — Error Classification (Tests 11 - 15)
// ============================================================================

test('Test 11 (Group C): Recognized auth/internal-error with Identity Toolkit disabled message -> classified as infrastructure failure', () => {
  assert.equal(
    isRevocationCheckUnsupportedError(LIVE_TRUNCATED_IDENTITY_TOOLKIT_ERROR()),
    true
  );
  assert.equal(
    isRevocationCheckUnsupportedError(FULL_IDENTITY_TOOLKIT_DISABLED_ERROR()),
    true
  );
});

test('Test 12 (Group C): SERVICE_DISABLED and PERMISSION_DENIED specifically associated with Identity Toolkit -> classified as infrastructure failure', () => {
  assert.equal(
    isRevocationCheckUnsupportedError(
      makeCodedError(
        'auth/internal-error',
        'SERVICE_DISABLED: Identity Toolkit API (identitytoolkit.googleapis.com) is disabled.'
      )
    ),
    true
  );
  assert.equal(
    isRevocationCheckUnsupportedError(
      makeCodedError(
        'SERVICE_DISABLED',
        'identitytoolkit.googleapis.com has not been used in project 883291891152 before or it is disabled.'
      )
    ),
    true
  );
  assert.equal(
    isRevocationCheckUnsupportedError(
      makeCodedError(
        'auth/internal-error',
        'PERMISSION_DENIED: Caller does not have permission on identitytoolkit.googleapis.com accounts:lookup'
      )
    ),
    true
  );
});

test('Test 13 (Group C): Unrelated auth/internal-error -> must NOT qualify for fallback', async () => {
  const unrelated = makeCodedError(
    'auth/internal-error',
    'Unexpected internal authentication error.'
  );
  assert.equal(isRevocationCheckUnsupportedError(unrelated), false);

  await withNodeEnv('development', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const deps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        throw unrelated;
      },
      resolveUser: async () => ({ id: 601 }),
    };

    await captureLogs(async () => {
      const res = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer test-jwt' }) },
        deps
      );
      assert.deepEqual(res, { ok: false, reason: 'invalid_token' });
    });

    assert.deepEqual(calls, [{ checkRevoked: true }]);
  });
});

test('Test 14 (Group C): Unrelated PERMISSION_DENIED -> must NOT qualify for fallback', async () => {
  const unrelatedPermErrors = [
    makeCodedError('PERMISSION_DENIED', 'PERMISSION_DENIED: Access to storage bucket denied.'),
    makeCodedError(
      'auth/internal-error',
      'PERMISSION_DENIED: Caller cannot read unrelated resource.'
    ),
    new Error('PERMISSION_DENIED: generic service error'),
  ];

  for (const err of unrelatedPermErrors) {
    assert.equal(isRevocationCheckUnsupportedError(err), false);
  }

  await withNodeEnv('development', async () => {
    const calls: Array<{ checkRevoked?: boolean }> = [];
    const deps: AuthDependencies = {
      verifyIdToken: async (_token, checkRevoked) => {
        calls.push({ checkRevoked });
        throw unrelatedPermErrors[0];
      },
      resolveUser: async () => ({ id: 602 }),
    };

    await captureLogs(async () => {
      const res = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer test-jwt' }) },
        deps
      );
      assert.deepEqual(res, { ok: false, reason: 'invalid_token' });
    });

    assert.deepEqual(calls, [{ checkRevoked: true }]);
  });
});

test('Test 15 (Group C): auth/invalid-credential -> preserves security classification (not infrastructure failure)', async () => {
  const invalidCred = makeCodedError(
    'auth/invalid-credential',
    'The credential used to authenticate is invalid.'
  );
  assert.equal(isRevocationCheckUnsupportedError(invalidCred), false);

  for (const envName of ['production', 'development'] as const) {
    await withNodeEnv(envName, async () => {
      const calls: Array<{ checkRevoked?: boolean }> = [];
      const deps: AuthDependencies = {
        verifyIdToken: async (_token, checkRevoked) => {
          calls.push({ checkRevoked });
          throw invalidCred;
        },
        resolveUser: async () => ({ id: 603 }),
      };

      await captureLogs(async () => {
        const res = await authenticateRequest(
          { headers: new Headers({ authorization: 'Bearer test-jwt' }) },
          deps
        );
        assert.deepEqual(res, { ok: false, reason: 'invalid_token' });
      });

      assert.deepEqual(calls, [{ checkRevoked: true }]);
    });
  }
});

// ============================================================================
// Test Group D — Database Resolution (Tests 16 - 19)
// ============================================================================

test('Test 16 (Group D): Successful getOrCreateUser() -> returns VerifiedSession', async () => {
  const deps: AuthDependencies = {
    verifyIdToken: async () => ({
      uid: 'db-ok-uid',
      email: 'candidate@example.com',
      name: 'Candidate',
    }),
    resolveUser: async (uid, email, displayName) => {
      assert.equal(uid, 'db-ok-uid');
      assert.equal(email, 'candidate@example.com');
      assert.equal(displayName, 'Candidate');
      return { id: 701 };
    },
  };

  const res = await authenticateRequest(
    { headers: new Headers({ authorization: 'Bearer valid-jwt' }) },
    deps
  );
  assert.deepEqual(res, {
    ok: true,
    session: {
      uid: 'db-ok-uid',
      email: 'candidate@example.com',
      displayName: 'Candidate',
      dbUserId: 701,
    },
  });
});

test('Test 17 (Group D): Database connection failure -> returns user_resolution_unavailable without leaking SQL/credentials', async () => {
  const sensitiveDbError = makeCodedError(
    'ECONNREFUSED',
    'connect ECONNREFUSED 10.0.0.5:5432 postgres://admin:supersecret@db.internal/appdb SELECT * FROM users'
  );
  const deps: AuthDependencies = {
    verifyIdToken: async () => ({
      uid: 'db-conn-uid',
      email: 'candidate@example.com',
      name: 'Candidate',
    }),
    resolveUser: async () => {
      throw sensitiveDbError;
    },
  };

  const { errors } = await captureLogs(async () => {
    const res = await authenticateRequest(
      { headers: new Headers({ authorization: 'Bearer valid-jwt' }) },
      deps
    );
    assert.deepEqual(res, { ok: false, reason: 'user_resolution_unavailable' });
  });

  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes('supersecret'), 'Logs must never expose DB credentials');
  assert.ok(!errors[0].includes('SELECT * FROM'), 'Logs must never expose SQL statements');
  assert.ok(!errors[0].includes('10.0.0.5'), 'Logs must never expose DB host details');
});

test('Test 18 (Group D): Database query timeout -> returns user_resolution_unavailable', async () => {
  const timeoutError = makeCodedError(
    '57014',
    'canceling statement due to statement timeout'
  );
  const deps: AuthDependencies = {
    verifyIdToken: async () => ({
      uid: 'db-timeout-uid',
      email: 'candidate@example.com',
      name: 'Candidate',
    }),
    resolveUser: async () => {
      throw timeoutError;
    },
  };

  await captureLogs(async () => {
    const res = await authenticateRequest(
      { headers: new Headers({ authorization: 'Bearer valid-jwt' }) },
      deps
    );
    assert.deepEqual(res, { ok: false, reason: 'user_resolution_unavailable' });
  });
});

test('Test 19 (Group D): Database error is never misclassified as invalid_token or unmapped_user, while null user preserves unmapped_user', async () => {
  const dbErrorRes = await (async () => {
    let result: Awaited<ReturnType<typeof authenticateRequest>> | undefined;
    await captureLogs(async () => {
      result = await authenticateRequest(
        { headers: new Headers({ authorization: 'Bearer valid-jwt' }) },
        {
          verifyIdToken: async () => ({
            uid: 'db-err-uid',
            email: 'candidate@example.com',
            name: 'Candidate',
          }),
          resolveUser: async () => {
            throw new Error('Unable to synchronize user profile. Please try again.');
          },
        }
      );
    });
    return result!;
  })();

  assert.equal(dbErrorRes.ok, false);
  if (!dbErrorRes.ok) {
    assert.equal(dbErrorRes.reason, 'user_resolution_unavailable');
    assert.notEqual(dbErrorRes.reason, 'invalid_token');
    assert.notEqual(dbErrorRes.reason, 'unmapped_user');
  }

  // Genuine null mapping still preserves `unmapped_user`
  const nullUserRes = await authenticateRequest(
    { headers: new Headers({ authorization: 'Bearer valid-jwt' }) },
    {
      verifyIdToken: async () => ({
        uid: 'unmapped-uid',
        email: 'candidate@example.com',
        name: 'Candidate',
      }),
      resolveUser: async () => null,
    }
  );
  assert.deepEqual(nullUserRes, { ok: false, reason: 'unmapped_user' });
});

// ============================================================================
// Test Group E — API Guard HTTP Mapping (Tests 20 - 24)
// ============================================================================

test('Test 20 (Group E): Missing token -> HTTP 401 AUTH_REQUIRED', async () => {
  const guardRes = await guardAiApiRequest(makeApiRequest(), 'extract-pdf', {
    rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
  });
  assert.equal(guardRes.ok, false);
  if (!guardRes.ok) {
    assert.equal(guardRes.response.status, 401);
    const body = (await guardRes.response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'AUTH_REQUIRED');
    assert.equal(body.error, BENGALI_AUTH_REQUIRED_MESSAGE);
    assert.equal(body.retryable, false);
  }
});

test('Test 21 (Group E): Invalid token -> HTTP 401 AUTH_REQUIRED', async () => {
  await captureLogs(async () => {
    const guardRes = await guardAiApiRequest(
      makeApiRequest('Bearer malformed.invalid.token'),
      'extract-pdf',
      {
        authDeps: {
          verifyIdToken: async () => {
            throw makeCodedError('auth/argument-error', 'Decoding Firebase ID token failed.');
          },
          resolveUser: async () => ({ id: 801 }),
        },
        rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
      }
    );
    assert.equal(guardRes.ok, false);
    if (!guardRes.ok) {
      assert.equal(guardRes.response.status, 401);
      const body = (await guardRes.response.json()) as Record<string, unknown>;
      assert.equal(body.code, 'AUTH_REQUIRED');
      assert.equal(body.error, BENGALI_AUTH_REQUIRED_MESSAGE);
      assert.equal(body.retryable, false);
    }
  });
});

test('Test 22 (Group E): Verification infrastructure failure -> HTTP 503 AUTH_VERIFICATION_UNAVAILABLE', async () => {
  await withNodeEnv('production', async () => {
    await captureLogs(async () => {
      const guardRes = await guardAiApiRequest(
        makeApiRequest('Bearer valid-prod-jwt'),
        'extract-pdf',
        {
          authDeps: {
            verifyIdToken: async () => {
              throw LIVE_TRUNCATED_IDENTITY_TOOLKIT_ERROR();
            },
            resolveUser: async () => ({ id: 802 }),
          },
          rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
        }
      );
      assert.equal(guardRes.ok, false);
      if (!guardRes.ok) {
        assert.equal(guardRes.response.status, 503);
        const body = (await guardRes.response.json()) as Record<string, unknown>;
        assert.equal(body.code, 'AUTH_VERIFICATION_UNAVAILABLE');
        assert.equal(body.error, BENGALI_AUTH_UNAVAILABLE_MESSAGE);
        assert.equal(body.retryable, true);
        assert.ok(
          !String(body.error).includes('সাইন ইন'),
          '503 message must not instruct already authenticated user to sign in again'
        );
        assert.ok(
          !String(body.error).includes('identitytoolkit'),
          '503 message must not leak Google API details'
        );
      }
    });
  });
});

test('Test 23 (Group E): Database user-resolution failure -> HTTP 503 AUTH_USER_RESOLUTION_UNAVAILABLE', async () => {
  await captureLogs(async () => {
    const guardRes = await guardAiApiRequest(
      makeApiRequest('Bearer valid-user-jwt'),
      'extract-pdf',
      {
        authDeps: {
          verifyIdToken: async () => ({
            uid: 'db-down-uid',
            email: 'student@example.com',
            name: 'Student',
          }),
          resolveUser: async () => {
            throw makeCodedError('ECONNREFUSED', 'connect ECONNREFUSED postgres://secret');
          },
        },
        rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
      }
    );
    assert.equal(guardRes.ok, false);
    if (!guardRes.ok) {
      assert.equal(guardRes.response.status, 503);
      const body = (await guardRes.response.json()) as Record<string, unknown>;
      assert.equal(body.code, 'AUTH_USER_RESOLUTION_UNAVAILABLE');
      assert.equal(body.error, BENGALI_USER_RESOLUTION_UNAVAILABLE_MESSAGE);
      assert.equal(body.retryable, true);
      assert.ok(
        !String(body.error).includes('সাইন ইন'),
        '503 DB error must not instruct user to sign in repeatedly'
      );
      assert.ok(
        !String(body.error).includes('postgres'),
        '503 DB error must not leak DB details'
      );
    }
  });
});

test('Test 24 (Group E): Valid authenticated user -> API guard allows request (both production checkRevoked=true and development Identity Toolkit fallback)', async () => {
  // 24a: Production normal path
  await withNodeEnv('production', async () => {
    const guardRes = await guardAiApiRequest(
      makeApiRequest('Bearer prod-valid-jwt'),
      'extract-pdf',
      {
        authDeps: {
          verifyIdToken: async (_token, checkRevoked) => {
            assert.equal(checkRevoked, true);
            return { uid: 'ok-prod-uid', email: 'ok@example.com', name: 'OK User' };
          },
          resolveUser: async () => ({ id: 804 }),
        },
        rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
      }
    );
    assert.equal(guardRes.ok, true);
    if (guardRes.ok) {
      assert.equal(guardRes.session.dbUserId, 804);
      assert.equal(guardRes.session.uid, 'ok-prod-uid');
    }
  });

  // 24b: Development fallback path when Identity Toolkit API is disabled in host project
  await withNodeEnv('development', async () => {
    await captureLogs(async () => {
      const guardRes = await guardAiApiRequest(
        makeApiRequest('Bearer dev-valid-jwt'),
        'extract-pdf',
        {
          authDeps: {
            verifyIdToken: async (_token, checkRevoked) => {
              if (checkRevoked) {
                throw LIVE_TRUNCATED_IDENTITY_TOOLKIT_ERROR();
              }
              return { uid: 'ok-dev-uid', email: 'dev@example.com', name: 'Dev User' };
            },
            resolveUser: async () => ({ id: 805 }),
          },
          rateLimitStore: new InMemorySlidingWindowRateLimitStore(),
        }
      );
      assert.equal(guardRes.ok, true);
      if (guardRes.ok) {
        assert.equal(guardRes.session.dbUserId, 805);
        assert.equal(guardRes.session.uid, 'ok-dev-uid');
      }
    });
  });
});
