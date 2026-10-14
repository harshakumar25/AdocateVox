/** Test helper: builds a valid PDF from standard Helvetica text lines, so tests need no fixture files. */

const escapePdfString = (text) => text.replace(/[\\()]/g, '\\$&');

/** Builds a valid PDF using only the standard Helvetica fonts (no fixture files needed). */
export const buildPdf = (pages) => {
  const fontObjects = [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  const pageCount = pages.length;
  const firstPageObject = 5;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPageObject + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...fontObjects,
  ];
  pages.forEach((lines, i) => {
    const content = lines
      .map((line) => `BT /${line.bold ? 'F2' : 'F1'} ${line.size} Tf ${line.x} ${line.y} Td (${escapePdfString(line.text)}) Tj ET`)
      .join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${firstPageObject + i * 2 + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
  });

  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
};
