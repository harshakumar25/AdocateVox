import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const source = path.join(root, 'web');
const destination = path.join(root, 'dist');

fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(destination === source ? root : source, destination, {
  recursive: true
});

for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
  if (entry.isSymbolicLink()) {
    const full = path.join(destination, entry.name);
    const target = fs.readlinkSync(full);
    const base = path.basename(target);
    const relativeTarget = fs.existsSync(path.join(destination, base))
      ? base
      : (path.isAbsolute(target) ? path.relative(destination, target) : target);
    fs.unlinkSync(full);
    fs.symlinkSync(relativeTarget, full);
  }
}

console.log('Build successful: dist/');
