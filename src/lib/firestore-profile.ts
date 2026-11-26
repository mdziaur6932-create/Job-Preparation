'use client';

import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from './firebase';
import {
  OperationType,
  handleFirestoreError,
  sanitizeUserPrivateProfileFields,
} from './firestore-errors';
import { shouldCreatePrivateProfile } from './firestore-sync-guards';

export interface FirestoreUserProfile {
  uid: string;
  displayName: string;
  email: string;
  targetExam: string;
  driveSyncEnabled: boolean;
}

export function getPrivateProfilePath(uid: string): string {
  return `users/${uid}/private/profile`;
}

export function subscribeUserPrivateProfile(params: {
  user: User;
  onProfile: (profile: FirestoreUserProfile) => void;
  onError?: (err: Error) => void;
}): Unsubscribe {
  const { user, onProfile, onError } = params;
  const profilePath = getPrivateProfilePath(user.uid);
  const profileRef = doc(db, 'users', user.uid, 'private', 'profile');
  let createAttempted = false;

  return onSnapshot(
    profileRef,
    (snapshot) => {
      if (snapshot.exists()) {
        const d = snapshot.data();
        onProfile({
          uid: String(d.uid ?? user.uid),
          displayName: String(d.displayName ?? user.displayName ?? ''),
          email: String(d.email ?? user.email ?? ''),
          targetExam: String(d.targetExam ?? '৪৭তম বিসিএস ও ব্যাংক প্রস্তুতি'),
          driveSyncEnabled:
            typeof d.driveSyncEnabled === 'boolean' ? d.driveSyncEnabled : true,
        });
        return;
      }

      if (
        !shouldCreatePrivateProfile({
          exists: snapshot.exists(),
          fromCache: snapshot.metadata.fromCache,
          emailVerified: user.emailVerified,
          email: user.email,
          createAttempted,
        })
      ) {
        return;
      }

      createAttempted = true;
      const sanitized = sanitizeUserPrivateProfileFields({
        uid: user.uid,
        displayName: user.displayName,
        email: user.email,
        targetExam: '৪৭তম বিসিএস ও ব্যাংক প্রস্তুতি',
        driveSyncEnabled: true,
      });

      void setDoc(profileRef, {
        ...sanitized,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch((err) => {
        try {
          handleFirestoreError(err, OperationType.CREATE, profilePath);
        } catch (wrapped) {
          if (onError && wrapped instanceof Error) onError(wrapped);
        }
      });
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.GET, profilePath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

export async function saveUserDriveSyncPreference(
  user: User,
  driveSyncEnabled: boolean
): Promise<void> {
  if (!user.emailVerified || !user.email) return;
  const profilePath = getPrivateProfilePath(user.uid);
  const profileRef = doc(db, 'users', user.uid, 'private', 'profile');

  try {
    await updateDoc(profileRef, {
      driveSyncEnabled: Boolean(driveSyncEnabled),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, profilePath);
  }
}
