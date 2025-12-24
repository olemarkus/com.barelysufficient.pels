import CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import type { PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import {
  RECENT_RESTORE_OVERSHOOT_BYPASS_KW,
  RECENT_RESTORE_SHED_GRACE_MS,
} from './planConstants';

export type SheddingPlan = {
  shedSet: Set<string>;
  shedReasons: Map<string, string>;
  sheddingActive: boolean;
  guardInShortfall: boolean;
  updates: {
    lastOvershootMs?: number;
    lastShedPlanMeasurementTs?: number;
  };
};

export type SheddingDeps = {
  capacityGuard: CapacityGuard | undefined;
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  getPriorityForDevice: (deviceId: string) => number;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};

type ShedCandidate = PlanInputDevice & { priority: number; effectivePower: number };

type ShedCandidateParams = {
  devices: PlanInputDevice[];
  needed: number;
  state: PlanEngineState;
  deps: SheddingDeps;
};

export async function buildSheddingPlan(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
): Promise<SheddingPlan> {
  const { shedSet, shedReasons, updates } = planShedding(context, state, deps);
  const guardResult = await updateGuardState({
    headroom: context.headroom,
    devices: context.devices,
    shedSet,
    capacityGuard: deps.capacityGuard,
  });
  const guardInShortfall = deps.capacityGuard?.isInShortfall() ?? false;
  return {
    shedSet,
    shedReasons,
    sheddingActive: guardResult.sheddingActive,
    guardInShortfall,
    updates,
  };
}

function shouldPlanShedding(headroom: number | null): boolean {
  return headroom !== null && headroom < 0;
}

function planShedding(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
): { shedSet: Set<string>; shedReasons: Map<string, string>; updates: { lastOvershootMs?: number; lastShedPlanMeasurementTs?: number } } {
  const shedSet = new Set<string>();
  const shedReasons = new Map<string, string>();
  if (!shouldPlanShedding(context.headroom)) {
    return { shedSet, shedReasons, updates: {} };
  }

  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const alreadyShedThisSample = measurementTs !== null && measurementTs === state.lastShedPlanMeasurementTs;
  if (alreadyShedThisSample) {
    deps.logDebug('Plan: skipping additional shedding until a new power measurement arrives');
    return { shedSet, shedReasons, updates: {} };
  }

  // Type narrowing: headroom is guaranteed to be non-null here due to shouldPlanShedding check
  if (context.headroom === null) {
    return { shedSet, shedReasons, updates: {} };
  }
  const needed = -context.headroom;
  deps.logDebug(
    `Planning shed: soft=${context.softLimit.toFixed(3)} headroom=${context.headroom.toFixed(
      3,
    )} total=${context.total === null ? 'unknown' : context.total.toFixed(3)}`,
  );
  const candidates = buildSheddingCandidates({
    devices: context.devices,
    needed,
    state,
    deps,
  });
  const result = selectShedDevices(candidates, needed, deps.log);
  result.shedSet.forEach((id) => shedSet.add(id));
  result.shedReasons.forEach((reason, id) => shedReasons.set(id, reason));

  if (shedSet.size === 0) {
    return { shedSet, shedReasons, updates: {} };
  }
  const updates = {
    lastOvershootMs: Date.now(),
    ...(measurementTs !== null ? { lastShedPlanMeasurementTs: measurementTs } : {}),
  };
  return { shedSet, shedReasons, updates };
}

function buildSheddingCandidates(params: ShedCandidateParams): ShedCandidate[] {
  const { devices, needed, state, deps } = params;
  const nowTs = Date.now();
  return devices
    .filter((d) => d.controllable !== false && d.currentOn !== false)
    .map((d) => addCandidatePower(d, deps.getPriorityForDevice))
    .filter((d) => isNotAtShedTemperature(d, deps.getShedBehavior))
    .filter((d) => isNotRecentlyRestored(d, state, nowTs, needed, deps.logDebug))
    .sort(sortCandidates);
}

function addCandidatePower(
  device: PlanInputDevice,
  getPriority: (deviceId: string) => number,
): ShedCandidate {
  const priority = getPriority(device.id);
  let power: number;
  if (typeof device.measuredPowerKw === 'number') {
    power = Math.max(0, device.measuredPowerKw);
  } else if (typeof device.expectedPowerKw === 'number' && device.expectedPowerKw > 0) {
    power = device.expectedPowerKw;
  } else if (typeof device.powerKw === 'number' && device.powerKw > 0) {
    power = device.powerKw;
  } else {
    power = 1;
  }
  return { ...device, priority, effectivePower: power };
}

function isNotAtShedTemperature(
  device: ShedCandidate,
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null },
): boolean {
  const shedBehavior = getShedBehavior(device.id);
  if (shedBehavior.action !== 'set_temperature' || shedBehavior.temperature === null) return true;
  const currentTarget = device.targets?.[0]?.value;
  return !(typeof currentTarget === 'number' && currentTarget === shedBehavior.temperature);
}

