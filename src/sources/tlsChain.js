/**
 * Completes certificate chains that servers send incomplete, the way browsers do.
 *
 * Some official sites (egazette.gov.in) present only their own certificate and
 * leave out the intermediate that links it to a trusted root. Browsers and
 * macOS curl fetch the missing issuer from the certificate's "CA Issuers" (AIA)
 * URL; Node does not, so the handshake fails. Here, on exactly that failure:
 *
 * 1. the server's presented certificates are read (handshake only, nothing sent);
 * 2. the leaf must match the hostname and be within its validity dates;
 * 3. each missing issuer is fetched from its AIA URL and its signature checked,
 *    until a certificate is signed by a root Node already trusts;
 * 4. only then are the fetched intermediates added to the trusted set, and the
 *    request is retried with full, normal verification.
 * Verification is never switched off for the request itself, and nothing is
 * trusted that does not chain to a root Node ships with.
 */

import crypto from 'node:crypto';
import tls from 'node:tls';

const INCOMPLETE_CHAIN_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
]);
const MAX_ISSUER_BYTES = 64 * 1024;
const MAX_DEPTH = 4;

export const isIncompleteChainError = (error) => INCOMPLETE_CHAIN_CODES.has(error?.cause?.code ?? error?.code);

const toCertificate = (bytes) => {
  const text = bytes.toString('latin1');
  return new crypto.X509Certificate(text.includes('-----BEGIN CERTIFICATE-----') ? text : bytes);
};

const withinValidity = (certificate, now) =>
  Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo);

/** The "CA Issuers" URLs a certificate names for its issuer (http/https only). */
export const issuerUrls = (certificate) =>
  [...String(certificate.infoAccess || '').matchAll(/CA Issuers - URI:(\S+)/g)]
    .map(([, url]) => url)
    .filter((url) => /^https?:\/\//i.test(url));

/** The certificates a server presents, leaf first. Only the handshake happens; no request is sent. */
export const presentedCertificates = (hostname, port = 443, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
      const chain = [];
      for (let peer = socket.getPeerCertificate(true); peer?.raw && !chain.some((c) => c.raw.equals(peer.raw));) {
        chain.push(new crypto.X509Certificate(peer.raw));
        peer = peer.issuerCertificate;
      }
      socket.destroy();
      resolve(chain);
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`TLS handshake with ${hostname} timed out`)));
    socket.on('error', reject);
  });

const fetchIssuer = async (url, fetchImpl, timeoutMs) => {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`issuer ${url}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_ISSUER_BYTES) throw new Error(`issuer ${url}: too large`);
  return toCertificate(body);
};

/**
 * Returns the PEMs of the intermediates that complete `hostname`'s chain to a trusted root,
 * or null when it cannot be completed and verified.
 */
export const completeChain = async ({
  hostname,
  port = 443,
  trustedPems = tls.getCACertificates('default'),
  presented = presentedCertificates,
  fetchImpl = fetch,
  now = Date.now(),
  timeoutMs = 15000,
}) => {
  const chain = await presented(hostname, port, timeoutMs);
  const [leaf] = chain;
  if (!leaf || !leaf.checkHost(hostname) || !withinValidity(leaf, now)) return null;

  const roots = trustedPems.map((pem) => new crypto.X509Certificate(pem));
  const signedBy = (child, parent) => child.checkIssued(parent) && child.verify(parent.publicKey);

  // Keep what the server did send if it links up; stop at the first gap.
  let current = leaf;
  for (const sent of chain.slice(1)) {
    if (!signedBy(current, sent) || !withinValidity(sent, now)) break;
    current = sent;
  }

  const fetched = [];
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    if (roots.some((root) => signedBy(current, root))) return fetched.map((certificate) => certificate.toString());
    if (depth === MAX_DEPTH) return null;
    let issuer = null;
    for (const url of issuerUrls(current)) {
      try {
        const candidate = await fetchIssuer(url, fetchImpl, timeoutMs);
        if (candidate.ca && signedBy(current, candidate) && withinValidity(candidate, now)) {
          issuer = candidate;
          break;
        }
      } catch {
        // Try the next URL, if any.
      }
    }
    if (!issuer) return null;
    fetched.push(issuer);
    current = issuer;
  }
  return null;
};

/** Adds verified intermediates to the CA set every new TLS connection in this process uses. */
export const installIntermediates = (pems) => {
  const current = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...current, ...pems.filter((pem) => !current.includes(pem))]);
};

/**
 * Wraps fetch: when a host's chain is incomplete, complete and verify it once (per host), then
 * retry the request with normal verification. Every other error passes through untouched.
 */
export const createChainCompletingFetch = (baseFetch = fetch, { complete = completeChain, install = installIntermediates } = {}) => {
  const attempts = new Map();
  return async (url, options) => {
    try {
      return await baseFetch(url, options);
    } catch (error) {
      const { hostname, port, protocol } = new URL(url);
      if (protocol !== 'https:' || !isIncompleteChainError(error)) throw error;
      if (!attempts.has(hostname)) {
        attempts.set(hostname, complete({ hostname, port: Number(port) || 443 })
          .then((pems) => {
            if (pems?.length) install(pems);
            return Boolean(pems?.length);
          })
          .catch(() => false));
      }
      if (!(await attempts.get(hostname))) throw error;
      return baseFetch(url, options);
    }
  };
};
