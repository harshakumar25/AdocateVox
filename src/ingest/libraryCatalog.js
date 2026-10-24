/**
 * Curated instrument identities, not a claim that their operative text has been ingested.
 * Each source points to an official listing or document. One canonical record may belong
 * to several practice topics; the library never duplicates its provisions by topic.
 */
import { isCitableOfficialSource } from '../sources/registry.js';

const INDIA_CODE = 'https://www.indiacode.nic.in';
const code = (handle) => `${INDIA_CODE}/indiacode/handle/123456789/${handle}?view_type=browse`;

export const PRACTICE_TOPICS = Object.freeze({
  corporate: 'Corporate and commercial',
  civil: 'Civil procedure and remedies',
  evidence: 'Evidence',
  competition: 'Competition',
  securities: 'Securities',
  trade: 'Foreign trade',
  labour: 'Labour and employment',
  ip: 'Intellectual property',
  consumer: 'Consumer',
  environment: 'Environment',
  banking: 'Banking and insurance',
  insolvency: 'Insolvency',
  'white-collar': 'White-collar offences',
  torts: 'Torts and civil liability',
  administrative: 'Administrative and public law',
  cyber: 'Cyber law',
  'cyber-security': 'Cybersecurity compliance',
  ecommerce: 'E-commerce',
  'social-media': 'Social media and intermediaries',
  'computer-crime': 'Computer crime',
  'data-protection': 'Data protection',
  telecom: 'Telecommunications',
});

const act = (id, title, year, actNumber, sourceUrl, topics, aliases = [], note = null, instrumentType = 'act', parentId = null) =>
  Object.freeze({ id, title, year, actNumber, sourceUrl, jurisdiction: 'IN', instrumentType, parentId, topics: Object.freeze(topics), aliases: Object.freeze(aliases), note });

