export type FrontendAuthStatus =
  | 'initializing'
  | 'guest'
  | 'signing_in'
  | 'authenticated'
  | 'signing_out'
  | 'error';

export interface FirebaseAuthUserLike {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

export type FirebaseSignInErrorCategory =
  | 'popup_blocked'
  | 'popup_closed'
  | 'unauthorized_domain'
  | 'network_error'
  | 'operation_not_allowed'
  | 'token_refresh_failed'
  | 'unknown_error';

export interface FormattedSignInError {
  category: FirebaseSignInErrorCategory;
  code: string;
  message: string;
}

export type AuthHeaderRetrievalResult =
  | { ok: true; headers: { Authorization: string }; token: string }
  | {
      ok: false;
      reason: 'initializing' | 'unauthenticated' | 'token_refresh_failed';
      message?: string;
    };

export const AUTH_TOKEN_REFRESH_ERROR_MESSAGE =
  'আপনার Google সেশন টোকেন নবায়ন করা যায়নি। অনুগ্রহ করে পুনরায় Google দিয়ে সাইন-ইন করুন।';

export const AUTH_INITIALIZING_WAIT_MESSAGE =
  'অ্যাকাউন্ট সেশন যাচাই হচ্ছে। অনুগ্রহ করে এক মুহূর্ত অপেক্ষা করে পুনরায় চেষ্টা করুন।';

function extractFirebaseClientErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const candidate = (error as { code?: unknown }).code;
  if (typeof candidate === 'string' && candidate.trim()) {
    return candidate.trim();
  }
  const msg = error instanceof Error ? error.message : '';
  const match = /\((auth\/[a-z0-9-]+)\)/i.exec(msg);
  return match?.[1] ?? '';
}

/**
 * Maps Firebase client-side authentication errors into sanitized, actionable
 * Bengali messages without exposing raw stack traces, tokens, or internal details.
 */
export function formatFirebaseSignInError(error: unknown): FormattedSignInError {
  const code = extractFirebaseClientErrorCode(error);

  switch (code) {
    case 'auth/popup-blocked':
      return {
        category: 'popup_blocked',
        code,
        message:
          'আপনার ব্রাউজার Google সাইন-ইন পপ-আপ ব্লক করেছে। অনুগ্রহ করে এই সাইটের জন্য পপ-আপ অনুমতি দিয়ে আবার চেষ্টা করুন।',
      };
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return {
        category: 'popup_closed',
        code,
        message:
          'Google সাইন-ইন পপ-আপ সম্পন্ন হওয়ার আগেই বন্ধ হয়ে গেছে। আবার সাইন-ইন করতে বাটনে ক্লিক করুন।',
      };
    case 'auth/unauthorized-domain':
      return {
        category: 'unauthorized_domain',
        code,
        message:
          'এই ডোমেইনটি Firebase সাইন-ইনের জন্য অনুমোদিত নয়। অনুগ্রহ করে অনুমোদিত অ্যাপ URL থেকে চেষ্টা করুন অথবা Firebase Authorized Domains-এ ডোমেইনটি যুক্ত করুন।',
      };
    case 'auth/network-request-failed':
      return {
        category: 'network_error',
        code,
        message:
          'নেটওয়ার্ক সংযোগের সমস্যার কারণে Google সাইন-ইন সম্পন্ন করা যায়নি। ইন্টারনেট সংযোগ যাচাই করে আবার চেষ্টা করুন।',
      };
    case 'auth/operation-not-allowed':
      return {
        category: 'operation_not_allowed',
        code,
        message:
          'এই অ্যাপ্লিকেশনে Google সাইন-ইন পদ্ধতি সক্রিয় নেই। অনুগ্রহ করে প্রজেক্ট প্রশাসকের সাথে যোগাযোগ করুন।',
      };
    default:
      return {
        category: 'unknown_error',
        code: code || 'auth/unknown',
        message:
          'Google সাইন-ইন সম্পন্ন করা যায়নি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
      };
  }
}

/**
 * Returns true while authentication state is still initializing or actively
 * transitioning so callers never mistake loading states for Guest Mode or fire
 * duplicate Sign-In prompts.
 */
