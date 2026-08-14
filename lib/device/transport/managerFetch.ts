import type { HomeyDeviceLike, Logger } from '../../utils/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { getLogger } from '../../logging/logger';
import { isHomeyDeviceLike } from '../../utils/types';
import { normalizeError } from '../../utils/errorUtils';

const moduleLogger = getLogger('device/manager-fetch');
import {
  resolveAutomaticHomePowerReading,
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
  /**
   * Whether this report is a MEASUREMENT (`true`) or a failed read (`false`).
   * `generationW: null` and `homePowerW: null` are shape-identical either way,
   * so consumers that publish from the report — `updateHomePowerFromReport` —
   * must consult this before overwriting held state. Required rather than
   * optional so a future failure branch cannot silently default to available.
   */
  reportAvailable: boolean;
  /** Whether the configured/Automatic Main meter produced authoritative watts. */
  homeMeterResolution: 'resolved' | 'ambiguous' | 'unavailable';
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
   * Automatic resolves to the sole usable `cumulative` item or retains its
   * previously proven candidate. Either may be a superset of the Main home or
   * even a meter area's own meter. `null` means the sampled identity is UNKNOWN (no
   * reading, or the resolved item carried no id) — never treat it as proof of
   * non-collision.
   */
  resolvedHomeMeterDeviceId: string | null;
  /**
   * Raw number of `cumulative` rows the payload carried, including duplicate or
   * unreadable rows. Read `homeMeterResolution` for the ambiguity decision.
   */
  cumulativeItemCount: number;
  /**
   * How many id-bearing meter items the payload carried — exactly the set the
   * whole-home meter picker seam exposes (`extractLiveMeterItems`: `cumulative`
   * or `device` items with an id, which explicit reads accept). Evidence for
   * the arrangement derivation: an id-less aggregate is only proven UNNAMEABLE
   * when no such item exists beside it.
   */
  selectableMeterItemCount: number;
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
  // A FAILED read, not a measurement. `generationW: null` below is
  // indistinguishable from "the report carried no generator", so consumers that
  // publish generation must check this flag before overwriting a good reading
  // with a freshly-stamped null (`updateHomePowerFromReport`).
  reportAvailable: false,
  homeMeterResolution: 'unavailable',
  byDeviceId: {},
  homePowerW: null,
  generationW: null,
  deviceCount: 0,
  additionalMeterPowerW: {},
  resolvedHomeMeterDeviceId: null,
  cumulativeItemCount: 0,
  selectableMeterItemCount: 0,
});

/**
 * What ONE whole-home read proves about whether the whole-home meter can be
 * NAMED (selected by device id):
 * - `identified` — the reading resolved with a device id, so an explicit
 *   selection can pin it.
 * - `idless_aggregate_only` — a reading was produced, the report's ONLY
 *   cumulative item carries no id (the arrangement `managerEnergy.ts`
 *   documents: some Homey setups emit the whole-home aggregate id-less), AND
 *   the payload carried no other id-bearing meter item. Only then is "no
 *   selection can ever name this meter" actually proven.
 * - `unproven` — this read proves neither: nothing was read (SDK miss), several
 *   cumulative items made Automatic ambiguous, or the id-less aggregate sat
 *   beside id-bearing items the picker seam
 *   exposes (`extractLiveMeterItems`) — naming one may then be the remedy, so
 *   this read must not claim unnameability. (Whether such an item survives the
 *   picker's device-class join lives outside this payload, so the read stays
 *   agnostic rather than proving either way.) Consumers must retain their last
 *   proven answer — an SDK miss must never flip a proven arrangement in either
 *   direction.
 */
export type HomeMeterArrangementObservation = 'identified' | 'idless_aggregate_only' | 'unproven';

export const deriveHomeMeterArrangement = (
  report: Pick<
    LivePowerReport,
    'homePowerW' | 'resolvedHomeMeterDeviceId' | 'cumulativeItemCount' | 'selectableMeterItemCount'
  >,
): HomeMeterArrangementObservation => {
  if (report.homePowerW === null) return 'unproven';
  if (report.resolvedHomeMeterDeviceId !== null) return 'identified';
  return report.cumulativeItemCount === 1 && report.selectableMeterItemCount === 0
    ? 'idless_aggregate_only'
    : 'unproven';
};

/**
 * The whole-home reading together with the identity it came from, so the two are
 * resolved in ONE place and no consumer re-derives which meter was sampled.
 *
 * Explicit selection: the identity is the configured id, reported only when that
 * meter actually produced a reading (a miss must not claim the meter was read).
 * Automatic: both come from the sole cumulative item or the retained prior
 * candidate. An unresolved multi-cumulative report produces no Main reading.
 */
const resolveHomeReading = (
  report: unknown,
  meterDeviceId: string | null | undefined,
  preferredAutomaticMeterDeviceId: string | null,
): Pick<
  LivePowerReport,
  'homeMeterResolution' | 'homePowerW' | 'resolvedHomeMeterDeviceId' | 'cumulativeItemCount'
