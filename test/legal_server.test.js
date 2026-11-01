import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { openLegalStore } from '../src/store/db.js';

test('AdvocateVox standalone HTTP server responds to web, api and redirect routes', async () => {
  const store = openLegalStore(':memory:');
  const { server, legalLibrary } = createServer({ legalStore: store });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Root redirect
    const rootRes = await fetch(baseUrl, { redirect: 'manual' });
    assert.equal(rootRes.status, 302);
    assert.equal(rootRes.headers.get('location'), '/advocatevox');

    // 2. Static HTML website
    const webRes = await fetch(`${baseUrl}/advocatevox`);
    assert.equal(webRes.status, 200);
    assert.match(webRes.headers.get('content-type'), /text\/html/);
    const html = await webRes.text();
    assert.match(html, /AdvocateVox/);

    // 3. API health endpoint
    const healthRes = await fetch(`${baseUrl}/advocatevox/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.service, 'AdvocateVox');
    assert.equal(health.status, 'ok');

    // 4. Missing route
    const notFoundRes = await fetch(`${baseUrl}/nonexistent-route`);
    assert.equal(notFoundRes.status, 404);
  } finally {
    await legalLibrary.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

