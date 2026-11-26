'use client';

import React, { useMemo, useRef, useState } from 'react';
import {
  Camera,
  Flag,
  Loader2,
  Trash2,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { KatexMathText } from './KatexMathText';
import {
  formatStructuredWrittenAnswer,
  parseStructuredWrittenAnswer,
  parseWrittenQuestionStructure,
} from '@/src/lib/job-exam-paper';
import { toBengaliNumber } from '@/src/lib/file-validation';
import type { Question } from '@/src/types/system';

export interface HandwrittenPhotoItem {
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
  previewUrl: string;
}

interface LiveWrittenQuestionCardProps {
  question: Question;
  index: number;
  defaultMaxMarks: number;
  writtenText: string;
  onWrittenTextChange: (nextText: string) => void;
  attachedPhotos: HandwrittenPhotoItem[];
  onAttachPhotos: (files: FileList | null) => Promise<void>;
  onRemovePhoto: (photoIdx: number) => void;
  isMarkedForReview: boolean;
  onToggleReview: () => void;
}

export function LiveWrittenQuestionCard({
  question,
  index,
  defaultMaxMarks,
  writtenText,
  onWrittenTextChange,
  attachedPhotos,
  onAttachPhotos,
  onRemovePhoto,
  isMarkedForReview,
  onToggleReview,
}: LiveWrittenQuestionCardProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const parsedQ = useMemo(
    () => parseWrittenQuestionStructure(question.stem, defaultMaxMarks),
    [question.stem, defaultMaxMarks]
  );

  const parsedAns = useMemo(
    () =>
      parseStructuredWrittenAnswer(
        writtenText,
        parsedQ.subItems,
        parsedQ.isChoiceOne
      ),
    [writtenText, parsedQ.subItems, parsedQ.isChoiceOne]
  );

  const handleSelectChoice = (label: string) => {
    const next = formatStructuredWrittenAnswer(
      { ...parsedAns, selectedChoiceLabel: label },
      parsedQ.subItems,
      true
    );
    onWrittenTextChange(next);
  };

  const handleChoiceTextChange = (text: string) => {
    const next = formatStructuredWrittenAnswer(
      {
        ...parsedAns,
        selectedChoiceLabel:
          parsedAns.selectedChoiceLabel || parsedQ.subItems[0]?.label || '',
        freeText: text,
      },
      parsedQ.subItems,
      true
    );
    onWrittenTextChange(next);
  };

  const handleSubAnswerChange = (label: string, value: string) => {
    const next = formatStructuredWrittenAnswer(
      {
        ...parsedAns,
        subAnswers: {
          ...parsedAns.subAnswers,
          [label]: value,
        },
      },
      parsedQ.subItems,
      false
    );
    onWrittenTextChange(next);
  };

  const handleFileChange = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPhotoError(null);
    setUploadingPhoto(true);
    try {
      await onAttachPhotos(files);
    } catch (err) {
      setPhotoError(
        err instanceof Error ? err.message : 'হাতে লেখা খাতার ছবি যুক্ত করা যায়নি।'
      );
    } finally {
      setUploadingPhoto(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <article
      id={`exam-question-card-${question.id}`}
      data-testid={`live-written-card-${index + 1}`}
      className={`rounded-xl border bg-white p-5 transition-colors ${
        isMarkedForReview ? 'border-amber-400 ring-1 ring-amber-200' : 'border-slate-200'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono font-bold text-slate-900">
            প্রশ্ন {toBengaliNumber(index + 1)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900 border border-amber-200">
            {question.questionType}
          </span>
          <span>{question.chapter}</span>
        </div>

        <div className="flex items-center gap-2">
          <span
            data-testid={`written-marks-badge-${index + 1}`}
            className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono tabular-nums font-semibold text-slate-800"
          >
            নম্বর: {toBengaliNumber(parsedQ.marks)}
          </span>
          <button
            type="button"
            onClick={onToggleReview}
            aria-pressed={isMarkedForReview}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-colors ${
              isMarkedForReview
                ? 'border-amber-400 bg-amber-50 text-amber-900'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Flag className="h-3 w-3" />
            <span>{isMarkedForReview ? 'রিভিউ মার্ক করা' : 'রিভিউ মার্ক'}</span>
          </button>
        </div>
      </div>

      <h2 className="mt-2.5 text-base font-semibold text-slate-900 leading-relaxed whitespace-pre-wrap">
        <KatexMathText text={parsedQ.displayStem} />
      </h2>

      {/* Case A: OR-Choice Question (e.g. Paragraph / Essay — Answer any 1) */}
      {parsedQ.isChoiceOne && parsedQ.subItems.length >= 2 ? (
        <div
          data-testid={`written-or-choice-${index + 1}`}
          className="mt-4 space-y-3"
        >
          <div className="text-xs font-semibold text-amber-900">
            যেকোনো ১টি বিকল্প নির্বাচন করে নিচে উত্তর লিখুন:
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {parsedQ.subItems.map((sub) => {
              const active =
                (parsedAns.selectedChoiceLabel || parsedQ.subItems[0]?.label) ===
                sub.label;
              return (
                <button
                  key={sub.label}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`written-choice-opt-${index + 1}-${sub.label}`}
                  onClick={() => handleSelectChoice(sub.label)}
                  className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-left text-xs transition-colors ${
                    active
                      ? 'border-blue-700 bg-blue-50 font-semibold text-blue-950'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      active
                        ? 'border-blue-700 bg-blue-700 text-white'
                        : 'border-slate-300 bg-white'
                    }`}
                  >
                    {active && <CheckCircle2 className="h-3 w-3" />}
                  </span>
                  <span className="leading-snug">
                    <strong className="mr-1">{sub.label}.</strong>
                    <KatexMathText text={sub.prompt} />
                  </span>
                </button>
              );
            })}
          </div>

          <textarea
            id={`written-choice-textarea-${question.id}`}
            rows={5}
            value={parsedAns.freeText}
            onChange={(e) => handleChoiceTextChange(e.target.value)}
            placeholder={`নির্বাচিত বিকল্প (${parsedAns.selectedChoiceLabel || parsedQ.subItems[0]?.label}) এর বিস্তারিত উত্তর এখানে লিখুন...`}
            className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 leading-relaxed focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
          />
        </div>
      ) : parsedQ.subItems.length >= 2 ? (
        /* Case B: Sub-Question Set (ক, খ, গ, ঘ, ঙ...) — individual input per sub-question */
        <div
          data-testid={`written-subitems-${index + 1}`}
          className="mt-4 space-y-2.5"
        >
          <div className="text-xs font-medium text-slate-600">
            প্রতিটি উপ-প্রশ্নের উত্তর আলাদা ঘরে লিখুন (মোট {toBengaliNumber(parsedQ.subItems.length)}টি উপ-প্রশ্ন):
          </div>
          <div className="space-y-2">
            {parsedQ.subItems.map((sub) => (
              <div
                key={sub.label}
                className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 space-y-1.5"
              >
                <label
                  htmlFor={`written-sub-${question.id}-${sub.label}`}
                  className="block text-xs font-semibold text-slate-800"
                >
                  <span className="mr-1.5 font-mono text-blue-700">
                    {sub.label}.
                  </span>
                  <KatexMathText text={sub.prompt} />
                </label>
                <input
                  id={`written-sub-${question.id}-${sub.label}`}
                  data-testid={`written-sub-input-${index + 1}-${sub.label}`}
                  type="text"
                  value={parsedAns.subAnswers[sub.label] ?? ''}
                  onChange={(e) =>
                    handleSubAnswerChange(sub.label, e.target.value)
                  }
                  placeholder={`${sub.label}-এর উত্তর লিখুন...`}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Case C: Standard Written / Math Step-by-Step Textarea */
        <div className="mt-4">
          <label
            htmlFor={`written-answer-${question.id}`}
            className="block text-xs font-medium text-slate-600 mb-1.5"
          >
            আপনার লিখিত উত্তর (টাইপ করুন অথবা নিচে হাতে লেখা খাতার ছবি আপলোড করুন)
          </label>
          <textarea
            id={`written-answer-${question.id}`}
            rows={5}
            value={writtenText}
            onChange={(e) => onWrittenTextChange(e.target.value)}
            placeholder="মূল পয়েন্ট, ধাপে ধাপে অঙ্কের সমাধান বা প্রাসঙ্গিক তথ্যসহ আপনার উত্তর এখানে লিখুন..."
            className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 leading-relaxed focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
          />
        </div>
      )}

      {/* Handwritten Answer Sheet Photo Upload (AI Multimodal OCR + Grading) */}
      <div className="mt-3.5 rounded-lg border border-dashed border-slate-300 bg-slate-50/70 p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-slate-600">
            <strong className="text-slate-800">খাতায় লিখেছেন?</strong> অঙ্ক বা লিখিত খাতার ছবি আপলোড করলে AI ছবি পড়ে ধাপে ধাপে নম্বর দেবে (সর্বোচ্চ ২টি ছবি)।
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            multiple
            onChange={(e) => void handleFileChange(e.target.files)}
            className="sr-only"
          />
          <button
            type="button"
            data-testid={`handwritten-upload-btn-${index + 1}`}
            disabled={uploadingPhoto || attachedPhotos.length >= 2}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-blue-800 hover:bg-blue-50 disabled:opacity-50"
          >
            {uploadingPhoto ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>প্রস্তুত হচ্ছে...</span>
              </>
            ) : (
              <>
                <Camera className="h-3.5 w-3.5" />
                <span>
                  {attachedPhotos.length > 0
                    ? `খাতার ছবি যুক্ত আছে (${toBengaliNumber(attachedPhotos.length)}/২)`
                    : 'হাতে লেখা খাতার ছবি আপলোড'}
                </span>
              </>
            )}
          </button>
        </div>

        {photoError && (
          <div
            role="alert"
            className="flex items-center gap-1.5 text-[11px] font-medium text-red-700"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{photoError}</span>
          </div>
        )}

        {attachedPhotos.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {attachedPhotos.map((photo, pIdx) => (
              <div
                key={`${photo.fileName}-${pIdx}`}
                className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.previewUrl}
                  alt={photo.fileName}
                  className="h-8 w-8 rounded object-cover border border-slate-200"
                />
                <span className="max-w-[140px] truncate font-medium text-slate-800">
                  {photo.fileName}
                </span>
                <button
                  type="button"
                  onClick={() => onRemovePhoto(pIdx)}
                  aria-label={`${photo.fileName} ছবি মুছুন`}
                  className="text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
