'use client';

import React, { useEffect, useMemo } from 'react';
import { Download, FileText, X } from 'lucide-react';
import { formatOfflineBytes } from '@/src/lib/offline-cache-policy';

interface OfflinePdfPreviewModalProps {
  bookTitle: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  onClose: () => void;
}

export function OfflinePdfPreviewModal({
  bookTitle,
  fileName,
  mimeType,
  blob,
  onClose,
}: OfflinePdfPreviewModalProps) {
  const objectUrl = useMemo(() => URL.createObjectURL(blob), [blob]);

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const isPdf =
    mimeType.toLowerCase().includes('pdf') ||
    fileName.toLowerCase().endsWith('.pdf');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="offline-pdf-preview-title"
      data-testid="offline-pdf-preview-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
    >
      <div className="flex h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
              <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="offline-pdf-preview-title"
                className="truncate text-sm font-bold text-slate-900"
              >
                {bookTitle}
              </h2>
              <p className="truncate text-xs text-slate-500">
                অফলাইন সংরক্ষিত ফাইল · {fileName} · {formatOfflineBytes(blob.size)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {objectUrl && (
              <a
                href={objectUrl}
                download={fileName}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                <span>ডাউনলোড করুন</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="প্রিভিউ বন্ধ করুন"
              className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 bg-slate-100">
          {objectUrl && isPdf ? (
            <iframe
              src={objectUrl}
              title={bookTitle}
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center">
              <FileText className="h-10 w-10 text-slate-400" />
              <p className="mt-3 text-sm font-semibold text-slate-800">
                এই ফাইলটি অফলাইনে সংরক্ষিত রয়েছে ({fileName})
              </p>
              <p className="mt-1 text-xs text-slate-500">
                ব্রাউজারে সরাসরি প্রিভিউর পরিবর্তে উপরের “ডাউনলোড করুন” বাটন থেকে ফাইলটি খুলুন।
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
