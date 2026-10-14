import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openLegalStore } from '../src/store/db.js';
import { comparableWords, compareCopyWithProvisions, latestEffectiveDate } from '../src/compare/copyCheck.js';
import { checkCopy, checkUploadedCopy, createCopyCheckers } from '../src/compare/checkCopy.js';
import { CONSTITUTION_ACT } from '../src/ingest/constitution.js';
import { drainChangeEvents, SIGNAL_ONLY } from '../src/watch/events.js';
import { handleLawBuddyApiRoute, LAWBUDDY_FILES } from '../src/routes.js';

const ARREST = '(1) No person who is arrested shall be detained in custody without being informed, as soon as may be, '
  + 'of the grounds for such arrest nor shall he be denied the right to consult, and to be defended by, a legal '
  + 'practitioner of his choice. (2) Every person who is arrested and detained in custody shall be produced before '
  + 'the nearest magistrate within a period of twenty-four hours of such arrest excluding the time necessary for the '
  + 'journey from the place of arrest to the court of the magistrate.';
const ASSOCIATIONS_NOW = '(1) All citizens shall have the right (a) to freedom of speech and expression; (b) to assemble '
  + 'peaceably and without arms; (c) to form associations or unions or co-operative societies; (d) to move freely '
  + 'throughout the territory of India.';
const ASSOCIATIONS_OLD = ASSOCIATIONS_NOW.replace(' or co-operative societies', '');
const RETURNS = 'Every co-operative society shall file returns, within six months of the close of every financial '
  + 'year, to the authority designated by the State Government including the annual report of its activities.';
const OMITTED = 'Omitted by the Constitution (Seventh Amendment) Act, 1956, s. 29 and Sch.';
const WOMEN = 'Seats shall be reserved for women in the House of the People, and as nearly as may be one-third of the '
  + 'total number of seats to be filled by direct election shall be reserved for women.';

const PROVISIONS = [
  { label: 'Art.22', heading: 'Protection against arrest and detention in certain cases.', text: ARREST, validFrom: '1979-06-20' },
  { label: 'Art.19', heading: 'Protection of certain rights regarding freedom of speech, etc.', text: ASSOCIATIONS_NOW, validFrom: '2012-02-15' },
  { label: 'Art.243ZP', heading: 'Returns.', text: RETURNS, validFrom: '2012-02-15' },
  { label: 'Art.238', heading: null, text: OMITTED, validFrom: '1956-11-01' },
  { label: 'Art.242', heading: null, text: OMITTED, validFrom: '1956-11-01' },
  { label: 'Art.330A', heading: 'Reservation of seats for women in the House of the People.', text: WOMEN, validFrom: '2026-04-16' },
  { label: 'Art.1', heading: 'Name and territory of the Union.', text: 'India, that is Bharat.', validFrom: '1950-01-26' },
];

/** An old printed copy: margin notes glued into lines, a page break with footnotes mid-article, footnote markers. */
const OLD_COPY = [
  'THE CONSTITUTION OF INDIA 11',
  '(Part III.—Fundamental Rights.—Arts. 19-22.)',
  'Protection of 19. 1[(1) All citizens shall have the right— certain rights',
  '(a) to freedom of speech and expression; regarding freedom',
  '(b) to assemble peaceably and without arms; of speech, etc.',
  '(c) to form associations or unions;',
  '(d) to move freely throughout the territory of India.]',
  '22. (1) No person who is arrested shall be detained in Protection against',
  'custody without being informed, as soon as may be, of the arrest and',
  'grounds for such arrest nor shall he be denied the right to detention in',
  `1. ${'Subs. by the Constitution (Forty-fourth Amendment) Act, 1978, s. 3 (w.e.f. 20-6-1979). '.repeat(12)}`,
  '2. Ins. by the Constitution (Ninety-fourth Amendment) Act, 2006, s. 2 (w.e.f. 12-6-2006).',
  'THE CONSTITUTION OF INDIA 12',
  'consult, and to be defended by, a legal practitioner of his choice.',
  '(2) Every person who is arrested and detained in custody shall be produced before the nearest',
  'magistrate within a period of twenty-four hours of such arrest excluding the time necessary for the',
  'journey from the place of arrest to the court of the magistrate.',
  `238. [${OMITTED}] 3*** 241. [${OMITTED}] 242. [${OMITTED}]`,
].join('\n');

