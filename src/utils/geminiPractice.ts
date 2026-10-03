/**
 * Client wrappers for the "Luyện Output" Gemini endpoint (/api/ai/context-practice).
 * The Gemini API key never reaches the browser — every call goes through the Vercel API route.
 */
import { evaluateSentenceOffline, evaluateGrammarSentenceOffline } from './contextEngine';
import { DEFAULT_TOPIC_NAMES, pickTopicsOffline } from './contextTopics';

export type PracticeKind = 'vocab' | 'grammar';

export const DEFAULT_CONTEXTS = DEFAULT_TOPIC_NAMES;

export interface SampleSentence {
  english: string;
  vietnamese: string;
}

export interface BatchPractice {
  contexts: string[];
  samples: SampleSentence[];
}

export interface SentenceValidation {
  isCorrect: boolean;
  score: number;
  grammarCorrection: string;
  feedback: string;
  betterSuggestion: string;
}

export class PracticeApiError extends Error {
  constructor(message: string, public code: 'RATE_LIMITED' | 'NO_API_KEY' | 'AI_ERROR' | 'NETWORK') {
    super(message);
  }
  get isRateLimit() {
    return this.code === 'RATE_LIMITED';
  }
}

async function callPracticeApi<T>(payload: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api/ai/context-practice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new PracticeApiError('Không kết nối được máy chủ.', 'NETWORK');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 429 || json?.code === 'RATE_LIMITED') {
    throw new PracticeApiError(json?.message || 'Gemini đang quá tải (429). Thử lại sau ít giây.', 'RATE_LIMITED');
  }
  if (!res.ok || !json?.success) {
    throw new PracticeApiError(json?.message || 'AI tạm thời không phản hồi.', json?.code === 'NO_API_KEY' ? 'NO_API_KEY' : 'AI_ERROR');
  }
  return json.data as T;
}

/** Một lượt Gemini tạo luôn 5 ngữ cảnh + 5 câu mẫu tham khảo.
 * Nếu lỗi/429 → dùng fallback offline, không gọi thêm AI.
 */
export async function generateFiveContextsAndSamples(
  word: string,
  definition: string,
  kind: PracticeKind = 'vocab'
): Promise<{ practice: BatchPractice; fromAI: boolean }> {
  try {
    const practice = await callPracticeApi<BatchPractice>({
      action: 'batchPractice',
      kind,
      word,
      definition,
    });
    if (
      Array.isArray(practice?.contexts) &&
      practice.contexts.length >= 5 &&
      Array.isArray(practice?.samples) &&
      practice.samples.length >= 5
    ) {
      return {
        practice: { contexts: practice.contexts.slice(0, 5), samples: practice.samples.slice(0, 5) },
        fromAI: true,
      };
    }
    throw new Error('Invalid batch practice response');
  } catch (err) {
    console.warn('generateFiveContextsAndSamples → fallback offline:', err);
    const contexts = pickTopicsOffline(word, definition);
    const w = word || 'this word';
    const samples: SampleSentence[] = [
      { english: `I use "${w}" when talking with my friends every day.`, vietnamese: '' },
      { english: `My colleagues and I discussed how to handle this with "${w}" at work.`, vietnamese: '' },
      { english: `I remembered to use "${w}" in my English writing test yesterday.`, vietnamese: '' },
      { english: `I saw many people online talking about "${w}" on modern platforms.`, vietnamese: '' },
      { english: `From my own experience, remembering "${w}" makes my English so much better.`, vietnamese: '' },
    ];
    return { practice: { contexts, samples }, fromAI: false };
  }
}

/** Hàm cũ — giữ lại để tương thích nếu còn nơi khác dùng. */
export async function suggestDynamicContexts(
  word: string,
  definition: string,
  kind: PracticeKind = 'vocab'
): Promise<{ contexts: string[]; fromAI: boolean }> {
  try {
    const contexts = await callPracticeApi<string[]>({ action: 'suggestContexts', kind, word, definition });
    if (Array.isArray(contexts) && contexts.length >= 5) return { contexts: contexts.slice(0, 5), fromAI: true };
    throw new Error('Invalid contexts');
  } catch (err) {
    console.warn('suggestDynamicContexts → fallback tabs:', err);
    return { contexts: pickTopicsOffline(word, definition), fromAI: false };
  }
}

/** Câu mẫu mới riêng lẻ — chỉ được gọi khi người dùng bấm 'Đổi câu mẫu'. */
export async function generateSampleSentence(
  word: string,
  context: string,
  kind: PracticeKind = 'vocab',
  avoid?: string
): Promise<SampleSentence> {
  return callPracticeApi<SampleSentence>({ action: 'sampleSentence', kind, word, context, avoid });
}

/** HÀM 3 — chấm điểm câu người dùng. Lỗi AI → chấm offline cơ bản (thang 100). */
export async function validateUserSentence(
  word: string,
  context: string,
  userSentence: string,
  kind: PracticeKind = 'vocab',
  formula?: string
): Promise<{ result: SentenceValidation; fromAI: boolean; error?: PracticeApiError }> {
  try {
    const result = await callPracticeApi<SentenceValidation>({ action: 'validate', kind, word, context, userSentence });
    return { result, fromAI: true };
  } catch (err) {
    const offline =
      kind === 'grammar'
        ? evaluateGrammarSentenceOffline(word, formula || word, userSentence, context)
        : evaluateSentenceOffline(word, userSentence, context);
    return {
      fromAI: false,
      error: err instanceof PracticeApiError ? err : undefined,
      result: {
        isCorrect: offline.isCorrect,
        score: Math.round(offline.score * 10),
        grammarCorrection: offline.improvedSentence || userSentence,
        feedback: offline.feedbackVi,
        betterSuggestion: '',
      },
    };
  }
}
