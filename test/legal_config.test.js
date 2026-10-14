import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hostRootOf, loadLegalEnv, resolveBaseDir } from '../src/config.js';

test('LawBuddy finds its host project when installed as a dependency', () => {
  assert.equal(hostRootOf(path.join('/work', 'docvex', 'node_modules', '@docvex', 'lawbuddy')), path.join('/work', 'docvex'));
  assert.equal(hostRootOf(path.join('/work', 'lawbuddy')), null);
});

test('every .env is read, most specific first; the library is found in the host project', () => {
  const pkgRoot = path.join('/work', 'docvex', 'node_modules', '@docvex', 'lawbuddy');
  const present = new Set([path.join('/elsewhere', '.env'), path.join('/work', 'docvex', '.env'), path.join(pkgRoot, '.env')]);
  const loaded = [];
  loadLegalEnv({ cwd: '/elsewhere', pkgRoot, exists: (file) => present.has(file), load: (file) => loaded.push(file) });
  assert.deepEqual(loaded, [path.join('/elsewhere', '.env'), path.join('/work', 'docvex', '.env'), path.join(pkgRoot, '.env')]);

  const library = path.join('/work', 'docvex', '.lawbuddy');
  assert.equal(resolveBaseDir({ cwd: '/elsewhere', pkgRoot, legalRoot: '', exists: (dir) => dir === library }), path.join('/work', 'docvex'),
    'a server started from another directory still finds the host project\'s library');
  assert.equal(resolveBaseDir({ cwd: '/elsewhere', pkgRoot, legalRoot: '/data/law' }), path.resolve('/data/law'));
});
