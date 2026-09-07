// Boundary guard for the app-wiring layer.
//
// WHY THIS EXISTS: `setup/` wires. It decides nothing, and it does not touch the
// SDK (`setup/AGENTS.md` § "No domain logic"). Both halves of that rule failed
// silently for a long time under a hedged phrasing ("push logic down if it is
// reusable"), and by the time anyone measured, 55 of 138 files imported two or
// more domain peers, `setup/` carried the same logic density as `lib/plan`, and
// it was the single largest area of the runtime bundle at 18%. A rule that
// nothing enforces is a rule that decays; § "No state" got a script and shrank,
// this one got prose and did not.
//
// It checks the two things a script CAN check. Neither is the rule itself —
// "no domain logic" is a judgement — but each is a proxy that only moves when
// the rule is being kept or broken, and together they cover both halves.
//
//   1. CROSS-PEER COMPOSITION. A `setup/` file importing two or more of the
//      twelve domain peers is composing domains. That is the shape the rule
//      exists to stop: the peers may not import each other (nine
//      `no-<domain>-to-peer` rules, plus `no-plan-to-device` and
//      `no-plan-to-executor`), so a file that needs two of them is a concept
//      nobody has named, sitting in the one layer where naming it is optional.
//      Coupling that happens ABOVE the boundary has no import edge for
//      `arch:check` to object to — which is exactly why it needs its own check.
//
//   2. SDK CONTACT. A `setup/` file importing from `'homey'` is reading the SDK
//      rather than wiring it. The rule is that setup hands the owning module a
//      structural port from `lib/ports/homeyRuntime.ts` and that module does the
//      read, the absence classification and the last-good policy.
//
// TYPE-ONLY IMPORTS COUNT for the peer check, and deliberately. `import type`
// leaves no runtime edge, but the coupling it expresses is the thing being
// measured: a file that needs to name three domains' types to do its job is
// composing three domains whether or not the bytes survive compilation. It is
// also what the published baseline counted, and a metric that quietly changes
// definition is worse than no metric.
//
// PARSED FROM THE AST, not matched with a regex. The seeded counts in
// `setup/AGENTS.md` were first measured with a regex that required `export
// (const|function)` and silently missed `export async function wireDeviceTransport`
// — an undercount nobody would have caught without an independent re-derivation.
// Every import form (`import`, `import type`, `export ... from`, side-effect
// import) reaches the same node type, so the AST cannot be dodged by layout.
//
// THE ALLOWLISTS carry the files that predate the rule.
//   - `scripts/setup-peer-allowlist.txt` budgets each listed file's PEER COUNT.
//     File-level alone would let a listed 2-peer file grow to 4 in silence,
//     which is the one thing an allowlist must not buy.
//   - `scripts/setup-sdk-allowlist.txt` is a plain file list: importing from
//     `'homey'` is binary, so there is nothing to budget.
// Both drift directions fail. Over budget means the layer got worse; under
// budget (or a listed file that is now clean) means the line is stale and would
// silently re-admit what a migration just removed. When a list empties, delete
// it — the guard then requires its absence.
//
// Regenerate with `--seed` after a deliberate migration; never edit by hand.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanDir = path.join(rootDir, 'setup');
const peerAllowlistFile = path.join(rootDir, 'scripts/setup-peer-allowlist.txt');
const sdkAllowlistFile = path.join(rootDir, 'scripts/setup-sdk-allowlist.txt');

/**
 * The twelve domain peers, as `AGENTS.md` § "Hard rules" lists them. Keep this
 * set and that list in step — a peer missing here is a coupling this guard
 * cannot see.
 */
const PEERS = new Set([
  'device', 'power', 'objectives', 'plan', 'price', 'dailyBudget',
  'observer', 'executor', 'actuator', 'weather', 'solar', 'home',
]);

const listFiles = async (dir, acc = []) => {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(next, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) acc.push(next);
  }
  return acc;
};

/**
 * Every module specifier the file imports or re-exports from, in source order.
 *
 * Four forms, because a guard that only sees the static ones is a guard the SDK
 * check can be walked around: `await import('homey')` reaches the same runtime
 * dependency with no `ImportDeclaration` anywhere in the tree, and
 * `import('homey').App` does it in type position. Both are call/type nodes
 * rather than statements, so each needs its own predicate — this is the one way
 * the AST *can* be dodged, and it is closed here rather than left to the
 * layout-independence the static forms already have.
 */
const moduleSpecifiers = (sourceFile) => {
  const out = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    }
    // `await import('homey')` — a call whose callee is the `import` keyword.
    if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])) {
      out.push(node.arguments[0].text);
    }
    // `import('homey').App` in type position.
    if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
};

const analyse = (specifiers) => {
  const peers = new Set();
  let sdk = false;
  for (const specifier of specifiers) {
    if (specifier === 'homey' || specifier.startsWith('homey/')) sdk = true;
    const match = /(?:^|\/)lib\/([A-Za-z]+)\//.exec(specifier);
    if (match !== null && PEERS.has(match[1])) peers.add(match[1]);
  }
  return { peers, sdk };
};

