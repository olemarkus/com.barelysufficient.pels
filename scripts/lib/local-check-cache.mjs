import process from 'node:process';

// Local checks keep tsc and ESLint caches in node_modules/.cache, so a warm
// pre-commit or pre-push run skips unchanged work (ESLint 73 s -> 6 s). CI
// always runs cold: ESLint caches a file's result by its own content, so a type
// change in a module it imports can leave a typed-lint result stale locally.
const CACHE_DIR = 'node_modules/.cache/pels-checks';

export const tscCacheArgs = (label) => (process.env.CI
  ? []
  : ['--incremental', '--tsBuildInfoFile', `${CACHE_DIR}/${label.replaceAll(':', '-')}.tsbuildinfo`]);

/** A `tsc --noEmit` check entry for run-parallel, cached per label locally. */
export const tscCheck = (label, projectArgs = []) => ({
  label,
  command: 'npx',
  args: ['tsc', ...projectArgs, '--noEmit', ...tscCacheArgs(label)],
});

export const eslintCacheArgs = () => (process.env.CI
  ? []
  : ['--cache', '--cache-location', `${CACHE_DIR}/eslint/`, '--cache-strategy', 'content']);
