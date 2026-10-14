/**
 * Checks a finished law-mode answer against the evidence it was given, so the reader can see what is
 * verified rather than take the model's word for it:
 *   - every citation tag ("[BNS s.38]", "[Article 21]", "[BNSS s.47(1)]") must name a provision that was
 *     retrieved for this answer;
 *   - every quotation ("…" or "…" of five words or more) must be found in the official text of the
 *     provisions retrieved: word for word, or (for a quotation that spans a line break or a dash) with at
 *     least 90% of its words in order within the text.
 * Nothing here can make an answer correct; it can only show which statements are tied to the law.
 */

const MIN_QUOTE_WORDS = 5;
const MIN_FUZZY_MATCH = 0.9;
// What may follow a quotation in the official text that changes its meaning: quoting up to just before
// it ("no right of private defence against an act which does not … grievous hurt" | ", if done … by a
// public servant") turns a narrow rule into a general one.
const QUALIFIER = /^[\s,;:—–-]*(?:if\b|unless\b|except\b|provided\b|only\b|by (?:the direction of )?a public servant\b|where\b|when\b|subject to\b|save\b|so long as\b|in (?:cases|the case) (?:in )?which\b)/i;

/** The words that follow `quoted` in `text`, when they open with a qualifier; null otherwise. */
export const qualifierAfter = (quoted, text) => {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const lastWords = words(quoted).slice(-6).join('\\W+');
  if (!lastWords) return null;
  const match = new RegExp(`${lastWords}\\W*?(?=[\\s,;:—–-])`, 'i').exec(flat);
  if (!match) return null;
  const rest = flat.slice(match.index + match[0].length);
  if (!QUALIFIER.test(rest)) return null;
  return rest.replace(/^[\s,;:—–-]+/, '').split(/[;.](?:\s|$)/)[0].split(/\s+/).slice(0, 16).join(' ');
};

const words = (text) => (String(text || '').toLowerCase().normalize('NFKC').match(/[a-z0-9]+/g) || []);

/** The sub-section a tag names ("[BNS s.37(2)]" → "2"), or null. */
const subSectionOf = (raw) => /\d[A-Z]?\s*\(\s*(\d{1,2}[A-Z]?)\s*\)/i.exec(String(raw || ''))?.[1] ?? null;

/** "[BNS s. 37(2)]" → "BNS s.37"; "[Art. 21]" / "[Article 21(1)]" → "Article 21"; unknown shapes → null. */
export const normalizeTag = (raw) => {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const section = /^(BNSS|BNS|BSA|IPC|CrPC|IEA)\s*(?:s\.?|sec\.?|section)\s*(\d{1,3}[A-Z]?)/i.exec(text)
    || /^(?:s\.?|sec\.?|section)\s*(\d{1,3}[A-Z]?)\s*(?:of\s+(?:the\s+)?)?(BNSS|BNS|BSA|IPC|CrPC|IEA)\b/i.exec(text);
  if (section) {
    const [act, number] = /^\d/.test(section[1]) ? [section[2], section[1]] : [section[1], section[2]];
    return `${act.toUpperCase().replace('CRPC', 'CrPC')} s.${number.toUpperCase()}`;
  }
  const article = /^(?:Article|Art\.?)\s*(\d{1,3}[A-Z]{0,2})/i.exec(text);
  return article ? `Article ${article[1].toUpperCase()}` : null;
};

const evidenceTag = (item) => (item.act && item.act !== 'COI'
  ? `${item.act} ${item.label}`
  : item.label?.startsWith('Art.') ? `Article ${item.label.slice(4)}` : null);

/** Longest in-order match of `needle` within `hay` (word lists), as a share of the needle. */
const inOrderShare = (needle, hay) => {
  if (!needle.length) return 0;
  // Anchor on each occurrence of the first two words, then walk forward greedily.
  let best = 0;
  for (let start = 0; start < hay.length; start += 1) {
    if (hay[start] !== needle[0] && hay[start] !== needle[1]) continue;
    let matched = 0;
    let position = start;
    const limit = start + Math.ceil(needle.length * 1.5);
    for (const word of needle) {
      const found = hay.indexOf(word, position);
      if (found === -1 || found > limit) continue;
      matched += 1;
      position = found + 1;
    }
    best = Math.max(best, matched / needle.length);
  }
  return best;
};

