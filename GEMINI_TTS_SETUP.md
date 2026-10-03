# Gemini TTS

This build replaces the browser's default speech synthesis for the app's **Phát âm** buttons with Gemini Text-to-Speech through `/api/tts`.

## Vercel
Keep the existing `GEMINI_API_KEY` environment variable. No new key is required.

Optional variable:
`GEMINI_TTS_VOICE=Kore`

The current frontend calls `/api/tts` and falls back to browser TTS if the API is temporarily unavailable.

## Voice
The default voice is `Kore`. Change `GEMINI_TTS_VOICE` in Vercel to another supported Gemini prebuilt voice if desired.
