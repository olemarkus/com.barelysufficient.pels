// Zero-dependency static server for the widget harness. Serves the repo root so
// the harness page can load the COMMITTED widget bundles under /widgets/*/public
// (run `npm run build:widgets` first if you changed widget source) and its own
// files under /tests/widget-harness. Same-origin over http so the harness's
// srcdoc iframes can reach `parent` (file:// origins make that flaky).
//
//   node tests/widget-harness/serve.mjs   →  http://localhost:4178/tests/widget-harness/
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT) || 4178;
// Bind all interfaces by default so a phone/tablet on the same LAN can reach it;
// override with HOST=127.0.0.1 to keep it local-only.
const HOST = process.env.HOST || '0.0.0.0';

// LAN IPv4 addresses, so the startup log prints a URL you can open on another
// device instead of a localhost one that only works on this machine.
const lanAddresses = () => Object.values(os.networkInterfaces())
  .flat()
  .filter((nic) => nic && nic.family === 'IPv4' && !nic.internal)
  .map((nic) => nic.address);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  // Resolve within ROOT; reject path traversal. A bare `startsWith(ROOT)` would
  // let a sibling dir like `<ROOT>-helper` through, so check the relative path
  // stays inside ROOT (no leading `..`, not absolute).
  const filePath = path.join(ROOT, pathname);
  const relativeToRoot = path.relative(ROOT, filePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`Not found: ${pathname}`);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(filePath)] ?? 'application/octet-stream' }).end(data);
  });
});

server.listen(PORT, HOST, () => {
  const suffix = `:${PORT}/tests/widget-harness/`;
  const lines = [`  http://localhost${suffix}  (this machine)`];
  for (const ip of lanAddresses()) lines.push(`  http://${ip}${suffix}  (LAN — open on phone/tablet)`);
  console.log(`Widget harness listening on ${HOST}:${PORT}\n${lines.join('\n')}`);
});
