/**
 * Everything the Power by the Hour price source needs, behind one door.
 *
 * Pricing a home from that app takes three decisions and they are only ever
 * made together: which of its price devices this home is priced from, what one
 * read of the app turns into for the two day payloads PELS stores, and what to
 * tell the owner when any of it produces nothing. Composing them here keeps
 * `PriceService` holding one collaborator for this scheme rather than the
 * pieces it is made of — the same shape `homeyScheme.ts` has.
 *
 * The transport and its whole classification live next door in
 * `powerhourPriceFetch.ts`; this module never sees a thrown call or a raw body.
 */

import { getDateKeyInTimeZone, shiftDateKey } from '../utils/dateUtils';
import {
  buildFlowEntries,
  buildPricesByHourFromPeriods,
  DEFAULT_PERIOD_MINUTES,
  getFlowPricePayload,
  type FlowPricePayload,
  type FlowPricePeriod,
} from '../../packages/shared-domain/src/price/flowPriceUtils';
import { readPowerhourDeviceIdSetting } from '../../packages/shared-domain/src/settings/priceScheme';

import type {
  PowerhourDeviceUiOption,
  PowerhourSourceUiStatus,
} from '../../packages/contracts/src/settingsUiApi';
import type { ApiPort, SettingsPort } from '../ports/homeyRuntime';
import { POWERHOUR_DEVICE_ID } from '../utils/settingsKeys';
import { toHourlyPeriods } from './hourlyPriceProjection';
import {
  fetchPowerhourPrices,
  type PowerhourDevice,
  type PowerhourRead,
  type PowerhourUnavailableReason,
} from './powerhourPriceFetch';

/**
 * Which device prices this home.
 *
 * `selected` when the owner's choice is present, and when there is exactly one
 * device and therefore nothing to choose — a single-device home should not have
 * to answer a question with one possible answer before it gets prices. Two
 * devices and no choice is `device_missing` with an empty id: the source cannot
 * guess which zone the owner meant, and guessing would price the home from
 * whichever one the app happened to list first.
 */
export type PowerhourDeviceResolution =
  | { kind: 'selected'; device: PowerhourDevice }
  | { kind: 'no_devices' }
  | { kind: 'device_missing'; deviceId: string }
  /** The owner's choice could not be read; this pass decides nothing. */
  | { kind: 'unreadable' };

/**
 * The owner's choice, as the runtime could read it. `unreadable` is the state
 * that earns the type: told apart from `unchosen`, a settings read that did not
 * come back would report a choice the owner DID make as un-made, stop the
 * refresh, and say "No device chosen" on the settings page.
 */
export type PowerhourDeviceChoice =
  | { kind: 'chosen'; deviceId: string }
  | { kind: 'unchosen' }
  | { kind: 'unreadable' };

/**
 * The runtime's half of the `powerhour_device_id` policy. The bytes are owned
 * by `packages/shared-domain/src/settings/priceScheme.ts`, which deliberately
 * does NOT answer absence — that answer needs `getKeys()`, which only this side
 * of the bridge can ask.
 */
export const readPowerhourDeviceChoice = (settings: SettingsPort): PowerhourDeviceChoice => {
  const raw = settings.get(POWERHOUR_DEVICE_ID);
  const deviceId = readPowerhourDeviceIdSetting(raw);
  if (deviceId !== null) return { kind: 'chosen', deviceId };
  // A stored empty string is the choice cleared on purpose, not a failed read.
  if (typeof raw === 'string') return { kind: 'unchosen' };
  return settings.getKeys().includes(POWERHOUR_DEVICE_ID)
    ? { kind: 'unreadable' }
    : { kind: 'unchosen' };
};

