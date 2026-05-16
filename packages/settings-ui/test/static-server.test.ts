/** @vitest-environment node */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');
const STATIC_SERVER_PATH = path.join(PACKAGE_ROOT, 'scripts', 'static-server.mjs');
const FIXTURE_NAME = 'static-server-fixture.txt';
const FIXTURE_PATH = path.join(DIST_DIR, FIXTURE_NAME);
const FIXTURE_CONTENT = 'settings-ui static server fixture';

const waitForServer = async (
  server: ReturnType<typeof spawn>,
): Promise<number> => {
  const readyPattern = /settings-ui static server listening on http:\/\/127\.0\.0\.1:(\d+)/;

  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for static server to become ready.'));
    }, 5000);
    const onStdout = (chunk: Buffer) => {
      const match = readyPattern.exec(chunk.toString('utf8'));
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Static server exited before becoming ready (code=${String(code)}, signal=${String(signal)}).`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      server.stdout?.off('data', onStdout);
      server.off('exit', onExit);
    };

    server.stdout?.on('data', onStdout);
    server.once('exit', onExit);
  });
};

const stopServer = async (server: ReturnType<typeof spawn>): Promise<void> => {
  if (server.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill('SIGKILL');
    }, 2000);
    server.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.kill('SIGTERM');
  });
};

const requestPath = async (
  port: number,
  pathname: string,
): Promise<{ status: number; body: string }> => (
  await new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: pathname,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
  })
);

describe('settings-ui static server', () => {
  let server: ReturnType<typeof spawn> | undefined;
  let port = 0;

  beforeAll(async () => {
    await fs.mkdir(DIST_DIR, { recursive: true });
    await fs.writeFile(FIXTURE_PATH, FIXTURE_CONTENT, 'utf8');
    server = spawn(process.execPath, [STATIC_SERVER_PATH, '--port', '0'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    port = await waitForServer(server);
  });

  afterAll(async () => {
    if (server) {
      await stopServer(server);
    }
    await fs.rm(FIXTURE_PATH, { force: true });
  });

  it('serves rooted asset URLs from dist instead of rejecting them', async () => {
    const response = await requestPath(port, `/${FIXTURE_NAME}`);

    expect(response.status).toBe(200);
    expect(response.body).toBe(FIXTURE_CONTENT);
  });
});

describe('settings-ui static server — Homey-wrap host CSS injection', () => {
  let server: ReturnType<typeof spawn> | undefined;
  let port = 0;
  // The suite needs `dist/index.html` so `/__pels__/` returns a real PELS
  // shell to rewrite. The production file is built by `npm run build` and
  // always contains a `./style.css` link, but `test:unit` runs the vitest
  // suite directly without a prior build, so we must seed a local fixture
  // when one isn't present. To avoid clobbering a real built file used by
  // other tests in the same run, write the stub only when missing and
  // clean it up only when we created it.
  const PELS_INDEX_PATH = path.join(DIST_DIR, 'index.html');
  const PELS_INDEX_STUB = (
    '<!DOCTYPE html><html><head>'
    + '<link rel="stylesheet" href="./style.css">'
    + '</head><body></body></html>'
  );
  let stubbedPelsIndex = false;

  beforeAll(async () => {
    await fs.mkdir(DIST_DIR, { recursive: true });
    try {
      await fs.stat(PELS_INDEX_PATH);
    } catch {
      await fs.writeFile(PELS_INDEX_PATH, PELS_INDEX_STUB, 'utf8');
      stubbedPelsIndex = true;
    }
    server = spawn(process.execPath, [STATIC_SERVER_PATH, '--port', '0'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PELS_E2E_SIMULATE_HOMEY: 'light' },
    });
    port = await waitForServer(server);
  });

  afterAll(async () => {
    if (server) {
      await stopServer(server);
    }
    if (stubbedPelsIndex) {
      await fs.rm(PELS_INDEX_PATH, { force: true });
    }
  });

  it('injects captured Homey host stylesheets into the iframe document after PELS style.css', async () => {
    // Inner PELS HTML is served under the `/__pels__/` mount when the wrap is
    // active. The captured `_base.css` rule that competes with PELS's
    // segmented control sits in the host CSS — without this injection the
    // local simulator would render PELS-correct and mask the bug.
    const response = await requestPath(port, '/__pels__/');
    expect(response.status).toBe(200);
    const baseIdx = response.body.indexOf('href="/__homey-host__/_base.css"');
    const buttonIdx = response.body.indexOf('href="/__homey-host__/_homey-button.css"');
    const homeyIdx = response.body.indexOf('href="/__homey-host__/homey.css"');
    const pelsIdx = response.body.indexOf('href="./style.css"');
    expect(baseIdx, 'host _base.css link should be injected').toBeGreaterThan(-1);
    expect(buttonIdx, 'host _homey-button.css link should be injected').toBeGreaterThan(-1);
    expect(homeyIdx, 'host homey.css link should be injected').toBeGreaterThan(-1);
    expect(pelsIdx, 'PELS style.css link should remain').toBeGreaterThan(-1);
    expect(
      baseIdx > pelsIdx && buttonIdx > pelsIdx && homeyIdx > pelsIdx,
      'Host CSS must follow PELS style.css so the cascade matches the real Homey shell (Homey loads its host CSS after PELS in the iframe, verified 2026-05-16)',
    ).toBe(true);
  });

  it('serves the captured _base.css with the legacy button rule that drives the segmented-control specificity bug', async () => {
    const response = await requestPath(port, '/__homey-host__/_base.css');
    expect(response.status).toBe(200);
    // The legacy button rule (`button:not(.hy-nostyle):not([class*='homey-button']):not([class*='hy-button']) { background-color: #e7e7e7; … }`)
    // is the specificity-(0,3,1) rule PELS's `.segmented .segmented__option`
    // (specificity (0,2,0)) used to lose to. Pin the cream colour so a
    // future fixture refresh that drops this rule is caught here.
    expect(response.body).toContain('background-color: #e7e7e7');
    expect(response.body).toContain("button:not(.hy-nostyle):not([class*='homey-button']):not([class*='hy-button'])");
  });
});
