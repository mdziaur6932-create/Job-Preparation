import { GoogleGenAI } from '@google/genai';

export const GEMINI_MODEL = 'gemini-4-hydrogen';
export const GEMINI_EMBED_MODEL = 'gemini-embedding-2';

let cachedClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please verify your API key in Settings > Secrets.'
    );
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export async function generateEmbedding768(
  text: string
): Promise<number[] | null> {
  try {
    const ai = getGeminiClient();
    const res = await ai.models.embedContent({
      model: GEMINI_EMBED_MODEL,
      contents: text.slice(0, 3500),
      config: {
        outputDimensionality: 768,
      },
    });
    const values = res.embeddings?.[0]?.values;
    if (Array.isArray(values) && values.length === 768) {
      return values;
    }
    return null;
  } catch (error) {
    console.error('Embedding generation failed:', error);
    return null;
  }
}
