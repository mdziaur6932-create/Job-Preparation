'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignJustify,
  Table2,
  ImagePlus,
  Undo2,
  Redo2,
  Search,
  Replace,
  FileUp,
  Save,
  RotateCcw,
  Loader2,
  X,
  Eye,
  Minus,
  Plus,
  ChevronLeft,
  ChevronRight,
  Eraser,
} from 'lucide-react';

interface SmartReaderOcrEditorProps {
  value: string;
  hasUnsavedChanges: boolean;
  saving: boolean;
  defaultPdfPage?: number;
  justifyText: boolean;
  fontSizeScale: number;
  onChange: (nextValue: string) => void;
  onToggleJustify: (justify: boolean) => void;
  onChangeFontSizeScale: (nextScale: number) => void;
  onSave: () => Promise<void> | void;
  onDiscard: () => void;
  onClose: () => void;
}

const DEFAULT_TABLE_TEMPLATE =
  '\n| কলাম ১ | কলাম ২ | কলাম ৩ |\n| --- | --- | --- |\n| তথ্য ১ | তথ্য ২ | তথ্য ৩ |\n| তথ্য ৪ | তথ্য ৫ | তথ্য ৬ |\n';

export function SmartReaderOcrEditor({
  value,
  hasUnsavedChanges,
  saving,
  defaultPdfPage = 1,
  justifyText,
  fontSizeScale,
  onChange,
  onToggleJustify,
  onChangeFontSizeScale,
  onSave,
  onDiscard,
  onClose,
}: SmartReaderOcrEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const figureInputRef = useRef<HTMLInputElement | null>(null);

  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);

  // Find & Replace bar state
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [replaceFeedback, setReplaceFeedback] = useState<string | null>(null);

  // Side-by-side Original PDF / Image Reference Viewer state
  const [showSourcePane, setShowSourcePane] = useState(true);
  const [sourceFileUrl, setSourceFileUrl] = useState<string | null>(null);
  const [sourceFileName, setSourceFileName] = useState<string>('');
  const [sourceFileKind, setSourceFileKind] = useState<'pdf' | 'image' | null>(null);
  const [sourcePdfPage, setSourcePdfPage] = useState<number>(
    Math.max(1, defaultPdfPage)
  );

  // Cleanup browser blob URL on unmount or file change
  useEffect(() => {
    return () => {
      if (sourceFileUrl) {
        URL.revokeObjectURL(sourceFileUrl);
      }
    };
  }, [sourceFileUrl]);

  const commitChange = (nextText: string, selectionStart?: number, selectionEnd?: number) => {
    setUndoStack((prev) => [...prev.slice(-39), value]);
    setRedoStack([]);
    onChange(nextText);

    if (typeof selectionStart === 'number') {
      window.requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(
          selectionStart,
          typeof selectionEnd === 'number' ? selectionEnd : selectionStart
        );
      });
    }
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev.slice(-39), value]);
    onChange(previous);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev.slice(-39), value]);
    onChange(next);
  };

  const wrapSelection = (prefix: string, suffix: string, placeholder: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const inner = selected || placeholder;

    // Toggle off if already wrapped identically
    if (
      selected &&
      value.slice(Math.max(0, start - prefix.length), start) === prefix &&
      value.slice(end, end + suffix.length) === suffix
    ) {
      const unwrapped =
        value.slice(0, start - prefix.length) +
        selected +
        value.slice(end + suffix.length);
      commitChange(
        unwrapped,
        start - prefix.length,
        end - prefix.length
      );
      return;
    }

    const nextText =
      value.slice(0, start) + prefix + inner + suffix + value.slice(end);
    commitChange(
      nextText,
      start + prefix.length,
      start + prefix.length + inner.length
    );
  };

  const handleClearFormatting = () => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start === end) return;
    const selected = value.slice(start, end);
    const stripped = selected
      .replace(/<\/?(?:u|b|strong|i|em)>/gi, '')
      .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '$1')
      .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
      .replace(/\*([^\s*][^*]*?)\*/g, '$1');
    const nextText = value.slice(0, start) + stripped + value.slice(end);
    commitChange(nextText, start, start + stripped.length);
  };

  const insertAtCursor = (snippet: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const nextText = value.slice(0, start) + snippet + value.slice(end);
    commitChange(nextText, start + snippet.length, start + snippet.length);
  };

  /**
   * Wraps the selected lines (or current line) in `<center>...</center>` so exam headers
   * or section headings render centered in full 1-column width above 2-column questions.
   */
  const handleToggleCenterBlock = () => {
    const el = textareaRef.current;
    const rawStart = el?.selectionStart ?? 0;
    const rawEnd = el?.selectionEnd ?? 0;

    // Expand selection to whole lines if user placed cursor without dragging
    const lineStart = value.lastIndexOf('\n', Math.max(0, rawStart - 1)) + 1;
    const nextNl = value.indexOf('\n', rawEnd);
    const lineEnd = nextNl === -1 ? value.length : nextNl;

    const start = rawStart === rawEnd ? lineStart : rawStart;
    const end = rawStart === rawEnd ? lineEnd : rawEnd;
    const selected = value.slice(start, end).trim();

    if (!selected) {
      const placeholder = '<center>\nপরীক্ষার শিরোনাম\nপদের নাম: ...\n</center>\n';
      insertAtCursor(placeholder);
      return;
    }

    // Toggle off if already wrapped in <center>...</center>
    if (/^<center>[\s\S]*<\/center>$/i.test(selected)) {
      const unwrapped = selected
        .replace(/^<center>\s*/i, '')
        .replace(/\s*<\/center>$/i, '')
        .trim();
      const nextText = value.slice(0, start) + unwrapped + value.slice(end);
      commitChange(nextText, start, start + unwrapped.length);
      return;
    }

    const wrapped = `<center>\n${selected}\n</center>`;
    const prefix = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
    const suffix = end < value.length && value[end] !== '\n' ? '\n' : '';
    const nextText = value.slice(0, start) + prefix + wrapped + suffix + value.slice(end);
    const newSelStart = start + prefix.length;
    commitChange(nextText, newSelStart, newSelStart + wrapped.length);
  };

  const handleInsertFigureImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = () => {
      const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!rawDataUrl) return;
      const img = new window.Image();
      img.onload = () => {
        const maxWidth = 420;
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const targetW = Math.max(1, Math.round(img.width * scale));
        const targetH = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, targetW, targetH);
          ctx.drawImage(img, 0, 0, targetW, targetH);
          const compressed = canvas.toDataURL('image/jpeg', 0.84);
          insertAtCursor(`\n![প্রশ্নের চিত্র](${compressed})\n`);
        } else {
          insertAtCursor(`\n![প্রশ্নের চিত্র](${rawDataUrl})\n`);
        }
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleReplaceAll = () => {
    if (!findQuery) return;
    const parts = value.split(findQuery);
    const hitCount = parts.length - 1;
    if (hitCount <= 0) {
      setReplaceFeedback(`"${findQuery}" পাওয়া যায়নি।`);
      return;
    }
    const nextText = parts.join(replaceQuery);
    commitChange(nextText);
    setReplaceFeedback(`${hitCount}টি জায়গায় পরিবর্তন করা হয়েছে।`);
  };

  const handleReplaceNext = () => {
    if (!findQuery) return;
    const el = textareaRef.current;
    const fromIdx = el ? el.selectionEnd : 0;
    let matchIdx = value.indexOf(findQuery, fromIdx);
    if (matchIdx === -1) {
      matchIdx = value.indexOf(findQuery, 0);
    }
    if (matchIdx === -1) {
      setReplaceFeedback(`"${findQuery}" পাওয়া যায়নি।`);
      return;
    }
    const nextText =
      value.slice(0, matchIdx) +
      replaceQuery +
      value.slice(matchIdx + findQuery.length);
    commitChange(nextText, matchIdx, matchIdx + replaceQuery.length);
    setReplaceFeedback('১টি জায়গায় পরিবর্তন হয়েছে।');
  };

  const handleLoadSourceFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (sourceFileUrl) {
      URL.revokeObjectURL(sourceFileUrl);
    }
    const nextUrl = URL.createObjectURL(file);
    const isImage = file.type.startsWith('image/');
    setSourceFileUrl(nextUrl);
    setSourceFileName(file.name);
    setSourceFileKind(isImage ? 'image' : 'pdf');
    setSourcePdfPage(Math.max(1, defaultPdfPage));
    setShowSourcePane(true);
    e.target.value = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'b') {
      e.preventDefault();
      wrapSelection('**', '**', 'বোল্ড লেখা');
    } else if (key === 'i') {
      e.preventDefault();
      wrapSelection('*', '*', 'ইটালিক লেখা');
    } else if (key === 'u') {
      e.preventDefault();
      wrapSelection('<u>', '</u>', 'আন্ডারলাইন শব্দ');
    } else if (key === 'z' && !e.shiftKey) {
      if (undoStack.length > 0) {
        e.preventDefault();
        handleUndo();
      }
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      if (redoStack.length > 0) {
        e.preventDefault();
        handleRedo();
      }
    }
  };

  const lineCount = value ? value.split('\n').length : 0;
  const wordCount = value ? value.trim().split(/\s+/).filter(Boolean).length : 0;

  return (
    <section
      data-testid="smart-reader-ocr-editor"
      aria-label="OCR প্রুফরিড ও Microsoft Word এডিটর"
      className="mt-4 rounded-xl border border-blue-200 bg-white shadow-sm overflow-hidden print:hidden"
    >
      {/* Top Title & Save Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-900 px-3.5 py-2.5 text-white">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold tracking-tight">
            OCR প্রুফরিড ও Word এডিটর
          </span>
          <span className="text-[11px] text-slate-300 font-mono tabular-nums">
            · {lineCount} লাইন · {wordCount} শব্দ
          </span>
          {hasUnsavedChanges && (
            <span
              data-testid="editor-unsaved-indicator"
              className="rounded bg-amber-400/20 border border-amber-300/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200"
            >
              অসংরক্ষিত পরিবর্তন আছে
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="editor-btn-toggle-source-pane"
            onClick={() => setShowSourcePane((prev) => !prev)}
            className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
              showSourcePane
                ? 'border-blue-400 bg-blue-600 text-white'
                : 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700'
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>{showSourcePane ? 'মূল PDF প্যানেল লুকান' : 'মূল PDF পাশে দেখুন'}</span>
          </button>

          {hasUnsavedChanges && (
            <button
              type="button"
              data-testid="editor-btn-discard"
              disabled={saving}
              onClick={onDiscard}
              className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>বাতিল</span>
            </button>
          )}

          <button
            type="button"
            data-testid="editor-btn-save"
            disabled={saving || !hasUnsavedChanges}
            onClick={() => void onSave()}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-45 transition-colors whitespace-nowrap"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span>বইয়ে সেভ করুন</span>
          </button>

          <button
            type="button"
            data-testid="editor-btn-close"
            onClick={onClose}
            aria-label="এডিটর বন্ধ করুন"
            className="rounded-md p-1 text-slate-300 hover:bg-slate-700 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Microsoft Word–Style Basic Formatting Ribbon */}
      <div
        data-testid="word-editing-toolbar"
        className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2"
      >
        {/* History group */}
        <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            data-testid="word-btn-undo"
            title="Undo (Ctrl+Z)"
            disabled={undoStack.length === 0}
            onClick={handleUndo}
            className="rounded p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-35"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="word-btn-redo"
            title="Redo (Ctrl+Shift+Z)"
            disabled={redoStack.length === 0}
            onClick={handleRedo}
            className="rounded p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-35"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Bold / Italic / Underline / Clear Formatting */}
        <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            data-testid="word-btn-bold"
            title="Bold (Ctrl+B)"
            onClick={() => wrapSelection('**', '**', 'বোল্ড লেখা')}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-bold text-slate-800 hover:bg-blue-50 hover:text-blue-800"
          >
            <Bold className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Bold</span>
          </button>
          <button
            type="button"
            data-testid="word-btn-italic"
            title="Italic (Ctrl+I)"
            onClick={() => wrapSelection('*', '*', 'ইটালিক লেখা')}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold italic text-slate-800 hover:bg-blue-50 hover:text-blue-800"
          >
            <Italic className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Italic</span>
          </button>
          <button
            type="button"
            data-testid="word-btn-underline"
            title="Underline (Ctrl+U) — গ্রামার প্রশ্নের শব্দ আন্ডারলাইন করুন"
            onClick={() => wrapSelection('<u>', '</u>', 'আন্ডারলাইন শব্দ')}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold underline text-slate-800 hover:bg-blue-50 hover:text-blue-800"
          >
            <Underline className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Underline</span>
          </button>
          <button
            type="button"
            data-testid="word-btn-clear-format"
            title="সিলেক্টেড অংশের বোল্ড/ইটালিক/আন্ডারলাইন মুছুন"
            onClick={handleClearFormatting}
            className="rounded p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            <Eraser className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Alignment: Left / Center (1-Col Header) / Justify */}
        <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            data-testid="word-btn-align-left"
            title="Align Left"
            aria-pressed={!justifyText}
            onClick={() => onToggleJustify(false)}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold ${
              !justifyText
                ? 'bg-slate-900 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <AlignLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="word-btn-align-center"
            title="সিলেক্ট করা শিরোনাম/অংশ মাঝখানে (১-কলাম হেডার) করুন"
            onClick={handleToggleCenterBlock}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-indigo-800 hover:bg-indigo-50"
          >
            <AlignCenter className="h-3.5 w-3.5" />
            <span>মাঝখানে (১-কলাম)</span>
          </button>
          <button
            type="button"
            data-testid="word-btn-align-justify"
            title="Justify (সকল প্রশ্ন দুই পাশে সমান করুন)"
            aria-pressed={justifyText}
            onClick={() => onToggleJustify(true)}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold ${
              justifyText
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <AlignJustify className="h-3.5 w-3.5" />
            <span>Justify</span>
          </button>
        </div>

        {/* Font Zoom A- / A+ */}
        <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            data-testid="word-btn-font-dec"
            title="ফন্ট ছোট করুন"
            onClick={() =>
              onChangeFontSizeScale(Math.max(0.85, Number((fontSizeScale - 0.05).toFixed(2))))
            }
            className="rounded px-1.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            <Minus className="h-3 w-3" />
          </button>
          <span className="px-1.5 text-[11px] font-mono tabular-nums text-slate-700">
            {Math.round(fontSizeScale * 100)}%
          </span>
          <button
            type="button"
            data-testid="word-btn-font-inc"
            title="ফন্ট বড় করুন"
            onClick={() =>
              onChangeFontSizeScale(Math.min(1.2, Number((fontSizeScale + 0.05).toFixed(2))))
            }
            className="rounded px-1.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        {/* Insert Table / Diagram Image / Answer / Explanation */}
        <div className="inline-flex items-center gap-1">
          <input
            ref={figureInputRef}
            type="file"
            accept="image/*"
            onChange={handleInsertFigureImage}
            className="hidden"
          />
          <button
            type="button"
            data-testid="word-btn-insert-table"
            onClick={() => insertAtCursor(DEFAULT_TABLE_TEMPLATE)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-blue-50 hover:text-blue-800 whitespace-nowrap"
          >
            <Table2 className="h-3.5 w-3.5 text-blue-700" />
            <span>+ টেবিল</span>
          </button>
          <button
            type="button"
            data-testid="word-btn-insert-image"
            title="প্রশ্নের চিত্র/ডায়াগ্রাম (যেমন ঘনক বা জ্যামিতি ছবি) যুক্ত করুন"
            onClick={() => figureInputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 whitespace-nowrap"
          >
            <ImagePlus className="h-3.5 w-3.5 text-emerald-700" />
            <span>+ চিত্র</span>
          </button>
          <button
            type="button"
            data-testid="word-btn-insert-answer"
            onClick={() => insertAtCursor('\nউত্তর: ')}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-blue-800 hover:bg-blue-50 whitespace-nowrap"
          >
            + উত্তর:
          </button>
          <button
            type="button"
            data-testid="word-btn-insert-explanation"
            onClick={() => insertAtCursor('\nব্যাখ্যা: ')}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-rose-800 hover:bg-rose-50 whitespace-nowrap"
          >
            + ব্যাখ্যা:
          </button>
        </div>

        {/* Find & Replace Toggle */}
        <button
          type="button"
          data-testid="word-btn-find-replace"
          aria-expanded={showFindReplace}
          onClick={() => {
            setShowFindReplace((prev) => !prev);
            setReplaceFeedback(null);
          }}
          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
            showFindReplace
              ? 'border-blue-600 bg-blue-50 text-blue-800'
              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
          }`}
        >
          <Search className="h-3.5 w-3.5" />
          <span>খুঁজুন ও বদলান</span>
        </button>
      </div>

      {/* Collapsible Find & Replace Strip */}
      {showFindReplace && (
        <div
          data-testid="word-find-replace-bar"
          className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-blue-50/50 px-3 py-2"
        >
          <input
            type="text"
            data-testid="word-find-input"
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              setReplaceFeedback(null);
            }}
            placeholder="ভুল শব্দ খুঁজুন (যেমন: বরবর্ণ)"
            className="min-w-[160px] flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
          />
          <input
            type="text"
            data-testid="word-replace-input"
            value={replaceQuery}
            onChange={(e) => setReplaceQuery(e.target.value)}
            placeholder="সঠিক শব্দ লিখুন (যেমন: স্বরবর্ণ)"
            className="min-w-[160px] flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
          />
          <button
            type="button"
            data-testid="word-btn-replace-next"
            onClick={handleReplaceNext}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-100 whitespace-nowrap"
          >
            <Replace className="h-3 w-3" />
            <span>১টি বদলান</span>
          </button>
          <button
            type="button"
            data-testid="word-btn-replace-all"
            onClick={handleReplaceAll}
            className="inline-flex items-center gap-1 rounded-md bg-blue-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap"
          >
            <span>সব বদলান</span>
          </button>
          {replaceFeedback && (
            <span
              data-testid="word-replace-feedback"
              className="text-[11px] font-semibold text-blue-800"
            >
              {replaceFeedback}
            </span>
          )}
        </div>
      )}

      {/* Split Proofread Workspace: Side-by-Side Original PDF/Image + OCR Editor */}
      <div
        className={`grid grid-cols-1 ${
          showSourcePane ? 'lg:grid-cols-2' : ''
        } divide-y lg:divide-y-0 lg:divide-x divide-slate-200`}
      >
        {/* Left Pane: Original PDF / Book Photo Reference */}
        {showSourcePane && (
          <div
            data-testid="editor-original-pdf-pane"
            className="flex flex-col bg-slate-50/70 min-h-[380px] max-h-[560px]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="text-xs font-bold text-slate-800">
                  মূল PDF / বইয়ের পৃষ্ঠা (মিলিয়ে দেখুন)
                </span>
                {sourceFileName && (
                  <p className="truncate text-[11px] text-slate-500">
                    {sourceFileName}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                {sourceFileKind === 'pdf' && sourceFileUrl && (
                  <div className="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setSourcePdfPage((p) => Math.max(1, p - 1))}
                      className="p-0.5 text-slate-600 hover:text-slate-900"
                      aria-label="আগের পৃষ্ঠা"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="px-1.5 font-mono tabular-nums font-semibold text-slate-700">
                      পৃ. {sourcePdfPage}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSourcePdfPage((p) => p + 1)}
                      className="p-0.5 text-slate-600 hover:text-slate-900"
                      aria-label="পরের পৃষ্ঠা"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,image/*"
                  onChange={handleLoadSourceFile}
                  className="hidden"
                />
                <button
                  type="button"
                  data-testid="editor-btn-load-original-pdf"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800 hover:bg-blue-100 whitespace-nowrap"
                >
                  <FileUp className="h-3.5 w-3.5" />
                  <span>{sourceFileUrl ? 'অন্য ফাইল খুলুন' : 'মূল PDF / ছবি খুলুন'}</span>
                </button>
              </div>
            </div>

            {sourceFileUrl ? (
              sourceFileKind === 'image' ? (
                <div className="flex-1 overflow-auto p-3 flex items-start justify-center bg-slate-200/60">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sourceFileUrl}
                    alt="মূল বইয়ের পৃষ্ঠা"
                    className="max-w-full rounded border border-slate-300 bg-white shadow-xs"
                  />
                </div>
              ) : (
                <iframe
                  key={`${sourceFileUrl}-${sourcePdfPage}`}
                  src={`${sourceFileUrl}#page=${sourcePdfPage}`}
                  title="মূল PDF রেফারেন্স"
                  className="w-full flex-1 min-h-[360px] bg-slate-200"
                />
              )
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center p-6 text-center space-y-3">
                <div className="rounded-full bg-blue-50 p-3 text-blue-700 border border-blue-100">
                  <FileUp className="h-5 w-5" />
                </div>
                <div className="space-y-1 max-w-xs">
                  <p className="text-xs font-bold text-slate-800">
                    মূল PDF বা পৃষ্ঠার ছবি পাশে খুলে OCR মিলিয়ে ঠিক করুন
                  </p>
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    ফাইলটি শুধু আপনার ব্রাউজারেই দেখাবে (সার্ভারে আপলোড হবে না)। ডান পাশে ভুল বানান, টেবিল বা আন্ডারলাইন ঠিক করলেই নিচে লাইভ A4 পেজ আপডেট হবে।
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800"
                >
                  <FileUp className="h-3.5 w-3.5" />
                  <span>মূল PDF / ছবি সিলেক্ট করুন</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Right Pane: Editable OCR Textarea */}
        <div className="flex flex-col bg-white min-h-[380px] max-h-[560px]">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/70 px-3 py-1.5 text-[11px] text-slate-600">
            <span>
              টিপস: শব্দ সিলেক্ট করে <strong>Bold</strong>, <em>Italic</em> বা{' '}
              <u>Underline</u> ক্লিক করুন — নিচে লাইভ A4 পেজ সাথে সাথে আপডেট হবে।
            </span>
          </div>
          <textarea
            ref={textareaRef}
            data-testid="smart-reader-ocr-textarea"
            value={value}
            onChange={(e) => commitChange(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            className="w-full flex-1 resize-none p-3.5 font-mono text-[13px] leading-6 text-slate-900 focus:outline-none"
            placeholder="এখানে OCR করা প্রশ্ন, উত্তর, ব্যাখ্যা ও টেবিল সম্পাদনা করুন..."
          />
        </div>
      </div>
    </section>
  );
}
