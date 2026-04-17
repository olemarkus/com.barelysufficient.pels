import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const runtimeRoots = [
  path.join(repoRoot, 'app.ts'),
  path.join(repoRoot, 'flowCards'),
  path.join(repoRoot, 'lib'),
];

const forbiddenPatterns = [
  /\b(name|deviceName|displayName)\s*(\|\||\?\?)\s*(deviceId|id)\b/,
  /\b(deviceId|id)\s*(\|\||\?\?)\s*(name|deviceName|displayName)\b/,
];

const collectRuntimeFiles = (entryPath: string): string[] => {
  const stats = statSync(entryPath);
  if (stats.isFile()) {
    return entryPath.endsWith('.ts') ? [entryPath] : [];
  }

  return readdirSync(entryPath, { withFileTypes: true })
    .flatMap((entry) => collectRuntimeFiles(path.join(entryPath, entry.name)));
};

describe('device identity hygiene', () => {
  it('does not allow id-or-name fallback rewrites in runtime code', () => {
    const matches: string[] = [];

    for (const filePath of runtimeRoots.flatMap(collectRuntimeFiles)) {
      const content = readFileSync(filePath, 'utf8');
      if (!forbiddenPatterns.some((pattern) => pattern.test(content))) continue;
      matches.push(path.relative(repoRoot, filePath));
    }

    expect(matches).toEqual([]);
  });
});
