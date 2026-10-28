import { REPORT_CONFIG } from './config.js';
import { parseJson } from './json.js';

const sourceClaim = { type: 'object', properties: { text: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } }, quote: { type: 'string' } },
  required: ['text', 'evidenceIds', 'quote'], additionalProperties: false };
const reportProperties = Object.fromEntries(['executiveSummary', 'issues', 'applicableLaw', 'analysis', 'counterarguments', 'conclusion']
  .map((name) => [name, { type: 'array', items: sourceClaim }]));
const shortNote = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
reportProperties.nextSteps = { type: 'array', items: shortNote };
reportProperties.researchGaps = { type: 'array', items: shortNote };
const REPORT_SCHEMA = { type: 'object', properties: reportProperties, required: Object.keys(reportProperties), additionalProperties: false };

export const providerSettings = (provider, options = {}) => ({
  model: provider === 'ollama' ? options.OLLAMA_MODEL || process.env.OLLAMA_MODEL || 'qwen3:4b'
    : provider === 'groq' ? options.GROQ_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-20b'
      : options.XAI_MODEL || process.env.XAI_MODEL || 'grok-4.7',
  context: Number(options.REPORT_OLLAMA_CONTEXT || process.env.REPORT_OLLAMA_CONTEXT || REPORT_CONFIG.ollamaContext),
  seed: Number(options.REPORT_SEED ?? process.env.REPORT_SEED ?? REPORT_CONFIG.seed),
});

export const generateReportText = async ({ systemPrompt, prompt, provider, options = {}, schema = REPORT_SCHEMA,
  mode = 'json', temperature = 0, seed, returnMetadata = false, stage = 'report' }) => {
  if (!['ollama', 'groq', 'grok'].includes(provider)) throw new Error('Unsupported report provider.');
  const settings = providerSettings(provider, options);
  const jsonMode = mode === 'json';
  const system = jsonMode ? `${systemPrompt}\nReturn JSON only, matching the supplied schema.` : systemPrompt;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  // Conservative UTF-8 byte bound, not an invented exact tokenizer count. Log actual usage when returned.
  const promptTokenUpperBound = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 256;
  const outputTokens = provider === 'ollama' ? REPORT_CONFIG.ollamaOutputTokens : REPORT_CONFIG.cloudOutputTokens;
  if (provider === 'ollama' && (!Number.isInteger(settings.context) || settings.context < 4096
    || promptTokenUpperBound + outputTokens > settings.context)) {
    throw Object.assign(new Error(`Local prompt exceeds the configured context budget (${promptTokenUpperBound} token upper bound plus ${outputTokens} output tokens; context ${settings.context}). Use smaller chunks or increase REPORT_OLLAMA_CONTEXT.`), { statusCode: 422 });
  }
  const chosenSeed = seed ?? settings.seed;
  const key = provider === 'groq' ? options.GROQ_API_KEY || process.env.GROQ_API_KEY : options.XAI_API_KEY || process.env.XAI_API_KEY;
  if (provider !== 'ollama' && !key) throw Object.assign(new Error(`${provider} is not configured on this server.`), { statusCode: 400 });
  const failures = [];
  let body; let text = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let url; let request;
    if (provider === 'ollama') {
      url = `${(options.OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/chat`;
      request = { model: settings.model, messages, stream: false, think: false, keep_alive: '2h',
        ...(jsonMode ? { format: schema } : {}),
        options: { num_ctx: settings.context, num_predict: outputTokens, temperature, seed: chosenSeed } };
    } else if (provider === 'groq') {
      url = 'https://api.groq.com/openai/v1/chat/completions';
      request = { model: settings.model, messages, temperature, seed: chosenSeed, max_completion_tokens: outputTokens,
        ...(jsonMode ? { response_format: settings.model.startsWith('openai/gpt-oss-')
          ? { type: 'json_schema', json_schema: { name: 'lawbuddy_stage', strict: true, schema } } : { type: 'json_object' } } : {}) };
    } else {
      url = 'https://api.x.ai/v1/responses';
      request = { model: settings.model, input: messages, temperature, store: false, max_output_tokens: outputTokens,
        ...(jsonMode ? { text: { format: { type: 'json_object' } } } : {}) };
    }
    const response = await (options.fetchFn || fetch)(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(provider === 'ollama' ? {} : { Authorization: `Bearer ${key}` }) },
      body: JSON.stringify(request),
      // Local jobs may take hours. Cloud calls remain bounded; no browser-side timeout is imposed.
      ...(provider === 'ollama' ? {} : { signal: AbortSignal.timeout(120000) }) });
    body = await response.json().catch(() => ({}));
    const failed = body?.error?.failed_generation;
    if (!response.ok) {
      if (response.status === 429 && attempt < 2) {
        const wait = Number(response.headers?.get?.('retry-after') || 5);
        if (Number.isFinite(wait) && wait >= 0 && wait <= 30) {
          await (options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(wait * 1000);
          continue;
        }
      }
      if (jsonMode && typeof failed === 'string') {
        failures.push({ attempt, failed_generation: failed.slice(0, 30000) });
        const salvaged = parseJson(failed);
        if (salvaged) { text = JSON.stringify(salvaged); break; }
        if (attempt < 2) continue;
      }
      throw Object.assign(new Error(`Report model stage ${stage} failed (${response.status}).`), {
        statusCode: response.status === 401 ? 401 : 502, stageFailures: failures });
    }
    text = provider === 'ollama' ? body?.message?.content || ''
      : provider === 'groq' ? body?.choices?.[0]?.message?.content || ''
        : body?.output?.filter((item) => item.type === 'message').flatMap((item) => item.content || [])
          .filter((item) => item.type === 'output_text').map((item) => item.text).join('\n') || '';
    text = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!jsonMode || parseJson(text)) break;
    failures.push({ attempt, failed_generation: text.slice(0, 30000) });
  }
  const meta = { provider, model: body?.model || settings.model, temperature, seed: provider === 'grok' ? null : chosenSeed,
    promptTokenUpperBound, promptTokens: body?.prompt_eval_count ?? body?.usage?.prompt_tokens ?? body?.usage?.input_tokens ?? null,
    context: provider === 'ollama' ? settings.context : null, stage, failures };
  return returnMetadata ? { text, meta } : text;
};
