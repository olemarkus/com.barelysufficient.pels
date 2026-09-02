import type { HomeyDeviceLike, Logger } from '../../utils/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { getLogger } from '../../logging/logger';
import { isHomeyDeviceLike } from '../../utils/types';
import { normalizeError } from '../../utils/errorUtils';
import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';

const moduleLogger = getLogger('device/manager-fetch');
import {
  asLiveEnergyReport,
  extractLiveMeterItems,
  extractLiveMeterPowerWatts,
  extractLivePowerWattsByDeviceId,
  resolveLiveGeneration,
  type LiveDevicePowerWatts,
  type LiveEnergyReport,
  type LiveGeneration,
  type LiveMeterItem,
} from '../managerEnergy';
import {
  DEVICES_API_PATH,
  getEnergyLiveReport,
  getRawDevice,
  getRawDevices,
  logDeviceTransportRuntimeError,
} from './managerHomeyApi';

export type DeviceFetchSource = 'raw_manager_devices' | 'targeted_by_id';

/**
 * Result of a device-list fetch. `failedIds` is the set of requested ids whose
 * by-id NETWORK read actually failed this cycle (404/timeout/invalid payload) —
 * the ONLY ids the targeted-refresh grace may retain. It is always empty for a
 * full (`raw_manager_devices`) read, which either succeeds wholly or throws.
 * A device that was fetched successfully but later dropped by PARSING (unmanaged
 * /unsupported/ineligible) is NOT in `failedIds` and must not be retained.
 */
export type DeviceFetchResult = {
  devices: HomeyDeviceLike[];
  fetchSource: DeviceFetchSource;
  failedIds: string[];
};

const DEVICE_FETCH_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

export async function fetchDevicesWithFallback(params: {
  logger: Logger;
}): Promise<DeviceFetchResult> {
  const { logger } = params;
  let lastError: unknown;
  for (let attempt = 0; attempt <= DEVICE_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const devices = await getRawDevices(DEVICES_API_PATH);
      const rawList = Array.isArray(devices) ? devices : Object.values(devices || {});
      const list = rawList.filter(isHomeyDeviceLike);
      logger.debug({
        event: 'manager_api_devices_returned',
        validDevices: list.length,
        invalidEntries: rawList.length - list.length,
      });
      return {
        devices: list,
        fetchSource: 'raw_manager_devices',
        failedIds: [],
      };
    } catch (error) {
      lastError = error;
      if (attempt < DEVICE_FETCH_RETRY_DELAYS_MS.length) {
        const delay = DEVICE_FETCH_RETRY_DELAYS_MS[attempt];
        logger.debug({ event: 'device_fetch_retry', attempt: attempt + 1, retryDelayMs: delay });
        await new Promise((resolve) => { setTimeout(resolve, delay); });
      }
    }
  }
  logDeviceTransportRuntimeError(
    logger,
    { event: 'device_fetch_failed_after_retries', attempts: DEVICE_FETCH_RETRY_DELAYS_MS.length + 1 },
    lastError,
  );
  throw lastError;
}

export async function fetchDevicesByIds(params: {
  deviceIds: string[];
  logger: Logger;
}): Promise<DeviceFetchResult> {
  const { deviceIds, logger } = params;
  if (deviceIds.length === 0) {
    return { devices: [], fetchSource: 'targeted_by_id', failedIds: [] };
  }
  const results = await Promise.allSettled(
    deviceIds.map((id) => getRawDevice(id)),
  );
  const devices: HomeyDeviceLike[] = [];
  const failedIds: string[] = [];
  for (const [index, deviceId] of deviceIds.entries()) {
    const result = results[index];
    // `Promise.allSettled` settles one entry per input in order, so a missing
    // settlement cannot happen; counting it as a failed read keeps the id inside the
    // per-device retention grace rather than dropping the device from the snapshot.
    if (result === undefined) {
      failedIds.push(deviceId);
      continue;
    }
    if (result.status === 'fulfilled') {
      if (isHomeyDeviceLike(result.value)) {
        devices.push(result.value);
      } else {
        failedIds.push(deviceId);
        logger.debug({ event: 'targeted_device_fetch_invalid_payload', deviceId });
      }
    } else {
      failedIds.push(deviceId);
      const err = result.reason as Error | undefined;
      logger.debug({
        event: 'targeted_device_fetch_failed',
        deviceId,
        error: err?.message || 'unknown error',
      });
    }
  }
  // A targeted (by-id) refresh is UPDATE-ONLY — it refreshes the devices we
  // already know about. So any read that returns at least one device is enough
  // to commit those successes. A device whose by-id NETWORK read failed THIS
  // cycle (404, timeout, invalid payload) is reported in `failedIds`: the
  // transport's snapshot overlay RETAINS those ids for a per-device grace
  // (`mergeTargetedRefreshSnapshot`) — they are transient misses, not removals.
  // The projection then prunes to the committed (overlaid) batch. (A device that
  // was fetched fine but parsed out is NOT in `failedIds`, so it is dropped
  // immediately, never retained.) Cascading every flaky single-device read to a
  // full re-fetch is what once let one bad device stall the whole snapshot the
  // capacity controller relies on. We fall back to the full fetch ONLY when
  // EVERY requested id failed (`devices` is empty) — there is nothing to commit,
  // so a genuine recovery path is warranted.
  if (devices.length === 0 && failedIds.length > 0) {
    logger.debug({
      event: 'targeted_fetch_fallback_to_full',
      failures: failedIds.length,
    });
    return fetchDevicesWithFallback({ logger });
  }
  if (failedIds.length > 0) {
    (logger.structuredLog ?? moduleLogger).warn({
      event: 'targeted_fetch_partial',
      succeeded: devices.length,
      failed: failedIds.length,
    });
  }
  return { devices, fetchSource: 'targeted_by_id', failedIds };
}

