/* eslint-disable max-lines -- reason normalization and shed-temperature hold decisions share stateful helpers here */
import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getActivationPenaltyLevel, getActivationRestoreBlockRemainingMs } from './planActivationBackoff';
import { computeBaseRestoreNeed, resolveRestorePowerSource } from './planRestoreSwap';
import { getRestoreNeed } from './planRestoreSupport';
import {
  classifyPlanReason,
  renderPlanReasonDecision,
  type ClassifiedPlanReason,
  type PlanReasonDecision,
} from './planReasonStrings';
import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  resolveRestoreDecisionPhase,
} from './planRestoreAdmission';
import { sortByPriorityAsc } from './planSort';
import { RESTORE_ADMISSION_FLOOR_KW, RESTORE_CONFIRM_RETRY_MS } from './planConstants';
import { resolveCapacityRestoreBlockReason } from './planRestoreTiming';
import { emitRestoreDebugEventOnChange } from './planDebugDedupe';

function shouldNormalizeReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'none'
    || reason.code === 'keep'
    || reason.code === 'restore_need'
    || reason.code === 'set_target';
}

function isSwapReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'swap_pending' || reason.code === 'swapped_out';
}

function isBudgetReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'hourly_budget' || reason.code === 'daily_budget';
}

function isShortfallReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'shortfall';
}

function getBaseShedReason(params: {
  dev: DevicePlanDevice;
  shedReasons: Map<string, string>;
}): PlanReasonDecision {
  const { dev, shedReasons } = params;
  const explicitReason = shedReasons.get(dev.id);
  if (explicitReason) return { code: 'existing', text: explicitReason };

  const classifiedReason = classifyPlanReason(dev.reason);
  if (
    classifiedReason.text
    && (
      isShortfallReason(classifiedReason)
      || isSwapReason(classifiedReason)
      || isBudgetReason(classifiedReason)
    )
  ) {
    return { code: 'existing', text: classifiedReason.text };
  }

  return { code: 'existing', text: 'shed due to capacity' };
}

function buildBaseReason(dev: DevicePlanDevice, shedReasons: Map<string, string>): string {
  const classifiedReason = classifyPlanReason(dev.reason);
  const keepReason = shouldNormalizeReason(classifiedReason) ? null : classifiedReason.text;
  return shedReasons.get(dev.id) || keepReason || 'shed due to capacity';
}

function maybeApplyShortfallReason(params: {
  dev: DevicePlanDevice;
  guardInShortfall: boolean;
  currentReason: ClassifiedPlanReason;
  headroomRaw: number | null;
}): PlanReasonDecision | null {
  const { dev, guardInShortfall, currentReason, headroomRaw } = params;
  if (!guardInShortfall || isSwapReason(currentReason) || isBudgetReason(currentReason)) return null;
  if (isShortfallReason(currentReason)) return null;
  const { needed: estimatedNeed } = computeBaseRestoreNeed(dev);
  return { code: 'shortfall', neededKw: estimatedNeed, headroomKw: headroomRaw };
}

function maybeApplyCooldownReason(params: {
  currentReason: ClassifiedPlanReason;
  inCooldown: boolean;
  activeOvershoot: boolean;
  shedCooldownRemainingSec: number | null;
}): PlanReasonDecision | null {
  const { currentReason, inCooldown, activeOvershoot, shedCooldownRemainingSec } = params;
  if (inCooldown && !activeOvershoot && !isSwapReason(currentReason)) {
    return { code: 'cooldown_shedding', remainingSec: shedCooldownRemainingSec };
  }
  return null;
}

export type PlanReasonPairValidationIssue = {
  deviceId: string;
  deviceName: string;
  plannedState: string;
  reason: string;
  allowedReasonKinds: string[];
};

type ReasonPatternRule = {
  pattern: RegExp;
  label: string;
};

