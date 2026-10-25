import { getDateKeyInTimeZone, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import { fetchGridTariffWithDateFallback } from './priceServiceUtils';
import { fetchAndNormalizeGridTariff, shouldUseGridTariffCache } from './gridTariffUtils';
import { NETTLEIE_FALLBACK_GENERATED_AT, resolveGridTariffFallback } from './staticGridTariffFallback';
import { correctNveGridTariffDay } from './nveTariffCorrections';
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

type StoredGridTariffRow = { dateKey?: string; datoId?: string; source?: unknown };

const rowsDated = <Row extends StoredGridTariffRow>(rows: Row[] | null, dateKey: string): Row[] => (
  (rows ?? []).filter((row) => (
    row.source === undefined
    && (typeof row.dateKey === 'string' ? row.dateKey : row.datoId)?.startsWith(dateKey)
  ))
);

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
  sinks.structuredLog.info({ event: 'grid_tariff_stored', entryCount: data.length, context: logContext });
  return 'rebuild';
};

/**
 * Fetch the grid company's tariff for today and tomorrow from NVE, or keep the
 * cached one while it still covers both: tomorrow's spot prices are priced on
 * tomorrow's tariff, which differs from today's across a weekend. Tomorrow is
 * asked for once, with no earlier-date fallback; without it, tomorrow is priced
 * on today's tariff. When every NVE attempt for today fails, keep real cached data;
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
  const tomorrow = shiftDateKey(today, 1);
  const existingData = store.readNettleie() as
    Array<Record<string, unknown> & StoredGridTariffRow> | null;
  if (!forceRefresh && shouldUseGridTariffCache(existingData, { today, tomorrow })) return 'rebuild';

  const { data, attempts, logContext } = await fetchGridTariffWithDateFallback({
    settings: request,
    todayDate,
    timeZone,
    structuredInfo: (payload) => sinks.structuredLog.info(payload),
    errorLog: sinks.errorLog,
  });
  if (data) {
    const tomorrowData = await fetchAndNormalizeGridTariff({
      date: tomorrow,
      settings: request,
      structuredInfo: (payload) => sinks.structuredLog.info(payload),
      errorLog: sinks.errorLog,
    });
    // NVE's own answer for today is corrected like any day's. An earlier day's
    // tariff, served when NVE had nothing for today, stands in for today as it
    // is: correcting it for its own weekday would price today on the wrong day
    // type. It loses to a real tariff already cached for today, unless the
    // refresh was forced, which a change of grid company does.
    const fetchedForToday = attempts.at(-1)?.date === today;
    const cachedToday = fetchedForToday || forceRefresh ? [] : rowsDated(existingData, today);
    const standInRows = cachedToday.length > 0 ? cachedToday : data;
    const todayRows = fetchedForToday
      ? correctNveGridTariffDay(data, request.organizationNumber, today)
      : standInRows;
    const tomorrowRows = tomorrowData
      ? correctNveGridTariffDay(tomorrowData, request.organizationNumber, tomorrow)
      : [];
    return storeGridTariff([...todayRows, ...tomorrowRows], logContext, request, readCurrentCompany, store, sinks);
  }

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
