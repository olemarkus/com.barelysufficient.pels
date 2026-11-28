import type { PlanLimitSource } from '../planContext';
import type { PlanEngineState } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';
import type { MeteredPlanInputDevice, PlanInputDevice } from '../planTypes';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { compareDeviceIdAsc } from '../planSort';
import { resolveRecentRestoreState, type RecentRestoreState } from './overshoot';
import {
  buildBinaryCandidate,
  buildTemperatureCandidate,
  isEligibleForShedding,
  recordSetpointShedSkip,
} from './candidateBuilders';
import { buildSteppedCandidate } from './steppedCandidates';
import { resolveShedLever } from './shedLever';
import {
  createShedCandidateSkipRecorder,
  type ShedCandidateSkipRecorder,
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
  buildStorageCandidate, isBoundedDischargeLimitScope, isDrivableLimitScope,
  isStorageLimitScope, type LimitableStorageDevice,
} from './storageCandidate';
import type { StorageRelief } from '../battery/storageRelief';
import { resolveShedNeedKw, resolveShedPressure, type ShedPressure } from './pressure';
import { drawMarginWFor, physicalDischargePreference } from '../battery/storageLadder';
import { offeredChargeW } from '../battery/storageContinuous';

/** One build's shed candidate walk, as selection and the shortfall verdict both ask it. */
/**
 * The deficit shedding answers, kW: the measured one less what home-battery
 * relief counts against it (`StorageShedTerm`), which a hand-back can raise.
 */
export function resolveStorageAdjustedDeficitKw(power: MeasuredPower, storage: StorageShedTerm): number {
  return power.headroom.kind === 'off' ? 0 : Math.max(0, -power.headroom.kw - storage.netCreditKw);
}

/**
 * How this cycle answers an exhausted hour, whose kWh are spent so any import
 * adds to a spent budget.
 *
 * - `shed_everything`: without a battery that could answer it, every
 *   candidate is shed whatever the reading, as always.
 * - `import_target`: a battery PELS holds discharging, or one it may limit
 *   now, answers the measured import above the safety allowance (`importKw`).
 *   Battery relief uses the physical order, then loads cover the residual. Keyed
 *   on the battery being there to answer, never on its candidacy: a battery
 *   already at its ceiling offers nothing more, and that is no reason to shed
 *   everything.
 * - `not_exhausted`: the period is not spent.
 * - `covered`: import is inside the soft-overshoot deadband and the margin
 *   the battery leaves under the house's draw (`resolveStorageDrawMarginKw`).
 */
export type ExhaustedHourAnswer =
  | { kind: 'not_exhausted' | 'covered' }
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
  context: PlanContext,
  state: PlanEngineState,
  power: MeasuredPower,
  storage: StorageShedTerm,
): ExhaustedHourAnswer {
  // The spent period acts only while Capacity limit is on: with it off the
  // period is still tracked, and still spent, but no limit spends it.
  if (!state.capacityPeriodSpentFor(context)) return { kind: 'not_exhausted' };
  const { devices } = context;
  const toleranceKw = SOFT_OVERSHOOT_DEADBAND_KW + resolveStorageDrawMarginKw(devices, storage);
  const importKw = power.drawKw - storage.netCreditKw - toleranceKw;
  if (!storage.relieving && !devices.some((device) => isBoundedDischargeLimitScope(device, importKw))) {
    return { kind: 'shed_everything' };
  }
  return importKw > 0 ? { kind: 'import_target', importKw } : { kind: 'covered' };
}

function resolveCyclePressure(
  context: PlanContext, power: MeasuredPower, storage: StorageShedTerm, period: ExhaustedHourAnswer,
): ShedPressure {
  const pressure = resolveShedPressure(power, context.capacity, storage);
  // The spent-period target already answers the capacity axis, including its
  // allowed import margin. An independent grid breach still has to be answered.
  return period.kind === 'covered' && pressure.kind !== 'grid' ? { kind: 'soft' } : pressure;
}

type MeasuredShedCycle = ShedCandidateParams & {
  pressure: ShedPressure;
  period: ExhaustedHourAnswer;
  prioritizeStorage: boolean;
};

