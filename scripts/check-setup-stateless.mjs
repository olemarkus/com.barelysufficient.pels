// Statelessness guard for the app-wiring layer.
//
// WHY THIS EXISTS: `setup/` constructs and connects — it does not run, and it
// does not remember (`setup/AGENTS.md` § "No state"). State held in the wiring
// layer is state with no owner. It sits ABOVE the layer boundaries
// `.dependency-cruiser.cjs` enforces, so anything wired can reach it, and it
// becomes a channel between modules that are forbidden to talk to each other —
// with no import edge to show for it, so `arch:check` cannot see it.
//
// That is not hypothetical. `setup/appDeviceControlHelpers.ts` HELD the
// executor's stepped-command state until it was moved to
// `lib/executor/steppedCommandStore.ts`, and it still drives three of that
// store's four lifecycle transitions (confirm / expire / prune) from inside
// `decorateSnapshotWithDeviceControl` — the plan-input producer. So a step
// command settles because the planner asked for its devices, not because the
// executor observed materialization, and the commanded axis reaches the planner
// without either module importing the other. `no-plan-to-executor` is an
// error-severity rule with a production incident attached (inc_26449fb9); this
// route goes around it.
//
// WHAT COUNTS AS STATE: anything that changes as the app runs, or that holds
// something which can. Three checks:
//
//   1. A mutable instance property — no `readonly` modifier. A field that can be
//      reassigned is a latch, a cache, a counter, or a cursor; all four are
//      state.
//   2. A `readonly` property or a module-level binding that CONSTRUCTS mutable
//      state: `new Map/Set/WeakMap/WeakSet`, an array or object literal, or a
//      `create*()` call (the repo's store/state factory convention —
//      `createDeviceControlRuntimeState`, `createCurtailmentHoldStore`). `readonly`
//      pins the reference, not the contents. A rebindable module-level binding
//      (`let` or `var`) is state too.
//   3. A field ASSIGNED mutable state anywhere in the class — `private readonly
//      cache: Map<string, string>;` declared bare and filled with `this.cache =
//      new Map()` in the constructor. The declaration is clean, so check 2 sees
//      nothing; the assignment is where the state appears. A field already
//      reported at its declaration is not counted twice, and neither are three
//      reassignments of one field: the budget counts FIELDS to move, not writes.
//
// WHAT IS ALLOWED, and why each is not a hole:
//
//   - `private readonly deps` (including constructor parameter properties): a
//     reference to something someone ELSE owns and someone else mutates. Setup's
//     product is exactly this — it hands components their collaborators.
//   - `abstract` property declarations on the façade base classes
//     (`appRuntimeApi.ts`, `appHostApi.ts`): they declare storage that `PelsApp`
//     provides. The declaration holds nothing; `app.ts` is the composition root
//     and holds the handles.
//   - Module consts typed `ReadonlySet` / `ReadonlyMap`: frozen lookup tables
//     (`CAPACITY_SCALAR_BASE_KEYS`), read the same on every call forever.
//   - Locals inside a function. An index map built to answer one call and
//     dropped is not retained state — it dies with the call frame.
//   - A class property initialized with an arrow function: that is a METHOD,
//     written as a field to bind its receiver. The setup façades expose dozens
//     (`appHostApi.ts`, `appRuntimeApi.ts`) because `homey.app` callers reach
//     them through the instance. Judged by its initializer, so a field that is
//     assigned a function LATER — a stored teardown handle like
//     a `stop*?: () => void` teardown handle — is state and is caught.
//   - A module const whose name is SCREAMING_SNAKE_CASE and whose initializer is
//     an array or object literal: the repo's constant-table convention
//     (`PERIODIC_STATUS_MINUTE_INTERVALS = [25, 55]`). The exemption is by
//     literal only — `const CACHE = new Map()` is state whatever it is called.
//
//   4. A CLOSURE VARIABLE a nested callback reassigns: a `let` or `var` declared
//      inside a function and written from a function nested in it —
//      `let lastSeen; emitter.on('x', () => { lastSeen = now; })`. The wiring
//      function returns, the callback keeps the binding alive, and each call
//      changes it: a latch held in a closure instead of a field, invisible to
//      checks 1-3. Counted once per variable, however many callbacks write it.
//      A local the function only writes itself, or writes from a synchronous
//      array callback (`items.forEach((item) => { total += item; })`), dies
//      with the call and passes. Name resolution is lexical: a nested function
//      that redeclares the name writes its own binding, not the captured one.
//
// THE ALLOWLIST (`scripts/setup-stateless-allowlist.txt`) carries the files that
// predate this rule, each with a BUDGET — how many stateful declarations it still
// has. The count is what makes the list safe: file-level granularity alone would
// let an already-listed file grow new state silently, which is the one thing an
// allowlist must not buy. Both drift directions fail, so the budget can only be
// lowered deliberately and the list cannot rot into a permanent exemption. When
// the last line goes, delete the file — the guard then requires it to be absent.
//
// WHAT THIS CANNOT SEE: state reached through a closure over a module-scope
// `const` object literal (caught — that is check 2), a closure `const` holding a
// mutable container that callbacks fill (`const seen = new Set()` read and
// written by a listener), state stored on an injected
// dep (that dep's own module owns it, which is the point), any container
// produced by a factory not named `create*`, and a container handed in from
// elsewhere (`this.cache = buildCache()`). Those need review, not a regex.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional `<scanDir> <allowlist>` arguments point the guard at a fixture tree.
const scanDir = path.resolve(rootDir, process.argv[2] ?? 'setup');
const allowlistFile = path.resolve(rootDir, process.argv[3] ?? 'scripts/setup-stateless-allowlist.txt');

