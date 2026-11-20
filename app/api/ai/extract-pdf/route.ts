import { NextRequest, NextResponse } from 'next/server';
import { ThinkingLevel, Type } from '@google/genai';
import {
  AiInvalidRequestError,
  DEFAULT_PDF_AI_TIMEOUT_MS,
  GEMINI_MODEL,
  generateWithRetry,
  mapAiErrorToHttpResponse,
  parseAiJson,
} from '@/src/lib/gemini';
import {
  MAX_UPLOAD_BYTES,
  validateUploadedDocument,
} from '@/src/lib/file-validation';

interface ExtractedSection {
  chapter: string;
  pageNumber: number;
  content: string;
}

interface ExtractedDocumentResponse {
  totalPages?: number;
  sections?: ExtractedSection[];
}

export async function POST(req: NextRequest) {
  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      throw new AiInvalidRequestError(
        'অনুগ্রহ করে বৈধ ফর্ম-ডেটা হিসেবে একটি PDF, ছবি বা টেক্সট ফাইল আপলোড করুন।'
      );
    }

    const file = formData.get('file');
    const useOcr = formData.get('useOcr') === 'true';

    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          error: 'অনুগ্রহ করে একটি বৈধ PDF, টেক্সট বা ছবি ফাইল নির্বাচন করুন।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: 'ফাইলের আকার সর্বোচ্চ ১৫ মেগাবাইটের মধ্যে হতে হবে।',
          code: 'FILE_TOO_LARGE',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const validation = validateUploadedDocument(
      file.name,
      file.type,
      bytes,
      MAX_UPLOAD_BYTES
    );

    if (!validation.ok) {
      return NextResponse.json(
        {
          error: validation.error,
          code: validation.code,
          retryable: false,
        },
        { status: 400 }
      );
    }

    // Fast path for validated plain text / markdown files
    if (validation.kind === 'text') {
      const rawText = new TextDecoder('utf-8').decode(bytes);
      return NextResponse.json({
        method: 'text',
        ocrCompleted: false,
        totalPages: Math.max(1, Math.ceil(rawText.length / 1800)),
        rawText,
      });
    }

    // PDF or Scanned Image extraction & Bangla/English OCR via Gemini multimodal
    const base64Data = Buffer.from(bytes).toString('base64');
    const mimeType = validation.mimeType;

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
            {
              text: `You are an academic OCR and PDF text extraction engine for Bangladeshi competitive job exams (BCS, Bank, Govt Jobs).
${useOcr ? 'Perform high-accuracy Bangla & English OCR on every scanned page.' : 'Extract structured text accurately from this document.'}
Return JSON with:
- totalPages: estimated page count
- sections: array of objects with { chapter, pageNumber, content } where each section contains faithful, clean, study-ready extracted text in the original language (Bangla or English).`,
            },
          ],
        },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              totalPages: { type: Type.INTEGER },
              sections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    chapter: { type: Type.STRING },
                    pageNumber: { type: Type.INTEGER },
                    content: { type: Type.STRING },
                  },
                  required: ['chapter', 'pageNumber', 'content'],
                },
              },
            },
            required: ['totalPages', 'sections'],
          },
        },
      },
      {
        timeoutMs: DEFAULT_PDF_AI_TIMEOUT_MS,
        signal: req.signal,
      }
    );

    const parsed = parseAiJson<ExtractedDocumentResponse>(
      response.text,
      'object'
    );
    const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
    const combinedText = sections
      .map(
        (s) =>
          `--- পৃষ্ঠা ${s.pageNumber} ---\n[${s.chapter}]\n${s.content}`
      )
      .join('\n\n');

    return NextResponse.json({
      method: useOcr ? 'ocr' : 'text',
      ocrCompleted: true,
      totalPages: Number(parsed.totalPages || Math.max(1, sections.length)),
      sections,
      rawText: combinedText,
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/extract-pdf',
      'PDF এক্সট্র্যাকশন বা OCR সম্পন্ন করা যায়নি।'
    );
  }
}
