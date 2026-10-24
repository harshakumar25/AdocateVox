import { REPORT_CONFIG } from './config.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s) => String(s).toLowerCase().match(/[a-z0-9']+/g) || [];
export const bodyOnly = (text) => String(text).split(/^(?:INDEXED OFFICIAL SOURCES|SOURCE LEDGER)\s*$/mi)[0];
export const maskQuotes = (text) => String(text).replace(/“[^”]*”|"[^"]*"/g, ' ').replace(/\[(?:S\d+|C\d+(?:-\d+)?)(?:,\s*(?:S\d+|C\d+(?:-\d+)?))*\]/g, ' ');
const shingles = (tokens, n) => new Set(tokens.slice(0, Math.max(0, tokens.length - n + 1)).map((_, i) => tokens.slice(i, i + n).join(' ')));
export const checkQuality = (memo, sources = [], config = REPORT_CONFIG) => {
  const body = bodyOnly(memo);
  const dashHits = [...body.matchAll(/[\u2012-\u2015\u2212]|--+/g)].map((m) => ({ offset: m.index, text: m[0] }));
  const banned = new RegExp(`\\b(?:${config.bannedPhrases.map(escape).join('|')})\\b`, 'gi');
  const phraseHits = config.bannedPhrases.length ? [...body.matchAll(banned)].map((m) => ({ offset: m.index, text: m[0] })) : [];
  const mine = shingles(words(maskQuotes(body)), config.shingleWords);
  const theirs = new Set(sources.flatMap((s) => [...shingles(words(typeof s === 'string' ? s : s.text), config.shingleWords)]));
  const matching = [...mine].filter((s) => theirs.has(s));
  const ratio = mine.size ? matching.length / mine.size : 0;
  return { pass: !dashHits.length && !phraseHits.length && ratio <= config.maxOverlap,
    dash_hits: dashHits.length, banned_phrases: [...new Set(phraseHits.map((h) => h.text.toLowerCase()))].sort(),
    overlap_pct: Math.round(ratio * 1000) / 10, overlapRatio: ratio, maxOverlap: config.maxOverlap,
    matchingShingles: matching, dashHits, phraseHits,
    scope: 'Generated prose against supplied and retrieved source text; quotations and source ledger excluded from overlap.' };
};

// Return only generated sentences that need work. Evidence text is never rewritten.
export const failingClaims = (claims, sources, config = REPORT_CONFIG) => {
  const whole = checkQuality(claims.map((c) => c.text).join('\n'), sources, config);
  return claims.filter((claim) => {
    const result = checkQuality(claim.text, sources, config);
    return result.dash_hits || result.banned_phrases.length || (whole.overlapRatio > config.maxOverlap && result.matchingShingles.length);
  }).map((claim) => ({ ...claim, quality: checkQuality(claim.text, sources, config) }));
};
