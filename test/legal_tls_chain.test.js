import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
  completeChain,
  createChainCompletingFetch,
  isIncompleteChainError,
  issuerUrls,
} from '../src/sources/tlsChain.js';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = hasOpenssl ? false : 'openssl CLI not available to generate test certificates';

/** A throwaway CA: root → intermediate → leaf for "localhost", the leaf naming `aiaUrl` as its issuer URL. */
const makePki = (aiaUrl) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lawbuddy-pki-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  const ca = 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n';
  writeFileSync(path.join(dir, 'ca.ext'), ca);
  writeFileSync(path.join(dir, 'leaf.ext'),
    `basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost\nauthorityInfoAccess=caIssuers;URI:${aiaUrl}\n`);

  const make = (name, subject) => run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', subject);
  const sign = (name, issuer, ext, serial) => run('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`,
    '-set_serial', serial, '-days', '2', '-out', `${name}.pem`, '-extfile', ext);

  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '2',
    '-subj', '/CN=LawBuddy Test Root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  make('int', '/CN=LawBuddy Test Intermediate');
  sign('int', 'root', 'ca.ext', '2');
  make('leaf', '/CN=localhost');
  sign('leaf', 'int', 'leaf.ext', '3');
  // A look-alike intermediate with the same name but a different key: a forged issuer.
  make('forged', '/CN=LawBuddy Test Intermediate');
  run('x509', '-req', '-in', 'forged.csr', '-signkey', 'forged.key', '-days', '2', '-out', 'forged.pem', '-extfile', 'ca.ext');

  const read = (file) => readFileSync(path.join(dir, file), 'utf8');
  const pki = {
    root: read('root.pem'), int: read('int.pem'), leaf: read('leaf.pem'), leafKey: read('leaf.key'), forged: read('forged.pem'),
  };
  rmSync(dir, { recursive: true, force: true });
  return pki;
};

const der = (pem) => new crypto.X509Certificate(pem).raw;

test('incomplete-chain errors are recognised; issuer URLs are read from the certificate', { skip }, () => {
  assert.equal(isIncompleteChainError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })), true);
  assert.equal(isIncompleteChainError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } })), false);
  assert.equal(isIncompleteChainError(new Error('ECONNRESET')), false);
  const { leaf } = makePki('http://issuer.example/int.der');
  assert.deepEqual(issuerUrls(new crypto.X509Certificate(leaf)), ['http://issuer.example/int.der']);
});

test('completeChain fetches and verifies the missing issuer, and refuses anything that does not verify', { skip }, async () => {
  const pki = makePki('http://issuer.example/int.der');
  const leaf = new crypto.X509Certificate(pki.leaf);
  const serving = (pem) => async (url) => {
    assert.equal(url, 'http://issuer.example/int.der');
    return new Response(der(pem));
  };
  const base = { hostname: 'localhost', presented: async () => [leaf], trustedPems: [pki.root] };

  assert.deepEqual(await completeChain({ ...base, fetchImpl: serving(pki.int) }), [new crypto.X509Certificate(pki.int).toString()]);
  assert.equal(await completeChain({ ...base, hostname: 'egazette.gov.in', fetchImpl: serving(pki.int) }), null, 'wrong host');
  assert.equal(await completeChain({ ...base, fetchImpl: serving(pki.forged) }), null, 'forged issuer');
  assert.equal(await completeChain({ ...base, trustedPems: [pki.forged], fetchImpl: serving(pki.int) }), null, 'untrusted root');
  assert.equal(await completeChain({ ...base, now: Date.now() + 10 * 86400_000, fetchImpl: serving(pki.int) }), null, 'expired');
  assert.deepEqual(await completeChain({ ...base, presented: async () => [leaf, new crypto.X509Certificate(pki.int)],
    fetchImpl: async () => assert.fail('nothing to fetch') }), [], 'a complete chain needs nothing');
});

test('createChainCompletingFetch completes a host once, retries, and passes every other error through', async () => {
  const incomplete = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
  let installed = false;
  const calls = [];
  const completions = [];
  const wrapped = createChainCompletingFetch(async (url) => {
    calls.push(url);
    if (!installed) throw incomplete();
    return new Response('ok');
  }, {
    complete: async ({ hostname }) => { completions.push(hostname); return ['PEM']; },
    install: (pems) => { assert.deepEqual(pems, ['PEM']); installed = true; },
  });

  assert.equal(await (await wrapped('https://egazette.gov.in/robots.txt')).text(), 'ok');
  assert.equal(await (await wrapped('https://egazette.gov.in/a.pdf')).text(), 'ok');
  assert.deepEqual(completions, ['egazette.gov.in'], 'completed once per host');

  const failing = createChainCompletingFetch(async () => { throw incomplete(); }, { complete: async () => null, install: () => assert.fail() });
  await assert.rejects(failing('https://bad.example/'), /fetch failed/);
  const other = createChainCompletingFetch(async () => { throw new Error('ECONNRESET'); }, { complete: () => assert.fail() });
  await assert.rejects(other('https://x.example/'), /ECONNRESET/);
});

test('end to end: a server sending only its leaf fails plain fetch and succeeds once its chain is completed', { skip }, async () => {
  const issuerServer = http.createServer();
  await new Promise((resolve) => issuerServer.listen(0, '127.0.0.1', resolve));
  const aiaUrl = `http://127.0.0.1:${issuerServer.address().port}/int.der`;
  const pki = makePki(aiaUrl);
  issuerServer.on('request', (req, res) => res.writeHead(200, { 'Content-Type': 'application/pkix-cert' }).end(der(pki.int)));

  // Only the leaf, like egazette.gov.in.
  const site = https.createServer({ key: pki.leafKey, cert: pki.leaf }, (req, res) => res.end('gazette'));
  await new Promise((resolve) => site.listen(0, resolve));
  const url = `https://localhost:${site.address().port}/robots.txt`;
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), pki.root]); // the root is trusted, the intermediate is not
    await assert.rejects(fetch(url), (error) => isIncompleteChainError(error));

    const response = await createChainCompletingFetch(fetch)(url);
    assert.equal(await response.text(), 'gazette');
    assert.ok(tls.getCACertificates('default').some((pem) => pem.includes(pki.int.split('\n')[1])), 'intermediate installed');
  } finally {
    await new Promise((resolve) => site.close(resolve));
    await new Promise((resolve) => issuerServer.close(resolve));
  }
});