const KEEP_REASON_RULES: readonly ReasonPatternRule[] = [
  { pattern: /^keep(?: \(.+\))?$/, label: 'keep' },
  { pattern: /^restore .+ -> .+ \(need .+\)$/, label: 'stepped restore admission' },
  { pattern: /^cooldown \(shedding, \d+s remaining\)$/, label: 'shedding cooldown' },
  { pattern: /^meter settling \(\d+s remaining\)$/, label: 'meter settling' },
  { pattern: /^restore throttled$/, label: 'restore throttle' },
  { pattern: /^waiting for other devices to recover$/, label: 'recovery gate' },
  { pattern: /^activation backoff \(\d+s remaining\)$/, label: 'activation backoff' },
  { pattern: /^insufficient headroom/, label: 'insufficient headroom' },
  { pattern: /^swap pending(?: \(.+\))?$/, label: 'swap pending' },
  { pattern: /^shed invariant: .+ -> .+ blocked \(\d+ device\(s\) shed, max step: .+\)$/, label: 'shed invariant' },
  { pattern: /^startup stabilization$/, label: 'startup stabilization' },
  { pattern: /^headroom cooldown \(.+\)$/, label: 'headroom cooldown' },
  { pattern: /^capacity control off$/, label: 'capacity control off' },
] as const;

const SHED_REASON_RULES: readonly ReasonPatternRule[] = [
  { pattern: /^shed due to capacity(?: .+)?$/, label: 'capacity shed' },
  { pattern: /^shed due to hourly budget(?: .+)?$/, label: 'hourly budget shed' },
  { pattern: /^shed due to daily budget(?: .+)?$/, label: 'daily budget shed' },
  { pattern: /^shortfall(?: \(.+\))?$/, label: 'shortfall shed' },
  { pattern: /^cooldown \(shedding, \d+s remaining\)$/, label: 'shedding cooldown' },
  { pattern: /^restore throttled$/, label: 'restore throttle' },
  { pattern: /^restore pending \(\d+s remaining\)$/, label: 'restore pending' },
  { pattern: /^waiting for other devices to recover$/, label: 'recovery gate' },
  { pattern: /^activation backoff \(\d+s remaining\)$/, label: 'activation backoff' },
  { pattern: /^insufficient headroom/, label: 'insufficient headroom' },
  { pattern: /^swap pending(?: \(.+\))?$/, label: 'swap pending' },
  { pattern: /^swapped out for .+$/, label: 'swapped out' },
  { pattern: /^shedding active(?: .+)?$/, label: 'shedding active' },
  { pattern: /^startup stabilization$/, label: 'startup stabilization' },
] as const;

const INACTIVE_REASON_RULES: readonly ReasonPatternRule[] = [
  { pattern: /^inactive(?: \(.+\))?$/, label: 'inactive' },
] as const;

function stripCandidateReasons(dev: DevicePlanDevice): DevicePlanDevice {
  const { candidateReasons: _candidateReasons, ...snapshotDevice } = dev;
  return snapshotDevice;
}

function getAllowedReasonRules(plannedState: string): readonly ReasonPatternRule[] {
  switch (plannedState) {
    case 'keep':
      return KEEP_REASON_RULES;
    case 'shed':
      return SHED_REASON_RULES;
    case 'inactive':
      return INACTIVE_REASON_RULES;
    default:
      return [];
  }
}

function validatePlanReasonPair(dev: DevicePlanDevice): PlanReasonPairValidationIssue | null {
  const plannedState = typeof dev.plannedState === 'string' ? dev.plannedState.trim() : '';
  const reason = typeof dev.reason === 'string' ? dev.reason.trim() : '';
  const allowedReasonRules = getAllowedReasonRules(plannedState);
  const allowedReasonKinds = allowedReasonRules.map((rule) => rule.label);

  if (!plannedState || allowedReasonRules.length === 0) {
    return {
      deviceId: dev.id,
      deviceName: dev.name,
      plannedState: plannedState || '<empty>',
      reason: reason || '<empty>',
      allowedReasonKinds,
    };
  }

  if (!reason) {
    if (plannedState === 'keep') return null;
    return {
      deviceId: dev.id,
      deviceName: dev.name,
      plannedState,
      reason: '<empty>',
      allowedReasonKinds,
    };
  }

  if (allowedReasonRules.some((rule) => rule.pattern.test(reason))) {
    return null;
  }

  return {
    deviceId: dev.id,
    deviceName: dev.name,
    plannedState,
    reason,
    allowedReasonKinds,
  };
}

function formatPlanReasonPairIssue(issue: PlanReasonPairValidationIssue): string {
  const allowedKinds = issue.allowedReasonKinds.join(', ') || '<none>';
  return `Invalid plan reason pair for ${issue.deviceName} (${issue.deviceId}): `
    + `plannedState=${issue.plannedState}, reason=${issue.reason}, allowed=${allowedKinds}`;
}

