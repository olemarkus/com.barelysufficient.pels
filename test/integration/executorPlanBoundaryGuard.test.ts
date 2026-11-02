import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const guard = path.resolve('scripts/check-executor-plan-edge.mjs');
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pels-executor-boundary-'));
  mkdirSync(path.join(root, 'lib/executor'), { recursive: true });
  mkdirSync(path.join(root, 'lib/planContract'), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const run = (): string => execFileSync(process.execPath, [guard, root], { encoding: 'utf8', stdio: 'pipe' });

describe('executor/planner source boundary', () => {
  it('accepts neutral decisions and executor-owned command state', () => {
    writeFileSync(
      path.join(root, 'lib/executor/consumer.ts'),
      "import type { Intent } from '../planContract/executionPlan';\n"
        + "import { store } from './executionState';\n",
    );
    writeFileSync(
      path.join(root, 'lib/planContract/executionPlan.ts'),
      "import type { Step } from '../../packages/contracts/src/types';\n",
    );
    expect(run()).toContain('0 lib/executor -> lib/plan edges');
  });

  it.each([
    "import { state } from '../plan/planState';",
    "import type { State } from '../plan/planState';",
    "export type { State } from '../plan/planState';",
    "type State = import('../plan/planState').State;",
    "const state = require('../plan/planState');",
    "import state = require('../plan/planState');",
    "import type { State } from '../plan/../plan/planState';",
    "const state = import('../plan/planState');",
  ])('rejects a planner dependency before compilation: %s', (source) => {
    writeFileSync(path.join(root, 'lib/executor/consumer.ts'), source);
    expect(run).toThrow('Architecture boundary violation');
  });

  it.each([
    '../plan/planTypes', '../executor/executablePlan', '../ports/plannerExecutionFeedback',
    '../../setup/appInit/createPlanEngine', '../../app', '../../api',
    '../../packages/settings-ui/src/script', 'homey', 'homey-api',
  ])('rejects a hidden neutral-contract dependency on %s', (target) => {
    writeFileSync(path.join(root, 'lib/planContract/executionPlan.ts'), `import type { Hidden } from '${target}';`);
    expect(run).toThrow('Architecture boundary violation');
  });

  it('rejects an absolute planner import', () => {
    const target = path.join(root, 'lib/plan/planState');
    writeFileSync(path.join(root, 'lib/executor/consumer.ts'), `import type { State } from '${target}';`);
    expect(run).toThrow('Architecture boundary violation');
  });

  it('rejects a computed import whose owner cannot be established', () => {
    writeFileSync(path.join(root, 'lib/executor/consumer.ts'), 'const owner = process.env.OWNER; void import(owner);');
    expect(run).toThrow('Non-static import specifier');
  });
});
