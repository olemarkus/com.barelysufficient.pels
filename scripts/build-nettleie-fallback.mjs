// Generates lib/price/nettleieFallbackData.generated.ts from the community
// "Fri Nettleie" dataset (https://github.com/kraftsystemet/fri-nettleie).
//
// This is a build-time/maintenance script, not shipped runtime code. It fetches
// every operator tariff file plus the Elhub GLN→organisasjonsnr reference table,
// and emits an orgnr-keyed table: the operator's tariff file, which PELS fetches
// live, and every tariff period still valid today or starting later, which PELS
// prices on when that fetch fails (see lib/price/gridTariffRefresh.ts). A grid
// company is matched to a file through the GLNs Elhub lists for its orgnr.
//
// The files are read with the same parser and reader the live fetch uses
// (lib/price/friNettleieYaml.ts, lib/price/friNettleieTariff.ts), so a file
// the generator cannot read is one the Homey cannot read either.
//
// Run with: npm run build:nettleie-fallback
// With --check, writes nothing and exits 1 when the committed table differs from
// what Fri Nettleie gives today, or when a file does not parse
// (scripts/check-grid-tariffs.mjs runs it weekly).
//
// Source data licence: CC-BY-4.0 (Fri Nettleie / kraftsystemet.no). The Elhub
// reference data follows Elhub's terms. Attribution is carried into the
// generated file's header.

import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'kraftsystemet/fri-nettleie';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const CONTENTS_API = `https://api.github.com/repos/${REPO}/contents/tariffer`;
const GRID_OWNERS_URL = `${RAW_BASE}/referanse-data/elhub/grid_owners.json`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'lib/price/nettleieFallbackData.generated.ts');

// GitHub's REST API rejects requests without a User-Agent, so set one explicitly
// rather than relying on the runtime's default.
const USER_AGENT = 'pels-nettleie-fallback-generator';

const fetchText = async (url) => {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github.raw+json, text/plain', 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
};

const fetchJson = async (url) => {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json();
};

// The runtime's parser and reader, bundled from TypeScript. Written under
// node_modules so nothing lands in the source tree.
const loadReader = async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { parseFriNettleieYaml } from './lib/price/friNettleieYaml';",
        "export { readFriNettleieTariffs } from './lib/price/friNettleieTariff';",
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  });
  const bundlePath = path.join(ROOT, 'node_modules/.cache/pels/fri-nettleie-reader.mjs');
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, result.outputFiles[0].text);
  return import(pathToFileURL(bundlePath).href);
};