/** `new Map()` / `[]` / `{}` / `createFooStore()` — a reference to fresh mutable state. */
function constructsMutableState(initializer) {
  if (initializer === undefined) return false;
  if (ts.isArrayLiteralExpression(initializer) || ts.isObjectLiteralExpression(initializer)) {
    return true;
  }
  if (ts.isNewExpression(initializer)) {
    return ts.isIdentifier(initializer.expression)
      && /^(Map|Set|WeakMap|WeakSet|Array|Object)$/.test(initializer.expression.text);
  }
  if (ts.isCallExpression(initializer)) {
    const callee = initializer.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : (ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined);
    return name !== undefined && /^create[A-Z]/.test(name);
  }
  return false;
}

/** A frozen lookup table: `const KEYS: ReadonlySet<string> = new Set([...])`. */
function isReadonlyCollectionType(typeNode) {
  return typeNode !== undefined
    && ts.isTypeReferenceNode(typeNode)
    && ts.isIdentifier(typeNode.typeName)
    && /^Readonly(Set|Map|Array)$/.test(typeNode.typeName.text);
}

/**
 * `const PERIODIC_STATUS_MINUTE_INTERVALS = [25, 55]` — a constant table.
 * SCREAMING_SNAKE alone is not enough: `const CACHE = {}` is a mutable store
 * wearing a constant's name. The contents must be present and all literal, so
 * anything with room to grow entries is still state.
 */
function isLiteralValue(node) {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression?.(node)) {
    return isLiteralValue(node.expression);
  }
  // Nested tables may be empty (`devices: []` in a frozen "unavailable"
  // payload); only the top-level table must have contents.
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(isLiteralValue);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => (
      ts.isPropertyAssignment(property) && isLiteralValue(property.initializer)
    ));
  }
  return ts.isStringLiteral(node)
    || ts.isNumericLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword
    || (ts.isPrefixUnaryExpression(node) && isLiteralValue(node.operand));
}

function isConstantTable(declaration) {
  let initializer = declaration.initializer;
  if (initializer !== undefined && ts.isAsExpression(initializer)) {
    initializer = initializer.expression;
  }
  if (initializer === undefined) return false;
  if (!ts.isIdentifier(declaration.name) || !/^[A-Z0-9_]+$/.test(declaration.name.text)) {
    return false;
  }
  if (ts.isArrayLiteralExpression(initializer)) {
    return initializer.elements.length > 0 && initializer.elements.every(isLiteralValue);
  }
  if (ts.isObjectLiteralExpression(initializer)) {
    return initializer.properties.length > 0
      && initializer.properties.every((property) => (
        ts.isPropertyAssignment(property) && isLiteralValue(property.initializer)
      ));
  }
  return false;
}

/** `foo = () => …` on a class is a method bound to its receiver, not state. */
function isBoundMethod(initializer) {
  return initializer !== undefined
    && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

function propertyName(node) {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
    ? node.name.text
    : node.name.getText();
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current !== undefined && !isFunctionLike(current)) current = current.parent;
  return current;
}

/** Array methods that run their callback before they return: a write there ends with the call. */
const SYNCHRONOUS_CALLBACK_METHODS = new Set([
  'forEach', 'map', 'flatMap', 'filter', 'reduce', 'reduceRight', 'some', 'every',
  'find', 'findIndex', 'findLast', 'findLastIndex', 'sort', 'toSorted',
]);

function isSynchronousCallback(fn) {
  const call = fn.parent;
  return call !== undefined
    && ts.isCallExpression(call)
    && call.arguments.includes(fn)
    && ts.isPropertyAccessExpression(call.expression)
    && SYNCHRONOUS_CALLBACK_METHODS.has(call.expression.name.text);
}

