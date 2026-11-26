'use client';

import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '@/src/hooks/usePWAInstall';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        data-testid="pwa-install-btn"
        onClick={() => void install()}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0"
      >
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span>অ্যাপ ইনস্টল</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          data-testid="pwa-ios-install-btn"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
        >
          <Smartphone className="h-3.5 w-3.5 shrink-0" />
          <span>হোম স্ক্রিনে যুক্ত করুন</span>
        </button>

        {showIOSGuide && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-pwa-guide-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          >
            <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
              <div className="flex items-start justify-between gap-2">
                <h3
                  id="ios-pwa-guide-title"
                  className="text-base font-bold text-slate-900"
                >
                  iPhone / iPad-এ ইনস্টল করুন
                </h3>
                <button
                  type="button"
                  aria-label="বন্ধ করুন"
                  onClick={() => setShowIOSGuide(false)}
                  className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                ১. Safari টুলবারের নিচে <strong>Share</strong> বাটনে ট্যাপ করুন।
                <br />
                ২. নিচে স্ক্রল করে <strong>Add to Home Screen</strong> নির্বাচন করুন।
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-lg bg-slate-900 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors"
              >
                বুঝেছি
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}
