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

// Normalize root symlinks to be relative
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

// Structure /advocatevox/assets and /lawbuddy/assets for static hosting and preview tools
for (const prefix of ['advocatevox', 'lawbuddy']) {
  const assetsDir = path.join(destination, prefix, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const file of fs.readdirSync(destination)) {
    if (file === 'advocatevox' || file === 'lawbuddy') continue;
    const srcFile = path.join(destination, file);
    if (fs.statSync(srcFile).isFile() || fs.lstatSync(srcFile).isSymbolicLink()) {
      const linkPath = path.join(assetsDir, file);
      fs.symlinkSync(path.join('../../', file), linkPath);
      if (file.endsWith('.html')) {
        const htmlLink = path.join(destination, prefix, file);
        if (!fs.existsSync(htmlLink)) {
          fs.symlinkSync(path.join('../', file), htmlLink);
        }
      }
    }
  }
}

console.log('Build successful: dist/');
