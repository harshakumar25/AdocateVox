/**
 * Content-addressed raw vault: each document body is stored once at
 * <vaultDir>/<first two hex chars>/<sha256>, never overwritten.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Where the vault keeps the body with this sha256 (whether or not it is there). */
export const vaultPath = (vaultDir, sha256) => path.join(vaultDir, sha256.slice(0, 2), sha256);

export const storeInVault = async (vaultDir, body) => {
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const rawPath = vaultPath(vaultDir, sha256);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  try {
    await fs.writeFile(rawPath, body, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return { sha256, rawPath };
};
