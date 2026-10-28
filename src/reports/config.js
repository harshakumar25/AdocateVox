import { readFileSync } from 'node:fs';
export const REPORT_CONFIG = Object.freeze(JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')));
export const reportConfig = (overrides = {}) => ({ ...REPORT_CONFIG, ...overrides,
  drafts: { ...REPORT_CONFIG.drafts, ...overrides.drafts },
  temperatures: { ...REPORT_CONFIG.temperatures, ...overrides.temperatures } });
