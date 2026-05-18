import type { PlanInputDevice } from './planTypes';

// Builds the executable shed posture used by the keep-invariant clamp on the shed side
// (docs/technical.md:222). Mirrors hasExecutableShedDevices in lib/executor/executablePlanProjection.ts
// by excluding phantom shedSet entries via the caller-supplied predicate. Caller resolves
// "phantom" because phantom-ness requires access to the planner's stepped shed resolver.
export function buildEffectiveShedPosture(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  isPhantom: (dev: PlanInputDevice) => boolean;
}): Set<string> {
  const { devices, shedSet, isPhantom } = params;
  if (shedSet.size === 0) return shedSet;
  const result = new Set<string>();
  const byId = new Map(devices.map((d) => [d.id, d]));
  for (const id of shedSet) {
    const dev = byId.get(id);
    if (!dev) { result.add(id); continue; }
    if (isPhantom(dev)) continue;
    result.add(id);
  }
  return result;
}

export function isAnyOtherDeviceLimited(shedSet: Set<string>, deviceId: string): boolean {
  if (shedSet.size === 0) return false;
  if (!shedSet.has(deviceId)) return true;
  return shedSet.size > 1;
}
