import { NextRequest, NextResponse } from 'next/server';
import { ThinkingLevel, Type } from '@google/genai';
import {
  DEFAULT_AI_TIMEOUT_MS,
  GEMINI_FAST_OCR_MODEL,
  GEMINI_MODEL,
  generateWithRetry,
  mapAiErrorToHttpResponse,
  parseAiJson,
  parseJsonBody,
} from '@/src/lib/gemini';
import { guardAiApiRequest } from '@/src/lib/ai-api-guard';
import {
  FALLBACK_SYLLABUS_TOPIC,
  SYLLABUS_SUBJECT_GROUPS,
  SYLLABUS_TOPICS,
  classifyQuestionSyllabusTopic,
  resolveCanonicalSyllabusTopic,
  type SyllabusSubjectGroup,
} from '@/src/lib/syllabus-topic-tagger';

interface IncomingTagItem {
  uid: string;
  text: string;
  bookTitle?: string;
  currentTopic?: string;
}

const ALLOWED_SUBJECT_GROUPS = new Set<string>(SYLLABUS_SUBJECT_GROUPS);

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'topic-tag');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    const items: IncomingTagItem[] = [];
    for (const entry of rawItems.slice(0, 40)) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const uid = String(obj.uid ?? '').trim().slice(0, 140);
      const text = String(obj.text ?? '').trim().slice(0, 380);
      const bookTitle = String(obj.bookTitle ?? '').trim().slice(0, 120);
      const currentTopic = String(obj.currentTopic ?? '').trim().slice(0, 80);
      if (!uid || !text) continue;
      items.push({ uid, text, bookTitle, currentTopic });
    }

    if (items.length === 0) {
      return NextResponse.json(
        {
          error: 'টপিক ট্যাগিংয়ের জন্য অন্তত ১টি প্রশ্ন প্রয়োজন।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const taxonomyList = SYLLABUS_TOPICS.map(
      (t) => `- "${t.label}" [${t.subjectGroup}]`
    ).join('\n');

    const questionLines = items
      .map(
        (it, idx) =>
          `${idx + 1}. uid="${it.uid}" | বই="${it.bookTitle || 'অনির্ধারিত'}" | প্রশ্ন: ${it.text}`
      )
      .join('\n');

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: `তুমি বাংলাদেশের বিসিএস, ব্যাংক ও সরকারি চাকরি পরীক্ষার একজন দক্ষ একাডেমিক সিলেবাস টপিক ক্লাসিফায়ার।
নিচের প্রতিটি প্রশ্ন মনোযোগ দিয়ে পড়ে নিচের নির্ধারিত একাডেমিক সিলেবাস টপিক তালিকা থেকে সবচেয়ে উপযুক্ত টপিক (topicLabel) এবং বিষয় গ্রুপ (subjectGroup) নির্ধারণ করো।

নির্ধারিত সিলেবাস টপিক তালিকা:
${taxonomyList}

নিয়মাবলি:
- প্রতিটি প্রশ্নের মূল ব্যাকরণগত বা বিষয়ভিত্তিক টপিক নিখুঁতভাবে বাছাই করবে (যেমন: সন্ধি বিচ্ছেদ হলে "সন্ধি বিচ্ছেদ (Sandhi Bicched)", verb-এর সঠিক রূপ হলে "Right Form of Verbs", জ্যামিতি/ত্রিভুজ/বৃত্ত/ক্ষেত্রফল হলে "Math Geometry (জ্যামিতি)")।
- অবশ্যই প্রতিটি ইনপুট uid-এর জন্য একটি আউটপুট অবজেক্ট দেবে।
- confidence হবে 60 থেকে 99 এর মধ্যে।

প্রশ্নসমূহ:
${questionLines}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                uid: { type: Type.STRING },
                topicLabel: { type: Type.STRING },
                subjectGroup: { type: Type.STRING },
                confidence: { type: Type.INTEGER },
              },
              required: ['uid', 'topicLabel', 'subjectGroup', 'confidence'],
            },
          },
        },
      },
      {
        timeoutMs: DEFAULT_AI_TIMEOUT_MS,
        fallbackModel: GEMINI_FAST_OCR_MODEL,
        signal: req.signal,
      }
    );

    const parsed = parseAiJson<Array<Record<string, unknown>>>(
      response.text,
      'array'
    );

    const itemByUid = new Map(items.map((it) => [it.uid, it]));
    const tags: Array<{
      uid: string;
      topicLabel: string;
      subjectGroup: SyllabusSubjectGroup;
      confidence: number;
    }> = [];

    for (const row of parsed) {
      const uid = String(row.uid ?? '').trim();
      const source = itemByUid.get(uid);
      if (!source) continue;

      const rawLabel = String(row.topicLabel ?? '').trim();
      const canonical =
        resolveCanonicalSyllabusTopic(rawLabel) ??
        classifyQuestionSyllabusTopic(source.text, {
          existingTopic: source.currentTopic,
        });

      const rawGroup = String(row.subjectGroup ?? '').trim();
      const subjectGroup: SyllabusSubjectGroup = ALLOWED_SUBJECT_GROUPS.has(
        rawGroup
      )
        ? (rawGroup as SyllabusSubjectGroup)
        : canonical.subjectGroup || FALLBACK_SYLLABUS_TOPIC.subjectGroup;

      tags.push({
        uid,
        topicLabel: canonical.label,
        subjectGroup,
        confidence: Math.min(99, Math.max(60, Number(row.confidence || 88))),
      });
    }

    return NextResponse.json({ tags, taggedCount: tags.length });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/topic-tag',
      'AI দিয়ে প্রশ্নগুলোর সিলেবাস টপিক ট্যাগ করা যায়নি।'
    );
  }
}