export const PRACTICE_ACTS = Object.freeze([
  act('COI', 'Constitution of India', 1950, null, 'https://www.legislative.gov.in/static/uploads/2025/07/c9fe9c9b6840524844316f74bb1c556c.pdf', ['administrative', 'civil'], ['constitutional law', 'constitution'], 'Articles and schedules provide the public-law starting point; State and delegated instruments require separate review.'),
  act('ICA1872', 'Indian Contract Act, 1872', 1872, '9 of 1872', 'https://indiacode.gov.in/server/api/core/bitstreams/e7571d39-11a7-4a2c-86e3-c515ae43e617/content', ['corporate', 'civil'], ['contract act', 'indian contract act'], 'A central India Code PDF is identified, but this copy does not print an as-on edition date. Resolve amendments and effective dates before indexing its text.'),
  act('CPC1908', 'Code of Civil Procedure, 1908', 1908, '5 of 1908', code(2191), ['civil', 'torts', 'administrative'], ['cpc', 'civil procedure code']),
  act('IEA1872', 'Indian Evidence Act, 1872', 1872, '1 of 1872', `${INDIA_CODE}/bitstream/123456789/6819/1/indian_evidence_act_1872.pdf`, ['evidence', 'civil', 'computer-crime'], ['evidence act'], 'Historical code: check repeal, savings and the date of the proceeding against the Bharatiya Sakshya Adhiniyam.'),
  act('BSA2023', 'Bharatiya Sakshya Adhiniyam, 2023', 2023, '47 of 2023', 'https://egazette.gov.in/WriteReadData/2023/250882.pdf', ['evidence', 'civil', 'cyber', 'computer-crime'], ['bsa', 'new evidence law', 'electronic evidence']),
  act('BNS2023', 'Bharatiya Nyaya Sanhita, 2023', 2023, '45 of 2023', 'https://egazette.gov.in/WriteReadData/2023/250883.pdf', ['cyber', 'computer-crime', 'white-collar'], ['bns', 'criminal offences']),
  act('BNSS2023', 'Bharatiya Nagarik Suraksha Sanhita, 2023', 2023, '46 of 2023', 'https://egazette.gov.in/WriteReadData/2023/250884.pdf', ['cyber', 'computer-crime'], ['bnss', 'criminal procedure']),
  act('TPA1882', 'Transfer of Property Act, 1882', 1882, '4 of 1882', `${INDIA_CODE}/bitstream/123456789/14648/1/tpa.pdf`, ['civil'], ['tpa', 'property transfer act']),
  act('LA1963', 'Limitation Act, 1963', 1963, '36 of 1963', code(1565), ['civil', 'torts'], ['limitation act']),
  act('SRA1963', 'Specific Relief Act, 1963', 1963, '47 of 1963', code(1583), ['civil', 'torts', 'administrative'], ['specific relief']),
  act('CPA2019', 'Consumer Protection Act, 2019', 2019, '35 of 2019', `${INDIA_CODE}/bitstream/123456789/15276/1/210422.pdf`, ['consumer', 'civil', 'torts', 'ecommerce', 'cyber'], ['consumer law']),
  act('CA2013', 'Companies Act, 2013', 2013, '18 of 2013', code(2114), ['corporate', 'securities'], ['company law', 'company act', 'companies act']),
  act('COMP2002', 'Competition Act, 2002', 2002, '12 of 2003', `${INDIA_CODE}/indiacode/bitstream/123456789/2010/7/A2003-12.pdf`, ['competition', 'corporate'], ['competition law', 'antitrust']),
  act('SEBI1992', 'Securities and Exchange Board of India Act, 1992', 1992, '15 of 1992', `${INDIA_CODE}/bitstream/123456789/1890/1/A1992-15.pdf`, ['securities', 'corporate', 'white-collar'], ['sebi act', 'securities law'], 'SEBI regulations and circulars are distinct instruments with their own amendment dates.'),
  act('FTDR1992', 'Foreign Trade (Development and Regulation) Act, 1992', 1992, '22 of 1992', code(1947), ['trade', 'corporate'], ['foreign trade act', 'ftdr']),
  act('IBC2016', 'Insolvency and Bankruptcy Code, 2016', 2016, '31 of 2016', code(2154), ['insolvency', 'corporate', 'banking'], ['ibc', 'insolvency code']),
  act('PATENTS1970', 'Patents Act, 1970', 1970, '39 of 1970', code(1392), ['ip', 'corporate', 'cyber'], ['patent law']),
  act('TM1999', 'Trade Marks Act, 1999', 1999, '47 of 1999', code(1993), ['ip', 'corporate', 'cyber', 'ecommerce'], ['trademarks act', 'trade mark law']),
  act('COPYRIGHT1957', 'Copyright Act, 1957', 1957, '14 of 1957', code(1367), ['ip', 'cyber', 'ecommerce', 'social-media'], ['copyright law', 'copyright act']),
  act('EPA1986', 'Environment (Protection) Act, 1986', 1986, '29 of 1986', code(1876), ['environment', 'civil'], ['environment protection act']),
  act('BR1949', 'Banking Regulation Act, 1949', 1949, '10 of 1949', `${INDIA_CODE}/bitstream/123456789/1885/1/A1949-10.pdf`, ['banking', 'corporate'], ['banking law']),
  act('INS1938', 'Insurance Act, 1938', 1938, '4 of 1938', code(2304), ['banking', 'corporate'], ['insurance law']),
  act('IRC2020', 'Industrial Relations Code, 2020', 2020, '35 of 2020', code(22040), ['labour', 'corporate'], ['industrial relations', 'labour code'], 'Check the 21 November 2025 commencement notification and the 2026 amendment before relying on a provision.'),
  act('WAGES2019', 'Code on Wages, 2019', 2019, '29 of 2019', code(15793), ['labour', 'corporate'], ['wages code'], 'Commencement is provision-specific; check notifications and State rules.'),
  act('SOCSEC2020', 'Code on Social Security, 2020', 2020, '36 of 2020', code(16823), ['labour', 'corporate'], ['social security code'], 'Check commencement notifications, schemes and State rules separately.'),
  act('OSH2020', 'Occupational Safety, Health and Working Conditions Code, 2020', 2020, '37 of 2020', code(22041), ['labour', 'corporate'], ['osh code'], 'Check commencement notifications and State rules separately.'),
  act('PMLA2002', 'Prevention of Money-Laundering Act, 2002', 2002, '15 of 2003', code(2036), ['white-collar', 'corporate', 'banking'], ['pmla', 'money laundering act'], 'Check the scheduled offence, applicable amendment and procedural stage.'),
  act('PCA1988', 'Prevention of Corruption Act, 1988', 1988, '49 of 1988', code(1558), ['white-collar', 'corporate'], ['anti corruption act', 'corruption act'], 'Check the alleged conduct date against amendment and sanction requirements.'),
  act('IT2000', 'Information Technology Act, 2000', 2000, '21 of 2000', 'https://indiacode.gov.in/server/api/core/bitstreams/770a7d02-48f2-4274-bab9-10d0f48ee264/content', ['white-collar', 'corporate', 'cyber', 'cyber-security', 'ecommerce', 'social-media', 'computer-crime', 'data-protection'], ['it act', 'cyber law', 'computer crime law'], 'The linked India Code edition is marked as on 27 June 2025. Check later amendments, applicable rules, orders and current judicial treatment before relying on it.'),
  act('DPDP2023', 'Digital Personal Data Protection Act, 2023', 2023, '22 of 2023', code(22037), ['cyber', 'data-protection', 'cyber-security', 'ecommerce', 'social-media'], ['dpdp', 'data protection act'], 'Provisions have phased commencement; do not infer commencement from enactment or the rules publication.'),
  act('TELECOM2023', 'Telecommunications Act, 2023', 2023, '44 of 2023', `${INDIA_CODE}/bitstream/123456789/20101/1/a2023-44.pdf`, ['cyber', 'telecom', 'cyber-security'], ['telecommunication act', 'telecom act'], 'Different sections commenced on different dates; subordinate telecom rules are separate instruments.'),
  act('ITINTERMEDIARY2021', 'Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021', 2021, null, 'https://www.meity.gov.in/static/uploads/2025/10/708f6a344c74249c2e1bbb6890342f80.pdf', ['cyber', 'social-media', 'ecommerce'], ['it rules 2021', 'intermediary guidelines', 'social media rules'], 'The linked consolidated text is marked updated 22 October 2025. G.S.R. 120(E) amended these rules with effect from 20 February 2026 and must be applied separately. Later second-amendment proposals are drafts until notified.', 'rules', 'IT2000'),
  act('ITINTERMEDIARYAMEND2026', 'Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Amendment Rules, 2026', 2026, null, 'https://egazette.gov.in/WriteReadData/2026/269993.pdf', ['cyber', 'social-media', 'ecommerce'], ['it intermediary amendment 2026', 'synthetically generated information rules', 'deepfake rules 2026'], 'G.S.R. 120(E), notified 10 February 2026 and in force from 20 February 2026. This is the notified amendment, distinct from the later proposed Second Amendment Rules, 2026.', 'rules', 'ITINTERMEDIARY2021'),
  act('ITSPDI2011', 'Information Technology (Reasonable security practices and procedures and sensitive personal data or information) Rules, 2011', 2011, null, 'https://emb.mes.gov.in/Common/help/gsr3_10511.pdf', ['cyber', 'cyber-security', 'data-protection', 'ecommerce'], ['spdi rules', 'sensitive personal data rules', 'reasonable security practices rules'], 'Government-hosted copy of G.S.R. 313(E), 11 April 2011, not the issuer site; this PDF also contains other notifications. DPDP Act section 44(2) schedules omission of enabling IT Act section 43A eighteen months after the 2025 commencement Gazette publication. Verify transition and later changes.', 'rules', 'IT2000'),
  act('DPDPR2025', 'Digital Personal Data Protection Rules, 2025', 2025, null, 'https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf', ['cyber', 'data-protection', 'cyber-security', 'ecommerce'], ['dpdp rules', 'data protection rules'], 'Rules 1, 2 and 17–21 commenced on publication; rule 4 is one year later and rules 3, 5–16, 22–23 are eighteen months later, subject to corrigenda.', 'rules', 'DPDP2023'),
  act('ECOM2020', 'Consumer Protection (E-Commerce) Rules, 2020', 2020, null, 'https://consumeraffairs.nic.in/sites/default/files/E%20commerce%20rules_0.pdf', ['ecommerce', 'consumer', 'cyber'], ['ecommerce rules', 'e commerce rules'], 'Review the official corrigendum and any later amendments separately.', 'rules', 'CPA2019'),
  act('CERTINRULES2013', 'Information Technology (The Indian Computer Emergency Response Team and Manner of Performing Functions and Duties) Rules, 2013', 2013, null, 'https://www.meity.gov.in/static/uploads/2024/05/gazette_11-01-2014.pdf', ['cyber', 'cyber-security', 'computer-crime'], ['cert in rules', 'cert-in functions rules'], 'The Gazette notification is dated 16 January 2014 although the short title says 2013. These rules are distinct from the 2022 CERT-In directions; verify later amendments.', 'rules', 'IT2000'),
  act('ITBLOCK2009', 'Information Technology (Procedure and Safeguards for Blocking for Access of Information by Public) Rules, 2009', 2009, null, 'https://www.meity.gov.in/static/uploads/2024/10/91f628cb778f94e76df356bc3fd3ac60.pdf', ['cyber', 'social-media'], ['it blocking rules', 'section 69a rules', 'blocking rules'], 'G.S.R. 781(E), 27 October 2009. Distinguish the blocking procedure from intermediary due diligence and later designated-officer notifications.', 'rules', 'IT2000'),
  act('CERT2022', 'CERT-In Cyber Security Directions under section 70B(6), 2022', 2022, null, 'https://www.cert-in.org.in/Directions70B.jsp', ['cyber-security', 'cyber', 'computer-crime'], ['cert in directions', 'cyber incident reporting'], 'Directions and clarifications have their own scope, reporting criteria and effective dates.', 'direction', 'IT2000'),
  act('TELCYBER2024', 'Telecommunications (Telecom Cyber Security) Rules, 2024', 2024, null, 'https://eservices.dot.gov.in/telecom-cyber-security', ['telecom', 'cyber-security', 'cyber'], ['telecom cyber security rules'], 'Review the 2025 amendment and later DoT directions as separate changes.', 'rules', 'TELECOM2023'),
  act('BIS27001', 'IS/ISO/IEC 27001:2022', 2022, null, 'https://www.bis.gov.in/system-certification-overview/systems-under-certification/information-security-management-systems/?lang=en', ['cyber-security'], ['iso 27001', 'information security standard', 'cyber security standards'], 'Technical standard, not a statute. Whether it is binding depends on an applicable law, licence, contract or direction. The official source identifies the standard; its full text may require separate licensed access.', 'standard'),
  act('SEBICSCRF2024', 'SEBI Cybersecurity and Cyber Resilience Framework, 2024', 2024, null, 'https://www.sebi.gov.in/legal/circulars/aug-2024/cybersecurity-and-cyber-resilience-framework-cscrf-for-sebi-regulated-entities-res-_85964.html', ['cyber-security', 'securities', 'corporate'], ['sebi cscrf', 'sebi cyber framework'], 'Sector-specific circular for SEBI regulated entities. Review 2024–25 clarifications and implementation extensions.', 'circular', 'SEBI1992'),
  act('RBIIT2023', 'RBI Information Technology Governance, Risk, Controls and Assurance Practices Directions, 2023', 2023, null, 'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12562', ['cyber-security', 'banking', 'corporate'], ['rbi it governance directions', 'rbi cyber security directions'], 'Applies to specified RBI-regulated entities from 1 April 2024; verify entity category and later updates.', 'direction', 'BR1949'),
  Object.freeze({
    id: 'UKCA2006', title: 'Companies Act 2006', year: 2006, actNumber: '2006 c. 46',
    sourceUrl: 'https://www.legislation.gov.uk/ukpga/2006/46/contents', jurisdiction: 'UK',
    instrumentType: 'act', parentId: null,
    topics: Object.freeze(['corporate']), aliases: Object.freeze(['company act 2006', 'uk companies act']),
    note: 'United Kingdom legislation. Excluded from Indian provision retrieval.',
  }),
]);

