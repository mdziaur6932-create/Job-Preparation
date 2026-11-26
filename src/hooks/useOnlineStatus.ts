'use client';

import { useSyncExternalStore } from 'react';

function subscribeOnlineStatus(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function getOnlineSnapshot(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

function getServerOnlineSnapshot(): boolean {
  return true;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeOnlineStatus,
    getOnlineSnapshot,
    getServerOnlineSnapshot
  );
}
