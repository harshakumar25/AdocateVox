/**
 * LawBuddy legal store on Node's built-in SQLite (node:sqlite) with FTS5.
 *
 * Holds the verified legal corpus: sources and their fetch history,
 * statutes with point-in-time provision versions, and court cases keyed by
 * every citation alias they are known by. node:sqlite is still marked
 * experimental in Node 24, so nothing outside this module touches it directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { MIGRATIONS } from './migrations.js';
import { JUDGMENT_READER_VERSION, TREATMENT_RANK } from '../parse/judgmentCitations.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const assertIsoDate = (value, field) => {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
};

// Question words and fillers that would otherwise dominate an "any word" search.
const QUESTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'about', 'as', 'at', 'be', 'by', 'can', 'could', 'do', 'does', 'did', 'explain', 'for',
  'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'say', 'should', 'tell', 'telling',
  'the', 'this', 'to', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'kya', 'hai', 'hota', 'batao', 'samjhao',
]);

/**
 * Turns free user text into a safe FTS5 query: every word becomes a quoted
 * term, so punctuation such as "Art. 21" or stray quotes can never be parsed
 * as FTS5 syntax. `all` requires every word (implicit AND); `any` drops
 * question words and ORs the rest, for natural-language questions.
 */
/**
 * The words of a question that can carry meaning in a search ("what is the right to education" →
 * right, education); all words when the question is nothing but question words.
 */
export const questionTerms = (text) => {
  // Marks (\p{M}) stay inside a word so Devanagari matras don't split Hindi terms.
  const words = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || [];
  const meaningful = words.filter((word) => !QUESTION_STOP_WORDS.has(word.toLowerCase()));
  return meaningful.length ? meaningful : words;
};

export const toFtsQuery = (text, mode = 'all') => {
  const terms = questionTerms(text);
  if (mode === 'any') {
    return [...new Set(terms.map((term) => term.toLowerCase()))].map((term) => `"${term}"`).join(' OR ');
  }
  return terms.map((term) => `"${term}"`).join(' ');
};

