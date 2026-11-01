// Checks that PELS's grid tariff sources still cover the grid company list.
//
// - The bundled file map (lib/price/friNettleieFiles.generated.ts) matches
//   what Fri Nettleie publishes today, and every published file reads with
//   the runtime's parser (`npm run build:fri-nettleie-files -- --check`).
// - Every grid company in the settings list, and every retired one an owner may
//   have saved, gets a tariff: from its Fri Nettleie file, or else from NVE.
//   One that gets neither has usually merged into another company: list it as
//   retired, with its successor's file in scripts/build-fri-nettleie-files.mjs.
//   A company priced from NVE is listed: Fri Nettleie may cover it under
//   another GLN.
//
// Exits 1 when any check needs attention. `npm run release -- start` runs it
// and stops on a failure, since the map ships with the build.
//
// Run with: npm run check:grid-tariffs

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TIME_ZONE = 'Europe/Oslo';
const TARIFF_GROUP = 'Husholdning';

const loadModules = async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { buildFriNettleieGridTariffDays, friNettleieFileFor } from './lib/price/gridTariffFallback';",
        "export { fetchFriNettleieFile } from './lib/price/friNettleieFetch';",
        "export { buildGridTariffUrl, normalizeGridTariffData } from './lib/price/gridTariffUtils';",
        "export { gridCompanies, retiredGridCompanies } from './packages/settings-ui/src/ui/gridCompanies';",
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, logLevel: 'silent',
  });
  // Under node_modules so the bundle's package imports resolve.
  const bundlePath = path.resolve('node_modules/.cache/pels/check-grid-tariffs.mjs');
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, result.outputFiles[0].text);
  return import(pathToFileURL(bundlePath).href);
};

const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());

const nveServes = async (modules, company, date) => {
  const url = modules.buildGridTariffUrl({
    date, tariffGroup: TARIFF_GROUP, countyCode: company.countyCodes[0], organizationNumber: company.organizationNumber,
  });
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`NVE ${response.status} for ${company.organizationNumber} on ${date}`);
  const data = await response.json();
  return Array.isArray(data) && modules.normalizeGridTariffData(data, date).length > 0;
};

const checkTable = () => {
  const run = spawnSync(process.execPath, ['scripts/build-fri-nettleie-files.mjs', '--check'], { encoding: 'utf8' });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  return run.status === 0 ? [] : ['Fri Nettleie file map: run npm run build:fri-nettleie-files'];
};

const checkCompanies = async (modules) => {
  const date = todayKey();
  const findings = [];
  const fromNve = [];
  const companies = [...modules.gridCompanies, ...modules.retiredGridCompanies];
  for (const company of companies) {
    const file = modules.friNettleieFileFor(company.organizationNumber);
    if (file !== undefined) {
      const fetched = await modules.fetchFriNettleieFile(file, date);
      const today = fetched.kind === 'tariffs'
        && modules.buildFriNettleieGridTariffDays(fetched.tariffs, TARIFF_GROUP, new Date(), TIME_ZONE);
      if (today) continue;
      const reason = fetched.kind === 'tariffs' ? 'has no period covering today' : fetched.reason;
      findings.push(`${company.name}: Fri Nettleie ${file} ${reason}`);
    } else if (await nveServes(modules, company, date)) {
      fromNve.push(company.name);
    } else {
      findings.push(`${company.name} (${company.organizationNumber}): no tariff from Fri Nettleie or NVE on ${date}`);
    }
  }
  console.log(`Grid companies: ${companies.length}, priced from NVE: ${fromNve.length}`
    + (fromNve.length > 0 ? ` (${fromNve.join(', ')})` : ''));
  return findings;
};

const modules = await loadModules();
const findings = [...checkTable(), ...await checkCompanies(modules)];
if (findings.length > 0) {
  console.log('\nNeeds attention:');
  for (const finding of findings) console.log(`- ${finding}`);
  process.exitCode = 1;
}
