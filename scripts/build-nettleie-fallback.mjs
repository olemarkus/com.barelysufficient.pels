// Generates lib/price/nettleieFallbackData.generated.ts from the community
// "Fri Nettleie" dataset (https://github.com/kraftsystemet/fri-nettleie).
//
// This is a build-time/maintenance script, not shipped runtime code. It fetches
// the operator tariff YAMLs plus the Elhub GLN→organisasjonsnr reference table,
// resolves the tariff that is valid *today* per operator, and emits a compact,
// orgnr-keyed table of grid-tariff energy fees (øre/kWh, ex VAT). PELS uses that
// table as a last-resort static fallback when the NVE API is unreachable AND the
// user has nothing cached yet (see lib/price/staticGridTariffFallback.ts).
//
// Run with: npm run build:nettleie-fallback
//
// Source data licence: CC-BY-4.0 (Fri Nettleie / kraftsystemet.no). The Elhub
// reference data follows Elhub's terms. Attribution is carried into the
// generated file's header.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO = 'kraftsystemet/fri-nettleie';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const CONTENTS_API = `https://api.github.com/repos/${REPO}/contents/tariffer`;
const GRID_OWNERS_URL = `${RAW_BASE}/referanse-data/elhub/grid_owners.json`;

const OUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../lib/price/nettleieFallbackData.generated.ts',
);

// fri-nettleie kundegruppe → PELS `nettleie_tariffgruppe` setting value.
const KUNDEGRUPPE_TO_TARIFF_GROUP = {
  husholdning: 'Husholdning',
  fritid: 'Hytter og fritidshus',
};

const MONTH_NAME_TO_NUMBER = {
  januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, desember: 12,
};

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

