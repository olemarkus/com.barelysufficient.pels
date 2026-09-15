/**
 * THE per-build map of every temperature device's `set_temperature` limit, as
 * the planner compares against it. The value is resolved before the planner,
 * capability-normalized, on `TemperatureSetpoints.shed`; this is only its
 * projection into the one shape the equality checks read.
 *
 * One rule, one map: every EQUALITY check against a configured limit in
 * `lib/plan` — hold gating, observed-at-floor, pending-restore delay, hold
 * stamps, restore classification — reads through `shedFloorCFor` over the map
 * the builder projects once per build. Raw `behavior.temperature` used to leak
 * into comparisons piecemeal, and every leak was the same bug: for a configured
 * limit off the device's step, the device converges to the NORMALIZED value, so
 * a raw comparison never matches what the device actually reports — a
 * post-restart off-step device classified as "not at its limit" could restore
 * straight through startup stabilization.
 *
 * Equality only. Whether moving a device to its limit still releases demand is
 * an ORDERING of setpoints, which depends on whether the device heats or cools;
 * it is resolved before the planner (`ResolvedShedBehavior.releasesDemand`).
 */
import type { TemperatureSetpointsByDevice } from '../../packages/planner-types/src/temperatureSetpoints';

/**
 * The setpoint limit of every temperature device limited by setpoint this
 * build. A device limited by turning it off or stepping it down gets no entry.
 */
export function resolveNormalizedShedFloors(setpoints: TemperatureSetpointsByDevice): ReadonlyMap<string, number> {
  const floors = new Map<string, number>();
  for (const [deviceId, { shed }] of setpoints) {
    if (shed.action === 'set_temperature') floors.set(deviceId, shed.limitC);
  }
  return floors;
}

/**
 * Read a floor after narrowing to a temperature device with `set_temperature`
 * behavior. `resolveNormalizedShedFloors` guarantees an entry for that device;
 * consumers trust the resolved map instead of re-deriving from raw settings.
 */
export function shedFloorCFor(
  floors: ReadonlyMap<string, number>,
  deviceId: string,
): number {
  return floors.get(deviceId)!;
}
