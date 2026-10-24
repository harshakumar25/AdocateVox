import { readFileSync } from 'node:fs';
const concordance = JSON.parse(readFileSync(new URL('./concordance.json', import.meta.url), 'utf8'));

export const temporalFramework = (decisionDate, cards, asOf) => concordance.rows.flatMap((row) => {
  const applicable = cards.filter((c) => c.type === 'statute_ref' &&
    ((/\bCr\.?\s*P\.?\s*C\.?\b|Code of Criminal Procedure/i.test(c.quote) && /\b152\b/.test(c.quote))
      || (decisionDate >= row.commencement && /\bBNSS\b|Bharatiya Nagarik Suraksha/i.test(c.quote) && /\b171\b/.test(c.quote))));
  if (!applicable.length) return [];
  const before = decisionDate < row.commencement;
  return [{ asDecided: before ? 'CrPC s.152 (identified in the supplied judgment)' : 'Determine from the judgment and pending-proceeding history',
    currentEquivalent: asOf >= row.commencement ? 'BNSS s.171 (correspondence only)' : 'CrPC s.152',
    commencement: row.commencement, evidenceIds: applicable.map((c) => c.id), ...row }];
});
