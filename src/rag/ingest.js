import fs from 'node:fs/promises';
import { PRACTICE_ACTS } from '../ingest/libraryCatalog.js';
import { runTextWorker } from '../cases/textIndex.js';
const extractPdfText = async (file) => {
  let record; await runTextWorker({ files: [file], idleTimeoutMs: 60000, onRecord: (value) => { record = value; } });
  if (record?.error || !record?.pages) throw new Error(record?.error || 'No extracted pages');
  return record.pages.map((text, i) => ({ page: i + 1, lines: text.split('\n') }));
};
import { findSourceForUrl } from '../sources/registry.js';
import { decodeEntities } from '../parse/html.js';
import { digest } from './corpus.js';
const ALTERNATIVES = { CERT2022: ['https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf'], TELCYBER2024: ['https://eservices.dot.gov.in/cyber-security/public/uploads/circulars/Telecommunications%20%28Telecom%20Cyber%20Security%29%20Rules%2C%202024.pdf-1751285968.pdf'], CA2013: ['https://nclat.nic.in/sites/default/files/2022-04/the-companies-act-2013.pdf'], CPC1908: ['https://aphc.gov.in/docs/6_20241130055515.pdf'], PATENTS1970: ['https://ipindia.gov.in/frontend/pdf/patents/1_113_1_The_Patents_Act__1970___incorporating_all_amendments_till_1-08-2024.pdf'] };
const normal = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g,' ');
export const matchesInstrument = (entry, pages) => {
  const header = normal(pages.slice(0, 8).flatMap((p) => p.lines.map((l) => typeof l === 'string' ? l : l.text)).join(' '));
  if (entry.id === 'CERT2022') return ['20 3 2022 cert in', '28 april 2022', 'directions under sub section 6 of section 70b'].every((anchor) => header.replace(/ +/g,' ').includes(anchor));
  const title = normal(entry.title).trim().replace(/^the /,'').replace(/ +/g,' ');
  return header.replace(/ +/g,' ').includes(title);
};
export const indexPracticeCorpus = async ({ store, fetcher, corpus, entries = PRACTICE_ACTS, extract = extractPdfText, onProgress = () => {}, force = false, recheck = false }) => {
  const results = [];
  for (const entry of entries.filter((e) => e.jurisdiction === 'IN')) {
    if (entry.instrumentType === 'standard') {
      corpus.replace(entry,null,null,'Licensed standard: catalogue page is not the full standard.');
      results.push({ id:entry.id,status:'unavailable',error:'Licensed full text unavailable' }); continue;
    }
    if (/also contains other notifications/i.test(entry.note || '')) {
      corpus.replace(entry,null,null,'Multi-instrument Gazette requires notification boundaries before indexing.'); results.push({id:entry.id,status:'unavailable',error:'Multi-instrument source needs segmentation'}); continue;
    }
    const previous = corpus.get(entry.id);
    if (!force && !recheck && previous?.status === 'retrieved-text-unreviewed' && previous.title === entry.title
      && previous.topics === JSON.stringify(entry.topics) && previous.note === (entry.note || null)
      && [entry.sourceUrl, ...(ALTERNATIVES[entry.id] || [])].includes(previous.url)) { results.push({id:entry.id,status:'cached'}); continue; }
    const attempted = new Set(); const queue = [entry.sourceUrl, ...(ALTERNATIVES[entry.id] || [])]; let accepted = false; const errors = [];
    while (queue.length && attempted.size < 8) {
      const url = queue.shift(); if (attempted.has(url) || !findSourceForUrl(url)) continue;
      attempted.add(url);
      try {
        const cached = store.latestDocument(url);
        const fetched = cached?.raw_path && !force ? {rawPath:cached.raw_path,sha256:cached.sha256} : await fetcher.fetchDocument(url);
        if (!fetched.rawPath) throw new Error(fetched.error || `HTTP ${fetched.status}`);
        const bytes = await fs.readFile(fetched.rawPath);
        if (digest(bytes) !== fetched.sha256) throw new Error('Source hash mismatch');
        if (bytes.subarray(0,5).toString() === '%PDF-') {
          const pages = await extract(fetched.rawPath);
          if (!matchesInstrument(entry,pages)) throw new Error('Extracted text does not establish instrument identity; OCR/source review needed');
          const chunks = corpus.replace(entry,{url,sha256:fetched.sha256},pages);
          if (!chunks) throw new Error('No readable text');
          results.push({id:entry.id,status:'indexed',chunks,url}); accepted=true; break;
        }
        // Landing pages are discovery only. Never embed navigation or catalogue summaries as law.
        const html = bytes.toString('utf8');
        const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
          .filter((m) => normal(decodeEntities(m[2].replace(/<[^>]*>/g,' '))).trim().replace(/ +/g,' ').includes(normal(entry.title).trim().replace(/^the /,'').replace(/ +/g,' ')))
          .map((m) => {try{return new URL(decodeEntities(m[1]),url).href;}catch{return null;}})
          .filter((link) => link && /\.pdf(?:[?#]|$)|\/bitstream[s]?\//i.test(link) && findSourceForUrl(link));
        queue.push(...links.slice(0,7));
        if (!links.length) errors.push('Catalogue page has no discoverable PDF link');
      } catch (error) { errors.push(error.message); }
    }
    if (!accepted) { const error=errors.join('; ') || 'No registered readable source'; corpus.replace(entry,null,null,error); results.push({id:entry.id,status:'unavailable',error}); }
    await onProgress(results.at(-1));
  }
  return results;
};
