import { NextRequest } from 'next/server';
import { adminAuth } from './firebase-admin.ts';
import { getOrCreateUser } from '../db/users.ts';

export interface VerifiedSession {
  uid: string;
  email: string;
  displayName: string;
  dbUserId: number;
}

export async function verifyAuthRequest(
  req: NextRequest
): Promise<VerifiedSession | null> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const email = decoded.email ?? `${decoded.uid}@user.local`;
    const displayName =
      typeof decoded.name === 'string' ? decoded.name : email.split('@')[0];
    const dbUser = await getOrCreateUser(decoded.uid, email, displayName);
    return {
      uid: decoded.uid,
      email,
      displayName,
      dbUserId: dbUser.id,
    };
  } catch (error) {
    console.error('Firebase ID token verification failed:', error);
    return null;
  }
}
