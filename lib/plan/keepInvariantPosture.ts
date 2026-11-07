import type { PlanInputDevice } from './planTypes';
import { yieldsToLimitedDevice } from './steppedFairness';

// Builds the effective shed posture used by the keep-invariant clamp on the shed side
// (docs/technical.md:222). Mirrors hasExecutableShedDevices in lib/plan/planExecutionProjection.ts
// by dropping shedSet entries that must NOT count as capacity-shed posture, via the
// caller-supplied predicate. The caller decides exclusion because it requires the planner's
// stepped shed resolver (phantom set_step drops) AND the surplus-hold state (a "Run on solar
// surplus" hold is an opt-in posture, not capacity pressure — it must not clamp unrelated
// stepped loads to their lowest step).
export function buildEffectiveShedPosture(
  devices: PlanInputDevice[],
  shedSet: Set<string>,
  isExcluded: (dev: PlanInputDevice) => boolean,
): Set<string> {
  if (shedSet.size === 0) return shedSet;
  const result = new Set<string>();
  const byId = new Map(devices.map((d) => [d.id, d]));
  for (const id of shedSet) {
    const dev = byId.get(id);
    if (!dev) { result.add(id); continue; }
    if (isExcluded(dev)) continue;
    result.add(id);
  }
  return result;
}

/**
 * Apply the shared priority rule to this cycle's effective limited posture.
 * The device map contains the actual inputs, built once per cycle by the caller.
 */
export function isFairnessLimited(
  shedSet: Set<string>,
  device: Pick<PlanInputDevice, 'id' | 'priority'>,
  boostActive: boolean,
  devicesById: ReadonlyMap<string, Pick<PlanInputDevice, 'id' | 'priority'>>,
): boolean {
  for (const id of shedSet) {
    const limitedDevice = devicesById.get(id);
    if (limitedDevice && yieldsToLimitedDevice(device, boostActive, limitedDevice)) return true;
  }
  return false;
}