export const resolvePowerhourDevice = (
  devices: PowerhourDevice[],
  choice: PowerhourDeviceChoice,
): PowerhourDeviceResolution => {
  if (choice.kind === 'unreadable') return { kind: 'unreadable' };
  if (devices.length === 0) return { kind: 'no_devices' };
  if (choice.kind === 'chosen') {
    const chosen = devices.find((device) => device.deviceId === choice.deviceId);
    return chosen
      ? { kind: 'selected', device: chosen }
      : { kind: 'device_missing', deviceId: choice.deviceId };
  }
  const [only] = devices;
  if (devices.length === 1 && only) return { kind: 'selected', device: only };
  return { kind: 'device_missing', deviceId: '' };
};

/** The device list as the settings UI has to render it. */
export const toPowerhourDeviceOptions = (devices: PowerhourDevice[]): PowerhourDeviceUiOption[] => (
  devices.map((device) => ({
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    priceIntervalMinutes: device.priceIntervalMinutes,
    biddingZone: device.biddingZone,
  }))
);

/**
 * The periods a stored day holds, through the same reader every other consumer
 * of a stored day uses.
 *
 * `buildFlowEntries` rather than a hand-read of `pricesByPeriod ?? pricesBySlot`
 * because it is the one place that knows the whole payload shape: it prefers
 * the source's own sub-hourly periods, falls back to the clock-hour map for an
 * hour no period covers, and drops anything outside the payload's own local
 * day. A merge base that reads one field fewer than the series build does is a
 * merge base that can silently carry less than the day actually holds.
 */
const storedPeriods = (payload: FlowPricePayload | null, timeZone: string): FlowPricePeriod[] => (
  payload ? buildFlowEntries(payload, timeZone) : []
);

const buildDayPayload = (
  dateKey: string,
  periods: FlowPricePeriod[],
  timeZone: string,
  now: Date,
): FlowPricePayload | null => {
  if (periods.length === 0) return null;
  const pricesByHour = buildPricesByHourFromPeriods(periods, timeZone);
  const pricesBySlot = toHourlyPeriods(periods, timeZone);
  const isSubHourly = periods.some((period) => period.durationMinutes < DEFAULT_PERIOD_MINUTES);
  if (pricesBySlot.length === 0 && Object.keys(pricesByHour).length === 0) return null;
  return {
    dateKey,
    pricesByHour,
    pricesBySlot: pricesBySlot.length > 0 ? pricesBySlot : undefined,
    pricesByPeriod: isSubHourly ? periods : undefined,
    updatedAt: now.toISOString(),
  };
};

/**
 * Merge a day's freshly read periods over what is already stored for it.
 *
 * A merge rather than a replacement because the app answers from the CURRENT
 * period onwards: a read at 18:00 knows nothing about this morning, and writing
 * that answer over the stored day would delete hours PELS had and still shows.
 * Fresh periods win on an identical start, so a price the app revised is taken.
 *
 * `keepStored` is false when the stored day came from a different device — see
 * {@link buildPowerhourPayloads}. Dropping it there rather than merging is the
 * point: two devices are two bidding zones, and a day half-priced in each is a
 * series nothing could read correctly.
 */
const mergeDayPeriods = (
  stored: FlowPricePeriod[],
  fresh: FlowPricePeriod[],
  keepStored: boolean,
): FlowPricePeriod[] => {
  const byStart = new Map<string, FlowPricePeriod>();
  if (keepStored) stored.forEach((period) => byStart.set(period.startsAt, period));
  fresh.forEach((period) => byStart.set(period.startsAt, period));
  return Array.from(byStart.values())
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
};

/**
 * What to do with one stored day after a read.
 *
 * Three outcomes, not a nullable payload, because "nothing fresh for this day"
 * means two opposite things. On the same device it is an absent reading and the
 * stored day is owed the no-op every absent reading is owed. On a different
 * device the stored day is another bidding zone's prices, and leaving it would
 * keep pricing the home from a device the owner has stopped using.
 */
export type PowerhourDayWrite =
  | { kind: 'store'; payload: FlowPricePayload }
  | { kind: 'clear' }
  | { kind: 'keep' };