export type ShedHoldParams = {
  planDevices: DevicePlanDevice[];
  state: PlanEngineState;
  shedReasons: Map<string, string>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  debugStructured?: StructuredDebugEmitter;
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  };
};

export function applyShedTemperatureHold(params: ShedHoldParams): {
  planDevices: DevicePlanDevice[];
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
} {
  const {
    planDevices,
    state,
    shedReasons,
    inShedWindow,
    inCooldown,
    activeOvershoot,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    shedCooldownRemainingSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    debugStructured,
    getShedBehavior,
  } = params;

  let headroom = availableHeadroom;
  let restoredOne = restoredOneThisCycle;
  const nextDevices: DevicePlanDevice[] = [];
  const pendingRestoreDelaySec = getPendingRestoreDelaySeconds(planDevices, state, getShedBehavior);

  for (const dev of planDevices) {
    const behavior = getShedBehavior(dev.id);
    const result = applyHoldToDevice({
      dev,
      behavior,
      state,
      shedReasons,
      inShedWindow,
      inCooldown,
      activeOvershoot,
      availableHeadroom: headroom,
      restoredOneThisCycle: restoredOne,
      restoredThisCycle,
      shedCooldownRemainingSec,
      holdDuringRestoreCooldown,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelaySec,
      debugStructured,
    });
    headroom = result.availableHeadroom;
    restoredOne = result.restoredOneThisCycle;
    nextDevices.push(result.device);
  }

  return {
    planDevices: nextDevices,
    availableHeadroom: headroom,
    restoredOneThisCycle: restoredOne,
  };
}

export function normalizeShedReasons(params: {
  planDevices: DevicePlanDevice[];
  shedReasons: Map<string, string>;
  guardInShortfall: boolean;
  headroomRaw: number | null;
  inCooldown: boolean;
  activeOvershoot: boolean;
  shedCooldownRemainingSec: number | null;
}): DevicePlanDevice[] {
  const {
    planDevices,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
  } = params;

  return planDevices.map((dev) => normalizeDeviceReason({
    dev,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
  }));
}

export function finalizePlanDevices(
  planDevices: DevicePlanDevice[],
  options?: {
    onInvalidReasonPair?: (issue: PlanReasonPairValidationIssue) => void;
    throwOnInvalid?: boolean;
  },
): {
  planDevices: DevicePlanDevice[];
  lastPlannedShedIds: Set<string>;
} {
  const sorted = sortByPriorityAsc(planDevices).map(stripCandidateReasons);
  const issues = sorted
    .map(validatePlanReasonPair)
    .filter((issue): issue is PlanReasonPairValidationIssue => issue !== null);

  if (issues.length > 0) {
    for (const issue of issues) {
      options?.onInvalidReasonPair?.(issue);
    }
    if (options?.throwOnInvalid ?? process.env.NODE_ENV === 'test') {
      throw new Error(issues.map(formatPlanReasonPairIssue).join('\n'));
    }
  }

  const lastPlannedShedIds = new Set(sorted.filter((d) => d.plannedState === 'shed').map((d) => d.id));
  return { planDevices: sorted, lastPlannedShedIds };
}

type HoldDecision =
  | { type: 'skip' }
  | { type: 'restore'; availableHeadroom: number; restoredOneThisCycle: boolean }
  | { type: 'hold'; reason: PlanReasonDecision };

function hasTemperatureTarget(dev: DevicePlanDevice): boolean {
  return (typeof dev.currentTarget === 'number' && Number.isFinite(dev.currentTarget))
    || (typeof dev.plannedTarget === 'number' && Number.isFinite(dev.plannedTarget));
}

