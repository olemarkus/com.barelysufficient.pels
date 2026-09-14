/**
 * THE per-build resolution of every temperature device's `set_temperature`
 * shed floor, capability-normalized (`normalizeTargetCapabilityValue` over the
 * device's primary target — the same primitive `resolveShedIntent` and the
 * shed candidate builder apply at their own derivation points).
 *
 * One rule, one map: every COMPARISON against a configured shed floor in
 * `lib/plan` — hold gating, observed-at-floor, pending-restore delay, swap-out
 * eligibility, hold stamps, restore classification — reads through
 * `shedFloorCFor` over the map the builder resolves once per build. Raw
 * `behavior.temperature` used to leak into comparisons piecemeal, and every
 * leak was the same bug: for a configured floor off the device's step (the
 * validator checks generic bounds, not the capability), the device converges
 * to the NORMALIZED value, so a raw comparison never matches what the device
 * actually reports — a post-restart off-step-floor device classified as "not
 * at its floor" could restore straight through startup stabilization.
 */
import type { PlanInputDevice, ShedBehavior } from './planTypes';
import type { ThermalDirection } from '../../packages/contracts/src/types';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { getPrimaryTargetCapability, normalizeTargetCapabilityValue } from '../utils/targetCapabilities';

/**
 * One device's setpoint limit for this build: the capability-normalized
 * setpoint PELS may move it to, and which way from a setpoint is more demand.
 *
 * The direction rides with the limit because every reader that compares a
 * setpoint against the limit also has to order two setpoints — "is this move a
 * resume", "would moving it to its limit still release demand" — and the answer
 * is opposite for a unit that is cooling. The map only holds devices limited by
 * setpoint, which is exactly the set those readers ask about.
 */
export type ShedSetpointLimit = {
  readonly temperatureC: number;
  readonly thermalDirection: ThermalDirection;
};

export type ShedSetpointLimits = ReadonlyMap<string, ShedSetpointLimit>;

/**
 * Resolve the capability-normalized `set_temperature` shed floor for every
 * temperature device in this build's input set. Devices without a
 * `set_temperature` behaviour (or without a temperature cluster) get no entry.
 * Called once per build by the builder; the result feeds the restore/swap
 * pass, the hold lane, reason normalization, and restore classification.
 */
export function resolveNormalizedShedFloors(
  devices: readonly PlanInputDevice[],
  getShedBehavior: (deviceId: string) => ShedBehavior,
): ShedSetpointLimits {
  const floors = new Map<string, ShedSetpointLimit>();
  for (const dev of devices) {
    if (!isTemperaturePlanDevice(dev)) continue;
    const behavior = getShedBehavior(dev.id);
    if (behavior.action !== 'set_temperature') continue;
    floors.set(dev.id, {
      temperatureC: normalizeTargetCapabilityValue({
        target: getPrimaryTargetCapability(dev.targets),
        value: behavior.temperature,
      }),
      thermalDirection: dev.thermalDirection,
    });
  }
  return floors;
}

/**
 * Read a floor after narrowing to a temperature device with `set_temperature`
 * behavior. `resolveNormalizedShedFloors` guarantees an entry for that device;
 * consumers trust the resolved map instead of re-deriving from raw settings.
 */
export function shedFloorCFor(
  floors: ShedSetpointLimits,
  deviceId: string,
): number {
  return shedLimitFor(floors, deviceId).temperatureC;
}

/** The whole limit, for a reader that also orders setpoints. Same guarantee as {@link shedFloorCFor}. */
export function shedLimitFor(
  floors: ShedSetpointLimits,
  deviceId: string,
): ShedSetpointLimit {
  return floors.get(deviceId)!;
}
