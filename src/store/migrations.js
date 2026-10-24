/**
 * Ordered schema migrations for the LawBuddy legal store.
 * Each entry runs once; PRAGMA user_version records how many have been applied.
 * Never edit a shipped migration — append a new one instead.
 */

export const MIGRATIONS = Object.freeze([
  // 1: sources, fetch log, statutes with point-in-time versions, cases and citation aliases.
  `
  CREATE TABLE source (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tier INTEGER NOT NULL CHECK (tier IN (0, 1, 2)),
    base_url TEXT NOT NULL,
    last_success_at TEXT
  );

  CREATE TABLE fetch_log (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES source(id),
    url TEXT NOT NULL,
    http_status INTEGER,
    sha256 TEXT,
    content_type TEXT,
    byte_length INTEGER,
    etag TEXT,
    last_modified TEXT,
    raw_path TEXT,
    error TEXT,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX fetch_log_url ON fetch_log(url, fetched_at);

  CREATE TABLE act (
    id INTEGER PRIMARY KEY,
    short_title TEXT NOT NULL,
    act_number TEXT,
    year INTEGER,
    ministry TEXT,
    UNIQUE (short_title, year)
  );

  CREATE TABLE provision (
    id INTEGER PRIMARY KEY,
    act_id INTEGER NOT NULL REFERENCES act(id),
    label TEXT NOT NULL,
    heading TEXT,
    UNIQUE (act_id, label)
  );

  -- Half-open validity interval [valid_from, valid_to); valid_to NULL means currently in force.
  CREATE TABLE provision_version (
    id INTEGER PRIMARY KEY,
    provision_id INTEGER NOT NULL REFERENCES provision(id),
    text TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    amended_by_ref TEXT,
    gazette_ref TEXT,
    CHECK (valid_to IS NULL OR valid_to > valid_from)
  );
  CREATE INDEX provision_version_lookup ON provision_version(provision_id, valid_from);

  -- M* keeps combining marks (Devanagari matras, viramas) inside words; the
  -- unicode61 default splits Hindi words apart at every vowel sign.
  CREATE VIRTUAL TABLE provision_fts USING fts5(label, heading, text, tokenize = "unicode61 categories 'L* N* Co M*'");

  CREATE TABLE court_case (
    id INTEGER PRIMARY KEY,
    court TEXT NOT NULL,
    title TEXT NOT NULL,
    decided_on TEXT,
    bench_strength INTEGER,
    status TEXT NOT NULL DEFAULT 'unknown'
      CHECK (status IN ('good', 'caution', 'overruled', 'unknown'))
  );

  CREATE TABLE citation_alias (
    case_id INTEGER NOT NULL REFERENCES court_case(id),
    scheme TEXT NOT NULL,
    normalized TEXT NOT NULL,
    PRIMARY KEY (scheme, normalized)
  );
  CREATE INDEX citation_alias_case ON citation_alias(case_id);
  `,

  // 2: record how a document arrived — 'auto' (polite fetcher) or 'manual'
  // (downloaded by a person in a browser, e.g. from a site that blocks bots).
  `
  ALTER TABLE fetch_log ADD COLUMN method TEXT NOT NULL DEFAULT 'auto' CHECK (method IN ('auto', 'manual'));
  `,

  // 3: official old↔new provision correspondence (e.g. NCRB Sankalan BNS↔IPC),
  // keyed by act code + section label so it works before either Act's text is ingested.
  `
  CREATE TABLE provision_mapping (
    id INTEGER PRIMARY KEY,
    new_act TEXT NOT NULL,
    new_label TEXT,
    new_title TEXT,
    old_act TEXT NOT NULL,
    old_label TEXT,
    old_title TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('mapped', 'merged', 'new', 'deleted')),
    changed INTEGER NOT NULL DEFAULT 0 CHECK (changed IN (0, 1)),
    chapter TEXT,
    source_url TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    CHECK (new_label IS NOT NULL OR old_label IS NOT NULL)
  );
  CREATE INDEX provision_mapping_old ON provision_mapping(old_act, old_label);
  CREATE INDEX provision_mapping_new ON provision_mapping(new_act, new_label);
  `,

  // 4: provenance and amendment notes on every provision version — which
  // official document the text came from, and its footnotes (JSON array).
  `
  ALTER TABLE provision_version ADD COLUMN source_url TEXT;
  ALTER TABLE provision_version ADD COLUMN source_sha256 TEXT;
  ALTER TABLE provision_version ADD COLUMN footnotes TEXT;
  `,

  // 5: where a provision sits in its Act (Part / Chapter / group heading, first page), as JSON —
  // the backbone of topic roadmaps such as "Part III — Fundamental Rights".
  `
  ALTER TABLE provision ADD COLUMN context TEXT;
  `,

  // 6: stem English words in search ("detain" finds "detained") with the Porter stemmer,
  // keeping the Hindi-safe unicode61 settings underneath; rebuilds the index from stored text.
  `
  DROP TABLE provision_fts;
  CREATE VIRTUAL TABLE provision_fts USING fts5(
    label, heading, text, tokenize = "porter unicode61 categories 'L* N* Co M*'"
  );
  INSERT INTO provision_fts (rowid, label, heading, text)
    SELECT pv.id, p.label, COALESCE(p.heading, ''), pv.text
    FROM provision_version pv JOIN provision p ON p.id = pv.provision_id;
  `,

  // 7: change watching. A watch_target is a URL we revalidate on an adaptive schedule:
  // a 'listing' (index page whose links define a set of documents) or a 'document'.
  // Every observed difference becomes a change_event that downstream ingest drains.
  `
  CREATE TABLE watch_target (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL REFERENCES source(id),
    watchlist TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('listing', 'document')),
    parent_id INTEGER REFERENCES watch_target(id),
    label TEXT,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'gone')),
    state_reason TEXT,
    interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
    min_interval_ms INTEGER NOT NULL CHECK (min_interval_ms > 0),
    max_interval_ms INTEGER NOT NULL CHECK (max_interval_ms >= min_interval_ms),
    next_check_at TEXT NOT NULL,
    lease_until TEXT,
    last_checked_at TEXT,
    last_changed_at TEXT,
    last_sha256 TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX watch_target_due ON watch_target(state, next_check_at);
  CREATE INDEX watch_target_parent ON watch_target(parent_id);

  CREATE TABLE change_event (
    id INTEGER PRIMARY KEY,
    target_id INTEGER NOT NULL REFERENCES watch_target(id),
    kind TEXT NOT NULL CHECK (kind IN ('discovered', 'changed', 'removed', 'restored', 'gone', 'paused')),
    old_sha256 TEXT,
    new_sha256 TEXT,
    raw_path TEXT,
    detail TEXT,
    detected_at TEXT NOT NULL,
    processed_at TEXT,
    outcome TEXT
  );
  CREATE INDEX change_event_pending ON change_event(processed_at, id);
  `,

  // 8: "Is this copy current?" reports — a copy of an Act (by URL + sha256) compared with the
  // official provisions in the library. One report per copy version and library version.
  `
  CREATE TABLE copy_check (
    id INTEGER PRIMARY KEY,
    copy_url TEXT NOT NULL,
    copy_sha256 TEXT NOT NULL,
    act_id INTEGER NOT NULL REFERENCES act(id),
    official_sha256 TEXT NOT NULL,
    report TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    UNIQUE (copy_sha256, act_id, official_sha256)
  );
  CREATE INDEX copy_check_url ON copy_check(copy_url, id);
  `,

  // 9: text fingerprint of each stored PDF (keyed by its byte sha256), so a re-upload whose
  // bytes changed but whose text did not is recognised without re-checking anything.
  `
  CREATE TABLE text_fingerprint (
    sha256 TEXT PRIMARY KEY,
    text_sha256 TEXT NOT NULL,
    pages INTEGER NOT NULL,
    chars INTEGER NOT NULL,
    extracted_at TEXT NOT NULL
  );
  `,

  // 10: where an unofficial copy really comes from. A mirror PDF that prints a Gazette ID is matched
  // against the official e-Gazette file with that ID: byte-identical, or different.
  `
  CREATE TABLE provenance (
    id INTEGER PRIMARY KEY,
    copy_url TEXT NOT NULL,
    copy_sha256 TEXT NOT NULL,
    gazette_id TEXT NOT NULL,
    official_url TEXT NOT NULL,
    official_sha256 TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('identical', 'different')),
    checked_at TEXT NOT NULL,
    UNIQUE (copy_sha256, official_url)
  );
  CREATE INDEX provenance_copy ON provenance(copy_url, id);
  `,

  // 11: the case-law layer. Supreme Court judgments indexed from the Court's own records (title, coram,
  // dates, bench, official SCR headnote), linked to the provisions their headnote catchwords name;
  // machine-structured briefs whose every item quotes the judgment; and reviews, shown only once a
  // reviewer's identity is verified (no anonymous or unverifiable reviews).
  `
  ALTER TABLE court_case ADD COLUMN source_key TEXT;
  ALTER TABLE court_case ADD COLUMN source_url TEXT;
  ALTER TABLE court_case ADD COLUMN pdf_url TEXT;
  ALTER TABLE court_case ADD COLUMN case_no TEXT;
  ALTER TABLE court_case ADD COLUMN disposal TEXT;
  ALTER TABLE court_case ADD COLUMN coram TEXT;
  ALTER TABLE court_case ADD COLUMN author TEXT;
  ALTER TABLE court_case ADD COLUMN headnote TEXT;
  ALTER TABLE court_case ADD COLUMN cnr TEXT;
  CREATE UNIQUE INDEX court_case_source ON court_case(source_key);

  CREATE TABLE case_provision (
    case_id INTEGER NOT NULL REFERENCES court_case(id),
    act TEXT NOT NULL,
    label TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('headnote', 'judgment')),
    position INTEGER NOT NULL,
    PRIMARY KEY (case_id, act, label, source)
  );
  CREATE INDEX case_provision_lookup ON case_provision(act, label);

  CREATE VIRTUAL TABLE case_fts USING fts5(title, headnote, tokenize = "porter unicode61");

  CREATE TABLE case_brief (
    case_id INTEGER PRIMARY KEY REFERENCES court_case(id),
    judgment_sha256 TEXT NOT NULL,
    brief TEXT NOT NULL,
    model TEXT NOT NULL,
    kept INTEGER NOT NULL,
    dropped INTEGER NOT NULL,
    generated_at TEXT NOT NULL
  );

  CREATE TABLE case_review (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES court_case(id),
    reviewer_name TEXT NOT NULL,
    reviewer_credential TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL,
    source_url TEXT,
    verified_by TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX case_review_case ON case_review(case_id);

  CREATE TABLE sc_import (
    year INTEGER PRIMARY KEY,
    archive_sha256 TEXT NOT NULL,
    records INTEGER NOT NULL,
    cases INTEGER NOT NULL,
    imported_at TEXT NOT NULL
  );
  `,

  // 12: the full-text citation index. What each indexed judgment cites (one row per group of parallel
  // citations, with the reporter's treatment label and one sentence of context; the judgment text itself
  // is not kept), the citation graph resolved from it (rebuilt whenever more judgments are indexed or
  // more aliases are learned), citations learned from parallel citations, and how often a judgment's
  // text names each Article.
  `
  CREATE TABLE case_text (
    case_id INTEGER PRIMARY KEY REFERENCES court_case(id),
    pdf_sha256 TEXT NOT NULL,
    pages INTEGER NOT NULL,
    chars INTEGER NOT NULL,
    citations INTEGER NOT NULL,
    references_listed INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE TABLE judgment_reference (
    citing_id INTEGER NOT NULL REFERENCES court_case(id),
    ref_key TEXT NOT NULL,
    citations TEXT NOT NULL,
    name TEXT,
    page INTEGER NOT NULL,
    in_list INTEGER NOT NULL,
    treatment TEXT,
    category TEXT,
    mentions INTEGER NOT NULL,
    context TEXT,
    context_page INTEGER,
    PRIMARY KEY (citing_id, ref_key)
  );

  CREATE TABLE case_citation (
    citing_id INTEGER NOT NULL REFERENCES court_case(id),
    cited_id INTEGER NOT NULL REFERENCES court_case(id),
    in_list INTEGER NOT NULL,
    treatment TEXT,
    category TEXT,
    mentions INTEGER NOT NULL,
    ref_page INTEGER,
    context TEXT,
    context_page INTEGER,
    method TEXT NOT NULL CHECK (method IN ('alias', 'learned', 'name')),
    PRIMARY KEY (citing_id, cited_id)
  );
  CREATE INDEX case_citation_cited ON case_citation(cited_id, category);

  CREATE TABLE learned_alias (
    scheme TEXT NOT NULL,
    normalized TEXT NOT NULL,
    case_id INTEGER NOT NULL REFERENCES court_case(id),
    votes INTEGER NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('parallel', 'name')),
    PRIMARY KEY (scheme, normalized)
  );

  CREATE TABLE case_mention (
    case_id INTEGER NOT NULL REFERENCES court_case(id),
    act TEXT NOT NULL,
    label TEXT NOT NULL,
    mentions INTEGER NOT NULL,
    PRIMARY KEY (case_id, act, label)
  );
  CREATE INDEX case_mention_lookup ON case_mention(act, label, mentions);

  CREATE TABLE sc_text_import (
    year INTEGER PRIMARY KEY,
    index_sha256 TEXT NOT NULL,
    archive_sha256 TEXT,
    files INTEGER NOT NULL,
    indexed INTEGER NOT NULL,
    unmatched INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    imported_at TEXT NOT NULL
  );
  `,

  // 13: which version of the judgment reader produced a judgment's references, so an improved reader
  // re-reads exactly the judgments an older one indexed (and a year whose archive is unchanged).
  `
  ALTER TABLE case_text ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sc_text_import ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1;
  `,

  // 14: a consolidated edition proves its text only through its stated review date.
  // NULL preserves the existing open-ended editions; a bounded snapshot is excluded
  // from current-law lookup/search/coverage after this date, without claiming repeal.
  `
  ALTER TABLE provision_version ADD COLUMN verified_through TEXT;
  `,
]);
