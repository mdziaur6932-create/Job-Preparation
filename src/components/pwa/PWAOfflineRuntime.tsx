'use client';

import React, { useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import {
  registerOfflineServiceWorker,
  warmCurrentAppAssetsInSw,
} from '@/src/lib/offline-library-cache';

export function PWAOfflineRuntime() {
  const isOnline = useOnlineStatus();

  useEffect(() => {
    let cancelled = false;

    const initSw = async () => {
      const reg = await registerOfflineServiceWorker();
      if (cancelled || !reg) return;
      // Warm current HTML shell and loaded Next.js static bundles for immediate offline reload
      await warmCurrentAppAssetsInSw();
    };

    void initSw();
    return () => {
      cancelled = true;
    };
  }, []);

  if (isOnline) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-mode-indicator"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-600/30 bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white shadow-lg"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>
        অফলাইন মোড — সংরক্ষিত PDF লাইব্রেরি ও স্টাডি ম্যাটেরিয়াল ব্যবহার করা হচ্ছে
      </span>
    </div>
  );
}
