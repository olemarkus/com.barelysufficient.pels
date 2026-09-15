import type { PlanEngineState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { compareDeviceIdAsc } from '../planSort';
import { resolveRecentRestoreState } from './overshoot';
import {
  buildBinaryCandidate,
  buildTemperatureCandidate,
  isEligibleForShedding,
  recordSetpointShedSkip,
} from './candidateBuilders';
import { buildSteppedCandidate } from './steppedCandidates';
import { temperatureSetpointsFor } from '../planTemperatureSetpoints';
import { isTemperaturePlanDevice } from '../planTemperatureDevice';
import type { TemperatureSetpointsByDevice } from '../../../packages/planner-types/src/temperatureSetpoints';
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
    deficitKw,
    limitSource,
    capacityBreached,
    temperatureSetpoints,
    state,
    deps,
  } = params;
  const nowTs = Date.now();
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
    if (device.control.commandAuthority === false) continue;
    if (!isEligibleForShedding(device)) {
      recorder.record({ device, reasonCode: 'binary_confirmed_off' });
      continue;
    }

    const candidate = addCandidatePower({
      device,
      devices,
      temperatureSetpoints,
      state,
      nowTs,
      needed,
      deficitKw,
      deps,
      recorder,
    });
    if (!candidate) continue;
    if (recordSetpointShedSkip(candidate, device, temperatureSetpoints, recorder)) continue;

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
  temperatureSetpoints: TemperatureSetpointsByDevice;
  state: PlanEngineState;
  nowTs: number;
  /** Severity, sentinel-carrying — for `resolveRecentRestoreState` only. */
  needed: number;
  /** The real deficit in kW — for anything that compares or subtracts. */
  deficitKw: number;
  deps: Pick<
    SheddingDeps,
    'getShedBehavior' | 'debugStructured' | 'pendingBinaryCommandStore'
  >;
  recorder: ShedCandidateSkipRecorder;
}): ShedCandidate | null {
  const {
    device,
    devices,
    temperatureSetpoints,
    state,
    nowTs,
    needed,
    deficitKw,
    deps,
    recorder,
  } = params;
  const priority = device.priority;
  const recentlyRestored = resolveRecentRestoreState(
    device, state, nowTs, needed, deps.debugStructured,
  );
  if (isSteppedLoadDevice(device)) {
    return buildSteppedCandidate({
      device,
      devices,
      priority,
      recentlyRestored,
      // The cycle's whole deficit sizes the rung: candidates are priced and
      // ranked before selection spends anything, so there is no per-device
      // remainder to hand down here.
      neededKw: deficitKw,
      state,
      temperatureSetpoints,
      getShedBehavior: deps.getShedBehavior,
      pendingBinaryCommandStore: deps.pendingBinaryCommandStore,
      recorder,
    });
  }
  // A device with no temperature facet has no setpoint to limit, whatever its
  // stored shed behaviour says.
  const target = device.targets?.[0];
  if (isTemperaturePlanDevice(device) && target?.id) {
    const { shed } = temperatureSetpointsFor(temperatureSetpoints, device.id);
    if (shed.action === 'set_temperature') {
      return buildTemperatureCandidate({
        device,
        priority,
        recentlyRestored,
        shedTemperature: shed.limitC,
        targetCapabilityId: target.id,
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
