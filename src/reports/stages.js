import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseJson, validSchema } from './json.js';
import { providerSettings } from './provider.js';

export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const writePrivate = (file, value) => {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
};

export const createStageRunner = ({ input, generate, config, options = {} }) => {
  const runId = input.resumeRunId || randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw Object.assign(new Error('Invalid resume run ID.'), { statusCode: 400 });
  const root = options.checkpointDir === false ? null : path.resolve(options.checkpointDir || process.env.REPORT_CHECKPOINT_DIR || '.lawbuddy/report-runs');
  const dir = root && path.join(root, runId);
  const { resumeRunId, ...request } = input;
  const settings = Object.fromEntries(['ollama', 'groq', 'grok'].map((p) => [p, providerSettings(p, options)]));
  const requestHash = hash({ request, config, settings });
  if (input.resumeRunId && (!dir || !existsSync(path.join(dir, 'manifest.json')))) throw Object.assign(new Error('Saved report run not found.'), { statusCode: 404 });
  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest = path.join(dir, 'manifest.json');
    if (existsSync(manifest)) {
      if (JSON.parse(readFileSync(manifest, 'utf8')).requestHash !== requestHash) throw Object.assign(new Error('Resume requires the same request, source texts and model settings.'), { statusCode: 409 });
    } else writePrivate(manifest, { runId, requestHash, createdAt: new Date().toISOString(), config, settings, input: request });
  }
  const records = [];
  const call = async ({ stage, key = stage, provider = input.provider, payload, system, schema, seed = config.seed }) => {
    const temperature = config.temperatures[stage] ?? 0;
    const prompt = JSON.stringify(payload);
    const promptHash = hash({ system, prompt, schema, temperature, seed, model: settings[provider].model, version: config.version });
    const file = dir && path.join(dir, `${hash(`${provider}:${key}:${promptHash}`)}.json`);
    if (file && existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, 'utf8'));
      if (cached.status === 'complete' && validSchema(cached.output, schema)) {
        const { failures, ...publicMeta } = cached.meta;
        records.push({ ...publicMeta, jsonFailures: failures?.length || 0, cacheHit: true }); return cached.output;
      }
    }
    const meta = { key, stage, provider, model: settings[provider].model, temperature, seed, promptHash,
      retrieverVersion: config.retrieverVersion, startedAt: new Date().toISOString() };
    try {
      const generated = await generate({ stage, systemPrompt: system, prompt, schema, mode: 'json', provider,
        temperature, seed, returnMetadata: true });
      const raw = typeof generated === 'string' ? generated : generated?.text || '';
      const output = parseJson(raw);
      const record = { status: validSchema(output, schema) ? 'complete' : 'invalid-schema', meta: { ...meta, ...generated?.meta, finishedAt: new Date().toISOString() }, system, payload, raw, output };
      if (file) writePrivate(file, record);
      // Public metadata excludes failed_generation text; private stage files retain it for diagnosis.
      const { failures, ...publicMeta } = record.meta;
      records.push({ ...publicMeta, jsonFailures: failures?.length || 0 });
      if (record.status !== 'complete') throw Object.assign(new Error(`Stage ${key} returned invalid JSON or schema. Resume this run to retry.`), { statusCode: 502 });
      return output;
    } catch (error) {
      if (file && !existsSync(file)) writePrivate(file, { status: 'failed', meta, error: error.message, failures: error.stageFailures || [] });
      error.runId = runId; throw error;
    }
  };
  return { runId, records, call, save: (name, data) => { if (dir) writePrivate(path.join(dir, `${hash(name)}.json`), data); } };
};
