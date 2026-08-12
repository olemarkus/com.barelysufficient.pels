/**
 * Observer-owned power resolution. Producing layer responsibility per the
 * "resolution belongs in producer" rule: plan and executor consume two flat
 * plan-state-blind values — current draw (for shed accounting) and restore
 * draw (for restore admission) — instead of branching on which raw source
 * carried the value.
 */
import type {
  RestorePowerSource,
} from '../../packages/contracts/src/types';
import { isFiniteNumber } from '../utils/appTypeGuards';
import { normalizeMeasuredPowerKw } from '../../packages/shared-domain/src/measuredPowerObservedState';

// The observer-side re-export of `RestorePowerSource` is gone with
// `getRestoreDrawKw` — it existed so callers of that function could name its
// return type without reaching into contracts, and nothing imports it from here
// any more. The canonical declaration stays in `packages/contracts/src/types`.
type KnownPowerSource = Exclude<RestorePowerSource, 'stepped'>;

export type ObservedPowerInput = {
  /**
   * The producer-resolved current draw. REQUIRED: the raw `measuredPowerKw` no
   * longer travels past a producer boundary, so the one number every caller
   * here has in hand is the resolved one. A producer-side caller that starts
   * from a snapshot resolves it with `getCurrentDrawKw` first.
   */
  currentDrawKw: number;
  /**
   * The producer-resolved expected draw. REQUIRED, and always positive:
   * `estimatePower` ends its ladder on a default rather than on absence, so
   * "nothing is known about this device" is not a state that reaches here.
   */
  expectedPowerKw: number;
  planningPowerKw?: number;
};

/**
 * The PRODUCER's view of a device, for `getCurrentDrawKw` only. Snapshot-shaped:
 * it still has the raw `measuredPowerKw`, because resolving that away is exactly
 * this function's job. Nothing downstream of the producer sees this type.
 */
export type CurrentDrawInput = {
  measuredPowerKw?: number;
};

export type ActivelyDrawingInput = {
  available?: boolean;
  currentOn?: boolean;
  currentDrawKw: number;
};

export const MIN_ACTIVE_MEASURED_POWER_KW = 0.05;

/**
 * What the device is assumed to draw when restored / active — the reservation
 * target for restore admission, pending-restore accounting, and the device's
 * `expectedPowerKw` projection on plan snapshots. Plan-state-blind *and*
 * cycle-blind by design: independent of plannedState, currentOn, and current
 * measurement state, so headroom math, overshoot detection, and overview copy
 * see a stable value across thermostat duty cycles. Drawing a stable configured
 * demand is what avoids over-granting restores when a binary-on thermostat is
 * mid-cycle and momentarily reports `measure_power = 0`.
 *
 * The highest of measured / expected / planning, and TOTAL — there is no null
 * arm and no fallback constant, because `expectedPowerKw` is a required,
 * always-positive producer output. The old `getRestoreDrawKw` wrapper existed
 * only to answer the case where every candidate was absent; the producer no
 * longer emits that case, so the two functions are one. Closes TODO §43.
 *
 * The `'configured'` rung is gone with `powerKw`: it carried the same number as
 * `'expected'` except on the last rung of the estimator, where it smuggled an
 * invented 1 kW past the field that had declined to guess.
 */