/**
 * The whole-home reading for the producer-clean Main meter selection. A
 * `resolved` reading names the meter it was read from — the reading and its
 * identity are one fact, stamped where the watts are produced, so the sample
 * built from it never has to re-check the selection it came from.
 * `unavailable` covers both an unavailable selection and a selected meter the
 * report did not carry: honestly absent, never a guess, because the only
 * guessable answer was Automatic, and claiming it is how the wrong meter's
 * watts become the whole home's.
 */
export type LiveHomeReading =
  | { readonly state: 'resolved'; readonly watts: number; readonly meterDeviceId: string }
  | { readonly state: 'unavailable' };

/**
 * One live energy report, resolved at this adapter so nothing nullable crosses
 * it. `unavailable` is a FAILED read (dead REST client, thrown fetch, a payload
 * that is not a report — see `asLiveEnergyReport`) — not a measurement, so a
 * consumer publishes nothing from it and lets held state age out. `measured`
 * is a parsed payload whose halves each say what they found: the whole-home
 * reading is `resolved` or `unavailable`, generation is `measured` or `none`.
 * No flag, no sibling enum, no `null` that means two things.
 */
export type LivePowerReport =
  | { readonly state: 'unavailable' }
  | {
    readonly state: 'measured';
    readonly byDeviceId: LiveDevicePowerWatts;
    readonly home: LiveHomeReading;
    /** Gross PV generation from the same payload. `+`-only; `unavailable` = a malformed signal, publish nothing. */
    readonly generation: LiveGeneration;
    readonly deviceCount: number;
    /**
     * Per-meter readings for the caller-requested additional meter ids
     * (multi-home R7b: one entry per sub-home meter that produced a FINITE
     * reading this poll). A requested id whose reading is absent/non-finite is
     * simply NOT a key — never a fabricated zero; the consumer's freshness
     * machinery handles the gap.
     */
    readonly additionalMeterPowerW: Record<string, number>;
  };

const resolveHomeReading = (
  report: unknown,
  selection: MainMeterSelection,
): LiveHomeReading => {
  if (selection.state !== 'resolved') return { state: 'unavailable' };
  const watts = extractLiveMeterPowerWatts(report, selection.meterDeviceId);
  return watts === null
    ? { state: 'unavailable' }
    : { state: 'resolved', watts, meterDeviceId: selection.meterDeviceId };
};

// Resolve each requested additional meter id against the SAME live payload the
// whole-home reading came from (one fetch serves all homes). Only finite
// readings land in the map (see the field doc above).
const extractAdditionalMeterPowerW = (
  report: unknown,
  meterDeviceIds: readonly string[],
): Record<string, number> => Object.fromEntries(
  meterDeviceIds.flatMap((meterDeviceId) => {
    const watts = extractLiveMeterPowerWatts(report, meterDeviceId);
    return watts === null ? [] : [[meterDeviceId, watts] as const];
  }),
);

