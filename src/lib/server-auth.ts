import { NextRequest } from 'next/server';
import { adminAuth } from './firebase-admin.ts';
import { getOrCreateUser } from '../db/users.ts';

export interface VerifiedSession {
  uid: string;
  email: string;
  displayName: string;
  dbUserId: number;
}

export type AuthFailureReason =
  | 'missing_header'
  | 'malformed_header'
  | 'invalid_token'
  | 'expired_token'
  | 'revoked_token'
  | 'verification_unavailable'
  | 'user_resolution_unavailable'
  | 'unmapped_user';

export type AuthVerificationResult =
  | { ok: true; session: VerifiedSession }
  | { ok: false; reason: AuthFailureReason };

export interface DecodedFirebaseToken {
  uid: string;
  email?: string;
  name?: string;
}

export interface AuthDependencies {
  verifyIdToken?: (
    token: string,
    checkRevoked?: boolean
  ) => Promise<DecodedFirebaseToken>;
  resolveUser?: (
    uid: string,
    email: string,
    displayName: string
  ) => Promise<{ id: number } | null>;
}

/**
 * Extracts and validates the `Authorization: Bearer <token>` header.
 * Rejects missing headers, non-Bearer schemes, empty tokens, or whitespace-containing tokens.
 */
export function extractBearerToken(
  authHeader: string | null
): { ok: true; token: string } | { ok: false; reason: 'missing_header' | 'malformed_header' } {
  if (!authHeader || !authHeader.trim()) {
    return { ok: false, reason: 'missing_header' };
  }

  const trimmed = authHeader.trim();
  const match = /^Bearer\s+(\S+)$/.exec(trimmed);
  if (!match || !match[1]) {
    return { ok: false, reason: 'malformed_header' };
  }

  return { ok: true, token: match[1] };
}

function getFirebaseErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const errObj = error as { code?: unknown; errorInfo?: { code?: unknown } };
  if (typeof errObj.code === 'string' && errObj.code.trim()) {
    return errObj.code.trim();
  }
  if (typeof errObj.errorInfo?.code === 'string' && errObj.errorInfo.code.trim()) {
    return errObj.errorInfo.code.trim();
  }
  return '';
}

function extractErrorMessageForClassification(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error ?? '');
  }
  const errObj = error as {
    message?: unknown;
    errorInfo?: { message?: unknown };
  };
  const parts: string[] = [];
  if (typeof errObj.message === 'string') {
    parts.push(errObj.message);
  }
  if (typeof errObj.errorInfo?.message === 'string') {
    parts.push(errObj.errorInfo.message);
  }
  return parts.join(' ');
}

/**
 * Produces a safe server-side diagnostic label containing only error type and validated error code.
 * Never logs raw error messages, stack traces, SQL strings, ID tokens, or private credentials.
 */
function formatSafeAuthDiagnostic(error: unknown): string {
  const rawCode = getFirebaseErrorCode(error);
  const safeCode = /^[A-Za-z0-9/_-]{1,64}$/.test(rawCode) ? rawCode : '';
  const rawName = error instanceof Error && error.name ? error.name : 'AuthError';
  const safeName = /^[A-Za-z0-9_$-]{1,64}$/.test(rawName) ? rawName : 'AuthError';
  return safeCode ? `${safeName} (${safeCode})` : safeName;
}

const IDENTITY_TOOLKIT_SERVICE_PATTERNS: ReadonlyArray<RegExp> = [
  /identitytoolkit\.googleapis\.com/i,
  /Identity Toolkit API/i,
  /accounts:lookup/i,
];

const REVOCATION_API_ACTIVATION_OR_PERMISSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bSERVICE_DISABLED\b/i,
  /\bPERMISSION_DENIED\b/i,
  /has not been used in project/i,
  /apis\/api\/identitytoolkit\.googleapis\.com\/overview/i,
  /If you enabled this API recently/i,
  /Enable it by visiting/i,
  /\b(?:api|service)\b[^.]{0,80}\bdisabled\b|\bdisabled\b[^.]{0,80}\b(?:api|service)\b/i,
  /caller does not have permission|permission denied|insufficient permission/i,
];

const ADC_INFRASTRUCTURE_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /Could not load the default credentials/i,
  /unable to detect a project id/i,
  /failed to determine service account/i,
];

/**
 * Narrowly identifies Firebase Admin / Google Identity Toolkit infrastructure failures
 * that prevent revocation user-record lookups (`verifyIdToken(token, true)`).
 *
 * Explicitly excludes:
 * - invalid, malformed, expired, or revoked tokens
 * - `auth/invalid-credential`
 * - generic/unrelated `auth/internal-error`
 * - unrelated `PERMISSION_DENIED` errors not tied to Identity Toolkit revocation lookup
 * - generic network/socket failures
 */