/** Whether `fn` itself binds `name` (a parameter, or a declaration in its own body). */
function declaresName(fn, name) {
  if (fn.parameters?.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)) {
    return true;
  }
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (node !== fn && isFunctionLike(node)) {
      // A nested function declaration binds its name in this scope.
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = true;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = true;
    ts.forEachChild(node, visit);
  };
  if (fn.body !== undefined) visit(fn.body);
  return found;
}

function assignedIdentifier(node) {
  if (
    ts.isBinaryExpression(node)
    && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    && ts.isIdentifier(node.left)
  ) {
    return node.left;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    && ts.isIdentifier(node.operand)
  ) {
    return node.operand;
  }
  return undefined;
}

/**
 * Check 4: does a function nested in `owner` write the `owner`-scoped `name`?
 * Walks from each write up to `owner`; a function on the way that redeclares
 * the name shadows it, and a chain of synchronous array callbacks ends with the
 * call. Returns the first retaining write, or undefined.
 */
function findRetainingWrite(owner, name) {
  let retaining;
  const visit = (node) => {
    if (retaining !== undefined) return;
    const target = assignedIdentifier(node);
    if (target !== undefined && target.text === name) {
      let fn = enclosingFunction(node);
      let shadowed = false;
      let synchronous = true;
      while (fn !== undefined && fn !== owner) {
        if (declaresName(fn, name)) shadowed = true;
        if (!isSynchronousCallback(fn)) synchronous = false;
        fn = enclosingFunction(fn);
      }
      const nested = enclosingFunction(node) !== owner;
      if (fn === owner && nested && !shadowed && !synchronous) retaining = node;
    }
    ts.forEachChild(node, visit);
  };
  if (owner.body !== undefined) visit(owner.body);
  return retaining;
}

function collectOffenders(sourceFile, relPath, offenders) {
  const record = (node, name, reason) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    offenders.push({ file: relPath, line: line + 1, name, reason });
  };
  // Fields already reported at their declaration, and `this.x = …` sites found
  // anywhere in the file. Resolved together at the end so a field that is both
  // declared mutable AND reassigned counts ONCE — the budget in the allowlist
  // is a count of stateful FIELDS, and three reassignments of one field are
  // still one thing to move.
  const declaredOffenders = new Set();
  const assignments = [];

  const visit = (node) => {
    // 1. Mutable instance property. `abstract` declares storage the composition
    //    root provides; `static readonly` constants are covered by check 2.
    if (ts.isPropertyDeclaration(node)) {
      const isAbstract = hasModifier(node, ts.SyntaxKind.AbstractKeyword);
      const isReadonly = hasModifier(node, ts.SyntaxKind.ReadonlyKeyword);
      if (isBoundMethod(node.initializer)) {
        // A method written as a field; falls through to the child walk.
      } else if (!isAbstract && !isReadonly) {
        declaredOffenders.add(propertyName(node));
        record(node, propertyName(node), 'mutable field');
      } else if (isReadonly && constructsMutableState(node.initializer)) {
        declaredOffenders.add(propertyName(node));
        record(node, propertyName(node), 'readonly field holding mutable state');
      }
    }

    // A readonly field may be declared bare and filled in the constructor
    // (`private readonly cache: Map<string, string>;` … `this.cache = new
    // Map()`). The declaration is clean, so the initializer check above sees
    // nothing — look at what is ASSIGNED to `this.x`, wherever in the class it
    // happens. `this.deps = deps` stays fine: it stores an injected reference,
    // not a fresh container.
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.expression.kind === ts.SyntaxKind.ThisKeyword
      && constructsMutableState(node.right)
    ) {
      assignments.push({ node, name: node.left.name.text });
    }

    // Constructor parameter properties (`private readonly deps: X`) hold an
    // injected reference; a mutable one can still be reassigned, so it is state.
    if (ts.isParameterPropertyDeclaration?.(node, node.parent)) {
      const isReadonly = hasModifier(node, ts.SyntaxKind.ReadonlyKeyword);
      if (!isReadonly) {
        record(node, node.name.getText(), 'mutable constructor parameter property');
      }
    }

    // 2. Module-level state: a rebindable binding, or a const constructing
    //    mutable state. `var` carries neither flag, so test for the absence of
    //    `Const` rather than the presence of `Let`.
    if (ts.isVariableStatement(node) && node.parent === sourceFile) {
      const isRebindable = (node.declarationList.flags & ts.NodeFlags.Const) === 0;
      for (const declaration of node.declarationList.declarations) {
        if (isRebindable) {
          record(declaration, declaration.name.getText(), 'module-level let/var');
        } else if (
          constructsMutableState(declaration.initializer)
          && !isReadonlyCollectionType(declaration.type)
          && !isConstantTable(declaration)
        ) {
          record(declaration, declaration.name.getText(), 'module-level mutable container');
        }
      }
    }

    // 4. A function-local `let`/`var` a nested callback reassigns.
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) === 0) {
      const owner = enclosingFunction(node);
      if (owner !== undefined) {
        for (const declaration of node.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          if (findRetainingWrite(owner, declaration.name.text) !== undefined) {
            record(declaration, declaration.name.text, 'closure variable reassigned by a nested callback');
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const seen = new Set();
  for (const { node, name } of assignments) {
    if (declaredOffenders.has(name) || seen.has(name)) continue;
    seen.add(name);
    record(node, `this.${name}`, 'field assigned mutable state');
  }
}

async function collectTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectTsFiles(full);
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return [];
      if (/\.test\.tsx?$/.test(entry.name)) return [];
      return [full];
    }),
  );
  return files.flat();
}

