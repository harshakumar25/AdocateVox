const requestJson = async (url, init, timeoutMs, fetchFn = fetch) => {
  try {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body?.error?.message || `Model request failed (${response.status}).`), { statusCode: response.status === 401 ? 401 : 502 });
    return body;
  } catch (error) {
    if (error.name === 'TimeoutError') throw Object.assign(new Error('Report generation timed out.'), { statusCode: 504 });
    throw error;
  }
};

const sourceClaim = { type: 'object', properties: { text: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } }, quote: { type: 'string' } },
  required: ['text', 'evidenceIds', 'quote'], additionalProperties: false };
const reportProperties = Object.fromEntries(['executiveSummary', 'issues', 'applicableLaw', 'analysis', 'counterarguments', 'conclusion']
  .map((name) => [name, { type: 'array', items: sourceClaim }]));
const shortNote = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
reportProperties.nextSteps = { type: 'array', items: shortNote };
reportProperties.researchGaps = { type: 'array', items: shortNote };
const REPORT_SCHEMA = { type: 'object', properties: reportProperties, required: Object.keys(reportProperties), additionalProperties: false };

export const generateReportText = async ({ systemPrompt, prompt, provider, options = {} }) => {
  if (provider === 'grok') {
    const key = options.XAI_API_KEY || process.env.XAI_API_KEY;
    if (!key) throw Object.assign(new Error('Grok is not configured. Set XAI_API_KEY on the server or choose another model.'), { statusCode: 400 });
    const body = await requestJson('https://api.x.ai/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: options.XAI_MODEL || process.env.XAI_MODEL || 'grok-4.7',
        input: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        text: { format: { type: 'json_object' } }, store: false, max_output_tokens: 4000 }),
    }, 120000, options.fetchFn);
    return body?.output?.filter((item) => item.type === 'message').flatMap((item) => item.content || [])
      .filter((item) => item.type === 'output_text').map((item) => item.text).join('\n') || '';
  }
  if (provider === 'groq') {
    const key = options.GROQ_API_KEY || process.env.GROQ_API_KEY;
    if (!key) throw Object.assign(new Error('Groq is not configured on this server.'), { statusCode: 400 });
    const model = options.GROQ_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
    const body = await requestJson('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0.1, max_completion_tokens: 3000,
        response_format: model.startsWith('openai/gpt-oss-')
          ? { type: 'json_schema', json_schema: { name: 'lawbuddy_report', strict: true, schema: REPORT_SCHEMA } }
          : { type: 'json_object' },
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] }),
    }, 60000, options.fetchFn);
    return body?.choices?.[0]?.message?.content || '';
  }
  const host = (options.OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const body = await requestJson(`${host}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.OLLAMA_MODEL || process.env.OLLAMA_MODEL || 'qwen3:4b', stream: false, think: false, format: 'json',
      options: { num_predict: 2000 }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] }),
  }, 180000, options.fetchFn);
  return String(body?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
};
