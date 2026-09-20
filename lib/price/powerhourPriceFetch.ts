/**
 * Power by the Hour's prices, read over Homey's app-to-app API.
 *
 * The app (`com.gruijter.powerhour`) publishes one GET route, `/dap-prices`,
 * carrying every price device the owner has paired in it: the hourly driver
 * (`dap`), the quarter-hourly one (`dap15`) and gas (`dapg`). Its own
 * documentation for the route is `README.dap-api.md` in that repo.
 *
 * This module is the adapter at that boundary, and it owns the whole
 * classification (root `AGENTS.md` § "Clean and trusted interfaces"): a missing
 * app, a refused handle, a thrown call, a malformed body and a device list with
 * nothing usable in it all come out as one typed `PowerhourRead`, never as a
 * thrown error or a nullable price. Inward of here nothing asks how the read
 * went, only what it says.
 *
 * Two things about the payload shape the rest of the module depends on:
 *
 * - **It carries only FUTURE slots.** The app answers from the current period
 *   onwards, so a read at 18:00 says nothing about this morning. Today's stored
 *   payload is therefore merged into, never replaced — see `powerhourScheme.ts`.
 * - **Gas is not electricity.** The `dapg` driver prices a gas meter per m³ and
 *   would be a plausible-looking nonsense if it reached the planner, so it is
 *   dropped here rather than offered to the owner as a choice.
 */

import type { ApiPort, ApiAppPort } from '../ports/homeyRuntime';

export const POWERHOUR_APP_ID = 'com.gruijter.powerhour';
export const DAP_PRICES_PATH = '/dap-prices';

/** The electricity drivers. `dapg` (gas) is deliberately not among them. */
const ELECTRICITY_DRIVER_TYPES = new Set(['dap', 'dap15']);

/** One priced period, as the app publishes it. Instants are ISO-8601 UTC. */
export type PowerhourSlot = {
  startsAt: string;
  /** Import price per kWh, after the owner's markups, in `currency`. */
  importPrice: number;
};

/** One of the app's price devices, resolved. */
export type PowerhourDevice = {
  deviceId: string;
  deviceName: string;
  biddingZone: string;
  /** The app's own currency label — a SYMBOL (`€`), not an ISO code. */
  currency: string;
  priceIntervalMinutes: number;
  slots: PowerhourSlot[];
};

/**
 * Why a read produced no prices. Each arm is a different thing for the owner to
 * do, which is why they are not one error string: `not_permitted` never
 * resolves itself, `app_unavailable` resolves when they install or start the
 * app, and `read_failed` is a transient that the next refresh may well fix.
 */
export type PowerhourUnavailableReason =
  | 'not_permitted'
  | 'app_unavailable'
  | 'read_failed'
  | 'malformed';

export type PowerhourRead =
  | { kind: 'resolved'; devices: PowerhourDevice[] }
  | { kind: 'unavailable'; reason: PowerhourUnavailableReason };

/**
 * The app handle, or the verdict that there will not be one.
 *
 * `getApiApp` throws synchronously on a Cloud Homey and when the permission is
 * missing, so the try/catch here is not defensive noise — it is the only place
 * that fact is observable.
 */
