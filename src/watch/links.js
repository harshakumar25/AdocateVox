/**
 * Link extraction for listing pages: every <a href> as an absolute URL plus
 * its visible text. Tolerates the sloppy markup real index pages carry
 * (unquoted values, a missing space before the next attribute).
 */

import { decodeEntities } from '../parse/html.js';

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

const toText = (html) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * @param {string} html listing page body
 * @param {string} baseUrl the page's own URL, for resolving relative links
 * @returns {{ url: string, text: string }[]} unique http(s) URLs, fragment removed, first text kept
 */
export const extractLinks = (html, baseUrl) => {
  const cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');

  const links = new Map();
  for (const [, attributes, inner] of cleaned.matchAll(ANCHOR)) {
    const href = HREF.exec(attributes);
    if (!href) continue;
    const raw = decodeEntities(href[1] ?? href[2] ?? href[3]).trim();

    let url;
    try {
      url = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    url.hash = '';

    if (!links.has(url.href)) links.set(url.href, { url: url.href, text: toText(inner) });
  }
  return [...links.values()];
};