export type PowerhourPayloads = {
  today: PowerhourDayWrite;
  tomorrow: PowerhourDayWrite;
  /** The device's own currency label, or `null` when it states none. */
  currency: string | null;
  /**
   * A day was left alone that this device did NOT write — it could not be read,
   * and the marker names someone else. The caller must not advance the marker
   * past it: once that day becomes readable again it would be taken for this
   * device's own cache, and the next merge would put two bidding zones in one
   * day. The very thing the `clear` arm exists to prevent.
   */
  retainsForeignDay: boolean;
};

/**
 * One cached day, as the store could resolve it.
 *
 * `unreadable` is the member that earns this type. This source MERGES into the
 * stored day rather than replacing it, which makes the read half load-bearing:
 * a transient settings miss that read as "nothing stored" would let the fresh
 * read — future slots only — be written as the whole day, and this morning's
 * prices would be gone for good. So a key that is listed but did not come back
 * settles nothing, and the day is left exactly as it is.
 */
export type PowerhourCachedDay =
  | { kind: 'stored'; payload: unknown }
  /** The key is not there: nothing has ever been stored for this day. */
  | { kind: 'absent' }
  /** Listed, but this read did not produce it. */
  | { kind: 'unreadable' };

/**
 * Which device the cached days were built from. Same three states and the same
 * reason: read as `absent`, a transient miss would look like "a different
 * device wrote this" and drop every stored period.
 */
export type PowerhourCacheDevice =
  | { kind: 'device'; deviceId: string }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/**
 * What PELS already holds from this source: the two stored day payloads and the
 * device they were built from.
 *
 * One object because the three are only ever meaningful together — a stored day
 * says nothing without the device that wrote it — and because the price data
 * store is what owns the keys behind them and hands the whole thing over,
 * resolved.
 */
export type PowerhourCache = {
  today: PowerhourCachedDay;
  tomorrow: PowerhourCachedDay;
  device: PowerhourCacheDevice;
};

/**
 * One read of one device, as the two day payloads PELS stores.
 *
 * Slots for any other local day are dropped. Market prices do not run past
 * tomorrow, and the forecast that used to reach further is refused at the
 * adapter (`powerhourPriceFetch.ts`), so this filter has no live cause left —
 * it stays because a third day has nowhere to be stored, and a payload that
 * grew one would otherwise land in whichever slot it was read into.
 */
export const buildPowerhourPayloads = (
  device: PowerhourDevice,
  cache: PowerhourCache,
  timeZone: string,
  now: Date,
): PowerhourPayloads => {
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  // Only a marker that NAMES another device is evidence the stored days belong
  // to one. Absence and an unreadable read are both "no verdict", and the
  // no-verdict answer is to keep what is there.
  const keepStored = cache.device.kind !== 'device' || cache.device.deviceId === device.deviceId;

  const freshByDay = device.slots.reduce<Map<string, FlowPricePeriod[]>>((acc, slot) => {
    const dateKey = getDateKeyInTimeZone(new Date(Date.parse(slot.startsAt)), timeZone);
    if (dateKey !== todayKey && dateKey !== tomorrowKey) return acc;
    const period: FlowPricePeriod = {
      startsAt: slot.startsAt,
      totalPrice: slot.importPrice,
      durationMinutes: device.priceIntervalMinutes,
    };
    acc.set(dateKey, [...(acc.get(dateKey) ?? []), period]);
    return acc;
  }, new Map<string, FlowPricePeriod[]>());

  const resolveDay = (dateKey: string, cached: PowerhourCachedDay): PowerhourDayWrite => {
    // A day PELS could not read is a day it must not write: the merge below
    // would carry nothing forward and persist the future half as the whole day.
    if (cached.kind === 'unreadable') return { kind: 'keep' };
    const existing = cached.kind === 'stored' ? getFlowPricePayload(cached.payload) : null;
    const fresh = freshByDay.get(dateKey) ?? [];
    if (fresh.length === 0) {
      // Only a day that actually HOLDS another device's prices is worth
      // clearing; on the same device, or with nothing stored, there is nothing
      // to undo and the absent reading is simply a no-op.
      return !keepStored && existing ? { kind: 'clear' } : { kind: 'keep' };
    }
    const carried = existing?.dateKey === dateKey ? storedPeriods(existing, timeZone) : [];
    const payload = buildDayPayload(dateKey, mergeDayPeriods(carried, fresh, keepStored), timeZone, now);
    return payload ? { kind: 'store', payload } : { kind: 'keep' };
  };

  const today = resolveDay(todayKey, cache.today);
  const tomorrow = resolveDay(tomorrowKey, cache.tomorrow);
  const unreadableForeignDay = !keepStored
    && (cache.today.kind === 'unreadable' || cache.tomorrow.kind === 'unreadable');

  return {
    today,
    tomorrow,
    currency: device.currency || null,
    retainsForeignDay: unreadableForeignDay,
  };
};

