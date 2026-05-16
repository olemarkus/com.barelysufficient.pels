/*
 * Static server for the built PELS settings UI (packages/settings-ui/dist).
 *
 * Optional env var:
 *   PELS_E2E_SIMULATE_HOMEY=light|dark
 *     Wraps the PELS UI in a Homey-like parent page so dev/Playwright runs see
 *     the same outer chrome (and dark-mode CSS filter) that the real
 *     my.homey.app shell layers around the PELS iframe. Captured fixtures live
 *     in packages/settings-ui/test/fixtures/homey-wrap/. When unset, the
 *     server serves PELS directly at `/` and behavior matches what it has
 *     always been.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4173;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const ROOT_DIR = path.join(PACKAGE_ROOT, 'dist');
const HOMEY_STUB_PATH = path.join(PACKAGE_ROOT, 'tests', 'e2e', 'fixtures', 'homey.stub.js');
const HOMEY_WRAP_FIXTURE_DIR = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'homey-wrap');

const RAW_SIMULATE_MODE = (process.env.PELS_E2E_SIMULATE_HOMEY ?? '').trim().toLowerCase();
const SIMULATE_HOMEY_MODE = RAW_SIMULATE_MODE === 'light' || RAW_SIMULATE_MODE === 'dark'
  ? RAW_SIMULATE_MODE
  : null;
if (RAW_SIMULATE_MODE && !SIMULATE_HOMEY_MODE) {
  console.warn(`[settings-ui static server] PELS_E2E_SIMULATE_HOMEY="${RAW_SIMULATE_MODE}" is not light|dark — ignoring`);
}

// Inner mount-point that hosts the real PELS iframe content when the Homey
// wrap is enabled. Keep it short so relative URLs in iframe HTML (e.g.
// `./style.css`) still resolve cleanly under it.
const WRAP_INNER_PREFIX = '/__pels__';

const buildHomeyWrapHtml = (mode) => {
  const themeClass = `${mode}Theme`;
  return `<!DOCTYPE html>
<html lang="en" class="${themeClass}" data-theme="${mode}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PELS (Homey wrap: ${mode})</title>
  <link rel="stylesheet" href="/__homey-wrap__/${mode}.css">
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    body { display: flex; min-height: 100vh; }
    .pels-homey-wrap-shell {
      display: flex;
      flex: 1 1 auto;
      min-height: 100vh;
      width: 100%;
    }
    iframe.pels-homey-wrap {
      width: 100%;
      min-height: 100vh;
      display: block;
      /* filter declaration comes from /__homey-wrap__/${mode}.css */
    }
  </style>
</head>
<body>
  <div class="pels-homey-wrap-shell">
    <iframe
      class="pels-homey-wrap"
      title="settings"
      sandbox="allow-scripts allow-forms allow-same-origin"
      src="${WRAP_INNER_PREFIX}/"
    ></iframe>
  </div>
</body>
</html>
`;
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

const parsePortArg = (argv) => {
  const idx = argv.indexOf('--port');
  if (idx === -1) return DEFAULT_PORT;
  const value = Number(argv[idx + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid --port value: ${argv[idx + 1]}`);
  }
  return value;
};

const isWithinRoot = (candidatePath) => {
  const rel = path.relative(ROOT_DIR, candidatePath);
  return (rel === '' || !rel.startsWith('..')) && !path.isAbsolute(rel);
};

const HOMEY_WRAP_CSS_PREFIX = '/__homey-wrap__/';

const resolveHomeyWrapCss = (pathname) => {
  if (!pathname.startsWith(HOMEY_WRAP_CSS_PREFIX)) return null;
  const tail = pathname.slice(HOMEY_WRAP_CSS_PREFIX.length);
  if (!/^[a-z]+\.css$/i.test(tail)) return null;
  const mode = tail.slice(0, -'.css'.length).toLowerCase();
  if (mode !== 'light' && mode !== 'dark') return null;
  return path.join(HOMEY_WRAP_FIXTURE_DIR, `homey-wrap.${mode}.css`);
};

const resolveInnerPelsPath = (pathname) => {
  if (!SIMULATE_HOMEY_MODE) return pathname;
  if (pathname === WRAP_INNER_PREFIX || pathname === `${WRAP_INNER_PREFIX}/`) return '/';
  if (pathname.startsWith(`${WRAP_INNER_PREFIX}/`)) return pathname.slice(WRAP_INNER_PREFIX.length);
  return pathname;
};

const resolveFilePath = async (pathname) => {
  const wrapCss = resolveHomeyWrapCss(pathname);
  if (wrapCss) return wrapCss;

  if (pathname === '/') {
    return path.join(ROOT_DIR, 'index.html');
  }

  if (pathname === '/homey.js') {
    return HOMEY_STUB_PATH;
  }

  const relativePathname = pathname.replace(/^\/+/, '');
  const fsPath = path.resolve(ROOT_DIR, relativePathname);
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
    if (pathname.endsWith('/')) {
      const dirIndex = path.resolve(ROOT_DIR, relativePathname, 'index.html');
      if (!isWithinRoot(dirIndex)) return null;
      return dirIndex;
    }
    return fsPath;
  }
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

      // Homey wrap: outer "/" returns a parent page that hosts the PELS UI in
      // an iframe whose src is /__pels__/. The wrap CSS comes from the
      // captured fixture under packages/settings-ui/test/fixtures/homey-wrap/.
      if (SIMULATE_HOMEY_MODE && pathname === '/') {
        send(
          res,
          200,
          { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          buildHomeyWrapHtml(SIMULATE_HOMEY_MODE),
        );
        return;
      }

      const inner = resolveInnerPelsPath(pathname);
      const fsPath = await resolveFilePath(inner);
      if (!fsPath) {
        send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
        return;
      }

      let data;
      try {
        data = await fs.readFile(fsPath);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
          return;
        }
        throw error;
      }

      const contentType = CONTENT_TYPES.get(path.extname(fsPath).toLowerCase()) ?? 'application/octet-stream';
      send(res, 200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }, data);
    } catch (error) {
      console.error('settings-ui static server error', error);
      send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = address && typeof address !== 'string' ? address.port : port;
    const wrapNote = SIMULATE_HOMEY_MODE ? ` (Homey wrap: ${SIMULATE_HOMEY_MODE})` : '';
    console.log(`settings-ui static server listening on http://127.0.0.1:${boundPort}${wrapNote}`);
  });
};

await main();
