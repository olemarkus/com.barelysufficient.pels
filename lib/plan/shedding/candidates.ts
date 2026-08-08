import type { PlanEngineState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { compareDeviceIdAsc } from '../planSort';
import { isCapacityBreached } from '../planRemainingSheddableLoad';
import { resolveRecentRestoreState } from './overshoot';
import {
  buildBinaryCandidate,
  buildTemperatureCandidate,
  isEligibleForShedding,
  isNotAtShedTemperature,
} from './candidateBuilders';
import { buildSteppedCandidate } from './steppedCandidates';
import {
  createShedCandidateSkipRecorder,
  type ShedCandidateSkipRecorder,
  type ShedCandidateSkipSummary,
} from './candidateSkipLog';
import {
  type ShedCandidate,
  type ShedCandidateParams,
  type SheddingDeps,
} from './types';

export function summarizeSheddingCandidates(params: ShedCandidateParams): {
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
} & ShedCandidateSkipSummary {
  const {
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    skippedCandidateCount,
    skippedCandidateReasons,
  } = collectSheddingCandidates(params, { includeCandidates: false });
  return {
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    skippedCandidateCount,
    skippedCandidateReasons,
  };
}

export function buildSheddingCandidates(params: ShedCandidateParams): {
  candidates: ShedCandidate[];
  reducibleControlledKw: number;
  blockedCandidateCount: number;
  blockedReducibleControlledKw: number;
  capacityBreached: boolean;
} & ShedCandidateSkipSummary {
  const result = collectSheddingCandidates(params, { includeCandidates: true });
  result.candidates.sort(sortCandidates);
  return result;
}

function collectSheddingCandidates(
  params: ShedCandidateParams,
  options: { includeCandidates: boolean },
): {
  candidates: ShedCandidate[];
  eligibleCandidateCount: number;
  reducibleControlledKw: number;
  blockedCandidateCount: number;
  blockedReducibleControlledKw: number;
  capacityBreached: boolean;
} & ShedCandidateSkipSummary {
  const {
    devices,
    needed,
    limitSource,
    total,
    capacitySoftLimit,
    state,
    deps,
  } = params;
  const nowTs = Date.now();
  const capacityBreached = isCapacityBreached(total, capacitySoftLimit);
  const candidates: ShedCandidate[] = [];
  // Every exit below either produces a candidate or records why it did not, so a
  // cycle that sheds nothing can say which devices it considered and what stopped
  // each one (`candidateSkipLog.ts`). Devices that are not controllable at all
  // are out of scope rather than skipped, and are not recorded.
  const recorder = createShedCandidateSkipRecorder(deps.debugStructured);
  let eligibleCandidateCount = 0;
  let reducibleControlledKw = 0;
  let blockedCandidateCount = 0;
  let blockedReducibleControlledKw = 0;

  for (const device of devices) {
    if (device.controllable === false) continue;
    if (!isEligibleForShedding(device)) {
      recorder.record({ device, reasonCode: 'binary_confirmed_off' });
      continue;
    }

    const candidate = addCandidatePower({
      device,
      devices,
      state,
      nowTs,
      needed,
      deps,
      recorder,
    });
    if (!candidate) continue;
    if (!isNotAtShedTemperature(candidate)) {
      recorder.record({ device, reasonCode: 'already_at_shed_temperature' });
      continue;
    }

    const allowedByLimitPolicy = limitSource !== 'daily' || capacityBreached || device.budgetExempt !== true;
    if (allowedByLimitPolicy) {
      eligibleCandidateCount += 1;
      if (options.includeCandidates) candidates.push(candidate);
      reducibleControlledKw += candidate.effectivePower;
      continue;
    }

    blockedCandidateCount += 1;
    blockedReducibleControlledKw += candidate.effectivePower;
    recorder.record({ device, reasonCode: 'budget_exempt_daily_only' });
  }

  recorder.emit();

  return {
    candidates,
    eligibleCandidateCount,
    reducibleControlledKw,
    blockedCandidateCount,
    blockedReducibleControlledKw,
    // Surfaced so the shed reason is attributed from the SAME breach decision that
    // gated budget-exempt candidates above, rather than a recomputation that could
    // drift from it.
    capacityBreached,
    ...recorder.summary(),
  };
}

function addCandidatePower(params: {
  device: PlanInputDevice;
  devices: PlanInputDevice[];
  state: PlanEngineState;
  nowTs: number;
  needed: number;
  deps: Pick<
    SheddingDeps,
    'getPriorityForDevice' | 'getShedBehavior' | 'debugStructured' | 'pendingBinaryCommandStore'
  >;
  recorder: ShedCandidateSkipRecorder;
}): ShedCandidate | null {
  const {
    device,
    devices,
    state,
    nowTs,
    needed,
    deps,
    recorder,
  } = params;
  const priority = deps.getPriorityForDevice(device.id);
  const recentlyRestored = resolveRecentRestoreState({
    device,
    state,
    nowTs,
    needed,
    debugStructured: deps.debugStructured,
  });
  if (isSteppedLoadDevice(device)) {
    return buildSteppedCandidate({
      device,
      devices,
      priority,
      recentlyRestored,
      state,
      getShedBehavior: deps.getShedBehavior,
      pendingBinaryCommandStore: deps.pendingBinaryCommandStore,
      recorder,
    });
  }
  const shedBehavior = deps.getShedBehavior(device.id);
  if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    const target = device.targets?.[0];
    if (target?.id) {
      return buildTemperatureCandidate({
        device,
        priority,
        recentlyRestored,
        shedTemperature: shedBehavior.temperature,
        targetCapabilityId: target.id,
        targetCapability: target,
        pendingTargetCommands: state.pendingTargetCommands,
        recorder,
      });
    }
  }
  return buildBinaryCandidate(device, priority, recentlyRestored, deps.pendingBinaryCommandStore, recorder);
}

function sortCandidates(a: ShedCandidate, b: ShedCandidate): number {
  // Preemptive step-down candidates sort before everything else so that step
  // reductions are attempted before turning off any device in this planning
  // cycle. A stepped device already at its lowest active step (going to off)
  // is effectively a turn-off and follows normal priority ordering.
  const aPreemptive = a.kind === 'stepped' && a.preemptiveStepDown;
  const bPreemptive = b.kind === 'stepped' && b.preemptiveStepDown;
  if (aPreemptive !== bPreemptive) return Number(bPreemptive) - Number(aPreemptive);
  const pa = a.priority ?? 100;
  const pb = b.priority ?? 100;
  if (pa !== pb) return pb - pa; // Higher number sheds first
  if (a.recentlyRestored !== b.recentlyRestored) {
    return Number(a.recentlyRestored) - Number(b.recentlyRestored);
  }
  if (a.effectivePower !== b.effectivePower) return b.effectivePower - a.effectivePower;
  // Defensive final tiebreak for partial/legacy inputs (active-home plan
  // inputs have unique ranks), shared with restore via compareDeviceIdAsc.
  return compareDeviceIdAsc(a, b);
}
