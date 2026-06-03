export type GridTariffSettings = {
  countyCode: string;
  organizationNumber: string;
  tariffGroup: string;
};

// Marks `nettleie_data` entries produced by the static fallback rather than the
// NVE API, so the cache layer can tell a real fetch from a stopgap.
export const GRID_TARIFF_SOURCE_FALLBACK = 'fallback' as const;

export type GridTariffEntryWithSource = {
  time: number;
  energyFeeExVat: number;
  energyFeeIncVat: number;
  fixedFeeExVat: number;
  fixedFeeIncVat: number;
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
  logDebug: (...args: unknown[]) => void,
): boolean => {
  // Fallback data serves prices but must not suppress NVE retries — keep trying
  // the API every cycle until a real tariff comes back.
  if (isGridTariffFallbackData(existingData)) return false;
  if (existingData && Array.isArray(existingData) && existingData.length > 0) {
    const firstEntry = existingData[0];
    const dateKey = typeof firstEntry?.dateKey === 'string' ? firstEntry.dateKey : firstEntry?.datoId;
    if (dateKey?.startsWith(today)) {
      logDebug(`Grid tariff: Using cached data for ${today} (${existingData.length} entries)`);
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
    const data = await response.json() as unknown;
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

export const normalizeGridTariffData = (data: Array<Record<string, unknown>>): Array<Record<string, unknown>> => (
  data.map((entry) => ({
    time: entry.time,
    energyFeeExVat: entry.energileddEks,
    energyFeeIncVat: entry.energileddInk,
    fixedFeeExVat: entry.fastleddEks,
    fixedFeeIncVat: entry.fastleddInk,
    dateKey: entry.datoId,
  }))
);

export const fetchAndNormalizeGridTariff = async (params: {
  date: string;
  settings: GridTariffSettings;
  log: (...args: unknown[]) => void;
  errorLog?: (...args: unknown[]) => void;
}): Promise<Array<Record<string, unknown>> | null> => {
  const { date, settings, log, errorLog } = params;
  const url = buildGridTariffUrl({
    date,
    countyCode: settings.countyCode,
    organizationNumber: settings.organizationNumber,
    tariffGroup: settings.tariffGroup,
  });
  log(
    `Grid tariff: Fetching NVE tariffs for ${date}, `
    + `county=${settings.countyCode}, org=${settings.organizationNumber}`,
  );
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
