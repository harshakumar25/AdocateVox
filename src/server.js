/**
 * AdvocateVox Standalone HTTP Server.
 * Runs independently or as a companion service.
 */

import http from 'node:http';
import { config, loadLegalEnv } from './config.js';
import {
  handleAdvocateVoxStaticRoute,
  handleAdvocateVoxApiRoute,
  ADVOCATEVOX_FILES,
} from './routes.js';
import { createLegalStoreLoader } from './retrieval/legalRetriever.js';

loadLegalEnv();

export const createServer = ({
  legalStore = null,
  dbPath = config.LEGAL_DB_PATH,
  reportOptions = {},
} = {}) => {
  const legalLibrary = createLegalStoreLoader({ store: legalStore, dbPath });

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '127.0.0.1';
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;

    // Root redirect to website
    if (pathname === '/' || pathname === '') {
      res.writeHead(302, { Location: '/advocatevox' });
      res.end();
      return;
    }

    const sendJson = (response, status, data, request) => {
      const body = JSON.stringify(data);
      const isOriginAllowed = Boolean(request?.headers?.origin);
      const originHeader = isOriginAllowed ? { 'Access-Control-Allow-Origin': request.headers.origin } : {};
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        ...originHeader,
      });
      response.end(body);
    };

    try {
      // 1. Static asset / HTML route
      if (handleAdvocateVoxStaticRoute(req, res, pathname, ADVOCATEVOX_FILES)) return;

      // 2. API route
      if (await handleAdvocateVoxApiRoute(req, res, {
        pathname,
        parsedUrl,
        legalLibrary,
        sendJson,
        reportOptions,
      })) return;

      // 3. Fallback 404
      sendJson(res, 404, { error: 'Not found', pathname }, req);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error', message: error.message }, req);
      }
    }
  });

  return { server, legalLibrary };
};

export const startServer = (port = Number(process.env.PORT) || 3020) => {
  const { server, legalLibrary } = createServer();
  server.listen(port, () => {
    console.log(`AdvocateVox server running at http://127.0.0.1:${port}/advocatevox`);
  });

  const shutdown = async () => {
    console.log('\nShutting down AdvocateVox server...');
    await legalLibrary.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
};

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startServer();
}

