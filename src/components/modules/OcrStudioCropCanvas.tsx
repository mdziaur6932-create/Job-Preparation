'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crop,
  FileText,
  ImagePlus,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import {
  type NormalizedCropRect,
  buildFigureMarkdownSnippet,
  computePixelCropBox,
  normalizeCropRect,
} from '@/src/lib/ocr-studio-utils';
import { toBengaliNumber } from '@/src/lib/file-validation';

interface OcrStudioCropCanvasProps {
  file: File | null;
  fileKind: 'image' | 'pdf' | null;
  fileObjectUrl: string | null;
  pdfPageNumber: number;
  pdfTotalPages: number;
  onChangePdfPage: (page: number) => void;
  onPdfPageCountDetected: (totalPages: number) => void;
  onInsertCroppedFigure: (figureMarkdown: string) => void;
  onStatusNotice?: (tone: 'info' | 'success' | 'error', text: string) => void;
}

export function OcrStudioCropCanvas({
  file,
  fileKind,
  fileObjectUrl,
  pdfPageNumber,
  pdfTotalPages,
  onChangePdfPage,
  onPdfPageCountDetected,
  onInsertCroppedFigure,
  onStatusNotice,
}: OcrStudioCropCanvasProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const sourceKey = file
    ? `${file.name}:${file.size}:${file.lastModified}:${pdfPageNumber}`
    : 'empty';

  const [pdfRenderResult, setPdfRenderResult] = useState<{
    key: string;
    imageUrl: string | null;
    failed: boolean;
  }>({ key: '', imageUrl: null, failed: false });

  const [cropState, setCropState] = useState<{
    key: string;
    rect: NormalizedCropRect | null;
  }>({ key: '', rect: null });
  const [dragState, setDragState] = useState<{
    key: string;
    origin: { x: number; y: number } | null;
  }>({ key: '', origin: null });
  const [figureCaption, setFigureCaption] = useState('প্রশ্নের চিত্র');
  const [copiedFigure, setCopiedFigure] = useState(false);

  const cropRect = cropState.key === sourceKey ? cropState.rect : null;
  const dragOrigin = dragState.key === sourceKey ? dragState.origin : null;

  const isPdfActive = Boolean(file && fileKind === 'pdf');
  const renderingPdfPage = isPdfActive && pdfRenderResult.key !== sourceKey;
  const renderedPdfImageUrl =
    isPdfActive && pdfRenderResult.key === sourceKey
      ? pdfRenderResult.imageUrl
      : null;
  const pdfRenderFailed =
    isPdfActive && pdfRenderResult.key === sourceKey
      ? pdfRenderResult.failed
      : false;

  // Render selected PDF page onto a high-DPI canvas image so diagrams can be cropped with the mouse
  useEffect(() => {
    if (!file || fileKind !== 'pdf') {
      return;
    }
    let cancelled = false;

    const renderPage = async () => {
      try {
        const rawBytes = new Uint8Array(await file.arrayBuffer());
        const { getDocumentProxy } = await import('unpdf');
        const proxy = await getDocumentProxy(rawBytes);
        const destroyProxy = async () => {
          const maybe = proxy as unknown as {
            destroy?: () => Promise<void>;
            cleanup?: () => Promise<void>;
          };
          if (typeof maybe.destroy === 'function') {
            await maybe.destroy();
          } else if (typeof maybe.cleanup === 'function') {
            await maybe.cleanup();
          }
        };
        if (cancelled) {
          await destroyProxy();
          return;
        }
        const total = Math.max(1, proxy.numPages || 1);
        onPdfPageCountDetected(total);

        const safePage = Math.max(1, Math.min(total, pdfPageNumber));
        const page = await proxy.getPage(safePage);
        const viewport = page.getViewport({ scale: 1.8 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas context unavailable');
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // unpdf's proxy page exposes pdf.js render()
        const renderTask = (
          page as unknown as {
            render: (params: {
              canvasContext: CanvasRenderingContext2D;
              viewport: unknown;
            }) => { promise: Promise<void> };
          }
        ).render({
          canvasContext: ctx,
          viewport,
        });
        await renderTask.promise;

        if (!cancelled) {
          setPdfRenderResult({
            key: sourceKey,
            imageUrl: canvas.toDataURL('image/png'),
            failed: false,
          });
        }
        await destroyProxy();
      } catch {
        if (!cancelled) {
          setPdfRenderResult({
            key: sourceKey,
            imageUrl: null,
            failed: true,
          });
        }
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
    };
  }, [file, fileKind, pdfPageNumber, sourceKey, onPdfPageCountDetected]);

  const activeImageSrc =
    fileKind === 'image'
      ? fileObjectUrl
      : fileKind === 'pdf'
        ? renderedPdfImageUrl
        : null;

  const getRelativePointer = (
    e: React.PointerEvent<HTMLDivElement>
  ): { x: number; y: number } | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeImageSrc) return;
    const pos = getRelativePointer(e);
    if (!pos) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragState({ key: sourceKey, origin: pos });
    setCropState({ key: sourceKey, rect: null });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragOrigin) return;
    const pos = getRelativePointer(e);
    if (!pos) return;
    const next = normalizeCropRect(dragOrigin.x, dragOrigin.y, pos.x, pos.y);
    setCropState({ key: sourceKey, rect: next });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragOrigin) return;
    const pos = getRelativePointer(e);
    if (pos) {
      const finalRect = normalizeCropRect(
        dragOrigin.x,
        dragOrigin.y,
        pos.x,
        pos.y
      );
      setCropState({ key: sourceKey, rect: finalRect });
    }
    setDragState({ key: sourceKey, origin: null });
  };

  const buildCroppedFigureMarkdown = (): string | null => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      onStatusNotice?.(
        'error',
        'ছবিটি এখনো লোড হয়নি। অনুগ্রহ করে একটু অপেক্ষা করুন।'
      );
      return null;
    }

    const box = computePixelCropBox(
      cropRect,
      img.naturalWidth,
      img.naturalHeight,
      440
    );
    if (!box) {
      onStatusNotice?.('error', 'সঠিক ক্রপ এরিয়া নির্বাচন করা যায়নি।');
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = box.destWidth;
    canvas.height = box.destHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      img,
      box.sx,
      box.sy,
      box.sw,
      box.sh,
      0,
      0,
      box.destWidth,
      box.destHeight
    );

    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    return buildFigureMarkdownSnippet(dataUrl, figureCaption);
  };

  const handleInsertCrop = () => {
    try {
      const md = buildCroppedFigureMarkdown();
      if (!md) return;
      onInsertCroppedFigure(md);
      onStatusNotice?.(
        'success',
        cropRect
          ? 'ক্রপ করা চিত্রটি এডিটরে যুক্ত হয়েছে — নিচে লাইভ A4 প্রিভিউয়ে দেখুন!'
          : 'সম্পূর্ণ ছবিটি এডিটরে যুক্ত হয়েছে — নিচে লাইভ A4 প্রিভিউয়ে দেখুন!'
      );
    } catch (err) {
      onStatusNotice?.(
        'error',
        err instanceof Error ? err.message : 'ছবি ক্রপ করতে সমস্যা হয়েছে।'
      );
    }
  };

  const handleCopyCropOnly = async () => {
    try {
      const md = buildCroppedFigureMarkdown();
      if (!md) return;
      await navigator.clipboard.writeText(md);
      setCopiedFigure(true);
      setTimeout(() => setCopiedFigure(false), 1800);
      onStatusNotice?.(
        'success',
        'ক্রপ করা ছবির কোড কপি হয়েছে! এখন Smart Reader-এ মূল প্রশ্নের Edit চালু করে Paste (Ctrl+V) করলেই ছবিটি বসে যাবে।'
      );
    } catch {
      onStatusNotice?.(
        'error',
        'ক্লিপবোর্ডে কপি করা যায়নি। অনুগ্রহ করে "এডিটরে বসান" বাটন ব্যবহার করুন।'
      );
    }
  };

  return (
    <div
      data-testid="ocr-studio-crop-pane"
      className="flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden"
    >
      {/* Pane Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3.5 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Crop className="h-4 w-4 text-blue-700 shrink-0" />
          <span className="text-xs font-bold text-slate-900 truncate">
            {file ? file.name : 'মূল ফটো / স্ক্রিনশট / PDF প্রিভিউ ও ছবি ক্রপ'}
          </span>
        </div>

        {fileKind === 'pdf' && pdfTotalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={pdfPageNumber <= 1}
              onClick={() => onChangePdfPage(Math.max(1, pdfPageNumber - 1))}
              className="rounded border border-slate-300 bg-white p-1 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              aria-label="আগের PDF পৃষ্ঠা"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-[11px] font-mono font-semibold text-slate-700 px-1">
              পৃষ্ঠা {toBengaliNumber(pdfPageNumber)} / {toBengaliNumber(pdfTotalPages)}
            </span>
            <button
              type="button"
              disabled={pdfPageNumber >= pdfTotalPages}
              onClick={() =>
                onChangePdfPage(Math.min(pdfTotalPages, pdfPageNumber + 1))
              }
              className="rounded border border-slate-300 bg-white p-1 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              aria-label="পরের PDF পৃষ্ঠা"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Interactive Image / PDF Canvas */}
      <div className="relative flex min-h-[340px] max-h-[540px] flex-1 items-center justify-center overflow-auto bg-slate-100 p-3">
        {!file ? (
          <div className="max-w-xs text-center space-y-2 py-8">
            <FileText className="mx-auto h-8 w-8 text-slate-400" />
            <p className="text-xs font-semibold text-slate-700">
              উপরে ফটো, স্ক্রিনশট বা PDF আপলোড করুন (অথবা সরাসরি Ctrl+V পেস্ট করুন)
            </p>
            <p className="text-[11px] leading-relaxed text-slate-500">
              যেকোনো ত্রিভুজ, ঘনক বা জ্যামিতির ছবির ওপর মাউস দিয়ে টেনে সিলেক্ট করে এক ক্লিকে ক্রপ করে মূল প্রশ্নে বসাতে পারবেন।
            </p>
          </div>
        ) : renderingPdfPage ? (
          <div className="flex flex-col items-center gap-2 py-10 text-xs text-slate-600">
            <Loader2 className="h-6 w-6 animate-spin text-blue-700" />
            <span>PDF পৃষ্ঠাটি ক্রপ করার জন্য প্রস্তুত হচ্ছে...</span>
          </div>
        ) : activeImageSrc ? (
          <div
            ref={stageRef}
            data-testid="ocr-studio-crop-stage"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="relative inline-block max-w-full select-none cursor-crosshair touch-none shadow-sm border border-slate-300 bg-white"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={activeImageSrc}
              alt="OCR উৎস ছবি"
              draggable={false}
              className="block max-h-[480px] max-w-full object-contain pointer-events-none"
            />
            {cropRect && (
              <div
                data-testid="ocr-studio-crop-selection"
                style={{
                  left: `${cropRect.x * 100}%`,
                  top: `${cropRect.y * 100}%`,
                  width: `${cropRect.width * 100}%`,
                  height: `${cropRect.height * 100}%`,
                }}
                className="pointer-events-none absolute border-2 border-blue-600 bg-blue-500/15 shadow-[0_0_0_9999px_rgba(15,23,42,0.32)]"
              />
            )}
          </div>
        ) : pdfRenderFailed && fileObjectUrl ? (
          <iframe
            title="PDF প্রিভিউ"
            src={`${fileObjectUrl}#page=${pdfPageNumber}`}
            className="h-[460px] w-full rounded border border-slate-300 bg-white"
          />
        ) : null}
      </div>

      {/* Crop Action Bar */}
      {activeImageSrc && (
        <div className="border-t border-slate-200 bg-slate-50 px-3.5 py-2.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
            <span>
              {cropRect
                ? 'ছবির নির্বাচিত অংশ ক্রপের জন্য প্রস্তুত।'
                : 'মাউস দিয়ে শুধু ত্রিভুজ/ঘনক/ডায়াগ্রামের অংশটুকু টেনে সিলেক্ট করুন (না করলে পুরো ছবিটি নেবে)।'}
            </span>
            {cropRect && (
              <button
                type="button"
                onClick={() => setCropState({ key: sourceKey, rect: null })}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600 hover:text-slate-900"
              >
                <RotateCcw className="h-3 w-3" />
                <span>সিলেকশন মুছুন</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={figureCaption}
              onChange={(e) => setFigureCaption(e.target.value)}
              placeholder="ছবির নাম (যেমন: ৯৪ নং ত্রিভুজের চিত্র)"
              aria-label="ক্রপ করা ছবির শিরোনাম"
              className="min-w-[160px] flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
            />
            <button
              type="button"
              data-testid="ocr-studio-btn-insert-crop"
              onClick={handleInsertCrop}
              className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              <span>{cropRect ? 'ক্রপ করে এডিটরে বসান' : 'ছবি এডিটরে বসান'}</span>
            </button>
            <button
              type="button"
              data-testid="ocr-studio-btn-copy-crop"
              onClick={() => void handleCopyCropOnly()}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 transition-colors"
            >
              {copiedFigure ? (
                <Check className="h-3.5 w-3.5 text-emerald-700" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>
                {copiedFigure ? 'ছবির কোড কপি হয়েছে' : 'শুধু ছবির কোড কপি'}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
