// Legacy-logging guard.
//
// WHY THIS EXISTS: you cannot tell from a logging call site whether the line
// reaches the owner. Three receivers spell `.debug(...)` identically and behave
// differently, and one of the three is invisible in production:
//
//   1. A PINO MODULE LOGGER — `getLogger(module)` or `getStructuredLogger(component)`.
//      DARK. The root is created at `info` (`installStructuredLogger`,
//      setup/appServiceWiring.ts) and these children INHERIT that level, so the
//      line is never written. Not theory: four events `notes/logging/README.md`
//      lists as current — `target_command_skipped`, `restore_command_skipped`,
//      `binary_command_skipped`, `stepped_load_command_skipped` — appear ZERO
//      times in a production log carrying tens of thousands of debug lines,
//      because they are emitted this way. They are the executor's "why was this
//      device not commanded?" events, the first thing anyone reaches for when a
//      device will not respond. Converting a working topic-gated emit onto this
//      path DELETES the line, and that has shipped: PR #2252 moved
//      `fetchZoneTree` and silently lost `zone_tree_fetch_failed`.
//
//   2. THE INJECTED SDK `Logger` (`lib/utils/types.ts`), whose `.debug` was wired
//      to `ctx.logDebug('devices', …)`. It DID emit — `zone_tree_fetched` reached
//      the log hundreds of times a day this way — but as topic-gated PROSE
//      through the Homey SDK (a printed object, not JSON), with no `event` field
//      to filter, count or alert on. The device lane moved to the devices-topic
//      emitter and the SDK `Logger` no longer has a `debug` at all.
//
//   3. A HAND-ROLLED `.child({component}, {level:'debug'})`, which emits
//      correctly (`lib/plan/rebuildScheduler/telemetryObserver.ts`). It is
//      `getDebugEmitter` rewritten by hand, and drifts from it silently.
//
// All three are refused. The point of the ban is not that every `.debug()` is
// dark — it is that the reader cannot tell which kind they are looking at, and
// one kind is invisible. `getDebugEmitter(component, topic)` is the one channel
// that is structured, topic-gated, and visibly so at the call site.
//
// Prose (`logDebug(topic, '…')`, `this.log('…')`) is banned for the same reason
// as case 2: it carries no `event` field. `console.*` is banned because it
// bypasses the Homey destination and never reaches the app log at all.
//
// A COMPUTED LEVEL — `logger[level](payload)` — is refused too, because the
// level is not readable at the call site and may resolve to a dark `debug`. One
// live instance does: `plan_rebuild_completed` takes the `debug` branch of
// `getPlanRebuildLogLevel` for actionChanged-only rebuilds, and that branch is
// absent from production while the `info` branches are present.
//
// WHAT IS ALLOWED:
//   - Anything inside `lib/logging/` — that is the implementation of the
//     channel, and `getDebugEmitter` necessarily calls `.debug()` on the child
//     it just created at `debug` level.
//   - `.info` / `.warn` / `.error` on any logger. Those inherit `info` and emit.
//   - An injected `StructuredDebugEmitter` (`debugStructured(...)`). It is the
//     same emitter under a threaded name; retiring the threading is a separate,
//     tracked migration and is not what this guard is about.
//   - The app-API wrapper's pre-logger boot `console.error` fallback
//     (`setup/api/defineRoutes.ts`), which runs before a root logger exists. It
//     is exempted by name (`EXEMPT_SITES`).
//
// Every other site fails: the files that predated the rule have all migrated.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Runtime roots. Test code logs however it likes; the owner never reads it. */
const SCAN = ['app.ts', 'api.ts', 'lib', 'setup', 'flowCards', 'drivers'];

/** The channel's own implementation. `.debug()` here is the thing that works. */
const EXEMPT_DIRS = [path.join('lib', 'logging')];

/**
 * Deliberate sites, as `<path>:<kind>` → how many are allowed.
 *
 * The app-API wrapper in `setup/api/defineRoutes.ts` runs one `console.error`
 * before a root logger exists, so console is genuinely the only channel
 * available there.
 *
 * The COUNT is what keeps this from becoming a file-wide licence: a second
 * console call in that file is over the exemption and fails, so an API handler
 * cannot quietly acquire one by sitting in an already-exempt file.
 */
const EXEMPT_SITES = new Map([['setup/api/defineRoutes.ts:console', 1]]);

async function collectFiles(entry) {
  const absolute = path.join(rootDir, entry);
  const stat = await fs.stat(absolute).catch(() => null);
  if (stat === null) return [];
  if (stat.isFile()) return absolute.endsWith('.ts') ? [absolute] : [];
  const found = [];
  for (const dirent of await fs.readdir(absolute, { withFileTypes: true })) {
    if (dirent.name === 'node_modules') continue;
    found.push(...await collectFiles(path.join(entry, dirent.name)));
  }
  return found;
}

