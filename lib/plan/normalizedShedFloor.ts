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
import type { PlanInputDevice, TemperatureShedBehavior, ShedBehavior } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { getPrimaryTargetCapability, normalizeTargetCapabilityValue } from '../utils/targetCapabilities';

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
): ReadonlyMap<string, number> {
  const floors = new Map<string, number>();
  for (const dev of devices) {
    if (!isTemperaturePlanDevice(dev)) continue;
    const behavior = getShedBehavior(dev.id);
    if (behavior.action !== 'set_temperature') continue;
    floors.set(dev.id, normalizeTargetCapabilityValue({
      target: getPrimaryTargetCapability(dev.targets),
      value: behavior.temperature,
    }));
  }
  return floors;
}

/**
 * The one accessor comparisons go through. The raw-config fallback is the
 * map-absent identity for scalar-only direct callers (test harnesses that
 * pass flat integer floors with an empty map) — production always resolves an
 * entry for a temperature device with a `set_temperature` behaviour, so raw
 * config is never compared against an observation there.
 */
export function shedFloorCFor(
  floors: ReadonlyMap<string, number>,
  deviceId: string,
  behavior: TemperatureShedBehavior,
): number {
  const normalized = floors.get(deviceId);
  return normalized === undefined ? behavior.temperature : normalized;
}
