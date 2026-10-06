import type { PlanEngineState } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';
import type { MeteredPlanInputDevice, PlanInputDevice } from '../planTypes';
import { isMeteredPlanDevice } from '../planMeteredDevice';
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
import {
  createShedCandidateSkipRecorder,
  type ShedCandidateSkipRecorder,
  type ShedCandidateSkipSummary,
} from './candidateSkipLog';
import {
  type LoadShedCandidate,
  type ShedCandidate,
  type ShedCandidateParams,
  type SheddingDeps,
  type StorageShedCandidate,
  type StorageShedTerm,
} from './types';
import { SOFT_OVERSHOOT_DEADBAND_KW } from '../planConstants';
import {
  buildStorageCandidate, isDrivableLimitScope, isStorageLimitScope, type LimitableStorageDevice,
} from './storageCandidate';
import { drawMarginWFor } from '../battery/storageLadder';
import type { StorageRelief } from '../battery/storageRelief';

/** One build's shed candidate walk, as selection and the shortfall verdict both ask it. */
/**
 * The deficit shedding answers, kW: the measured one less what home-battery
 * relief counts against it (`StorageShedTerm`), which a hand-back can raise.
 */
export function resolveStorageAdjustedDeficitKw(power: MeasuredPower, storage: StorageShedTerm): number {
  return Math.max(0, -power.headroomKw - storage.netCreditKw);
}

/**
 * How this cycle answers an exhausted hour, whose kWh are spent so any import
 * adds to a spent budget.
 *
 * - `shed_everything`: without a battery that could answer it, every
 *   candidate is shed whatever the reading, as always.
 * - `import_target`: a battery PELS holds discharging, or one it may limit
 *   now, answers in priority order instead, down to the import the battery
 *   deliberately leaves (`importKw`): the devices ranked below it first, then
 *   the battery, and the devices above it only for what it cannot cover. Keyed
 *   on the battery being there to answer, never on its candidacy: a battery
 *   already at its ceiling offers nothing more, and that is no reason to shed
 *   everything.
 * - `not_exhausted`: the hour is not spent, or a battery holds the house at
 *   the pace. "At the pace" forgives the soft-overshoot deadband and the margin
 *   the battery leaves under the house's draw (`resolveStorageDrawMarginKw`).
 */
export type ExhaustedHourAnswer =
  | { kind: 'not_exhausted' }
  | { kind: 'shed_everything' }
  | { kind: 'import_target'; importKw: number };

/**
 * The margin a battery limit leaves under the house's draw, kW: the largest of
 * the holds discharging now (`StorageShedTerm.drawMarginKw`) and of the
 * batteries PELS may limit this cycle (`drawMarginWFor`).
 */
export function resolveStorageDrawMarginKw(devices: readonly PlanInputDevice[], storage: StorageShedTerm): number {
  const marginsKw = devices.filter(isDrivableLimitScope).map((device) => drawMarginWFor(device.storage) / 1000);
  return Math.max(storage.drawMarginKw, ...marginsKw);
}

export function resolveExhaustedHourAnswer(
  devices: readonly PlanInputDevice[],
  state: PlanEngineState,
  power: MeasuredPower,
  storage: StorageShedTerm,
): ExhaustedHourAnswer {
  if (!state.hourlyBudgetExhausted) return { kind: 'not_exhausted' };
  if (!storage.relieving && !devices.some(isDrivableLimitScope)) return { kind: 'shed_everything' };
  const toleranceKw = SOFT_OVERSHOOT_DEADBAND_KW + resolveStorageDrawMarginKw(devices, storage);
  const importKw = power.drawKw - storage.netCreditKw - toleranceKw;
  return importKw > 0 ? { kind: 'import_target', importKw } : { kind: 'not_exhausted' };
}