/**
 * `expr.debug(...)` / `expr.log(...)` — returns the method name for a call whose
 * callee is a property access, so the caller can decide what it means.
 */
function calledMethodName(node) {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  return callee.name.text;
}

/**
 * `logger[level](payload)` — the level is chosen at runtime, so the call site
 * does not say whether this line is visible. Flagged wherever the computed
 * property is not a literal, because one live instance resolves to `debug`.
 */
function isComputedLevelCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isElementAccessExpression(callee)) return false;
  return !ts.isStringLiteralLike(callee.argumentExpression);
}

/**
 * Any call on `console`, including `globalThis.console.…` and element access.
 * Deliberately not a method allowlist: `table`, `dir`, `assert`, `timeEnd`,
 * `group` and `count` all write, and all of them bypass the Homey destination
 * exactly as `log` does.
 */
function isConsoleCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
  const target = callee.expression;
  if (ts.isIdentifier(target)) return target.text === 'console';
  return ts.isPropertyAccessExpression(target) && target.name.text === 'console';
}

/**
 * A prose call: `logDebug(topic, ...)` however it is reached, and a bare
 * `log(...)` / `logDebug(...)` forwarded through a dep. `this.error(...)` is
 * prose too, but `.error` on a pino logger is not, so only the SDK-shaped
 * receivers count: `this`, `deps`, `ctx`, `params`, `host`.
 */
const PROSE_RECEIVERS = new Set(['this', 'deps', 'ctx', 'params', 'host', 'app']);

/**
 * The root identifier of a receiver chain, so `this.deps.log(...)` is judged on
 * `deps` exactly as `deps.log(...)` is. Without this, adding one `this.` evades
 * the rule — and six live sites did.
 */
function receiverRoot(node) {
  let current = node;
  for (;;) {
    if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
}

function proseCallName(node) {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  // A bare `log(...)` / `logDebug(...)` destructured or passed in as a dep.
  if (ts.isIdentifier(callee)) {
    return callee.text === 'log' || callee.text === 'logDebug' ? callee.text : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const name = callee.name.text;
  if (name !== 'log' && name !== 'logDebug') return undefined;
  const receiver = receiverRoot(callee.expression);
  if (receiver === undefined) return undefined;
  return PROSE_RECEIVERS.has(receiver) ? name : undefined;
}

function findingsFor(sourceFile, relativePath, exemptBudget) {
  const exempt = EXEMPT_DIRS.some((dir) => relativePath.startsWith(dir + path.sep));
  const findings = [];
  const visit = (node) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    if (isConsoleCall(node)) {
      findings.push({ line, kind: 'console', detail: 'console.* never reaches the Homey app log' });
    } else if (!exempt && calledMethodName(node) === 'debug') {
      findings.push({
        line,
        kind: 'debug-call',
        detail: 'a .debug() call is dark (pino child) or prose (SDK logger) and the call site cannot say which; '
          + 'use getDebugEmitter(component, topic)',
      });
    } else if (isComputedLevelCall(node)) {
      findings.push({
        line,
        kind: 'computed-level',
        detail: 'the log level is computed, so this may resolve to a dark debug; spell the level out',
      });
    } else {
      const prose = proseCallName(node);
      if (!exempt && prose !== undefined) {
        findings.push({ line, kind: 'prose', detail: `${prose}() writes prose through the SDK, not a structured event` });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  // Drop up to the exempted number of findings per kind, oldest first. Anything
  // beyond the exemption stays and fails, so an exempt file cannot grow more.
  return findings.filter((finding) => {
    const key = `${relativePath}:${finding.kind}`;
    const remaining = exemptBudget.get(key);
    if (remaining === undefined || remaining <= 0) return true;
    exemptBudget.set(key, remaining - 1);
    return false;
  });
}

const files = (await Promise.all(SCAN.map(collectFiles))).flat();
const exemptBudget = new Map(EXEMPT_SITES);
const actual = new Map();
for (const file of files) {
  const relativePath = path.relative(rootDir, file);
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings = findingsFor(sourceFile, relativePath, exemptBudget);
  if (findings.length > 0) actual.set(relativePath, findings);
}

if (actual.size === 0) {
  console.log(`logging:no-legacy OK — no legacy logging (${files.length} files scanned)`);
  process.exit(0);
}
console.error('logging:no-legacy FAILED\n');
for (const [file, findings] of actual) {
  for (const f of findings) console.error(`  ${file}:${f.line}  [${f.kind}] ${f.detail}`);
}
console.error('\n  Rules: notes/logging/README.md § "Legacy logging is banned".');
process.exit(1);
