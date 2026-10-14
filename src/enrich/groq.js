/**
 * Minimal Groq chat client for ingest-time extraction that must return JSON.
 * Rate limits (429) and overload (503) are retried after the server's
 * Retry-After (bounded); dropped connections and timeouts are retried; an empty
 * or unparseable answer is retried too, since reasoning models occasionally end
 * a turn with no visible content.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const RETRYABLE = new Set([429, 500, 502, 503]);
const MAX_WAIT_MS = 60_000;

const waitFor = (response, attempt) => {
  const header = Number(response?.headers?.get?.('retry-after'));
  const ms = Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, MAX_WAIT_MS);
};

export const groqJson = async ({
  apiKey,
  model,
  system,
  user,
  maxTokens = 4096,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 4,
  timeoutMs = 120_000,
  reasoningEffort = 'low',
}) => {
  if (!apiKey) throw new Error('GROQ_API_KEY is not set; it is needed to prepare case briefs.');
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0,
          max_completion_tokens: maxTokens,
          reasoning_effort: reasoningEffort,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A dropped connection or timeout: worth another attempt, like an overloaded server.
      lastError = error;
      await sleep(waitFor(null, attempt));
      continue;
    }

    if (RETRYABLE.has(response.status)) {
      lastError = new Error(`Groq HTTP ${response.status}`);
      await response.body?.cancel();
      await sleep(waitFor(response, attempt));
      continue;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`Groq HTTP ${response.status}: ${body?.error?.message || response.statusText}`);
    }

    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content?.trim();
    try {
      if (content) return { data: JSON.parse(content), model: body.model || model, usage: body.usage || null };
      lastError = new Error('Groq returned an empty answer');
    } catch {
      lastError = new Error('Groq returned JSON that could not be parsed');
    }
    await sleep(waitFor(null, attempt));
  }
  throw lastError ?? new Error('Groq request failed');
};
