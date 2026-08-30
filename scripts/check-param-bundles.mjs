// Param-bundle guard.
//
// WHY THIS EXISTS: a function parameter typed as an INLINE OBJECT LITERAL is a
// bag, not a domain object. It has no name, so nothing else in the model can
// hold it, pass it, or reason about it; it exists for exactly one call and is
// destructured back into loose values on the first line of the body. The repo
// has 1,008 such sites carrying 8,509 lines of property declarations and
// matching `const { … } = params` blocks — 6.9% of all executable code spent
// restating argument lists.
//
// They are not there because anyone wanted them. `eslint.config.mjs`'s
// `max-params` is enforced at `--max-warnings=0`, and for a long time it was 5,
// so the cheapest way past a sixth argument was to wrap the arguments in an
// object. The rule cannot tell six honest arguments from a 48-field
// god-object, and it reliably produced the latter to avoid the former:
// `AppContext` reached 91 fields, `AppServiceWiringDeps` 50, `FlowCardDeps` 38.
//
// THE RULE (owner ruling, 2026-08-30): if you pass an object, it must be a
// DOMAIN OBJECT — a named concept that means something in the model and that
// other code also holds and passes. A bag invented to get under an argument
// limit is banned. `max-params` is 7 so an honest signature fits without one.
//
// THE INVERSE FAILURE COUNTS TOO, and this guard cannot see it: taking a real
// domain object and exploding it into loose scalars downstream. `RestoreTiming`
// (17 fields, lib/plan/restore/timing.ts) is flattened into 14 scalars on
// `RestorePlanResult`, re-listed at the call site, re-declared as 12 scalars
// under different names in `ShedHoldParams`, re-destructured, re-passed
// individually, and narrowed by three `Pick<>`s — one of which
// (`CapacityRestoreGateTiming`) had no consumer outside its own file. When you
// already hold the domain object, pass it.
//
// WHAT COUNTS AS A VIOLATION: a parameter whose type is an inline object
// literal (a TypeScript `TypeLiteral`) declaring 3 or more members. Two members
// or fewer is a small structural constraint, not a bag, and stays legal.
//
// Detection runs on the TypeScript AST, not on a regex over the text. A regex
// has to guess at layout, and every guess is a hole: an earlier version of this
// script required the opening brace to end the line, so the single-line
// `constructor(params: { homey: Homey.App; logger: Logger; callbacks: FeedCallbacks })`
// in lib/device/liveFeed.ts was invisible to it, and any new bag could dodge the
// ratchet by being written on one line. A destructured parameter
// (`({ a, b, c }: { a: A; b: B; c: C })`) is the same bag with the binding
// inlined, and the AST sees it for what it is.
//
// WHAT IS ALLOWED, and why each is not a hole:
//   - A NAMED type as a parameter (`deps: PlanBuilderDeps`). This guard cannot
//     judge whether a name denotes a real concept; review does. Naming the type
//     is the first step out of a bag, and a named type at least has one place
//     to look and one place to fix.
//   - Inline object literals in RETURN types and in variable declarations. This
//     rule is about argument lists.
//   - Test files. They construct fixtures; a bag there costs nothing.
//
// THE ALLOWLIST IS A RATCHET. `scripts/param-bundle-allowlist.txt` records
// "<path> <site count>" for every file that predates the rule. A count may only
// SHRINK. Adding a bundle to an already-listed file fails the guard, so the
// debt cannot grow while it is being paid down. A count that no longer matches
// after you remove one is also a failure — update the line, or delete it when
// the file reaches zero.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = join(ROOT, 'scripts', 'param-bundle-allowlist.txt');
const MIN_PROPERTIES = 3;

const SCAN_ROOTS = [
  'app.ts', 'api.ts', 'lib', 'setup', 'flowCards', 'drivers', 'widgets',
  'packages/contracts/src', 'packages/shared-domain/src', 'packages/settings-ui/src',
];


function isScannable(name) {
  if (name.endsWith('.d.ts') || name.endsWith('.generated.ts')) return false;
  return name.endsWith('.ts') || name.endsWith('.tsx');
}

function collect(target, found) {
  if (!existsSync(target)) return;
  if (statSync(target).isFile()) {
    if (isScannable(target)) found.push(target);
    return;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    collect(join(target, entry.name), found);
  }
}

function sourceFiles() {
  const found = [];
  for (const root of SCAN_ROOTS) collect(join(ROOT, root), found);
  return found.sort();
}

