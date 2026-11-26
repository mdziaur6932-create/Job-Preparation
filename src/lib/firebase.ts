'use client';

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { GOOGLE_DRIVE_SCOPES } from './google-drive';

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

function createFirestoreClient(): Firestore {
  // experimentalForceLongPolling is browser-only; on SSR use standard getFirestore
  if (typeof window === 'undefined') {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }

  try {
    // Force long-polling + memoryLocalCache avoids:
    // 1) 10-second WebChannel streaming timeouts behind buffering proxies / firewalls / iframes
    // 2) Cross-origin iframe & multi-tab IndexedDB lease deadlocks from persistentMultipleTabManager
    // (App-level offline storage is already persisted reliably via prostuti_ai_offline_vault_v1 IndexedDB + sw.js)
    return initializeFirestore(
      app,
      {
        experimentalForceLongPolling: true,
        experimentalLongPollingOptions: { timeoutSeconds: 20 },
        localCache: memoryLocalCache(),
      },
      firebaseConfig.firestoreDatabaseId
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
}

export const db = createFirestoreClient();
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();
for (const scope of GOOGLE_DRIVE_SCOPES) {
  googleAuthProvider.addScope(scope);
}
googleAuthProvider.setCustomParameters({ prompt: 'select_account' });
export { GOOGLE_DRIVE_SCOPES };

async function testConnection(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
      return;
    } catch (error) {
      const isOfflineError =
        error instanceof Error &&
        error.message.includes('the client is offline');
      if (!isOfflineError) {
        // Server responded (e.g. permission-denied on /test/connection) — backend is reachable!
        return;
      }
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      console.error('Please check your Firebase configuration.');
    }
  }
}

if (typeof window !== 'undefined') {
  void testConnection();
}