export const resolvePowerhourApiApp = (
  api: Pick<ApiPort, 'getApiApp'>,
  appId: string = POWERHOUR_APP_ID,
): ApiAppPort | null => {
  try {
    return api.getApiApp(appId);
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/**
 * A slot's period length. The app states it per device (`priceInterval`), and a
 * value outside one minute to one day is not a period length whatever it is.
 */
const resolveIntervalMinutes = (value: unknown): number | null => {
  const minutes = toFiniteNumber(value);
  if (minutes === null || minutes <= 0 || minutes > 24 * 60) return null;
  return minutes;
};

/**
 * One slot, or nothing.
 *
 * A slot with no readable instant or no finite price is dropped rather than
 * defaulted: an absent price is not zero, and zero is a price the planner would
 * act on.
 *
 * A FORECAST slot is dropped for the opposite reason: it is perfectly well
 * formed, and it is still not a price. With `forecastEnable` on, the app appends
 * Stekker's AI forecast past its own last market price and marks each one
 * `isForecast: true` (in its own `generic_dap_device.js`, not a path in this
 * repo). It does not treat them as prices itself either — they are excluded
 * from its recency check and drawn desaturated in its own charts. Carried
 * inward they would be indistinguishable from a cleared auction, and PELS would
 * commit a smart task against tomorrow at 09:00 while telling the owner it had
 * a full day. It is the judgement the Homey Energy source already makes when it
 * refuses the bare market price: a plausible number is the dangerous kind of
 * wrong.
 *
 * Only a literal `true` is a forecast. An absent or non-boolean field is an app
 * older than the feature, or an owner who left it off, and both publish market
 * prices only.
 */
const resolveSlot = (value: unknown): PowerhourSlot | null => {
  const record = asRecord(value);
  if (!record) return null;
  if (record.isForecast === true) return null;
  const time = toNonEmptyString(record.time);
  if (!time) return null;
  const startsAtMs = Date.parse(time);
  if (!Number.isFinite(startsAtMs)) return null;
  const importPrice = toFiniteNumber(record.importPrice);
  if (importPrice === null) return null;
  return { startsAt: new Date(startsAtMs).toISOString(), importPrice };
};

/**
 * One device, or nothing. A device with no id, no usable interval or no usable
 * slot cannot price anything, and offering it to the owner as a choice would be
 * offering them a dead end.
 */
const resolveDevice = (value: unknown): PowerhourDevice | null => {
  const record = asRecord(value);
  if (!record) return null;
  const driverType = toNonEmptyString(record.driverType);
  if (!driverType || !ELECTRICITY_DRIVER_TYPES.has(driverType)) return null;
  const deviceId = toNonEmptyString(record.deviceId);
  if (!deviceId) return null;
  const priceIntervalMinutes = resolveIntervalMinutes(record.priceInterval);
  if (priceIntervalMinutes === null) return null;
  if (!Array.isArray(record.slots)) return null;
  const slots = record.slots
    .map(resolveSlot)
    .filter((slot): slot is PowerhourSlot => slot !== null)
    // A repeated start is not a second period; keep the first, as the flow
    // payload read boundary does.
    .filter((slot, index, all) => all.findIndex((other) => other.startsAt === slot.startsAt) === index)
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  if (slots.length === 0) return null;
  return {
    deviceId,
    // The owner named the device; a nameless one still has to be pickable.
    deviceName: toNonEmptyString(record.deviceName) ?? deviceId,
    biddingZone: toNonEmptyString(record.biddingZone) ?? '',
    currency: toNonEmptyString(record.currency) ?? '',
    priceIntervalMinutes,
    slots,
  };
};

/**
 * The app's answer, resolved. A body that is not an object with a `prices`
 * array is `malformed` — the route exists and answered something PELS cannot
 * read, which is a different fact from the app not being there.
 */
export const resolvePowerhourPayload = (payload: unknown): PowerhourRead => {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.prices)) return { kind: 'unavailable', reason: 'malformed' };
  const devices = record.prices
    .map(resolveDevice)
    .filter((device): device is PowerhourDevice => device !== null);
  return { kind: 'resolved', devices };
};

/**
 * Read the app's prices once.
 *
 * `getInstalled()` is asked first so the two states the owner can act on stay
 * apart: an app that is not there answers `app_unavailable`, while one that is
 * there and still fails the GET answers `read_failed`. A throw from
 * `getInstalled()` itself is treated as the app being unavailable — the only
 * thing that call reports on is the app.
 */
export const fetchPowerhourPrices = async (
  api: Pick<ApiPort, 'getApiApp'>,
  appId: string = POWERHOUR_APP_ID,
): Promise<PowerhourRead> => {
  const apiApp = resolvePowerhourApiApp(api, appId);
  if (!apiApp) return { kind: 'unavailable', reason: 'not_permitted' };

  const installed = await apiApp.getInstalled().catch(() => false);
  if (!installed) return { kind: 'unavailable', reason: 'app_unavailable' };

  const payload = await apiApp.get(DAP_PRICES_PATH).then(
    (value: unknown) => ({ ok: true as const, value }),
    () => ({ ok: false as const, value: undefined }),
  );
  if (!payload.ok) return { kind: 'unavailable', reason: 'read_failed' };
  return resolvePowerhourPayload(payload.value);
};