const readAllowlist = async (file, withCounts) => {
  const entries = new Map();
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { entries, present: false };
    throw error;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [file_, count] = trimmed.split(/\s+/);
    entries.set(file_, withCounts ? Number(count) : 0);
  }
  return { entries, present: true };
};

const files = await listFiles(scanDir);
const peerOffenders = new Map();
const sdkOffenders = [];

for (const absolute of files) {
  const rel = path.relative(rootDir, absolute);
  const source = await fs.readFile(absolute, 'utf8');
  const sourceFile = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
  const { peers, sdk } = analyse(moduleSpecifiers(sourceFile));
  if (peers.size >= 2) peerOffenders.set(rel, [...peers].sort());
  if (sdk) sdkOffenders.push(rel);
}
sdkOffenders.sort();

if (process.argv.includes('--seed')) {
  const peerBody = [...peerOffenders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, peers]) => `${file} ${peers.length}  # ${peers.join(', ')}`)
    .join('\n');
  await fs.writeFile(peerAllowlistFile,
    '# setup/ files that import two or more domain peers, and therefore compose\n'
    + '# domains rather than wire them (setup/AGENTS.md § "No domain logic").\n'
    + '#\n'
    + '# Format: "<path> <peer count>". The count is the budget and may only\n'
    + '# SHRINK. A count that goes up fails the guard; a count left stale after a\n'
    + '# migration fails too, so the list cannot rot into a permanent exemption.\n'
    + '# Regenerate with `node scripts/check-setup-boundaries.mjs --seed`, never by\n'
    + '# hand. When the last line goes, DELETE THIS FILE.\n#\n'
    + `# Seeded at ${peerOffenders.size} files.\n\n${peerBody}\n`, 'utf8');
  await fs.writeFile(sdkAllowlistFile,
    "# setup/ files that import from 'homey'. The wiring layer does not touch the\n"
    + '# SDK: it hands the owning module a structural port from\n'
    + '# lib/ports/homeyRuntime.ts and that module does the read\n'
    + '# (setup/AGENTS.md § "No domain logic").\n'
    + '#\n'
    + '# A plain file list — importing the SDK is binary, so there is nothing to\n'
    + '# budget. A file that stops importing it must be removed from this list.\n'
    + '# Regenerate with `node scripts/check-setup-boundaries.mjs --seed`, never by\n'
    + '# hand. When the last line goes, DELETE THIS FILE.\n#\n'
    + `# Seeded at ${sdkOffenders.length} files.\n\n${sdkOffenders.join('\n')}\n`, 'utf8');
  process.stdout.write(
    `setup:boundaries seeded — ${peerOffenders.size} cross-peer files, ${sdkOffenders.length} SDK importers\n`,
  );
  process.exit(0);
}

const peerAllow = await readAllowlist(peerAllowlistFile, true);
const sdkAllow = await readAllowlist(sdkAllowlistFile, false);
const problems = [];

for (const [file, peers] of [...peerOffenders].sort(([a], [b]) => a.localeCompare(b))) {
  const budget = peerAllow.entries.get(file);
  if (budget === undefined) {
    problems.push(`  ${file} — composes ${peers.length} domains (${peers.join(', ')}); not on the allowlist`);
  } else if (peers.length !== budget) {
    const direction = peers.length > budget ? 'coupling added' : 'update the line';
    problems.push(`  ${file} — budgeted ${budget} peers, found ${peers.length} (${peers.join(', ')}); ${direction}`);
  }
}
for (const [file] of peerAllow.entries) {
  if (!peerOffenders.has(file)) problems.push(`  ${file} — listed as cross-peer but is clean; delete the line`);
}
for (const file of sdkOffenders) {
  if (!sdkAllow.entries.has(file)) problems.push(`  ${file} — imports from 'homey'; take a port from lib/ports/homeyRuntime.ts instead`);
}
for (const [file] of sdkAllow.entries) {
  if (!sdkOffenders.includes(file)) problems.push(`  ${file} — listed as an SDK importer but is clean; delete the line`);
}

if (problems.length > 0) {
  process.stderr.write(
    'Setup boundary violation (check-setup-boundaries):\n'
    + 'setup/ wires. It decides nothing, and it does not touch the SDK\n'
    + '(setup/AGENTS.md § "No domain logic").\n'
    + 'A file needing two domain peers at once is a concept nobody has named, not\n'
    + 'cross-cutting code needing a home: name it and give it a module — a domain\n'
    + 'service beside the port it implements, a projection between two domains in a\n'
    + 'neutral contract module. A file reading the SDK should be handed a\n'
    + 'SettingsPort/FlowPort/ApiPort instead, with the owning module doing the read.\n'
    + 'Both counts may only go down.\n',
  );
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `setup:boundaries OK — ${files.length} files scanned, `
  + `${peerAllow.entries.size} cross-peer and ${sdkAllow.entries.size} SDK-importing files awaiting migration\n`,
);
