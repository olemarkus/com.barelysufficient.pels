// Shrinking budget for the shared `AppContext` bag.
//
// WHY THIS EXISTS: a new runtime service has kept landing as one more
// `AppContext` slot — a member on `lib/app/appContext.ts`, a placeholder in
// `app.ts`, and a `ctx.<member> = …` assignment in a `setup/` wiring file. Each
// slot is reachable from every module handed the context, so it is a channel
// with no import edge for `arch:check` to see, and the bag only ever grew. This
// guard pins both measures of it so they can only shrink:
//
//   1. The number of distinct `AppContext` members (a getter/setter pair is one
//      member).
//   2. Every `ctx.<member> = …` assignment under `setup/`, budgeted per file and
//      member. Plain `=` and compound assignments both count; reads do not.
//
// THE ALLOWLIST (`scripts/context-slot-allowlist.txt`) holds one
// `AppContext <count>` line and one `<file> <member> <count>` line per assigned
// slot. Both drift directions fail, exactly like the setup-stateless budget: an
// increase means a new slot landed, a decrease means the line is stale and must
// be lowered (or deleted) in the change that removed the slot. A new runtime
// service belongs to the `lib/` module that owns it, constructed by setup and
// handed to its consumers, not parked on the context.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contextFile = path.join(rootDir, 'lib/app/appContext.ts');
const scanDir = path.join(rootDir, 'setup');
const allowlistFile = path.join(rootDir, 'scripts/context-slot-allowlist.txt');
const CONTEXT_KEY = 'AppContext';

function memberName(member) {
  if (!member.name) return undefined;
  return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
    ? member.name.text
    : member.name.getText();
}

async function countContextMembers() {
  const source = await fs.readFile(contextFile, 'utf8');
  const sourceFile = ts.createSourceFile(contextFile, source, ts.ScriptTarget.Latest, true);
  const alias = sourceFile.statements.find((statement) => (
    ts.isTypeAliasDeclaration(statement) && statement.name.text === CONTEXT_KEY
  ));
  if (!alias || !ts.isTypeLiteralNode(alias.type)) {
    process.stderr.write(`check-context-slots: ${CONTEXT_KEY} is no longer a type literal in ${contextFile}\n`);
    process.exit(1);
  }
  const names = new Set();
  for (const member of alias.type.members) {
    const name = memberName(member);
    if (name !== undefined) names.add(name);
  }
  return names.size;
}

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
]);

/** `ctx.x = …` or `this.ctx.x = …`. */
function contextSlotName(left) {
  if (!ts.isPropertyAccessExpression(left)) return undefined;
  const receiver = left.expression;
  const isCtx = (ts.isIdentifier(receiver) && receiver.text === 'ctx')
    || (ts.isPropertyAccessExpression(receiver)
      && receiver.expression.kind === ts.SyntaxKind.ThisKeyword
      && receiver.name.text === 'ctx');
  return isCtx ? left.name.text : undefined;
}

async function collectTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTsFiles(full);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  }));
  return files.flat();
}

async function collectAssignments() {
  const counts = new Map();
  for (const file of await collectTsFiles(scanDir)) {
    const source = await fs.readFile(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const relPath = path.relative(rootDir, file);
    const visit = (node) => {
      if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
        const slot = contextSlotName(node.left);
        if (slot !== undefined) {
          const key = `${relPath} ${slot}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return counts;
}

async function readAllowlist() {
  const raw = await fs.readFile(allowlistFile, 'utf8');
  let memberBudget;
  const slots = new Map();
  for (const line of raw.split('\n')) {
    const entry = line.replace(/#.*$/, '').trim();
    if (entry.length === 0) continue;
    const parts = entry.split(/\s+/);
    const count = parts.at(-1);
    if (!/^\d+$/.test(count ?? '')) {
      process.stderr.write(`Malformed context-slot allowlist entry: "${entry}"\n`);
      process.exit(1);
    }
    if (parts.length === 2 && parts[0] === CONTEXT_KEY) {
      memberBudget = Number(count);
    } else if (parts.length === 3) {
      slots.set(`${parts[0]} ${parts[1]}`, Number(count));
    } else {
      process.stderr.write(
        `Malformed context-slot allowlist entry: "${entry}"\n`
        + `Each line is "${CONTEXT_KEY} <member count>" or "<file> <member> <assignment count>".\n`,
      );
      process.exit(1);
    }
  }
  if (memberBudget === undefined) {
    process.stderr.write(`context-slot allowlist has no "${CONTEXT_KEY} <count>" line\n`);
    process.exit(1);
  }
  return { memberBudget, slots };
}

const memberCount = await countContextMembers();
const assignments = await collectAssignments();
const { memberBudget, slots } = await readAllowlist();

const failures = [];
if (memberCount !== memberBudget) {
  failures.push(`  ${CONTEXT_KEY} members: budgeted ${memberBudget}, found ${memberCount} — ${
    memberCount > memberBudget ? 'a member was added' : 'lower the budget'}`);
}
for (const key of new Set([...slots.keys(), ...assignments.keys()])) {
  const budget = slots.get(key) ?? 0;
  const actual = assignments.get(key) ?? 0;
  if (budget === actual) continue;
  failures.push(`  ${key}: budgeted ${budget}, found ${actual} — ${
    actual > budget ? 'a context slot assignment was added' : 'update the line'}`);
}

if (failures.length > 0) {
  process.stderr.write(
    'AppContext slot budget drift (check-context-slots):\n'
    + 'A new runtime service belongs to the lib/ module that owns it, built by setup\n'
    + 'and handed to its consumers, not parked as another AppContext slot. Budgets in\n'
    + 'scripts/context-slot-allowlist.txt may only shrink: lower or delete a line in\n'
    + 'the change that removes a slot.\n'
    + failures.sort().join('\n') + '\n',
  );
  process.exit(1);
}

const assigned = [...assignments.values()].reduce((sum, count) => sum + count, 0);
process.stdout.write(
  `context:slots OK — ${memberCount} ${CONTEXT_KEY} members, ${assigned} setup slot assignments budgeted\n`,
);