/**
 * What to tell the owner about this source.
 *
 * Every arm but `reading` means the home has no prices from Power by the Hour,
 * and the settings UI says something different for each — a transient read
 * failure and a Cloud Homey are not the same news. A failed read reports
 * `app_unavailable` rather than inventing a fifth state: from the owner's side
 * an app that will not answer and an app that is not running are the same
 * problem in the same place.
 */
export const resolvePowerhourSourceUiStatus = (
  read: PowerhourRead,
  choice: PowerhourDeviceChoice,
): PowerhourSourceUiStatus => {
  if (read.kind === 'unavailable') {
    return read.reason === 'not_permitted'
      ? { kind: 'not_permitted' }
      : { kind: 'app_unavailable' };
  }
  const devices = toPowerhourDeviceOptions(read.devices);
  const resolution = resolvePowerhourDevice(read.devices, choice);
  if (resolution.kind === 'unreadable') return { kind: 'unknown' };
  if (resolution.kind === 'no_devices') return { kind: 'no_devices' };
  if (resolution.kind === 'device_missing') {
    return { kind: 'device_missing', deviceId: resolution.deviceId, devices };
  }
  const selected = toPowerhourDeviceOptions([resolution.device])[0];
  // `toPowerhourDeviceOptions` maps one device to one option, so the first
  // element is always there; the fallback is the type system's, not a state —
  // `unknown` is what to say when there is nothing to report.
  if (!selected) return { kind: 'unknown' };
  return { kind: 'reading', selected, devices };
};

/**
 * The owner's chosen device, re-exported so this module stays the one door on
 * the source — `PriceService` reads the setting through it rather than
 * type-importing shared-domain for one policy it does not otherwise touch.
 */
export { readPowerhourDeviceIdSetting as readPowerhourDeviceId };

/**
 * What one refresh decided. The caller persists and reports it — the decision
 * is made here, where the read and the cache meet, and the store writes stay
 * with the component that holds the store.
 */
export type PowerhourRefreshOutcome =
  | { kind: 'unavailable'; reason: PowerhourUnavailableReason }
  | {
    kind: 'no_device';
    reason: 'no_devices' | 'device_missing' | 'unreadable';
    deviceCount: number;
    /** The stored days came from a device that is no longer in force. */
    staleCache: boolean;
  }
  | { kind: 'mirrored'; device: PowerhourDevice; payloads: PowerhourPayloads };

/**
 * One read, answering both questions it can answer: what to store, and what to
 * tell the owner. From the SAME read, so the prices the planner gets and the
 * account the settings UI shows can never describe different moments.
 */
export type PowerhourRefresh = {
  status: PowerhourSourceUiStatus;
  outcome: PowerhourRefreshOutcome;
};