export function buildShedCandidateParams(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  /** This cycle's storage stage: the term it counts against the deficit, and the holds a battery is priced from. */
  storage: StorageRelief,
): MeasuredShedCycle {
  const hour = resolveExhaustedHourAnswer(context, state, power, storage.shed);
  const hourlyBudgetExhausted = hour.kind === 'import_target' || hour.kind === 'shed_everything';
  const pressure = resolveCyclePressure(context, power, storage.shed, hour);
  const prioritizeStorage = context.devices.some(isDrivableLimitScope)
    && (hour.kind === 'import_target' || pressure.kind !== 'soft');
  const physicalLimitBreached = hour.kind === 'covered' ? pressure.kind === 'grid'
    : power.physicalLimitBreached || prioritizeStorage;
  const deficitKw = resolveCycleDeficitKw(power, storage.shed, hour, pressure, prioritizeStorage);
  return {
    pressure,
    period: hour,
    prioritizeStorage,
    devices: context.devices,
    nowTs: context.nowTs,
    relayRetryMeterAtMs: state.isNewRelayMeterDecision(power.sampledAtMs) ? power.sampledAtMs : undefined,
    needed: hourlyBudgetExhausted ? Number.POSITIVE_INFINITY : deficitKw,
    bypassRecentRestore: power.gridBreached,
    // The measured deficit, never the severity sentinel: rung sizing compares
    // kW against it. See `ShedCandidateParams`.
    deficitKw,
    limitSource: resolveCycleLimitSource(context, hour, pressure, prioritizeStorage),
    physicalLimitBreached,
    temperatureSetpoints: context.temperatureSetpoints,
    storageLimit: {
      kind: 'measured', drawKw: power.drawKw, levers: storage.levers, surplusOffers: storage.surplusOffers,
    },
    state,
    deps,
  };
}

function resolveCycleDeficitKw(
  power: MeasuredPower, storage: StorageShedTerm, hour: ExhaustedHourAnswer, pressure: ShedPressure,
  prioritizeStorage: boolean,
): number {
  if (hour.kind === 'import_target') return hour.importKw;
  if (hour.kind === 'covered' && pressure.kind === 'soft') {
    return power.budgetHeadroom.kind === 'on' ? Math.max(0, -power.budgetHeadroom.kw - storage.netCreditKw) : 0;
  }
  const combinedNeed = resolveStorageAdjustedDeficitKw(power, storage);
  // The load-only capacity-pace path keeps its existing sizing and pending
  // demand policy. Isolate physical need when storage can otherwise spend it.
  if (pressure.kind === 'capacity' && !prioritizeStorage) return combinedNeed;
  return resolveShedNeedKw(pressure, combinedNeed);
}