export function getHighestKnownPowerKw(
  device: ObservedPowerInput,
): { kw: number; source: KnownPowerSource } {
  const candidates: Array<{ source: KnownPowerSource; value?: number }> = [
    { source: 'measured', value: device.currentDrawKw },
    { source: 'expected', value: device.expectedPowerKw },
    { source: 'planning', value: device.planningPowerKw },
  ];
  let best: { kw: number; source: KnownPowerSource } | null = null;
  for (const candidate of candidates) {
    const value = resolveFinitePositiveKw(candidate.value);
    if (value === null) continue;
    if (best === null || value > best.kw) best = { kw: value, source: candidate.source };
  }
  // Candidate ORDER is load-bearing beyond the max: ties resolve to the earliest
  // entry, so a device measuring exactly what it is expected to draw still
  // reports `'measured'`. Reordering this list to put the guaranteed field first
  // silently relabels every such tie.
  //
  // `expectedPowerKw` is required and always positive, so the loop cannot come up
  // empty and this tail is unreachable under the contract. It answers `0` rather
  // than passing `device.expectedPowerKw` through, because the only way to get
  // here is for that value to have FAILED the finiteness filter above — and
  // handing a raw `Infinity`/`NaN` to consumers that trust this number implicitly
  // is precisely what the boundary rule forbids. `0` under-reserves; junk
  // poisons every headroom sum it reaches.
  return best ?? { kw: 0, source: 'expected' };
}

/**
 * What this device is drawing right now, in kW: the meter's answer, and nothing
 * else.
 *
 * PRODUCER-ONLY. Call it at a producer boundary (`toPlanDevice`,
 * `withHeadroomCurrentOn`, `buildResidualKwForPlanDevice`) to resolve
 * `currentDrawKw` once. Plan and executor code reads that resolved field and
 * never comes back here.
 *
 * `DeviceMeasuredPowerResolver.selectSource` has already collapsed the three real
 * sources into one number: `measure_power`, a `meter_power` delta, and the Homey
 * Energy live reading. A reported `0` is an ANSWER — the device is drawing
 * nothing — and it stops here. Crediting a nameplate over a real zero is the
 * defect this whole change exists to remove.
 *
 * There is deliberately NO declared-load rung, and no fallback constant.
 *
 * A declared load looked like it deserved one: an Elko thermostat configured with
 * `settings.load: 900` plainly knows something about itself. But that population
 * is already metered — across a 124-device fleet, every device carrying
 * `settings.load` also exposes plain `measure_power` and `meter_power`, and zero
 * devices qualify for management on the declared load alone. So the rung would
 * have described no one, while costing the contract its most useful property:
 * a declared load is a CONSTANT that does not fall to zero when the device is
 * switched off, so reading it here would mean `currentDrawKw > 0` no longer
 * implied "drawing". A satisfied thermostat reports its own honest `0 W`
 * instead — verified against a real device (`no.elko:smart_plus_thermostat`,
 * `measure_power: 0` while at target, `settings.load: 900`).
 *
 * `EV_MIN_START_FALLBACK_KW` (1.38) and `DEFAULT_FALLBACK_KW` (1.0) are gone for
 * the same reason, one step further out: guesses about a device nobody described.
 *
 * It consults NO plan state. There is no `currentOn` branch, and with no declared
 * load to qualify it none is needed: the meter already reports 0 when the device
 * is off.
 */
export function getCurrentDrawKw(device: CurrentDrawInput): number {
  // The same `normalizeMeasuredPowerKw` every snapshot write seam applies — one
  // rule, not a fourth hand-rolled guard. It is the backstop rather than the only
  // line of defence: a presence check here would pass `null` and `NaN` (the
  // snapshot guard next door, `hasObservedMeasuredPower`, uses `!= null`, so its
  // author considered `null` reachable), and a bare finiteness check would pass a
  // discharging battery's negative watts to consumers that cannot question them.
  //
  // A rejected reading is absence, and absence resolves to 0 here for the same
  // reason a device with no meter does — nothing is known to be drawn.
  return normalizeMeasuredPowerKw(device.measuredPowerKw) ?? 0;
}

/**
 * True when the device is observably on or drawing power right now. Used by
 * activation backoff and other lifecycle gates that must not penalize
 * planner-driven sheds or unobserved devices.
 */
export function isActivelyDrawing(observation: ActivelyDrawingInput): boolean {
  if (observation.available === false) return false;
  if (observation.currentOn === true) return true;
  return observation.currentDrawKw > MIN_ACTIVE_MEASURED_POWER_KW;
}

function resolveFinitePositiveKw(value: number | undefined): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value <= 0) return null;
  return value;
}
