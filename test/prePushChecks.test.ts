import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts/pre-push-checks.mjs');
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const tempDirs: string[] = [];

const createFakeGitDir = (): { dir: string; logPath: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-pre-push-'));
  tempDirs.push(dir);
  const logPath = path.join(dir, 'git.log');
  const gitPath = path.join(dir, 'git');
  fs.writeFileSync(gitPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
cmd="$1"
shift || true
case "$cmd" in
  symbolic-ref)
    printf '%s\\n' "\${FAKE_BASE_REF:-origin/main}"
    ;;
  merge-base)
    if [ "$1" = "--is-ancestor" ]; then
      if [ "\${FAKE_IS_ANCESTOR:-1}" = "1" ]; then
        exit 0
      fi
      exit 1
    fi
    if [ "\${FAKE_MERGE_BASE_MODE:-value}" = "fail" ]; then
      exit 1
    fi
    printf '%s' "\${FAKE_MERGE_BASE_VALUE:-}"
    if [ -n "\${FAKE_MERGE_BASE_VALUE:-}" ]; then
      printf '\\n'
    fi
    ;;
  rev-list)
    printf '%s' "\${FAKE_ROOT_OUTPUT:-}"
    if [ -n "\${FAKE_ROOT_OUTPUT:-}" ]; then
      printf '\\n'
    fi
    ;;
  diff)
    range="\${!#}"
    if [ "\${FAKE_DIFF_MODE:-match}" = "error" ]; then
      printf 'unexpected diff invocation: %s\\n' "$range" >&2
      exit 99
    fi
    if [ "$range" = "\${FAKE_DIFF_RANGE:-}" ]; then
      printf '%s' "\${FAKE_DIFF_OUTPUT:-}"
      if [ -n "\${FAKE_DIFF_OUTPUT:-}" ]; then
        printf '\\n'
      fi
      exit 0
    fi
    printf 'unexpected diff range: %s\\n' "$range" >&2
    exit 99
    ;;
  *)
    printf 'unexpected git command: %s %s\\n' "$cmd" "$*" >&2
    exit 98
    ;;
