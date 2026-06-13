import type { Logger as PinoLogger } from 'pino';
import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import { isUnknownRecord } from '../utils/types';
import { fetchDeviceDailyKwh, meterCapabilityOf, quantileSorted } from './meterKwhBackfill';
import { applyControlledBackfill, CONTROLLED_BACKFILL_VERSION } from './weatherHistory';

/**
 * One-shot reconstruction of historical CONTROLLED (PELS-managed) daily kWh by
 * summing each managed device's own cumulative meter Insights — so the
 * uncontrolled split (whole-home total − controlled) exists for the backfilled
 * year instead of only from the next rollup forward. Uncontrolled load is
 * never suppressed by PELS, so its temperature response is an uncensored
 * ground-truth signal; backfilling it lets a later estimator reconstruct
 * historical censoring (controlled shortfall vs weather expectation) that the
 * diagnostics layer prunes after ~21 days.
 *
 * Validation is MEDIAN-only against the tracker's controlled totals, not
 * per-day: in flow power-source mode the tracker integrates irregularly-timed
 * samples, so ITS per-day controlled numbers are the noisy side — the exact
 * cumulative device meters are cleaner. The systematic level (median ratio)
 * confirms the reconstruction; per-day scatter is the reference's noise. A
 * loose spread floor still rejects gross garbage (a wrong device set). The
 * sum has a known blind spot: a managed device with no cumulative meter (e.g.
 * a bare relay) contributes nothing, leaving its share in "uncontrolled" — the
 * median gate keeps that bounded.
 */

const MIN_OVERLAP_DAYS = 14;
const RATIO_MIN = 0.9;
const RATIO_MAX = 1.1;
/**
 * Per-day ratios scatter widely in flow mode (the tracker reference is noisy),
 * so the spread gate is deliberately loose — it exists only to reject a
 * grossly-wrong device set (e.g. summing the whole home), not to certify
 * per-day accuracy the way the whole-home meter backfill's tight quartiles do.
 */
const RATIO_Q25_FLOOR = 0.5;
const RATIO_Q75_CEIL = 1.6;

export type ControlledKwhBackfillOutcome =
  | {
    outcome: 'resolved';
    controlledDailyKwh: Record<string, number>;
    overlapDays: number;
    medianRatio: number;
    devicesUsed: number;
    devicesMissingMeter: number;
    /** False if any managed device's meter failed to read — caller must not latch its marker. */
    complete: boolean;
  }
  | { outcome: 'no_devices' }
  | { outcome: 'not_validated'; overlapDays: number; medianRatio: number; devicesUsed: number };

export type ControlledKwhBackfillDeps = {
  /** Read-only GET against the Homey Web API (path without leading slash). */
  fetchFromHomeyApi: (path: string) => Promise<unknown>;
  /** Whether PELS manages (controls) a device — the flat managed predicate from the factory. */
  isManaged: (deviceId: string) => boolean;
  /** Tracker's controlled daily kWh, the validation reference; undefined when the day is unknown. */
  getControlledDailyKwh: (dateKey: string) => number | undefined;
  timeZone: string;
  nowMs: number;
};

export async function resolveControlledDailyKwh(
  deps: ControlledKwhBackfillDeps,
): Promise<ControlledKwhBackfillOutcome> {
  const devices = await deps.fetchFromHomeyApi('manager/devices/device');
  const managedMeters = listManagedMeters(devices, deps.isManaged);
  if (managedMeters.length === 0) return { outcome: 'no_devices' };

  const controlledDailyKwh = new Map<string, number>();
  let devicesUsed = 0;
  let devicesMissingMeter = 0;
  let anyIncomplete = false;
  for (const meter of managedMeters) {
    const { dailyKwh, complete } = await fetchDeviceDailyKwh({
      deviceId: meter.deviceId,
      capability: meter.capability,
      fetchFromHomeyApi: deps.fetchFromHomeyApi,
      timeZone: deps.timeZone,
      nowMs: deps.nowMs,
    });
    if (!complete) anyIncomplete = true;
    const dayKeys = Object.keys(dailyKwh);
    if (dayKeys.length === 0) {
      devicesMissingMeter += 1;
      continue;
    }
    devicesUsed += 1;
    for (const [dateKey, kwh] of Object.entries(dailyKwh)) {
      controlledDailyKwh.set(dateKey, (controlledDailyKwh.get(dateKey) ?? 0) + kwh);
    }
  }

  const summed = Object.fromEntries(controlledDailyKwh);
  const validation = validateAgainstTrackerControlled(summed, deps.getControlledDailyKwh);
  if (!validation.passed) {
    return {
      outcome: 'not_validated',
      overlapDays: validation.overlapDays,
      medianRatio: validation.medianRatio,
      devicesUsed,
    };
  }
  return {
    outcome: 'resolved',
    controlledDailyKwh: summed,
    overlapDays: validation.overlapDays,
    medianRatio: validation.medianRatio,
    devicesUsed,
    devicesMissingMeter,
    complete: !anyIncomplete,
  };
}

