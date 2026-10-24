/**
 * Import a reviewed India Code consolidated edition from immutable local snapshots.
 * A source-identified Act is never promoted by a search result alone: the PDF identity,
 * edition date, byte hash, central section metadata, and selected PDF clauses all have
 * to match this review manifest before a provision version is written.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { extractPdfText } from '../extract/pdfText.js';
import { decodeEntities } from '../parse/html.js';

const IT_ACT_ID = 'AC_CEN_45_76_00001_200021_1517807324077';
const INDIA_CODE_API = 'https://indiacode.gov.in/server/api/core';

export const IT_ACT_2025_CORE = Object.freeze({
  title: 'Information Technology Act, 2000', year: 2000, actNumber: '21 of 2000',
  actId: IT_ACT_ID,
  pdfUrl: `${INDIA_CODE_API}/bitstreams/770a7d02-48f2-4274-bab9-10d0f48ee264/content`,
  pdfSha256: '003b3218fe399b293c73f6aef9ca52e5c1d080388c43fb0523572c1dc5f3d529',
  editionAsOf: '2025-06-27',
  header: /The Information Technology Act, 2000[\s\S]*ACT NO\. 21 OF 2000[\s\S]*27th June, 2025/i,
  sections: Object.freeze([
    Object.freeze({
      label: 's.43', uuid: 'b85a05ed-3539-4e5b-8215-10f80d2867ed',
      sha256: '808c873f0cbc9da0119b9524dac8583dd7fe82ab8d84392aeab02b25f75b00f1',
      heading: 'Penalty and compensation for damage to computer, computer system, etc.',
      validFrom: '2009-10-27', pages: [20, 21],
      anchors: ['without permission of the owner', 'accesses or secures access', 'liable to pay damages by way of compensation to the person so affected'],
    }),
    Object.freeze({
      label: 's.66', uuid: 'd420742d-4d53-4225-a20d-7dcf89c0b274',
      sha256: 'a297b6e9dddb1eeab91cbb72c211206f53f945dab404f8083e07b1c32bb693a4',
      heading: 'Computer related offences.', validFrom: '2009-10-27', pages: [26, 26],
      anchors: ['dishonestly or fraudulently', 'does any act referred to in section 43', 'fine which may extend to five lakh rupees'],
    }),
  ]),
});

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const plain = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const only = (item, key) => item?.metadata?.[key]?.[0]?.value ?? null;
const urlFor = (section) => `${INDIA_CODE_API}/items/${section.uuid}`;

export const sectionTextFromHtml = (html) => decodeEntities(String(html || '')
  .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '') // editorial footnote markers, not operative words
  .replace(/<br\s*\/?\s*>|<hr\b[^>]*>/gi, '\n')
  .replace(/<[^>]*>/g, ' '))
  .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

const readPinned = async (document, expectedHash, label) => {
  if (!document) throw new Error(`${label} is not in the source vault.`);
  const bytes = await fs.readFile(document.raw_path);
  if (sha256(bytes) !== expectedHash || document.sha256 !== expectedHash) {
    throw new Error(`${label} changed from the reviewed byte snapshot; refusing to index it.`);
  }
  return bytes;
};

/**
 * The edition is deliberately bounded through its printed as-of date. A newer
 * verified edition can extend the review window; this import does not claim
 * that the 2025 PDF proves the text current in 2026.
 */
export const ingestReviewedIndiaCodeEdition = async ({ store, manifest = IT_ACT_2025_CORE, extract = extractPdfText }) => {
  const pdf = store.latestDocument(manifest.pdfUrl);
  const pdfBytes = await readPinned(pdf, manifest.pdfSha256, 'India Code Act PDF');
  if (pdfBytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Reviewed Act source is not a PDF.');
  const pages = await extract(pdf.raw_path);
  const pageText = (page) => page?.lines?.map((line) => line.text).join('\n') || '';
  if (!manifest.header.test(pageText(pages[0]))) throw new Error('Act identity or edition date does not match the reviewed manifest.');

  // Validate the entire requested set before any store mutation.
  const prepared = [];
  for (const section of manifest.sections) {
    const bytes = await readPinned(store.latestDocument(urlFor(section)), section.sha256, section.label);
    let item;
    try { item = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${section.label} metadata is not valid JSON.`); }
    if (item.id !== section.uuid || item.name !== section.heading
      || only(item, 'dc.identifier.act_id') !== manifest.actId
      || only(item, 'dc.identifier.state_name') !== 'CENTRAL'
      || only(item, 'dc.identifier.section_number') !== section.label.slice(2)) {
      throw new Error(`${section.label} does not belong to the reviewed Central Act section.`);
    }
    const body = sectionTextFromHtml(only(item, 'dc.identifier.section_page_note'));
    if (!body || !plain(body).includes(plain(section.heading))) throw new Error(`${section.label} has no matching section text and heading.`);
    const relevantPages = pages.slice(section.pages[0] - 1, section.pages[1]).map(pageText).join(' ');
    if (!section.anchors.every((anchor) => plain(body).includes(plain(anchor)) && plain(relevantPages).includes(plain(anchor)))) {
      throw new Error(`${section.label} does not match the reviewed clauses on PDF pages ${section.pages.join('–')}.`);
    }
    prepared.push({ section, body });
  }

  const actId = store.upsertAct({ shortTitle: manifest.title, year: manifest.year, actNumber: manifest.actNumber });
  for (const { section, body } of prepared) {
    const provisionId = store.upsertProvision({ actId, label: section.label, heading: section.heading.replace(/\.$/, ''),
      context: { pageStart: section.pages[0], pageEnd: section.pages[1], sourceItemUrl: urlFor(section), editionAsOf: manifest.editionAsOf } });
    store.addProvisionVersion({ provisionId, text: body, validFrom: section.validFrom, verifiedThrough: manifest.editionAsOf,
      sourceUrl: manifest.pdfUrl, sourceSha256: manifest.pdfSha256,
      footnotes: [{ review: `Verified against India Code edition as on ${manifest.editionAsOf}; later text and amendments require a newer source review.` }] });
  }
  return { ok: true, act: manifest.title, actId, sections: prepared.map(({ section }) => section.label),
    editionAsOf: manifest.editionAsOf, sourceUrl: manifest.pdfUrl, sha256: manifest.pdfSha256 };
};