// Returns the number of parameters typed as an inline object literal carrying
// >= MIN_PROPERTIES members, anywhere in the file, at any layout.
function countBundles(path, text) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let sites = 0;
  const visit = (node) => {
    if (ts.isParameter(node)
      && node.type !== undefined
      && ts.isTypeLiteralNode(node.type)
      && node.type.members.length >= MIN_PROPERTIES) {
      sites += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return sites;
}

function readAllowlist() {
  const budgets = new Map();
  if (!existsSync(ALLOWLIST)) return budgets;
  for (const line of readFileSync(ALLOWLIST, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [path, count] = trimmed.split(/\s+/);
    budgets.set(path, Number(count));
  }
  return budgets;
}

// `--seed` rewrites the allowlist from the current tree using THIS file's
// counter, so the seeder and the checker can never disagree. Regenerating it
// with a separate script is how the first version of this guard shipped a hole:
// the two implementations drifted and the allowlist certified counts the checker
// never produced.
if (process.argv.includes('--seed')) {
  const rows = [];
  let total = 0;
  for (const file of sourceFiles()) {
    const sites = countBundles(file, readFileSync(file, 'utf8'));
    if (sites === 0) continue;
    rows.push(`${relative(ROOT, file)} ${sites}`);
    total += sites;
  }
  const header = [
    '# Files carrying param bundles that predate the "a parameter object must be a',
    '# domain object" rule (AGENTS.md, enforced by scripts/check-param-bundles.mjs).',
    '#',
    '# A bundle here is a parameter typed as an inline object literal with 3+',
    '# members: an anonymous bag with no other holder in the model, destructured',
    '# straight back into loose values on the first line of the body.',
    '#',
    '# Format: "<path> <bundle count>". The count is a budget and it may only SHRINK.',
    '# A count that goes UP fails the guard, so the debt cannot grow while it is being',
    '# paid down. A count that no longer matches after you remove a bundle also fails:',
    '# update the line, or delete it once the file reaches zero.',
    '#',
    `# Regenerate with \`node scripts/check-param-bundles.mjs --seed\` — never by hand,`,
    '# and never with a second script.',
    '#',
    `# Seeded ${new Date().toISOString().slice(0, 10)}: ${rows.length} files, ${total} bundles.`,
    '',
  ].join('\n');
  writeFileSync(ALLOWLIST, `${header}${rows.join('\n')}\n`);
  console.log(`Param-bundle allowlist seeded: ${rows.length} files, ${total} bundles.`);
  process.exit(0);
}

const budgets = readAllowlist();
const overBudget = [];
const staleBudget = [];
const unlisted = [];

for (const file of sourceFiles()) {
  const path = relative(ROOT, file);
  const sites = countBundles(file, readFileSync(file, 'utf8'));
  const budget = budgets.get(path);
  if (budget === undefined) {
    if (sites > 0) unlisted.push({ path, sites });
    continue;
  }
  if (sites > budget) overBudget.push({ path, sites, budget });
  else if (sites < budget) staleBudget.push({ path, sites, budget });
  budgets.delete(path);
}

const lines = [];
if (unlisted.length > 0) {
  lines.push('Param bundles in files that are not on the allowlist:');
  for (const { path, sites } of unlisted) lines.push(`  ${path} — ${sites} bundle(s)`);
  lines.push('');
  lines.push('An inline object literal as a parameter type is a bag, not a domain object.');
  lines.push('Pass the arguments, or name the concept and pass that. See the header of');
  lines.push('scripts/check-param-bundles.mjs.');
}
if (overBudget.length > 0) {
  lines.push('Param-bundle count grew in a file that is supposed to be shedding them:');
  for (const { path, sites, budget } of overBudget) {
    lines.push(`  ${path} — ${sites} bundle(s), budget ${budget}`);
  }
}
if (staleBudget.length > 0) {
  lines.push('Param-bundle count shrank — thank you. Update the allowlist to lock it in:');
  for (const { path, sites, budget } of staleBudget) {
    lines.push(`  ${path} — ${sites} bundle(s), allowlist still says ${budget}`);
  }
}
if (budgets.size > 0) {
  lines.push('Allowlist entries for files that no longer exist:');
  for (const path of budgets.keys()) lines.push(`  ${path}`);
}

if (lines.length > 0) {
  console.error(lines.join('\n'));
  process.exit(1);
}

console.log('Param-bundle guard: no new bags.');
