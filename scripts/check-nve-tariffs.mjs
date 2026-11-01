// Checks that PELS's grid tariff workarounds still match what NVE serves.
//
// - Each correction in lib/price/nveTariffCorrections.ts runs against NVE's
//   tariff for the next 7 days; one that changes none of them is no longer
//   needed and should be removed.
// - The static fallback (lib/price/nettleieFallbackData.generated.ts) should be
//   regenerated with `npm run build:nettleie-fallback` once it is 60 days old.
// - Every grid company in the settings list should still get a tariff from
//   NVE; one that gets none has usually merged into another company.
//
// Exits 1 when any check needs attention. Runs weekly in
// .github/workflows/nve-tariffs.yml.
//
// Run with: npm run check:nve-tariffs

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const DAYS_PROBED = 7;
const FALLBACK_MAX_AGE_DAYS = 60;
const TIME_ZONE = 'Europe/Oslo';
const TARIFF_GROUP = 'Husholdning';

const loadModules = async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { correctNveGridTariffDay, NVE_CORRECTED_ORGANIZATION_NUMBERS } from './lib/price/nveTariffCorrections';",
        "export { buildGridTariffUrl, normalizeGridTariffData } from './lib/price/gridTariffUtils';",
        "export { NETTLEIE_FALLBACK_GENERATED_AT } from './lib/price/nettleieFallbackData.generated';",
        "export { gridCompanies } from './packages/settings-ui/src/ui/gridCompanies';",
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, logLevel: 'silent',
  });
  // Under node_modules so the bundle's package imports resolve.
  const bundlePath = path.resolve('node_modules/.cache/pels/check-nve-tariffs.mjs');
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, result.outputFiles[0].text);
  return import(pathToFileURL(bundlePath).href);
};

const localDateKey = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE })
  .format(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));

const fetchNveDay = async (modules, organizationNumber, countyCode, date) => {
  const url = modules.buildGridTariffUrl({ date, tariffGroup: TARIFF_GROUP, countyCode, organizationNumber });
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`NVE ${response.status} for ${organizationNumber} on ${date}`);
  const data = await response.json();
  return Array.isArray(data) ? modules.normalizeGridTariffData(data, date) : [];
};

const companyByOrganizationNumber = (modules) => new Map(
  modules.gridCompanies.map((company) => [company.organizationNumber, company]),
);

const checkCorrections = async (modules) => {
  const companies = companyByOrganizationNumber(modules);
  const findings = [];
  for (const organizationNumber of modules.NVE_CORRECTED_ORGANIZATION_NUMBERS) {
    const company = companies.get(organizationNumber);
    if (!company) {
      findings.push(`${organizationNumber}: corrected, but not in the grid company list`);
      continue;
    }
    let corrects = false;
    for (let offset = 0; offset < DAYS_PROBED && !corrects; offset += 1) {
      const date = localDateKey(offset);
      const rows = await fetchNveDay(modules, organizationNumber, company.countyCodes[0], date);
      corrects = rows.length > 0
        && !isDeepStrictEqual(modules.correctNveGridTariffDay(rows, organizationNumber, date), rows);
    }
    const status = corrects ? 'still corrects what NVE serves' : 'changes nothing NVE serves: remove it';
    console.log(`${company.name}: correction ${status}`);
    if (!corrects) findings.push(`${company.name}: remove its correction from lib/price/nveTariffCorrections.ts`);
  }
  return findings;
};

const checkFallbackAge = (modules) => {
  const ageDays = Math.floor((Date.now() - Date.parse(modules.NETTLEIE_FALLBACK_GENERATED_AT)) / 86_400_000);
  console.log(`Static fallback generated ${modules.NETTLEIE_FALLBACK_GENERATED_AT} (${ageDays} days ago)`);
  return ageDays > FALLBACK_MAX_AGE_DAYS
    ? [`Static fallback is ${ageDays} days old: run npm run build:nettleie-fallback`]
    : [];
};

const checkCompaniesServed = async (modules) => {
  const date = localDateKey(0);
  const findings = [];
  for (const company of modules.gridCompanies) {
    const rows = await fetchNveDay(modules, company.organizationNumber, company.countyCodes[0], date);
    if (rows.length === 0) {
      findings.push(`${company.name} (${company.organizationNumber}): NVE serves no tariff on ${date}`);
    }
  }
  console.log(`Grid companies NVE serves today: ${modules.gridCompanies.length - findings.length}`
    + ` of ${modules.gridCompanies.length}`);
  return findings;
};

const modules = await loadModules();
const findings = [
  ...await checkCorrections(modules),
  ...checkFallbackAge(modules),
  ...await checkCompaniesServed(modules),
];
if (findings.length > 0) {
  console.log('\nNeeds attention:');
  for (const finding of findings) console.log(`- ${finding}`);
  process.exitCode = 1;
}
