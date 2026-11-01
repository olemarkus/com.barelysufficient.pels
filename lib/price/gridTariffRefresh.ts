import { getDateKeyInTimeZone, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import { fetchGridTariffWithDateFallback } from './priceServiceUtils';
import {
  fetchAndNormalizeGridTariff,
  shouldUseGridTariffCache,
  type GridTariffEntryWithSource,
} from './gridTariffUtils';
import {
  asFallbackRows,
  buildFriNettleieGridTariffDays,
  friNettleieFileFor,
  resolveGridTariffFallback,
} from './gridTariffFallback';
import { fetchFriNettleieFile, readFriNettleieFile, readSavedFriNettleieFile } from './friNettleieFetch';
import type { PriceDataStore } from './priceDataStore';
import type { PriceServiceLoggingSinks } from './priceServiceLoggingSinks';

const GRID_TARIFF_FAILURE_REASONS: Record<'keepCache' | 'clearStaleFallback' | 'noData', string> = {
  keepCache: 'Keeping cached tariff data (no live tariff)',
  clearStaleFallback: 'Cleared stale fallback (no live tariff, no saved tariff for current operator)',
  noData: 'No live tariff and no saved tariff for this operator',
};

/** The grid company whose tariff a refresh fetches, and where it is billed. */
export type GridTariffRequest = {
  countyCode: string;
  organizationNumber: string;
  tariffGroup: string;
};

type GridTariffStore = Pick<
  PriceDataStore, 'readNettleie' | 'writeNettleie' | 'readFriNettleieFile' | 'writeFriNettleieFile'
>;

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
 * A company Fri Nettleie covers is fetched from there, with its dated periods,
 * and the file is saved. While it cannot be fetched, the saved file prices each
 * day on its own day type and period. NVE serves stale rates for many
 * companies after a mid-year change, so it is asked only for a company Fri
 * Nettleie does not cover, or one with no saved file yet. From NVE, tomorrow is
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

  // No live tariff: keep real cached data that covers today; otherwise store the
  // rows the saved Fri Nettleie file prices today and tomorrow on, so prices
  // still follow the tariff until the source recovers (see
  // `resolveGridTariffFallback`). They are flagged so they never suppress the
  // next live attempt (see `shouldUseGridTariffCache`).
  const settleWithoutLiveTariff = (
    failure: Record<string, unknown>,
    saved: { rows: GridTariffEntryWithSource[]; fetchedAt: string } | null,
  ): GridTariffRefreshOutcome => {
    // Read the stored tariff again: a refresh that overlapped this one may have
    // stored a live tariff for today while this one waited on its fetch, and a
    // stale read would let this fallback replace it.
    const current = store.readNettleie() as Array<Record<string, unknown> & StoredGridTariffRow> | null;
    const outcome = resolveGridTariffFallback(current, saved?.rows ?? null, todayDate, timeZone);
    if (outcome.kind === 'store') {
      const fallbackContext = ` (saved Fri Nettleie file, fetched ${saved?.fetchedAt ?? 'earlier'}; no live tariff)`;
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

  // The saved file's rows for today and tomorrow, when it is this company's.
  const savedFileRows = (file: string): { rows: GridTariffEntryWithSource[]; fetchedAt: string } | null => {
    const saved = readSavedFriNettleieFile(store.readFriNettleieFile());
    if (saved?.organizationNumber !== request.organizationNumber || saved.file !== file) return null;
    const read = readFriNettleieFile(saved.text, today);
    const rows = read.kind === 'tariffs'
      ? buildFriNettleieGridTariffDays(read.tariffs, request.tariffGroup, todayDate, timeZone)
      : null;
    return rows ? { rows: asFallbackRows(rows), fetchedAt: saved.fetchedAt } : null;
  };

  // The company's Fri Nettleie file, live or else as saved; `null` when there
  // is neither, so NVE is asked.
  const refreshFromFriNettleie = async (friNettleieFile: string): Promise<GridTariffRefreshOutcome | null> => {
    const fetched = await fetchFriNettleieFile(friNettleieFile, today);
    const rows = fetched.kind === 'tariffs'
      ? buildFriNettleieGridTariffDays(fetched.tariffs, request.tariffGroup, todayDate, timeZone)
      : null;
    if (fetched.kind === 'tariffs' && rows) {
      const outcome = storeGridTariff(
        rows, ` (Fri Nettleie ${friNettleieFile})`, request, readCurrentCompany, store, sinks,
      );
      if (outcome === 'rebuild') {
        store.writeFriNettleieFile({
          organizationNumber: request.organizationNumber,
          file: friNettleieFile,
          text: fetched.text,
          fetchedAt: todayDate.toISOString(),
        });
      }
      return outcome;
    }
    const failure = {
      source: 'fri-nettleie',
      file: friNettleieFile,
      reason: fetched.kind === 'unavailable' ? fetched.reason : 'no period covers today',
    };
    const saved = savedFileRows(friNettleieFile);
    if (saved) return settleWithoutLiveTariff(failure, saved);
    // Nothing saved yet, as on a new install: NVE serves something meanwhile.
    sinks.structuredLog.info({ event: 'grid_tariff_fri_nettleie_unavailable', ...failure });
    return null;
  };

  const friNettleieFile = friNettleieFileFor(request.organizationNumber);
  const fromFriNettleie = friNettleieFile === undefined ? null : await refreshFromFriNettleie(friNettleieFile);
  if (fromFriNettleie) return fromFriNettleie;

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

  return settleWithoutLiveTariff({ source: 'nve', attempts }, null);
};
