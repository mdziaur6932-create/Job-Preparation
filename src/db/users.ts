import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './index.ts';
import { users } from './schema.ts';

export interface ResolvedDbUser {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  targetExam: string | null;
  createdAt: Date;
}

/**
 * Deterministically maps a verified Firebase Auth UID to a stable positive 31-bit integer ID.
 * Used when the workspace runs on Firebase Firestore (without an active Cloud SQL socket)
 * so per-user rate limiting and PDF upload session ownership remain strictly isolated by user.
 */
export function deriveStableUserIdFromUid(uid: string): number {
  const digest = crypto.createHash('sha256').update(`prostuti-uid:${uid}`).digest();
  // Keep strictly within positive signed 32-bit int range [1, 2_147_483_647]
  const raw = digest.readUInt32BE(0) & 0x7fffffff;
  return raw === 0 ? 1 : raw;
}

function hasReachableSqlConfig(): boolean {
  const host = process.env.SQL_HOST?.trim();
  const dbName = process.env.SQL_DB_NAME?.trim();
  const user = process.env.SQL_USER?.trim();
  if (!host || !dbName || !user) return false;
  if (host.startsWith('/')) {
    return fs.existsSync(path.join(host, '.s.PGSQL.5432'));
  }
  return true;
}

function isSqlInfrastructureUnavailable(error: unknown): boolean {
  const chain: unknown[] = [error];
  if (error && typeof error === 'object' && 'cause' in error) {
    chain.push((error as { cause?: unknown }).cause);
  }
  for (const item of chain) {
    if (!item || typeof item !== 'object') continue;
    const code = String((item as { code?: unknown }).code ?? '');
    const msg = String((item as { message?: unknown }).message ?? '');
    if (
      code === 'ENOENT' ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      /ENOENT|ECONNREFUSED|Connection terminated unexpectedly|cloudsql/i.test(msg)
    ) {
      return true;
    }
  }
  return false;
}

function buildFirebaseBackedUser(
  uid: string,
  email: string,
  displayName: string
): ResolvedDbUser {
  return {
    id: deriveStableUserIdFromUid(uid),
    uid,
    email,
    displayName,
    targetExam: '৪৭তম বিসিএস ও ব্যাংক প্রস্তুতি',
    createdAt: new Date(),
  };
}

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName = ''
): Promise<ResolvedDbUser> {
  if (!hasReachableSqlConfig()) {
    return buildFirebaseBackedUser(uid, email, displayName);
  }

  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email,
        displayName,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
          ...(displayName ? { displayName } : {}),
        },
      })
      .returning();

    return {
      ...result[0],
      displayName: result[0].displayName ?? displayName,
    };
  } catch (error) {
    if (isSqlInfrastructureUnavailable(error)) {
      return buildFirebaseBackedUser(uid, email, displayName);
    }
    console.error('Database user upsert failed:', error);
    throw new Error('Unable to synchronize user profile. Please try again.', {
      cause: error,
    });
  }
}

export async function findUserByUid(uid: string): Promise<ResolvedDbUser | null> {
  if (!hasReachableSqlConfig()) {
    return buildFirebaseBackedUser(uid, `${uid}@user.local`, '');
  }

  try {
    const rows = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (!rows[0]) return null;
    return {
      ...rows[0],
      displayName: rows[0].displayName ?? '',
    };
  } catch (error) {
    if (isSqlInfrastructureUnavailable(error)) {
      return buildFirebaseBackedUser(uid, `${uid}@user.local`, '');
    }
    console.error('Database user lookup failed:', error);
    throw new Error('Unable to load user profile. Please try again.', {
      cause: error,
    });
  }
}