test('comparableWords drops footnote markers and punctuation; latestEffectiveDate finds the newest valid w.e.f.', () => {
  assert.deepEqual(comparableWords('1[(1) All citizens] 2*** shall—have'), ['1', 'all', 'citizens', 'shall', 'have']);
  assert.equal(latestEffectiveDate(OLD_COPY), '2006-06-12');
  assert.equal(latestEffectiveDate('(w.e.f. 31-2-2024) (w. e. f. 1.3.1985)'), '1985-03-01', 'impossible dates ignored');
  assert.equal(latestEffectiveDate('no footnotes'), null);
});

test('a copy compared with itself matches every comparable provision', () => {
  const copyText = PROVISIONS.map((provision) => `${provision.heading ?? ''} ${provision.text}`).join('\n');
  const result = compareCopyWithProvisions({ provisions: PROVISIONS, copyText, copyDate: '2026-10-01' });
  assert.equal(result.compared, 6);
  assert.equal(result.tooShort, 1, '"India, that is Bharat." is too short to judge');
  assert.deepEqual(result.differs, []);
  assert.deepEqual(result.newerThanCopy, []);
});

test('an old copy: amended, missing and newer provisions are reported; layout noise and boilerplate are not', () => {
  const result = compareCopyWithProvisions({ provisions: PROVISIONS, copyText: OLD_COPY, copyDate: '2023-12-28' });
  const differing = Object.fromEntries(result.differs.map((d) => [d.label, d.coverage]));

  assert.equal('Art.22' in differing, false, 'margin notes and a page break inside Art. 22 are tolerated');
  assert.equal('Art.238' in differing, false, 'repeated "Omitted" boilerplate still matches');
  assert.equal('Art.242' in differing, false);
  const art19 = result.differs.find((d) => d.label === 'Art.19');
  assert.equal(art19.coverage, 0.9, 'a ratio alone would let this through');
  assert.deepEqual(art19.missing, ['or co operative societies'], 'the inserted phrase is caught and shown');
  assert.ok(differing['Art.243ZP'] < 0.5, 'Part IXB is absent from the copy');
  assert.ok('Art.330A' in differing);
  assert.deepEqual(result.newerThanCopy.map((p) => p.label), ['Art.330A']);
  assert.equal(result.differs[0].label, 'Art.243ZP', 'worst first');
});

/** An in-memory library holding a 3-provision "Constitution" from an official source. */
const libraryWith = () => {
  const store = openLegalStore(':memory:');
  store.registerSource({ id: 'legislative', name: 'Legislative Department', tier: 0, baseUrl: 'https://legislative.gov.in' });
  store.registerSource({ id: 'mirror', name: 'A coaching site', tier: 2, baseUrl: 'https://mirror.example' });
  const actId = store.upsertAct(CONSTITUTION_ACT);
  for (const provision of PROVISIONS.slice(0, 3).concat(PROVISIONS[5])) {
    const provisionId = store.upsertProvision({ actId, label: provision.label, heading: provision.heading });
    store.addProvisionVersion({
      provisionId, text: provision.text, validFrom: provision.validFrom,
      sourceUrl: 'https://legislative.gov.in/coi-2026.pdf', sourceSha256: 'officialsha',
    });
  }
  return store;
};

const COPY_URL = 'https://mirror.example/bare-acts/constitution-of-india.pdf';
const fakeExtract = (texts) => async (rawPath) => [{ page: 1, lines: texts[rawPath].split('\n').map((text) => ({ text })) }];