export function buildShedCandidateParams(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  /** This cycle's storage stage: the term it counts against the deficit, and the holds a battery is priced from. */
  storage: StorageRelief,
): ShedCandidateParams {
  const hour = resolveExhaustedHourAnswer(context.devices, state, power, storage.shed);
  const hourlyBudgetExhausted = hour.kind !== 'not_exhausted';
  const needed = hour.kind === 'import_target' ? hour.importKw : resolveStorageAdjustedDeficitKw(power, storage.shed);
  return {
    devices: context.devices,
    needed: hourlyBudgetExhausted ? Number.POSITIVE_INFINITY : needed,
    // The measured deficit, never the severity sentinel: rung sizing compares
    // kW against it. See `ShedCandidateParams`.
    deficitKw: needed,
    limitSource: hourlyBudgetExhausted ? 'daily' : context.softLimitSource,
    // Resolved once on the measurement; no candidate walk re-derives it from a total.
    capacityBreached: power.capacityBreached,
    temperatureSetpoints: context.temperatureSetpoints,
    storageLimit: { kind: 'measured', drawKw: power.drawKw, levers: storage.levers },
    state,
    deps,
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
  return { ...result, candidates: rankCandidates(result.candidates) };
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
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
  const { capacityBreached, deps } = params;
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

  for (const device of params.devices) {
    const walked = walkDevice(device, params, recorder, nowTs);
    if (walked === null) continue;
    if (walked.allowedByLimitPolicy === false) {
      blockedCandidateCount += 1;
      blockedReducibleControlledKw += walked.candidate.effectivePower;
      recorder.record({ device: walked.candidate, reasonCode: 'budget_exempt_daily_only' });
      continue;
    }
    eligibleCandidateCount += 1;
    if (options.includeCandidates) candidates.push(walked.candidate);
    reducibleControlledKw += walked.candidate.effectivePower;
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
/* eslint-enable functional/immutable-data */

/**
 * One device's candidate, and whether the daily-budget policy lets it be
 * spent; or null when it is none. A home battery has no generic command
 * authority, so it is offered first, before that gate, at its own place in the
 * order (`storageCandidate.ts`). Its grid charge counts against the daily
 * budget like any load's, so the budget-exempt policy never spares it.
 */
function walkDevice(
  device: PlanInputDevice,
  params: ShedCandidateParams,
  recorder: ShedCandidateSkipRecorder,
  nowTs: number,
): { candidate: StorageShedCandidate; allowedByLimitPolicy: true }
  | { candidate: LoadShedCandidate; allowedByLimitPolicy: boolean }
  | null {
  if (isStorageLimitScope(device)) {
    const battery = addStorageCandidate(device, params, recorder, nowTs);
    return battery === null ? null : { candidate: battery, allowedByLimitPolicy: true };
  }
  const candidate = addLoadCandidate(device, params, recorder, nowTs);
  if (candidate === null) return null;
  const { limitSource, capacityBreached } = params;
  return {
    candidate,
    allowedByLimitPolicy: limitSource !== 'daily' || capacityBreached || device.budgetExempt !== true,
  };
}

/**
 * A load's candidate, or null with the reason recorded. Out of scope, and not
 * recorded: a device PELS may not command, and a device without a power
 * reading — the plan still sets its temperature, but nothing measures what
 * limiting it would release.
 */
function addLoadCandidate(
  device: PlanInputDevice,
  params: ShedCandidateParams,
  recorder: ShedCandidateSkipRecorder,
  nowTs: number,
): LoadShedCandidate | null {
  if (device.control.commandAuthority === false || !isMeteredPlanDevice(device)) return null;
  if (!isEligibleForShedding(device)) {
    recorder.record({ device, reasonCode: 'binary_confirmed_off' });
    return null;
  }
  const candidate = addCandidatePower(device, params, recorder, nowTs);
  if (!candidate) return null;
  if (recordSetpointShedSkip(candidate, device, params.temperatureSetpoints, recorder)) return null;
  return candidate;
}

/**
 * A home battery's candidate, or null with the reason recorded. Without a
 * measurement there is no draw to bound its discharge by, and the silent-meter
 * pass hands it back instead.
 */
function addStorageCandidate(
  device: LimitableStorageDevice,
  params: ShedCandidateParams,
  recorder: ShedCandidateSkipRecorder,
  nowTs: number,
): StorageShedCandidate | null {
  const { storageLimit, state, needed, deps } = params;
  if (storageLimit.kind !== 'measured') return null;
  const candidate = buildStorageCandidate(
    device,
    storageLimit.levers[device.id],
    storageLimit.drawKw,
    resolveRecentRestoreState(device, state, nowTs, needed, deps.debugStructured),
    nowTs,
  );
  if (typeof candidate !== 'string') return candidate;
  recorder.recordStorage({ device, batterySignedPowerW: device.storage.signedPowerW, reasonCode: candidate });
  return null;
}

function addCandidatePower(
  device: MeteredPlanInputDevice,
  params: ShedCandidateParams,
  recorder: ShedCandidateSkipRecorder,
  nowTs: number,
): LoadShedCandidate | null {
  const {
    devices,
    temperatureSetpoints,
    state,
    // Severity, sentinel-carrying — for `resolveRecentRestoreState` only.
    needed,
    // The real deficit in kW — for anything that compares or subtracts.
    deficitKw,
    deps,
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

/**
 * The ranked order selection spends candidates in. A home battery holds its
 * place by priority: devices ranked below it go first and the ones above it
 * after (owner ruling, 2026-10-06). Among the loads between two batteries (or
 * all of them, without a battery), preemptive step-down candidates go first,
 * so that step reductions are attempted before any device in that stretch is
 * turned off. A stepped device already at its lowest active step (going to
 * off) is effectively a turn-off and follows normal priority ordering. The
 * preemptive rule never moves a load past a battery: a stepped tank whose
 * upper rung covers the deficit must not be stepped down ahead of a battery
 * ranked last.
 */

function rankCandidates(candidates: readonly ShedCandidate[]): ShedCandidate[] {
  const byPriority = [...candidates].sort(comparePriority);
  const batteryIndexes = byPriority.flatMap((candidate, index) => (candidate.kind === 'storage' ? [index] : []));
  const bounds = [-1, ...batteryIndexes, byPriority.length];
  return bounds.slice(1).flatMap((end, part) => {
    const loads = byPriority.slice((bounds[part] ?? -1) + 1, end).sort(comparePreemptiveFirst);
    const battery = byPriority[end];
    return battery === undefined ? loads : loads.concat([battery]);
  });
}


const isPreemptive = (candidate: ShedCandidate): boolean => (
  candidate.kind === 'stepped' && candidate.preemptiveStepDown
);

function comparePreemptiveFirst(a: ShedCandidate, b: ShedCandidate): number {
  const aPreemptive = isPreemptive(a);
  const bPreemptive = isPreemptive(b);
  if (aPreemptive !== bPreemptive) return Number(bPreemptive) - Number(aPreemptive);
  return comparePriority(a, b);
}

function comparePriority(a: ShedCandidate, b: ShedCandidate): number {
  const pa = a.priority;
  const pb = b.priority;
  if (pa !== pb) return pb - pa; // Higher number sheds first
  if (a.recentlyRestored !== b.recentlyRestored) {
    return Number(a.recentlyRestored) - Number(b.recentlyRestored);
  }
  if (a.effectivePower !== b.effectivePower) return b.effectivePower - a.effectivePower;
  // Defensive final tiebreak for partial/legacy inputs (active-home plan
  // inputs have unique ranks), shared with restore via compareDeviceIdAsc.
  return compareDeviceIdAsc(a, b);
}