/**
 * `path<space>count` per line. The count is what pins the list: file-level
 * granularity alone would let an already-listed file grow NEW state silently,
 * which is the one thing an allowlist must not buy.
 */
async function readAllowlist() {
  const budgets = new Map();
  let raw;
  try {
    raw = await fs.readFile(allowlistFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return budgets;
    throw error;
  }
  for (const line of raw.split('\n')) {
    const entry = line.replace(/#.*$/, '').trim();
    if (entry.length === 0) continue;
    const [file, count] = entry.split(/\s+/);
    if (count === undefined || !/^\d+$/.test(count)) {
      process.stderr.write(
        `Malformed setup-stateless allowlist entry: "${entry}"\n`
        + 'Each line is "<path> <declaration count>".\n',
      );
      process.exit(1);
    }
    budgets.set(file, Number(count));
  }
  return budgets;
}

const files = await collectTsFiles(scanDir);
const allowlist = await readAllowlist();
const offenders = [];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectOffenders(sourceFile, path.relative(rootDir, file), offenders);
}

const countByFile = new Map();
for (const offender of offenders) {
  countByFile.set(offender.file, (countByFile.get(offender.file) ?? 0) + 1);
}
const unlisted = offenders.filter((offender) => !allowlist.has(offender.file));
// Both directions fail. Over budget means new state landed in a file that was
// only ever meant to shed it; under budget means the line is stale and would
// silently re-admit what the migration just removed.
const drifted = [...allowlist]
  .map(([file, budget]) => ({ file, budget, actual: countByFile.get(file) ?? 0 }))
  .filter((entry) => entry.actual !== entry.budget)
  .sort((a, b) => a.file.localeCompare(b.file));

if (unlisted.length > 0) {
  process.stderr.write(
    'Setup statelessness violation (check-setup-stateless):\n'
    + 'setup/ constructs and connects — it does not run, and it does not remember\n'
    + '(setup/AGENTS.md § "No state"). State here has no owner: it sits above the\n'
    + 'layer boundaries arch:check enforces, so it becomes a back-channel between\n'
    + 'modules forbidden to talk, with no import edge to show for it.\n'
    + 'Move the state — and the rules that read it — into the domain module that\n'
    + 'owns the concept, and let setup build that component and hand it over.\n'
    + 'Offending declaration(s):\n',
  );
  for (const { file, line, name, reason } of unlisted) {
    process.stderr.write(`  ${file}:${line}  ${name} — ${reason}\n`);
  }
  process.exit(1);
}

if (drifted.length > 0) {
  process.stderr.write(
    'Setup-stateless allowlist drift (check-setup-stateless):\n'
    + 'Each line of scripts/setup-stateless-allowlist.txt budgets how many stateful\n'
    + 'declarations a pre-existing file still has. A count that went UP means new\n'
    + 'state landed in a file that is supposed to be shedding it — move it out\n'
    + 'instead. A count that went DOWN (or to zero) means the line is stale: lower\n'
    + 'it, or delete it when the file is clean. When the last line goes, delete the\n'
    + 'allowlist file itself. The budget may only shrink.\n',
  );
  for (const { file, budget, actual } of drifted) {
    const direction = actual > budget ? 'state added' : 'update the line';
    process.stderr.write(`  ${file}  budgeted ${budget}, found ${actual} — ${direction}\n`);
  }
  process.exit(1);
}

const remaining = [...allowlist.values()].reduce((sum, count) => sum + count, 0);
process.stdout.write(
  `setup:stateless OK — ${files.length} files scanned, `
  + `${allowlist.size} files / ${remaining} declarations awaiting migration\n`,
);
