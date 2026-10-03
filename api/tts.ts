import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-3.8-flash-tts';
const DEFAULT_VOICE = 'Kore';

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'vocabbank-vercel-tts' } } });
}

function inferLanguageCode(text: string, requested?: string): string {
  if (requested && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(requested)) return requested;
  if (/[\u3040-\u30ff]/.test(text)) return 'ja-JP';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko-KR';
  if (/[\u4e00-\u9fff]/.test(text)) return 'cmn-CN';
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th-TH';
  return 'en-US';
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ success: false, message: 'Invalid JSON body.' }, { status: 400 });
  }

  const text = String(body?.text || '').trim().slice(0, 1200);
  if (!text) return Response.json({ success: false, message: 'text is required.' }, { status: 400 });

  const ai = getGeminiClient();
  if (!ai) return Response.json({ success: false, code: 'NO_API_KEY', message: 'Gemini API key is not configured.' }, { status: 503 });

  const languageCode = inferLanguageCode(text, body?.languageCode);
  const voiceName = String(process.env.GEMINI_TTS_VOICE || DEFAULT_VOICE).trim() || DEFAULT_VOICE;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{
        role: 'user',
        parts: [{
          text,
          speech_metadata: {
            style: 'Natural, clear, warm, human-like language-learning pronunciation. Moderate pace with clean articulation and natural pauses. Do not add or remove words.',
          },
        }],
      }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode,
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const data = response.candidates?.[0]?.content?.parts?.find((part: any) => part.inlineData)?.inlineData?.data;
    if (!data) throw new Error('Gemini TTS returned no audio.');

    const audioBuffer = Buffer.from(data, 'base64');
    return new Response(audioBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err: any) {
    console.error('Vercel Gemini TTS error:', err?.message || err);
    return Response.json({
      success: false,
      code: 'TTS_ERROR',
      message: String(err?.message || 'Gemini TTS failed.'),
    }, { status: 502 });
  }
}

export default async function apiHandler(req: any, res: any) {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers || {})) {
      if (Array.isArray(value)) headers.set(key, value.join(', '));
      else if (value != null) headers.set(key, String(value));
    }
    const method = String(req.method || 'GET').toUpperCase();
    let body: BodyInit | undefined;
    if (!['GET', 'HEAD'].includes(method)) {
      body = typeof req.body === 'string' ? req.body : req.body == null ? undefined : JSON.stringify(req.body);
    }
    const request = new Request(`https://${req.headers?.host || 'localhost'}${req.url || ''}`, { method, headers, body });
    const response = await handle(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const arrayBuffer = await response.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (err: any) {
    console.error('Vercel TTS handler error:', err?.message || err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Server error.' });
  }
}
