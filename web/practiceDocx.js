/**
 * Small, dependency-free OOXML exporter for browser-local working drafts.
 * The package uses stored ZIP entries so it works without a build step or network call.
 * It deliberately exports no research leads as legal propositions.
 */

const encoder = new TextEncoder();
const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export { WORD_MIME };

const xmlText = (value) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const run = (value, placeholder = false) => `<w:r>${placeholder ? '<w:rPr><w:color w:val="8A5400"/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlText(value)}</w:t></w:r>`;
const runs = (value) => {
  const segments = String(value).split(/(\[[^\]\n]+\])/g);
  return segments.map((part) => run(part, /^\[[^\]\n]+\]$/.test(part))).join('');
};
const paragraph = (value, style = 'Normal', options = {}) => {
  const lines = String(value).split('\n');
  const contents = lines.map((line, index) => `${index ? '<w:r><w:br/></w:r>' : ''}${runs(line)}`).join('');
  const keepLines = lines.length > 1 && value.length < 1000;
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${options.pageBreakBefore ? '<w:pageBreakBefore/>' : ''}${keepLines ? '<w:keepLines/>' : ''}</w:pPr>${contents}</w:p>`;
};

const TITLES = Object.freeze({
  'fir-information': 'Police information request working draft',
  'anticipatory-bail': 'Anticipatory bail application working draft',
  'regular-bail': 'Regular bail application working draft',
  'civil-adjournment': 'Civil hearing adjournment working draft',
  'legal-opinion': 'Legal opinion working draft',
  'legal-report': 'Legal research report working document',
});

const paragraphStyle = (block) => {
  if (/^WORKING (?:DRAFT|LEGAL OPINION)/.test(block)) return 'Heading2';
  if (/^[A-Z][A-Z\s/&–—-]{2,70}$/.test(block)) return 'Heading1';
  return 'Normal';
};
const draftBlock = (block) => {
  const [first, ...rest] = block.split('\n');
  if (rest.length && /^[A-Z][A-Z\s/&–—-]{2,70}$/.test(first)) {
    return [paragraph(first, 'Heading1'), paragraph(rest.join('\n'))];
  }
  return [paragraph(block, paragraphStyle(block))];
};

const packageDocument = (packet, createdAt) => {
  const title = TITLES[packet.kind];
  if (!title || typeof packet.draft !== 'string') throw new TypeError('A supported prepared packet is required.');
  if (packet.blockers?.length) throw new Error('Resolve known forum or statutory restrictions before exporting.');
  if (packet.draft.length > 1_000_000) throw new RangeError('The draft is too large for browser export.');

  const body = [
    paragraph(title, 'Title'),
    paragraph('Working document for advocate review. Not a filing copy.', 'Subtitle'),
    ...packet.draft.split(/\n\s*\n/).filter(Boolean).flatMap(draftBlock),
    paragraph('Internal review notes', 'Heading1', { pageBreakBefore: true }),
    paragraph('This section is outside the proposed filing text. Resolve these items against the file and current local rules before use.', 'ReviewNote'),
    paragraph('Facts and documents to confirm', 'Heading2'),
    ...(packet.gaps?.length ? packet.gaps.map((item, index) => paragraph(`${index + 1}. ${item}`)) : [paragraph('No listed intake field is blank. Verify the entered facts and source references.')]),
    paragraph('Forum and legal checks', 'Heading2'),
    ...(packet.jurisdictionReview?.length ? packet.jurisdictionReview.map((item, index) => paragraph(`${index + 1}. ${item}`)) : [paragraph('Verify the chosen forum and its current local rules.')]),
    ...(packet.transition ? [paragraph('Historical law and transition', 'Heading2'), paragraph(packet.transition)] : []),
    paragraph('Limits of this working document', 'Heading2'),
    ...(packet.limitations || []).map((item, index) => paragraph(`${index + 1}. ${item}`)),
  ].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="150" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="22"/><w:color w:val="000000"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="180"/><w:keepNext/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="30"/><w:color w:val="000000"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="300"/><w:keepNext/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="20"/><w:color w:val="000000"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="260" w:after="120"/><w:keepNext/><w:keepLines/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="24"/><w:color w:val="000000"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/><w:keepNext/><w:keepLines/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="22"/><w:color w:val="000000"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="ReviewNote"><w:name w:val="Review Note"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:i/><w:sz w:val="20"/><w:color w:val="000000"/></w:rPr></w:style>
  </w:styles>`;
  const iso = createdAt.toISOString();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dc:creator>LawBuddy</dc:creator><cp:description>Working draft for advocate review</cp:description><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created></cp:coreProperties>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return [
    ['[Content_Types].xml', types],
    ['_rels/.rels', rels],
    ['docProps/core.xml', core],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/_rels/document.xml.rels', documentRels],
  ];
};

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
};
const combined = (pieces) => {
  const output = new Uint8Array(pieces.reduce((length, piece) => length + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) { output.set(piece, offset); offset += piece.length; }
  return output;
};

const storedZip = (files, date) => {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1);
  const dosDate = (Math.max(1980, date.getFullYear()) - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const fileName = encoder.encode(name);
    const bytes = encoder.encode(value);
    const checksum = crc32(bytes);
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034B50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, bytes.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, fileName.length, true);
    local.push(header, fileName, bytes);

    const directory = new Uint8Array(46);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014B50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(8, 0x0800, true);
    directoryView.setUint16(12, dosTime, true);
    directoryView.setUint16(14, dosDate, true);
    directoryView.setUint32(16, checksum, true);
    directoryView.setUint32(20, bytes.length, true);
    directoryView.setUint32(24, bytes.length, true);
    directoryView.setUint16(28, fileName.length, true);
    directoryView.setUint32(42, offset, true);
    central.push(directory, fileName);
    offset += header.length + fileName.length + bytes.length;
  }
  const centralBytes = combined(central);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054B50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralBytes.length, true);
  endView.setUint32(16, offset, true);
  return combined([...local, centralBytes, end]);
};

export const buildWorkingDraftDocx = (packet, { createdAt = new Date() } = {}) => {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new TypeError('A valid export date is required.');
  return storedZip(packageDocument(packet, createdAt), createdAt);
};
