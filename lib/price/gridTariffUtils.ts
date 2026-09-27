import type { StructuredDebugEmitter } from '../logging/logger';

export type GridTariffSettings = {
  countyCode: string;
  organizationNumber: string;
  tariffGroup: string;
};

// Marks cached grid-tariff entries produced by the static fallback rather than the
// NVE API, so the cache layer can tell a real fetch from a stopgap.
export const GRID_TARIFF_SOURCE_FALLBACK = 'fallback' as const;

export type GridTariffEntryWithSource = {
  time: number;
  energyFeeExVat: number;
  energyFeeIncVat: number;
  dateKey: string;
  source: typeof GRID_TARIFF_SOURCE_FALLBACK;
};

// True when the cached tariff data was written by the static fallback (i.e. NVE
// was unreachable and nothing real was cached). Such data must never block a
// fresh NVE attempt, nor count as a "real" cache worth preserving.
export const isGridTariffFallbackData = (
  existingData: Array<{ source?: unknown }> | null,
): boolean => (
  Array.isArray(existingData)
  && existingData.length > 0
  && existingData[0]?.source === GRID_TARIFF_SOURCE_FALLBACK
);

export const shouldUseGridTariffCache = (
  existingData: Array<{ dateKey?: string; datoId?: string; source?: unknown }> | null,
  today: string,
  debugStructured: StructuredDebugEmitter,
): boolean => {
  // Fallback data serves prices but must not suppress NVE retries — keep trying
  // the API every cycle until a real tariff comes back.
  if (isGridTariffFallbackData(existingData)) return false;
  if (existingData && Array.isArray(existingData) && existingData.length > 0) {
    const firstEntry = existingData[0];
    const dateKey = typeof firstEntry?.dateKey === 'string' ? firstEntry.dateKey : firstEntry?.datoId;
    if (dateKey?.startsWith(today)) {
      debugStructured({ event: 'grid_tariff_cache_used', date: today, entryCount: existingData.length });
      return true;
    }
  }
  return false;
};

export const buildGridTariffUrl = (params: {
  date: string;
  tariffGroup: string;
  countyCode: string;
  organizationNumber: string;
}): string => {
  const baseUrl = 'https://nettleietariffer.dataplattform.nve.no/v1/'
    + 'NettleiePerOmradePrTimeHusholdningFritidEffekttariffer';
  const search = new URLSearchParams({
    ValgtDato: params.date,
    Tariffgruppe: params.tariffGroup,
    FylkeNr: params.countyCode,
    OrganisasjonsNr: params.organizationNumber,
  });
  return `${baseUrl}?${search.toString()}`;
};

export const fetchGridTariffData = async (
  url: string,
  errorLog?: (...args: unknown[]) => void,
): Promise<Array<Record<string, unknown>> | null> => {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`NVE API returned ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      errorLog?.('Grid tariff: Unexpected response format from NVE API');
      return null;
    }
    return data as Array<Record<string, unknown>>;
  } catch (error) {
    errorLog?.('Grid tariff: Failed to fetch NVE tariffs', error);
    return null;
  }
};

const hasEnergyFee = (entry: Record<string, unknown>): boolean => (
  [entry.energyFeeExVat, entry.energyFeeIncVat, entry.energileddEks, entry.energileddInk]
    .some((fee) => typeof fee === 'number' && Number.isFinite(fee))
);

/**
 * One tariff entry per hour: the last one that carries an energy fee, or the
 * last one given when none does. NVE answers with one row per hour per capacity
 * step, and the energy fee does not depend on the step, so a day came back as
 * 360 rows carrying 24 prices. Only the energy fee per hour is read, by
 * `buildGridTariffByHour`, which lets the last row of an hour with a fee win;
 * keeping that row changes no price and drops the rest.
 */
export const oneGridTariffEntryPerHour = (
  entries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
  const byHour = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const hour = String(entry.time);
    const held = byHour.get(hour);
    if (held === undefined || hasEnergyFee(entry) || !hasEnergyFee(held)) byHour.set(hour, entry);
  }
  return [...byHour.values()];
};

/**
 * The NVE rows in the shape the price module stores. The fixed fee is per
 * capacity step and nothing reads it, so it is not carried once the rows are
 * one per hour.
 */
export const normalizeGridTariffData = (data: Array<Record<string, unknown>>): Array<Record<string, unknown>> => (
  oneGridTariffEntryPerHour(data.map((entry) => ({
    time: entry.time,
    energyFeeExVat: entry.energileddEks,
    energyFeeIncVat: entry.energileddInk,
    dateKey: entry.datoId,
  })))
);

export const fetchAndNormalizeGridTariff = async (params: {
  date: string;
  settings: GridTariffSettings;
  structuredInfo: StructuredDebugEmitter;
  errorLog?: (...args: unknown[]) => void;
}): Promise<Array<Record<string, unknown>> | null> => {
  const { date, settings, structuredInfo, errorLog } = params;
  const url = buildGridTariffUrl({
    date,
    countyCode: settings.countyCode,
    organizationNumber: settings.organizationNumber,
    tariffGroup: settings.tariffGroup,
  });
  structuredInfo({
    event: 'grid_tariff_fetch_started',
    date,
    countyCode: settings.countyCode,
    organizationNumber: settings.organizationNumber,
  });
  const gridTariffData = await fetchGridTariffData(url, errorLog);
  if (!gridTariffData) return null;
  const normalized = normalizeGridTariffData(gridTariffData);
  if (normalized.length === 0) {
    errorLog?.(
      'Grid tariff: NVE API returned 0 hourly tariff entries',
      {
        date,
        countyCode: settings.countyCode,
        organizationNumber: settings.organizationNumber,
        tariffGroup: settings.tariffGroup,
      },
    );
    return null;
  }
  return normalized;
};
