import type { HomeyDeviceLike, Logger } from '../../utils/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { getLogger } from '../../logging/logger';
import { isHomeyDeviceLike } from '../../utils/types';

const moduleLogger = getLogger('device/manager-fetch');
import {
  extractLiveHomePowerWatts,
  extractLiveGenerationWatts,
  extractLiveMeterPowerWatts,
  extractLivePowerWattsByDeviceId,
  type LiveDevicePowerWatts,
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
      return { byDeviceId: {}, homePowerW: null, generationW: null, deviceCount: 0, additionalMeterPowerW: {} };
    }
    const byDeviceId = extractLivePowerWattsByDeviceId(report);
    const homePowerW = meterDeviceId != null
      ? extractLiveMeterPowerWatts(report, meterDeviceId)
      : extractLiveHomePowerWatts(report);
    const generationW = extractLiveGenerationWatts(report);
    const additionalMeterPowerW = extractAdditionalMeterPowerW(report, additionalMeterDeviceIds);
    const deviceCount = Object.keys(byDeviceId).length;
    (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
      event: 'energy_live_report_received',
      source: 'homey_energy',
      homePowerW,
      generationW,
      deviceCount,
      ...(meterDeviceId != null ? { meterDeviceId } : {}),
      ...(additionalMeterDeviceIds.length > 0
        ? {
          additionalMetersRequested: additionalMeterDeviceIds.length,
          additionalMetersRead: Object.keys(additionalMeterPowerW).length,
        }
        : {}),
    });
    return { byDeviceId, homePowerW, generationW, deviceCount, additionalMeterPowerW };
  } catch (error) {
    logDeviceTransportRuntimeError(logger, { event: 'energy_live_report_fetch_failed' }, error);
    return { byDeviceId: {}, homePowerW: null, generationW: null, deviceCount: 0, additionalMeterPowerW: {} };
  }
}
