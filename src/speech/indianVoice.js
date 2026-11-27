import { createHash } from 'node:crypto';
import { SovereignLruCache } from '../store/cache.js';

// Pin the model and speaker catalogue together. No reference recordings or cloning.
export const INDIAN_VOICES = Object.freeze({
  'indian-female': 'ishita',
  'indian-male': 'ratan',
});

// Cache up to 200 synthesized audio clips (TTL 1 hour)
export const audioCache = new SovereignLruCache(200, 3600000);
export const MAX_CONCURRENT_SPEECH = 3;
export const MAX_QUEUE_SIZE = 10;
export const requestQueue = [];
export let active = 0;

export function resetSpeechState() {
  audioCache.clear();
  requestQueue.length = 0;
  active = 0;
}

export async function synthesizeIndianVoice(input, options = {}) {
  const { apiKey = process.env.SARVAM_API_KEY, fetchImpl = fetch, signal, useCache = false, bypassCache = false } = options;
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2500 || !Object.hasOwn(INDIAN_VOICES, input.voice) || input.cloudConsent !== true) {
    return { status: 400, ok: false, error: 'Choose an Indian voice, allow cloud speech, and send 1–2500 characters.' };
  }

  const pace = Math.min(1.3, Math.max(0.7, Number(input.pace ?? input.rate) || 1));
  const text = input.text.trim();
  const cacheKey = createHash('sha256')
    .update(`${input.voice}:${pace}:${text}`)
    .digest('hex');

  const shouldCache = (fetchImpl === fetch || useCache === true) && !bypassCache;
  const cached = shouldCache ? audioCache.get(cacheKey) : null;
  if (cached) {
    return {
      status: 200,
      ok: true,
      audio: cached.audio,
      mime: cached.mimeType || cached.mime || 'audio/mpeg',
      mimeType: cached.mimeType || cached.mime || 'audio/mpeg',
      cached: true,
    };
  }

  if (!apiKey) {
    return { status: 503, ok: false, error: 'Indian neural voices need SARVAM_API_KEY on the server. Device voices are available now.' };
  }

  let slotAcquired = false;
  if (active >= MAX_CONCURRENT_SPEECH) {
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
      return { status: 429, ok: false, error: 'Voice service is busy. Please retry shortly.' };
    }
    await new Promise((resolve) => {
      requestQueue.push(resolve);
    });
    slotAcquired = true;
  } else {
    active++;
    slotAcquired = true;
  }

  try {
    const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    const response = await fetchImpl('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      signal: fetchSignal,
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': apiKey },
      body: JSON.stringify({
        text,
        model: 'bulbul:v3',
        language_code: 'en-IN',
        speaker: INDIAN_VOICES[input.voice],
        pace,
        temperature: 0.4,
        speech_sample_rate: 24000,
        output_audio_codec: 'mp3',
      }),
    });
    if (!response.ok) {
      return { status: 502, ok: false, error: 'Indian voice provider could not generate audio. Retry or select a device voice.' };
    }
    const data = await response.json();
    const audio = data.audios?.[0];
    if (typeof audio !== 'string' || audio.length < 16 || audio.length > 8000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) {
      throw new Error('Invalid audio');
    }
    if (shouldCache) {
      audioCache.set(cacheKey, { audio, mimeType: 'audio/mpeg' });
    }
    return { status: 200, ok: true, audio, mime: 'audio/mpeg', mimeType: 'audio/mpeg', cached: false };
  } catch {
    // Do not expose provider responses, keys, or spoken legal text in errors/logs.
    return { status: 502, ok: false, error: 'Indian voice generation timed out or failed. Retry or select a device voice.' };
  } finally {
    if (slotAcquired) {
      if (requestQueue.length > 0) {
        const next = requestQueue.shift();
        next();
      } else {
        active--;
      }
    }
  }
}

