import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeIndianVoice } from '../src/speech/indianVoice.js';
const input = { text: 'Let us read Article 21 carefully.', voice: 'indian-female', cloudConsent: true, rate: 1 };
test('speech requires consent, known speaker, bounded text and a configured key', async () => {
  const options = { apiKey: '', fetchImpl: () => { throw new Error('Must not call provider'); } };
  for (const invalid of [{ ...input, cloudConsent: false }, { ...input, voice: 'unknown' }, { ...input, text: 'x'.repeat(2501) }, null]) {
    assert.equal((await synthesizeIndianVoice(invalid, options)).status, 400);
  }
  assert.equal((await synthesizeIndianVoice(input, options)).status, 503);
});
test('Indian speech pins model, locale and speaker and uses compact audio without pitch manipulation', async () => {
  let request;
  const result = await synthesizeIndianVoice(input, { apiKey: 'test-only', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.sarvam.ai/text-to-speech'); request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ audios: [Buffer.from('example audio bytes').toString('base64')] }) };
  } });
  assert.equal(result.status, 200); assert.equal(request.speaker, 'ishita');
  assert.equal(request.language_code, 'en-IN'); assert.equal(request.model, 'bulbul:v3');
  assert.equal(request.output_audio_codec, 'mp3'); assert.equal(request.pitch, undefined);
});
test('provider errors never leak upstream text or keys', async () => {
  for (const fetchImpl of [async () => ({ ok: false }), async () => { throw new Error('secret private content'); }, async () => ({ ok: true, json: async () => ({ audios: [] }) })]) {
    const result = await synthesizeIndianVoice(input, { apiKey: 'test-only', fetchImpl });
    assert.equal(result.status, 502); assert.doesNotMatch(JSON.stringify(result), /secret private content|test-only/);
  }
});
