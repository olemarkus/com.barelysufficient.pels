import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '../..');
const temporaryRoots: string[] = [];
const forwardingSource = `
class Destination {
  write(line: string): void {
    this.callbacks.log(line);
  }
}
`;

const runGuard = (relativePath: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-logging-guard-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(
    path.join(repoRoot, 'scripts/check-logging-legacy.mjs'),
    path.join(root, 'scripts/check-logging-legacy.mjs'),
  );
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, forwardingSource);
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-logging-legacy.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy logging guard channel exemption', () => {
  it('permits the logging channel to forward serialized lines through the SDK callback', () => {
    const result = runGuard('lib/logging/destination.ts');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('logging:no-legacy OK');
  });

  it.each(['lib/power/forwarder.ts', 'setup/forwarder.ts'])(
    'continues banning SDK callback logging in %s', (relativePath) => {
      const result = runGuard(relativePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(relativePath);
    },
  );
});
