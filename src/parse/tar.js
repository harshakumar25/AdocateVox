/**
 * Minimal, dependency-free tar reader (POSIX ustar + pax long names) for the
 * yearly metadata archives of the Supreme Court open dataset. Regular files
 * only; links and devices are skipped. The archive is untrusted input, so
 * sizes and offsets are bounds-checked and nothing is ever written to disk.
 */

const BLOCK = 512;

const readString = (buffer, start, length) => {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
};

const readOctal = (buffer, start, length) => {
  const text = readString(buffer, start, length).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar: bad numeric field "${text}"`);
  return Number.parseInt(text, 8);
};

/** pax extended header records ("<len> key=value\n") → { path, ... }. */
const parsePax = (data) => {
  const records = {};
  let offset = 0;
  const text = data.toString('utf8');
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
};

/**
 * @param {Buffer} archive the whole tar file
 * @returns {{ name: string, data: Buffer }[]} regular files in archive order
 */
export const readTar = (archive) => {
  const files = [];
  let offset = 0;
  let paxPath = null;

  while (offset < archive.length) {
    if (offset + BLOCK > archive.length) {
      // Only zero padding may follow the last entry; anything else is an archive cut short.
      if (archive.subarray(offset).every((byte) => byte === 0)) break;
      throw new Error('tar: archive ends inside an entry header');
    }
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker

    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error('tar: entry runs past the end of the archive');
    const data = archive.subarray(dataStart, dataEnd);

    if (type === 'x') {
      paxPath = parsePax(data).path ?? null;
    } else if (type === '0' || type === '\0') {
      const prefix = readString(header, 345, 155);
      const name = paxPath ?? (prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100));
      files.push({ name, data });
      paxPath = null;
    } else {
      paxPath = null; // directories, links, global pax headers: nothing to read
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
};