/* eslint-disable-next-line max-lines-per-function --
target restore admission mirrors binary restore checks and keeps decision/logging together */
function resolveRestoreDecision(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  debugStructured?: StructuredDebugEmitter;
}): HoldDecision {
  const {
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    debugStructured,
  } = params;

  const setbackRemainingMs = getActivationRestoreBlockRemainingMs({ state, deviceId: dev.id });
  const phase = resolveRestoreDecisionPhase(state.currentRebuildReason);
  const restoreDebugKey = `target:${dev.id}`;
  if (setbackRemainingMs !== null) {
    const reason: PlanReasonDecision = { code: 'activation_backoff', remainingMs: setbackRemainingMs };
    const reasonText = renderPlanReasonDecision(reason);
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_rejected',
        restoreType: 'target',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: reasonText,
        availableKw: availableHeadroom,
        decision: 'rejected',
        decisionReason: reasonText,
        penaltyLevel: getActivationPenaltyLevel(state, dev.id),
      },
      debugStructured,
    });
    return { type: 'hold', reason };
  }

  const restoreNeed = getRestoreNeed(dev, state);
  const admission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw: restoreNeed.needed });
  if (admission.postReserveMarginKw < RESTORE_ADMISSION_FLOOR_KW) {
    const reason: PlanReasonDecision = {
      code: 'restore_headroom',
      params: {
        neededKw: restoreNeed.needed,
        availableKw: availableHeadroom,
        postReserveMarginKw: admission.postReserveMarginKw,
        minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
        penaltyExtraKw: restoreNeed.penaltyExtraKw,
      },
    };
    const reasonText = renderPlanReasonDecision(reason);
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_rejected',
        restoreType: 'target',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: reasonText,
        estimatedPowerKw: restoreNeed.devPower,
        powerSource: resolveRestorePowerSource(dev),
        neededKw: restoreNeed.needed,
        availableKw: availableHeadroom,
        ...buildRestoreAdmissionLogFields(admission),
        minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
        decision: 'rejected',
        decisionReason: reasonText,
        penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
        penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
      },
      debugStructured,
    });
    return { type: 'hold', reason };
  }
  const gateReason = resolveCapacityRestoreBlockReason({
    timing: {
      activeOvershoot: false,
      inCooldown: false,
      inRestoreCooldown: false,
      inStartupStabilization: false,
      restoreCooldownSeconds,
      shedCooldownRemainingSec: null,
      restoreCooldownRemainingSec,
      startupStabilizationRemainingSec: null,
    },
    restoredOneThisCycle,
    useThrottleLabel: true,
  });
  if (gateReason) {
    const reason: PlanReasonDecision = { code: 'existing', text: gateReason };
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_rejected',
        restoreType: 'target',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: gateReason,
        estimatedPowerKw: restoreNeed.devPower,
        powerSource: resolveRestorePowerSource(dev),
        neededKw: restoreNeed.needed,
        availableKw: availableHeadroom,
        penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
        penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
        ...buildRestoreAdmissionLogFields(admission),
        decision: 'rejected',
        decisionReason: gateReason,
      },
      debugStructured,
    });
    return { type: 'hold', reason };
  }
  restoredThisCycle.add(dev.id);
  const powerSource = resolveRestorePowerSource(dev);
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_admitted',
      restoreType: 'target',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      estimatedPowerKw: restoreNeed.devPower,
      powerSource,
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      decision: 'admitted',
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
    },
    debugStructured,
  });
  return {
    type: 'restore',
    availableHeadroom: availableHeadroom - restoreNeed.needed,
    restoredOneThisCycle: true,
  };
}

function resolveHoldDecision(params: {
  dev: DevicePlanDevice;
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null };
  state: PlanEngineState;
  shedReasons: Map<string, string>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelaySec: number | null;
  debugStructured?: StructuredDebugEmitter;
}): HoldDecision {
  const {
    dev,
    behavior,
    state,
    shedReasons,
    inShedWindow,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
    debugStructured,
  } = params;

  if (dev.controllable === false) {
    return { type: 'skip' };
  }

  if (behavior.action !== 'set_temperature' || behavior.temperature === null) {
    return { type: 'skip' };
  }
  if (!hasTemperatureTarget(dev)) {
    return { type: 'skip' };
  }

  const atMinTemp = Number(dev.currentTarget) === behavior.temperature
    || Number(dev.plannedTarget) === behavior.temperature;
  const alreadyMinTempShed = dev.shedAction === 'set_temperature' && dev.shedTemperature === behavior.temperature;
  const wasShedLastPlan = state.lastPlannedShedIds.has(dev.id);
  const shouldHold = (inShedWindow || holdDuringRestoreCooldown)
    && (dev.plannedState === 'shed' || atMinTemp || alreadyMinTempShed || wasShedLastPlan);

  if (!shouldHold && wasShedLastPlan) {
    return resolvePostHoldRestoreDecision({
      dev,
      state,
      availableHeadroom,
      restoredOneThisCycle,
      restoredThisCycle,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelaySec,
      debugStructured,
    });
  }

  if (!shouldHold) {
    return { type: 'skip' };
  }

  const baseReason = getBaseShedReason({
    dev,
    shedReasons,
  });
  return { type: 'hold', reason: baseReason };
}

