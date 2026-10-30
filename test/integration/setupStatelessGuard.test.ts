import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The closure-state check of scripts/check-setup-stateless.mjs, run against
// fixture trees: a retained closure variable fails, per-call locals pass, and
// a budgeted file cannot grow.

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/check-setup-stateless.mjs');
const tempDirs: string[] = [];

const makeTree = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-setup-stateless-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};

const runGuard = (dir: string, allowlist: Record<string, number> = {}) => {
  const allowlistFile = path.join(dir, 'allowlist.txt');
  fs.writeFileSync(allowlistFile, Object.entries(allowlist)
    .map(([name, count]) => `${path.relative(repoRoot, path.join(dir, name))} ${count}`)
    .join('\n'));
  return spawnSync(process.execPath, [scriptPath, dir, allowlistFile], { cwd: repoRoot, encoding: 'utf8' });
};

const RETAINED = `
export function wireLatch(on: (listener: () => void) => void): void {
  let lastSeenMs = 0;
  on(() => { lastSeenMs = Date.now(); });
}
`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('check-setup-stateless closure variables', () => {
  it('fails a local that a retained callback reassigns', () => {
    const result = runGuard(makeTree({ 'wireLatch.ts': RETAINED }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lastSeenMs — closure variable reassigned by a nested callback');
  });

  it('passes per-call locals: own writes, synchronous array callbacks, and shadowing parameters', () => {
    const result = runGuard(makeTree({
      'perCall.ts': `
export function total(values: number[], on: (listener: (count: number) => void) => void): number {
  let sum = 0;
  values.forEach((value) => { sum += value; });
  let count = 0;
  count += 1;
  on((count) => { count = 2; });
  return sum + count;
}
`,
    }));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('holds a budgeted file to its budget in both directions', () => {
    const grown = makeTree({
      'wireLatch.ts': `${RETAINED}
export function wireCounter(on: (listener: () => void) => void): void {
  let fired = 0;
  on(() => { fired += 1; });
}
`,
    });
    const over = runGuard(grown, { 'wireLatch.ts': 1 });
    expect(over.status).toBe(1);
    expect(over.stderr).toContain('budgeted 1, found 2 — state added');

    const exact = runGuard(makeTree({ 'wireLatch.ts': RETAINED }), { 'wireLatch.ts': 1 });
    expect(exact.status).toBe(0);

    const stale = runGuard(makeTree({ 'wireLatch.ts': 'export const none = 1;\n' }), { 'wireLatch.ts': 1 });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('budgeted 1, found 0 — update the line');
  });
});
