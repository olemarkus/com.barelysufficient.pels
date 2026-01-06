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
  overshootStats: {
    needed: number;
    candidates: number;
    totalSheddable: number;
  } | null;
};

export type SheddingDeps = {
  capacityGuard: CapacityGuard | undefined;
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  getPriorityForDevice: (deviceId: string) => number;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};

type BaseShedCandidate = PlanInputDevice & { priority: number; effectivePower: number };
type ShedCandidate = BaseShedCandidate & { recentlyRestored: boolean };

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
  const { shedSet, shedReasons, updates, overshootStats } = planShedding(context, state, deps);
  const guardResult = await updateGuardState({
    headroom: context.headroom,
    capacitySoftLimit: context.capacitySoftLimit,
    softLimitSource: context.softLimitSource,
    total: context.total,
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
    overshootStats,
  };
}

function shouldPlanShedding(headroom: number | null): boolean {
  return headroom !== null && headroom < 0;
}

function planShedding(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
): {
  shedSet: Set<string>;
  shedReasons: Map<string, string>;
  updates: { lastOvershootMs?: number; lastShedPlanMeasurementTs?: number };
  overshootStats: SheddingPlan['overshootStats'];
} {
  const shedSet = new Set<string>();
  const shedReasons = new Map<string, string>();
  if (!shouldPlanShedding(context.headroom)) {
    return { shedSet, shedReasons, updates: {}, overshootStats: null };
  }

  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const alreadyShedThisSample = measurementTs !== null && measurementTs === state.lastShedPlanMeasurementTs;
  if (alreadyShedThisSample) {
    deps.logDebug('Plan: skipping additional shedding until a new power measurement arrives');
    return { shedSet, shedReasons, updates: {}, overshootStats: null };
  }

  // Type narrowing: headroom is guaranteed to be non-null here due to shouldPlanShedding check
  if (context.headroom === null) {
    return { shedSet, shedReasons, updates: {}, overshootStats: null };
  }
  const needed = -context.headroom;
  deps.logDebug(
    `Planning shed: soft=${context.softLimit.toFixed(3)} headroom=${context.headroom.toFixed(
      3,
    )} total=${context.total === null ? 'unknown' : context.total.toFixed(3)}`,
  );
  const shedReason = resolveShedReason(context.softLimitSource);
  const candidates = buildSheddingCandidates({
    devices: context.devices,
    needed,
    state,
    deps,
  });
  const result = selectShedDevices(candidates, needed, shedReason);
  result.shedSet.forEach((id) => shedSet.add(id));
  result.shedReasons.forEach((reason, id) => shedReasons.set(id, reason));

  if (shedSet.size === 0) {
    return { shedSet, shedReasons, updates: {}, overshootStats: null };
  }
  const updates = {
    lastOvershootMs: Date.now(),
    ...(measurementTs !== null ? { lastShedPlanMeasurementTs: measurementTs } : {}),
  };
  const candidateCount = candidates.length;
  const totalSheddable = candidates.reduce((sum, c) => sum + c.effectivePower, 0);
  return {
    shedSet,
    shedReasons,
    updates,
    overshootStats: {
      needed,
      candidates: candidateCount,
      totalSheddable,
    },
  };
}

function buildSheddingCandidates(params: ShedCandidateParams): ShedCandidate[] {
  const { devices, needed, state, deps } = params;
  const nowTs = Date.now();
  return devices
    .filter((d) => d.controllable !== false && d.currentOn !== false)
    .map((d) => addCandidatePower(d, deps.getPriorityForDevice))
    .filter((candidate): candidate is BaseShedCandidate => candidate !== null)
    .map((candidate) => addRecentRestoreState(candidate, state, nowTs, needed, deps.logDebug))
    .filter((d) => isNotAtShedTemperature(d, deps.getShedBehavior))
    .sort(sortCandidates);
}

function resolveCandidatePower(device: PlanInputDevice): number | null {
  const measured = device.measuredPowerKw;
  if (typeof measured === 'number' && Number.isFinite(measured)) {
    return measured > 0 ? measured : null;
  }
  if (typeof device.expectedPowerKw === 'number' && device.expectedPowerKw > 0) {
    return device.expectedPowerKw;
  }
  if (typeof device.powerKw === 'number' && device.powerKw > 0) {
    return device.powerKw;
  }
  return 1;
}