function isNotRecentlyRestored(
  device: ShedCandidate,
  state: PlanEngineState,
  nowTs: number,
  needed: number,
  logDebug: (...args: unknown[]) => void,
): boolean {
  const lastRestore = state.lastDeviceRestoreMs[device.id];
  if (!lastRestore) return true;
  const sinceRestoreMs = nowTs - lastRestore;
  const recentlyRestored = sinceRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
  const overshootSevere = needed > RECENT_RESTORE_OVERSHOOT_BYPASS_KW;
  if (recentlyRestored && !overshootSevere) {
    logDebug(
      `Plan: protecting ${device.name} from shedding (recently restored ${Math.round(sinceRestoreMs / 1000)}s ago, overshoot ${needed.toFixed(2)}kW)`,
    );
    return false;
  }
  return true;
}

function sortCandidates(a: ShedCandidate, b: ShedCandidate): number {
  const pa = a.priority ?? 100;
  const pb = b.priority ?? 100;
  if (pa !== pb) return pb - pa; // Higher number sheds first
  return b.effectivePower - a.effectivePower;
}

function selectShedDevices(
  candidates: ShedCandidate[],
  needed: number,
  log: (...args: unknown[]) => void,
): { shedSet: Set<string>; shedReasons: Map<string, string> } {
  const shedSet = new Set<string>();
  const shedReasons = new Map<string, string>();
  let remaining = needed;
  const totalSheddable = candidates.reduce((sum, c) => sum + c.effectivePower, 0);
  log(`Plan: overshoot=${needed.toFixed(2)}kW, candidates=${candidates.length}, totalSheddable=${totalSheddable.toFixed(2)}kW`);
  for (const candidate of candidates) {
    if (candidate.effectivePower <= 0) continue;
    if (remaining <= 0) break;
    shedSet.add(candidate.id);
    shedReasons.set(candidate.id, 'shed due to capacity');
    remaining -= candidate.effectivePower;
  }
  return { shedSet, shedReasons };
}

async function updateGuardState(params: {
  headroom: number | null;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  capacityGuard: CapacityGuard | undefined;
}): Promise<{ sheddingActive: boolean }> {
  const { headroom, devices, shedSet, capacityGuard } = params;
  if (shouldActivateShedding(headroom, shedSet)) {
    const remainingCandidates = countRemainingCandidates(devices, shedSet, headroom);
    const deficitKw = headroom !== null ? -headroom : 0;
    await capacityGuard?.setSheddingActive(true);
    await capacityGuard?.checkShortfall(remainingCandidates > 0, deficitKw);
    return { sheddingActive: true };
  }

  const restoreMargin = capacityGuard?.getRestoreMargin() ?? 0.2;
  const canDisable = headroom !== null && headroom >= restoreMargin;
  const current = capacityGuard?.isSheddingActive() ?? false;
  if (canDisable) {
    await capacityGuard?.setSheddingActive(false);
  }
  await capacityGuard?.checkShortfall(true, 0);
  return { sheddingActive: canDisable ? false : current };
}

function shouldActivateShedding(headroom: number | null, shedSet: Set<string>): boolean {
  if (shedSet.size > 0) return true;
  return headroom !== null && headroom < 0;
}

function countRemainingCandidates(
  devices: PlanInputDevice[],
  shedSet: Set<string>,
  headroom: number | null,
): number {
  if (headroom === null || headroom >= 0) return 0;
  return devices.filter((d) => d.controllable !== false && d.currentOn !== false && !shedSet.has(d.id)).length;
}