export const openLegalStore = (filePath = config.LEGAL_DB_PATH) => {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (filePath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const applied = db.prepare('PRAGMA user_version').get().user_version;
  for (let index = applied; index < MIGRATIONS.length; index += 1) {
    transaction(() => {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }

  const statements = {
    upsertSource: db.prepare(`
      INSERT INTO source (id, name, tier, base_url) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, tier = excluded.tier, base_url = excluded.base_url
    `),
    markSourceSuccess: db.prepare('UPDATE source SET last_success_at = ? WHERE id = ?'),
    insertFetch: db.prepare(`
      INSERT INTO fetch_log (source_id, url, method, http_status, sha256, content_type, byte_length,
                             etag, last_modified, raw_path, error, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    lastSuccessfulFetch: db.prepare(`
      SELECT * FROM fetch_log WHERE url = ? AND method = 'auto' AND http_status = 200 AND raw_path IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `),
    latestDocument: db.prepare(`
      SELECT * FROM fetch_log WHERE url = ? AND sha256 IS NOT NULL AND raw_path IS NOT NULL ORDER BY id DESC LIMIT 1
    `),
    upsertAct: db.prepare(`
      INSERT INTO act (short_title, act_number, year, ministry) VALUES (?, ?, ?, ?)
      ON CONFLICT(short_title, year) DO UPDATE SET
        act_number = COALESCE(excluded.act_number, act.act_number),
        ministry = COALESCE(excluded.ministry, act.ministry)
      RETURNING id
    `),
    findAct: db.prepare('SELECT id FROM act WHERE short_title = ? AND year IS ?'),
    actSource: db.prepare(`
      SELECT pv.source_url, pv.source_sha256 FROM provision_version pv JOIN provision p ON p.id = pv.provision_id
      WHERE p.act_id = ? AND pv.source_url IS NOT NULL ORDER BY pv.id DESC LIMIT 1
    `),
    upsertProvision: db.prepare(`
      INSERT INTO provision (act_id, label, heading, context) VALUES (?, ?, ?, ?)
      ON CONFLICT(act_id, label) DO UPDATE SET
        heading = COALESCE(excluded.heading, provision.heading),
        context = COALESCE(excluded.context, provision.context)
      RETURNING id
    `),
    openVersion: db.prepare(`
      SELECT * FROM provision_version WHERE provision_id = ? AND valid_to IS NULL
    `),
    closeVersion: db.prepare('UPDATE provision_version SET valid_to = ? WHERE id = ?'),
    insertVersion: db.prepare(`
      INSERT INTO provision_version (provision_id, text, valid_from, amended_by_ref, gazette_ref,
                                     source_url, source_sha256, footnotes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    rewriteVersion: db.prepare(`
      UPDATE provision_version SET text = ?, amended_by_ref = ?, gazette_ref = ?, footnotes = ? WHERE id = ?
    `),
    deleteFts: db.prepare('DELETE FROM provision_fts WHERE rowid = ?'),
    provisionMeta: db.prepare('SELECT label, heading FROM provision WHERE id = ?'),
    insertFts: db.prepare('INSERT INTO provision_fts (rowid, label, heading, text) VALUES (?, ?, ?, ?)'),
    versionAsOf: db.prepare(`
      SELECT pv.*, p.label, p.heading, p.act_id, p.context
      FROM provision_version pv JOIN provision p ON p.id = pv.provision_id
      WHERE p.act_id = ? AND p.label = ?
        AND pv.valid_from <= ? AND (pv.valid_to IS NULL OR pv.valid_to > ?)
    `),
    // Ranking weights: label 2x, heading 5x, body 1x — a provision titled "Right to education."
    // should outrank one that merely mentions education.
    searchCurrent: db.prepare(`
      SELECT pv.id AS version_id, p.label, p.heading, a.short_title, pv.valid_from,
             snippet(provision_fts, 2, '[', ']', ' … ', 12) AS snippet,
             bm25(provision_fts, 2.0, 5.0, 1.0) AS score
      FROM provision_fts
      JOIN provision_version pv ON pv.id = provision_fts.rowid
      JOIN provision p ON p.id = pv.provision_id
      JOIN act a ON a.id = p.act_id
      WHERE provision_fts MATCH ? AND pv.valid_to IS NULL
      ORDER BY score LIMIT ?
    `),
    searchAsOf: db.prepare(`
      SELECT pv.id AS version_id, p.label, p.heading, a.short_title, pv.valid_from,
             snippet(provision_fts, 2, '[', ']', ' … ', 12) AS snippet,
             bm25(provision_fts, 2.0, 5.0, 1.0) AS score
      FROM provision_fts
      JOIN provision_version pv ON pv.id = provision_fts.rowid
      JOIN provision p ON p.id = pv.provision_id
      JOIN act a ON a.id = p.act_id
      WHERE provision_fts MATCH ? AND pv.valid_from <= ? AND (pv.valid_to IS NULL OR pv.valid_to > ?)
      ORDER BY score LIMIT ?
    `),
    insertCase: db.prepare(`
      INSERT INTO court_case (court, title, decided_on, bench_strength) VALUES (?, ?, ?, ?)
    `),
    aliasOwner: db.prepare('SELECT case_id FROM citation_alias WHERE scheme = ? AND normalized = ?'),
    insertAlias: db.prepare('INSERT INTO citation_alias (case_id, scheme, normalized) VALUES (?, ?, ?)'),
    caseById: db.prepare('SELECT * FROM court_case WHERE id = ?'),
    versionMatches: db.prepare('SELECT 1 AS hit FROM provision_fts WHERE rowid = ? AND provision_fts MATCH ?'),
    stats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM act) AS acts,
        (SELECT COUNT(*) FROM provision) AS provisions,
        (SELECT COUNT(*) FROM provision_version) AS versions,
        (SELECT COUNT(*) FROM provision_mapping) AS mappings,
        (SELECT COUNT(*) FROM court_case) AS cases
    `),
    actsSummary: db.prepare(`
      SELECT a.id, a.short_title, a.year, COUNT(p.id) AS provisions
      FROM act a LEFT JOIN provision p ON p.act_id = a.id GROUP BY a.id ORDER BY a.id
    `),
    mappingsSummary: db.prepare(`
      SELECT new_act, old_act, COUNT(*) AS rows, MAX(source_url) AS source_url
      FROM provision_mapping GROUP BY new_act, old_act ORDER BY new_act
    `),
    deleteMappings: db.prepare('DELETE FROM provision_mapping WHERE new_act = ? AND old_act = ?'),
    insertMapping: db.prepare(`
      INSERT INTO provision_mapping (new_act, new_label, new_title, old_act, old_label, old_title,
                                     kind, changed, chapter, source_url, source_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    mappingsByOld: db.prepare(`
      SELECT * FROM provision_mapping
      WHERE old_act = ? AND (old_label = ? OR old_label LIKE ? ESCAPE '\\') ORDER BY id
    `),
    mappingsByNew: db.prepare(`
      SELECT * FROM provision_mapping
      WHERE new_act = ? AND (new_label = ? OR new_label LIKE ? ESCAPE '\\') ORDER BY id
    `),
    aliasesForCase: db.prepare(`
      SELECT scheme, normalized FROM citation_alias WHERE case_id = ? ORDER BY scheme, normalized
    `),
    upsertScCase: db.prepare(`
      INSERT INTO court_case (court, title, decided_on, bench_strength, source_key, source_url, pdf_url,
                              case_no, disposal, coram, author, headnote, cnr)
      VALUES ('SC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        title = excluded.title, decided_on = excluded.decided_on, bench_strength = excluded.bench_strength,
        source_url = excluded.source_url, pdf_url = excluded.pdf_url, case_no = excluded.case_no,
        disposal = excluded.disposal, coram = excluded.coram, author = excluded.author,
        headnote = excluded.headnote, cnr = excluded.cnr
      RETURNING id
    `),
    deleteCaseProvisions: db.prepare('DELETE FROM case_provision WHERE case_id = ? AND source = ?'),
    insertCaseProvision: db.prepare('INSERT OR IGNORE INTO case_provision (case_id, act, label, source, position) VALUES (?, ?, ?, ?, ?)'),
    deleteCaseFts: db.prepare('DELETE FROM case_fts WHERE rowid = ?'),
    insertCaseFts: db.prepare('INSERT INTO case_fts (rowid, title, headnote) VALUES (?, ?, ?)'),
    casesForProvision: db.prepare(`
      SELECT c.*, cp.label AS matched_label, MIN(cp.position) AS position,
             (SELECT COUNT(*) FROM case_citation cc WHERE cc.cited_id = c.id) AS cited_by,
             (SELECT cm.mentions FROM case_mention cm WHERE cm.case_id = c.id AND cm.act = cp.act AND cm.label = cp.label) AS mentions
      FROM case_provision cp JOIN court_case c ON c.id = cp.case_id
      WHERE cp.act = ? AND cp.label = ?
      GROUP BY c.id
    `),
    casesMentioning: db.prepare(`
      SELECT c.*, cm.label AS matched_label, NULL AS position, cm.mentions,
             (SELECT COUNT(*) FROM case_citation cc WHERE cc.cited_id = c.id) AS cited_by
      FROM case_mention cm JOIN court_case c ON c.id = cm.case_id
      WHERE cm.act = ? AND cm.label = ? AND cm.mentions >= ?
    `),
    caseCountsForProvisions: db.prepare(`
      SELECT cp.label, COUNT(DISTINCT cp.case_id) AS cases FROM case_provision cp
      WHERE cp.act = ? GROUP BY cp.label
    `),
    scImport: db.prepare('SELECT * FROM sc_import WHERE year = ?'),
    saveScImport: db.prepare(`
      INSERT INTO sc_import (year, archive_sha256, records, cases, imported_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(year) DO UPDATE SET archive_sha256 = excluded.archive_sha256, records = excluded.records,
        cases = excluded.cases, imported_at = excluded.imported_at
    `),
    caseBrief: db.prepare('SELECT * FROM case_brief WHERE case_id = ?'),
    saveCaseBrief: db.prepare(`
      INSERT INTO case_brief (case_id, judgment_sha256, brief, model, kept, dropped, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET judgment_sha256 = excluded.judgment_sha256, brief = excluded.brief,
        model = excluded.model, kept = excluded.kept, dropped = excluded.dropped, generated_at = excluded.generated_at
    `),
    insertCaseReview: db.prepare(`
      INSERT INTO case_review (case_id, reviewer_name, reviewer_credential, rating, comment, source_url,
                               verified_by, verified_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    verifiedReviews: db.prepare(`
      SELECT id, reviewer_name, reviewer_credential, rating, comment, source_url, verified_at
      FROM case_review WHERE case_id = ? AND verified_at IS NOT NULL ORDER BY verified_at DESC
    `),
    reviewSummary: db.prepare(`
      SELECT COUNT(*) AS reviews, AVG(rating) AS average FROM case_review WHERE case_id = ? AND verified_at IS NOT NULL
    `),
    caseStats: db.prepare(`
      SELECT (SELECT COUNT(*) FROM court_case WHERE source_key IS NOT NULL) AS cases,
             (SELECT COUNT(DISTINCT case_id) FROM case_provision) AS linked,
             (SELECT MIN(decided_on) FROM court_case WHERE source_key IS NOT NULL) AS earliest,
             (SELECT MAX(decided_on) FROM court_case WHERE source_key IS NOT NULL) AS latest
    `),
    currentProvisions: db.prepare(`
      SELECT p.label, p.heading, pv.text, pv.valid_from AS validFrom, p.context, pv.footnotes
      FROM provision p JOIN provision_version pv ON pv.provision_id = p.id
      WHERE p.act_id = ? AND pv.valid_to IS NULL ORDER BY p.id
    `),
    upsertCopyCheck: db.prepare(`
      INSERT INTO copy_check (copy_url, copy_sha256, act_id, official_sha256, report, checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(copy_sha256, act_id, official_sha256) DO UPDATE SET
        copy_url = excluded.copy_url, report = excluded.report, checked_at = excluded.checked_at
    `),
    latestCopyCheck: db.prepare('SELECT * FROM copy_check WHERE copy_url = ? ORDER BY checked_at DESC, id DESC LIMIT 1'),
    copyCheckFor: db.prepare('SELECT * FROM copy_check WHERE copy_sha256 = ? AND act_id = ? AND official_sha256 = ?'),
    textFingerprint: db.prepare('SELECT * FROM text_fingerprint WHERE sha256 = ?'),
    saveProvenance: db.prepare(`
      INSERT INTO provenance (copy_url, copy_sha256, gazette_id, official_url, official_sha256, relation, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(copy_sha256, official_url) DO UPDATE SET copy_url = excluded.copy_url,
        official_sha256 = excluded.official_sha256, relation = excluded.relation, checked_at = excluded.checked_at
    `),
    provenanceFor: db.prepare('SELECT * FROM provenance WHERE copy_url = ? ORDER BY id'),
    saveTextFingerprint: db.prepare(`
      INSERT INTO text_fingerprint (sha256, text_sha256, pages, chars, extracted_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET text_sha256 = excluded.text_sha256, pages = excluded.pages,
        chars = excluded.chars, extracted_at = excluded.extracted_at
    `),
    // Re-seeding a watchlist refreshes its policy but never resets an existing schedule or state.
    upsertWatchTarget: db.prepare(`
      INSERT INTO watch_target (url, source_id, watchlist, kind, parent_id, label, interval_ms,
                                min_interval_ms, max_interval_ms, next_check_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        label = COALESCE(excluded.label, watch_target.label),
        parent_id = COALESCE(excluded.parent_id, watch_target.parent_id),
        min_interval_ms = excluded.min_interval_ms,
        max_interval_ms = excluded.max_interval_ms,
        interval_ms = MIN(MAX(watch_target.interval_ms, excluded.min_interval_ms), excluded.max_interval_ms)
      RETURNING id
    `),
    watchTargetById: db.prepare('SELECT * FROM watch_target WHERE id = ?'),
    claimDueTargets: db.prepare(`
      UPDATE watch_target SET lease_until = ?
      WHERE id IN (
        SELECT id FROM watch_target
        WHERE state = 'active' AND next_check_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
          AND (? IS NULL OR kind = ?)
        ORDER BY kind = 'document', next_check_at, id
        LIMIT ?
      )
      RETURNING *
    `),
    completeWatchCheck: db.prepare(`
      UPDATE watch_target SET state = ?, state_reason = ?, interval_ms = ?, next_check_at = ?, lease_until = NULL,
        last_checked_at = ?, last_changed_at = COALESCE(?, last_changed_at),
        last_sha256 = COALESCE(?, last_sha256), failures = ?
      WHERE id = ?
    `),
    releaseWatchLease: db.prepare('UPDATE watch_target SET lease_until = NULL WHERE id = ?'),
    setWatchState: db.prepare(`
      UPDATE watch_target SET state = ?, state_reason = ?, next_check_at = COALESCE(?, next_check_at) WHERE id = ?
    `),
    childTargets: db.prepare('SELECT * FROM watch_target WHERE parent_id = ? ORDER BY id'),
    insertChangeEvent: db.prepare(`
      INSERT INTO change_event (target_id, kind, old_sha256, new_sha256, raw_path, detail, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    pendingChangeEvents: db.prepare(`
      SELECT e.*, t.url, t.kind AS target_kind, t.label, t.watchlist, t.source_id, s.tier
      FROM change_event e JOIN watch_target t ON t.id = e.target_id JOIN source s ON s.id = t.source_id
      WHERE e.processed_at IS NULL ORDER BY e.id LIMIT ?
    `),
    recentChangeEvents: db.prepare(`
      SELECT e.id, e.kind, e.detected_at, e.processed_at, e.outcome, e.detail, e.new_sha256, t.url, t.label, t.watchlist
      FROM change_event e JOIN watch_target t ON t.id = e.target_id ORDER BY e.id DESC LIMIT ?
    `),
    markChangeEventProcessed: db.prepare('UPDATE change_event SET processed_at = ?, outcome = ? WHERE id = ?'),
    nextDueAt: db.prepare(`SELECT MIN(next_check_at) AS at FROM watch_target WHERE state = 'active'`),
    watchTargetsSummary: db.prepare(`
      SELECT t.id, t.watchlist, t.kind, t.label, t.url, t.state, t.state_reason, t.next_check_at,
             t.last_checked_at, t.last_changed_at, t.failures, t.interval_ms,
             (SELECT f.last_modified FROM fetch_log f
               WHERE f.url = t.url AND f.http_status = 200 ORDER BY f.id DESC LIMIT 1) AS last_modified,
             (SELECT f.byte_length FROM fetch_log f
               WHERE f.url = t.url AND f.http_status = 200 ORDER BY f.id DESC LIMIT 1) AS byte_length,
             (SELECT p.relation || ' to official Gazette ' || p.gazette_id FROM provenance p
               WHERE p.copy_url = t.url ORDER BY p.id DESC LIMIT 1) AS provenance
      FROM watch_target t ORDER BY t.watchlist, t.kind DESC, t.id
    `),
    pendingEventCount: db.prepare('SELECT COUNT(*) AS n FROM change_event WHERE processed_at IS NULL'),
    caseIdBySourceKey: db.prepare('SELECT id FROM court_case WHERE source_key = ?'),
    correspondenceSummary: db.prepare(`
      SELECT kind, COUNT(*) AS n, COUNT(DISTINCT old_label) AS old_sections FROM provision_mapping
      WHERE old_act = ? AND new_act = ? GROUP BY kind
    `),
    learnedAliasOwner: db.prepare('SELECT case_id, votes, method FROM learned_alias WHERE scheme = ? AND normalized = ?'),
    citedByCount: db.prepare('SELECT COUNT(*) AS n FROM case_citation WHERE cited_id = ?'),
    casesDecidedOn: db.prepare('SELECT id, title, decided_on, pdf_url FROM court_case WHERE decided_on = ? AND source_key IS NOT NULL'),
    storedJudgmentPdfs: db.prepare(`
      SELECT c.id, c.source_key, f.raw_path, f.sha256
      FROM court_case c JOIN fetch_log f ON f.id = (
        SELECT MAX(id) FROM fetch_log WHERE url = c.pdf_url AND sha256 IS NOT NULL AND raw_path IS NOT NULL
      )
      WHERE c.pdf_url IS NOT NULL
    `),
    caseText: db.prepare('SELECT * FROM case_text WHERE case_id = ?'),
    saveCaseText: db.prepare(`
      INSERT INTO case_text (case_id, pdf_sha256, pages, chars, citations, references_listed, indexed_at, parser_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET pdf_sha256 = excluded.pdf_sha256, pages = excluded.pages,
        chars = excluded.chars, citations = excluded.citations, references_listed = excluded.references_listed,
        indexed_at = excluded.indexed_at, parser_version = excluded.parser_version
    `),
    deleteJudgmentReferences: db.prepare('DELETE FROM judgment_reference WHERE citing_id = ?'),
    insertJudgmentReference: db.prepare(`
      INSERT INTO judgment_reference (citing_id, ref_key, citations, name, page, in_list, treatment, category,
                                      mentions, context, context_page)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteCaseMentions: db.prepare('DELETE FROM case_mention WHERE case_id = ?'),
    insertCaseMention: db.prepare('INSERT INTO case_mention (case_id, act, label, mentions) VALUES (?, ?, ?, ?)'),
    allJudgmentReferences: db.prepare('SELECT * FROM judgment_reference ORDER BY citing_id, ref_key'),
    allCitationAliases: db.prepare('SELECT case_id, scheme, normalized FROM citation_alias'),
    caseIndexRows: db.prepare(`
      SELECT id, source_key, title, decided_on, bench_strength FROM court_case WHERE source_key IS NOT NULL
    `),
    clearCitationGraph: db.prepare('DELETE FROM case_citation'),
    insertCaseCitation: db.prepare(`
      INSERT INTO case_citation (citing_id, cited_id, in_list, treatment, category, mentions, ref_page, context, context_page, method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    clearLearnedAliases: db.prepare('DELETE FROM learned_alias'),
    insertLearnedAlias: db.prepare('INSERT INTO learned_alias (scheme, normalized, case_id, votes, method) VALUES (?, ?, ?, ?, ?)'),
    resetDerivedStatus: db.prepare(`UPDATE court_case SET status = 'unknown' WHERE status IN ('overruled', 'caution')`),
    setCaseStatus: db.prepare('UPDATE court_case SET status = ? WHERE id = ?'),
    citedBy: db.prepare(`
      SELECT cc.citing_id, cc.in_list, cc.treatment, cc.category, cc.mentions, cc.ref_page, cc.context, cc.context_page, cc.method,
             c.title, c.decided_on, c.bench_strength, c.pdf_url
      FROM case_citation cc JOIN court_case c ON c.id = cc.citing_id
      WHERE cc.cited_id = ?
      ORDER BY c.decided_on DESC, c.id DESC
    `),
    textIndexStats: db.prepare(`
      SELECT (SELECT COUNT(*) FROM case_text) AS judgments,
             (SELECT COUNT(*) FROM case_citation) AS edges,
             (SELECT COUNT(*) FROM learned_alias) AS learned,
             (SELECT MIN(c.decided_on) FROM case_text t JOIN court_case c ON c.id = t.case_id) AS earliest,
             (SELECT MAX(c.decided_on) FROM case_text t JOIN court_case c ON c.id = t.case_id) AS latest
    `),
    textIndexYears: db.prepare(`
      SELECT substr(c.decided_on, 1, 4) AS year, COUNT(*) AS judgments
      FROM case_text t JOIN court_case c ON c.id = t.case_id GROUP BY year ORDER BY year
    `),
    scTextImport: db.prepare('SELECT * FROM sc_text_import WHERE year = ?'),
    saveScTextImport: db.prepare(`
      INSERT INTO sc_text_import (year, index_sha256, archive_sha256, files, indexed, unmatched, failed, imported_at, parser_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(year) DO UPDATE SET index_sha256 = excluded.index_sha256, archive_sha256 = excluded.archive_sha256,
        files = excluded.files, indexed = excluded.indexed, unmatched = excluded.unmatched, failed = excluded.failed,
        imported_at = excluded.imported_at, parser_version = excluded.parser_version
    `),
  };

  const registerSource = ({ id, name, tier, baseUrl }) => {
    statements.upsertSource.run(id, name, tier, baseUrl);
  };

  const recordFetch = ({
    sourceId, url, method = 'auto', httpStatus = null, sha256 = null, contentType = null, byteLength = null,
    etag = null, lastModified = null, rawPath = null, error = null, fetchedAt = new Date().toISOString(),
  }) => {
    transaction(() => {
      statements.insertFetch.run(
        sourceId, url, method, httpStatus, sha256, contentType, byteLength,
        etag, lastModified, rawPath, error, fetchedAt,
      );
      if (httpStatus === 200 || httpStatus === 304) {
        statements.markSourceSuccess.run(fetchedAt, sourceId);
      }
    });
  };

  /** Latest automatic 200 for `url` — the basis for conditional revalidation. */
  const lastSuccessfulFetch = (url) => statements.lastSuccessfulFetch.get(url) || null;

  /** Latest stored copy of `url`, however it arrived (fetched or manually imported). */
  const latestDocument = (url) => statements.latestDocument.get(url) || null;

  const upsertAct = ({ shortTitle, actNumber = null, year = null, ministry = null }) =>
    statements.upsertAct.get(shortTitle, actNumber, year, ministry).id;

  /** Read-only lookup: the act's id, or null when it has not been ingested. */
  const findAct = ({ shortTitle, year = null }) => statements.findAct.get(shortTitle, year)?.id ?? null;

  /** The official document the act's most recently stored text came from. */
  const actSource = (actId) => statements.actSource.get(actId) ?? null;

  const upsertProvision = ({ actId, label, heading = null, context = null }) =>
    statements.upsertProvision.get(actId, label, heading, context === null ? null : JSON.stringify(context)).id;

  const indexVersion = (versionId, provisionId, text) => {
    const meta = statements.provisionMeta.get(provisionId);
    statements.deleteFts.run(versionId);
    statements.insertFts.run(versionId, meta.label, meta.heading || '', text);
  };

  /**
   * Records a provision's text from validFrom onwards, closing the version it
   * replaces. Re-ingesting unchanged text is a no-op, so syncs are idempotent.
   * Re-parsing the *same* source document (same sha256 and validFrom) corrects
   * that version in place instead of inventing a new point in time.
   */
  const addProvisionVersion = ({
    provisionId, text, validFrom, amendedByRef = null, gazetteRef = null,
    sourceUrl = null, sourceSha256 = null, footnotes = null,
  }) => {
    assertIsoDate(validFrom, 'validFrom');
    if (typeof text !== 'string' || !text.trim()) {
      throw new TypeError('text must be a non-empty string');
    }
    const footnotesJson = footnotes === null ? null : JSON.stringify(footnotes);

    return transaction(() => {
      const current = statements.openVersion.get(provisionId);
      if (current) {
        const sameSource = Boolean(sourceSha256) && current.source_sha256 === sourceSha256 && current.valid_from === validFrom;
        if (current.text === text) {
          // Same text: only a re-parse of the same document may refresh its metadata.
          if (sameSource && (current.footnotes !== footnotesJson || current.amended_by_ref !== amendedByRef)) {
            statements.rewriteVersion.run(text, amendedByRef, gazetteRef, footnotesJson, current.id);
          }
          return Number(current.id);
        }
        if (sameSource) {
          statements.rewriteVersion.run(text, amendedByRef, gazetteRef, footnotesJson, current.id);
          indexVersion(Number(current.id), provisionId, text);
          return Number(current.id);
        }
        if (current.valid_from >= validFrom) {
          throw new RangeError(
            `validFrom ${validFrom} must be after the current version's valid_from ${current.valid_from}`,
          );
        }
        statements.closeVersion.run(validFrom, current.id);
      }

      const versionId = Number(
        statements.insertVersion.run(
          provisionId, text, validFrom, amendedByRef, gazetteRef, sourceUrl, sourceSha256, footnotesJson,
        ).lastInsertRowid,
      );
      indexVersion(versionId, provisionId, text);
      return versionId;
    });
  };

  const getProvisionAsOf = ({ actId, label, date }) => {
    assertIsoDate(date, 'date');
    return statements.versionAsOf.get(actId, label, date, date) || null;
  };

  /**
   * BM25-ranked provision search; current law by default, or the law as on `asOf`.
   * `match: 'any'` ranks provisions by how many of the question's words they contain.
   */
  const searchProvisions = (query, { asOf = null, limit = 10, match = 'all' } = {}) => {
    const ftsQuery = toFtsQuery(query, match);
    if (!ftsQuery) return [];
    if (asOf) {
      assertIsoDate(asOf, 'asOf');
      return statements.searchAsOf.all(ftsQuery, asOf, asOf, limit);
    }
    return statements.searchCurrent.all(ftsQuery, limit);
  };

  const addCase = ({ court, title, decidedOn = null, benchStrength = null }) => {
    if (decidedOn !== null) assertIsoDate(decidedOn, 'decidedOn');
    return Number(statements.insertCase.run(court, title, decidedOn, benchStrength).lastInsertRowid);
  };

  /**
   * Attaches a citation alias to a case. A citation that already belongs to a
   * different case is a data conflict and throws instead of being reassigned.
   */
  const addCitationAlias = (caseId, { scheme, normalized }) => {
    const owner = statements.aliasOwner.get(scheme, normalized);
    if (owner) {
      if (Number(owner.case_id) === Number(caseId)) return;
      throw new Error(`Citation ${scheme} "${normalized}" already belongs to case ${owner.case_id}`);
    }
    statements.insertAlias.run(caseId, scheme, normalized);
  };

  const findCaseByCitation = ({ scheme, normalized }) => {
    const owner = statements.aliasOwner.get(scheme, normalized);
    if (!owner) return null;
    const row = statements.caseById.get(owner.case_id);
    return { ...row, aliases: statements.aliasesForCase.all(owner.case_id) };
  };

  /**
   * Replaces the whole correspondence between two Acts with a freshly parsed
   * official table, so re-importing a table never leaves stale rows behind.
   */
  const replaceMappings = ({ newAct, oldAct, entries, sourceUrl, sourceSha256 }) =>
    transaction(() => {
      statements.deleteMappings.run(newAct, oldAct);
      for (const entry of entries) {
        statements.insertMapping.run(
          newAct, entry.newLabel, entry.newTitle, oldAct, entry.oldLabel, entry.oldTitle,
          entry.kind, entry.changed ? 1 : 0, entry.chapter, sourceUrl, sourceSha256,
        );
      }
      return entries.length;
    });

  /**
   * Official correspondence rows for a provision on either side, including its
   * sub-divisions: "s.65B" also returns "s.65B(3)(a)".
   */
  const findCorrespondence = ({ act, label }) => {
    const childPattern = `${label.replace(/[\\%_]/g, '\\$&')}(%`;
    return [
      ...statements.mappingsByOld.all(act, label, childPattern),
      ...statements.mappingsByNew.all(act, label, childPattern),
    ];
  };

  /**
   * How many of a question's meaningful words a stored version contains (stemmed, as in search):
   * a hit that matches only "work" out of "how do kubernetes pods work" is not about the question.
   */
  const termCoverage = (versionId, text) => {
    const terms = [...new Set(questionTerms(text).map((term) => term.toLowerCase()))];
    const matched = terms.filter((term) => statements.versionMatches.get(versionId, `"${term}"`)).length;
    return { matched, total: terms.length };
  };

  /**
   * Stores one Supreme Court judgment record (keyed by its dataset path) with its headnote provision
   * links and search index, in one transaction. Returns the case id.
   */
  const upsertScCase = ({
    key, sourceUrl, pdfUrl, title, decidedOn = null, benchStrength = null, caseNo = null, disposal = null,
    coram = [], author = null, headnote = null, cnr = null, provisions = [], act = 'COI',
  }) => transaction(() => {
    const id = Number(statements.upsertScCase.get(
      title, decidedOn, benchStrength, key, sourceUrl, pdfUrl, caseNo, disposal,
      JSON.stringify(coram), author, headnote, cnr,
    ).id);
    statements.deleteCaseProvisions.run(id, 'headnote');
    // position = the headnote catchword group the provision first appears in (0 = the lead group).
    // A provision may name its own Act (catchwords cite "Penal Code, 1860 - s.302" as well as Articles).
    for (const { label, group, act: own } of provisions) statements.insertCaseProvision.run(id, own || act, label, 'headnote', group);
    statements.deleteCaseFts.run(id);
    statements.insertCaseFts.run(id, title, headnote || '');
    return id;
  });

  /** Judgments whose headnote names `label` of `act`, with the catchword position it appears at. */
  const casesForProvision = ({ act = 'COI', label }) => statements.casesForProvision.all(act, label)
    .map((row) => ({ ...row, coram: row.coram ? JSON.parse(row.coram) : [], aliases: statements.aliasesForCase.all(row.id) }));

  /** How many indexed judgments each provision of `act` has. */
  const caseCountsByProvision = (act = 'COI') =>
    Object.fromEntries(statements.caseCountsForProvisions.all(act).map((row) => [row.label, row.cases]));

  const getCaseBrief = (caseId) => {
    const row = statements.caseBrief.get(caseId);
    return row ? { ...row, brief: JSON.parse(row.brief) } : null;
  };

  const saveCaseBrief = ({ caseId, judgmentSha256, brief, model, kept, dropped, generatedAt = new Date().toISOString() }) => {
    statements.saveCaseBrief.run(caseId, judgmentSha256, JSON.stringify(brief), model, kept, dropped, generatedAt);
  };

  /**
   * Records a review. Only reviews with a named, credentialed reviewer whose identity a LawBuddy
   * administrator verified (verifiedBy + verifiedAt) are ever shown (IS 19000:2022 practice).
   */
  const addCaseReview = ({
    caseId, reviewerName, reviewerCredential, rating, comment, sourceUrl = null,
    verifiedBy = null, verifiedAt = null, createdAt = new Date().toISOString(),
  }) => {
    for (const [name, value] of Object.entries({ reviewerName, reviewerCredential, comment })) {
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
    }
    return Number(statements.insertCaseReview.run(
      caseId, reviewerName.trim(), reviewerCredential.trim(), rating, comment.trim(), sourceUrl, verifiedBy, verifiedAt, createdAt,
    ).lastInsertRowid);
  };

  const verifiedReviewsFor = (caseId) => ({
    ...statements.reviewSummary.get(caseId),
    items: statements.verifiedReviews.all(caseId),
  });

  const caseStats = () => ({ ...statements.caseStats.get() });

  /** The archive a year of Supreme Court metadata was last fully imported from, or null. */
  const getScImport = (year) => statements.scImport.get(year) || null;

  const saveScImport = ({ year, archiveSha256, records, cases, importedAt = new Date().toISOString() }) => {
    statements.saveScImport.run(year, archiveSha256, records, cases, importedAt);
  };

  /** Every provision of an Act with the text in force now. */
  const currentProvisions = (actId) => statements.currentProvisions.all(actId);

  const caseIdBySourceKey = (key) => statements.caseIdBySourceKey.get(key)?.id ?? null;

  /**
   * Replaces what indexing one judgment's full text found: its references (one row per group of parallel
   * citations; the same group printed twice is merged, keeping the weightier label and the first context
   * that is the Court's own words rather than counsel's argument) and its Article mentions.
   */
  const saveJudgmentText = ({
    caseId, pdfSha256, pages, chars, citations, references, articles, act = 'COI', indexedAt = new Date().toISOString(),
    parserVersion = JUDGMENT_READER_VERSION,
  }) => transaction(() => {
    const merged = new Map();
    for (const reference of references) {
      const key = `${reference.citations[0].scheme}|${reference.citations[0].normalized}`;
      const known = merged.get(key);
      if (!known) {
        merged.set(key, { ...reference, citations: [...reference.citations], mentions: 1 });
        continue;
      }
      known.mentions += 1;
      for (const citation of reference.citations) {
        if (!known.citations.some((member) => member.normalized === citation.normalized)) known.citations.push(citation);
      }
      known.inReferenceList ||= reference.inReferenceList;
      if (reference.category && (!known.category || TREATMENT_RANK[reference.category] > TREATMENT_RANK[known.category])) {
        known.treatment = reference.treatment;
        known.category = reference.category;
      }
      if (reference.context && (!known.context || (known.argument && !reference.argument))) {
        known.context = reference.context;
        known.argument = reference.argument;
        known.contextPage = reference.page;
      }
    }
    statements.deleteJudgmentReferences.run(caseId);
    for (const [key, reference] of merged) {
      statements.insertJudgmentReference.run(
        caseId, key, JSON.stringify(reference.citations), reference.name, reference.page,
        reference.inReferenceList ? 1 : 0, reference.treatment, reference.category, reference.mentions,
        reference.context, reference.context ? reference.contextPage ?? reference.page : null,
      );
    }
    statements.deleteCaseMentions.run(caseId);
    for (const [label, mentions] of articles) statements.insertCaseMention.run(caseId, act, label, mentions);
    statements.saveCaseText.run(
      caseId, pdfSha256, pages, chars, citations, [...merged.values()].filter((reference) => reference.inReferenceList).length, indexedAt,
      parserVersion,
    );
    return merged.size;
  });

  /** Everything the citation graph is rebuilt from. */
  const citationGraphInputs = () => ({
    references: statements.allJudgmentReferences.all().map((row) => ({ ...row, citations: JSON.parse(row.citations) })),
    aliases: statements.allCitationAliases.all(),
    cases: statements.caseIndexRows.all(),
  });

  /** Swaps in a freshly resolved citation graph, its learned aliases and the case statuses it implies. */
  const replaceCitationGraph = ({ edges, learned, statuses }) => transaction(() => {
    statements.clearCitationGraph.run();
    for (const edge of edges) {
      statements.insertCaseCitation.run(
        edge.citingId, edge.citedId, edge.inList ? 1 : 0, edge.treatment, edge.category, edge.mentions,
        edge.refPage, edge.context, edge.contextPage, edge.method,
      );
    }
    statements.clearLearnedAliases.run();
    for (const alias of learned) {
      statements.insertLearnedAlias.run(alias.scheme, alias.normalized, alias.caseId, alias.votes, alias.method);
    }
    statements.resetDerivedStatus.run();
    for (const [caseId, status] of statuses) statements.setCaseStatus.run(status, caseId);
    return edges.length;
  });

  const citedBy = (caseId) => statements.citedBy.all(caseId);

  const textIndexStats = () => ({
    ...statements.textIndexStats.get(),
    years: statements.textIndexYears.all().map((row) => ({ year: Number(row.year), judgments: row.judgments })),
  });

  const casesMentioning = ({ act = 'COI', label, minMentions = 1 }) => statements.casesMentioning.all(act, label, minMentions)
    .map((row) => ({ ...row, coram: row.coram ? JSON.parse(row.coram) : [], aliases: statements.aliasesForCase.all(row.id) }));

  const getScTextImport = (year) => statements.scTextImport.get(year) || null;

  const saveScTextImport = ({
    year, indexSha256, archiveSha256 = null, files, indexed, unmatched, failed, importedAt = new Date().toISOString(),
    parserVersion = JUDGMENT_READER_VERSION,
  }) => {
    statements.saveScTextImport.run(year, indexSha256, archiveSha256, files, indexed, unmatched, failed, importedAt, parserVersion);
  };

  const saveCopyCheck = ({ copyUrl, copySha256, actId, officialSha256, report, checkedAt = new Date().toISOString() }) => {
    statements.upsertCopyCheck.run(copyUrl, copySha256, actId, officialSha256, JSON.stringify(report), checkedAt);
  };

  /** The most recent stored report for a copy's URL, or null. */
  const latestCopyCheck = (copyUrl) => {
    const row = statements.latestCopyCheck.get(copyUrl);
    return row ? { ...row, report: JSON.parse(row.report) } : null;
  };

  /** The stored report for exactly these bytes against exactly this official text, or null. */
  const copyCheckFor = ({ copySha256, actId, officialSha256 }) => {
    const row = statements.copyCheckFor.get(copySha256, actId, officialSha256);
    return row ? { ...row, report: JSON.parse(row.report) } : null;
  };

  const saveProvenance = ({
    copyUrl, copySha256, gazetteId, officialUrl, officialSha256, relation, checkedAt = new Date().toISOString(),
  }) => {
    statements.saveProvenance.run(copyUrl, copySha256, gazetteId, officialUrl, officialSha256, relation, checkedAt);
  };

  /** What is known about where a copy's text officially comes from. */
  const provenanceFor = (copyUrl) => statements.provenanceFor.all(copyUrl);

  const getTextFingerprint = (sha256) => statements.textFingerprint.get(sha256) || null;

  const saveTextFingerprint = ({ sha256, textSha256, pages, chars, extractedAt = new Date().toISOString() }) => {
    statements.saveTextFingerprint.run(sha256, textSha256, pages, chars, extractedAt);
  };

  /** Adds a URL to watch, or refreshes its watch policy without touching its schedule. Returns its id. */
  const upsertWatchTarget = ({
    url, sourceId, watchlist, kind, parentId = null, label = null,
    minIntervalMs, maxIntervalMs, nextCheckAt, createdAt = new Date().toISOString(),
  }) => Number(statements.upsertWatchTarget.get(
    url, sourceId, watchlist, kind, parentId, label, minIntervalMs,
    minIntervalMs, maxIntervalMs, nextCheckAt, createdAt,
  ).id);

  const getWatchTarget = (id) => statements.watchTargetById.get(id) || null;

  /**
   * Leases up to `limit` active targets due at `now` (listings first), so two
   * watcher processes never check the same URL at once. A crashed watcher's
   * lease simply expires at `leaseUntil`.
   */
  const claimDueWatchTargets = ({ now, leaseUntil, limit = 25, kind = null }) =>
    transaction(() => statements.claimDueTargets.all(leaseUntil, now, now, kind, kind, limit));

  /** Stores one check's outcome and releases the lease. */
  const completeWatchCheck = ({
    id, state = 'active', stateReason = null, intervalMs, nextCheckAt, checkedAt,
    changedAt = null, sha256 = null, failures = 0,
  }) => {
    statements.completeWatchCheck.run(
      state, stateReason, intervalMs, nextCheckAt, checkedAt, changedAt, sha256, failures, id,
    );
  };

  const releaseWatchLease = (id) => {
    statements.releaseWatchLease.run(id);
  };

  const setWatchTargetState = ({ id, state, reason = null, nextCheckAt = null }) => {
    statements.setWatchState.run(state, reason, nextCheckAt, id);
  };

  const childWatchTargets = (parentId) => statements.childTargets.all(parentId);

  const recordChangeEvent = ({
    targetId, kind, oldSha256 = null, newSha256 = null, rawPath = null, detail = null,
    detectedAt = new Date().toISOString(),
  }) => Number(statements.insertChangeEvent.run(
    targetId, kind, oldSha256, newSha256, rawPath, detail === null ? null : JSON.stringify(detail), detectedAt,
  ).lastInsertRowid);

  /** Unprocessed change events, oldest first, with their target and source tier. */
  const pendingChangeEvents = (limit = 100) => statements.pendingChangeEvents.all(limit);

  const markChangeEventProcessed = ({ id, outcome, processedAt = new Date().toISOString() }) => {
    statements.markChangeEventProcessed.run(processedAt, outcome, id);
  };

  /** When the next active watch target falls due (ISO), or null when nothing is watched. */
  const nextWatchDueAt = () => statements.nextDueAt.get().at ?? null;

  /** Everything being watched and the latest events, for the CLI and the sync status API. */
  const watchSummary = ({ recent = 20 } = {}) => ({
    nextDueAt: statements.nextDueAt.get().at,
    pendingEvents: statements.pendingEventCount.get().n,
    targets: statements.watchTargetsSummary.all(),
    recentEvents: statements.recentChangeEvents.all(recent),
  });

  /** Size of the stored library, for health checks. */
  const stats = () => ({ ...statements.stats.get() });

  /** What the library holds and where each part came from, for the LawBuddy home page. */
  const librarySummary = () => ({
    acts: statements.actsSummary.all().map((act) => {
      const source = statements.actSource.get(act.id);
      return {
        title: act.short_title,
        year: act.year,
        provisions: act.provisions,
        sourceUrl: source?.source_url ?? null,
        sha256: source?.source_sha256 ?? null,
      };
    }),
    correspondence: statements.mappingsSummary.all().map((row) => ({
      table: `${row.new_act} ↔ ${row.old_act}`,
      rows: row.rows,
      sourceUrl: row.source_url,
    })),
  });

  return {
    registerSource,
    stats,
    librarySummary,
    recordFetch,
    lastSuccessfulFetch,
    latestDocument,
    upsertAct,
    findAct,
    actSource,
    upsertProvision,
    addProvisionVersion,
    getProvisionAsOf,
    searchProvisions,
    termCoverage,
    addCase,
    addCitationAlias,
    findCaseByCitation,
    replaceMappings,
    findCorrespondence,
    upsertScCase,
    casesForProvision,
    caseCountsByProvision,
    getCaseBrief,
    saveCaseBrief,
    addCaseReview,
    verifiedReviewsFor,
    caseStats,
    getScImport,
    saveScImport,
    caseIdBySourceKey,
    /** A citation the index learned from parallel citations or names ("(1978) 1 SCC 248"), or null. */
    findLearnedAlias: ({ scheme, normalized }) => statements.learnedAliasOwner.get(scheme, normalized) || null,
    citedByCount: (caseId) => statements.citedByCount.get(caseId).n,
    casesDecidedOn: (date) => statements.casesDecidedOn.all(date),
    /** How much of a repealed code its successor carries forward: { mapped, new, oldSections }. */
    findCorrespondenceSummary: (oldAct, newAct) => {
      const rows = statements.correspondenceSummary.all(oldAct, newAct);
      if (!rows.length) return null;
      const mapped = rows.find((row) => row.kind === 'mapped');
      return { mapped: mapped?.n ?? 0, oldSections: mapped?.old_sections ?? 0, new: rows.find((row) => row.kind === 'new')?.n ?? 0 };
    },
    getCaseText: (caseId) => statements.caseText.get(caseId) || null,
    storedJudgmentPdfs: () => statements.storedJudgmentPdfs.all(),
    saveJudgmentText,
    citationGraphInputs,
    replaceCitationGraph,
    citedBy,
    textIndexStats,
    casesMentioning,
    getScTextImport,
    saveScTextImport,
    getCase: (id) => {
      const row = statements.caseById.get(id);
      return row ? { ...row, coram: row.coram ? JSON.parse(row.coram) : [], aliases: statements.aliasesForCase.all(id) } : null;
    },
    currentProvisions,
    saveCopyCheck,
    latestCopyCheck,
    copyCheckFor,
    saveProvenance,
    provenanceFor,
    getTextFingerprint,
    saveTextFingerprint,
    upsertWatchTarget,
    getWatchTarget,
    claimDueWatchTargets,
    completeWatchCheck,
    releaseWatchLease,
    setWatchTargetState,
    childWatchTargets,
    recordChangeEvent,
    pendingChangeEvents,
    markChangeEventProcessed,
    nextWatchDueAt,
    watchSummary,
    close: () => db.close(),
  };
};
