/**
 * Minimal robots.txt evaluator (RFC 9309): user-agent groups, Allow/Disallow
 * with "*" and "$" patterns, longest-match precedence, plus Crawl-delay.
 */

const patternToRegex = (pattern) => {
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`);
};

/**
 * @param {string} text robots.txt body
 * @param {string} productToken our crawler's product token, e.g. "LawBuddyBot"
 * @returns {{ isAllowed: (pathAndQuery: string) => boolean, crawlDelayMs: number|null }}
 */
export const parseRobots = (text, productToken) => {
  const groups = [];
  let current = null;
  let previousWasAgent = false;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (!line || separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'user-agent') {
      if (!current || !previousWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }

    previousWasAgent = false;
    if (!current) continue;

    if ((key === 'allow' || key === 'disallow') && value) {
      current.rules.push({ allow: key === 'allow', length: value.length, regex: patternToRegex(value) });
    } else if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }

  const token = productToken.toLowerCase();
  let applicable = groups.filter((group) => group.agents.includes(token));
  if (applicable.length === 0) {
    applicable = groups.filter((group) => group.agents.includes('*'));
  }

  const rules = applicable.flatMap((group) => group.rules);
  const delays = applicable.map((group) => group.crawlDelay).filter((delay) => delay !== null);

  const isAllowed = (pathAndQuery) => {
    if (pathAndQuery === '/robots.txt') return true;
    let best = null;
    for (const rule of rules) {
      if (!rule.regex.test(pathAndQuery)) continue;
      if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) {
        best = rule;
      }
    }
    return best ? best.allow : true;
  };

  return { isAllowed, crawlDelayMs: delays.length ? Math.max(...delays) * 1000 : null };
};
