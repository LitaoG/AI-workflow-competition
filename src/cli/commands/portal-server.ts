/**
 * Lightweight local portal HTTP server (P-ENV-6, Issue #270, Issue #275).
 *
 * Ensures that visual workflow boards and Studio views are served over
 * standard loopback HTTP (`http://127.0.0.1:<port>/`), completely bypassing
 * host IDE file associations that open `file:///` URLs as raw source code.
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

export async function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

export function createPortalHttpServer(viewsDir: string): http.Server {
  return http.createServer((req, res) => {
    let reqPath = req.url ? req.url.split('?')[0] : '/';
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

export async function ensurePortalServer(
  viewsDir: string,
  preferredPort = 8080,
): Promise<{ url: string; port: number; server?: http.Server }> {
  // If we already hold an in-process active portal server, reuse it
  if (activePortalServer && activePortalPort) {
    return { url: `http://127.0.0.1:${activePortalPort}/`, port: activePortalPort, server: activePortalServer };
  }

  // Check if preferredPort is already responding
  const listening = await isPortListening(preferredPort);
  if (listening) {
    return { url: `http://127.0.0.1:${preferredPort}/`, port: preferredPort };
  }

  // Bind to preferredPort or fall back to dynamic port 0
  const server = createPortalHttpServer(viewsDir);
  return new Promise((resolve, reject) => {
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Fall back to random dynamic port
        const fallbackServer = createPortalHttpServer(viewsDir);
        fallbackServer.listen(0, '127.0.0.1', () => {
          const addr = fallbackServer.address() as net.AddressInfo;
          activePortalServer = fallbackServer;
          activePortalPort = addr.port;
          resolve({ url: `http://127.0.0.1:${addr.port}/`, port: addr.port, server: fallbackServer });
        });
        fallbackServer.on('error', reject);
      } else {
        reject(err);
      }
    });

    server.listen(preferredPort, '127.0.0.1', () => {
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
