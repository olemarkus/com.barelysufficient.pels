import { getDateKeyInTimeZone } from '../../packages/shared-domain/src/utils/dateUtils';
import { fetchGridTariffWithDateFallback } from './priceServiceUtils';
import { shouldUseGridTariffCache } from './gridTariffUtils';
import { NETTLEIE_FALLBACK_GENERATED_AT, resolveGridTariffFallback } from './staticGridTariffFallback';
import type { PriceDataStore } from './priceDataStore';
import type { PriceServiceLoggingSinks } from './priceServiceLoggingSinks';

const GRID_TARIFF_FAILURE_REASONS: Record<'keepCache' | 'clearStaleFallback' | 'noData', string> = {
  keepCache: 'Keeping cached tariff data (NVE returned empty list)',
  clearStaleFallback: 'Cleared stale fallback (NVE unavailable, no static fallback for current operator)',
  noData: 'NVE unavailable and no static fallback for this operator',
};

/** The grid company whose tariff a refresh fetches, and where it is billed. */
export type GridTariffRequest = {
  countyCode: string;
  organizationNumber: string;
  tariffGroup: string;
};

type GridTariffStore = Pick<PriceDataStore, 'readNettleie' | 'writeNettleie'>;

/** Whether the combined prices need rebuilding on the stored tariff. */
export type GridTariffRefreshOutcome = 'rebuild' | 'unchanged';

const storeGridTariff = (
  data: Array<Record<string, unknown>>,
  logContext: string,
  request: GridTariffRequest,
  readCurrentCompany: () => string | null,
  store: GridTariffStore,
  sinks: PriceServiceLoggingSinks,
): GridTariffRefreshOutcome => {
  // The owner chose another grid company, or cleared it, while NVE answered:
  // this tariff is not theirs, and the refresh their change started stores
  // the right one.
  if (readCurrentCompany() !== request.organizationNumber) return 'unchanged';
  store.writeNettleie(data);
  sinks.structuredLog?.info({ event: 'grid_tariff_stored', entryCount: data.length, context: logContext });
  return 'rebuild';
};

/**
 * Fetch the grid company's tariff from NVE, or keep the cached one while it
 * still covers today. When every NVE attempt fails, keep real cached data;
 * with nothing cached, seed the static fallback so prices still work until NVE
 * recovers. The fallback is flagged so it never suppresses the next NVE retry
 * (see `shouldUseGridTariffCache`).
 */
export const refreshGridTariff = async (
  request: GridTariffRequest,
  readCurrentCompany: () => string | null,
  store: GridTariffStore,
  timeZone: string,
  sinks: PriceServiceLoggingSinks,
  forceRefresh: boolean,
): Promise<GridTariffRefreshOutcome> => {
  const todayDate = new Date();
  const today = getDateKeyInTimeZone(todayDate, timeZone);
  const existingData = store.readNettleie() as
    Array<{ dateKey?: string; datoId?: string; source?: unknown }> | null;
  if (!forceRefresh && shouldUseGridTariffCache(existingData, today, sinks.debugStructured)) return 'rebuild';

  const { data, attempts, logContext } = await fetchGridTariffWithDateFallback({
    settings: request,
    todayDate,
    timeZone,
    structuredInfo: (payload) => sinks.structuredLog?.info(payload),
    errorLog: sinks.errorLog,
  });
  if (data) return storeGridTariff(data, logContext, request, readCurrentCompany, store, sinks);

  const outcome = resolveGridTariffFallback({
    existingData,
    organizationNumber: request.organizationNumber,
    tariffGroup: request.tariffGroup,
    date: todayDate,
    timeZone,
  });
  if (outcome.kind === 'store') {
    const fallbackContext = ' (static fallback — NVE unavailable, no cached tariff; '
      + `snapshot ${NETTLEIE_FALLBACK_GENERATED_AT})`;
    return storeGridTariff(outcome.entries, fallbackContext, request, readCurrentCompany, store, sinks);
  }
  // Fallback already matches today; recompute combined prices in memory but
  // skip the redundant cache write while NVE stays down.
  if (outcome.kind === 'fallbackCurrent') return 'rebuild';
  sinks.errorLog?.(`Grid tariff: ${GRID_TARIFF_FAILURE_REASONS[outcome.kind]}`, { attempts, ...request });
  if (outcome.kind !== 'clearStaleFallback') return 'unchanged';
  // The cached data is a stale fallback for an operator we can no longer
  // serve (e.g. the org number changed). Clear it so combined prices don't
  // keep using another operator's tariff.
  store.writeNettleie([]);
  return 'rebuild';
};
