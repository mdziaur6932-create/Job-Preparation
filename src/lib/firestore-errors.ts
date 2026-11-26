import { auth } from './firebase';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Verbatim blueprint constraints from firebase-blueprint.json
export const FIRESTORE_BLUEPRINT_LIMITS = {
  UID_PATTERN: /^[a-zA-Z0-9_-]{1,128}$/,
  DISPLAY_NAME_MAX: 120,
  EMAIL_MAX: 254,
  TARGET_EXAM_MAX: 160,
  BOOK_TITLE_MAX: 200,
  SUBJECT_MAX: 120,
  NOTE_MAX: 1000,
} as const;

export function sanitizeUserPrivateProfileFields(input: {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  targetExam?: string | null;
  driveSyncEnabled?: boolean;
}) {
  const cleanUid = input.uid.trim();
  if (!FIRESTORE_BLUEPRINT_LIMITS.UID_PATTERN.test(cleanUid)) {
    throw new Error('Invalid Firebase UID for Firestore profile document.');
  }
  return {
    uid: cleanUid,
    displayName: String(input.displayName ?? '')
      .trim()
      .slice(0, FIRESTORE_BLUEPRINT_LIMITS.DISPLAY_NAME_MAX),
    email: String(input.email ?? '')
      .trim()
      .slice(0, FIRESTORE_BLUEPRINT_LIMITS.EMAIL_MAX),
    targetExam: String(input.targetExam ?? '৪৭তম বিসিএস ও ব্যাংক প্রস্তুতি')
      .trim()
      .slice(0, FIRESTORE_BLUEPRINT_LIMITS.TARGET_EXAM_MAX),
    driveSyncEnabled: Boolean(input.driveSyncEnabled ?? true),
  };
}
