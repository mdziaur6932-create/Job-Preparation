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
import { deduplicateQuestions } from '@/src/lib/rag-engine';
import { guardAiApiRequest } from '@/src/lib/ai-api-guard';
import {
  SYLLABUS_TOPICS,
  classifyQuestionSyllabusTopic,
  parseDemoQuestionBlueprint,
  resolveCanonicalSyllabusTopic,
} from '@/src/lib/syllabus-topic-tagger';
import { encodeExplanationWithSource } from '@/src/lib/demo-paper-blueprint';
import {
  normalizeWrittenSections,
  type QuestionLanguageMode,
} from '@/src/lib/job-exam-paper';

interface SourceChunk {
  bookId: number;
  bookTitle: string;
  chapter: string;
  pageNumber: number;
  content: string;
}

interface IncomingTopicAllocation {
  topicLabel: string;
  percentage: number;
  targetCount: number;
}

function clampString(value: string, maxLen: number): string {
  const cleaned = value.trim();
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen).trim();
}

export async function POST(req: NextRequest) {
  const guard = await guardAiApiRequest(req, 'questions');
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const chunks: SourceChunk[] = Array.isArray(body.chunks)
      ? (body.chunks.slice(0, 14) as SourceChunk[])
      : [];
    const existingStems: string[] = Array.isArray(body.existingStems)
      ? body.existingStems.slice(0, 120).map(String)
      : [];

    const rawType = String(body.questionType || 'MCQ');
    const questionType: 'MCQ' | 'Written' | 'Short' | 'Mixed' =
      rawType === 'Written' || rawType === 'Short' || rawType === 'Mixed'
        ? rawType
        : 'MCQ';

    const rawDiff = String(body.difficulty || 'Medium');
    const difficulty: 'Easy' | 'Medium' | 'Hard' =
      rawDiff === 'Easy' || rawDiff === 'Hard' ? rawDiff : 'Medium';

    const subject = clampString(String(body.subject || 'সাধারণ জ্ঞান'), 150);
    const topicHint = clampString(String(body.topicHint || ''), 400);
    const jobExamPreset = clampString(String(body.jobExamPreset || ''), 120);
    const demoQuestionText = clampString(
      String(body.demoQuestionText || ''),
      4000
    );
    const selectedTopics: string[] = Array.isArray(body.selectedTopics)
      ? body.selectedTopics
          .slice(0, 16)
          .map((t) => clampString(String(t || ''), 90))
          .filter(Boolean)
      : [];

    const topicAllocations: IncomingTopicAllocation[] = [];
    if (Array.isArray(body.topicAllocations)) {
      for (const entry of body.topicAllocations.slice(0, 20)) {
        if (!entry || typeof entry !== 'object') continue;
        const obj = entry as Record<string, unknown>;
        const topicLabel = clampString(String(obj.topicLabel || ''), 90);
        const percentage = Math.max(0, Math.min(100, Number(obj.percentage || 0)));
        const targetCount = Math.max(
          0,
          Math.min(25, Math.round(Number(obj.targetCount || 0)))
        );
        if (topicLabel && targetCount > 0) {
          topicAllocations.push({ topicLabel, percentage, targetCount });
        }
      }
    }

    const setNumber = Math.max(1, Math.min(5, Math.round(Number(body.setNumber || 1))));
    const totalSets = Math.max(1, Math.min(5, Math.round(Number(body.totalSets || 1))));
    const organizationName = clampString(String(body.organizationName || ''), 140);
    const postName = clampString(String(body.postName || ''), 140);
    const rawLang = String(body.languageMode || 'mixed_bd_job');
    const languageMode: QuestionLanguageMode =
      rawLang === 'bn_only' || rawLang === 'en_only' ? rawLang : 'mixed_bd_job';
    const writtenSections = Array.isArray(body.writtenSections)
      ? normalizeWrittenSections(
          body.writtenSections as Array<Record<string, unknown>>
        )
      : [];

    const parsedDemo = parseDemoQuestionBlueprint(demoQuestionText);

    // Resolve MCQ & Written counts cleanly (max 25 per single API batch for reliable JSON)
    const requestedSingleCount = Math.min(
      25,
      Math.max(1, Number(body.count || 4) || 4)
    );

    let mcqCount = 0;
    let writtenCount = 0;

    if (questionType === 'Mixed') {
      mcqCount = Math.min(
        20,
        Math.max(
          0,
          Number(body.mcqCount ?? parsedDemo.detectedMcqHintCount ?? 5)
        )
      );
      writtenCount = Math.min(
        10,
        Math.max(
          0,
          Number(body.writtenCount ?? parsedDemo.detectedWrittenHintCount ?? 3)
        )
      );
      if (mcqCount + writtenCount === 0) {
        mcqCount = 5;
        writtenCount = 3;
      }
      if (mcqCount + writtenCount > 25) {
        mcqCount = Math.min(mcqCount, 17);
        writtenCount = Math.min(writtenCount, 8);
      }
    } else if (questionType === 'MCQ') {
      mcqCount = Math.min(
        25,
        Math.max(1, Number(body.mcqCount ?? requestedSingleCount))
      );
    } else {
      writtenCount = Math.min(
        15,
        Math.max(1, Number(body.writtenCount ?? requestedSingleCount))
      );
    }

    const totalRequested =
      questionType === 'Mixed'
        ? mcqCount + writtenCount
        : questionType === 'MCQ'
          ? mcqCount
          : writtenCount;

    if (chunks.length === 0) {
      return NextResponse.json(
        {
          error: 'প্রশ্ন তৈরির জন্য অন্তত একটি বই বা অধ্যায় নির্বাচন করুন।',
          code: 'INVALID_REQUEST',
          retryable: false,
        },
        { status: 400 }
      );
    }

    const contextText = chunks
      .map(
        (c, idx) =>
          `[উৎস ${idx + 1}: বই="${clampString(String(c.bookTitle || ''), 120)}" | অধ্যায়="${clampString(String(c.chapter || ''), 120)}" | পৃষ্ঠা=${Number(c.pageNumber || 1)}]\n${String(c.content || '').slice(0, 2200)}`
      )
      .join('\n\n');

    const avoidList =
      existingStems.length > 0
        ? `\nনিচের বিদ্যমান বা পূর্বের সেটের প্রশ্নগুলোর কোনোটি পুনরাবৃত্তি করবে না:\n- ${existingStems.slice(-80).join('\n- ')}`
        : '';

    const combinedTopics = Array.from(
      new Set([
        ...topicAllocations.map((a) => a.topicLabel),
        ...selectedTopics,
        ...parsedDemo.detectedTopics,
      ])
    );

    const syllabusRefList = SYLLABUS_TOPICS.map((t) => t.label).join(', ');

    const formatInstruction =
      questionType === 'Mixed'
        ? `মোট ঠিক ${totalRequested}টি প্রশ্ন তৈরি করো — এর মধ্যে ঠিক ${mcqCount}টি "MCQ" এবং ঠিক ${writtenCount}টি "Written" প্রশ্ন থাকতে হবে (১টিও কম বা বেশি নয়)। প্রথম ${mcqCount}টি MCQ (বহুনির্বাচনি) এবং পরের ${writtenCount}টি Written (চাকরি পরীক্ষার লিখিত ধাঁচের প্রশ্ন) আকারে সাজাও।`
        : questionType === 'MCQ'
          ? `অবশ্যই ঠিক ${mcqCount}টি চাকরির পরীক্ষার মানসম্মত "MCQ" (বহুনির্বাচনি) প্রশ্ন তৈরি করো — ১টিও কম বা বেশি নয়।`
          : `অবশ্যই ঠিক ${writtenCount}টি চাকরির পরীক্ষার মানসম্মত "${questionType}" প্রশ্ন তৈরি করো — ১টিও কম বা বেশি নয়।`;

    const allocationInstruction =
      topicAllocations.length > 0
        ? `\nআপলোডকৃত ডেমো প্রশ্নপত্র বিশ্লেষণের শতকরা (%) প্রাধান্য অনুযায়ী এই ব্যাচের প্রশ্ন বণ্টন (অবশ্যই এই অনুপাত ও সংখ্যা কঠোরভাবে অনুসরণ করবে):\n${topicAllocations
            .map(
              (a) =>
                `- ${a.topicLabel} (${a.percentage}% প্রাধান্য) → ঠিক ${a.targetCount}টি প্রশ্ন`
            )
            .join('\n')}`
        : '';

    const setInstruction =
      totalSets > 1
        ? `\nএটি মোট ${totalSets}টি প্রশ্নসেটের মধ্যে **সেট-${setNumber}**। পূর্ববর্তী সেটগুলো থেকে সম্পূর্ণ ভিন্ন ও নতুন প্রশ্ন বাছাই করবে।`
        : '';

    const demoInstruction = demoQuestionText
      ? `\nডেমো প্রশ্নপত্রের অতিরিক্ত নোট:\n"""\n${demoQuestionText}\n"""`
      : '';

    const orgPostInstruction =
      organizationName || postName
        ? `\nপরীক্ষার প্রতিষ্ঠান ও পদের প্রেক্ষাপট: ${[organizationName && `প্রতিষ্ঠান: ${organizationName}`, postName && `পদের নাম: ${postName}`].filter(Boolean).join(' | ')} (দাপ্তরিক/ব্যবহারিক বা স্থানীয় গুরুত্বের প্রশ্ন তৈরি করলে এই প্রতিষ্ঠান ও পদের সাথে সামঞ্জস্য রাখবে)।`
        : '';

    const languageInstruction =
      languageMode === 'bn_only'
        ? 'ভাষার নিয়ম: ইংরেজি গ্রামার অংশ বাদে সব প্রশ্ন ও অপশন পরিষ্কার বাংলায় লিখবে।'
        : languageMode === 'en_only'
          ? 'ভাষার নিয়ম: বাংলা সাহিত্য/ব্যাকরণ অংশ বাদে সব প্রশ্ন, অপশন ও গাণিতিক সমস্যা ইংরেজিতে (English Version) লিখবে।'
          : 'ভাষার নিয়ম: বাংলাদেশের সরকারি চাকরির পরীক্ষার আদর্শে বাংলা ও সাধারণ জ্ঞান বাংলায়, ইংরেজি গ্রামার ইংরেজিতে, এবং গণিত প্রয়োজনমতো বাংলা বা ইংরেজিতে লিখবে।';

    const writtenBlueprintInstruction =
      writtenSections.length > 0 && writtenCount > 0
        ? `\nলিখিত (Written) প্রশ্নগুলোর জন্য নির্ধারিত সেকশন ও নম্বর কাঠামো (অবশ্যই অনুসরণ করবে):\n${writtenSections
            .map(
              (sec, idx) =>
                `${idx + 1}. বিষয়: ${sec.subjectGroup} — ${sec.title} | সংখ্যা: ${sec.questionCount}টি | প্রতি প্রশ্নের নম্বর: ${sec.marksPerQuestion}${sec.subQuestionsPerItem >= 2 ? (sec.isChoiceOne ? ` | অথবা বিকল্প: ${sec.subQuestionsPerItem}টি বিকল্পের মধ্যে যেকোনো ১টি` : ` | প্রতিটি প্রশ্নে ${sec.subQuestionsPerItem}টি উপ-প্রশ্ন (ক, খ, গ...)`) : ''}`
            )
            .join('\n')}`
        : '';

    const response = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: `তুমি বাংলাদেশের বিসিএস (BCS), ব্যাংক এবং মন্ত্রণালয়/অধিদপ্তর চাকরি পরীক্ষার একজন অভিজ্ঞ প্রশ্নপ্রণেতা।
নিচের নির্বাচিত বইগুলোর Knowledge Base অংশগুলো (এবং যুক্ত থাকলে সাম্প্রতিক সাধারণ জ্ঞান / Paper Cutting) বিশ্লেষণ করে বাস্তব চাকরির পরীক্ষার অনুরূপ প্রশ্নপত্র তৈরি করো।

${formatInstruction}${setInstruction}${orgPostInstruction}
বিষয়: ${subject}
কঠিনতার মাত্রা: ${difficulty}
${languageInstruction}
${jobExamPreset ? `পরীক্ষার প্যাটার্ন: ${jobExamPreset}` : ''}${allocationInstruction}${writtenBlueprintInstruction}
${combinedTopics.length > 0 && topicAllocations.length === 0 ? `অগ্রাধিকারপ্রাপ্ত সিলেবাস টপিকসমূহ: ${combinedTopics.join(', ')}` : ''}
${topicHint ? `অতিরিক্ত নির্দেশনা: ${topicHint}` : ''}${demoInstruction}
${avoidList}

অত্যন্ত গুরুত্বপূর্ণ নিয়মাবলি:
১. প্রতিটি প্রশ্নের questionType অবশ্যই "MCQ", "Written", অথবা "Short" হবে।
২. MCQ প্রশ্নে অবশ্যই ৪টি মানসম্মত বিকল্প (options) এবং সঠিক উত্তরের সূচক (correctOptionIndex: 0 থেকে 3) দিতে হবে। গণিত বা বিজ্ঞানের MCQ-তে প্রশ্নের পাশাপাশি options-এর ভেতরেও ভগ্নাংশ, সূচক, রুট বা সূত্র পরিষ্কার LaTeX ($...$) ফরম্যাটে লিখবে।
৩. Written বা Short প্রশ্নে options ফাঁকা অ্যারে [] দেবে এবং নিচের কাঠামো অনুসরণ করবে:
   - প্রতিটি লিখিত প্রশ্নের stem-এর শুরুতে প্রশ্নের নম্বর উল্লেখ করবে, যেমন: "[নম্বর: ৫]" অথবা উপ-প্রশ্ন থাকলে "[নম্বর: ১×৫ = ৫]"।
   - উপ-প্রশ্ন থাকলে (যেমন সন্ধি বিচ্ছেদ, Preposition, Translation, অতিসংক্ষিপ্ত সা.জ্ঞান) প্রতিটি উপ-প্রশ্ন আলাদা লাইনে "ক. ...", "খ. ...", "গ. ...", "ঘ. ...", "ঙ. ..." আকারে লিখবে এবং modelAnswer-এ প্রতিটি উপ-প্রশ্নের উত্তর "ক) ...", "খ) ..." আকারে দেবে।
   - "যেকোনো ১টি" অথবা বিকল্প থাকলে (যেমন Paragraph/Essay) stem-এ "[যেকোনো ১টি উত্তর দিন]" যুক্ত করে বিকল্পগুলো আলাদা লাইনে "ক. ..." ও "খ. ..." আকারে দেবে।
   - গণিতের লিখিত প্রশ্নের modelAnswer-এ ধাপে ধাপে সম্পূর্ণ সমাধান (LaTeX $...$ সহ) দেবে।
৪. প্রতিটি প্রশ্নে অবশ্যই সংশ্লিষ্ট উৎস বইয়ের নাম (bookTitle), অধ্যায় (chapter), পৃষ্ঠা নম্বর (pageNumber), সম্ভাব্যতা (importanceScore: 60-99), এবং একাডেমিক সিলেবাস টপিক ট্যাগ (syllabusTopic) দিতে হবে।
৫. **ব্যাখ্যা ও উৎস নির্দেশিকা (অবশ্যই মানতে হবে)**:
   - যদি নির্বাচিত উৎস বইয়ের প্রদত্ত টেক্সটে এই প্রশ্নের ব্যাখ্যা বা সমাধানের ধাপ উল্লেখ থাকে, তবে সেই বইয়ের ব্যাখ্যাটি দাও এবং \`explanationSource: "book"\` সেট করো।
   - আর যদি নির্বাচিত বইয়ে এই প্রশ্নের ব্যাখ্যা না থাকে, তবে নিজে নির্ভুল ও তথ্যবহুল বাংলা ব্যাখ্যা তৈরি করে দাও এবং অবশ্যই \`explanationSource: "ai"\` সেট করো।
   - কখনোই explanation ফাঁকা রাখবে না।
৬. syllabusTopic অবশ্যই নিচের মানসম্মত তালিকা থেকে সবচেয়ে উপযুক্তটি বাছাই করবে: ${syllabusRefList}
৭. কখনোই প্রকাশকের বিজ্ঞাপন বা বইয়ের পৃষ্ঠা রেফারেন্স (যেমন "পৃষ্ঠা: ৮৪", "www.prebd.com") প্রশ্নের stem বা option-এ ঢোকাবে না।

নির্বাচিত বইগুলোর উৎসসমূহ:
${contextText}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                questionType: { type: Type.STRING },
                syllabusTopic: { type: Type.STRING },
                stem: { type: Type.STRING },
                options: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                correctOptionIndex: { type: Type.INTEGER },
                modelAnswer: { type: Type.STRING },
                explanation: { type: Type.STRING },
                explanationSource: { type: Type.STRING },
                bookTitle: { type: Type.STRING },
                chapter: { type: Type.STRING },
                pageNumber: { type: Type.INTEGER },
                importanceScore: { type: Type.INTEGER },
              },
              required: [
                'questionType',
                'syllabusTopic',
                'stem',
                'options',
                'modelAnswer',
                'explanation',
                'explanationSource',
                'bookTitle',
                'chapter',
                'pageNumber',
                'importanceScore',
              ],
            },
          },
        },
      },
      {
        timeoutMs: Math.max(DEFAULT_AI_TIMEOUT_MS, 45_000),
        fallbackModel: GEMINI_FAST_OCR_MODEL,
        signal: req.signal,
      }
    );

    const rawItems = parseAiJson<Array<Record<string, unknown>>>(
      response.text,
      'array'
    );

    const normalized = rawItems.map((item) => {
      const matchedChunk =
        chunks.find((c) => c.bookTitle === item.bookTitle) ?? chunks[0];

      const itemRawType = String(item.questionType || '');
      let resolvedType: 'MCQ' | 'Written' | 'Short';
      if (questionType === 'Mixed') {
        resolvedType =
          itemRawType === 'Written' || itemRawType === 'Short'
            ? itemRawType
            : 'MCQ';
      } else {
        resolvedType = questionType;
      }

      const options =
        resolvedType === 'MCQ' && Array.isArray(item.options)
          ? item.options.slice(0, 4).map((o) => clampString(String(o || ''), 300))
          : [];
      const correctIdx =
        resolvedType === 'MCQ'
          ? Math.max(
              0,
              Math.min(
                Math.max(0, options.length - 1),
                Number(item.correctOptionIndex ?? 0)
              )
            )
          : null;

      const stem = clampString(String(item.stem || ''), 3800);
      const rawChapter = clampString(
        String(item.chapter || matchedChunk.chapter || 'অধ্যায় ১'),
        140
      );
      const canonicalTopic =
        resolveCanonicalSyllabusTopic(String(item.syllabusTopic || '')) ??
        classifyQuestionSyllabusTopic(stem, {
          chapter: rawChapter,
          subject,
        });

      const taggedChapter = clampString(
        rawChapter.toLowerCase().includes(canonicalTopic.label.toLowerCase())
          ? rawChapter
          : `${canonicalTopic.label} · ${rawChapter}`,
        235
      );

      const explanationSource: 'book' | 'ai' =
        String(item.explanationSource || '').trim().toLowerCase() === 'book'
          ? 'book'
          : 'ai';
      const rawExplanation = clampString(String(item.explanation || ''), 7300);
      const encodedExplanation = rawExplanation
        ? encodeExplanationWithSource(rawExplanation, explanationSource, 7500)
        : '';

      return {
        bookId: matchedChunk.bookId,
        bookTitle: clampString(
          String(item.bookTitle || matchedChunk.bookTitle),
          235
        ),
        chapter: taggedChapter,
        pageNumber: Math.max(
          1,
          Number(item.pageNumber || matchedChunk.pageNumber || 1)
        ),
        subject,
        questionType: resolvedType,
        difficulty,
        stem,
        options,
        correctOptionIndex: correctIdx,
        modelAnswer: clampString(
          String(item.modelAnswer || '').trim() ||
            (correctIdx !== null ? options[correctIdx] ?? '' : ''),
          7500
        ),
        explanation: encodedExplanation,
        isPreviousYear: false,
        examYear: null,
        examSource:
          totalSets > 1
            ? clampString(
                `${jobExamPreset || 'মডেল টেস্ট'} · সেট-${setNumber}`,
                155
              )
            : jobExamPreset || null,
        importanceScore: Math.min(
          99,
          Math.max(55, Number(item.importanceScore || 85))
        ),
      };
    });

    const uniqueQuestions = deduplicateQuestions(
      normalized.filter((q) => q.stem.length > 0),
      existingStems.map((stem) => ({ stem }))
    );

    return NextResponse.json({
      questions: uniqueQuestions,
      filteredDuplicates: normalized.length - uniqueQuestions.length,
      detectedDemoTopics: parsedDemo.detectedTopics,
      setNumber,
      totalSets,
    });
  } catch (error) {
    return mapAiErrorToHttpResponse(
      error,
      'POST /api/ai/questions',
      'AI প্রশ্ন তৈরি করতে সমস্যা হয়েছে।'
    );
  }
}
