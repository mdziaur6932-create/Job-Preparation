import { eq } from 'drizzle-orm';
import { db } from './index.ts';
import { users } from './schema.ts';

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName = ''
) {
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

    return result[0];
  } catch (error) {
    console.error('Database user upsert failed:', error);
    throw new Error('Unable to synchronize user profile. Please try again.', {
      cause: error,
    });
  }
}

export async function findUserByUid(uid: string) {
  try {
    const rows = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Database user lookup failed:', error);
    throw new Error('Unable to load user profile. Please try again.', {
      cause: error,
    });
  }
}