const main = async () => {
  const check = process.argv.includes('--check');
  // Norwegian grid tariffs change on local calendar dates, so resolve "today" in
  // Europe/Oslo (not UTC) to avoid dropping a period one hour early.
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  console.log(`Building the grid tariff table for ${todayKey} (Europe/Oslo)`);

  const { parseFriNettleieYaml, readFriNettleieTariffs } = await loadReader();

  const gridOwners = await fetchJson(GRID_OWNERS_URL);
  const glnToOwner = new Map();
  for (const owner of gridOwners) {
    if (owner?.gln && owner?.organisationNumber) {
      glnToOwner.set(String(owner.gln), {
        orgnr: String(owner.organisationNumber),
        name: String(owner.name ?? '').trim(),
      });
    }
  }
  console.log(`Loaded ${glnToOwner.size} GLN→orgnr mappings from Elhub reference data`);

  const dir = await fetchJson(CONTENTS_API);
  const files = dir
    .filter((entry) => entry?.type === 'file' && String(entry.name).endsWith('.yml'))
    .map((entry) => entry.name);
  console.log(`Found ${files.length} operator tariff files`);

  const byOrgnr = {};
  const unreadable = [];
  let skippedNoOrgnr = 0;
  let skippedNoTariff = 0;

  for (const file of files) {
    const raw = await fetchText(`${RAW_BASE}/tariffer/${file}`);
    let doc;
    try {
      doc = parseFriNettleieYaml(raw);
    } catch (error) {
      unreadable.push(`${file}: ${error.message}`);
      continue;
    }
    const tariffs = readFriNettleieTariffs(doc, todayKey);
    if (!tariffs) {
      // No current period, or a current one PELS cannot read.
      skippedNoTariff += 1;
      continue;
    }

    const glnList = Array.isArray(doc?.gln) ? doc.gln.map(String) : [];
    const orgnrs = [...new Set(glnList.map((gln) => glnToOwner.get(gln)?.orgnr).filter(Boolean))];
    if (orgnrs.length === 0) {
      skippedNoOrgnr += 1;
      console.warn(`! ${file}: no orgnr resolved from GLN ${JSON.stringify(glnList)}; skipping`);
      continue;
    }
    const name = String(doc?.netteier ?? glnToOwner.get(glnList[0])?.name ?? file).trim();
    for (const orgnr of orgnrs) {
      byOrgnr[orgnr] = { name, file, tariffs };
    }
  }

  const operatorCount = Object.keys(byOrgnr).length;
  console.log(
    `Resolved ${operatorCount} orgnr entries `
    + `(skipped ${skippedNoOrgnr} without orgnr, ${skippedNoTariff} without a current tariff)`,
  );
  for (const line of unreadable) console.warn(`! unreadable: ${line}`);

  const sorted = Object.fromEntries(Object.entries(byOrgnr).sort(([a], [b]) => a.localeCompare(b)));
  // Collapse pure-number arrays (the hour lists) onto a single line for readability.
  const body = JSON.stringify(sorted, null, 2)
    .replace(/\[\n\s*((?:-?\d+(?:\.\d+)?,\n\s*)*-?\d+(?:\.\d+)?)\n\s*\]/g, (_match, inner) => (
      `[${inner.replace(/,\n\s*/g, ', ')}]`
    ));

  const header = `// AUTO-GENERATED by scripts/build-nettleie-fallback.mjs — DO NOT EDIT BY HAND.
// Run \`npm run build:nettleie-fallback\` to refresh.
//
// Norwegian grid tariffs (nettleie) per grid company: the Fri Nettleie file PELS
// fetches live, and the tariff periods it prices on when that fetch fails.
//
// Generated: ${todayKey} | Operators: ${operatorCount}
// Source: Fri Nettleie (https://github.com/kraftsystemet/fri-nettleie), CC-BY-4.0.
// GLN→organisasjonsnr mapping from Elhub reference data.
//
// Periods and fees are as lib/price/friNettleieTariff.ts reads them; resolution
// to a concrete day happens in lib/price/staticGridTariffFallback.ts.
`;

  const ts = `${header}
import type { FriNettleieTariffs } from './friNettleieTariff';

export interface NettleieFallbackOperator {
  readonly name: string;
  /** The operator's file under \`tariffer/\` in Fri Nettleie. */
  readonly file: string;
  readonly tariffs: FriNettleieTariffs;
}

export const NETTLEIE_FALLBACK_GENERATED_AT = '${todayKey}';

export const NETTLEIE_FALLBACK_BY_ORGNR: Readonly<Record<string, NettleieFallbackOperator>> = ${body};
`;

  if (check) {
    // The generation date alone does not make the table stale.
    const withoutDate = (text) => text.replace(/^.*Generated: .*$/m, '').replace(/GENERATED_AT = '.*'/, '');
    const committed = await readFile(OUT_PATH, 'utf8');
    const matches = withoutDate(committed) === withoutDate(ts);
    console.log(matches
      ? 'Grid tariff table matches Fri Nettleie'
      : 'Grid tariff table differs from Fri Nettleie: run npm run build:nettleie-fallback');
    if (!matches || unreadable.length > 0) process.exitCode = 1;
    return;
  }
  // A table built without an unreadable file would drop that company, so the
  // committed one stays until every file reads.
  if (unreadable.length > 0) {
    console.error(`Not writing ${OUT_PATH}: ${unreadable.length} unreadable file(s)`);
    process.exitCode = 1;
    return;
  }
  await writeFile(OUT_PATH, ts, 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