test('checkCopy stores a report dated by the delivering 200 response, even after 304 revalidations', async () => {
  const store = libraryWith();
  try {
    store.recordFetch({
      sourceId: 'mirror', url: COPY_URL, httpStatus: 200, sha256: 'copysha', rawPath: '/vault/copysha',
      lastModified: 'Thu, 28 Dec 2023 10:16:07 GMT',
    });
    store.recordFetch({ sourceId: 'mirror', url: COPY_URL, httpStatus: 304, sha256: 'copysha', rawPath: '/vault/copysha' });

    const result = await checkCopy({
      store, url: COPY_URL, extract: fakeExtract({ '/vault/copysha': OLD_COPY }), now: () => Date.parse('2026-10-12T12:00:00Z'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'outdated');
    assert.equal(result.copy.fileDate, '2023-12-28');
    assert.equal(result.copy.textCurrentTo, '2006-06-12');
    assert.match(result.summary, /1 provisions took effect after this copy's date \(2023-12-28\)/);
    assert.match(result.summary, /footnotes stop at 2006-06-12/);
    assert.deepEqual(result.official, { url: 'https://legislative.gov.in/coi-2026.pdf', sha256: 'officialsha' });

    const stored = store.latestCopyCheck(COPY_URL);
    assert.equal(stored.checked_at, '2026-10-12T12:00:00.000Z');
    assert.equal(stored.report.verdict, 'outdated');

    assert.equal((await checkCopy({ store, url: 'https://mirror.example/none.pdf' })).status, 404);
    assert.equal((await checkCopy({ store, url: COPY_URL, act: 'ipc' })).status, 400);
  } finally {
    store.close();
  }
});

test('a current copy gets the "current" verdict', async () => {
  const store = libraryWith();
  try {
    const current = [ARREST, ASSOCIATIONS_NOW, RETURNS, WOMEN].join('\n');
    store.recordFetch({ sourceId: 'mirror', url: COPY_URL, httpStatus: 200, sha256: 'newsha', rawPath: '/vault/newsha' });
    const result = await checkCopy({ store, url: COPY_URL, copyDate: '2026-06-12', extract: fakeExtract({ '/vault/newsha': current }) });
    assert.equal(result.verdict, 'current');
    assert.equal(result.summary, 'All 4 comparable provisions match the official text in force.');
  } finally {
    store.close();
  }
});

test('watched mirror copies of a checkable Act are checked automatically when they change', async () => {
  const store = libraryWith();
  try {
    const checked = [];
    const checkers = createCopyCheckers({
      store,
      watchlists: [{ id: 'mirror-acts', acts: { 'constitution-of-india.pdf': 'constitution' } }, { id: 'no-acts' }],
      check: async ({ url, act }) => {
        checked.push([url, act]);
        return { ok: true, verdict: 'outdated', summary: '48 of 509 provisions read differently.' };
      },
    });
    assert.deepEqual(Object.keys(checkers), ['mirror-acts']);
    assert.equal(await checkers['mirror-acts']({ kind: 'removed', url: COPY_URL }), null, 'removals are not checked');
    assert.equal(await checkers['mirror-acts']({ kind: 'changed', url: 'https://mirror.example/bare-acts/ipc.pdf' }), null);

    // Route a real pending event through the drain.
    const targetId = store.upsertWatchTarget({
      url: COPY_URL, sourceId: 'mirror', watchlist: 'mirror-acts', kind: 'document',
      minIntervalMs: 1000, maxIntervalMs: 2000, nextCheckAt: '2026-10-12T00:00:00Z',
    });
    store.recordChangeEvent({ targetId, kind: 'changed', newSha256: 'copysha' });
    const drained = await drainChangeEvents({ store, checkers });
    assert.deepEqual(checked, [[COPY_URL, 'constitution']]);
    assert.equal(drained.processed[0].outcome, `${SIGNAL_ONLY}; copy check: outdated — 48 of 509 provisions read differently.`);
  } finally {
    store.close();
  }
});

test('GET /lawbuddy/api/copy-check serves the stored report, or 404', async () => {
  const store = libraryWith();
  try {
    store.recordFetch({ sourceId: 'mirror', url: COPY_URL, httpStatus: 200, sha256: 'copysha', rawPath: '/vault/copysha' });
    await checkCopy({ store, url: COPY_URL, copyDate: '2023-12-28', extract: fakeExtract({ '/vault/copysha': OLD_COPY }) });

    const call = async (url) => {
      let sent = null;
      const parsedUrl = new URL(`http://localhost/lawbuddy/api/copy-check?url=${encodeURIComponent(url)}`);
      await handleLawBuddyApiRoute({ method: 'GET' }, {}, {
        pathname: parsedUrl.pathname, parsedUrl, legalLibrary: { get: async () => store },
        sendJson: (res, status, body) => { sent = { status, body }; },
      });
      return sent;
    };
    const found = await call(COPY_URL);
    assert.equal(found.status, 200);
    assert.equal(found.body.verdict, 'outdated');
    assert.ok(found.body.checkedAt);
    assert.equal((await call('https://mirror.example/other.pdf')).status, 404);
  } finally {
    store.close();
  }
});

test('an uploaded PDF is read in a temporary folder that is always deleted, and only its report is kept', async () => {
  const store = libraryWith();
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'lawbuddy-upload-test-'));
  try {
    const pdf = Buffer.from(`%PDF-1.4\n${OLD_COPY}`);
    const reads = [];
    const extract = async (file) => {
      reads.push(file);
      assert.equal(path.dirname(path.dirname(file)), tmpRoot, 'read from a private folder under tmpRoot');
      return [{ page: 1, lines: OLD_COPY.split('\n').map((text) => ({ text })) }];
    };

    const first = await checkUploadedCopy({ store, body: pdf, extract, tmpRoot });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(first.verdict, 'differs', 'without a date nothing can be "newer than the copy"');
    assert.deepEqual(first.newerThanCopy, []);
    assert.equal(first.copy.upload, true);
    assert.equal(first.copy.url, null);
    assert.deepEqual(await readdir(tmpRoot), [], 'the uploaded file is deleted');

    const dated = await checkUploadedCopy({ store, body: pdf, copyDate: '2023-12-28', extract, tmpRoot });
    assert.equal(dated.cached, true);
    assert.equal(reads.length, 1, 'the same bytes are never read twice');
    assert.equal(dated.verdict, 'outdated');
    assert.deepEqual(dated.newerThanCopy.map((p) => p.label), ['Art.330A']);
    assert.equal(dated.copy.fileDate, '2023-12-28');
    assert.equal(store.latestCopyCheck(`upload:${first.copy.sha256}`).report.copy.fileDate, null, 'the stored report stays undated');

    await assert.rejects(
      checkUploadedCopy({ store, body: Buffer.from('%PDF-1.4 other'), extract: async () => { throw new Error('PDFSyntaxError at /tmp/x'); }, tmpRoot }),
      /PDFSyntaxError/,
    );
    assert.deepEqual(await readdir(tmpRoot), [], 'deleted even when reading fails');

    // A file byte-identical to a watched, already-checked copy is answered from that copy's report.
    store.recordFetch({ sourceId: 'mirror', url: COPY_URL, httpStatus: 200, sha256: 'unused', rawPath: '/vault/known' });
    const known = Buffer.from('%PDF-1.4 the mirror copy');
    const knownSha = (await import('node:crypto')).createHash('sha256').update(known).digest('hex');
    store.saveCopyCheck({
      copyUrl: COPY_URL, copySha256: knownSha, actId: store.findAct(CONSTITUTION_ACT), officialSha256: 'officialsha',
      report: { ...first, copy: { url: COPY_URL, sha256: knownSha, fileDate: '2023-12-28', textCurrentTo: '2006-06-12' } },
    });
    const sameAsMirror = await checkUploadedCopy({ store, body: known, extract: async () => assert.fail('must not read'), tmpRoot });
    assert.equal(sameAsMirror.cached, true);
    assert.deepEqual(sameAsMirror.copy, {
      url: null, sha256: knownSha, upload: true, fileDate: null, textCurrentTo: '2006-06-12', sameAs: COPY_URL,
    });

    assert.equal((await checkUploadedCopy({ store, body: Buffer.from('<html>not a pdf'), tmpRoot })).status, 415);
    assert.equal((await checkUploadedCopy({ store, body: pdf, copyDate: '28-12-2023', tmpRoot })).status, 400);
  } finally {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

const upload = async ({ body = Buffer.from('%PDF-1.4'), headers = { 'content-type': 'application/pdf' }, query = '', checkUpload }) => {
  const req = Object.assign(Readable.from([body]), { method: 'POST', headers });
  const parsedUrl = new URL(`http://localhost/lawbuddy/api/copy-check${query}`);
  let sent = null;
  await handleLawBuddyApiRoute(req, {}, {
    pathname: parsedUrl.pathname, parsedUrl, legalLibrary: { get: async () => ({}) }, checkUpload,
    sendJson: (res, status, sentBody) => { sent = { status, body: sentBody }; },
  });
  return sent;
};

test('POST /lawbuddy/api/copy-check passes the PDF and options through, and fails safely', async () => {
  const calls = [];
  const ok = await upload({
    query: '?act=constitution&date=2023-12-28',
    checkUpload: async (args) => { calls.push(args); return { ok: true, verdict: 'outdated' }; },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verdict, 'outdated');
  assert.equal(calls[0].body.toString(), '%PDF-1.4');
  assert.equal(calls[0].act, 'constitution');
  assert.equal(calls[0].copyDate, '2023-12-28');

  const never = async () => { throw new Error('must not be called'); };
  assert.equal((await upload({ headers: { 'content-type': 'text/plain' }, checkUpload: never })).status, 415);
  assert.equal((await upload({ headers: { 'content-type': 'application/pdf', 'content-length': String(31 * 1024 * 1024) }, checkUpload: never })).status, 413);

  const failed = await upload({ checkUpload: async () => { throw new Error('pdf_extract failed at /Users/someone/secret/path'); } });
  assert.equal(failed.status, 422);
  assert.doesNotMatch(failed.body.error, /secret|pdf_extract/, 'worker details never reach the browser');
});

test('the "Check my bare act" page and its script are served', () => {
  assert.match(LAWBUDDY_FILES['/lawbuddy/check'][0], /web[\\/]check\.html$/);
  assert.match(LAWBUDDY_FILES['/lawbuddy/assets/check.js'][1], /javascript/);
});
