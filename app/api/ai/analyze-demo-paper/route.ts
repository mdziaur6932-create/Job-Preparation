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
import { SYLLABUS_TOPICS } from '@/src/lib/syllabus-topic-tagger';
import {
  normalizeTopicPercentages,
  type DemoPaperAnalysis,
} from '@/src/lib/demo-paper-blueprint';
import {
  computeSubjectDistribution,
  normalizeWrittenSections,
} from '@/src/lib/job-exam-paper';
import { extractLocalPdfTextPerPage } from '@/src/lib/pdf-splitter';
import { analyzeDemoPaperTextLocally } from '@/src/lib/local-demo-paper-analyzer';
import { tryConvertBijoyPageText } from '@/src/lib/bijoy-to-unicode';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const MAX_FILES = 6;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.8 * 1024 * 1024;

interface IncomingDemoFile {
  fileName: string;
  mimeType: string;
  base64: string;
}

function hasValidMagicBytes(buf: Buffer, mimeType: string): boolean {
  if (buf.length < 5) return false;
  if (mimeType === 'application/pdf') {
    return (
      buf[0] === 0x25 &&
      buf[1] === 0x50 &&
      buf[2] === 0x44 &&
      buf[3] === 0x46 &&
      buf[4] === 0x2d
    ); // %PDF-
  }
  if (mimeType === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8;
  }
  if (mimeType === 'image/png') {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

async function extractReadablePagesFromPdfFiles(
  files: IncomingDemoFile[]
): Promise<string[]> {
  const pages: string[] = [];
  for (const f of files) {
    if (f.mimeType !== 'application/pdf') continue;
    try {
      const buf = Buffer.from(f.base64, 'base64');
      const extracted = await extractLocalPdfTextPerPage(
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      );
      if (extracted && extracted.length > 0) {
        for (const pageText of extracted) {
          const converted = tryConvertBijoyPageText(pageText || '', false).text;
          if (converted.trim().length > 20) {
            pages.push(converted.trim());
          }
        }
      }
    } catch {
      // Fall through cleanly if PDF has no text layer or uses unsupported font encoding
    }
  }
  return pages;
}

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'analyze-demo-paper');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const rawFiles = Array.isArray(body.files) ? body.files : [];
    const requestedMode = body.mode === 'local' ? 'local' : 'ai';

    const validatedFiles: IncomingDemoFile[] = [];
    for (const entry of rawFiles.slice(0, MAX_FILES)) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const mimeType = String(obj.mimeType ?? '').trim().toLowerCase();
      const base64 = String(obj.base64 ?? '').trim();
      const fileName = String(obj.fileName ?? 'demo-paper').trim().slice(0, 140);

      if (!ALLOWED_MIME_TYPES.has(mimeType) || !base64) {
        return NextResponse.json(
          {
            error:
              'শুধু JPG, PNG, WebP ফটো অথবা PDF ফাইল ডেমো প্রশ্ন হিসেবে বিশ্লেষণ করা যাবে।',
            code: 'INVALID_REQUEST',
            retryable: false,
          },
          { status: 400 }
        );
      }

      const estimatedBytes = Math.floor((base64.length * 3) / 4);
      const maxAllowed =
        mimeType === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
      if (estimatedBytes > maxAllowed) {
        return NextResponse.json(
          {
            error: `"${fileName}" ফাইলের আকার নির্ধারিত সীমার বেশি।`,
            code: 'PAYLOAD_TOO_LARGE',
            retryable: false,
          },
          { status: 413 }
        );
      }

      const sampleBuf = Buffer.from(base64.slice(0, 64), 'base64');
      if (!hasValidMagicBytes(sampleBuf, mimeType)) {
        return NextResponse.json(
          {
            error: `"${fileName}" সঠিক ছবি বা PDF ফাইল নয়।`,
            code: 'INVALID_REQUEST',
            retryable: false,
          },
          { status: 400 }
        );
      }

      validatedFiles.push({ fileName, mimeType, base64 });
    }

    if (validatedFiles.length === 0) {
      return NextResponse.json(
        {
          error: 'বিশ্লেষণের জন্য অন্তত ১টি ডেমো প্রশ্নের ফটো বা PDF আপলোড করুন।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    // Explicit Zero-API Local PDF Text Analysis mode (0 Gemini API calls)
    if (requestedMode === 'local') {
      const hasPdf = validatedFiles.some((f) => f.mimeType === 'application/pdf');
      if (!hasPdf) {
        return NextResponse.json(
          {
            error:
              'স্থানীয় (০ API) বিশ্লেষণ শুধু টেক্সটযুক্ত PDF ফাইলে কাজ করে। ছবির (JPG/PNG) জন্য AI বিশ্লেষণ ব্যবহার করুন।',
            code: 'INVALID_REQUEST',
            retryable: false,
          },
          { status: 400 }
        );
      }
      const extractedPages = await extractReadablePagesFromPdfFiles(validatedFiles);
      const localAnalysis = analyzeDemoPaperTextLocally(
        extractedPages,
        validatedFiles[0].fileName
      );
      if (!localAnalysis) {
        return NextResponse.json(
          {
            error:
              'এই PDF-এ সরাসরি পড়ার মতো টেক্সট লেয়ার পাওয়া যায়নি (সম্ভবত স্ক্যান করা ছবি PDF)। AI বিশ্লেষণ ব্যবহার করুন অথবা ডেমো ছাড়াই "সরাসরি বই থেকে (০ API)" মোডে প্রশ্ন তৈরি করুন।',
            code: 'INVALID_REQUEST',
            retryable: false,
          },
          { status: 422 }
        );
      }
      return NextResponse.json({ analysis: localAnalysis, engineUsed: 'local' });
    }

    const taxonomyList = SYLLABUS_TOPICS.map(
      (t) => `- "${t.label}" [${t.subjectGroup}]`
    ).join('\n');

    // Optimization: if all files are PDFs with clean embedded text, send compact text
    // instead of heavy raw PDF binaries to slash input token consumption by ~80%
    const allPdfs = validatedFiles.every((f) => f.mimeType === 'application/pdf');
    let extractedPdfTextForPrompt = '';
    if (allPdfs) {
      const pages = await extractReadablePagesFromPdfFiles(validatedFiles);
      const joined = pages.join('\n\n--- পৃষ্ঠা ---\n\n').trim();
      const bengaliOrLatinWordCount = (joined.match(/[\u0980-\u09FFA-Za-z]{2,}/g) ?? []).length;
      if (bengaliOrLatinWordCount >= 40) {
        extractedPdfTextForPrompt = joined.slice(0, 28_000);
      }
    }

    const mediaParts = extractedPdfTextForPrompt
      ? []
      : validatedFiles.map((f) => ({
          inlineData: {
            mimeType: f.mimeType,
            data: f.base64,
          },
        }));

    const promptText = `তুমি বাংলাদেশের বিসিএস (BCS), ব্যাংক, প্রাথমিক শিক্ষক এবং মন্ত্রণালয়/অধিদপ্তর চাকরির পরীক্ষার প্রশ্নপত্র বিশ্লেষণ বিশেষজ্ঞ।
সংযুক্ত নমুনা (Demo) প্রশ্নপত্রের ফটো বা PDF-এর প্রতিটি প্রশ্ন মনোযোগ দিয়ে পড়ো এবং বিশ্লেষণ করো:
১. এটি কোন প্রতিষ্ঠান/মন্ত্রণালয়ের পরীক্ষা (organizationDetected), কোন পদের পরীক্ষা (postNameDetected), পরীক্ষার শিরোনাম (examTitleDetected), পূর্ণমান (totalMarksDetected) এবং সময় কত মিনিট (durationMinutesDetected)?
২. নমুনা প্রশ্নপত্রে মোট কতটি মূল প্রশ্ন আছে? এর মধ্যে কতটি MCQ এবং কতটি Written (লিখিত) প্রশ্ন?
৩. প্রতিটি প্রশ্ন কোন একাডেমিক সিলেবাস টপিক থেকে এসেছে তা নিচের নির্ধারিত তালিকা থেকে চিহ্নিত করে গণনা করো এবং প্রতিটি টপিকে কত শতাংশ (%) প্রশ্নকে প্রাধান্য দেওয়া হয়েছে তা হিসাব করো (সব টপিকের শতাংশের যোগফল ১০০% হবে)।
৪. যদি প্রশ্নপত্রে Written (লিখিত) প্রশ্ন থাকে, তবে writtenSections অ্যারেতে বিষয়ভিত্তিক লিখিত কাঠামো নির্ণয় করো (প্রতিটি সেকশনে কয়টি প্রশ্ন, প্রতিটি প্রশ্নে কয়টি উপ-প্রশ্ন ক–ঙ/a–e আছে, প্রতি প্রশ্নের নম্বর কত, "যেকোনো ১টি" অথবা বিকল্প আছে কিনা, এবং itemStyle: "step_math" | "sub_questions" | "choice_essay" | "short_gk" | "office_descriptive")। আর শুধু MCQ হলে writtenSections ফাঁকা অ্যারে [] রাখবে।

নির্ধারিত সিলেবাস টপিক তালিকা:
${taxonomyList}

গুরুত্বপূর্ণ নিয়মাবলি:
- বইয়ের প্রকাশকের নাম, বিজ্ঞাপন, ওয়েবসাইট লিংক (যেমন www.prebd.com, অগ্রদূত Recent Job Solution), এবং পৃষ্ঠা রেফারেন্স (যেমন "পৃষ্ঠা: ৮৪", "[সেল্ফ প্রিপারেশন...]") সম্পূর্ণ এড়িয়ে যাবে—এগুলো প্রশ্ন হিসেবে গণনা করবে না।
- topicDistribution অ্যারেতে প্রতিটি শনাক্তকৃত টপিকের সঠিক questionCountInDemo (কয়টি প্রশ্ন এসেছে) এবং percentage (শতকরা হার) দেবে।
- যদি কোনো প্রশ্নপত্রের টপিক উপরের তালিকায় হুবহু না মেলে, তবে সবচেয়ে কাছাকাছি টপিক বেছে নেবে।
- recommendedFormat হবে "MCQ", "Written" অথবা "Mixed"।
- summaryNote-এ ১–২ বাক্যে বাংলায় জানিয়ে দাও এই ডেমো প্রশ্নপত্রে কোন বিষয় (বাংলা/ইংরেজি/গণিত/সাধারণ জ্ঞান/কম্পিউটার) ও টপিকগুলোতে সবচেয়ে বেশি প্রাধান্য দেওয়া হয়েছে।${extractedPdfTextForPrompt ? `\n\nডেমো PDF থেকে সংগৃহীত প্রশ্নপত্রের টেক্সট:\n"""\n${extractedPdfTextForPrompt}\n"""` : ''}`;

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: {
          parts: [...mediaParts, { text: promptText }],
        },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              examTitleDetected: { type: Type.STRING },
              examPatternDetected: { type: Type.STRING },
              organizationDetected: { type: Type.STRING },
              postNameDetected: { type: Type.STRING },
              totalMarksDetected: { type: Type.INTEGER },
              durationMinutesDetected: { type: Type.INTEGER },
              totalQuestionsDetected: { type: Type.INTEGER },
              mcqCountDetected: { type: Type.INTEGER },
              writtenCountDetected: { type: Type.INTEGER },
              recommendedFormat: { type: Type.STRING },
              summaryNote: { type: Type.STRING },
              topicDistribution: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    topicLabel: { type: Type.STRING },
                    subjectGroup: { type: Type.STRING },
                    questionCountInDemo: { type: Type.INTEGER },
                    percentage: { type: Type.NUMBER },
                    questionTypes: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                  },
                  required: [
                    'topicLabel',
                    'subjectGroup',
                    'questionCountInDemo',
                    'percentage',
                    'questionTypes',
                  ],
                },
              },
              writtenSections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    subjectGroup: { type: Type.STRING },
                    title: { type: Type.STRING },
                    questionCount: { type: Type.INTEGER },
                    subQuestionsPerItem: { type: Type.INTEGER },
                    marksPerQuestion: { type: Type.NUMBER },
                    isChoiceOne: { type: Type.BOOLEAN },
                    itemStyle: { type: Type.STRING },
                  },
                  required: [
                    'subjectGroup',
                    'title',
                    'questionCount',
                    'subQuestionsPerItem',
                    'marksPerQuestion',
                    'isChoiceOne',
                    'itemStyle',
                  ],
                },
              },
            },
            required: [
              'examTitleDetected',
              'examPatternDetected',
              'totalQuestionsDetected',
              'mcqCountDetected',
              'writtenCountDetected',
              'recommendedFormat',
              'summaryNote',
              'topicDistribution',
              'writtenSections',
            ],
          },
        },
      },
      {
        timeoutMs: Math.max(DEFAULT_AI_TIMEOUT_MS, 45_000),
        fallbackModel: GEMINI_FAST_OCR_MODEL,
        signal: req.signal,
      }
    );

    const raw = parseAiJson<Record<string, unknown>>(response.text, 'object');
    const rawDist = Array.isArray(raw.topicDistribution)
      ? (raw.topicDistribution as Array<{
          topicLabel: string;
          subjectGroup?: string;
          questionCountInDemo?: number;
          percentage?: number;
          questionTypes?: string[];
        }>)
      : [];

    const normalizedTopics = normalizeTopicPercentages(rawDist);
    const subjectDistribution = computeSubjectDistribution(normalizedTopics);
    const writtenSections = Array.isArray(raw.writtenSections)
      ? normalizeWrittenSections(
          raw.writtenSections as Array<Record<string, unknown>>
        )
      : [];

    const mcqDetected = Math.max(0, Math.round(Number(raw.mcqCountDetected || 0)));
    const writtenDetected = Math.max(
      0,
      Math.round(Number(raw.writtenCountDetected || 0))
    );
    const totalDetected = Math.max(
      mcqDetected + writtenDetected,
      Math.round(Number(raw.totalQuestionsDetected || 0)),
      normalizedTopics.reduce((s, t) => s + t.questionCountInDemo, 0)
    );

    const rawFmt = String(raw.recommendedFormat || '');
    const recommendedFormat: 'MCQ' | 'Written' | 'Mixed' =
      rawFmt === 'MCQ' || rawFmt === 'Written' || rawFmt === 'Mixed'
        ? rawFmt
        : mcqDetected > 0 && writtenDetected > 0
          ? 'Mixed'
          : writtenDetected > 0
            ? 'Written'
            : 'MCQ';

    const organizationDetected = String(raw.organizationDetected || '')
      .trim()
      .slice(0, 140);
    const postNameDetected = String(raw.postNameDetected || '')
      .trim()
      .slice(0, 140);
    const totalMarksDetected = Math.round(Number(raw.totalMarksDetected || 0));
    const durationMinutesDetected = Math.round(
      Number(raw.durationMinutesDetected || 0)
    );

    const primaryFile = validatedFiles[0];
    const analysis: DemoPaperAnalysis = {
      fileName:
        validatedFiles.length === 1
          ? primaryFile.fileName
          : `${primaryFile.fileName} (+ আরও ${validatedFiles.length - 1}টি ফাইল)`,
      fileType: primaryFile.mimeType === 'application/pdf' ? 'pdf' : 'image',
      examTitleDetected:
        String(raw.examTitleDetected || '').trim().slice(0, 180) ||
        'আপলোডকৃত ডেমো প্রশ্নপত্র',
      examPatternDetected:
        String(raw.examPatternDetected || '').trim().slice(0, 140) ||
        'চাকরির পরীক্ষার নমুনা প্যাটার্ন',
      ...(organizationDetected ? { organizationDetected } : {}),
      ...(postNameDetected ? { postNameDetected } : {}),
      ...(totalMarksDetected > 0 && totalMarksDetected <= 500
        ? { totalMarksDetected }
        : {}),
      ...(durationMinutesDetected > 0 && durationMinutesDetected <= 300
        ? { durationMinutesDetected }
        : {}),
      totalQuestionsDetected: totalDetected,
      mcqCountDetected: mcqDetected,
      writtenCountDetected: writtenDetected,
      recommendedFormat,
      subjectDistribution,
      writtenSections,
      topicDistribution: normalizedTopics,
      summaryNote:
        String(raw.summaryNote || '').trim().slice(0, 600) ||
        'ডেমো প্রশ্নপত্র বিশ্লেষণ করে বিষয় ও টপিকভিত্তিক শতকরা প্রাধান্য নির্ণয় করা হয়েছে।',
    };

    return NextResponse.json({ analysis });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/analyze-demo-paper',
      'ডেমো প্রশ্নপত্রের ফটো/PDF বিশ্লেষণ করা যায়নি।'
    );
  }
}