> => {
  if (meterDeviceId != null) {
    const homePowerW = extractLiveMeterPowerWatts(report, meterDeviceId);
    return {
      homeMeterResolution: homePowerW === null ? 'unavailable' : 'resolved',
      homePowerW,
      resolvedHomeMeterDeviceId: homePowerW === null ? null : meterDeviceId,
      cumulativeItemCount: 0,
    };
  }
  const automatic = resolveAutomaticHomePowerReading(report, preferredAutomaticMeterDeviceId);
  if (automatic.state !== 'resolved') {
    return {
      homeMeterResolution: automatic.state,
      homePowerW: null,
      resolvedHomeMeterDeviceId: null,
      cumulativeItemCount: automatic.cumulativeItemCount,
    };
  }
  return {
    homeMeterResolution: 'resolved',
    homePowerW: automatic.watts,
    resolvedHomeMeterDeviceId: automatic.deviceId,
    cumulativeItemCount: automatic.cumulativeItemCount,
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

/**
 * A whole-home PRODUCTION read that discriminates "no generation signal" from
 * "the read failed" — the two things `LivePowerReport.generationW: null`
 * conflates, because `buildEmptyLivePowerReport()` is what both a dead REST
 * client and a thrown fetch return.
 *
 * That conflation is harmless on the `homey_energy` path: a failed report also
 * nulls `homePowerW`, so no sample is recorded and the fabricated null never
 * reaches an accrual. It is NOT harmless on `flow`, where net keeps arriving
 * from the Flow card independently — publishing a failure as a fresh
 * "producing nothing" observation would overwrite a good reading, stamp it
 * `now`, and so slip past the freshness window straight into `generationBuckets`.
 * The adapter owns the classification (root `AGENTS.md`); the caller decides
 * whether to publish.
 *
 * Deliberately narrower than {@link fetchLivePowerReport}: production comes from
 * the report's own `totalGenerated` aggregate, independent of meter selection,
 * so this needs neither the selection nor the per-device/sub-meter lanes.
 */
export type LiveGenerationRead =
  | { readonly state: 'resolved'; readonly generationW: number | null }
  | { readonly state: 'unavailable' };

export async function fetchLiveGenerationW(logger: Logger): Promise<LiveGenerationRead> {
  try {
    const report = await getEnergyLiveReport();
    if (report === null) {
      logger.error({
        event: 'energy_live_generation_unavailable',
        reasonCode: 'rest_client_not_initialized',
      });
      return { state: 'unavailable' };
    }
    return { state: 'resolved', generationW: extractLiveGenerationWatts(report) };
  } catch (error) {
    logDeviceTransportRuntimeError(logger, { event: 'energy_live_generation_fetch_failed' }, error);
    return { state: 'unavailable' };
  }
}

export async function fetchLivePowerReport(params: {
  logger: Logger;
  debugStructured?: StructuredDebugEmitter;
  /** Resolved explicit whole-home meter id; null/undefined = Automatic. */
  meterDeviceId?: string | null;
  /** Previously resolved Automatic meter id, used only to retain a candidate. */
  preferredAutomaticMeterDeviceId?: string | null;
  /** Additional per-meter reading requests (sub-home meters); empty/absent = none. */
  additionalMeterDeviceIds?: readonly string[];
}): Promise<LivePowerReport> {
  const {
    logger,
    debugStructured,
    meterDeviceId,
    preferredAutomaticMeterDeviceId = null,
    additionalMeterDeviceIds = [],
  } = params;
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
    const {
      homeMeterResolution,
      homePowerW,
      resolvedHomeMeterDeviceId,
      cumulativeItemCount,
    } = resolveHomeReading(report, meterDeviceId, preferredAutomaticMeterDeviceId);
    const generationW = extractLiveGenerationWatts(report);
    const additionalMeterPowerW = extractAdditionalMeterPowerW(report, additionalMeterDeviceIds);
    const selectableMeterItemCount = extractLiveMeterItems(report).length;
    const deviceCount = Object.keys(byDeviceId).length;
    (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
      event: 'energy_live_report_received',
      source: 'homey_energy',
      homeMeterResolution,
      homePowerW,
      generationW,
      deviceCount,
      // Always logged, explicit or Automatic: an unattributed whole-home reading
      // is exactly what made a wrong-meter sample undiagnosable.
      resolvedHomeMeterDeviceId,
      ...(meterDeviceId != null ? { meterDeviceId } : { cumulativeItemCount, selectableMeterItemCount }),
      ...(additionalMeterDeviceIds.length > 0
        ? {
          additionalMetersRequested: additionalMeterDeviceIds.length,
          additionalMetersRead: Object.keys(additionalMeterPowerW).length,
        }
        : {}),
    });
    return {
      reportAvailable: true,
      homeMeterResolution,
      byDeviceId,
      homePowerW,
      generationW,
      deviceCount,
      additionalMeterPowerW,
      resolvedHomeMeterDeviceId,
      cumulativeItemCount,
      selectableMeterItemCount,
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