// "6-21" → [6..21] (inclusive), "5" → [5]. Range upper bound is inclusive per
// the fri-nettleie spec ("16-21 gjelder fra 16:00 til 21:59:59").
const parseHourToken = (token) => {
  const text = String(token).trim();
  if (text.includes('-')) {
    const [fromRaw, toRaw] = text.split('-');
    const from = Number.parseInt(fromRaw, 10);
    const to = Number.parseInt(toRaw, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return [];
    const hours = [];
    for (let h = from; h <= to; h += 1) if (h >= 0 && h <= 23) hours.push(h);
    return hours;
  }
  const single = Number.parseInt(text, 10);
  return Number.isInteger(single) && single >= 0 && single <= 23 ? [single] : [];
};

// `timer` may be omitted (all hours), a single value, a span string, or a list
// of values/spans. Normalise to a sorted, de-duped explicit hour array.
const parseTimer = (timer) => {
  if (timer === undefined || timer === null) {
    return Array.from({ length: 24 }, (_, h) => h);
  }
  const tokens = Array.isArray(timer) ? timer : [timer];
  const hours = new Set();
  for (const token of tokens) for (const h of parseHourToken(token)) hours.add(h);
  return [...hours].sort((a, b) => a - b);
};

const parseMonths = (måneder) => {
  if (!Array.isArray(måneder) || måneder.length === 0) return undefined;
  const months = måneder
    .map((name) => MONTH_NAME_TO_NUMBER[String(name).trim().toLowerCase()])
    .filter((n) => Number.isInteger(n));
  return months.length > 0 ? months : undefined;
};

const parseDayTypes = (dager) => {
  if (!Array.isArray(dager) || dager.length === 0) return undefined;
  const tokens = dager.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
};

// Pick the tariff entry valid on `todayKey` (YYYY-MM-DD) for a given kundegruppe.
// gyldig_fra is inclusive, gyldig_til exclusive. Prefer the latest start date.
const resolveCurrentTariff = (tariffer, kundegruppe, todayKey) => {
  const candidates = (Array.isArray(tariffer) ? tariffer : [])
    .filter((t) => Array.isArray(t?.kundegrupper) && t.kundegrupper.includes(kundegruppe))
    .filter((t) => {
      // Normalise to YYYY-MM-DD so a future datetime form (e.g. "2026-01-01T00:00:00")
      // still compares correctly against the date-only todayKey.
      const from = t.gyldig_fra ? String(t.gyldig_fra).slice(0, 10) : undefined;
      const until = t.gyldig_til ? String(t.gyldig_til).slice(0, 10) : undefined;
      if (from && from > todayKey) return false;
      if (until && until <= todayKey) return false;
      return true;
    })
    .sort((a, b) => String(a.gyldig_fra ?? '').localeCompare(String(b.gyldig_fra ?? '')));
  return candidates.at(-1);
};

const buildExceptions = (energiledd) => {
  const unntak = Array.isArray(energiledd?.unntak) ? energiledd.unntak : [];
  const exceptions = [];
  for (const u of unntak) {
    const price = Number(u?.pris);
    if (!Number.isFinite(price)) continue;
    const exception = { hours: parseTimer(u.timer), price };
    const months = parseMonths(u.måneder);
    const dayTypes = parseDayTypes(u.dager);
    if (months) exception.months = months;
    if (dayTypes) exception.dayTypes = dayTypes;
    if (exception.hours.length > 0) exceptions.push(exception);
  }
  return exceptions;
};

const buildTariff = (energiledd) => {
  const basePrice = Number(energiledd?.grunnpris);
  if (!Number.isFinite(basePrice)) return undefined;
  return { basePrice, exceptions: buildExceptions(energiledd) };
};

const main = async () => {
  // Norwegian grid tariffs change on local calendar dates, so resolve "today" in
  // Europe/Oslo (not UTC) to avoid picking the wrong validity window when the
  // generator is run in the hour between Oslo midnight and UTC midnight.
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  console.log(`Building nettleie fallback table for ${todayKey} (Europe/Oslo)`);

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
  let skippedNoOrgnr = 0;
  let skippedNoTariff = 0;

  for (const file of files) {
    const raw = await fetchText(`${RAW_BASE}/tariffer/${file}`);
    let doc;
    try {
      doc = parseYaml(raw);
    } catch (error) {
      console.warn(`! ${file}: YAML parse failed (${error.message}); skipping`);
      continue;
    }
    const glnList = Array.isArray(doc?.gln) ? doc.gln.map(String) : [];
    const tariffer = doc?.tariffer;

    const tariffs = {};
    for (const [kundegruppe, groupKey] of Object.entries(KUNDEGRUPPE_TO_TARIFF_GROUP)) {
      const current = resolveCurrentTariff(tariffer, kundegruppe, todayKey);
      const tariff = current && buildTariff(current.energiledd);
      if (tariff) tariffs[groupKey] = tariff;
    }
    if (Object.keys(tariffs).length === 0) {
      skippedNoTariff += 1;
      continue;
    }

    const orgnrs = [...new Set(glnList.map((gln) => glnToOwner.get(gln)?.orgnr).filter(Boolean))];
    if (orgnrs.length === 0) {
      skippedNoOrgnr += 1;
      console.warn(`! ${file}: no orgnr resolved from GLN ${JSON.stringify(glnList)}; skipping`);
      continue;
    }
    const name = String(doc?.netteier ?? glnToOwner.get(glnList[0])?.name ?? file).trim();
    for (const orgnr of orgnrs) {
      byOrgnr[orgnr] = { name, tariffs };
    }
  }

  const operatorCount = Object.keys(byOrgnr).length;
  console.log(
    `Resolved ${operatorCount} orgnr entries `
    + `(skipped ${skippedNoOrgnr} without orgnr, ${skippedNoTariff} without a current tariff)`,
  );

  const sorted = Object.fromEntries(Object.entries(byOrgnr).sort(([a], [b]) => a.localeCompare(b)));
  // Collapse pure-number arrays (the hour lists) onto a single line for readability.
  const body = JSON.stringify(sorted, null, 2)
    .replace(/\[\n\s*((?:-?\d+(?:\.\d+)?,\n\s*)*-?\d+(?:\.\d+)?)\n\s*\]/g, (_match, inner) => (
      `[${inner.replace(/,\n\s*/g, ', ')}]`
    ));

  const header = `// AUTO-GENERATED by scripts/build-nettleie-fallback.mjs — DO NOT EDIT BY HAND.
// Run \`npm run build:nettleie-fallback\` to refresh.
//
// Static, last-resort fallback for Norwegian grid tariffs (nettleie), used only
// when the NVE API is unreachable and no live tariff has been cached yet.
//
// Generated: ${todayKey} | Operators: ${operatorCount}
// Source: Fri Nettleie (https://github.com/kraftsystemet/fri-nettleie), CC-BY-4.0.
// GLN→organisasjonsnr mapping from Elhub reference data.
//
// Prices are energy-fee (energiledd) in øre/kWh, EXCLUDING VAT and other taxes.
// 'hours' are the local hours-of-day the exception applies to; 'months' (1-12)
// and 'dayTypes' (fri-nettleie day tokens) narrow when it applies — omitted means
// "always". Resolution to a concrete day happens in staticGridTariffFallback.ts.
`;

  const ts = `${header}
export interface NettleieFallbackException {
  /** Local hours-of-day (0-23) the exception price applies to. */
  readonly hours: readonly number[];
  /** Months (1-12) the exception applies to; omitted means all months. */
  readonly months?: readonly number[];
  /** fri-nettleie day tokens (e.g. 'virkedag', 'helg'); omitted means all days. */
  readonly dayTypes?: readonly string[];
  /** Replacement energy fee in øre/kWh, ex VAT. */
  readonly price: number;
}

export interface NettleieFallbackTariff {
  /** Base energy fee in øre/kWh, ex VAT (applies when no exception matches). */
  readonly basePrice: number;
  readonly exceptions: readonly NettleieFallbackException[];
}

export type NettleieFallbackTariffGroup = 'Husholdning' | 'Hytter og fritidshus';

export interface NettleieFallbackOperator {
  readonly name: string;
  readonly tariffs: Partial<Record<NettleieFallbackTariffGroup, NettleieFallbackTariff>>;
}

export const NETTLEIE_FALLBACK_GENERATED_AT = '${todayKey}';

export const NETTLEIE_FALLBACK_BY_ORGNR: Readonly<Record<string, NettleieFallbackOperator>> = ${body};
`;

  await writeFile(OUT_PATH, ts, 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
