/**
 * What LawBuddy watches for changes, declared per source.
 *
 * A watchlist names one listing page and the pattern its documents' links
 * match. Every matching link becomes a watched document; each one is
 * revalidated on its own adaptive schedule between the bounds given here.
 * Only sources our bot may fetch belong here: sources that block bots
 * (sci.gov.in, indiacode.nic.in, legislative.gov.in, NCRB) stay manual-import.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const WATCHLISTS = Object.freeze([
  {
    id: 'yourlordships-bare-acts',
    sourceId: 'yourlordships',
    listingUrl: 'https://yourlordships.in/bare-acts/',
    documentPattern: /\/bare-acts\/[^/?#]+\.pdf$/i,
    // Each link's text ends with the page's "PDF Download" button label.
    cleanLabel: (text) => text.replace(/\s*PDF\s+Download$/i, ''),
    // Copies of Acts whose official text the library holds: checked automatically when new or changed.
    acts: { 'constitution-of-india.pdf': 'constitution' },
    listing: { minIntervalMs: 12 * HOUR, maxIntervalMs: 7 * DAY },
    documents: { minIntervalMs: DAY, maxIntervalMs: 30 * DAY },
  },
]);