export function isRevocationCheckUnsupportedError(error: unknown): boolean {
  const code = getFirebaseErrorCode(error);

  // Fast-reject token, credential, and user-state auth failures
  if (
    code.startsWith('auth/id-token-') ||
    code === 'auth/argument-error' ||
    code === 'auth/invalid-credential' ||
    code === 'auth/invalid-id-token' ||
    code === 'auth/user-not-found' ||
    code === 'auth/user-disabled'
  ) {
    return false;
  }

  // Confirmed Firebase Admin ADC / IAM error codes
  if (
    code === 'app/invalid-credential' ||
    code === 'auth/insufficient-permission'
  ) {
    return true;
  }

  const message = extractErrorMessageForClassification(error);
  if (!message) {
    return false;
  }

  // Confirmed ADC initialization failures without an auth-token code
  if (ADC_INFRASTRUCTURE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }

  // Narrowly recognize Identity Toolkit API disabled / activation / permission failures
  // surfaced via `auth/internal-error` or raw Google API infrastructure error codes
  const allowedIdentityToolkitCode =
    code === 'auth/internal-error' ||
    code === '' ||
    code === 'SERVICE_DISABLED' ||
    code === 'PERMISSION_DENIED';

  if (!allowedIdentityToolkitCode) {
    return false;
  }

  const referencesIdentityToolkit = IDENTITY_TOOLKIT_SERVICE_PATTERNS.some((pattern) =>
    pattern.test(message)
  );
  if (!referencesIdentityToolkit) {
    return false;
  }

  return REVOCATION_API_ACTIVATION_OR_PERMISSION_PATTERNS.some((pattern) =>
    pattern.test(message)
  );
}

function classifyTokenVerificationError(error: unknown): AuthFailureReason {
  const code = getFirebaseErrorCode(error);
  const message = extractErrorMessageForClassification(error);

  if (code === 'auth/id-token-revoked' || /revoked/i.test(message)) {
    return 'revoked_token';
  }
  if (code === 'auth/id-token-expired' || /expired/i.test(message)) {
    return 'expired_token';
  }
  return 'invalid_token';
}

/**
 * Server-side Firebase Bearer token authentication with revocation checking and
 * established PostgreSQL user resolution.
 *
 * Security guarantees:
 * - In Production (`NODE_ENV === 'production'`) and any unknown/non-development environment,
 *   ALWAYS fails closed if revocation verification infrastructure is unavailable
 *   (`verifyIdToken(token, false)` is NEVER invoked).
 * - Strictly when `NODE_ENV === 'development'`, permits a warning-logged development-only
 *   fallback ONLY for narrowly recognized Identity Toolkit / ADC / IAM revocation lookup
 *   infrastructure failures. This fallback still verifies signature and expiry via
 *   `verifyIdToken(token, false)` and does NOT verify token revocation.
 * - Distinguishes database user-resolution infrastructure failures (`user_resolution_unavailable`)
 *   from invalid tokens (`invalid_token`) and unmapped users (`unmapped_user`).
 * - Never trusts client-supplied UID, email, or userId fields.
 */
export async function authenticateRequest(
  req: Pick<NextRequest, 'headers'>,
  deps: AuthDependencies = {}
): Promise<AuthVerificationResult> {
  const extracted = extractBearerToken(req.headers.get('authorization'));
  if (!extracted.ok) {
    return { ok: false, reason: extracted.reason };
  }

  const verifyIdToken =
    deps.verifyIdToken ??
    ((token: string, checkRevoked?: boolean) =>
      adminAuth.verifyIdToken(token, checkRevoked));
  const resolveUser = deps.resolveUser ?? getOrCreateUser;
  const isDevelopment = process.env.NODE_ENV === 'development';

  let decoded: DecodedFirebaseToken;
  try {
    decoded = await verifyIdToken(extracted.token, true);
  } catch (error) {
    if (isRevocationCheckUnsupportedError(error)) {
      if (!isDevelopment) {
        console.error(
          `[server-auth] Firebase revocation verification unavailable (${formatSafeAuthDiagnostic(error)}). Failing closed without non-revocation fallback.`
        );
        return { ok: false, reason: 'verification_unavailable' };
      }

      console.info(
        '[server-auth] Development-only fallback: Firebase revocation lookup unavailable in local dev runtime. Proceeding with verifyIdToken(token, false) without revocation checking. Not permitted in production.'
      );
      try {
        decoded = await verifyIdToken(extracted.token, false);
      } catch (fallbackError) {
        console.error(
          `[server-auth] Firebase ID token verification failed during development fallback (${formatSafeAuthDiagnostic(fallbackError)}).`
        );
        return {
          ok: false,
          reason: classifyTokenVerificationError(fallbackError),
        };
      }
    } else {
      console.error(
        `[server-auth] Firebase ID token verification failed (${formatSafeAuthDiagnostic(error)}).`
      );
      return {
        ok: false,
        reason: classifyTokenVerificationError(error),
      };
    }
  }

  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid.trim()) {
    return { ok: false, reason: 'invalid_token' };
  }

  const uid = decoded.uid.trim();
  const email =
    typeof decoded.email === 'string' && decoded.email.trim()
      ? decoded.email.trim()
      : `${uid}@user.local`;
  const displayName =
    typeof decoded.name === 'string' && decoded.name.trim()
      ? decoded.name.trim()
      : email.split('@')[0];

  try {
    const dbUser = await resolveUser(uid, email, displayName);
    if (!dbUser || typeof dbUser.id !== 'number' || !Number.isFinite(dbUser.id)) {
      return { ok: false, reason: 'unmapped_user' };
    }

    return {
      ok: true,
      session: {
        uid,
        email,
        displayName,
        dbUserId: dbUser.id,
      },
    };
  } catch (error) {
    console.error(
      `[server-auth] Authenticated user database resolution unavailable (${formatSafeAuthDiagnostic(error)}).`
    );
    return { ok: false, reason: 'user_resolution_unavailable' };
  }
}

/**
 * Backward-compatible authentication helper used by existing routes such as /api/workspace.
 */
export async function verifyAuthRequest(
  req: NextRequest,
  deps?: AuthDependencies
): Promise<VerifiedSession | null> {
  const result = await authenticateRequest(req, deps);
  return result.ok ? result.session : null;
}