/**
 * A whole-home PRODUCTION read: the report's generation (`measured`, `none`,
 * or `unavailable` for a present-but-malformed signal), or `unavailable` when
 * the read itself failed — the same state, because both are the same no-op to
 * the caller. The distinction from `none` matters on `flow`, where net keeps
 * arriving from the Flow card independently — publishing a failure as a fresh
 * "producing nothing" observation would overwrite a good reading, stamp it
 * `now`, and so slip past the freshness window straight into
 * `generationBuckets`. The adapter owns the classification (root
 * `AGENTS.md`); the caller decides whether to publish.
 *
 * Deliberately narrower than {@link fetchLivePowerReport}: production comes from
 * the report's own `totalGenerated` aggregate, independent of meter selection,
 * so this needs neither the selection nor the per-device/sub-meter lanes.
 */
export type LiveGenerationRead = LiveGeneration;

/**
 * The one read + shape gate behind both live-report fetches: `null` from the
 * REST layer is the uninitialised-client sentinel, and anything that is not a
 * record with an `items` array is a malformed payload (an empty 2xx body
 * resolves `undefined`). Both leave as `null` here after their own log line,
 * so the callers have a single "no report" branch.
 */
async function readLiveEnergyReport(logger: Logger, unavailableEvent: string): Promise<LiveEnergyReport | null> {
  const raw = await getEnergyLiveReport();
  if (raw === null) {
    logger.error({ event: unavailableEvent, reasonCode: 'rest_client_not_initialized' });
    return null;
  }
  const report = asLiveEnergyReport(raw);
  if (report === null) {
    logger.error({ event: unavailableEvent, reasonCode: 'malformed_payload' });
  }
  return report;
}

export async function fetchLiveGenerationW(logger: Logger): Promise<LiveGenerationRead> {
  try {
    const report = await readLiveEnergyReport(logger, 'energy_live_generation_unavailable');
    return report === null ? { state: 'unavailable' } : resolveLiveGeneration(report);
  } catch (error) {
    logDeviceTransportRuntimeError(logger, { event: 'energy_live_generation_fetch_failed' }, error);
    return { state: 'unavailable' };
  }
}

export async function fetchLivePowerReport(params: {
  logger: Logger;
  debugStructured?: StructuredDebugEmitter;
  /** Producer-clean Main meter selection; `unavailable` nulls the whole-home half. */
  meterSelection: MainMeterSelection;
  /** Additional per-meter reading requests (sub-home meters); empty = none. */
  additionalMeterDeviceIds: readonly string[];
}): Promise<LivePowerReport> {
  const {
    logger,
    debugStructured,
    meterSelection,
    additionalMeterDeviceIds,
  } = params;
  try {
    const report = await readLiveEnergyReport(logger, 'energy_live_report_unavailable');
    if (report === null) return { state: 'unavailable' };
    const byDeviceId = extractLivePowerWattsByDeviceId(report);
    const home = resolveHomeReading(report, meterSelection);
    const generation = resolveLiveGeneration(report);
    const additionalMeterPowerW = extractAdditionalMeterPowerW(report, additionalMeterDeviceIds);
    const deviceCount = Object.keys(byDeviceId).length;
    (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
      event: 'energy_live_report_received',
      source: 'homey_energy',
      homeMeterResolution: home.state,
      ...(home.state === 'resolved' ? { homePowerW: home.watts } : {}),
      ...(generation.state === 'measured' ? { generationW: generation.watts } : {}),
      deviceCount,
      // Always logged: an unattributed whole-home reading is exactly what made
      // a wrong-meter sample undiagnosable.
      ...(meterSelection.state === 'resolved' ? { meterDeviceId: meterSelection.meterDeviceId } : {}),
      ...(additionalMeterDeviceIds.length > 0
        ? {
          additionalMetersRequested: additionalMeterDeviceIds.length,
          additionalMetersRead: Object.keys(additionalMeterPowerW).length,
        }
        : {}),
    });
    return {
      state: 'measured',
      byDeviceId,
      home,
      generation,
      deviceCount,
      additionalMeterPowerW,
    };
  } catch (error) {
    logDeviceTransportRuntimeError(logger, { event: 'energy_live_report_fetch_failed' }, error);
    return { state: 'unavailable' };
  }
}

/**
 * The pickable whole-home meters from the live energy report — the same seam
 * the meter-selection reader resolves against, so the picker offers exactly
 * what a selection can read (no capability/class proxy over the device list).
 * A read failure or uninitialised client resolves to an empty list, never a
 * throw: the picker then shows only its placeholder and re-fetches on the next open.
 */
export async function fetchLiveMeterItems(): Promise<LiveMeterItem[]> {
  try {
    return extractLiveMeterItems(await getEnergyLiveReport());
  } catch (error) {
    moduleLogger.error({ event: 'energy_live_meter_items_fetch_failed', err: normalizeError(error) });
    return [];
  }
}
