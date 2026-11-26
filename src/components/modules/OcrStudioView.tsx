'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  ArrowRight,
  Bold,
  Check,
  Columns2,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileDown,
  FileText,
  ImagePlus,
  Italic,
  Loader2,
  PenLine,
  Printer,
  Redo2,
  RemoveFormatting,
  ScanText,
  Search,
  Sparkles,
  Table2,
  Trash2,
  Underline,
  Undo2,
  Upload,
} from 'lucide-react';
import { useWorkspace } from '@/src/components/WorkspaceProvider';
import {
  FormattedReaderContent,
  type A4ReaderLayoutMode,
} from '@/src/components/modules/FormattedReaderContent';
import { OcrStudioCropCanvas } from '@/src/components/modules/OcrStudioCropCanvas';
import { slicePdfFileInBrowser } from '@/src/lib/client-pdf-accelerator';
import {
  buildSafeExportFilename,
  buildStructuredExamPdfBytes,
  triggerBrowserFileDownload,
} from '@/src/lib/exam-paper-exporter';
import { buildStructuredExamDocxBytes } from '@/src/lib/exam-word-exporter';
import { toBengaliNumber } from '@/src/lib/file-validation';
import {
  buildFigureMarkdownSnippet,
  buildOcrStudioExportUnit,
  computePixelCropBox,
  convertGeminiBox2dToNormalizedCropRect,
  insertBlockSnippetIntoText,
  mergeOcrStudioSections,
  replaceDiagramMarkersWithEmbeddedFigures,
  type DetectedOcrDiagram,
} from '@/src/lib/ocr-studio-utils';
import { formatAiResponseError } from '@/src/lib/ai-client';
import { prepareImageForPaperCuttingApi } from '@/src/lib/image-upload-utils';
import { parsePdfPageSubsetSyntax } from '@/src/lib/pdf-rules';
import { runChunkedPdfPipeline } from '@/src/lib/pdf-upload-client';

const OCR_STUDIO_STORAGE_KEY = 'prostuti_ai_ocr_studio_draft_v1';
const MAX_INLINE_PDF_JSON_BYTES = 4 * 1024 * 1024; // 4 MB -> fast JSON OCR; larger -> chunked pipeline

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

interface OcrStudioApiResponse {
  ok?: boolean;
  error?: string;
  code?: string;
  retryAfterSeconds?: number;
  text?: string;
  rawText?: string;
  diagrams?: DetectedOcrDiagram[];
  sections?: Array<{ chapter?: string; pageNumber?: number; content?: string }>;
}

async function autoCropDetectedDiagramsFromImage(
  imageUrl: string,
  diagrams: DetectedOcrDiagram[]
): Promise<Array<{ id: string; label: string; dataUrl: string }>> {
  if (!imageUrl || !Array.isArray(diagrams) || diagrams.length === 0) {
    return [];
  }

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new window.Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode source image for diagram crop'));
      el.src = imageUrl;
    });

    if (img.naturalWidth < 16 || img.naturalHeight < 16) {
      return [];
    }

    const cropped: Array<{ id: string; label: string; dataUrl: string }> = [];
    for (const diagram of diagrams) {
      const normalizedRect = convertGeminiBox2dToNormalizedCropRect(diagram.box_2d);
      if (!normalizedRect) continue;

      const box = computePixelCropBox(
        normalizedRect,
        img.naturalWidth,
        img.naturalHeight,
        440
      );
      if (!box) continue;

      const canvas = document.createElement('canvas');
      canvas.width = box.destWidth;
      canvas.height = box.destHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

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
      if (dataUrl.startsWith('data:image/')) {
        cropped.push({
          id: diagram.id,
          label: diagram.label || 'প্রশ্নের চিত্র',
          dataUrl,
        });
      }
    }

    return cropped;
  } catch {
    return [];
  }
}

function stripUnresolvedDiagramMarkers(text: string): string {
  return text.replace(
    /\[\[\s*DIAGRAM_[A-Za-z0-9_-]+\s*\]\]/gi,
    '[চিত্র: বাম পাশ থেকে ক্রপ করে বসান]'
  );
}

function parseOcrStudioResponseText(
  status: number,
  rawText: string
): { ok: boolean; payload: OcrStudioApiResponse | null; errorMessage?: string } {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as OcrStudioApiResponse;
      return { ok: status >= 200 && status < 300, payload: parsed };
    } catch {
      // Fall through to status-based Bengali message
    }
  }

  if (status === 413) {
    return {
      ok: false,
      payload: null,
      errorMessage:
        'ছবি বা PDF ফাইলটি আকারে বেশি বড়। অনুগ্রহ করে কম পৃষ্ঠার রেঞ্জ দিন অথবা আরেকটু ছোট স্ক্রিনশট আপলোড করুন।',
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      ok: false,
      payload: null,
      errorMessage:
        'সার্ভার থেকে OCR উত্তর আসতে সময় বেশি লেগেছে (Timeout)। অনুগ্রহ করে আরেকবার "AI দিয়ে OCR করুন" বাটনে ক্লিক করুন।',
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      payload: null,
      errorMessage:
        'আপনার সেশনের মেয়াদ শেষ হয়েছে। অনুগ্রহ করে পুনরায় Google সাইন-ইন করে চেষ্টা করুন।',
    };
  }
  return {
    ok: false,
    payload: null,
    errorMessage:
      'OCR সার্ভার থেকে সঠিক ডেটা পাওয়া যায়নি। অনুগ্রহ করে পেজটি রিলোড করে আবার চেষ্টা করুন।',
  };
}

