import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseJson, validSchema } from './json.js';
import { providerSettings } from './provider.js';

export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export const writePrivate = async (file, value) => {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
};
export const writePrivateAsync = writePrivate;

const DEFAULT_RETENTION_MS = (Number(process.env.REPORT_CHECKPOINT_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;

export const pruneOldReportRuns = async (root, maxAgeMs = DEFAULT_RETENTION_MS) => {
  if (!root || !existsSync(root)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(root, entry.name);
      try {
        const stats = await fs.stat(dirPath);
        if (stats.mtimeMs < cutoff) {
          await fs.rm(dirPath, { recursive: true, force: true });
          pruned += 1;
        }
      } catch {}
    }
  } catch {}
  return pruned;
};
export const pruneOldReportRunsAsync = pruneOldReportRuns;

export const createStageRunner = ({ input, generate, config, options = {} }) => {
  const runId = input.resumeRunId || randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw Object.assign(new Error('Invalid resume run ID.'), { statusCode: 400 });
  const root = options.checkpointDir === false ? null : path.resolve(options.checkpointDir || process.env.REPORT_CHECKPOINT_DIR || (existsSync('.advocatevox/report-runs') ? '.advocatevox/report-runs' : '.lawbuddy/report-runs'));
  const dir = root && path.join(root, runId);
  const { resumeRunId, ...request } = input;
  const settings = Object.fromEntries(['ollama', 'groq', 'grok'].map((p) => [p, providerSettings(p, options)]));
  const requestHash = hash({ request, config, settings });
  if (input.resumeRunId && (!dir || !existsSync(path.join(dir, 'manifest.json')))) throw Object.assign(new Error('Saved report run not found.'), { statusCode: 404 });
  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneOldReportRuns(root).catch(() => {});
    const manifest = path.join(dir, 'manifest.json');
    if (existsSync(manifest)) {
      if (JSON.parse(readFileSync(manifest, 'utf8')).requestHash !== requestHash) throw Object.assign(new Error('Resume requires the same request, source texts and model settings.'), { statusCode: 409 });
    } else {
      writePrivate(manifest, { runId, requestHash, createdAt: new Date().toISOString(), config, settings, input: request }).catch(() => {});
    }
  }
  const records = [];
  const call = async ({ stage, key = stage, provider = input.provider, payload, system, schema, seed = config.seed }) => {
    const temperature = config.temperatures[stage] ?? 0;
    const prompt = JSON.stringify(payload);
    const promptHash = hash({ system, prompt, schema, temperature, seed, model: settings[provider].model, version: config.version });
    const file = dir && path.join(dir, `${hash(`${provider}:${key}:${promptHash}`)}.json`);
    if (file && existsSync(file)) {
      try {
        const cachedRaw = await fs.readFile(file, 'utf8');
        const cached = JSON.parse(cachedRaw);
        if (cached.status === 'complete' && validSchema(cached.output, schema)) {
          const { failures, ...publicMeta } = cached.meta;
          records.push({ ...publicMeta, jsonFailures: failures?.length || 0, cacheHit: true });
          return cached.output;
        }
      } catch {}
    }
    const meta = { key, stage, provider, model: settings[provider].model, temperature, seed, promptHash,
      retrieverVersion: config.retrieverVersion, startedAt: new Date().toISOString() };
    try {
      const generated = await generate({ stage, systemPrompt: system, prompt, schema, mode: 'json', provider,
        temperature, seed, returnMetadata: true });
      const raw = typeof generated === 'string' ? generated : generated?.text || '';
      const output = parseJson(raw);
      const record = { status: validSchema(output, schema) ? 'complete' : 'invalid-schema', meta: { ...meta, ...generated?.meta, finishedAt: new Date().toISOString() }, system, payload, raw, output };
      if (file) await writePrivate(file, record);
      // Public metadata excludes failed_generation text; private stage files retain it for diagnosis.
      const { failures, ...publicMeta } = record.meta;
      records.push({ ...publicMeta, jsonFailures: failures?.length || 0 });
      if (record.status !== 'complete') throw Object.assign(new Error(`Stage ${key} returned invalid JSON or schema. Resume this run to retry.`), { statusCode: 502 });
      return output;
    } catch (error) {
      if (file && !existsSync(file)) {
        await writePrivate(file, { status: 'failed', meta, error: error.message, failures: error.stageFailures || [] }).catch(() => {});
      }
      error.runId = runId;
      throw error;
    }
  };
  return {
    runId,
    records,
    call,
    save: (name, data) => (dir ? writePrivate(path.join(dir, `${hash(name)}.json`), data).catch(() => {}) : Promise.resolve()),
  };
};
