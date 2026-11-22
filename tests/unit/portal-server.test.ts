/**
 * Portal HTTP server unit tests (Issue #275).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensurePortalServer,
  closeActivePortalServer,
  isPortListening,
  isOurPortalListening,
  createPortalHttpServer,
  PORTAL_SIGNATURE_HEADER,
  PORTAL_SIGNATURE_VALUE,
} from '../../src/cli/commands/portal-server.js';

function httpGet(url: string): Promise<{ status: number; contentType?: string; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          contentType: res.headers['content-type'],
          headers: res.headers,
          body: data,
        });
      });
    }).on('error', reject);
  });
}

test('portal-server: isPortListening accurately probes ports', async () => {
  // Random ephemeral port that shouldn't be listening
  const freePort = 59871;
  const initiallyListening = await isPortListening(freePort);
  assert.equal(initiallyListening, false, 'free port should not be listening initially');

  // Start temporary server
  const tempServer = http.createServer((_, res) => res.end('ok'));
  await new Promise<void>((resolve) => tempServer.listen(freePort, '127.0.0.1', () => resolve()));

  const nowListening = await isPortListening(freePort);
  assert.equal(nowListening, true, 'port should be detected as listening');

  await new Promise<void>((resolve) => tempServer.close(() => resolve()));
});

test('portal-server: isOurPortalListening distinguishes our portal from third-party servers', async () => {
  const foreignPort = 59875;
  const portalPort = 59876;

  // 1. Third-party foreign server (e.g., user Tomcat/React on 8080 or custom port)
  const foreignServer = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('foreign app');
  });
  await new Promise<void>((resolve) => foreignServer.listen(foreignPort, '127.0.0.1', () => resolve()));

  try {
    const isForeignOurs = await isOurPortalListening(foreignPort);
    assert.equal(isForeignOurs, false, 'foreign server must NOT be identified as our portal');
    const foreignListening = await isPortListening(foreignPort);
    assert.equal(foreignListening, true, 'foreign port is listening');
  } finally {
    await new Promise<void>((resolve) => foreignServer.close(() => resolve()));
  }

  // 2. Real portal server
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-probe-'));
  try {
    const ourServer = createPortalHttpServer(tmpDir);
    await new Promise<void>((resolve) => ourServer.listen(portalPort, '127.0.0.1', () => resolve()));

    try {
      const isPortalOurs = await isOurPortalListening(portalPort);
      assert.equal(isPortalOurs, true, 'our portal must be identified via signature');
    } finally {
      await new Promise<void>((resolve) => ourServer.close(() => resolve()));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('portal-server: serves html files with correct headers and prevents directory traversal', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>Portal Home</h1>', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'demo.html'), '<title>Demo</title>', 'utf-8');

    const server = createPortalHttpServer(tmpDir);
    const port = 59872;
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

    try {
      // 1. Root / -> index.html
      const rootRes = await httpGet(`http://127.0.0.1:${port}/`);
      assert.equal(rootRes.status, 200);
      assert.ok(rootRes.contentType?.includes('text/html'));
      assert.ok(rootRes.body.includes('Portal Home'));
      assert.equal(rootRes.headers[PORTAL_SIGNATURE_HEADER], PORTAL_SIGNATURE_VALUE);

      // 2. /demo.html -> demo.html
      const demoRes = await httpGet(`http://127.0.0.1:${port}/demo.html`);
      assert.equal(demoRes.status, 200);
      assert.ok(demoRes.body.includes('<title>Demo</title>'));

      // 3. /__portal_probe -> 200 JSON
      const probeRes = await httpGet(`http://127.0.0.1:${port}/__portal_probe`);
      assert.equal(probeRes.status, 200);
      assert.ok(probeRes.body.includes('ai-workflow-portal'));

      // 4. 404 for missing file
      const missingRes = await httpGet(`http://127.0.0.1:${port}/missing.html`);
      assert.equal(missingRes.status, 404);

      // 5. Directory traversal attempt blocked
      const traversalRes = await httpGet(`http://127.0.0.1:${port}/../../etc/passwd`);
      assert.ok(traversalRes.status === 403 || traversalRes.status === 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('portal-server: ensurePortalServer defaults to dynamic random port (port 0)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-dyn-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'demo.html'), 'dynamic demo', 'utf-8');

    // Default call: preferredPort is 0
    const portal = await ensurePortalServer(tmpDir);
    try {
      assert.ok(portal.port > 0, 'assigned port must be positive');
      assert.ok(portal.url.startsWith(`http://127.0.0.1:${portal.port}/`));

      const res = await httpGet(`${portal.url}demo.html`);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('dynamic demo'));
    } finally {
      await closeActivePortalServer();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('portal-server: ensurePortalServer falls back to dynamic port when preferredPort is occupied by user', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-conflict-'));
  const occupiedPort = 59877;

  // Simulate third-party user app running on occupiedPort
  const foreignServer = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('user custom app');
  });
  await new Promise<void>((resolve) => foreignServer.listen(occupiedPort, '127.0.0.1', () => resolve()));

  try {
    fs.writeFileSync(path.join(tmpDir, 'demo.html'), 'fallback demo', 'utf-8');

    // Attempt to bind occupiedPort
    const portal = await ensurePortalServer(tmpDir, occupiedPort);
    try {
      assert.notEqual(portal.port, occupiedPort, 'must NOT hijack foreign occupied port');
      assert.ok(portal.port > 0, 'assigned fallback port must be positive');
      assert.ok(portal.url.startsWith(`http://127.0.0.1:${portal.port}/`));

      const res = await httpGet(`${portal.url}demo.html`);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('fallback demo'));
    } finally {
      await closeActivePortalServer();
    }
  } finally {
    await new Promise<void>((resolve) => foreignServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('portal-server: ensurePortalServer creates and reuses active server', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ensure-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), 'hello portal', 'utf-8');

    const portal = await ensurePortalServer(tmpDir, 59873);
    assert.ok(portal.url.startsWith('http://127.0.0.1:'));
    assert.equal(portal.port, 59873);

    // Reuse check
    const second = await ensurePortalServer(tmpDir, 59873);
    assert.equal(second.port, portal.port);

    const res = await httpGet(portal.url);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('hello portal'));

    await closeActivePortalServer();
  } finally {
    await closeActivePortalServer();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
