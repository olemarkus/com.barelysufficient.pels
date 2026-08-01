// Source-graph guard for the "Multiple meters" shared-domain trio.
//
// `homesManagementCopy.ts` imports its error/warning TYPES from
// `homesManagement.ts`. A back-edge — the validation module reaching into the
// copy module for a home name — closes a cycle, which root AGENTS.md forbids.
// `npm run arch:check` cannot see it: dependency-cruiser runs without
// `tsPreCompilationDeps`, so the type-only edge is erased before the cruise and
// the circle never shows up. `homeNames.ts` exists to hold the names outside
// both, and these assertions are what keeps it that way.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sharedDomainSrc = path.resolve(__dirname, '../../packages/shared-domain/src');

/** Module source with block/line comments stripped, so prose never reads as an import. */
const readCode = (fileName: string): string => readFileSync(
  path.join(sharedDomainSrc, fileName),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Specifiers of every `import ... from '…'` / `export ... from '…'` statement. */
const moduleSpecifiers = (code: string): string[] => [
  ...code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
].map((match) => match[1] ?? '');

describe('homeNames.ts is a dependency-neutral leaf', () => {
  it('imports nothing at all', () => {
    const code = readCode('homeNames.ts');
    expect(moduleSpecifiers(code)).toEqual([]);
    // Bare side-effect imports carry no `from`, dynamic `import()` carries no
    // static statement, and CommonJS bypasses all three.
    expect(code).not.toMatch(/^\s*import\s*['"]/m);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it('keeps validation independent of copy, so the pair cannot go circular', () => {
    const specifiers = moduleSpecifiers(readCode('homesManagement.ts'));
    expect(specifiers).not.toContain('./homesManagementCopy');
    expect(specifiers.filter((specifier) => specifier.includes('Copy'))).toEqual([]);
  });

  it('keeps the area rules independent of copy, closing the transitive route', () => {
    // `homesManagement.ts` value-imports `homeAreaConfigRules.ts`, so a Copy
    // import HERE re-closes the same circle one hop longer:
    // validation → rules → copy → (type) validation.
    const specifiers = moduleSpecifiers(readCode('homeAreaConfigRules.ts'));
    expect(specifiers.filter((specifier) => specifier.includes('Copy'))).toEqual([]);
  });
});
