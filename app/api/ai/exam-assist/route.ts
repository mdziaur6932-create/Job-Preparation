import { NextRequest, NextResponse } from 'next/server';
import { ThinkingLevel } from '@google/genai';
import {
  DEFAULT_AI_TIMEOUT_MS,
  GEMINI_FAST_OCR_MODEL,
  GEMINI_MODEL,
  generateWithRetry,
  mapAiErrorToHttpResponse,
  parseJsonBody,
} from '@/src/lib/gemini';
import { guardAiApiRequest } from '@/src/lib/ai-api-guard';
import {
  analyzeExamQuestionAnswers,
  mergeAiMissingAnswersSafely,
  mergeRepairedMathSafely,
  normalizeQuestionKey,
  type AiMissingAnswerEntry,
  type AiReferenceItem,
  type SafeMathRepairEntry,
} from '@/src/lib/exam-math-and-answer-guard';

interface GroundingChunkLike {
  web?: {
    uri?: string;
    title?: string;
  };
}

function extractGroundingWebReferences(response: unknown): AiReferenceItem[] {
  const refs: AiReferenceItem[] = [];
  const seen = new Set<string>();
  const candidates = (
    response as {
      candidates?: Array<{
        groundingMetadata?: { groundingChunks?: GroundingChunkLike[] };
      }>;
    }
  )?.candidates;

  const chunks = candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return refs;

  for (const chunk of chunks) {
    const uri = (chunk?.web?.uri ?? '').trim();
    const title = (chunk?.web?.title ?? '').trim();
    if (!uri && !title) continue;
    const dedupeKey = uri || title;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    refs.push({
      title: title || uri,
      url: uri || undefined,
    });
    if (refs.length >= 4) break;
  }

  return refs;
}

function parseDelimitedMissingAnswers(
  rawText: string,
  groundingRefs: AiReferenceItem[]
): AiMissingAnswerEntry[] {
  const entries: AiMissingAnswerEntry[] = [];
  const blockRe = /<<<Q_START\s+key=([^\s>]+)\s*>>>([\s\S]*?)<<<Q_END>>>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(rawText)) !== null) {
    const questionKey = normalizeQuestionKey(match[1] ?? '');
    const body = (match[2] ?? '').trim();
    if (!questionKey || !body) continue;

    const refSplit = body.split(/<<<REF>>>/i);
    const answerPart = (refSplit[0] ?? '')
      .replace(/<<<ANSWER>>>/i, '')
      .trim();
    const modelRefRaw = (refSplit[1] ?? '').trim();

    if (!answerPart) continue;

    const perQuestionRefs: AiReferenceItem[] = [...groundingRefs];
    if (modelRefRaw) {
      const refLines = modelRefRaw
        .split(/\n|\|/)
        .map((r) => r.replace(/^[-•*\d.)\s]+/, '').trim())
        .filter(Boolean);
      for (const rl of refLines.slice(0, 2)) {
        const urlMatch = rl.match(/https?:\/\/[^\s)]+/);
        const url = urlMatch ? urlMatch[0] : undefined;
        const title = url
          ? rl.replace(url, '').replace(/[()]/g, '').trim() || url
          : rl;
        if (!perQuestionRefs.some((x) => (url && x.url === url) || x.title === title)) {
          perQuestionRefs.push({ title, url });
        }
      }
    }

    entries.push({
      questionKey,
      answerText: answerPart,
      references: perQuestionRefs.slice(0, 3),
    });
  }

  return entries;
}

