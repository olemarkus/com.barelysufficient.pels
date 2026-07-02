import type { PlanInputDevice } from './planTypes';

// Builds the effective shed posture used by the keep-invariant clamp on the shed side
// (docs/technical.md:222). Mirrors hasExecutableShedDevices in lib/executor/executablePlanProjection.ts
// by dropping shedSet entries that must NOT count as capacity-shed posture, via the
// caller-supplied predicate. The caller decides exclusion because it requires the planner's
// stepped shed resolver (phantom set_step drops) AND the surplus-hold state (a "Run on solar
// surplus" hold is an opt-in posture, not capacity pressure — it must not clamp unrelated
// stepped loads to their lowest step).
export function buildEffectiveShedPosture(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  isExcluded: (dev: PlanInputDevice) => boolean;
}): Set<string> {
  const { devices, shedSet, isExcluded } = params;
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