const normal = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const TOPIC_ALIASES = Object.freeze({
  'white-collar': ['white collar law', 'economic offences', 'financial crime'],
  torts: ['law of torts', 'tort law', 'civil liability'],
  administrative: ['administrative law', 'public law', 'writs'],
  labour: ['labour law', 'employment law'],
  corporate: ['company law', 'corporate law', 'commercial law'],
  ip: ['intellectual property law', 'ip law'],
  cyber: ['cyber law', 'internet law', 'digital law'],
  'cyber-security': ['cyber security law', 'cybersecurity standards', 'information security'],
  ecommerce: ['ecommerce law', 'e commerce law', 'online marketplace'],
  'social-media': ['social media laws', 'platform law', 'intermediary law'],
  'computer-crime': ['computer crime law', 'cyber crime', 'digital evidence'],
  'data-protection': ['privacy law', 'data privacy law'],
  telecom: ['telecommunication law', 'telecom law'],
});
const searchable = PRACTICE_ACTS.map((entry) => ({ entry, keys: [entry.id, entry.title, ...entry.aliases].map(normal) }));

/** A metadata-only index: no empty Act is inserted into the operative-law store. */
export const cataloguedActs = (store, { query = '', topic = '', includeForeign = false, asOf = new Date().toISOString().slice(0, 10) } = {}) => {
  if (topic && !PRACTICE_TOPICS[topic]) throw new RangeError(`Unknown practice topic: ${topic}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))
    || new Date(asOf).toISOString().slice(0, 10) !== asOf) throw new RangeError('asOf must be a real YYYY-MM-DD date');
  const q = normal(query);
  const words = q.split(' ').filter(Boolean);
  const results = searchable.flatMap(({ entry, keys }) => {
    if (entry.jurisdiction !== 'IN' && !includeForeign) return [];
    if (topic && !entry.topics.includes(topic)) return [];
    const exact = keys.includes(q);
    const prefix = keys.some((key) => key.startsWith(q));
    const haystack = normal(`${keys.join(' ')} ${entry.topics.flatMap((key) => [PRACTICE_TOPICS[key], ...(TOPIC_ALIASES[key] || [])]).join(' ')}`);
    if (q && !exact && !prefix && !words.every((word) => haystack.includes(word))) return [];
    const actId = entry.jurisdiction === 'IN' ? store.findAct({ shortTitle: entry.title, year: entry.year }) : null;
    const coverage = actId && entry.instrumentType !== 'standard'
      ? store.verifiedActCoverageAsOf(actId, asOf) : { provisions: 0, source: null };
    const verified = Boolean(coverage.provisions && isCitableOfficialSource(coverage.source?.source_url, coverage.source?.source_sha256));
    const historical = actId && !verified && entry.instrumentType !== 'standard' ? store.lastBoundedReview(actId, asOf) : null;
    return [{
      ...entry,
      status: verified ? 'indexed-as-of' : historical?.provisions ? 'indexed-historical' : 'source-identified',
      indexedSections: verified ? coverage.provisions : 0,
      indexedSourceUrl: verified ? coverage.source.source_url : null,
      indexedSourceSha256: verified ? coverage.source.source_sha256 : null,
      historicalIndexedSections: historical?.provisions ?? 0,
      reviewedThrough: historical?.reviewedThrough ?? null,
      historicalSourceUrl: historical?.source?.source_url ?? null,
      score: q ? exact ? 0 : prefix ? 1 : 2 : 3,
    }];
  });
  return results.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title)).map(({ score, ...item }) => item);
};
