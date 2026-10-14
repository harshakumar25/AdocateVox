import test from 'node:test';
import assert from 'node:assert/strict';
import { openLegalStore } from '../src/store/db.js';
import {
  createLawRetriever,
  createLegalStoreLoader,
  detectLegalReferences,
  retrieveLegalEvidence,
} from '../src/retrieval/legalRetriever.js';
import http from 'node:http';
import { handleLawBuddyStaticRoute, handleLawBuddyApiRoute, LAWBUDDY_FILES } from '../src/routes.js';
import { config } from '../src/config.js';

const SOURCE = 'https://www.legislative.gov.in/static/uploads/2025/07/coi.pdf';


const createTestServer = ({ legalStore = null, LEGAL_DB_PATH = config.LEGAL_DB_PATH } = {}) => {
  const legalLibrary = createLegalStoreLoader({ store: legalStore, dbPath: LEGAL_DB_PATH });
  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;
    const sendJson = (res, status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (handleLawBuddyStaticRoute(req, res, pathname, LAWBUDDY_FILES)) return;
    if (await handleLawBuddyApiRoute(req, res, { pathname, parsedUrl, legalLibrary, sendJson })) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
};

const seedStore = () => {
  const store = openLegalStore(':memory:');
  const actId = store.upsertAct({ shortTitle: 'Constitution of India', year: 1950 });
  const add = (label, heading, text, validFrom, footnotes = [], context = null, amendedByRef = null) => {
    const provisionId = store.upsertProvision({ actId, label, heading, context });
    store.addProvisionVersion({ provisionId, text, validFrom, amendedByRef, sourceUrl: SOURCE, sourceSha256: 'f00d', footnotes });
  };
  add('Art.21', 'Protection of life and personal liberty.',
    'No person shall be deprived of his life or personal liberty except according to procedure established by law.',
    '1950-01-26', [], { part: 'PART III — FUNDAMENTAL RIGHTS', chapter: null, group: 'Right to Freedom' });
  add('Art.21A', 'Right to education.', 'The State shall provide free and compulsory education to all children.',
    '2010-04-01', [], null, 'Constitution (Eighty-sixth Amendment) Act, 2002');
  add('Art.124A', 'National Judicial Appointments Commission.', '(1) There shall be a Commission.', '2015-04-13', [
    { n: '1', text: 'Ins. by the Constitution (Ninety-ninth Amendment) Act, 2014. This amendment has been struck down by the Supreme Court.', invalidated: true, pending: false },
  ]);
  add('Art.22', 'Protection against arrest and detention in certain cases.', '(1) No person who is arrested shall be detained.', '1950-01-26', [
    { n: '*', text: 'Cl. (4) shall stand substituted by the Constitution (Forty-fourth Amendment) Act, 1978 (date yet to be notified).', invalidated: false, pending: true },
  ]);
  add('Sch.7', 'Seventh Schedule (Article 246)', 'List I—Union List 1. Defence of India.', '2016-09-16');
  store.replaceMappings({
    newAct: 'BNS', oldAct: 'IPC', sourceUrl: 'https://www.ncrb.gov.in/uploads/SankalanPortal/SectionTableBNS.html', sourceSha256: 'abc',
    entries: [
      { kind: 'mapped', newLabel: 's.103', newTitle: 'Punishment for murder.', oldLabel: 's.302', oldTitle: 'Punishment for murder.', changed: true, chapter: null },
      { kind: 'deleted', newLabel: null, newTitle: null, oldLabel: 's.124A', oldTitle: 'Sedition', changed: false, chapter: null },
    ],
  });
  return store;
};

test('detectLegalReferences finds articles, lists, Hindi, the Preamble, schedules and code sections', () => {
  assert.deepEqual(detectLegalReferences('Explain Article 21 to me').constitution, ['Art.21']);
  assert.deepEqual(detectLegalReferences('Compare Articles 14, 19 and 21').constitution, ['Art.14', 'Art.19', 'Art.21']);
  assert.deepEqual(detectLegalReferences('art. 21a(1) and Art 32').constitution, ['Art.21A', 'Art.32']);
  assert.deepEqual(detectLegalReferences('अनुच्छेद 21 समझाओ').constitution, ['Art.21']);
  assert.deepEqual(detectLegalReferences('What does the Preamble say?').constitution, ['Preamble']);
  assert.deepEqual(detectLegalReferences('Seventh Schedule, 9th Schedule and Schedule X').constitution, ['Sch.7', 'Sch.9', 'Sch.10']);
  assert.deepEqual(detectLegalReferences('Section 302 IPC vs BNS 103 and 498A IPC').sections, [
    { act: 'IPC', label: 's.302' },
    { act: 'BNS', label: 's.103' },
    { act: 'IPC', label: 's.498A' },
  ]);
  assert.deepEqual(detectLegalReferences('s. 65B of the Indian Evidence Act').sections, [{ act: 'IEA', label: 's.65B' }]);
  assert.deepEqual(detectLegalReferences('section 438 Cr.P.C.').sections, [{ act: 'CrPC', label: 's.438' }]);

  const none = detectLegalReferences('Part 3 of this article explains binary search; a smart 5-step plan.');
  assert.deepEqual(none, { constitution: [], sections: [] });
});

test('retrieveLegalEvidence returns official text with date, location, source, cautions and pending amendments', () => {
  const store = seedStore();
  try {
    const [art21] = retrieveLegalEvidence({ store, references: detectLegalReferences('Article 21'), asOf: '2026-10-12' });
    assert.equal(art21.kind, 'statute');
    assert.equal(art21.domain, 'legislative.gov.in');
    assert.equal(art21.url, SOURCE);
    assert.equal(art21.title, 'Constitution of India — Article 21');
    assert.match(art21.content, /Article 21 — Protection of life and personal liberty\./);
    assert.match(art21.content, /Location: PART III — FUNDAMENTAL RIGHTS; Right to Freedom\./);
    assert.match(art21.content, /in force since 1950-01-26:\nNo person shall be deprived/);

    const [art21A] = retrieveLegalEvidence({ store, references: detectLegalReferences('Article 21A'), asOf: '2026-10-12' });
    assert.match(art21A.content, /in force since 2010-04-01 \(last amended by the Constitution \(Eighty-sixth Amendment\) Act, 2002\)/);

    const [njac] = retrieveLegalEvidence({ store, references: detectLegalReferences('Article 124A'), asOf: '2026-10-12' });
    assert.match(njac.content, /CAUTION — the printed text includes an amendment a court invalidated: .*struck down/);

    const [art22] = retrieveLegalEvidence({ store, references: detectLegalReferences('Article 22'), asOf: '2026-10-12' });
    assert.match(art22.content, /PENDING — an amendment never brought into force: .*date yet to be notified/);

    const [schedule] = retrieveLegalEvidence({ store, references: detectLegalReferences('Seventh Schedule'), asOf: '2026-10-12' });
    assert.equal(schedule.title, 'Constitution of India — Seventh Schedule');
  } finally {
    store.close();
  }
});

test('missing or not-yet-in-force provisions yield an explicit "not found" notice, never invented text', () => {
  const store = seedStore();
  try {
    const [missing] = retrieveLegalEvidence({ store, references: detectLegalReferences('Article 999'), asOf: '2026-10-12' });
    assert.equal(missing.kind, 'statute-absence');
    assert.match(missing.content, /has no Article 999 in force on 2026-10-12\. Do not describe its contents/);
    assert.equal(missing.url, SOURCE);

    const [early] = retrieveLegalEvidence({ store, references: detectLegalReferences('Article 21A'), asOf: '2005-01-01' });
    assert.equal(early.kind, 'statute-absence', 'Article 21A did not exist yet in 2005');
  } finally {
    store.close();
  }
});

test('section references use the official correspondence table and add nothing when no table is loaded', () => {
  const store = seedStore();
  try {
    const evidence = retrieveLegalEvidence({ store, references: detectLegalReferences('IPC 302 and IPC 124A and IEA 65B'), asOf: '2026-10-12' });
    assert.deepEqual(evidence.map((e) => e.kind), ['correspondence', 'correspondence']);
    assert.equal(evidence[0].domain, 'ncrb.gov.in');
    assert.match(evidence[0].content, /IPC s\.302 \(Punishment for murder\.\) corresponds to BNS s\.103 \(Punishment for murder\.\), with changes\./);
    assert.match(evidence[1].content, /IPC s\.124A \(Sedition\) was deleted; it has no counterpart in the BNS\./);
  } finally {
    store.close();
  }
});

test('the law retriever grounds named provisions, then searches the official text, else returns nothing', async () => {
  const store = seedStore();
  try {
    const retrieve = createLawRetriever({ loader: createLegalStoreLoader({ store }), asOf: '2026-10-12' });
    const named = await retrieve({ text: 'Teach me Article 21' });
    assert.deepEqual(named.map((e) => e.title), ['Constitution of India — Article 21']);

    const searched = await retrieve({ text: 'what is the right to education?' });
    assert.equal(searched[0].title, 'Constitution of India — Article 21A (found by search)');
    assert.match(searched[0].content, /^Found by searching the official text for the student's question/);

    assert.deepEqual(await retrieve({ text: 'Explain Kubernetes pods' }), [], 'nothing legal: no evidence, no fallback');
    assert.deepEqual(
      await retrieve({ text: 'How do Kubernetes pods and containers use education?' }),
      [],
      'a provision matching one word out of three is not about the question',
    );
    assert.equal((await retrieve({ text: 'Can someone be deprived of personal liberty?' }))[0].label, 'Art.21');
  } finally {
    store.close();
  }

  const missing = createLawRetriever({ loader: createLegalStoreLoader({ dbPath: '/nonexistent/lawbuddy.db' }) });
  assert.deepEqual(await missing({ text: 'Article 21' }), [], 'no library installed');
});

test('LawBuddy library API (/lawbuddy/api/*): health, article as of a date, search and section lookup', async () => {
  const store = seedStore();
  const server = createTestServer({ legalStore: store });
  await new Promise((resolve) => server.listen(0, resolve));
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  };
  try {
    const health = await get('/lawbuddy/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.library.provisions, 5);
    assert.equal(health.body.library.mappings, 2);
    assert.deepEqual(health.body.library.acts, [{
      title: 'Constitution of India', year: 1950, provisions: 5, sourceUrl: SOURCE, sha256: 'f00d',
    }]);
    assert.equal(health.body.library.correspondence[0].table, 'BNS ↔ IPC');

    const art = await get('/lawbuddy/api/article/21A');
    assert.equal(art.status, 200);
    assert.equal(art.body.inForceSince, '2010-04-01');
    assert.equal(art.body.source.url, SOURCE);
    assert.equal((await get('/lawbuddy/api/article/21A?asOf=2005-01-01')).status, 404);
    assert.equal((await get('/lawbuddy/api/article/124A')).body.judicialNotes.length, 1);
    assert.equal((await get('/lawbuddy/api/article/not-an-article')).status, 400);
    assert.equal((await get('/lawbuddy/api/article/%E0')).status, 400);
    assert.equal((await get('/lawbuddy/api/article/21?asOf=yesterday')).status, 400);

    const search = await get('/lawbuddy/api/search?q=right%20to%20education');
    assert.equal(search.body.hits[0].label, 'Art.21A');
    assert.equal((await get('/lawbuddy/api/search')).status, 400);

    const lookup = await get('/lawbuddy/api/lookup?act=IPC&section=302');
    assert.equal(lookup.body.matches[0].new, 'BNS s.103 Punishment for murder.');
    assert.equal((await get('/lawbuddy/api/lookup?act=IPC&section=999')).status, 404);
    assert.equal((await get('/lawbuddy/api/nope')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }

  const empty = createTestServer({ LEGAL_DB_PATH: '/nonexistent/lawbuddy.db' });
  await new Promise((resolve) => empty.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${empty.address().port}/lawbuddy/api/health`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /legal library is not installed/);
  } finally {
    await new Promise((resolve) => empty.close(resolve));
  }
});

test('GET /lawbuddy and GET /lawbuddy/teach serve the website from a fixed whitelist with security headers', async () => {
  const server = createTestServer({ LEGAL_DB_PATH: '/nonexistent/lawbuddy.db' });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, type, marker] of [
      ['/lawbuddy', 'text/html', 'Learn Indian law from the'],
      ['/lawbuddy/', 'text/html', 'Learn Indian law from the'],
      ['/lawbuddy/teach', 'text/html', 'Official text relied on'],
      ['/lawbuddy/assets/lawbuddy.css', 'text/css', '--brass'],
      ['/lawbuddy/assets/teach.js', 'text/javascript', 'POST /lawbuddy/teach'],
      ['/lawbuddy/assets/home.js', 'text/javascript', '/lawbuddy/api/health'],
      ['/lawbuddy/assets/common.js', 'text/javascript', 'isSafeUrl'],
      ['/lawbuddy/assets/voiceSelector.js', 'text/javascript', "'daniel'"],
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.ok(res.headers.get('content-type').startsWith(type), path);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'; script-src 'self'/, path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.ok((await res.text()).includes(marker), path);
    }
    const head = await fetch(`${base}/lawbuddy/teach`, { method: 'HEAD' });
    assert.equal(head.status, 200);

    for (const path of ['/lawbuddy/assets/../../server/server.js', '/lawbuddy/assets/teach.html', '/lawbuddy/assets/missing.js', '/lawbuddy/index.html']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