export function isAuthStateResolving(status: FrontendAuthStatus): boolean {
  return (
    status === 'initializing' ||
    status === 'signing_in' ||
    status === 'signing_out'
  );
}

/**
 * Returns true when an AI feature should wait instead of opening the Guest
 * Sign-In Required modal (i.e., while initial Firebase auth is still settling
 * or an interactive sign-in is already in progress).
 */
export function shouldDeferAiSignInPrompt(status: FrontendAuthStatus): boolean {
  return status === 'initializing' || status === 'signing_in';
}

/**
 * Resolves the authoritative Firebase user by preferring Firebase SDK's live
 * `auth.currentUser` over potentially lagging React state, while respecting
 * active sign-out transitions.
 */
export function resolveCurrentAuthenticatedUser<T extends FirebaseAuthUserLike>(params: {
  currentAuthUser: T | null | undefined;
  reactUser: T | null | undefined;
  authStatus: FrontendAuthStatus;
}): T | null {
  if (params.authStatus === 'signing_out') {
    return null;
  }
  return params.currentAuthUser ?? params.reactUser ?? null;
}

/**
 * Retrieves a valid `Authorization: Bearer <token>` header from the current
 * authenticated Firebase user without exposing or logging token values.
 *
 * - Returns `initializing` if Firebase has not finished initial auth hydration.
 * - Returns `unauthenticated` only when there is genuinely no authenticated user.
 * - Returns controlled `token_refresh_failed` (never throwing) if `getIdToken` fails.
 */
export async function retrieveAiAuthHeaders(params: {
  currentAuthUser: FirebaseAuthUserLike | null | undefined;
  reactUser: FirebaseAuthUserLike | null | undefined;
  authStatus: FrontendAuthStatus;
  forceRefresh?: boolean;
}): Promise<AuthHeaderRetrievalResult> {
  const activeUser = resolveCurrentAuthenticatedUser({
    currentAuthUser: params.currentAuthUser,
    reactUser: params.reactUser,
    authStatus: params.authStatus,
  });

  if (!activeUser) {
    if (params.authStatus === 'initializing') {
      return {
        ok: false,
        reason: 'initializing',
        message: AUTH_INITIALIZING_WAIT_MESSAGE,
      };
    }
    return {
      ok: false,
      reason: 'unauthenticated',
    };
  }

  try {
    const token = await activeUser.getIdToken(Boolean(params.forceRefresh));
    if (typeof token !== 'string' || !token.trim()) {
      return {
        ok: false,
        reason: 'token_refresh_failed',
        message: AUTH_TOKEN_REFRESH_ERROR_MESSAGE,
      };
    }
    const cleanToken = token.trim();
    return {
      ok: true,
      token: cleanToken,
      headers: {
        Authorization: `Bearer ${cleanToken}`,
      },
    };
  } catch {
    return {
      ok: false,
      reason: 'token_refresh_failed',
      message: AUTH_TOKEN_REFRESH_ERROR_MESSAGE,
    };
  }
}

export interface SignInModalState {
  aiAuthPrompt: { featureName: string; message: string } | null;
  authStatus: FrontendAuthStatus;
  authError: string | null;
}

/**
 * Computes the next frontend auth UI state after `signInWithPopup` resolves
 * with a verified Firebase user — explicitly closing any open Sign-In modal
 * even when `onAuthStateChanged` does not re-fire for the same Google account.
 */
export function applySignInSuccessUiState(): SignInModalState {
  return {
    aiAuthPrompt: null,
    authStatus: 'authenticated',
    authError: null,
  };
}

/**
 * Computes the next frontend auth UI state after `signInWithPopup` rejects.
 * Never closes an open Sign-In modal on failure and preserves a clear Bengali error.
 */
export function applySignInFailureUiState(params: {
  error: unknown;
  currentPrompt: { featureName: string; message: string } | null;
  hasExistingAuthenticatedUser: boolean;
}): SignInModalState {
  const formatted = formatFirebaseSignInError(params.error);
  return {
    aiAuthPrompt: params.currentPrompt,
    authStatus: params.hasExistingAuthenticatedUser ? 'authenticated' : 'error',
    authError: formatted.message,
  };
}
