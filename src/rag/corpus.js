import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
export const CORPUS_PATH = path.join(path.dirname(config.LEGAL_DB_PATH), 'practice-rag.db');
export const digest = (text) => createHash('sha256').update(text).digest('hex');

// Page boundaries are retained; offsets allow every retrieved chunk to be traced to extraction.
export const chunkPages = (pages, wordsPerChunk = 450) => pages.flatMap((page) => {
  const text = page.lines.map((line) => typeof line === 'string' ? line : line.text).join('\n');
  const words = [...text.matchAll(/\S+/g)]; const chunks = [];
  for (let start = 0; start < words.length; start += wordsPerChunk) {
    const end = Math.min(start + wordsPerChunk, words.length);
    const offset = words[start].index; const finish = words[end - 1].index + words[end - 1][0].length;
    chunks.push({ page: page.page, start: offset, end: finish, text: text.slice(offset, finish) });
  }
  return chunks;
});
export const openCorpus = (file = CORPUS_PATH) => {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS rag_document(id TEXT PRIMARY KEY,title TEXT NOT NULL,topics TEXT NOT NULL,type TEXT NOT NULL,url TEXT,sha256 TEXT,checked_at TEXT,status TEXT NOT NULL,error TEXT,note TEXT);
    CREATE TABLE IF NOT EXISTS rag_chunk(id INTEGER PRIMARY KEY,document_id TEXT NOT NULL,page INTEGER,start_offset INTEGER,end_offset INTEGER,text TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(title,text,tokenize='unicode61');
    CREATE INDEX IF NOT EXISTS rag_document_chunks ON rag_chunk(document_id);`);
  const upsert = db.prepare(`INSERT INTO rag_document VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,topics=excluded.topics,type=excluded.type,url=excluded.url,sha256=excluded.sha256,checked_at=excluded.checked_at,status=excluded.status,error=excluded.error,note=excluded.note`);
  const remove = (id) => {
    db.prepare('DELETE FROM rag_fts WHERE rowid IN (SELECT id FROM rag_chunk WHERE document_id=?)').run(id);
    db.prepare('DELETE FROM rag_chunk WHERE document_id=?').run(id);
  };
  const replace = (entry, source, pages, error = null) => {
    const chunks = pages ? chunkPages(pages) : [];
    db.exec('BEGIN IMMEDIATE');
    try {
      remove(entry.id);
      upsert.run(entry.id,entry.title,JSON.stringify(entry.topics),entry.instrumentType,source?.url || entry.sourceUrl,source?.sha256 || null,new Date().toISOString(),chunks.length ? 'retrieved-text-unreviewed' : 'unavailable',error,entry.note || null);
      for (const chunk of chunks) {
        const result = db.prepare('INSERT INTO rag_chunk(document_id,page,start_offset,end_offset,text) VALUES(?,?,?,?,?)').run(entry.id,chunk.page,chunk.start,chunk.end,chunk.text);
        db.prepare('INSERT INTO rag_fts(rowid,title,text) VALUES(?,?,?)').run(result.lastInsertRowid,entry.title,chunk.text);
      }
      db.exec('COMMIT');
      return chunks.length;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const search = (query, { topic = '', instrument = '', limit = 8 } = {}) => {
    const stop = new Set(['the','and','for','with','from','what','which','how','does','under','explain','report','please']);
    const tokens = [...new Set((String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(t => !stop.has(t)))].slice(0, 24);
    if (!tokens.length) return [];
    const match = tokens.map((t) => `"${t}"`).join(' OR ');
    return db.prepare(`SELECT c.*,d.title,d.url,d.sha256,d.type,d.note,d.status,d.checked_at,bm25(rag_fts,2,1) AS rank
      FROM rag_fts JOIN rag_chunk c ON c.id=rag_fts.rowid JOIN rag_document d ON d.id=c.document_id
      WHERE rag_fts MATCH ? AND (?='' OR d.id=?) AND (?='' OR EXISTS(SELECT 1 FROM json_each(d.topics) WHERE value=?))
      ORDER BY rank,c.id LIMIT ?`).all(match,instrument,instrument,topic,topic,Math.max(1,Math.min(120,(Number(limit)||8)*5)))
      .map((r) => ({ ...r, contentsPage: /arrangement of (?:sections|rules)|(?:^|\n)\s*SECTIONS\s*(?:\n|$)/i.test(r.text), citation: `${r.document_id}, PDF page ${r.page}, offsets ${r.start_offset}-${r.end_offset}`, legalCurrency: 'Unreviewed source snapshot; not verified law in force.' }))
      .sort((a,b) => (a.contentsPage ? a.rank * .15 : a.rank) - (b.contentsPage ? b.rank * .15 : b.rank))
      .slice(0,Math.max(1,Math.min(30,Number(limit)||8)))
      .map((r) => ({...r, adjacentContext: db.prepare('SELECT page,start_offset,end_offset,text FROM rag_chunk WHERE document_id=? AND id IN (?,?) ORDER BY id').all(r.document_id,r.id-1,r.id+1)}));
  };
  return { replace, search, get: (id) => db.prepare('SELECT * FROM rag_document WHERE id=?').get(id),
    coverage: () => db.prepare('SELECT d.*,COUNT(c.id) AS chunks FROM rag_document d LEFT JOIN rag_chunk c ON c.document_id=d.id GROUP BY d.id ORDER BY d.title').all(), close: () => db.close() };
};