function parseDelimitedMathRepairs(rawText: string): SafeMathRepairEntry[] {
  const repairs: SafeMathRepairEntry[] = [];
  const blockRe = /<<<MATH_START\s+key=([^\s>]+)\s*>>>([\s\S]*?)<<<MATH_END>>>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(rawText)) !== null) {
    const questionKey = normalizeQuestionKey(match[1] ?? '');
    const repairedBlock = (match[2] ?? '').trim();
    if (questionKey && repairedBlock) {
      repairs.push({ questionKey, repairedBlock });
    }
  }

  return repairs;
}

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'reader');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const mode =
      body.mode === 'fill_missing_answers' ? 'fill_missing_answers' : 'repair_math';
    const content = String(body.content ?? '').trim();
    const bookTitle = String(body.bookTitle ?? '').trim();
    const examTitle = String(body.examTitle ?? '').trim();

    if (!content) {
      return NextResponse.json(
        {
          error: 'বিশ্লেষণের জন্য কোনো প্রশ্নপত্রের টেক্সট পাওয়া যায়নি।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const analysis = analyzeExamQuestionAnswers(content);

    // -----------------------------------------------------------------------
    // MODE 1: STRICT NON-OVERRIDE MISSING-ANSWER LOOKUP WITH WEB GROUNDING
    // -----------------------------------------------------------------------
    if (mode === 'fill_missing_answers') {
      if (!analysis.isExam) {
        return NextResponse.json({
          mode,
          skippedAll: true,
          updatedContent: content,
          appliedKeys: [],
          skippedProtectedCount: 0,
          references: [],
          message:
            'এই পৃষ্ঠায় নম্বরযুক্ত পরীক্ষার প্রশ্ন পাওয়া যায়নি। তাই AI দিয়ে কোনো উত্তর তৈরি করা হয়নি।',
        });
      }

      // HARD SERVER GUARD: If EVERY question already has a printed answer, NEVER call AI!
      if (analysis.unansweredQuestions.length === 0) {
        return NextResponse.json({
          mode,
          skippedAll: true,
          updatedContent: content,
          appliedKeys: [],
          skippedProtectedCount: analysis.answeredCount,
          references: [],
          message: `এই পরীক্ষার সবগুলো প্রশ্নের (${analysis.answeredCount}টি) উত্তর মূল বইয়ে ইতিমধ্যেই রয়েছে। নিয়ম অনুযায়ী মূল বইয়ে উত্তর থাকা কোনো প্রশ্নে AI দিয়ে উত্তর তৈরি করা হয়নি।`,
        });
      }

      const unansweredBatch = analysis.unansweredQuestions.slice(0, 12);
      const unansweredPromptList = unansweredBatch
        .map(
          (q) =>
            `[Question Key: ${q.questionKey} | Original Number: ${q.numberLabel}]\n${q.rawBlock}`
        )
        .join('\n\n---\n\n');

      const response = await generateWithRetry(
        {
          model: GEMINI_MODEL,
          contents: `পরীক্ষার শিরোনাম: ${examTitle || bookTitle || 'সরকারি চাকরি পরীক্ষা'}

নিচের প্রশ্নগুলোর মূল বইয়ে কোনো উত্তর দেওয়া নেই। Google Search ব্যবহার করে নির্ভরযোগ্য সরকারি/শিক্ষামূলক/পাঠ্যবই উৎস থেকে প্রতিটি প্রশ্নের নির্ভুল উত্তর ও প্রামাণ্য রেফারেন্স খুঁজে বের করুন।

অনুত্তরিত প্রশ্নসমূহ (${unansweredBatch.length}টি):
${unansweredPromptList}

OUTPUT FORMAT (STRICTLY USE THESE DELIMITERS FOR EVERY QUESTION — NO MARKDOWN FENCES):
<<<Q_START key=QUESTION_KEY>>>
<<<ANSWER>>>
[সংক্ষিপ্ত, নির্ভুল বাংলা উত্তর। গণিত হলে ধাপে ধাপে সমাধান এবং প্রতিটি ভগ্নাংশ \\frac{লব}{হর} ফরম্যাটে লিখুন]
<<<REF>>>
[নির্ভরযোগ্য উৎসের নাম ও লিংক (যদি থাকে)]
<<<Q_END>>>`,
          config: {
            tools: [{ googleSearch: {} }],
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction:
              'You are a rigorous Bangladeshi competitive job exam (BCS, Bank, Govt) fact-checker and teacher. Answer ONLY the unanswered questions provided by the user. Verify factual answers using Google Search grounding. For mathematics, write every fraction inline as \\frac{numerator}{denominator} and verify every calculation. Always include the source/reference title. Never fabricate URLs.',
          },
        },
        {
          timeoutMs: DEFAULT_AI_TIMEOUT_MS,
          fallbackModel: GEMINI_FAST_OCR_MODEL,
          signal: req.signal,
        }
      );

      const groundingRefs = extractGroundingWebReferences(response);
      const parsedAnswers = parseDelimitedMissingAnswers(
        response.text ?? '',
        groundingRefs
      );

      if (parsedAnswers.length === 0) {
        return NextResponse.json(
          {
            error:
              'AI থেকে অনুত্তরিত প্রশ্নগুলোর নির্ভুল উত্তর পার্স করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।',
            code: 'INVALID_AI_RESPONSE',
            retryable: true,
          },
          { status: 502 }
        );
      }

      // Deterministic server-side non-override merge (physically impossible to touch answered questions)
      const merged = mergeAiMissingAnswersSafely(content, parsedAnswers);

      return NextResponse.json({
        mode,
        skippedAll: merged.appliedKeys.length === 0,
        updatedContent: merged.updatedContent,
        appliedKeys: merged.appliedKeys,
        skippedProtectedCount: analysis.answeredCount,
        references: groundingRefs,
        message:
          merged.appliedKeys.length > 0
            ? `উত্তরবিহীন ${merged.appliedKeys.length}টি প্রশ্নের উত্তর রেফারেন্সসহ যুক্ত করা হয়েছে এবং প্রতিটি উত্তরে "[AI দ্বারা তৈরি উত্তর]" চিহ্নিত করা হয়েছে। মূল বইয়ে উত্তর থাকা ${analysis.answeredCount}টি প্রশ্ন সম্পূর্ণ অপরিবর্তিত রাখা হয়েছে।`
            : 'কোনো উত্তরবিহীন প্রশ্ন আপডেট করা হয়নি; মূল বইয়ের সব উত্তর অপরিবর্তিত আছে।',
      });
    }

    // -----------------------------------------------------------------------
    // MODE 2: MATH FRACTION & GARBLED EQUATION OCR REPAIR
    // -----------------------------------------------------------------------
    const targetMathQuestions =
      analysis.corruptedMathQuestions.length > 0
        ? analysis.corruptedMathQuestions
        : analysis.mathQuestions;

    if (!analysis.isExam || targetMathQuestions.length === 0) {
      return NextResponse.json({
        mode,
        skippedAll: true,
        updatedContent: content,
        repairedKeys: [],
        message:
          'এই পরীক্ষায় মেরামত করার মতো কোনো গণিত বা ভগ্নাংশের ত্রুটি পাওয়া যায়নি।',
      });
    }

    const mathBatch = targetMathQuestions.slice(0, 12);
    const mathPromptList = mathBatch
      .map(
        (q) =>
          `[Question Key: ${q.questionKey} | Original Number: ${q.numberLabel}]\n${q.rawBlock}`
      )
      .join('\n\n---\n\n');

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: `পরীক্ষার শিরোনাম: ${examTitle || bookTitle || 'সরকারি চাকরি পরীক্ষা'}

নিচের গণিত প্রশ্নগুলোর OCR টেক্সটে ভগ্নাংশ ভেঙে গেছে বা সূচক/সমীকরণ ভুল টাইপ হয়েছে (যেমন: লব-হর আলাদা লাইনে চলে যাওয়া, x⁴ কে x° পড়া, মৌলিক উৎপাদক এলোমেলো হওয়া, বা ∴ এর বদলে ... আসা)।

প্রতিটি গণিত প্রশ্ন ও তার বিদ্যমান সমাধানকে গাণিতিকভাবে নির্ভুল করে পুনর্গঠন করুন।

কঠোর নিয়মাবলি:
১. প্রতিটি ভগ্নাংশ অবশ্যই ইনলাইনে \\frac{লব}{হর} ফরম্যাটে লিখবেন (যেমন: \\frac{3x+7}{4} + \\frac{5x-4}{7} = x + 3\\frac{1}{2}, \\frac{১০}{১০০}, \\frac{x}{y} = \\frac{১৩}{১২})। কখনো লব ও হর আলাদা লাইনে ভাঙবেন না।
২. সূচক (Exponents) সঠিকভাবে লিখবেন (x⁴, y², z², (x²)² বা x^4, y^2)। কখনো °, *, ', @ লিখবেন না।
৩. মৌলিক উৎপাদক, সমীকরণের প্রতিটি ধাপ, ⇒, ∴, ×, ÷, = গাণিতিকভাবে যাচাই করে নির্ভুল লিখবেন।
৪. মূল বইয়ে দেওয়া চূড়ান্ত উত্তর (যেমন: x = 5, ১৩ জন, ১৩ : ১২) এবং প্রশ্নের মূল অর্থ অবশ্যই অক্ষুণ্ণ রাখবেন। কোনো প্রশ্নে আগে থেকে সমাধান না থাকলে নতুন সমাধান বানাবেন না—শুধু প্রশ্নটির ভাঙা গণিত/ভগ্নাংশ ঠিক করবেন।

মেরামতযোগ্য গণিত প্রশ্নসমূহ (${mathBatch.length}টি):
${mathPromptList}

OUTPUT FORMAT (STRICTLY USE THESE DELIMITERS — NO MARKDOWN FENCES):
<<<MATH_START key=QUESTION_KEY>>>
[Original Number] [নির্ভুল প্রশ্ন]
সমাধান: [যদি মূল টেক্সটে সমাধান থাকে তবে নির্ভুল ধাপে ধাপে সমাধান \\frac{...}{...} সহ]
<<<MATH_END>>>`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction:
            'You are an expert Bangladeshi mathematics editor and OCR repair specialist for BCS and Govt job solution books. Repair ONLY broken OCR math equations, shattered fractions, corrupted exponents, and garbled prime factorizations. Always format every fraction as \\frac{numerator}{denominator}. Verify every algebraic step carefully so it leads cleanly to the printed answer. NEVER invent a solution if the original question had no solution.',
        },
      },
      {
        timeoutMs: DEFAULT_AI_TIMEOUT_MS,
        fallbackModel: GEMINI_FAST_OCR_MODEL,
        signal: req.signal,
      }
    );

    const repairs = parseDelimitedMathRepairs(response.text ?? '');
    if (repairs.length === 0) {
      return NextResponse.json(
        {
          error:
            'গণিত মেরামতের ফলাফল পার্স করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।',
          code: 'INVALID_AI_RESPONSE',
          retryable: true,
        },
        { status: 502 }
      );
    }

    const merged = mergeRepairedMathSafely(content, repairs);

    return NextResponse.json({
      mode,
      skippedAll: merged.repairedKeys.length === 0,
      updatedContent: merged.updatedContent,
      repairedKeys: merged.repairedKeys,
      message:
        merged.repairedKeys.length > 0
          ? `${merged.repairedKeys.length}টি গণিত প্রশ্নের ভগ্নাংশ ও সমীকরণ নির্ভুলভাবে মেরামত করা হয়েছে। চাইলে এখনই বইয়ে সংরক্ষণ করতে পারেন।`
          : 'কোনো গণিত প্রশ্ন পরিবর্তন করা হয়নি।',
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/exam-assist',
      'পরীক্ষার প্রশ্ন বিশ্লেষণ বা মেরামত করতে সমস্যা হয়েছে।'
    );
  }
}