const resolvePowerhourRefresh = async (
  api: Pick<ApiPort, 'getApiApp'>,
  choice: PowerhourDeviceChoice,
  cache: PowerhourCache,
  timeZone: string,
  now: Date,
): Promise<PowerhourRefresh> => {
  const read = await fetchPowerhourPrices(api);
  const status = resolvePowerhourSourceUiStatus(read, choice);
  if (read.kind === 'unavailable') {
    return { status, outcome: { kind: 'unavailable', reason: read.reason } };
  }
  const resolution = resolvePowerhourDevice(read.devices, choice);
  if (resolution.kind !== 'selected') {
    return {
      status,
      outcome: {
        kind: 'no_device',
        reason: resolution.kind,
        deviceCount: read.devices.length,
        // The stored days belong to a device that is no longer the owner's —
        // unless the choice itself is what could not be read, which settles
        // nothing and must not take their prices away.
        staleCache: resolution.kind !== 'unreadable' && cache.device.kind === 'device',
      },
    };
  }
  return {
    status,
    outcome: {
      kind: 'mirrored',
      device: resolution.device,
      payloads: buildPowerhourPayloads(resolution.device, cache, timeZone, now),
    },
  };
};

export type { PowerhourDevice, PowerhourRead, PowerhourUnavailableReason } from './powerhourPriceFetch';
export type { PowerhourSourceUiStatus } from '../../packages/contracts/src/settingsUiApi';

/**
 * The slice of the price data store this source reads and writes.
 *
 * Declared here rather than importing `PriceDataStore` so the dependency runs
 * one way only: the store names this module's `PowerhourCache`, and this module
 * names nothing of the store's.
 */
export type PowerhourStore = {
  readPowerhourCache(): PowerhourCache;
  /** Persist (or clear) one of the two stored days. The store owns which key that is. */
  writePowerhourDay(day: PowerhourDay, payload: FlowPricePayload | null): void;
  /** `null` clears it: the unit is the device's, and an absent one is unknown. */
  writePowerhourCurrency(unit: string | null): void;
  writePowerhourCacheDevice(deviceId: string | null): void;
};

/** Which of the two stored days a write is about. */
export type PowerhourDay = 'today' | 'tomorrow';

/** What a mirror pass did, for its caller to report and act on. */
export type PowerhourMirror = {
  status: PowerhourSourceUiStatus;
  /** True when the stored series moved, so the combined prices need rebuilding. */
  changed: boolean;
  /**
   * Where the record belongs. A pass that changed the home's prices is an
   * event; a settled verdict repeating every three hours forever is not, and
   * at `info` it would be the loudest line this source ever writes.
   */
  level: 'info' | 'debug';
  /** One structured record of the pass, for the caller's own log sink. */
  record: Record<string, unknown>;
};

/**
 * Read Power by the Hour once and mirror what it said into the stored days.
 *
 * There is no cache short-circuit, deliberately, and it is the difference
 * between this source and the Homey Energy one: the app answers from the
 * CURRENT period onwards, so every refresh carries slots the stored day does
 * not have yet — a revised price, or tomorrow's auction landing.
 * Skipping the read because today is "already stored" would leave the home on
 * whatever the first read of the day happened to say.
 *
 * Nothing that fails here writes: an unavailable app, a device the owner has
 * not chosen and a day with no slots are all no-ops that leave the last good
 * payload exactly where it is.
 */
