/**
 * Small dependency-free helpers for reading simple, well-formed official
 * HTML tables (e.g. NCRB Sankalan correspondence tables) as plain text.
 */

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…',
  // Seen in the Supreme Court's own listing rows; a soft hyphen is a line-break hint, not text.
  bull: '•', middot: '·', shy: '', laquo: '«', raquo: '»', sect: '§', para: '¶', times: '×', deg: '°',
});

export const decodeEntities = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });

const toText = (html) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Returns every table row as an array of cells; each cell is an array of its
 * non-empty paragraphs (split on </p> and <br>), as plain text.
 */
export const extractTableRows = (html) => {
  const cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');

  const rows = [];
  for (const [, rowHtml] of cleaned.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const [, tag, cellHtml] of rowHtml.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      cells.push({
        header: tag.toLowerCase() === 'th',
        paragraphs: cellHtml.split(/<\/p>|<br\s*\/?>/i).map(toText).filter(Boolean),
      });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
};
