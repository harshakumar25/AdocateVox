/**
 * Manual import: a person downloads an official document in their browser
 * (for sites whose firewall blocks declared bots) and LawBuddy takes it from
 * there. The original URL must belong to a registered source, the file goes
 * into the same content-addressed vault, and fetch_log marks it 'manual' so
 * provenance is never confused with an automatic fetch.
 */

import fs from 'node:fs/promises';
import { config } from '../config.js';
import { LEGAL_SOURCES, findSourceForUrl } from './registry.js';
import { storeInVault } from './vault.js';

const sniffContentType = (body) => (body.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : null);

export const importLocalDocument = async ({
  store,
  filePath,
  url,
  vaultDir = config.LEGAL_RAW_DIR,
  sources = LEGAL_SOURCES,
  maxBytes = config.LEGAL_FETCH_MAX_BYTES,
}) => {
  const source = findSourceForUrl(url, sources);
  if (!source) {
    throw new TypeError(`Refusing to import: ${url} is not on a registered legal source`);
  }

  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new TypeError(`${filePath} is not a file`);
  if (stat.size > maxBytes) throw new RangeError(`${filePath} exceeds ${maxBytes} bytes`);

  const body = await fs.readFile(filePath);
  const { sha256, rawPath } = await storeInVault(vaultDir, body);
  const contentType = sniffContentType(body);

  store.registerSource(source);
  store.recordFetch({
    sourceId: source.id, url, method: 'manual', sha256, contentType, byteLength: body.length, rawPath,
  });

  return { ok: true, method: 'manual', url, sourceId: source.id, sha256, rawPath, contentType, byteLength: body.length };
};
