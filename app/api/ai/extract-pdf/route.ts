import { NextRequest, NextResponse } from 'next/server';
import { Type } from '@google/genai';
import { GEMINI_MODEL, getGeminiClient } from '@/src/lib/gemini';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const useOcr = formData.get('useOcr') === 'true';

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'অনুগ্রহ করে একটি বৈধ PDF, টেক্সট বা ছবি ফাইল নির্বাচন করুন।' },
        { status: 400 }
      );
    }

    if (file.size > 15 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'ফাইলের আকার সর্বোচ্চ ১৫ মেগাবাইটের মধ্যে হতে হবে।' },
        { status: 400 }
      );
    }

    // Fast path for plain text / markdown files
    if (
      file.type === 'text/plain' ||
      file.name.endsWith('.txt') ||
      file.name.endsWith('.md')
    ) {
      const rawText = await file.text();
      return NextResponse.json({
        method: 'text',
        ocrCompleted: false,
        totalPages: Math.max(1, Math.ceil(rawText.length / 1800)),
        rawText,
      });
    }

    // PDF or Scanned Image extraction & Bangla/English OCR via Gemini multimodal
    const arrayBuffer = await file.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const mimeType =
      file.type ||
      (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png');

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
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
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
    const combinedText = sections
      .map(
        (s: { pageNumber: number; chapter: string; content: string }) =>
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
    console.error('POST /api/ai/extract-pdf failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'PDF এক্সট্র্যাকশন বা OCR সম্পন্ন করা যায়নি।',
      },
      { status: 500 }
    );
  }
}
