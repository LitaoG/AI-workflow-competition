/**
 * Lightweight local portal HTTP server (P-ENV-6, Issue #270, Issue #275).
 *
 * Ensures that visual workflow boards and Studio views are served over
 * standard loopback HTTP (`http://127.0.0.1:<port>/`), completely bypassing
 * host IDE file associations that open `file:///` URLs as raw source code.
 *
 * Port Allocation & Collision Protection:
 * Defaults to dynamic random port allocation (port 0) or automatically falls
 * back to an ephemeral random port whenever a preferred port (e.g. 8080) is
 * occupied by a third-party user process.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

export const PORTAL_SIGNATURE_HEADER = 'x-ai-workflow-portal';
export const PORTAL_SIGNATURE_VALUE = '1';

/** Probes whether a port is currently open and accepting TCP connections. */
export async function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  if (port <= 0 || port > 65535) return false;
  return new Promise((resolve) => {
    const socket = net.connect(port, host, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

/** Probes whether an existing server on the given port is an ai-workflow portal instance. */
export async function isOurPortalListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  if (port <= 0 || port > 65535) return false;
  return new Promise((resolve) => {
    const req = http.get(
      `http://${host}:${port}/__portal_probe`,
      { timeout: 800 },
      (res) => {
        const isPortal = res.headers[PORTAL_SIGNATURE_HEADER] === PORTAL_SIGNATURE_VALUE;
        res.resume();
        resolve(isPortal);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export function createPortalHttpServer(viewsDir: string): http.Server {
  return http.createServer((req, res) => {
    res.setHeader(PORTAL_SIGNATURE_HEADER, PORTAL_SIGNATURE_VALUE);

    let reqPath = req.url ? req.url.split('?')[0] : '/';
    // Internal health & identity probe endpoint
    if (reqPath === '/__portal_probe' || reqPath === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'ai-workflow-portal' }));
      return;
    }

    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
    const normalized = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(viewsDir, normalized);

    if (!filePath.startsWith(viewsDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Not found: ${reqPath}`);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME_TYPES[ext] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  });
}

let activePortalServer: http.Server | undefined;
let activePortalPort: number | undefined;

/**
 * Ensures an active portal HTTP server is available for `viewsDir`.
 *
 * @param viewsDir Directory containing the HTML views
 * @param preferredPort Desired port (default 0 = OS assigns a random ephemeral port).
 *                      If preferredPort > 0 is already occupied by a foreign application,
 *                      it automatically falls back to an available dynamic random port.
 */
export async function ensurePortalServer(
  viewsDir: string,
  preferredPort = 0,
): Promise<{ url: string; port: number; server?: http.Server }> {
  // If we already hold an in-process active portal server, reuse it
  if (activePortalServer && activePortalPort) {
    return { url: `http://127.0.0.1:${activePortalPort}/`, port: activePortalPort, server: activePortalServer };
  }

  // If a specific preferred port (> 0) was requested:
  if (preferredPort > 0) {
    // 1. Check if our own portal is already listening on this port (cross-process reuse)
    const isOurs = await isOurPortalListening(preferredPort);
    if (isOurs) {
      return { url: `http://127.0.0.1:${preferredPort}/`, port: preferredPort };
    }

    // 2. Check if the port is occupied by another third-party application
    const occupied = await isPortListening(preferredPort);
    if (!occupied) {
      try {
        const bound = await new Promise<{ url: string; port: number; server: http.Server }>((resolve, reject) => {
          const s = createPortalHttpServer(viewsDir);
          s.once('error', reject);
          s.listen(preferredPort, '127.0.0.1', () => {
            const addr = s.address() as net.AddressInfo;
            resolve({ url: `http://127.0.0.1:${addr.port}/`, port: addr.port, server: s });
          });
        });
        activePortalServer = bound.server;
        activePortalPort = bound.port;
        return bound;
      } catch (err: any) {
        if (err.code !== 'EADDRINUSE') {
          throw err;
        }
        // EADDRINUSE: fall through to dynamic random port below
      }
    }
    // Port is occupied by third party: fall through to dynamic random port
  }

  // Bind to dynamic random port (port 0) - OS allocates an available ephemeral port
  const server = createPortalHttpServer(viewsDir);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      activePortalServer = server;
      activePortalPort = addr.port;
      resolve({ url: `http://127.0.0.1:${addr.port}/`, port: addr.port, server });
    });
  });
}

export function closeActivePortalServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activePortalServer) {
      activePortalServer.close(() => {
        activePortalServer = undefined;
        activePortalPort = undefined;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
