/**
 * Who wrote which part of a reported Supreme Court judgment.
 *
 * A Supreme Court Reports PDF opens with the reporter's headnote (which also
 * records each judge's stance: "BEG, C. J., (Concurring with Bhagwati, J.)",
 * "Kailasam, J. (Dissenting)") and then prints each opinion under its judge's
 * name in capitals ("BHAGWATI, J.-The Petitioner is…", or, in recent reports,
 * the name alone on a line), or, for a single judgment, after "The Judgment of
 * the Court was delivered by …". Recent reports also head every page with its
 * author ("[DR. D. Y. CHANDRACHUD, J.]") and close with an "ORDER OF THE COURT"
 * that all judges join, naming whose judgment was delivered on behalf of whom.
 *
 * The leading opinion is the one delivered for the Court; failing that, the one
 * the most judges concur with; failing that, the longest. A brief's "held"
 * points must come from it (or the official headnote), never from a dissent
 * that happens to be printed last.
 *
 * Names are OCR'd ("KAI ASAM", "KRISHNA lYE!~"), so when the coram is known
 * (from the Court's own record) every name found is matched to the nearest
 * coram judge, which also gives the reader the judge's proper name.
 */

const TITLE = String.raw`(C\.\s*J\.?(?:I\.?)?|J\.)`;
const STANCE = new RegExp(String.raw`^([A-Z][A-Za-z.'\s]{1,40}?),?\s*${TITLE}\s*,?\s*\(\s*(Concurring|Dissenting|Partly\s+dissenting)([^)]*)\)`, 'i');
const DELIVERED = new RegExp(String.raw`Judgment of the Court was delivered by\s+([A-Z][A-Za-z.'\s]{1,40}?),?\s*${TITLE}`, 'i');
// OCR damages names ("KRISHNA lYE!~, J.-"), so the name may hold stray marks; it must still be mostly capitals.
// The opinion's first word follows: "The …", or the one-letter "I regret…".
const OPINION_START = new RegExp(String.raw`^([A-Z][A-Za-z.'!~|\s]{2,40}?),\s*${TITLE}\s*[-—–:.]?\s*(?=[A-Z](?:[a-z]|\s))`);
// "[DR. D. Y. CHANDRACHUD, J.]" in a page's first lines: who wrote this page (OCR varies the punctuation).
const RUNNING_HEAD = new RegExp(String.raw`^\[\s*((?:DR\.?\s*)?[A-Z][A-Za-z.'\s]{2,45}?)[,.;]\s*(C\.?\s*J\.?I?|J)[.,;:]?\s*\]$`);
// An opinion heading on its own line ("DR. D. Y. CHANDRACHUD, J."); "PER …" lines are the headnote's summaries.
const NAME_ALONE = new RegExp(String.raw`^(?:[A-H]\s+)?((?:DR\.?\s*)?[A-Z][A-Z.'\s]{2,45}?)[,.;]\s*(C\.?\s*J\.?I?|J)[.,;:]?\s*$`);
const COURT_ORDER = /^ORDER OF THE COURT$/i;
const DELIVERED_ON_BEHALF = /judgment on behalf of[\s\S]{0,400}?was delivered by\s+(?:Dr\.?\s+)?(?:Shri\s+)?(?:Justice\s+)?([A-Z][A-Za-z.\s]{2,40}?)[.,]/i;
export const COURT_ORDER_KEY = 'court-order';
const HEAD_LINES = 3;
const CONCURS_WITH = /(?:concurring with|agree(?:s|d)?(?:\s+(?:entirely|fully|respectfully))?\s+with(?:\s+my)?(?:\s+learned)?(?:\s+brother)?(?:\s+the\s+(?:judgment|opinion)\s+of)?)\s+([A-Z][a-z]+)/g;

/** A judge's matching key without a coram: the first name-word of three or more letters ("M. H. BEG" → "beg"). */
export const judgeKey = (name) =>
  (String(name).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).find((word) => word.length >= 3) || '').trim();

const letters = (text) => String(text).toLowerCase().replace(/[^a-z]/g, '');

const editDistance = (a, b) => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
};

const MAX_NAME_DISTANCE = 0.34;

/**
 * Matches an OCR'd name to the nearest coram judge: against the full name, each surname-length word
 * and each pair of words ("lYE!~" → "KRISHNA IYER"). Returns the coram index, or -1.
 */
export const matchCoram = (name, coram) => {
  const found = letters(name);
  if (found.length < 3) return -1;
  let best = { index: -1, score: Infinity };
  coram.forEach((judge, index) => {
    const words = String(judge).split(/[\s.]+/).filter((word) => word.length >= 3);
    const forms = [judge, ...words, ...words.slice(1).map((word, i) => `${words[i]} ${word}`)];
    for (const form of forms) {
      const target = letters(form);
      const score = editDistance(found, target) / Math.max(found.length, target.length);
      if (score < best.score) best = { index, score };
    }
  });
  return best.score <= MAX_NAME_DISTANCE ? best.index : -1;
};

const titleWord = (word) => (word.length > 2 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toUpperCase());

const displayName = (name, title) => {
  const words = String(name).replace(/[^A-Za-z.\s]/g, ' ').split(/[\s.]+/).filter((word) => word.length > 1);
  return `${words.map(titleWord).join(' ')} ${/C/.test(title) ? 'CJ' : 'J'}`;
};