/**
 * @param {string} answer the model's finished answer
 * @param {Array<{kind: string, act?: string, label?: string, title: string, content: string}>} evidence
 */
export const checkLegalAnswer = (answer, evidence) => {
  const statutes = (evidence || []).filter((item) => item.kind === 'statute');
  const byTag = new Map(statutes.map((item) => [evidenceTag(item), item]).filter(([tag]) => tag));

  const seenTags = new Set();
  const citations = [];
  for (const [, raw] of String(answer || '').matchAll(/\[([^\]\n]{2,60})\]/g)) {
    for (const part of raw.split(/\s*[;,]\s*(?=(?:BNSS|BNS|BSA|Art|Article|s\.|section)\b)/i)) {
      const tag = normalizeTag(part);
      if (!tag) continue;
      const item = byTag.get(tag);
      // A cited sub-section must exist: "s.101(2)" for Exception 2 of s.101 names a sub-section the text lacks.
      const sub = subSectionOf(part);
      const missingSub = Boolean(item && sub && !new RegExp(`(?:^|\\n)\\(${sub}\\)`).test(item.content));
      const key = `${tag}${missingSub ? `(${sub})` : ''}`;
      if (seenTags.has(key)) continue;
      seenTags.add(key);
      citations.push({
        tag: missingSub ? `${tag}(${sub})` : tag,
        ok: Boolean(item) && !missingSub,
        title: item?.title ?? null,
        ...(missingSub ? { problem: `${tag} has no sub-section (${sub}) in the official text` } : {}),
      });
    }
  }

  const texts = statutes.map((item) => ({ item, words: words(item.content) }));
  const quotes = [];
  // A quotation of the question ("territorial of 48 nautical miles of India") restates the facts, not the law.
  const asked = ` ${words(evidence?.analysis?.question).join(' ')} `;
  for (const match of String(answer || '').matchAll(/[“"]([^”"\n]{12,1200})[”"]/g)) {
    if (words(match[1]).length < MIN_QUOTE_WORDS) continue;
    if (asked.length > 2 && asked.includes(` ${words(match[1]).join(' ')} `)) continue;
    // "(a) against an act … (c) in cases in which…": each fragment must be in the same provision, in order.
    const fragments = match[1].split(/\s*(?:…|\.{3})\s*/).map(words).filter((fragment) => fragment.length);
    const located = (hay) => {
      const text = ` ${hay.join(' ')} `;
      let from = 0;
      for (const fragment of fragments) {
        const at = text.indexOf(` ${fragment.join(' ')} `, from);
        if (at === -1) return false;
        from = at + fragment.join(' ').length;
      }
      return true;
    };
    let source = texts.find(({ words: hay }) => located(hay));
    let exact = Boolean(source);
    if (!source) {
      const quoted = fragments.flat();
      const scored = texts.map((text) => ({ ...text, share: inOrderShare(quoted, text.words) })).sort((a, b) => b.share - a.share);
      if (scored[0]?.share >= MIN_FUZZY_MATCH) source = scored[0];
      exact = false;
    }
    const cutBefore = source && exact ? qualifierAfter(fragments.at(-1).join(' '), source.item.content) : null;
    quotes.push({
      text: match[1], ok: Boolean(source), exact, source: source ? evidenceTag(source.item) : null,
      ...(cutBefore ? { cutBefore } : {}),
    });
  }

  return {
    citations,
    quotes,
    verifiedCitations: citations.filter((citation) => citation.ok).length,
    verifiedQuotes: quotes.filter((quote) => quote.ok).length,
    cutQuotes: quotes.filter((quote) => quote.cutBefore).length,
    ok: citations.every((citation) => citation.ok) && quotes.every((quote) => quote.ok && !quote.cutBefore),
  };
};