export function OcrStudioView() {
  const { getAiAuthHeaders, requestAiSignIn, setActiveModule } = useWorkspace();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const figureUploadRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Uploaded source file state (Photo / Screenshot / PDF)
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<'image' | 'pdf' | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [pdfTotalPages, setPdfTotalPages] = useState(1);
  const [pdfPageRangeInput, setPdfPageRangeInput] = useState('');
  const [ocrInsertMode, setOcrInsertMode] = useState<'replace' | 'append'>(
    'replace'
  );

  // OCR execution & status
  const [ocrRunning, setOcrRunning] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'info' | 'success' | 'error';
    text: string;
  } | null>(null);

  // Editable document state + Word toolbar undo/redo
  const [docTitle, setDocTitle] = useState('OCR Studio প্রশ্নপত্র');
  const [content, setContent] = useState('');
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [showEditorWorkspace, setShowEditorWorkspace] = useState(true);

  // Find & Replace state
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceValue, setReplaceValue] = useState('');
  const [replaceFeedback, setReplaceFeedback] = useState<string | null>(null);

  // Smart Reader-grade A4 layout & export controls
  const [a4LayoutMode, setA4LayoutMode] = useState<A4ReaderLayoutMode>('double');
  const [justifyText, setJustifyText] = useState(true);
  const [hideAnswers, setHideAnswers] = useState(false);
  const [fontSizeScale, setFontSizeScale] = useState<number>(1);
  const [a4PageCount, setA4PageCount] = useState(1);
  const [copiedAll, setCopiedAll] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadingDocx, setDownloadingDocx] = useState(false);

  const draftHydratedRef = useRef(false);

  // Restore last draft safely after mount (avoids SSR hydration mismatch & cascading renders)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(OCR_STUDIO_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { title?: string; content?: string };
          if (typeof parsed.title === 'string' && parsed.title.trim()) {
            setDocTitle(parsed.title);
          }
          if (typeof parsed.content === 'string' && parsed.content.trim()) {
            setContent(parsed.content);
          }
        }
      } catch {
        // Ignore storage read issues
      } finally {
        draftHydratedRef.current = true;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Persist draft cleanly to localStorage once initial draft has been hydrated
  useEffect(() => {
    if (!draftHydratedRef.current) return;
    try {
      window.localStorage.setItem(
        OCR_STUDIO_STORAGE_KEY,
        JSON.stringify({ title: docTitle, content })
      );
    } catch {
      // Quota or private-mode fallback
    }
  }, [docTitle, content]);

  // Revoke object URL on unmount/change
  useEffect(() => {
    return () => {
      if (sourceUrl) {
        URL.revokeObjectURL(sourceUrl);
      }
    };
  }, [sourceUrl]);

  const loadSourceFile = useCallback((file: File) => {
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage =
      file.type.startsWith('image/') ||
      /\.(png|jpe?g|webp)$/i.test(file.name);

    if (!isPdf && !isImage) {
      setNotice({
        tone: 'error',
        text: 'অনুগ্রহ করে PNG, JPG, WebP ছবি/স্ক্রিনশট অথবা PDF ফাইল আপলোড করুন।',
      });
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    setSourceUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextUrl;
    });
    setSourceFile(file);
    setSourceKind(isPdf ? 'pdf' : 'image');
    setPdfPageNumber(1);
    setPdfTotalPages(1);
    setPdfPageRangeInput('');
    setNotice({
      tone: 'info',
      text: isPdf
        ? `"${file.name}" লোড হয়েছে। এখন "AI দিয়ে OCR করুন" চাপুন অথবা প্রিভিউ থেকে যেকোনো চিত্র ক্রপ করুন।`
        : `"${file.name}" লোড হয়েছে। এখন "AI দিয়ে OCR করুন" চাপুন অথবা ছবির ভেতরের ডায়াগ্রাম ক্রপ করে নিন।`,
    });
  }, []);

  // Global clipboard paste listener for instant screenshot pasting (Ctrl+V)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Do not hijack plain-text pasting inside input/textarea unless clipboard has an image file
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            const ext = item.type.includes('png') ? 'png' : 'jpg';
            const pastedFile = new File(
              [blob],
              `screenshot-${Date.now()}.${ext}`,
              { type: item.type }
            );
            loadSourceFile(pastedFile);
            return;
          }
        }
      }
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadSourceFile]);

  const commitChange = (
    nextText: string,
    selectionStart?: number,
    selectionEnd?: number
  ) => {
    setUndoStack((prev) => [...prev.slice(-39), content]);
    setRedoStack([]);
    setContent(nextText);

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
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s.slice(-39), content]);
    setContent(prev);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s.slice(-39), content]);
    setContent(next);
  };

  const wrapSelection = (
    prefix: string,
    suffix: string,
    placeholder: string
  ) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    const selected = content.slice(start, end);
    const inner = selected || placeholder;

    if (
      selected &&
      content.slice(Math.max(0, start - prefix.length), start) === prefix &&
      content.slice(end, end + suffix.length) === suffix
    ) {
      const unwrapped =
        content.slice(0, start - prefix.length) +
        selected +
        content.slice(end + suffix.length);
      commitChange(unwrapped, start - prefix.length, end - prefix.length);
      return;
    }

    const nextText =
      content.slice(0, start) + prefix + inner + suffix + content.slice(end);
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
    const selected = content.slice(start, end);
    const stripped = selected
      .replace(/<\/?(?:u|b|strong|i|em|center)>/gi, '')
      .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '$1')
      .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
      .replace(/\*([^\s*][^*]*?)\*/g, '$1');
    const nextText = content.slice(0, start) + stripped + content.slice(end);
    commitChange(nextText, start, start + stripped.length);
  };

  const insertAtCursor = (snippet: string) => {
    const el = textareaRef.current;
    const { nextText, nextCursorPos } = insertBlockSnippetIntoText(
      content,
      snippet,
      el?.selectionStart,
      el?.selectionEnd
    );
    commitChange(nextText, nextCursorPos, nextCursorPos);
  };

  const handleToggleCenterBlock = () => {
    const el = textareaRef.current;
    const rawStart = el?.selectionStart ?? 0;
    const rawEnd = el?.selectionEnd ?? 0;

    const lineStart = content.lastIndexOf('\n', Math.max(0, rawStart - 1)) + 1;
    const nextNl = content.indexOf('\n', rawEnd);
    const lineEnd = nextNl === -1 ? content.length : nextNl;

    const start = rawStart === rawEnd ? lineStart : rawStart;
    const end = rawStart === rawEnd ? lineEnd : rawEnd;
    const selected = content.slice(start, end).trim();

    if (!selected) {
      insertAtCursor('<center>\nপরীক্ষার শিরোনাম\nপদের নাম: ...\n</center>');
      return;
    }

    if (/^<center>[\s\S]*<\/center>$/i.test(selected)) {
      const unwrapped = selected
        .replace(/^<center>\s*/i, '')
        .replace(/\s*<\/center>$/i, '')
        .trim();
      const nextText = content.slice(0, start) + unwrapped + content.slice(end);
      commitChange(nextText, start, start + unwrapped.length);
      return;
    }

    const wrapped = `<center>\n${selected}\n</center>`;
    const prefix = start > 0 && content[start - 1] !== '\n' ? '\n' : '';
    const suffix = end < content.length && content[end] !== '\n' ? '\n' : '';
    const nextText =
      content.slice(0, start) + prefix + wrapped + suffix + content.slice(end);
    const newStart = start + prefix.length;
    commitChange(nextText, newStart, newStart + wrapped.length);
  };

  const handleDirectFigureFileInsert = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!rawDataUrl) return;
      const img = new window.Image();
      img.onload = () => {
        const maxW = 440;
        const scale = img.width > maxW ? maxW / img.width : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const compressed = canvas.toDataURL('image/jpeg', 0.88);
        insertAtCursor(buildFigureMarkdownSnippet(compressed, 'প্রশ্নের চিত্র'));
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleReplaceAll = () => {
    if (!findQuery) return;
    const parts = content.split(findQuery);
    const matches = parts.length - 1;
    if (matches === 0) {
      setReplaceFeedback(`"${findQuery}" পাওয়া যায়নি।`);
      return;
    }
    commitChange(parts.join(replaceValue));
    setReplaceFeedback(
      `${toBengaliNumber(matches)}টি স্থানে "${findQuery}" পরিবর্তন হয়েছে।`
    );
  };

  const handleRunOcr = async () => {
    if (!sourceFile || ocrRunning) return;

    const initialAuthHeaders = await getAiAuthHeaders();
    if (!initialAuthHeaders) {
      requestAiSignIn('09. OCR Studio (AI OCR)');
      return;
    }

    setOcrRunning(true);
    setNotice({
      tone: 'info',
      text: 'AI দিয়ে নিখুঁত OCR চলছে — টেবিল, ভগ্নাংশ, বোল্ড/আন্ডারলাইন ও উত্তর বিশ্লেষণ করা হচ্ছে...',
    });

    try {
      const chapterTitle = docTitle.trim() || 'OCR Studio';
      let extracted = '';
      let autoCroppedCount = 0;

      if (sourceKind === 'pdf') {
        let fileToUpload = sourceFile;
        const rangeText = pdfPageRangeInput.trim();
        if (rangeText) {
          const parsedRange = parsePdfPageSubsetSyntax(rangeText);
          if (!parsedRange.ok) {
            throw new Error(parsedRange.error);
          }
          if (
            !parsedRange.empty &&
            parsedRange.startPage !== null &&
            parsedRange.endPage !== null
          ) {
            const sliced = await slicePdfFileInBrowser({
              file: sourceFile,
              startPage: parsedRange.startPage,
              endPage: parsedRange.endPage,
            });
            fileToUpload = sliced.file;
          }
        } else if (pdfTotalPages > 1) {
          const sliced = await slicePdfFileInBrowser({
            file: sourceFile,
            startPage: pdfPageNumber,
            endPage: pdfPageNumber,
          });
          fileToUpload = sliced.file;
        }

        if (fileToUpload.size > MAX_INLINE_PDF_JSON_BYTES) {
          // Large multi-page PDF -> use battle-tested 4 MB chunked pipeline
          const pipelineResult = await runChunkedPdfPipeline({
            file: fileToUpload,
            useOcr: true,
            ocrMode: 'force',
            ocrSpeed: 'fast',
            fallbackChapter: chapterTitle,
            getAuthHeaders: getAiAuthHeaders,
            onProgress: (prog) => {
              if (prog.statusMessage) {
                setNotice({ tone: 'info', text: prog.statusMessage });
              }
            },
            onUnauthorized: () => requestAiSignIn('09. OCR Studio (AI OCR)'),
          });

          if (!pipelineResult.ok) {
            throw new Error(pipelineResult.error || 'PDF OCR সম্পন্ন করা যায়নি।');
          }
          extracted = mergeOcrStudioSections(
            pipelineResult.extraction.sections,
            pipelineResult.extraction.rawText ?? ''
          );
        } else {
          const pdfBase64 = arrayBufferToBase64(await fileToUpload.arrayBuffer());
          const bodyJson = JSON.stringify({
            fileBase64: pdfBase64,
            mimeType: 'application/pdf',
            fileName: fileToUpload.name,
            fallbackChapter: chapterTitle,
          });

          const callOcrApi = async (headers: Record<string, string>) =>
            fetch('/api/ai/ocr-studio', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...headers,
              },
              body: bodyJson,
            });

          let res = await callOcrApi(initialAuthHeaders);
          if (res.status === 401) {
            const refreshed = await getAiAuthHeaders({ forceRefresh: true });
            if (refreshed) {
              res = await callOcrApi(refreshed);
            }
          }

          const rawBody = await res.text();
          const parsed = parseOcrStudioResponseText(res.status, rawBody);
          if (!parsed.ok || !parsed.payload) {
            if (res.status === 401) {
              requestAiSignIn('09. OCR Studio (AI OCR)');
            }
            throw new Error(
              parsed.payload
                ? formatAiResponseError(
                    res.status,
                    parsed.payload,
                    'PDF OCR সম্পন্ন করা যায়নি।'
                  )
                : parsed.errorMessage || 'PDF OCR সম্পন্ন করা যায়নি।'
            );
          }

          extracted =
            (typeof parsed.payload.text === 'string' && parsed.payload.text.trim()) ||
            mergeOcrStudioSections(
              parsed.payload.sections,
              parsed.payload.rawText ?? ''
            );
        }
      } else {
        // Photo or pasted screenshot -> compress safely under 3.2 MB & send clean JSON to /api/ai/ocr-studio
        const prepared = await prepareImageForPaperCuttingApi(sourceFile);
        try {
          const bodyJson = JSON.stringify({
            imageBase64: prepared.imageBase64,
            mimeType: prepared.mimeType,
            fileName: prepared.fileName,
            fallbackChapter: chapterTitle,
          });

          const callOcrApi = async (headers: Record<string, string>) =>
            fetch('/api/ai/ocr-studio', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...headers,
              },
              body: bodyJson,
            });

          let res = await callOcrApi(initialAuthHeaders);
          if (res.status === 401) {
            const refreshed = await getAiAuthHeaders({ forceRefresh: true });
            if (refreshed) {
              res = await callOcrApi(refreshed);
            }
          }

          const rawBody = await res.text();
          const parsed = parseOcrStudioResponseText(res.status, rawBody);
          if (!parsed.ok || !parsed.payload) {
            if (res.status === 401) {
              requestAiSignIn('09. OCR Studio (AI OCR)');
            }
            throw new Error(
              parsed.payload
                ? formatAiResponseError(
                    res.status,
                    parsed.payload,
                    'ছবির OCR সম্পন্ন করা যায়নি।'
                  )
                : parsed.errorMessage || 'ছবির OCR সম্পন্ন করা যায়নি।'
            );
          }

          extracted =
            (typeof parsed.payload.text === 'string' && parsed.payload.text.trim()) ||
            mergeOcrStudioSections(
              parsed.payload.sections,
              parsed.payload.rawText ?? ''
            );

          if (
            extracted &&
            Array.isArray(parsed.payload.diagrams) &&
            parsed.payload.diagrams.length > 0
          ) {
            const croppedFigures = await autoCropDetectedDiagramsFromImage(
              prepared.previewUrl,
              parsed.payload.diagrams
            );
            if (croppedFigures.length > 0) {
              extracted = replaceDiagramMarkersWithEmbeddedFigures(
                extracted,
                croppedFigures
              );
              autoCroppedCount = croppedFigures.length;
            }
          }
        } finally {
          URL.revokeObjectURL(prepared.previewUrl);
        }
      }

      extracted = stripUnresolvedDiagramMarkers(extracted).trim();

      if (!extracted) {
        throw new Error(
          'এই ছবি বা PDF পৃষ্ঠায় পাঠযোগ্য কোনো লেখা পাওয়া যায়নি। স্পষ্ট ছবি দিয়ে আবার চেষ্টা করুন।'
        );
      }

      if (ocrInsertMode === 'append' && content.trim()) {
        const { nextText } = insertBlockSnippetIntoText(
          content,
          extracted,
          content.length,
          content.length
        );
        commitChange(nextText);
      } else {
        commitChange(extracted);
      }

      setNotice({
        tone: 'success',
        text:
          autoCroppedCount > 0
            ? `OCR সম্পন্ন হয়েছে এবং স্বয়ংক্রিয়ভাবে ${toBengaliNumber(autoCroppedCount)}টি চিত্র/ডায়াগ্রাম যুক্ত করা হয়েছে! প্রয়োজনে এডিট করে বা বাম পাশ থেকে পুনরায় ক্রপ করে কপি অথবা Word/PDF ডাউনলোড করুন।`
            : 'OCR সম্পন্ন হয়েছে! প্রয়োজনে এডিট করে বা বাম পাশ থেকে ডায়াগ্রাম ক্রপ করে বসিয়ে কপি করুন অথবা Word/PDF ডাউনলোড করুন।',
      });
    } catch (err) {
      setNotice({
        tone: 'error',
        text: err instanceof Error ? err.message : 'OCR করতে সমস্যা হয়েছে।',
      });
    } finally {
      setOcrRunning(false);
    }
  };

  const handleCopyAll = async () => {
    if (!content.trim()) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1800);
      setNotice({
        tone: 'success',
        text: 'সম্পূর্ণ টেক্সট ও ছবির কোড কপি হয়েছে! এখন 02. Smart Reader-এ গিয়ে "এডিট (Word টুলস)" খুলে মূল প্রশ্নে Paste ও সেভ করুন।',
      });
    } catch {
      setNotice({
        tone: 'error',
        text: 'ক্লিপবোর্ডে কপি করা যায়নি। এডিটর থেকে Ctrl+A ও Ctrl+C দিয়ে কপি করুন।',
      });
    }
  };

  const handleDownloadPdf = async () => {
    if (!content.trim() || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const exportUnit = buildOcrStudioExportUnit(content, docTitle);
      const { bytes } = await buildStructuredExamPdfBytes([exportUnit], {
        bookTitle: exportUnit.bookTitle,
        numberingStyle: 'original',
        includeHeader: true,
        includeSolutions: !hideAnswers,
        layoutColumns: a4LayoutMode === 'double' ? 2 : 1,
        justifyText,
      });
      const filename = buildSafeExportFilename(
        `${docTitle}-A4-${a4LayoutMode === 'double' ? '2col' : '1col'}`,
        'pdf'
      );
      triggerBrowserFileDownload(bytes, 'application/pdf', filename);
      setNotice({
        tone: 'success',
        text: `A4 PDF ফাইল ডাউনলোড সম্পন্ন হয়েছে: ${filename}`,
      });
    } catch (err) {
      setNotice({
        tone: 'error',
        text:
          err instanceof Error ? err.message : 'A4 PDF তৈরি করতে সমস্যা হয়েছে।',
      });
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleDownloadDocx = async () => {
    if (!content.trim() || downloadingDocx) return;
    setDownloadingDocx(true);
    try {
      const exportUnit = buildOcrStudioExportUnit(content, docTitle);
      const bytes = await buildStructuredExamDocxBytes([exportUnit], {
        bookTitle: exportUnit.bookTitle,
        numberingStyle: 'original',
        includeHeader: true,
        includeSolutions: !hideAnswers,
        layoutColumns: a4LayoutMode === 'double' ? 2 : 1,
        justifyText,
      });
      const filename = buildSafeExportFilename(
        `${docTitle}-A4-${a4LayoutMode === 'double' ? '2col' : '1col'}`,
        'docx'
      );
      triggerBrowserFileDownload(
        bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename
      );
      setNotice({
        tone: 'success',
        text: `Microsoft Word (.docx) ফাইল ডাউনলোড সম্পন্ন হয়েছে: ${filename}`,
      });
    } catch (err) {
      setNotice({
        tone: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Word (.docx) ফাইল তৈরি করতে সমস্যা হয়েছে।',
      });
    } finally {
      setDownloadingDocx(false);
    }
  };

  const wordCount = useMemo(
    () => (content.trim() ? content.trim().split(/\s+/).length : 0),
    [content]
  );

  return (
    <div data-testid="ocr-studio-view" className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            09. OCR Studio — ফটো, স্ক্রিনশট ও PDF OCR
          </h1>
          <p className="mt-1 text-sm text-slate-600 leading-relaxed">
            যেকোনো ফটো, স্ক্রিনশট (সরাসরি Ctrl+V পেস্ট) বা PDF পৃষ্ঠা থেকে নিখুঁত OCR করুন, জ্যামিতি/ঘনকের আসল ছবি ক্রপ করে এডিট করুন এবং কপি করে Smart Reader-এর মূল প্রশ্নে বসান অথবা Word/PDF ডাউনলোড করুন।
          </p>
        </div>

        <button
          type="button"
          data-testid="ocr-studio-btn-go-reader"
          onClick={() => setActiveModule('reader')}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
        >
          <span>Smart Reader-এ যান</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Step 1: Upload / Paste / Run OCR Control Bar */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              data-testid="ocr-studio-btn-upload"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors"
            >
              <Upload className="h-4 w-4" />
              <span>ফটো / স্ক্রিনশট / PDF নির্বাচন করুন</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf,.png,.jpg,.jpeg,.webp,.pdf"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                e.target.value = '';
                if (picked) loadSourceFile(picked);
              }}
            />

            <span className="text-xs text-slate-500">
              অথবা স্ক্রিনশট কপি করে সরাসরি{' '}
              <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-700">
                Ctrl+V
              </kbd>{' '}
              পেস্ট করুন
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {sourceKind === 'pdf' && (
              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="ocr-studio-page-range"
                  className="text-xs font-medium text-slate-600 whitespace-nowrap"
                >
                  পৃষ্ঠা:
                </label>
                <input
                  id="ocr-studio-page-range"
                  type="text"
                  value={pdfPageRangeInput}
                  onChange={(e) => setPdfPageRangeInput(e.target.value)}
                  placeholder={`যেমন: ${pdfPageNumber} বা 1-3`}
                  className="w-28 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
            )}

            <select
              aria-label="OCR যুক্ত করার ধরন"
              value={ocrInsertMode}
              onChange={(e) =>
                setOcrInsertMode(e.target.value as 'replace' | 'append')
              }
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
            >
              <option value="replace">নতুন হিসেবে বসাবে</option>
              <option value="append">আগের লেখার নিচে যোগ করবে</option>
            </select>

            <button
              type="button"
              data-testid="ocr-studio-btn-run-ocr"
              disabled={!sourceFile || ocrRunning}
              onClick={() => void handleRunOcr()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {ocrRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              <span>{ocrRunning ? 'OCR চলছে...' : 'AI দিয়ে OCR করুন'}</span>
            </button>
          </div>
        </div>

        {notice && (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            data-testid="ocr-studio-notice"
            className={`rounded-lg border px-3.5 py-2.5 text-xs font-medium leading-relaxed ${
              notice.tone === 'error'
                ? 'border-red-200 bg-red-50 text-red-800'
                : notice.tone === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-blue-200 bg-blue-50 text-blue-900'
            }`}
          >
            {notice.text}
          </div>
        )}
      </section>

      {/* Step 2: Side-by-Side Source Cropper + Word Editor Workspace */}
      {showEditorWorkspace && (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {/* Left: Interactive Image / PDF Viewer + Mouse Drag Cropper */}
          <div className="xl:col-span-5">
            <OcrStudioCropCanvas
              file={sourceFile}
              fileKind={sourceKind}
              fileObjectUrl={sourceUrl}
              pdfPageNumber={pdfPageNumber}
              pdfTotalPages={pdfTotalPages}
              onChangePdfPage={setPdfPageNumber}
              onPdfPageCountDetected={setPdfTotalPages}
              onInsertCroppedFigure={(md) => insertAtCursor(md)}
              onStatusNotice={(tone, text) => setNotice({ tone, text })}
            />
          </div>

          {/* Right: Built-in Word Editor + Copy to Smart Reader */}
          <div className="xl:col-span-7 flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden">
            {/* Editor Title & Primary Copy Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-900 px-3.5 py-2.5 text-white">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <ScanText className="h-4 w-4 text-blue-300 shrink-0" />
                <input
                  type="text"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  aria-label="প্রশ্নপত্রের শিরোনাম"
                  className="min-w-[140px] max-w-[260px] rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs font-semibold text-white focus:border-blue-400 focus:outline-none"
                />
                <span className="hidden sm:inline text-[11px] font-mono text-slate-300">
                  {toBengaliNumber(wordCount)} শব্দ
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid="ocr-studio-btn-copy-all"
                  disabled={!content.trim()}
                  onClick={() => void handleCopyAll()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors"
                >
                  {copiedAll ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {copiedAll ? 'কপি সম্পন্ন!' : 'কপি করে মূল প্রশ্নে বসান'}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="ocr-studio-btn-clear"
                  disabled={!content.trim()}
                  onClick={() => {
                    commitChange('');
                    setNotice({ tone: 'info', text: 'এডিটর পরিষ্কার করা হয়েছে।' });
                  }}
                  title="এডিটর পরিষ্কার করুন"
                  className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Microsoft Word-style Formatting Toolbar */}
            <div
              data-testid="ocr-studio-word-toolbar"
              className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2"
            >
              <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5">
                <button
                  type="button"
                  onClick={handleUndo}
                  disabled={undoStack.length === 0}
                  title="Undo"
                  className="rounded p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-35"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleRedo}
                  disabled={redoStack.length === 0}
                  title="Redo"
                  className="rounded p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-35"
                >
                  <Redo2 className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => wrapSelection('**', '**', 'বোল্ড লেখা')}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-bold text-slate-800 hover:bg-slate-100"
                >
                  <Bold className="h-3.5 w-3.5" />
                  <span>Bold</span>
                </button>
                <button
                  type="button"
                  onClick={() => wrapSelection('*', '*', 'ইটালিক লেখা')}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs italic text-slate-800 hover:bg-slate-100"
                >
                  <Italic className="h-3.5 w-3.5" />
                  <span>Italic</span>
                </button>
                <button
                  type="button"
                  onClick={() => wrapSelection('<u>', '</u>', 'আন্ডারলাইন শব্দ')}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs underline text-slate-800 hover:bg-slate-100"
                >
                  <Underline className="h-3.5 w-3.5" />
                  <span>Underline</span>
                </button>
                <button
                  type="button"
                  onClick={handleClearFormatting}
                  title="ফরম্যাটিং মুছুন"
                  className="rounded p-1.5 text-slate-600 hover:bg-slate-100"
                >
                  <RemoveFormatting className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setJustifyText(false)}
                  title="বাম অ্যালাইন"
                  className={`rounded p-1.5 ${
                    !justifyText
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <AlignLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-testid="ocr-studio-btn-align-center"
                  onClick={handleToggleCenterBlock}
                  title="সিলেক্ট করা শিরোনাম মাঝখানে (১-কলাম) রাখুন"
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-blue-800 hover:bg-blue-50"
                >
                  <AlignCenter className="h-3.5 w-3.5" />
                  <span>মাঝখানে (১-কলাম)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setJustifyText(true)}
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

              <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5 text-[11px] font-mono">
                <button
                  type="button"
                  onClick={() =>
                    setFontSizeScale((s) =>
                      Math.max(0.85, Number((s - 0.05).toFixed(2)))
                    )
                  }
                  title="ফন্ট ছোট করুন"
                  className="rounded px-1.5 py-1 font-bold text-slate-700 hover:bg-slate-100"
                >
                  A-
                </button>
                <span className="px-1 text-slate-600">
                  {Math.round(fontSizeScale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setFontSizeScale((s) =>
                      Math.min(1.2, Number((s + 0.05).toFixed(2)))
                    )
                  }
                  title="ফন্ট বড় করুন"
                  className="rounded px-1.5 py-1 font-bold text-slate-700 hover:bg-slate-100"
                >
                  A+
                </button>
              </div>

              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    insertAtCursor(
                      '| কলাম ১ | কলাম ২ | কলাম ৩ |\n| --- | --- | --- |\n| তথ্য ১ | তথ্য ২ | তথ্য ৩ |'
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-blue-800 hover:bg-blue-50"
                >
                  <Table2 className="h-3.5 w-3.5" />
                  <span>+ টেবিল</span>
                </button>
                <button
                  type="button"
                  onClick={() => figureUploadRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-50"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  <span>+ চিত্র</span>
                </button>
                <input
                  ref={figureUploadRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handleDirectFigureFileInsert}
                />
                <button
                  type="button"
                  onClick={() => insertAtCursor('উত্তর: ক')}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                >
                  + উত্তর:
                </button>
                <button
                  type="button"
                  onClick={() => insertAtCursor('ব্যাখ্যা: ')}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-rose-800 hover:bg-rose-50"
                >
                  + ব্যাখ্যা:
                </button>
                <button
                  type="button"
                  onClick={() => setShowFindReplace((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold ${
                    showFindReplace
                      ? 'border-blue-700 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Search className="h-3.5 w-3.5" />
                  <span>খুঁজুন</span>
                </button>
              </div>
            </div>

            {showFindReplace && (
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-blue-50/60 px-3 py-2">
                <input
                  type="text"
                  value={findQuery}
                  onChange={(e) => setFindQuery(e.target.value)}
                  placeholder="খুঁজুন..."
                  className="w-36 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
                />
                <input
                  type="text"
                  value={replaceValue}
                  onChange={(e) => setReplaceValue(e.target.value)}
                  placeholder="বদলে লিখুন..."
                  className="w-36 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
                />
                <button
                  type="button"
                  onClick={handleReplaceAll}
                  className="rounded bg-blue-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-800"
                >
                  সব বদলান
                </button>
                {replaceFeedback && (
                  <span className="text-[11px] font-medium text-blue-900">
                    {replaceFeedback}
                  </span>
                )}
              </div>
            )}

            {/* Editable Textarea */}
            <textarea
              ref={textareaRef}
              data-testid="ocr-studio-editor-textarea"
              value={content}
              onChange={(e) => commitChange(e.target.value)}
              placeholder={`এখানে OCR ফলাফল দেখাবে, অথবা সরাসরি প্রশ্ন টাইপ/পেস্ট করে এডিট করতে পারেন।\n\nবাম পাশের ছবি থেকে ত্রিভুজ বা ঘনকের চিত্র ক্রপ করে বসালেই নিচের A4 প্রিভিউ, Word (.docx) ও PDF-এ আসল ছবিটি দেখাবে।`}
              className="min-h-[380px] flex-1 resize-y bg-white p-4 font-mono text-xs leading-relaxed text-slate-900 focus:outline-none"
            />
          </div>
        </section>
      )}

      {/* Step 3: Smart Reader-grade A4 Toolbar (1-Column / 2-Column + Word & PDF Export) */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div
          data-testid="ocr-studio-a4-toolbar"
          className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-200 bg-slate-50 px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* 1-Column / 2-Column Layout Switcher */}
            <div
              role="group"
              aria-label="A4 পেজ কলাম মোড"
              className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
            >
              <button
                type="button"
                data-testid="ocr-studio-layout-single"
                onClick={() => setA4LayoutMode('single')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  a4LayoutMode === 'single'
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <AlignLeft className="h-3.5 w-3.5" />
                <span>A4 ১-কলাম</span>
              </button>
              <button
                type="button"
                data-testid="ocr-studio-layout-double"
                onClick={() => setA4LayoutMode('double')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  a4LayoutMode === 'double'
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <Columns2 className="h-3.5 w-3.5" />
                <span>A4 ২-কলাম (অরিজিনাল প্রশ্নপত্র)</span>
              </button>
            </div>

            <button
              type="button"
              data-testid="ocr-studio-toggle-justify"
              onClick={() => setJustifyText((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                justifyText
                  ? 'border-blue-700 bg-blue-50 text-blue-800'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <AlignJustify className="h-3.5 w-3.5" />
              <span>Justify</span>
            </button>

            <button
              type="button"
              data-testid="ocr-studio-toggle-answers"
              onClick={() => setHideAnswers((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                hideAnswers
                  ? 'border-amber-600 bg-amber-50 text-amber-900'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {hideAnswers ? (
                <Eye className="h-3.5 w-3.5" />
              ) : (
                <EyeOff className="h-3.5 w-3.5" />
              )}
              <span>{hideAnswers ? 'উত্তর দেখান' : 'উত্তর লুকান (প্র্যাকটিস)'}</span>
            </button>

            <button
              type="button"
              data-testid="ocr-studio-toggle-editor"
              onClick={() => setShowEditorWorkspace((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                showEditorWorkspace
                  ? 'border-emerald-700 bg-emerald-50 text-emerald-800'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <PenLine className="h-3.5 w-3.5" />
              <span>{showEditorWorkspace ? 'এডিটর লুকান' : 'এডিটর দেখান'}</span>
            </button>
          </div>

          {/* Export Controls: Word (.docx), A4 PDF, Print */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-mono text-slate-600">
              মোট {toBengaliNumber(a4PageCount)}টি A4 পৃষ্ঠা · Narrow (0.5&quot;)
            </span>

            <button
              type="button"
              data-testid="ocr-studio-download-docx"
              disabled={!content.trim() || downloadingDocx}
              onClick={() => void handleDownloadDocx()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-100 disabled:opacity-40 transition-colors"
            >
              {downloadingDocx ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileDown className="h-3.5 w-3.5" />
              )}
              <span>Word (.docx) ডাউনলোড</span>
            </button>

            <button
              type="button"
              data-testid="ocr-studio-download-pdf"
              disabled={!content.trim() || downloadingPdf}
              onClick={() => void handleDownloadPdf()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-40 transition-colors"
            >
              {downloadingPdf ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>A4 PDF ডাউনলোড</span>
            </button>

            <button
              type="button"
              data-testid="ocr-studio-print"
              disabled={!content.trim()}
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40 transition-colors"
            >
              <Printer className="h-3.5 w-3.5" />
              <span>A4 প্রিন্ট</span>
            </button>
          </div>
        </div>

        {/* Live A4 Sheet Preview */}
        <div className="p-4 sm:p-6 bg-slate-100/70">
          {content.trim() ? (
            <FormattedReaderContent
              content={content}
              layoutMode={a4LayoutMode}
              hideAnswers={hideAnswers}
              justifyText={justifyText}
              fontSizeScale={fontSizeScale}
              runningHeaderTitle={docTitle || 'OCR Studio'}
              pageLabel="OCR Studio"
              printableId="ocr-studio-a4-sheet"
              onPageCountChange={setA4PageCount}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center space-y-2">
              <FileText className="mx-auto h-8 w-8 text-slate-400" />
              <p className="text-sm font-semibold text-slate-800">
                A4 লাইভ প্রিভিউ এখানে দেখাবে
              </p>
              <p className="mx-auto max-w-md text-xs text-slate-500 leading-relaxed">
                উপরে ফটো, স্ক্রিনশট বা PDF দিয়ে OCR করলে অথবা এডিটরে লেখা ও ক্রপ করা ছবি যুক্ত করলেই এখানে Smart Reader-এর মতো A4 ১-কলাম বা ২-কলাম প্রিভিউ এবং Word / PDF ডাউনলোড চালু হয়ে যাবে।
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