function addCandidatePower(
  device: PlanInputDevice,
  getPriority: (deviceId: string) => number,
): BaseShedCandidate | null {
  const power = resolveCandidatePower(device);
  if (power === null) return null;
  const priority = getPriority(device.id);
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

function addRecentRestoreState(
  device: BaseShedCandidate,
  state: PlanEngineState,
  nowTs: number,
  needed: number,
  logDebug: (...args: unknown[]) => void,
): ShedCandidate {
  const lastRestore = state.lastDeviceRestoreMs[device.id];
  if (!lastRestore) return { ...device, recentlyRestored: false };
  const sinceRestoreMs = nowTs - lastRestore;
  const recentlyRestored = sinceRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
  const overshootSevere = needed > RECENT_RESTORE_OVERSHOOT_BYPASS_KW;
  if (recentlyRestored && !overshootSevere) {
    logDebug(
      `Plan: deprioritizing ${device.name} for shedding (recently restored ${Math.round(sinceRestoreMs / 1000)}s ago, overshoot ${needed.toFixed(2)}kW)`,
    );
    return { ...device, recentlyRestored: true };
  }
  return { ...device, recentlyRestored: false };
}

function sortCandidates(a: ShedCandidate, b: ShedCandidate): number {
  const pa = a.priority ?? 100;
  const pb = b.priority ?? 100;
  if (pa !== pb) return pb - pa; // Higher number sheds first
  if (a.recentlyRestored !== b.recentlyRestored) {
    return Number(a.recentlyRestored) - Number(b.recentlyRestored);
  }
  return b.effectivePower - a.effectivePower;
}

function selectShedDevices(
  candidates: ShedCandidate[],
  needed: number,
  reason: string,
): { shedSet: Set<string>; shedReasons: Map<string, string> } {
  const shedSet = new Set<string>();
  const shedReasons = new Map<string, string>();
  let remaining = needed;
  for (const candidate of candidates) {
    if (candidate.effectivePower <= 0) continue;
    if (remaining <= 0) break;
    shedSet.add(candidate.id);
    shedReasons.set(candidate.id, reason);
    remaining -= candidate.effectivePower;
  }
  return { shedSet, shedReasons };
}

async function handleShortfallCheck(
  capacityGuard: CapacityGuard | undefined,
  softLimitSource: PlanContext['softLimitSource'],
  remainingCandidates: number,
  deficitKw: number,
): Promise<void> {
  // Shortfall (panic mode) should only trigger when exceeding the hard capacity limit.
  // The soft limit (with margin) is for shedding decisions, but panic is only
  // when we actually exceed the contracted grid capacity limit.
  //
  // softLimitSource tells us why we're shedding:
  // - 'capacity': Exceeding hourly hard cap (should check shortfall)
  // - 'daily': Exceeding daily budget soft limit (should NOT panic)
  // - 'both': Both limits exceeded, but hard cap is the panic trigger
  if (softLimitSource === 'capacity' || softLimitSource === 'both') {
    await capacityGuard?.checkShortfall(remainingCandidates > 0, deficitKw);
  } else if (softLimitSource === 'daily') {
    // Daily budget violation only - clear shortfall if it was set
    await capacityGuard?.checkShortfall(true, 0);
  }
}

async function updateGuardState(params: {
  headroom: number | null;
  capacitySoftLimit: number;
  softLimitSource: PlanContext['softLimitSource'];
  total: number | null;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  capacityGuard: CapacityGuard | undefined;
}): Promise<{ sheddingActive: boolean }> {
  const { headroom, capacitySoftLimit, softLimitSource, total, devices, shedSet, capacityGuard } = params;
  if (shouldActivateShedding(headroom, shedSet)) {
    const remainingCandidates = countRemainingCandidates(devices, shedSet, headroom);
    const capacityHeadroom = total === null ? null : capacitySoftLimit - total;
    const deficitKw = capacityHeadroom !== null ? Math.max(0, -capacityHeadroom) : 0;
    await capacityGuard?.setSheddingActive(true);
    await handleShortfallCheck(capacityGuard, softLimitSource, remainingCandidates, deficitKw);
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

function resolveShedReason(limitSource: PlanContext['softLimitSource']): string {
  if (limitSource === 'daily') return 'shed due to daily budget';
  if (limitSource === 'both') return 'shed due to daily budget + capacity';
  return 'shed due to capacity';
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
  return devices.filter((d) => d.controllable !== false && d.currentOn !== false && !shedSet.has(d.id))
    .filter((d) => resolveCandidatePower(d) !== null)
    .length;
}
