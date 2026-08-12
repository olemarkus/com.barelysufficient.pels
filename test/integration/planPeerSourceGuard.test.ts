import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const guardPath = path.join(repositoryRoot, 'scripts/check-plan-objectives-edge.mjs');
const fixtureDirectories: string[] = [];

function createFixture(files: Readonly<Record<string, string>>): string {
  const fixtureDirectory = mkdtempSync(path.join(repositoryRoot, 'lib/plan-source-guard-fixture-'));
  fixtureDirectories.push(fixtureDirectory);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(fixtureDirectory, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return fixtureDirectory;
}

function runGuard(fixtureDirectory: string): string {
  return execFileSync(process.execPath, [guardPath, fixtureDirectory], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('planner peer source guard', () => {
  afterEach(() => {
    for (const fixtureDirectory of fixtureDirectories.splice(0)) {
      rmSync(fixtureDirectory, { recursive: true });
    }
  });

  it('accepts static imports outside the forbidden peers', () => {
    const fixture = createFixture({
      'allowed.ts': "import type { Logger } from '../logging/logger.js';\nvoid import('../power/capacityGuard.js');\nvoid require('../power/capacityGuard.js');\nexport type Allowed = Logger;\n",
      'similarNames.ts': "import type { Metrics } from '../utils/executorMetrics.js';\nimport { helper } from '../utils/objectivesHelper.js';\nimport externalExecutor from 'external-executor-package';\nvoid externalExecutor;\nvoid helper;\nexport type { Metrics };\n",
      'barePackages.ts': "import executor from '@scope/executor';\nimport objectives from '@scope/objectives';\nvoid executor;\nvoid objectives;\n",
      'outsideRepository.ts': "import sibling from '../../../executor/outside-repository.js';\nvoid sibling;\n",
    });
    expect(runGuard(fixture)).toContain('arch:grep OK');
  });

  it('rejects every static import shape and computed import or require', () => {
    const fixture = createFixture({
      'importDeclaration.ts': "import { PlanExecutor } from '../executor/planExecutor.js';\nvoid PlanExecutor;\n",
      'exportDeclaration.ts': "export { PlanExecutor } from '../executor/planExecutor.js';\n",
      'importEquals.ts': "import PlanExecutor = require('../executor/planExecutor.js');\nvoid PlanExecutor;\n",
      'importType.ts': "type Executor = import('../executor/planExecutor.js').PlanExecutor;\nexport type { Executor };\n",
      'importTypeDeclaration.ts': "import type { PlanExecutor } from '../executor/planExecutor.js';\nexport type { PlanExecutor };\n",
      'staticDynamicImport.ts': "void import('../objectives/types.js');\n",
      'staticRequire.ts': "void require('../objectives/types.js');\n",
      'normalizedRelative.ts': "import type { PlanExecutor } from './nested/../../executor/planExecutor.js';\nexport type { PlanExecutor };\n",
      'absoluteRepositoryPath.ts': `import type { Objective } from '${path.join(repositoryRoot, 'lib/objectives/types.js')}';\nexport type { Objective };\n`,
      'computedDynamicImport.ts': "declare const peer: string;\nvoid import(`../${peer}/types.js`);\n",
      'computedRequire.ts': "declare const peer: string;\nvoid require('../' + peer + '/types.js');\n",
      'missingRequireArgument.ts': "declare function require(): unknown;\nvoid require();\n",
    });
    let stderr = '';
    try {
      runGuard(fixture);
    } catch (error) {
      if (!(error instanceof Error) || !('stderr' in error)) throw error;
      stderr = String(error.stderr);
    }

    expect(stderr).toContain('importDeclaration.ts');
    expect(stderr).toContain('exportDeclaration.ts');
    expect(stderr).toContain('importEquals.ts');
    expect(stderr).toContain('importType.ts');
    expect(stderr).toContain('importTypeDeclaration.ts');
    expect(stderr).toContain('staticDynamicImport.ts');
    expect(stderr).toContain('staticRequire.ts');
    expect(stderr).toContain('normalizedRelative.ts');
    expect(stderr).toContain('absoluteRepositoryPath.ts');
    expect(stderr).toContain("computedDynamicImport.ts:2  imports '<non-static import()>'");
    expect(stderr).toContain("computedRequire.ts:2  imports '<non-static require()>'");
    expect(stderr).toContain("missingRequireArgument.ts:2  imports '<non-static require()>'");
  });
});
