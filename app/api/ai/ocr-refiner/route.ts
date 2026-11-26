import { NextRequest, NextResponse } from 'next/server';
import { mapAiErrorToHttpResponse, parseJsonBody } from '@/src/lib/gemini';
import { guardAiApiRequest } from '@/src/lib/ai-api-guard';
import { refineExamPaperWithAgent } from '@/src/lib/ocr-refiner-agent';

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'reader');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const content = String(body.content ?? '').trim();
    const bookTitle = String(body.bookTitle ?? '').trim();
    const examTitle = String(body.examTitle ?? '').trim();
    const highlightHints = Array.isArray(body.highlightHints)
      ? body.highlightHints.map((h) => String(h ?? '').trim()).filter(Boolean)
      : undefined;

    if (!content) {
      return NextResponse.json(
        {
          error: 'রিফাইন করার জন্য কোনো পরীক্ষার টেক্সট পাওয়া যায়নি।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const result = await refineExamPaperWithAgent({
      rawContent: content,
      bookTitle,
      examTitle,
      highlightHints,
      signal: req.signal,
    });

    const summary = result.refinedJson.refinementSummary;

    return NextResponse.json({
      refinedJson: result.refinedJson,
      formattedContent: result.formattedContent,
      usedAi: result.usedAi,
      message: result.usedAi
        ? `OCR Refiner সম্পন্ন: ${summary.totalQuestions}টি প্রশ্ন Structured JSON-এ সংরক্ষিত (${summary.mathLatexConvertedCount}টি LaTeX গণিত, ${summary.extractedInlineAnswersCount}টি উত্তর নিচে বোল্ড আকারে আলাদা করা হয়েছে${summary.preservedHighlightsCount > 0 ? `, ${summary.preservedHighlightsCount}টি হাইলাইট সংরক্ষিত` : ''})।`
        : 'কোনো নম্বরযুক্ত পরীক্ষার প্রশ্ন পাওয়া যায়নি, সাধারণ ফরম্যাটিং প্রয়োগ করা হয়েছে।',
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/ocr-refiner',
      'OCR Refiner এজেন্ট চালাতে সমস্যা হয়েছে।'
    );
  }
}
