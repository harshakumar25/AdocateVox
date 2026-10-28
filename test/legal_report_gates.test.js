import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkQuality } from '../src/reports/quality.js';
import { quoteFromAnchors, numberedParagraphs, chunkParagraphs } from '../src/reports/cards.js';
import { generateReportText } from '../src/reports/provider.js';
import { parseJson } from '../src/reports/json.js';

test('deterministic gates detect dashes, phrases and six-word copied prose while excluding quoted ledger text', () => {
  const source = 'The green lantern stood outside the small fictional courthouse yesterday.';
  const result = checkQuality(`Moreover, this is pivotal — ${source}`, [source]);
  assert.equal(result.pass, false); assert.equal(result.dash_hits, 1);
  assert.deepEqual(result.banned_phrases, ['moreover', 'pivotal']); assert.ok(result.overlap_pct > 10);
  const quoted = checkQuality(`A short note. “${source}” [C1]\nSOURCE LEDGER\n${source} — moreover`, [source]);
  assert.equal(quoted.pass, true); assert.equal(quoted.overlap_pct, 0);
});

test('Python CLI and application gates agree and return nonzero for failure', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lawbuddy-gates-'));
  try {
    const memo = 'Furthermore, the fictional judge — wrote a short note.';
    const file = path.join(dir, 'memo.txt'); writeFileSync(file, memo);
    const run = spawnSync('python3', ['scripts/quality_gates.py', file], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    const actual = JSON.parse(run.stdout); const expected = checkQuality(memo);
    for (const key of ['pass', 'dash_hits', 'banned_phrases', 'overlap_pct']) assert.deepEqual(actual[key], expected[key]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('anchor extraction preserves exact characters and refuses ambiguous or invented spans', () => {
  const raw = 'The fictional court heard five witnesses,\nthen ordered another hearing for the applicant.';
  const ws = raw.split(/\s+/);
  assert.equal(quoteFromAnchors(raw, ws.slice(0, 5).join(' '), ws.slice(-5).join(' ')), raw);
  assert.equal(quoteFromAnchors(raw, ws.slice(0, 5).join(' '), ws.slice(-5).join(' ').replace(/\.$/, '')), raw);
  assert.equal(quoteFromAnchors(raw, 'Invented words cannot become evidence', ws.slice(-5).join(' ')), null);
  assert.equal(quoteFromAnchors(`${raw} ${raw}`, ws.slice(0, 5).join(' '), ws.slice(-5).join(' ')), null);
  assert.throws(() => numberedParagraphs('1. First text.\n1. Duplicate text.'), /repeated/);
  const chunks = chunkParagraphs([{ para: '1', text: 'one two three' }, { para: '2', text: 'four five six' }], 4);
  assert.equal(chunks.length, 2); assert.equal(chunks[0][0].text, 'one two three');
});

test('Ollama sets schema, context, seed and temperature without a client timeout', async () => {
  const result = await generateReportText({ provider: 'ollama', stage: 'verify', systemPrompt: 'Check evidence.', prompt: 'Small input.',
    temperature: 0, seed: 7, returnMetadata: true, options: { OLLAMA_MODEL: 'fixture-model', fetchFn: async (_url, init) => {
      assert.equal(init.signal, undefined); const body = JSON.parse(init.body);
      assert.equal(body.options.num_ctx, 16384); assert.equal(body.options.temperature, 0); assert.equal(body.options.seed, 7);
      assert.equal(body.format.type, 'object'); assert.equal(body.keep_alive, '2h');
      return { ok: true, json: async () => ({ message: { content: '{}' }, prompt_eval_count: 15 }) };
    } } });
  assert.equal(result.meta.promptTokens, 15); assert.equal(result.meta.model, 'fixture-model');
  await assert.rejects(() => generateReportText({ provider: 'ollama', systemPrompt: 'x', prompt: 'x'.repeat(20000), options: { fetchFn: () => { throw new Error('must not send'); } } }), /context budget/);
});

test('prose stages omit JSON mode and invalid Groq JSON exposes a private failure record before retry', async () => {
  let calls = 0;
  const result = await generateReportText({ provider: 'groq', systemPrompt: 'Extract.', prompt: 'fixture', returnMetadata: true, options: {
    GROQ_API_KEY: 'fixture', fetchFn: async (_url, init) => {
      calls++; const body = JSON.parse(init.body); assert.match(body.messages[0].content, /JSON/);
      assert.equal(body.max_completion_tokens, 6000);
      if (calls === 1) return { ok: false, status: 400, json: async () => ({ error: { failed_generation: '{broken' } }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    },
  } });
  assert.equal(calls, 2); assert.equal(result.meta.failures[0].failed_generation, '{broken');
  await generateReportText({ provider: 'groq', mode: 'prose', systemPrompt: 'Write.', prompt: 'fixture', options: { GROQ_API_KEY: 'fixture', fetchFn: async (_url, init) => {
    assert.equal(JSON.parse(init.body).response_format, undefined);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Plain prose.' } }] }) };
  } } });
  assert.deepEqual(parseJson('Preface ```json\n{"a":"a brace } within text"}\n```'), { a: 'a brace } within text' });
});