export const mirrorPowerhourPrices = async (
  api: Pick<ApiPort, 'getApiApp'>,
  settings: SettingsPort,
  store: PowerhourStore,
  timeZone: string,
  /**
   * Move a `tomorrow` payload that has become today into the today slot. Called
   * BEFORE the merge, because the merge base has to be the day as the local
   * calendar has it — but only while both slots can be read. The rotation works
   * off raw payloads, so a slot it cannot read looks empty: it would clear a
   * stale today and promote nothing, and the next pass, seeing today populated
   * with this device's future-only answer, would clear the tomorrow copy that
   * still held the elapsed hours.
   */
  rotateSlots: () => void,
): Promise<PowerhourMirror> => {
  const choice = readPowerhourDeviceChoice(settings);
  const before = store.readPowerhourCache();
  // The two slots are ONE rotation state, so a slot PELS cannot read makes the
  // whole pass a no-op — not just the rotation. Rotating alone is not enough:
  // with today stale and tomorrow unreadable, skipping the rotation still lets
  // the merge write today's future-only answer over the stale slot, and the
  // NEXT pass — reading today as current — clears the tomorrow copy that held
  // the elapsed hours. Deciding nothing is the only answer that keeps them.
  if (before.today.kind === 'unreadable' || before.tomorrow.kind === 'unreadable') {
    return {
      status: resolvePowerhourSourceUiStatus(await fetchPowerhourPrices(api), choice),
      changed: false,
      level: 'debug',
      record: { event: 'powerhour_prices_cache_unreadable' },
    };
  }
  rotateSlots();
  const cache = store.readPowerhourCache();
  const { status, outcome } = await resolvePowerhourRefresh(
    api,
    choice,
    cache,
    timeZone,
    new Date(),
  );
  if (outcome.kind === 'unavailable') {
    return {
      status,
      changed: false,
      level: 'debug',
      record: { event: 'powerhour_prices_unavailable', reason: outcome.reason },
    };
  }
  if (outcome.kind === 'no_device') {
    // The owner has no device in force, and the stored days were built from one
    // they had. Keeping them prices the home from a bidding zone it has stopped
    // using while the settings page says it has no prices at all — the same
    // reason the `clear` arm exists on a device SWITCH. A day PELS could not
    // read is left alone, because clearing it is still a write.
    const dropped = outcome.staleCache
      ? ([
        ['today', cache.today],
        ['tomorrow', cache.tomorrow],
      ] as const).filter(([, day]) => day.kind === 'stored')
      : [];
    dropped.forEach(([day]) => store.writePowerhourDay(day, null));
    if (outcome.staleCache) store.writePowerhourCacheDevice(null);
    return {
      status,
      changed: dropped.length > 0,
      level: dropped.length > 0 ? 'info' : 'debug',
      record: {
        event: 'powerhour_prices_no_device',
        reason: outcome.reason,
        deviceCount: outcome.deviceCount,
        clearedDayCount: dropped.length,
      },
    };
  }

  const { device, payloads } = outcome;
  const writes: Array<[PowerhourDay, PowerhourDayWrite]> = [
    ['today', payloads.today],
    ['tomorrow', payloads.tomorrow],
  ];
  const stored = writes.filter(([, write]) => write.kind === 'store').length;
  const cleared = writes.filter(([, write]) => write.kind === 'clear').length;
  if (stored === 0 && cleared === 0) {
    return {
      status,
      changed: false,
      level: 'debug',
      record: { event: 'powerhour_prices_no_data', deviceId: device.deviceId },
    };
  }
  // The stored currency names the device in force, including when that device
  // states none — leaving the previous device's label behind would price the new
  // device's numbers in the old one's unit. `null` is the modelled unknown, which
  // `getPriceUnitLabel` already renders as "price units".
  store.writePowerhourCurrency(payloads.currency);
  writes.forEach(([day, write]) => {
    if (write.kind === 'store') store.writePowerhourDay(day, write.payload);
    if (write.kind === 'clear') store.writePowerhourDay(day, null);
  });
  // After the payloads, so a crash between the two cannot leave a marker
  // claiming a cache was built from a device whose prices never landed in it.
  // Held back entirely while a day PELS could not read still belongs to the
  // previous device: advancing past it would adopt that day as this device's.
  if (!payloads.retainsForeignDay) store.writePowerhourCacheDevice(device.deviceId);
  return {
    status,
    changed: true,
    level: 'info',
    record: {
      event: 'powerhour_prices_stored',
      deviceId: device.deviceId,
      priceIntervalMinutes: device.priceIntervalMinutes,
      dayCount: stored,
      clearedDayCount: cleared,
      markerHeld: payloads.retainsForeignDay,
    },
  };
};
