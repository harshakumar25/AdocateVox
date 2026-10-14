/**
 * Registry of legal sources LawBuddy may fetch from.
 *
 * Tier decides what may be cited as evidence:
 *   0 = primary official (court, Gazette, India Code, legislative.gov.in) — citable.
 *   1 = official mirror / secondary (AWS Open Data mirror, SUVAS translations) — citable,
 *       linked back to the tier-0 original where one exists.
 *   2 = signal only (news) — never cited; only triggers a tier-0/1 fetch.
 * Hosts not listed here are never fetched.
 */

export const LEGAL_SOURCES = Object.freeze([
  {
    id: 'aws-sc-judgments',
    name: 'AWS Open Data: Indian Supreme Court Judgments (CC-BY-4.0)',
    tier: 1,
    baseUrl: 'https://indian-supreme-court-judgments.s3.ap-south-1.amazonaws.com',
    hosts: ['indian-supreme-court-judgments.s3.ap-south-1.amazonaws.com'],
    // Older reports are scanned page images with a text layer: Maneka Gandhi (1978) alone is 64 MB.
    maxBytes: 150 * 1024 * 1024,
  },
  {
    id: 'aws-hc-judgments',
    name: 'AWS Open Data: Indian High Court Judgments (CC-BY-4.0)',
    tier: 1,
    baseUrl: 'https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com',
    hosts: ['indian-high-court-judgments.s3.ap-south-1.amazonaws.com'],
    maxBytes: 150 * 1024 * 1024,
  },
  {
    id: 'sci',
    name: 'Supreme Court of India',
    tier: 0,
    baseUrl: 'https://www.sci.gov.in',
    hosts: ['sci.gov.in'],
  },
  {
    id: 'india-code',
    name: 'India Code (Legislative Department)',
    tier: 0,
    baseUrl: 'https://www.indiacode.nic.in',
    hosts: ['indiacode.nic.in'],
  },
  {
    id: 'legislative',
    name: 'Legislative Department, Ministry of Law and Justice',
    tier: 0,
    baseUrl: 'https://legislative.gov.in',
    hosts: ['legislative.gov.in'],
  },
  {
    id: 'egazette',
    name: 'e-Gazette of India (Directorate of Printing)',
    tier: 0,
    baseUrl: 'https://egazette.gov.in',
    hosts: ['egazette.gov.in'],
  },
  {
    id: 'sebi',
    name: 'Securities and Exchange Board of India',
    tier: 0,
    baseUrl: 'https://www.sebi.gov.in',
    hosts: ['sebi.gov.in'],
  },
  {
    id: 'mca',
    name: 'Ministry of Corporate Affairs',
    tier: 0,
    baseUrl: 'https://www.mca.gov.in',
    hosts: ['mca.gov.in'],
  },
  {
    id: 'nclat',
    name: 'National Company Law Appellate Tribunal',
    tier: 0,
    baseUrl: 'https://nclat.nic.in',
    hosts: ['nclat.nic.in'],
  },
  {
    id: 'ibbi',
    name: 'Insolvency and Bankruptcy Board of India (NCLT order mirror)',
    tier: 0,
    baseUrl: 'https://ibbi.gov.in',
    hosts: ['ibbi.gov.in'],
  },
  {
    // MHA's official "Sankalan" compilation of BNS/BNSS/BSA, their Gazette copies and the
    // old↔new correspondence tables. robots.txt disallows all crawlers: manual import only.
    id: 'ncrb',
    name: 'National Crime Records Bureau (MHA), Sankalan of New Criminal Laws',
    tier: 0,
    baseUrl: 'https://www.ncrb.gov.in',
    hosts: ['ncrb.gov.in'],
  },
  {
    id: 'law-commission',
    name: 'Law Commission of India',
    tier: 0,
    baseUrl: 'https://lawcommissionofindia.nic.in',
    hosts: ['lawcommissionofindia.nic.in'],
  },
  {
    // A judiciary-coaching site's "free download" bare acts: unofficial copies of unknown provenance
    // (all dated 28 Dec 2023 when first checked). Tier 2: a change here is a signal to re-check the
    // official text, and its Act list is a curriculum signal. Never evidence.
    id: 'yourlordships',
    name: 'Your Lordships (judiciary coaching) — bare act downloads, unofficial',
    tier: 2,
    baseUrl: 'https://yourlordships.in',
    hosts: ['yourlordships.in'],
  },
]);

/**
 * Returns the registered source that owns `url`, matching the exact host or
 * any subdomain of it (so "main.sci.gov.in" belongs to "sci.gov.in"), else null.
 */
export const findSourceForUrl = (url, sources = LEGAL_SOURCES) => {
  let hostname;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }

  return (
    sources.find((source) =>
      source.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)),
    ) || null
  );
};