esac
`, { mode: 0o755 });
  return { dir, logPath };
};

const runPrePush = (envOverrides: NodeJS.ProcessEnv, input = 'refs/heads/fix local-sha refs/heads/fix 0000000000000000000000000000000000000000\n') => {
  const result = spawnSync(
    process.execPath,
    [scriptPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PELS_PRE_PUSH_DRY_RUN: '1',
        ...envOverrides,
      },
      input,
    },
  );

  return result;
};

describe('pre-push checks script', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to diffing from the empty tree when a new branch has no merge-base', () => {
    const { dir, logPath } = createFakeGitDir();
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: logPath,
      FAKE_MERGE_BASE_MODE: 'fail',
      FAKE_ROOT_OUTPUT: 'root-sha',
      FAKE_DIFF_RANGE: `${EMPTY_TREE_SHA}..local-sha`,
      FAKE_DIFF_OUTPUT: 'package.json',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-push: inspecting 1 changed file(s)');
    expect(result.stdout).toContain('pre-push: running npm run ci:full');
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      `diff --name-only --diff-filter=ACMR ${EMPTY_TREE_SHA}..local-sha`,
    );
  });

  it('skips diffing when the root lookup returns no commit', () => {
    const { dir, logPath } = createFakeGitDir();
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: logPath,
      FAKE_MERGE_BASE_MODE: 'fail',
      FAKE_ROOT_OUTPUT: '',
      FAKE_DIFF_MODE: 'error',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-push: no changed files detected in pushed refs, skipping extra local checks');
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('diff ');
  });

  it('runs both settings and runtime checks for shared contract changes', () => {
    const { dir } = createFakeGitDir();
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: path.join(dir, 'git.log'),
      FAKE_MERGE_BASE_VALUE: 'base-sha',
      FAKE_DIFF_RANGE: 'base-sha..local-sha',
      FAKE_DIFF_OUTPUT: 'packages/contracts/src/targetCapabilities.ts',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-push: running npm run ci:test:settings-ui');
    expect(result.stdout).toContain('pre-push: running npm run ci:test:playwright:quick');
    expect(result.stdout).toContain('pre-push: running npm run ci:checks');
    expect(result.stdout).toContain('pre-push: running npm run ci:test:runtime');
  });

  it('fails clearly when local dependencies are missing', () => {
    const { dir } = createFakeGitDir();
    const missingNodeModulesDir = path.join(dir, 'missing-node-modules');
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      PELS_PRE_PUSH_DRY_RUN: '0',
      FAKE_GIT_LOG: path.join(dir, 'git.log'),
      FAKE_MERGE_BASE_VALUE: 'base-sha',
      FAKE_DIFF_RANGE: 'base-sha..local-sha',
      FAKE_DIFF_OUTPUT: 'app.ts',
      PELS_NODE_MODULES_PATH: missingNodeModulesDir,
    }, 'refs/heads/fix local-sha refs/heads/fix 0000000000000000000000000000000000000000\n');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`pre-push: missing local dependencies at ${missingNodeModulesDir}. Run \`npm install\` before pushing.`);
  });

  it('treats a rewritten branch like a new remote diff and rechecks the full branch content', () => {
    const { dir, logPath } = createFakeGitDir();
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: logPath,
      FAKE_IS_ANCESTOR: '0',
      FAKE_MERGE_BASE_VALUE: 'base-sha',
      FAKE_DIFF_RANGE: 'base-sha..local-sha',
      FAKE_DIFF_OUTPUT: 'packages/contracts/src/settingsUiApi.ts',
    }, 'refs/heads/fix local-sha refs/heads/fix remote-sha\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-push: running npm run ci:test:settings-ui');
    expect(result.stdout).toContain('pre-push: running npm run ci:test:playwright:quick');
    expect(result.stdout).toContain('pre-push: running npm run ci:checks');
    expect(result.stdout).toContain('pre-push: running npm run ci:test:runtime');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('merge-base --is-ancestor remote-sha local-sha');
  });

  it('runs runtime checks and validation for Homey runtime packaging changes', () => {
    const { dir } = createFakeGitDir();
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: path.join(dir, 'git.log'),
      FAKE_MERGE_BASE_VALUE: 'base-sha',
      FAKE_DIFF_RANGE: 'base-sha..local-sha',
      FAKE_DIFF_OUTPUT: 'drivers/pels_insights/device.ts',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-push: running npm run ci:checks');
    expect(result.stdout).toContain('pre-push: running npm run ci:test:runtime');
    expect(result.stdout).toContain('pre-push: running npm run validate');
  });

  it('runs runtime checks and validation for widget source changes', () => {
    const { dir } = createFakeGitDir();
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: path.join(dir, 'git.log'),
      FAKE_MERGE_BASE_VALUE: 'base-sha',
      FAKE_DIFF_RANGE: 'base-sha..local-sha',
      FAKE_DIFF_OUTPUT: 'widgets/plan_budget/src/public/chart.ts',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-push: running npm run ci:checks');
    expect(result.stdout).toContain('pre-push: running npm run ci:test:runtime');
    expect(result.stdout).toContain('pre-push: running npm run validate');
  });

  it('runs runtime checks for root Vitest configuration changes', () => {
    const { dir } = createFakeGitDir();
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: path.join(dir, 'git.log'),
      FAKE_MERGE_BASE_VALUE: 'base-sha',
      FAKE_DIFF_RANGE: 'base-sha..local-sha',
      FAKE_DIFF_OUTPUT: 'vitest.config.fast.ts',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-push: running npm run ci:checks');
    expect(result.stdout).toContain('pre-push: running npm run ci:test:runtime');
  });

  it('runs runtime checks for runtime test file changes', () => {
    const { dir } = createFakeGitDir();
    const result = runPrePush({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: path.join(dir, 'git.log'),
      FAKE_MERGE_BASE_VALUE: 'base-sha',
      FAKE_DIFF_RANGE: 'base-sha..local-sha',
      FAKE_DIFF_OUTPUT: 'test/planExecutor.test.ts',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-push: running npm run ci:checks');
    expect(result.stdout).toContain('pre-push: running npm run ci:test:runtime');
  });
});
