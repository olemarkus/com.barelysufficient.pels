// Generates lib/price/friNettleieFiles.generated.ts from the community
// "Fri Nettleie" dataset (https://github.com/kraftsystemet/fri-nettleie).
//
// This is a build-time/maintenance script, not shipped runtime code. It fetches
// every operator tariff file plus the Elhub GLN→organisasjonsnr reference table,
// and emits which file holds each grid company's tariff, matched through the
// GLNs Elhub lists for its orgnr. PELS fetches that file live and keeps the
// last one it read (see lib/price/gridTariffRefresh.ts); the tariffs themselves
// are not bundled.
//
// Every file is read with the parser and reader the live fetch uses
// (lib/price/friNettleieYaml.ts, lib/price/friNettleieTariff.ts), so a file
// the generator cannot read is one the Homey cannot read either, and the run
// stops without writing.
//
// Run with: npm run build:fri-nettleie-files
// With --check, writes nothing and exits 1 when the committed map differs from
// what Fri Nettleie gives today, or when a file does not read
// (scripts/check-grid-tariffs.mjs, which `npm run release -- start` runs).
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
const OUT_PATH = path.join(ROOT, 'lib/price/friNettleieFiles.generated.ts');

// Grid companies that no longer operate, each priced on the file of the company
// that took over its grid (Elhub's structural changes). An owner may have saved
// one before it merged; the settings list shows those as `retiredGridCompanies`
// and offers them to no one else. Fri Nettleie no longer lists their GLNs.
//  - Hemsil Nett (Hemsedal) and Føie Akershus moved to Føie on 2026-05-11, on
//    one Føie price list since August 2025 (fri-nettleie #164).
//  - Norgesnett moved to Glitre Nett on 2026-10-12 (#445), on Glitre's energy
//    rates since 2026-07-01.
//  - Rakkestad Energi moved to Elvia on 2026-03-02, and Modalen Kraftlag to
//    Mostraum Nett on 2025-02-10.
//  - LeGa Nett and Luostejok Nett moved to Area Nett on 2024-11-07. Area keeps
//    their regional tariffs, so each keeps its own file.
const RETIRED_GRID_COMPANY_FILES = {
  '923050612': 'foie.yml',
  '987626844': 'foie.yml',
  '980234088': 'glitre.yml',
  '968398083': 'elvia.yml',
  '877051412': 'mostraum.yml',
  '924868759': 'area-lega.yml',
  '924934867': 'area-luostejok.yml',
};

// GitHub's REST API rejects requests without a User-Agent, so set one explicitly
// rather than relying on the runtime's default.
const USER_AGENT = 'pels-fri-nettleie-files-generator';

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
  const byFile = {};
  const filesByOrgnr = {};
  const blocking = [];
  let skippedNoOrgnr = 0;
  let skippedNoTariff = 0;

  for (const file of files) {
    const raw = await fetchText(`${RAW_BASE}/tariffer/${file}`);
    let doc;
    try {
      doc = parseFriNettleieYaml(raw);
    } catch (error) {
      blocking.push(`${file}: unreadable: ${error.message}`);
      continue;
    }
    const read = readFriNettleieTariffs(doc, todayKey);
    if (read.kind === 'malformed') {
      blocking.push(`${file}: a current or future tariff period cannot be read`);
      continue;
    }
    if (read.kind === 'none') {
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
    byFile[file] = file;
    for (const orgnr of orgnrs) {
      (filesByOrgnr[orgnr] ??= []).push(file);
      byOrgnr[orgnr] = file;
    }
  }

  // Several files under one company's GLNs are regional tariffs (Area Nett
  // keeps the tariffs of the companies it took over). The company PELS holds
  // cannot say which applies, so it is left out and priced from NVE.
  for (const [orgnr, orgnrFiles] of Object.entries(filesByOrgnr)) {
    if (orgnrFiles.length < 2) continue;
    console.warn(`! ${orgnr}: ${orgnrFiles.join(', ')} share its GLN; left to NVE`);
    delete byOrgnr[orgnr];
  }

  // A retired company whose successor file is gone is a table that would drop
  // it, so it blocks the build like an unreadable file.
  for (const [orgnr, file] of Object.entries(RETIRED_GRID_COMPANY_FILES)) {
    const successor = byFile[file];
    if (byOrgnr[orgnr]) {
      blocking.push(`${orgnr}: listed by Fri Nettleie again; drop it from RETIRED_GRID_COMPANY_FILES`);
    } else if (!successor) {
      blocking.push(`${orgnr}: its successor ${file} is not in the table`);
    } else {
      byOrgnr[orgnr] = successor;
    }
  }

  const operatorCount = Object.keys(byOrgnr).length;
  console.log(
    `Resolved ${operatorCount} orgnr entries `
    + `(skipped ${skippedNoOrgnr} without orgnr, ${skippedNoTariff} without a current tariff)`,
  );
  for (const line of blocking) console.warn(`! ${line}`);

  const sorted = Object.fromEntries(Object.entries(byOrgnr).sort(([a], [b]) => a.localeCompare(b)));
  const body = JSON.stringify(sorted, null, 2);

  const header = `// AUTO-GENERATED by scripts/build-fri-nettleie-files.mjs — DO NOT EDIT BY HAND.
// Run \`npm run build:fri-nettleie-files\` to refresh.
//
// The Fri Nettleie file (under \`tariffer/\`) that holds each Norwegian grid
// company's tariff, by organisasjonsnummer. PELS fetches it live.
//
// Generated: ${todayKey} | Operators: ${operatorCount}
// Source: Fri Nettleie (https://github.com/kraftsystemet/fri-nettleie), CC-BY-4.0.
// GLN→organisasjonsnr mapping from Elhub reference data.
`;

  const ts = `${header}
export const FRI_NETTLEIE_FILE_BY_ORGNR: Readonly<Record<string, string>> = ${body};
`;

  if (check) {
    // The generation date alone does not make the table stale.
    const withoutDate = (text) => text.replace(/^.*Generated: .*$/m, '');
    const committed = await readFile(OUT_PATH, 'utf8');
    const matches = withoutDate(committed) === withoutDate(ts);
    console.log(matches
      ? 'Fri Nettleie file map matches Fri Nettleie'
      : 'Fri Nettleie file map differs from Fri Nettleie: run npm run build:fri-nettleie-files');
    if (!matches || blocking.length > 0) process.exitCode = 1;
    return;
  }
  // A table built past a blocking problem would drop that company, so the
  // committed one stays until every file reads.
  if (blocking.length > 0) {
    console.error(`Not writing ${OUT_PATH}: ${blocking.length} blocking problem(s)`);
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
