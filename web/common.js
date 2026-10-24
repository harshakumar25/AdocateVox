// Shared helpers for the LawBuddy pages. All untrusted text goes through
// textContent (never innerHTML) and every link is protocol-checked.

/** Creates an element with optional class, text and attributes. */
export const el = (tag, { className, text, attrs } = {}, children = []) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value !== undefined && value !== null && value !== false) node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
};

export const isSafeUrl = (url) => {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

/** An external link that opens safely, or plain text when the URL is not http(s). */
export const safeLink = (url, text) =>
  isSafeUrl(url)
    ? el('a', { text, attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } })
    : el('span', { text });

const SCHEDULES = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth'];

/** "Art.21A" → "Article 21A", "Sch.7" → "Seventh Schedule", "Preamble" → "Preamble". */
export const humanLabel = (label) => {
  if (!label) return '';
  if (label.startsWith('Art.')) return `Article ${label.slice(4)}`;
  if (label.startsWith('Sch.')) return `${SCHEDULES[Number(label.slice(4)) - 1] || label} Schedule`;
  return label;
};

const DATE_FORMAT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const INDIA_TODAY = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

export const indiaToday = (instant = new Date()) => {
  const fields = Object.fromEntries(INDIA_TODAY.formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};

/** "1950-01-26" → "26 Jan 1950". */
export const formatDate = (iso) => {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DATE_FORMAT.format(parsed);
};

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
};
