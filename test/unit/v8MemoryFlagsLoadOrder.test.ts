import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const firstImport = (file: string): string | undefined => readFileSync(path.join(repoRoot, file), 'utf8')
  .split('\n')
  .find((line) => line.startsWith('import '));

// The V8 memory flags only save memory when they are set before the module
// graph is parsed and compiled (`lib/diagnostics/v8MemoryFlags.ts`).
describe('V8 memory flags load first', () => {
  it('app.ts imports the runtime API first', () => {
    expect(firstImport('app.ts')).toBe("import { withAppApi } from './setup/appRuntimeApi';");
  });

  it('the runtime API imports the memory flags first', () => {
    expect(firstImport('setup/appRuntimeApi.ts')).toBe("import '../lib/diagnostics/v8MemoryFlags';");
  });
});