function resolvePostHoldRestoreDecision(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelaySec: number | null;
  debugStructured?: StructuredDebugEmitter;
}): HoldDecision {
  const {
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
    debugStructured,
  } = params;
  if (pendingRestoreDelaySec !== null) {
    return { type: 'hold', reason: { code: 'restore_pending', remainingSec: pendingRestoreDelaySec } };
  }
  return resolveRestoreDecision({
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    debugStructured,
  });
}

function applyHoldToDevice(params: {
  dev: DevicePlanDevice;
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null };
  state: PlanEngineState;
  shedReasons: Map<string, string>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelaySec: number | null;
  debugStructured?: StructuredDebugEmitter;
}): { device: DevicePlanDevice; availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    behavior,
    state,
    shedReasons,
    inShedWindow,
    inCooldown,
    activeOvershoot,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    shedCooldownRemainingSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
    debugStructured,
  } = params;

  const decision = resolveHoldDecision({
    dev,
    behavior,
    state,
    shedReasons,
    inShedWindow,
    inCooldown,
    activeOvershoot,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    shedCooldownRemainingSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
    debugStructured,
  });

  if (decision.type === 'restore') {
    return {
      device: dev,
      availableHeadroom: decision.availableHeadroom,
      restoredOneThisCycle: decision.restoredOneThisCycle,
    };
  }
  if (decision.type === 'hold') {
    return applyHoldUpdate(
      dev,
      behavior,
      renderPlanReasonDecision(decision.reason),
      availableHeadroom,
      restoredOneThisCycle,
    );
  }
  return { device: dev, availableHeadroom, restoredOneThisCycle };
}

function getPendingRestoreDelaySeconds(
  planDevices: DevicePlanDevice[],
  state: PlanEngineState,
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  },
): number | null {
  let maxRemainingMs = 0;
  const nowMs = Date.now();
  for (const dev of planDevices) {
    const behavior = getShedBehavior(dev.id);
    if (behavior.action !== 'set_temperature' || behavior.temperature === null) continue;
    if (typeof dev.currentTarget !== 'number' || dev.currentTarget !== behavior.temperature) continue;
    if (typeof dev.plannedTarget !== 'number' || dev.plannedTarget <= behavior.temperature) continue;

    const lastRestoreMs = state.lastDeviceRestoreMs[dev.id];
    if (!lastRestoreMs) continue;

    const elapsedMs = nowMs - lastRestoreMs;
    const remainingMs = RESTORE_CONFIRM_RETRY_MS - elapsedMs;
    if (remainingMs > maxRemainingMs) {
      maxRemainingMs = remainingMs;
    }
  }
  if (maxRemainingMs <= 0) return null;
  return Math.ceil(maxRemainingMs / 1000);
}

function normalizeDeviceReason(params: {
  dev: DevicePlanDevice;
  shedReasons: Map<string, string>;
  guardInShortfall: boolean;
  headroomRaw: number | null;
  inCooldown: boolean;
  activeOvershoot: boolean;
  shedCooldownRemainingSec: number | null;
}): DevicePlanDevice {
  const {
    dev,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
  } = params;

  if (dev.plannedState !== 'shed') return dev;

  const currentReason = classifyPlanReason(dev.reason);
  const baseReason = buildBaseReason(dev, shedReasons);

  const shortfallReason = maybeApplyShortfallReason({
    dev,
    guardInShortfall,
    currentReason,
    headroomRaw,
  });
  if (shortfallReason) return { ...dev, reason: renderPlanReasonDecision(shortfallReason) };

  const cooldownReason = maybeApplyCooldownReason({
    currentReason,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
  });
  if (cooldownReason) return { ...dev, reason: renderPlanReasonDecision(cooldownReason) };

  if (shouldNormalizeReason(currentReason)) {
    return { ...dev, reason: baseReason };
  }
  return dev;
}

function applyHoldUpdate(
  dev: DevicePlanDevice,
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null },
  reason: string,
  availableHeadroom: number,
  restoredOneThisCycle: boolean,
): { device: DevicePlanDevice; availableHeadroom: number; restoredOneThisCycle: boolean } {
  return {
    device: {
      ...dev,
      plannedState: 'shed',
      shedAction: 'set_temperature',
      shedTemperature: behavior.temperature,
      plannedTarget: behavior.temperature,
      reason,
    },
    availableHeadroom,
    restoredOneThisCycle,
  };
}
