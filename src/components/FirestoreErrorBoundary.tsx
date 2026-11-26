'use client';

import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class FirestoreErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    const raw = error?.message || '';
    if (raw.includes('Quota exceeded')) {
      return {
        hasError: true,
        message:
          'Firebase Firestore-এর দৈনিক ফ্রি কোটা শেষ হয়ে গেছে। আগামীকাল কোটা পুনরায় রিসেট হবে।',
      };
    }
    return {
      hasError: true,
      message:
        'অ্যাপ্লিকেশনে অপ্রত্যাশিত ত্রুটি দেখা দিয়েছে। অনুগ্রহ করে পৃষ্ঠাটি পুনরায় লোড করুন।',
    };
  }

  componentDidCatch(error: Error) {
    console.error('FirestoreErrorBoundary caught error:', error.message);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
          <div className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-red-50 text-red-700">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <h1 className="mt-4 text-base font-bold text-slate-900">
              সার্ভিস সংযোগে সাময়িক সমস্যা
            </h1>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>পুনরায় চেষ্টা করুন</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
