#!/usr/bin/env node
/**
 * scripts/seed-legal.mjs
 *
 * Automated seeder for AdvocateVox legal corpus:
 * 1. Downloads official Gazette / legislative PDFs to local cache if missing
 * 2. Imports and ingests BNS, BNSS, BSA (Central Acts)
 * 3. Imports and ingests Constitution of India (Official 2026 Edition)
 * 4. Fetches IPC, CrPC, IEA bare acts and computes old <-> new correspondences
 * 5. Runs verification checks and reports status
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const CACHE_DIR = join(ROOT, '.cache', 'legal-sources');

mkdirSync(CACHE_DIR, { recursive: true });

const SOURCES = [
  {
    name: 'BNS 2023 Gazette',
    file: join(CACHE_DIR, 'bns.pdf'),
    url: 'https://egazette.gov.in/WriteReadData/2023/250883.pdf',
    type: 'act',
    code: 'BNS',
  },
  {
    name: 'BNSS 2023 Gazette',
    file: join(CACHE_DIR, 'bnss.pdf'),
    url: 'https://egazette.gov.in/WriteReadData/2023/250884.pdf',
    type: 'act',
    code: 'BNSS',
  },
  {
    name: 'BSA 2023 Gazette',
    file: join(CACHE_DIR, 'bsa.pdf'),
    url: 'https://egazette.gov.in/WriteReadData/2023/250882.pdf',
    type: 'act',
    code: 'BSA',
  },
  {
    name: 'Constitution of India (2026 English Edition)',
    file: join(CACHE_DIR, 'constitution_2026.pdf'),
    url: 'https://www.legislative.gov.in/static/uploads/2025/07/c9fe9c9b6840524844316f74bb1c556c.pdf',
    type: 'constitution',
  },
];

const BARE_ACT_URLS = [
  { code: 'IPC', url: 'https://yourlordships.in/images/LLC/LawMore/yourlordships/img/pdf/bare-acts/ipc-bare-act.pdf' },
  { code: 'CrPC', url: 'https://yourlordships.in/images/LLC/LawMore/yourlordships/img/pdf/bare-acts/crpc-bare-act-1973.pdf' },
  { code: 'IEA', url: 'https://yourlordships.in/images/LLC/LawMore/yourlordships/img/pdf/bare-acts/evidence-act.pdf' },
];

function runCommand(cmd, args) {
  return new Promise((res, rej) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', cwd: ROOT });
    proc.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`));
    });
    proc.on('error', rej);
  });
}

async function downloadFile(url, dest) {
  if (existsSync(dest)) {
    console.log(`[Cache Hit] ${dest}`);
    return;
  }
  console.log(`[Downloading] ${url} -> ${dest}`);
  await runCommand('curl', ['-sL', '--retry', '3', '-A', 'Mozilla/5.0', '-o', dest, url]);
}

async function main() {
  console.log('=== AdvocateVox Legal Corpus Seeder ===\n');

  // Step 1: Download & Ingest primary statutory acts & Constitution
  for (const src of SOURCES) {
    console.log(`\n--- Ingesting ${src.name} ---`);
    await downloadFile(src.url, src.file);
    console.log(`Importing to legal vault: ${src.url}`);
    await runCommand('node', ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'import', src.file, src.url]);

    if (src.type === 'act') {
      console.log(`Ingesting Act: ${src.code}`);
      await runCommand('node', ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'ingest-act', src.code]);
    } else if (src.type === 'constitution') {
      console.log('Ingesting Constitution provisions...');
      await runCommand('node', ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'ingest-constitution', src.url]);
    }
  }

  // Step 2: Fetch IPC, CrPC, IEA and align with BNS, BNSS, BSA
  console.log('\n--- Aligning Old Codes (IPC, CrPC, IEA) <-> New Sanhitas ---');
  for (const { code, url } of BARE_ACT_URLS) {
    console.log(`Fetching ${code} bare act from ${url}...`);
    try {
      await runCommand('node', ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'fetch', url]);
    } catch {
      console.warn(`Fetch returned notice for ${code}, proceeding with alignment...`);
    }
    console.log(`Aligning ${code}...`);
    await runCommand('node', ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'align-codes', code]);
  }

  // Step 3: Verification
  console.log('\n--- Verifying Legal Grounding & Search ---');
  await runCommand('node', ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'article', '21A']);
  await runCommand('node', ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'lookup', 'IPC', '302']);

  console.log('\n=== All Legal Documents Successfully Indexed! ===');
}

main().catch((err) => {
  console.error('\nSeeding failed:', err.message);
  process.exit(1);
});