type ManagedMeter = { deviceId: string; capability: string };

function listManagedMeters(devicesResponse: unknown, isManaged: (deviceId: string) => boolean): ManagedMeter[] {
  if (!isUnknownRecord(devicesResponse)) return [];
  return Object.values(devicesResponse).flatMap((device) => {
    if (!isUnknownRecord(device)) return [];
    const deviceId = device.id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) return [];
    if (!isManaged(deviceId)) return [];
    const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
    const capability = meterCapabilityOf(capabilities);
    return capability === undefined ? [] : [{ deviceId, capability }];
  });
}

function validateAgainstTrackerControlled(
  controlledDailyKwh: Record<string, number>,
  getControlledDailyKwh: ControlledKwhBackfillDeps['getControlledDailyKwh'],
): { passed: boolean; overlapDays: number; medianRatio: number } {
  const ratios = Object.entries(controlledDailyKwh).flatMap(([dateKey, summedKwh]) => {
    const trackerKwh = getControlledDailyKwh(dateKey);
    if (trackerKwh === undefined || trackerKwh <= 0) return [];
    return [summedKwh / trackerKwh];
  });
  if (ratios.length < MIN_OVERLAP_DAYS) return { passed: false, overlapDays: ratios.length, medianRatio: 0 };
  const sorted = [...ratios].sort((a, b) => a - b);
  const medianRatio = quantileSorted(sorted, 0.5);
  const centered = medianRatio >= RATIO_MIN && medianRatio <= RATIO_MAX;
  const notGarbage = quantileSorted(sorted, 0.25) >= RATIO_Q25_FLOOR && quantileSorted(sorted, 0.75) <= RATIO_Q75_CEIL;
  return { passed: centered && notGarbage, overlapDays: ratios.length, medianRatio };
}

/**
 * Applies a controlled-backfill outcome to the history state: fills the split,
 * stamps the version marker (only on a complete run), recomputes derived
 * fields, and logs. Returns the next state plus whether it needs persisting.
 * Lives here (not in the collector) so the orchestration stays with its domain
 * and the collector wrapper is just the run/generation guard.
 */
export function applyControlledOutcome(params: {
  state: WeatherHistoryState;
  result: ControlledKwhBackfillOutcome;
  // Least-privilege: this orchestration only emits info-level events. Narrowing
  // to the methods used lets tests pass a plain typed mock with no `as` cast.
  logger: Pick<PinoLogger, 'info'>;
}): { state: WeatherHistoryState; dirty: boolean } {
  const { state, result, logger } = params;
  if (result.outcome !== 'resolved') {
    logger.info({
      event: 'weather_controlled_backfill_no_source',
      outcome: result.outcome,
      ...(result.outcome === 'not_validated'
        ? { overlapDays: result.overlapDays, medianRatio: result.medianRatio, devicesUsed: result.devicesUsed }
        : {}),
    });
    // Deliberately do NOT latch on a failed/absent validation: a meter added
    // later, or a managed-set change, must still be adoptable on a future boot.
    // The cost is one bounded read-only device sweep per app restart on a
    // structurally-unvalidatable home (no terminal state) — accepted for a
    // hidden, advisory feature; a managed-set-change re-attempt is the proper
    // long-term off-ramp (deferred).
    return { state, dirty: false };
  }
  const applied = applyControlledBackfill(state, result.controlledDailyKwh);
  // No recomputeDerived: the energy-signature fit reads kwhTotal + temp only,
  // never the controlled/uncontrolled split, so a split-only patch cannot move
  // any derived field. Re-running the O(n²) fit here would only emit a
  // duplicate, identical `weather_advisor_fit` line. (Re-add if a future fit
  // ever conditions on the split.)
  const next: WeatherHistoryState = {
    ...applied.state,
    ...(result.complete ? { controlledBackfillVersion: CONTROLLED_BACKFILL_VERSION } : {}),
  };
  logger.info({
    event: 'weather_controlled_backfill_completed',
    patchedDays: applied.patchedDays,
    overlapDays: result.overlapDays,
    medianRatio: result.medianRatio,
    devicesUsed: result.devicesUsed,
    devicesMissingMeter: result.devicesMissingMeter,
    complete: result.complete,
  });
  return { state: next, dirty: applied.patchedDays > 0 || result.complete };
}
