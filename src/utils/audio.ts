/**
 * Audio playback and speech synthesis utilities
 */

let activeAudio: HTMLAudioElement | null = null;

/**
 * Play an audio from a URL or Data URI.
 * If no audioUrl is provided, it uses the Web Speech Synthesis API to pronounce the text in English.
 */
export function playAudioOrTTS(
  audioUrl?: string,
  fallbackText?: string,
  onStart?: () => void,
  onEnd?: () => void
): () => void {
  // Stop any currently playing audio
  stopCurrentAudio();

  if (audioUrl) {
    try {
      const audio = new Audio(audioUrl);
      activeAudio = audio;
      if (onStart) {
        audio.onplay = onStart;
      }
      audio.onended = () => {
        activeAudio = null;
        if (onEnd) onEnd();
      };
      audio.onerror = () => {
        activeAudio = null;
        // Fallback to TTS if audio fails to load
        if (fallbackText) {
          speakText(fallbackText, onStart, onEnd);
        } else if (onEnd) {
          onEnd();
        }
      };
      audio.play().catch(() => {
        if (fallbackText) {
          speakText(fallbackText, onStart, onEnd);
        } else if (onEnd) {
          onEnd();
        }
      });

      return () => {
        audio.pause();
        audio.currentTime = 0;
        activeAudio = null;
        if (onEnd) onEnd();
      };
    } catch {
      if (fallbackText) {
        speakText(fallbackText, onStart, onEnd);
      }
      return () => {};
    }
  } else if (fallbackText) {
    return speakText(fallbackText, onStart, onEnd);
  }

  return () => {};
}

/**
 * Speak text using Gemini TTS through the Vercel API.
 * Falls back to the browser speech engine if the network/API is unavailable.
 */
export function speakText(
  text: string,
  onStart?: () => void,
  onEnd?: () => void
): () => void {
  const controller = new AbortController();
  let cancelled = false;
  let activeObjectUrl: string | null = null;
  let audio: HTMLAudioElement | null = null;
  let ended = false;

  const finish = () => {
    if (ended) return;
    ended = true;
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
    if (onEnd) onEnd();
  };

  const fallbackToBrowser = () => {
    if (cancelled || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      finish();
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = /[\u3040-\u30ff\u3400-\u9fff]/.test(text) ? 'ja-JP' : 'en-US';
      utterance.rate = 0.9;
      const voices = window.speechSynthesis.getVoices();
      const prefix = utterance.lang.split('-')[0];
      const voice = voices.find(v => v.lang.toLowerCase().startsWith(prefix));
      if (voice) utterance.voice = voice;
      if (onStart) utterance.onstart = onStart;
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    } catch {
      finish();
    }
  };

  const run = async () => {
    if (!text.trim()) {
      finish();
      return;
    }
    try {
      const languageCode = /[\u3040-\u30ff]/.test(text) ? 'ja-JP' : 'en-US';
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), languageCode }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`TTS request failed: ${response.status}`);
      const blob = await response.blob();
      if (cancelled) return;
      activeObjectUrl = URL.createObjectURL(blob);
      audio = new Audio(activeObjectUrl);
      activeAudio = audio;
      audio.onplay = () => {
        if (onStart) onStart();
      };
      audio.onended = () => {
        if (activeAudio === audio) activeAudio = null;
        finish();
      };
      audio.onerror = () => {
        if (activeAudio === audio) activeAudio = null;
        fallbackToBrowser();
      };
      await audio.play();
    } catch (error) {
      if ((error as any)?.name === 'AbortError' || cancelled) return;
      fallbackToBrowser();
    }
  };

  void run();

  return () => {
    cancelled = true;
    controller.abort();
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      if (activeAudio === audio) activeAudio = null;
    }
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (!ended) {
      ended = true;
      if (onEnd) onEnd();
    }
  };
}

/**
 * Stop any current sound playing
 */
export function stopCurrentAudio() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

/**
 * Convert a File object to base64 Data URL
 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}
