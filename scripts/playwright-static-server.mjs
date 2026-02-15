import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PORT = 4173;

const parsePortArg = (argv) => {
  const idx = argv.indexOf('--port');
  if (idx === -1) return DEFAULT_PORT;
  const value = argv[idx + 1];
  const port = Number(value);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  return port;
};

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const ROOT_DIR = process.cwd();
const HOMEY_STUB_PATH = path.join(ROOT_DIR, 'tests', 'e2e', 'fixtures', 'homey.stub.js');

const isWithinRoot = (candidatePath) => {
  const rel = path.relative(ROOT_DIR, candidatePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const resolveFilePath = async (pathname) => {
  if (pathname === '/') {
    return path.join(ROOT_DIR, 'settings', 'index.html');
  }

  if (pathname === '/homey.js') {
    return HOMEY_STUB_PATH;
  }

  const fsPath = path.normalize(path.join(ROOT_DIR, pathname));
  if (!isWithinRoot(fsPath)) {
    return null;
  }

  try {
    const stat = await fs.stat(fsPath);
    if (stat.isDirectory()) {
      return path.join(fsPath, 'index.html');
    }
    return fsPath;
  } catch {
    // Fallthrough: try with /index.html for directory-like paths.
  }

  if (pathname.endsWith('/')) {
    const dirIndex = path.normalize(path.join(ROOT_DIR, pathname, 'index.html'));
    if (!isWithinRoot(dirIndex)) return null;
    return dirIndex;
  }

  return fsPath;
};

const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  if (res.req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
};

const main = async () => {
  const port = parsePortArg(process.argv.slice(2));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
        return;
      }

      const fsPath = await resolveFilePath(pathname);
      if (!fsPath) {
        send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
        return;
      }

      let data;
      try {
        data = await fs.readFile(fsPath);
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
          send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
          return;
        }
        throw err;
      }
      const ext = path.extname(fsPath).toLowerCase();
      const contentType = CONTENT_TYPES.get(ext) ?? 'application/octet-stream';

      send(
        res,
        200,
        {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        },
        data,
      );
    } catch (err) {
      console.error('playwright-static-server error', err);
      send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`playwright-static-server listening on http://127.0.0.1:${port}`);
  });
};

await main();