function resolveCycleLimitSource(
  context: PlanContext, hour: ExhaustedHourAnswer, pressure: ShedPressure, prioritizeStorage: boolean,
): PlanLimitSource | 'none' {
  if (pressure.kind === 'grid') return 'grid';
  if (hour.kind === 'covered' && pressure.kind === 'soft') return 'daily';
  if (hour.kind === 'shed_everything' || hour.kind === 'import_target') return 'daily';
  if (prioritizeStorage) return 'capacity';
  return context.binding.kind === 'bound' ? context.binding.source : 'none';
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function buildSheddingCandidates(params: ShedCandidateParams): {
  candidates: ShedCandidate[];
  availableCandidates: ShedCandidate[];
  physicalLimitBreached: boolean;
  physicalStorageCount: number;
  diagnostics: ShedCandidateSkipRecorder;
} {
  const candidates: ShedCandidate[] = [];
  // Every exit below either produces a candidate or records why it did not, so a
  // cycle that sheds nothing can say which devices it considered and what stopped
  // each one (`candidateSkipLog.ts`). Devices that are not controllable at all
  // are out of scope rather than skipped, and are not recorded.
  const recorder = createShedCandidateSkipRecorder();

  for (const device of params.devices) {
    const walked = walkDevice(device, params, recorder, params.nowTs);
    if (walked === null) continue;
    if (walked.allowedByLimitPolicy === false) {
      recorder.record(walked.candidate, 'budget_exempt_daily_only');
      continue;
    }
    candidates.push(walked.candidate);
  }

  const { storageLimit, physicalLimitBreached } = params;
  const physical = storageLimit.kind === 'measured' && physicalLimitBreached
    ? rankPhysicalStorage(candidates, storageLimit) : { first: [], ranked: candidates };
  return {
    candidates: [...physical.first, ...rankCandidates(physical.ranked)],
    physicalStorageCount: physical.first.length,
    availableCandidates: candidates,
    diagnostics: recorder,
    // Surfaced so the shed reason is attributed from the SAME breach decision that
    // gated budget-exempt candidates above, rather than a recomputation that could
    // drift from it.
    physicalLimitBreached: params.physicalLimitBreached,
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
  const { limitSource, physicalLimitBreached } = params;
  return {
    candidate,
    allowedByLimitPolicy: limitSource !== 'daily' || physicalLimitBreached || !device.budgetExempt,
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
    recorder.record(device, 'binary_confirmed_off');
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
  const { storageLimit, state, needed } = params;
  if (storageLimit.kind !== 'measured') return null;
  const restore: RecentRestoreState = params.bypassRecentRestore
    ? { recentlyRestored: false }
    : resolveRecentRestoreState(device, state, nowTs, needed);
  if (restore.recentlyRestored) recorder.recordRecentRestore(device, restore.sinceRestoreMs, needed);
  const bound = storageLimit.boundFor?.(device) ?? { drawKw: storageLimit.drawKw, chargeOnly: false };
  const candidate = buildStorageCandidate(
    device,
    storageLimit.levers[device.id],
    bound.drawKw,
    restore.recentlyRestored,
    nowTs,
    bound.chargeOnly || !params.physicalLimitBreached,
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
    bypassRecentRestore,
    deps,
  } = params;
  const priority = device.priority;
  const restore: RecentRestoreState = bypassRecentRestore
    ? { recentlyRestored: false }
    : resolveRecentRestoreState(device, state, nowTs, needed);
  if (restore.recentlyRestored) recorder.recordRecentRestore(device, restore.sinceRestoreMs, needed);
  const { recentlyRestored } = restore;
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
  // stored shed behaviour says (`resolveShedLever`).
  const lever = resolveShedLever(device, temperatureSetpoints);
  const target = device.targets?.[0];
  if (lever.kind === 'setpoint' && target?.id) {
    return buildTemperatureCandidate(
      device, priority, recentlyRestored, lever.limitC, target.id, state.pendingTargetCommands, recorder,
    );
  }
  if (device.relayShedNoAck && (params.relayRetryMeterAtMs ?? -Infinity) < device.relayShedNoAck.retryAtMs) {
    recorder.record(device, 'relay_no_ack_waiting_for_meter');
    return null;
  }
  return buildBinaryCandidate(device, priority, recentlyRestored, deps.pendingBinaryCommandStore, recorder);
}

/** Grid-charge stops and available supply precede ranked loads and allocated solar charge. */
function rankPhysicalStorage(
  candidates: readonly ShedCandidate[], storage: Extract<ShedCandidateParams['storageLimit'], { kind: 'measured' }>,
): { first: StorageShedCandidate[]; ranked: ShedCandidate[] } {
  const batteries = candidates.flatMap((candidate) => candidate.kind === 'storage'
    ? [{ candidate, solarW: protectedSolarChargeW(storage, candidate) }] : []);
  const gridCharge = [...batteries.flatMap(({ candidate, solarW }) => {
    const reliefKw = Math.min((candidate.baseW - solarW) / 1000, candidate.effectivePower);
    return reliefKw > 0 ? [{ ...candidate, effectivePower: reliefKw }] : [];
  })].sort(compareDeviceIdAsc);
  const discharge = batteries
    .filter(({ candidate, solarW }) => solarW <= 0 && candidate.effectivePower > Math.max(0, candidate.baseW) / 1000)
    .map(({ candidate }) => candidate)
    .sort((a, b) => (
      physicalDischargePreference(b.storage, storage.levers[b.id])
      - physicalDischargePreference(a.storage, storage.levers[a.id])
      || compareDeviceIdAsc(a, b)
    ));
  const loads = candidates.filter((candidate) => candidate.kind !== 'storage');
  const solar = batteries.flatMap(({ candidate, solarW }) => solarW > 0 ? [candidate] : []);
  return { first: gridCharge.concat(discharge), ranked: [...loads, ...solar] };
}

function protectedSolarChargeW(
  storage: Extract<ShedCandidateParams['storageLimit'], { kind: 'measured' }>, candidate: StorageShedCandidate,
): number {
  const positiveW = Math.max(0, candidate.baseW);
  const offer = storage.surplusOffers.get(candidate.id);
  if (offer === undefined) return positiveW;
  const lever = storage.levers[candidate.id];
  if (lever?.purpose === 'limit' || (lever?.baseline === true && candidate.storage.claimHeld)) return positiveW;
  return Math.min(positiveW, offeredChargeW(candidate.storage, offer, drawMarginWFor(candidate.storage)));
}

/** Apply load rules between the battery charge turns that retain their Modes position. */
function rankCandidates(candidates: readonly ShedCandidate[]): ShedCandidate[] {
  const byPriority = [...candidates].sort(comparePriority);
  const batteryIndexes = byPriority.flatMap((candidate, index) => (candidate.kind === 'storage' ? [index] : []));
  const bounds = [-1, ...batteryIndexes, byPriority.length];
  return bounds.slice(1).flatMap((end, part) => {
    const loads = byPriority.slice((bounds[part] ?? -1) + 1, end).sort(compareLoads);
    const battery = byPriority[end];
    return battery === undefined ? loads : loads.concat([battery]);
  });
}

const usesAvailablePower = (candidate: ShedCandidate): boolean => (
  candidate.kind === 'binary' && candidate.usesAvailablePower === true
);
const isPreemptive = (candidate: ShedCandidate): boolean => (
  candidate.kind === 'stepped' && candidate.preemptiveStepDown
);

function compareLoads(a: ShedCandidate, b: ShedCandidate): number {
  const availablePowerOrder = Number(usesAvailablePower(b)) - Number(usesAvailablePower(a));
  if (availablePowerOrder !== 0) return availablePowerOrder;
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