const upperShare = (text) => {
  const letters = text.replace(/[^A-Za-z]/g, '');
  return letters ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0;
};

/**
 * @param {{ page: number, lines: { text: string }[] }[]} pages
 * @returns {{ opinions: { key: string, name: string, page: number, line: number }[],
 *   leading: string|null, dissenting: string[] }}
 */
export const parseOpinions = (pages, { coram = [] } = {}) => {
  const opinions = [];
  const dissenting = new Set();
  const concurrences = new Map();
  let delivered = null;

  // With a coram, a judge is known by their place in it; without one, by a name-word.
  const identify = (rawName, title = 'J.') => {
    const name = String(rawName).replace(/^DR\.?\s*/i, '');
    if (coram.length) {
      const index = matchCoram(name, coram);
      return index === -1 ? null : { key: `coram:${index}`, name: displayName(coram[index], title) };
    }
    const key = judgeKey(name);
    return key ? { key, name: displayName(name, title) } : null;
  };
  const concur = (target) => {
    const judge = identify(target);
    if (judge) concurrences.set(judge.key, (concurrences.get(judge.key) || 0) + 1);
  };

  const startOpinion = (judge, page, line) => {
    if (judge && opinions.at(-1)?.key !== judge.key) opinions.push({ ...judge, page, line });
  };

  for (const page of pages) {
    page.lines.forEach((line, index) => {
      const head = index < HEAD_LINES ? RUNNING_HEAD.exec(String(line.text).trim()) : null;
      if (head) {
        startOpinion(identify(head[1], head[2]), page.page, index);
        return;
      }
      if (COURT_ORDER.test(String(line.text).trim())) {
        opinions.push({ key: COURT_ORDER_KEY, name: 'Order of the Court', page: page.page, line: index });
        return;
      }
      // Supreme Court Reports print margin letters (A–H) at the start of some lines.
      const text = String(line.text).trim().replace(/^[A-H]\s+(?=[A-Z])/, '');
      const stance = STANCE.exec(text);
      if (stance) {
        const judge = identify(stance[1], stance[2]);
        if (judge && /dissent/i.test(stance[3])) dissenting.add(judge.key);
        const target = /with\s+([A-Z][a-z]+)/.exec(stance[4] || '');
        if (target) concur(target[1]);
        return;
      }
      const deliveredBy = DELIVERED.exec(text);
      const deliveredJudge = deliveredBy && identify(deliveredBy[1], deliveredBy[2]);
      if (deliveredJudge) {
        delivered = deliveredJudge.key;
        opinions.push({ ...deliveredJudge, page: page.page, line: index });
        return;
      }
      const start = OPINION_START.exec(text);
      const author = start && upperShare(start[1]) > 0.7 ? identify(start[1], start[2]) : null;
      if (author) {
        opinions.push({ ...author, page: page.page, line: index });
        return;
      }
      // "PER …" (OCR'd as "PERR. F. NARIMAN", "'PERADHAY…", ". PER …") introduces a headnote summary.
      const alone = /^\W*PER/i.test(text) ? null : NAME_ALONE.exec(text);
      if (alone && upperShare(alone[1]) > 0.8) startOpinion(identify(alone[1], alone[2]), page.page, index);
    });
    const pageText = page.lines.map((line) => line.text).join(' ');
    for (const match of pageText.matchAll(CONCURS_WITH)) concur(match[1]);
    const onBehalf = DELIVERED_ON_BEHALF.exec(pageText);
    if (onBehalf && !delivered) delivered = identify(onBehalf[1])?.key ?? null;
  }

  const authors = new Set(opinions.map((opinion) => opinion.key).filter((key) => key !== COURT_ORDER_KEY));
  let leading = delivered;
  if (!leading) {
    const backed = [...concurrences.entries()].filter(([key]) => authors.has(key)).sort((a, b) => b[1] - a[1]);
    leading = backed[0]?.[0] ?? null;
  }
  if (!leading && authors.size) {
    const lastPage = pages.at(-1)?.page ?? 0;
    const spans = opinions
      .map((opinion, index) => ({ key: opinion.key, pages: (opinions[index + 1]?.page ?? lastPage + 1) - opinion.page }))
      .filter((span) => span.key !== COURT_ORDER_KEY);
    leading = spans.sort((a, b) => b.pages - a.pages)[0].key;
  }
  return { opinions, leading, dissenting: [...dissenting] };
};

/**
 * The part of the report a line belongs to: the headnote and arguments before the first opinion, or
 * the opinion that began most recently (opinions often change mid-page), with its role.
 */
export const opinionOnPage = ({ opinions, leading, dissenting }, page, line = Infinity) => {
  const current = opinions.filter((opinion) => opinion.page < page || (opinion.page === page && opinion.line <= line)).at(-1);
  if (!current) return { role: opinions.length ? 'headnote' : 'judgment', name: null };
  if (current.key === COURT_ORDER_KEY) return { role: 'order', name: current.name };
  const role = current.key === leading ? 'leading' : dissenting.includes(current.key) ? 'dissenting' : 'separate';
  return { role, name: current.name };
};
