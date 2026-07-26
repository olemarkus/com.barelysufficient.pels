import type { HomeyDeviceLike, Logger } from '../../utils/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { getLogger } from '../../logging/logger';
import { isHomeyDeviceLike } from '../../utils/types';
import { normalizeError } from '../../utils/errorUtils';

const moduleLogger = getLogger('device/manager-fetch');
import {
  extractAutomaticHomePowerReading,
  extractLiveGenerationWatts,
  extractLiveMeterItems,
  extractLiveMeterPowerWatts,
  extractLivePowerWattsByDeviceId,
  type LiveDevicePowerWatts,
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
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      if (isHomeyDeviceLike(result.value)) {
        devices.push(result.value);
      } else {
        failedIds.push(deviceIds[i]);
        logger.debug({ event: 'targeted_device_fetch_invalid_payload', deviceId: deviceIds[i] });
      }
    } else {
      failedIds.push(deviceIds[i]);
      const err = result.reason as Error | undefined;
      logger.debug({
        event: 'targeted_device_fetch_failed',
        deviceId: deviceIds[i],
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

export type LivePowerReport = {
  byDeviceId: LiveDevicePowerWatts;
  homePowerW: number | null;
  /** Gross PV generation (W) from the same payload; null when absent. `+`-only. */
  generationW: number | null;
  deviceCount: number;
  /**
   * Per-meter readings for the caller-requested additional meter ids
   * (multi-home R7b: one entry per sub-home meter that produced a FINITE
   * reading this poll). A requested id whose reading is absent/non-finite is
   * simply NOT a key — never a fabricated zero; the consumer's freshness
   * machinery handles the gap.
   */
  additionalMeterPowerW: Record<string, number>;
  /**
   * Identity of the meter `homePowerW` was actually read from, so ownership can
   * be proven rather than assumed. An explicit selection resolves to that id;
   * Automatic resolves to whichever `cumulative` item the payload yielded first,
   * which in a multi-meter house may be a superset of the Main home or even a
   * meter area's own meter. `null` means the sampled identity is UNKNOWN (no
   * reading, or the resolved item carried no id) — never treat it as proof of
   * non-collision.
   */
  resolvedHomeMeterDeviceId: string | null;
  /**
   * How many `cumulative` items the payload carried. `>1` under Automatic means
   * the whole-home reading was an arbitrary pick among several meters.
   */
  cumulativeItemCount: number;
};

/**
 * The "nothing was read" report. Defined here, beside the type, so the shape has
 * ONE owner: `transportTypes.ts` re-exports it rather than restating the fields,
 * which is what previously let a second construction site drift. The import
 * direction (`transportTypes` → here) is the legal one and introduces no cycle.
 * Fresh nested objects per call — callers may mutate `byDeviceId` /
 * `additionalMeterPowerW`.
 */
export const buildEmptyLivePowerReport = (): LivePowerReport => ({
  byDeviceId: {},
  homePowerW: null,
  generationW: null,
  deviceCount: 0,
  additionalMeterPowerW: {},
  resolvedHomeMeterDeviceId: null,
  cumulativeItemCount: 0,
});

/**
 * The whole-home reading together with the identity it came from, so the two are
 * resolved in ONE place and no consumer re-derives which meter was sampled.
 *
 * Explicit selection: the identity is the configured id, reported only when that
 * meter actually produced a reading (a miss must not claim the meter was read).
 * Automatic: both come from the resolved `cumulative` item.
 */
const resolveHomeReading = (
  report: unknown,
  meterDeviceId: string | null | undefined,
): Pick<LivePowerReport, 'homePowerW' | 'resolvedHomeMeterDeviceId' | 'cumulativeItemCount'> => {
  if (meterDeviceId != null) {
    const homePowerW = extractLiveMeterPowerWatts(report, meterDeviceId);
    return {
      homePowerW,
      resolvedHomeMeterDeviceId: homePowerW === null ? null : meterDeviceId,
      cumulativeItemCount: 0,
    };
  }
  const automatic = extractAutomaticHomePowerReading(report);
  return {
    homePowerW: automatic?.watts ?? null,
    resolvedHomeMeterDeviceId: automatic?.deviceId ?? null,
    cumulativeItemCount: automatic?.cumulativeItemCount ?? 0,
  };
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

export async function fetchLivePowerReport(params: {
  logger: Logger;
  debugStructured?: StructuredDebugEmitter;
  /** Resolved explicit whole-home meter id; null/undefined = automatic (first cumulative item). */
  meterDeviceId?: string | null;
  /** Additional per-meter reading requests (sub-home meters); empty/absent = none. */
  additionalMeterDeviceIds?: readonly string[];
}): Promise<LivePowerReport> {
  const { logger, debugStructured, meterDeviceId, additionalMeterDeviceIds = [] } = params;
  try {
    const report = await getEnergyLiveReport();
    if (report === null) {
      logger.error({
        event: 'energy_live_report_unavailable',
        reasonCode: 'rest_client_not_initialized',
      });
      return buildEmptyLivePowerReport();
    }
    const byDeviceId = extractLivePowerWattsByDeviceId(report);
    const { homePowerW, resolvedHomeMeterDeviceId, cumulativeItemCount }
      = resolveHomeReading(report, meterDeviceId);
    const generationW = extractLiveGenerationWatts(report);
    const additionalMeterPowerW = extractAdditionalMeterPowerW(report, additionalMeterDeviceIds);
    const deviceCount = Object.keys(byDeviceId).length;
    (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
      event: 'energy_live_report_received',
      source: 'homey_energy',
      homePowerW,
      generationW,
      deviceCount,
      // Always logged, explicit or Automatic: an unattributed whole-home reading
      // is exactly what made a wrong-meter sample undiagnosable.
      resolvedHomeMeterDeviceId,
      ...(meterDeviceId != null ? { meterDeviceId } : { cumulativeItemCount }),
      ...(additionalMeterDeviceIds.length > 0
        ? {
          additionalMetersRequested: additionalMeterDeviceIds.length,
          additionalMetersRead: Object.keys(additionalMeterPowerW).length,
        }
        : {}),
    });
    return {
      byDeviceId,
      homePowerW,
      generationW,
      deviceCount,
      additionalMeterPowerW,
      resolvedHomeMeterDeviceId,
      cumulativeItemCount,
    };
  } catch (error) {
    logDeviceTransportRuntimeError(logger, { event: 'energy_live_report_fetch_failed' }, error);
    return buildEmptyLivePowerReport();
  }
}

/**
 * The pickable whole-home meters from the live energy report — the same seam
 * the meter-selection reader resolves against, so the picker offers exactly
 * what a selection can read (no capability/class proxy over the device list).
 * A read failure or uninitialised client resolves to an empty list, never a
 * throw: the picker then shows only Automatic and re-fetches on the next open.
 */
export async function fetchLiveMeterItems(): Promise<LiveMeterItem[]> {
  try {
    return extractLiveMeterItems(await getEnergyLiveReport());
  } catch (error) {
    moduleLogger.error({ event: 'energy_live_meter_items_fetch_failed', err: normalizeError(error) });
    return [];
  }
}
