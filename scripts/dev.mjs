/**
 * npm run dev — the AdvocateVox website served from this checkout.
 *
 * The /advocatevox pages and API, and the teaching pipeline behind /advocatevox/teach (with backwards-compatible
 * /lawbuddy routes), are served by DocVex's server, which normally imports the published @docvex/lawbuddy from
 * its node_modules. This links a private copy of that layout in .dev/ (git-ignored): DocVex's server, and
 * @docvex/lawbuddy pointing at this checkout, then runs it with --preserve-symlinks so the server imports
 * the code being worked on. DocVex's own node_modules are never touched.
 *
 *   DOCVEX_DIR  the DocVex checkout (default ../DOCVEX)
 *   PORT        the port (default 3020)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docvex = path.resolve(root, process.env.DOCVEX_DIR || '../DOCVEX');
const server = path.join(docvex, 'server', 'server.js');
if (!fs.existsSync(server)) {
  console.error(`DocVex's server was not found at ${server}. Set DOCVEX_DIR to the DocVex checkout.`);
  process.exit(1);
}

const dev = path.join(root, '.dev');
const link = (target, at) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  // Replace an earlier link (unlink removes the link itself, never what it points to); anything else is left alone.
  const existing = fs.lstatSync(at, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) fs.unlinkSync(at);
  else if (existing) throw new Error(`${at} exists and is not a link; remove it by hand`);
  fs.symlinkSync(target, at);
};
link(path.join(docvex, 'server'), path.join(dev, 'server'));
link(root, path.join(dev, 'node_modules', '@docvex', 'lawbuddy'));

// DocVex reads its .env (GROQ_API_KEY, providers) from its own folder: run from there.
const child = spawn(process.execPath, [
  '--preserve-symlinks', '--preserve-symlinks-main', '--disable-warning=ExperimentalWarning', path.join(dev, 'server', 'server.js'),
], {
  cwd: docvex,
  stdio: 'inherit',
  env: { CHATTERBOX_ENABLED: 'false', PORT: '3020', ...process.env },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
