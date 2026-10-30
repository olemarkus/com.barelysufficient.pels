import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/check-api-manifest-parity.mjs');
const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-api-parity-'));
  tempDirs.push(dir);
  return dir;
};

const runParity = (apiFile: string, manifestFile: string) => spawnSync(
  process.execPath,
  [scriptPath, apiFile, manifestFile],
  { cwd: repoRoot, encoding: 'utf8' },
);

const writeManifest = (dir: string, keys: string[]): string => {
  const file = path.join(dir, 'app.json');
  const api = Object.fromEntries(keys.map((key) => [key, { method: 'GET', path: `/${key}` }]));
  fs.writeFileSync(file, JSON.stringify({ api }));
  return file;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('check-api-manifest-parity', () => {
  it('passes for the repository api.ts and manifest', () => {
    const result = runParity('api.ts', '.homeycompose/app.json');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('follows spreads of imported route tables', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'familyRoutes.ts'), [
      'const defineRoutes = <T>(routes: T): T => routes;',
      'export const familyRoutes = defineRoutes({ ui_a: () => 1, ui_b: () => 2 });',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'api.ts'), [
      "import { familyRoutes } from './familyRoutes';",
      'export = { ...familyRoutes, ui_c: () => 3 };',
    ].join('\n'));
    const result = runParity(path.join(dir, 'api.ts'), writeManifest(dir, ['ui_a', 'ui_b', 'ui_c']));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails when a handler and the manifest disagree', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'api.ts'), 'export = { ui_a: () => 1, ui_extra: () => 2 };\n');
    const result = runParity(path.join(dir, 'api.ts'), writeManifest(dir, ['ui_a', 'ui_missing']));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ui_missing — declared in the manifest, no handler');
    expect(result.stderr).toContain('ui_extra — handler exported, not in the manifest');
  });

  it('fails on a route declared twice across tables', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'familyRoutes.ts'), 'export const familyRoutes = { ui_a: () => 1 };\n');
    fs.writeFileSync(path.join(dir, 'api.ts'), [
      "import { familyRoutes } from './familyRoutes';",
      'export = { ...familyRoutes, ui_a: () => 2 };',
    ].join('\n'));
    const result = runParity(path.join(dir, 'api.ts'), writeManifest(dir, ['ui_a']));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('route ui_a is declared twice');
  });
});
