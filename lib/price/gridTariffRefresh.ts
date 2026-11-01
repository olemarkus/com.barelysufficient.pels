import { getDateKeyInTimeZone, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import { fetchGridTariffWithDateFallback } from './priceServiceUtils';
import { fetchAndNormalizeGridTariff, shouldUseGridTariffCache } from './gridTariffUtils';
import {
  NETTLEIE_FALLBACK_GENERATED_AT,
  buildFriNettleieGridTariffDays,
  friNettleieFileFor,
  resolveGridTariffFallback,
} from './staticGridTariffFallback';
import { fetchFriNettleieTariffs } from './friNettleieFetch';
import type { PriceDataStore } from './priceDataStore';
import type { PriceServiceLoggingSinks } from './priceServiceLoggingSinks';

const GRID_TARIFF_FAILURE_REASONS: Record<'keepCache' | 'clearStaleFallback' | 'noData', string> = {
  keepCache: 'Keeping cached tariff data (no live tariff)',
  clearStaleFallback: 'Cleared stale fallback (no live tariff, no static fallback for current operator)',
  noData: 'No live tariff and no static fallback for this operator',
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
  // The owner chose another grid company, or cleared it, while the source answered:
  // this tariff is not theirs, and the refresh their change started stores
  // the right one.
  if (readCurrentCompany() !== request.organizationNumber) return 'unchanged';
  store.writeNettleie(data);
  sinks.structuredLog.info({ event: 'grid_tariff_stored', entryCount: data.length, context: logContext });
  return 'rebuild';
};

/**
 * Fetch the grid company's tariff for today and tomorrow, or keep the cached
 * one while it still covers both: tomorrow's spot prices are priced on
 * tomorrow's tariff, which differs from today's across a weekend or a tariff
 * change.
 *
 * A company Fri Nettleie covers is fetched from there, with its dated periods;
 * NVE serves stale rates for many companies after a mid-year change, so it is
 * asked only for a company Fri Nettleie does not cover. From NVE, tomorrow is
 * asked for once, with no earlier-date fallback; without it, tomorrow is priced
 * on today's tariff.
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

  // No live tariff: keep real cached data that covers today; otherwise seed the
  // bundled snapshot so prices still work until the source recovers (see
  // `resolveGridTariffFallback`). The snapshot is flagged so it never
  // suppresses the next live attempt (see `shouldUseGridTariffCache`).
  const settleWithoutLiveTariff = (failure: Record<string, unknown>): GridTariffRefreshOutcome => {
    const outcome = resolveGridTariffFallback({
      existingData,
      organizationNumber: request.organizationNumber,
      tariffGroup: request.tariffGroup,
      date: todayDate,
      timeZone,
    });
    if (outcome.kind === 'store') {
      const fallbackContext = ' (static fallback — no live tariff, no cached tariff for today; '
        + `snapshot ${NETTLEIE_FALLBACK_GENERATED_AT})`;
      return storeGridTariff(outcome.entries, fallbackContext, request, readCurrentCompany, store, sinks);
    }
    // Fallback already matches today; recompute combined prices in memory but
    // skip the redundant cache write while the source stays down.
    if (outcome.kind === 'fallbackCurrent') return 'rebuild';
    sinks.errorLog?.(`Grid tariff: ${GRID_TARIFF_FAILURE_REASONS[outcome.kind]}`, { ...failure, ...request });
    if (outcome.kind !== 'clearStaleFallback') return 'unchanged';
    // The cached data is a stale fallback for an operator we can no longer
    // serve (e.g. the org number changed). Clear it so combined prices don't
    // keep using another operator's tariff.
    store.writeNettleie([]);
    return 'rebuild';
  };

  const friNettleieFile = friNettleieFileFor(request.organizationNumber);
  if (friNettleieFile !== undefined) {
    const fetched = await fetchFriNettleieTariffs(friNettleieFile, today);
    const rows = fetched.kind === 'tariffs'
      ? buildFriNettleieGridTariffDays(fetched.tariffs, request.tariffGroup, todayDate, timeZone)
      : null;
    if (rows) {
      return storeGridTariff(rows, ` (Fri Nettleie ${friNettleieFile})`, request, readCurrentCompany, store, sinks);
    }
    const reason = fetched.kind === 'unavailable' ? fetched.reason : 'no period covers today';
    return settleWithoutLiveTariff({ source: 'fri-nettleie', file: friNettleieFile, reason });
  }

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
    // An earlier day's tariff, served when NVE had nothing for today, stands in
    // for today. It loses to a real tariff already cached for today, unless the
    // refresh was forced, which a change of grid company does.
    const fetchedForToday = attempts.at(-1)?.date === today;
    const cachedToday = fetchedForToday || forceRefresh ? [] : rowsDated(existingData, today);
    const todayRows = !fetchedForToday && cachedToday.length > 0 ? cachedToday : data;
    const rows = [...todayRows, ...(tomorrowData ?? [])];
    return storeGridTariff(rows, logContext, request, readCurrentCompany, store, sinks);
  }

  return settleWithoutLiveTariff({ source: 'nve', attempts });
};
