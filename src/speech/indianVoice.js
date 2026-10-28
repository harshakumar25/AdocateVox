// Pin the model and speaker catalogue together. No reference recordings or cloning.
export const INDIAN_VOICES = Object.freeze({
  'indian-female': 'ishita',
  'indian-male': 'ratan',
});
let active = 0;
export async function synthesizeIndianVoice(input, { apiKey = process.env.SARVAM_API_KEY, fetchImpl = fetch } = {}) {
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2500 || !Object.hasOwn(INDIAN_VOICES, input.voice) || input.cloudConsent !== true) {
    return { status: 400, error: 'Choose an Indian voice, allow cloud speech, and send 1–2500 characters.' };
  }
  if (!apiKey) return { status: 503, error: 'Indian neural voices need SARVAM_API_KEY on the server. Device voices are available now.' };
  if (active >= 3) return { status: 429, error: 'Voice service is busy. Please retry shortly.' };
  active++;
  try {
    const response = await fetchImpl('https://api.sarvam.ai/text-to-speech', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': apiKey },
      body: JSON.stringify({ text: input.text.trim(), model: 'bulbul:v3', language_code: 'en-IN',
        speaker: INDIAN_VOICES[input.voice], pace: Math.min(1.3, Math.max(0.7, Number(input.rate) || 1)),
        temperature: 0.4, speech_sample_rate: 24000, output_audio_codec: 'mp3' }),
    });
    if (!response.ok) return { status: 502, error: 'Indian voice provider could not generate audio. Retry or select a device voice.' };
    const data = await response.json();
    const audio = data.audios?.[0];
    if (typeof audio !== 'string' || audio.length < 16 || audio.length > 8000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw new Error('Invalid audio');
    return { status: 200, audio, mime: 'audio/mpeg' };
  } catch {
    // Do not expose provider responses, keys, or spoken legal text in errors/logs.
    return { status: 502, error: 'Indian voice generation timed out or failed. Retry or select a device voice.' };
  } finally { active--; }
}
