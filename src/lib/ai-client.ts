export const GUEST_AI_SIGNIN_MESSAGE =
  'এই AI ফিচারটি ব্যবহার করতে Google অ্যাকাউন্ট দিয়ে সাইন ইন করুন। আপনার Guest Mode-এর স্থানীয় তথ্য অক্ষত থাকবে।';

export interface AiApiErrorPayload {
  error?: string;
  code?: string;
  retryAfterSeconds?: number;
}

export function isRateLimitErrorPayload(
  status: number,
  payload: AiApiErrorPayload | null | undefined
): boolean {
  return (
    status === 429 ||
    payload?.code === 'RATE_LIMIT_EXCEEDED' ||
    payload?.code === 'AI_RATE_LIMITED'
  );
}

/**
 * Formats backend AI HTTP error responses (especially 401 and 429) into clear Bengali messages.
 */
export function formatAiResponseError(
  status: number,
  payload: AiApiErrorPayload | null | undefined,
  fallbackMessage: string
): string {
  if (status === 401 || payload?.code === 'AUTH_REQUIRED') {
    return GUEST_AI_SIGNIN_MESSAGE;
  }

  if (isRateLimitErrorPayload(status, payload)) {
    const baseMsg =
      payload?.error ||
      'আপনি অল্প সময়ে অনেকগুলো AI অনুরোধ করেছেন। কিছুক্ষণ অপেক্ষা করে আবার চেষ্টা করুন।';
    if (
      typeof payload?.retryAfterSeconds === 'number' &&
      payload.retryAfterSeconds > 0
    ) {
      const secs = Math.ceil(payload.retryAfterSeconds);
      if (secs >= 3600) {
        const hours = Math.floor(secs / 3600);
        const remMins = Math.ceil((secs % 3600) / 60);
        const durationText =
          remMins > 0 && remMins < 60
            ? `${hours} ঘণ্টা ${remMins} মিনিট`
            : `${hours + (remMins >= 60 ? 1 : 0)} ঘণ্টা`;
        return `${baseMsg} (ফ্রি-টিয়ার দৈনিক সীমা রিসেট হতে প্রায় ${durationText} বাকি। Settings > Secrets থেকে পেইড API কী নির্বাচন করলে সীমা বাড়বে, অথবা নিচের "সরাসরি বই থেকে (০ API)" মোড ব্যবহার করুন।)`;
      }
      if (secs >= 60) {
        const mins = Math.ceil(secs / 60);
        return `${baseMsg} (প্রায় ${mins} মিনিট পর পুনরায় চেষ্টা করুন।)`;
      }
      return `${baseMsg} (প্রায় ${secs} সেকেন্ড পর পুনরায় চেষ্টা করুন।)`;
    }
    return baseMsg;
  }

  return payload?.error || fallbackMessage;
}
