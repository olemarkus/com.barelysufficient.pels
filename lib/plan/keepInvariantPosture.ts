import type { PlanInputDevice } from './planTypes';

// Builds the effective shed posture used by the keep-invariant clamp on the shed side
// (docs/technical.md:222). Mirrors hasExecutableShedDevices in lib/executor/executablePlanProjection.ts
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

export function isAnyOtherDeviceLimited(shedSet: Set<string>, deviceId: string): boolean {
  if (shedSet.size === 0) return false;
  if (!shedSet.has(deviceId)) return true;
  return shedSet.size > 1;
}

/**
 * The keep-step twin of `countFairnessLimitedDevices` (`lib/plan/restore/coordination.ts`):
 * is a device this one yields to limited this cycle? Any other limited device,
 * or, for a boosted device, only one ranked above it: a boost takes power from
 * lower-priority devices and never from one ranked above it (owner ruling
 * 2026-11-03). Priority 1 ranks highest. `priorityById` is the cycle's planned
 * devices' ranks, built once per cycle by the caller.
 */
export function isFairnessLimited(
  shedSet: Set<string>,
  device: Pick<PlanInputDevice, 'id' | 'priority'>,
  boostActive: boolean,
  priorityById: ReadonlyMap<string, number>,
): boolean {
  if (!boostActive) return isAnyOtherDeviceLimited(shedSet, device.id);
  for (const id of shedSet) {
    if (id === device.id) continue;
    const priority = priorityById.get(id);
    if (priority !== undefined && priority < device.priority) return true;
  }
  return false;
}
