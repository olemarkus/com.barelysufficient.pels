/** @vitest-environment node */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');
const STATIC_SERVER_PATH = path.join(PACKAGE_ROOT, 'scripts', 'static-server.mjs');
const FIXTURE_NAME = 'static-server-fixture.txt';
const FIXTURE_PATH = path.join(DIST_DIR, FIXTURE_NAME);
const FIXTURE_CONTENT = 'settings-ui static server fixture';

const getFreePort = async (): Promise<number> => (
  await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate test port.'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  })
);

const waitForServer = async (
  server: ReturnType<typeof spawn>,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for static server to become ready.'));
    }, 5000);
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('settings-ui static server listening')) {
        cleanup();
        resolve();
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
    port = await getFreePort();
    server = spawn(process.execPath, [STATIC_SERVER_PATH, '--port', String(port)], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(server);
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
