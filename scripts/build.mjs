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
  recursive: true,
  dereference: true
});

console.log('Build successful: dist/');
