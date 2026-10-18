import { isMeteredPlanDevice } from './planMeteredDevice';
import type {
  DeviceDiagnosticsBlockCause,
  DeviceDiagnosticsPlanObservation,
  DeviceDiagnosticsStarvationCountingCause,
} from '../diagnostics/deviceDiagnosticsService';
import type { HeldBackScope, LiveStarvationObservation } from '../diagnostics/deviceDiagnosticsServiceTypes';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveStarvationSuppressionSemantics } from '../planContract/planDecisionSemantics';
import type { MeasuredPower, PlanContext } from './planContext';
import type { RestorePlanResult } from './restore';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { getSteppedLoadHighestStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { temperatureSetpointsFor } from './planTemperatureSetpoints';
import type {
  TemperatureSetpoints,
  TemperatureSetpointsByDevice,
} from '../../packages/planner-types/src/temperatureSetpoints';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import type {
  StarvationTarget,
  StarvationUnmeasuredReason,
} from '../../packages/contracts/src/starvationRescue';

const noStarvationSuppression = (): StarvationSuppressionNormalization => ({
  suppressionState: 'none',
  countingCause: null,
  pauseReason: null,
});

type StarvationSuppressionNormalization = Pick<
  LiveStarvationObservation,
  'suppressionState' | 'countingCause' | 'pauseReason'
>;

export const buildDeviceDiagnosticsObservations = (
  context: PlanContext,
  power: MeasuredPower,
  planDevices: DevicePlanDevice[],
  restoreResult: RestorePlanResult,
  budgetPressureEligible: boolean,
  smartTaskDrivingDeviceIds: ReadonlySet<string>,
): DeviceDiagnosticsPlanObservation[] => {
  const inputDeviceById = new Map(context.devices.map((device) => [device.id, device]));
  return planDevices.map((device) => buildDiagnosticsObservation(
    context,
    power,
    restoreResult,
    budgetPressureEligible,
    device,
    inputDeviceById.get(device.id),
    smartTaskDrivingDeviceIds.has(device.id),
  ));
};

const isTemperatureInputDevice = (inputDevice?: PlanInputDevice): boolean => (
  isTemperatureControlDevice(inputDevice)
);

const resolveCurrentTemperatureC = (
  device: DevicePlanDevice,
): number | null => (
  // The temperature cluster is complete on a narrowed device (atomic facet):
  // one read, no input-device fallback, no finiteness re-check.
  isTemperaturePlanDevice(device) ? device.currentTemperature : null
);

/**
 * The device's resolved setpoints, for a temperature device that exposes a
 * target to command — `null` for every other device, which has no intended
 * temperature to be held short of (the observation's temperature fields are
 * `null` for it too).
 */
const resolveObservationSetpoints = (
  temperatureSetpoints: TemperatureSetpointsByDevice,
  inputDevice?: PlanInputDevice,
): TemperatureSetpoints | null => {
  if (!inputDevice || !isTemperaturePlanDevice(inputDevice)) return null;
  if (!Array.isArray(inputDevice.targets) || inputDevice.targets.length === 0) return null;
  return temperatureSetpointsFor(temperatureSetpoints, inputDevice.id);
};

// The effective target PELS is currently COMMANDING the device toward: the
// planned setpoint this cycle when PELS is applying one, otherwise the held
// current setpoint. Starvation compares this against the intended/mode target —
// a device PELS commands in full (`keep`) is not starved, however cold it is.
const resolveCommandedTargetC = (device: DevicePlanDevice): number | null => {
  if (!isTemperaturePlanDevice(device)) return null;
  return device.plannedTarget;
};

// True when PELS is shedding this temperature device by commanding it OFF: the
// plan decided to shed it (`plannedState === 'shed'`) and the resolved shed
// action is `turn_off` (the default shed behavior — cut power without lowering a
// setpoint). This is just as much PELS holding the device below its target as a
// setpoint-lowering shed, but it leaves no lowered commanded target for the
// commanded-vs-intended check to detect, so it is surfaced as its own signal.
// A device the USER turned off is not being shed by PELS (`plannedState` is
// `keep`), so it never sets this.
const resolvePelsCommandsTurnOffShed = (
  device: DevicePlanDevice,
  isTemperatureDevice: boolean,
): boolean => (
  isTemperatureDevice
  && device.plannedState === 'shed'
  && device.shedAction === 'turn_off'
);

/** The plan limits this device by moving its setpoint to the limit — the outcome, not a comparison. */
const isLimitedBySetpoint = (device: DevicePlanDevice): boolean => (
  device.plannedState === 'shed' && device.shedAction === 'set_temperature'
);

/**
 * Whether the setpoint PELS commands this cycle asks for less work than the
 * owner's intended target — asked by OUTCOME. The plan says which setpoint it
 * commands (the limit, the surplus lift, or the kept target), and the resolved
 * setpoints say whether that one falls short of the intended target on the
 * device's own axis. A commanded 19 against an intended 22 is a held-back heater
 * and a harder-working air conditioner, and the planner cannot tell which.
 */
const pelsCommandsBelowTarget = (device: DevicePlanDevice, setpoints: TemperatureSetpoints): boolean => {
  const { shed } = setpoints;
  if (shed.action === 'set_temperature' && isLimitedBySetpoint(device)) return shed.asksLessThanIntended;
  if (device.surplusAbsorbActive === true) return setpoints.surplusAsksLessThanIntended;
  return setpoints.keepAsksLessThanIntended;
};

/**
 * The one resolution of "PELS is holding this device below its intended target",
 * resolved HERE in the producer and carried on the observation. Both consumers
 * read the same boolean: the starvation episode engine (the "Held back" clock)
 * and the demand/censoring counters that feed the daily-budget evidence. They
 * disagreed for five days in production — the censoring side saw only a lowered
 * setpoint, so a turn_off shed recorded nothing while the badge counted hours —
 * which is exactly the divergence a single producer-side resolution forecloses.
 *
 * A turn_off shed leaves no lowered commanded target to detect, so it counts
 * when the room itself is still short of the intended target; a device that is
 * off because it already reached its target is satisfied, not starved.
 */
const resolvePelsHoldsTemperatureBelowTarget = (
  device: DevicePlanDevice,
  setpoints: TemperatureSetpoints | null,
  pelsCommandsTurnOffShed: boolean,
): boolean => (
  setpoints !== null
  && (pelsCommandsBelowTarget(device, setpoints) || (pelsCommandsTurnOffShed && setpoints.roomShortOfIntended))
);

/** The car is below its charger's target battery level (`PlanInputDevice.chargeTargetHold`). */
const isChargerShortOfTarget = (inputDevice: PlanInputDevice | undefined): boolean => (
  inputDevice?.chargeTargetHold.kind === 'below_target'
);

/**
 * A charger's target battery level, when the producer measured the car against
 * one (`PlanInputDevice.chargeTargetHold`): a known level below it or at it. The
 * planner holds no battery level, so this is the whole of what starvation knows
 * about the car — short of the target or not.
 */
const resolveChargerStarvationTarget = (inputDevice: PlanInputDevice | undefined): StarvationTarget | null => {
  const hold = inputDevice?.chargeTargetHold;
  if (hold?.kind !== 'below_target' && hold?.kind !== 'target_reached' && hold?.kind !== 'at_full_target') return null;
  return { kind: 'ev_soc', targetPercent: hold.targetPercent };
};

/**
 * The target the starvation clock measures this device against: the mode
 * temperature of a temperature device, or a charger's target battery level.
 */
const resolveStarvationTarget = (
  setpoints: TemperatureSetpoints | null,
  inputDevice: PlanInputDevice | undefined,
): StarvationTarget | null => (
  setpoints !== null
    ? { kind: 'temperature', targetTemperatureC: setpoints.intendedC }
    : resolveChargerStarvationTarget(inputDevice)
);

/** This cycle's reason is a counting capacity or budget hold. */
const isCountingHold = (device: DevicePlanDevice): boolean => (
  resolveStarvationSuppressionSemantics(device.reason).state === 'counting'
);

/**
 * The plan keeps this charger from charging at full rate, asked by OUTCOME, as
 * the setpoint comparison asks a thermostat: paused, or a stepped charger whose
 * planned step is below its top step, whatever reason the cycle wrote.
 */
const isChargerKeptFromFullRate = (device: DevicePlanDevice): boolean => {
  if (device.plannedState === 'shed') return true;
  if (!isSteppedLoadDevice(device) || device.desiredStepId === undefined) return false;
  return device.desiredStepId !== getSteppedLoadHighestStep(device.steppedLoadProfile)?.id;
};

/**
 * "PELS is holding this device below its intended target" for both kinds. A
 * charger is held below its target battery level when the plan keeps it from
 * full rate while the car is short of the target; a charger at its target, or
 * one PELS lets charge at full rate, is not.
 */
const resolvePelsHoldsBelowTarget = (
  device: DevicePlanDevice,
  inputDevice: PlanInputDevice | undefined,
  setpoints: TemperatureSetpoints | null,
  pelsCommandsTurnOffShed: boolean,
): boolean => {
  if (setpoints !== null) return resolvePelsHoldsTemperatureBelowTarget(device, setpoints, pelsCommandsTurnOffShed);
  return isChargerShortOfTarget(inputDevice) && isChargerKeptFromFullRate(device);
};

/**
 * The device wants energy it may be denied, for the starvation lanes: standing
 * demand (`hasStandingDemand`), or a charger whose car is below its target
 * battery level. A charger carries no standing demand, because its demand comes
 * with a car; a car short of the owner's target is that demand.
 */
const resolveStarvationDemand = (inputDevice: PlanInputDevice | undefined, hasStandingDemand: boolean): boolean => (
  hasStandingDemand || isChargerShortOfTarget(inputDevice)
);

/**
 * Why starvation does or does not measure this device.
 *
 * - `eligible`: it has a target, and PELS is the one that would hold it.
 * - `unmeasured`: it has no target starvation can measure, and `reason` says
 *   which, in the held-back widget's terms.
 * - `excluded`: it has a target, but something other than PELS holds it (the
 *   owner's own hold, its smart task's deferral), or PELS cannot command it.
 */
type StarvationEligibility =
  | { kind: 'eligible' }
  | { kind: 'unmeasured'; reason: StarvationUnmeasuredReason }
  | { kind: 'excluded' };

const ELIGIBLE: StarvationEligibility = { kind: 'eligible' };
const EXCLUDED: StarvationEligibility = { kind: 'excluded' };
const unmeasured = (reason: StarvationUnmeasuredReason): StarvationEligibility => ({ kind: 'unmeasured', reason });

/**
 * Whether this device has a target starvation can measure: a supported
 * temperature device that always wants heat below target, or a charger with a
 * target battery level and a known level. A charger at its target is measured,
 * so reaching it clears an episode rather than resetting one.
 */
const resolveStarvationTargetEligibility = (
  inputDevice: PlanInputDevice,
  hasStandingDemand: boolean,
): StarvationEligibility => {
  if (isTemperatureInputDevice(inputDevice)) {
    return hasStandingDemand && inputDevice.starvationSupported ? ELIGIBLE : unmeasured('no_target');
  }
  switch (inputDevice.chargeTargetHold.kind) {
    case 'below_target':
    case 'target_reached':
    case 'at_full_target':
      return ELIGIBLE;
    case 'no_target':
      return unmeasured('no_battery_target');
    case 'level_unknown':
    case 'awaiting_level':
      return unmeasured('battery_level_unknown');
    case 'none':
      return unmeasured('no_target');
    default: {
      const exhaustive: never = inputDevice.chargeTargetHold;
      return exhaustive;
    }
  }
};

const resolveStarvationEligibility = (
  device: DevicePlanDevice,
  inputDevice: PlanInputDevice | undefined,
  hasStandingDemand: boolean,
): StarvationEligibility => {
  if (!inputDevice) return EXCLUDED;
  const targetEligibility = resolveStarvationTargetEligibility(inputDevice, hasStandingDemand);
  if (targetEligibility.kind !== 'eligible') return targetEligibility;
  // A device the user turned off outside PELS is not starved — PELS is not
  // withholding power from it, it is respecting an explicit action. Excluding it
  // from ELIGIBILITY (rather than pausing an episode) resets any accrual and
  // keeps it out of the Held-back list entirely, which is what keeps
  // `notes/ui-terminology.md` § "Held back" accurate: there is still no
  // "manual"/"external" starvation cause.
  if (device.externalOffHoldActive === true) return EXCLUDED;
  // Same treatment, same reason, for "Only PELS starts this device": PELS is not
  // withholding power, it is honouring a configuration. ELIGIBILITY rather than a
  // paused episode is load-bearing here — a standing baseline-off posture holds
  // the device below target forever, so `clearQualified` (which requires
  // `!pelsHoldsBelowTarget`) could never fire and a latched episode would stay
  // latched, leaving the card permanently reading "Waiting for available power"
  // with a "Let it run now" rescue against the owner's own setting.
  //
  // Read the DECIDED hold, not the owner's setting: during an hour its smart task
  // is driving the device the hold is lifted, and the device becomes eligible
  // again — which is correct, because a task-driven device that is being denied
  // power IS starved, and that is the hour the owner would want to know about.
  // The episode cannot outlive the hour: `applyObservationSpan` hard-resets the
  // accrual on the first cycle eligibility drops, which is the cycle the hold
  // returns.
  if (device.startPolicyHoldActive === true) return EXCLUDED;
  // And for an hour the device's own smart task defers (`deferredHoldActive`): the
  // task scheduled its energy for a cheaper hour and holds the device off until
  // then (owner ruling, 2026-09-25). PELS is not withholding power, and a "Let it
  // run now" rescue would argue with the task's own schedule. Its planned hours
  // are not held, so a task-driven device denied power there still counts.
  // The hold being ACTIVE, not the hold-only shed (`nonCapacityHoldShed`), exactly
  // as `startPolicyHoldActive` above: the task keeps the device off this hour even
  // when capacity also wanted it off, so it is not waiting for power either way.
  if (inputDevice.deferredHoldActive === true) return EXCLUDED;
  // One read, not two: `DevicePlanDevice.control` is carried through from the
  // plan input unchanged, so asking both shapes was a dead second read.
  return inputDevice.control.managed
    && inputDevice.control.commandAuthority
    && inputDevice.available
    && device.available
    ? ELIGIBLE
    : EXCLUDED;
};

/**
 * PELS limits this device for power: a device it commands, held by a counting
 * capacity or budget hold, whether paused or kept below its top step.
 */
const isLimitedForPower = (device: DevicePlanDevice): boolean => (
  device.plannedState !== 'inactive'
  && device.control.commandAuthority
  && isCountingHold(device)
);

/**
 * The held-back widget's view of a device: off the list unless PELS limits it
 * for power and nothing else holds it; a candidate when starvation measures it;
 * otherwise why it is not measured.
 */
const resolveHeldBackScope = (device: DevicePlanDevice, eligibility: StarvationEligibility): HeldBackScope => {
  if (!isLimitedForPower(device) || eligibility.kind === 'excluded') return 'off_list';
  return eligibility.kind === 'eligible' ? 'candidate' : eligibility.reason;
};

// A restore held for `insufficient_headroom` is blocked against the binding soft limit.
// When that hold is BUDGET-RELEASABLE — the daily budget is the binding limit and
// capacity is not also breached (`budgetReleasableHeadroomHold`, producer-resolved)
// — the physical capacity cap is not the constraint doing the work; the daily budget is,
// and it is the releasable lever the owner can rescue against. Re-attribute the counting
// cause to `daily_budget` so device detail and the emitted `device_starvation_started`
// cause both read the true, releasable cause — without any consumer re-deriving the
// source. This mirrors the shed-time re-attribution `resolveShedReason`/`buildBaseReason`
// already perform for capacity→daily. A genuine capacity-bound shortfall — physical
// capacity, or an exhausted hourly cap (which forces `softLimitSource` to 'capacity') —
// keeps `insufficient_headroom`. (The silent-meter pass never reaches this: it plans no
// restores and observes no diagnostics.)
//
// This re-attribution no longer gates anything user-facing. Until 2026-08-04 it fed the
// flat overview `budget | capacity` bucket, which decided whether the "Let it run now"
// rescue was offered; both the bucket and that gate are gone (the rescue is offered on
// either axis). What remains is diagnostic honesty — do not restore a consumer that
// branches on it.
const reattributeHeadroomShortfallCause = (
  countingCause: DeviceDiagnosticsStarvationCountingCause | null,
  budgetReleasableHeadroomHold: boolean,
): DeviceDiagnosticsStarvationCountingCause | null => (
  countingCause === 'insufficient_headroom' && budgetReleasableHeadroomHold
    ? 'daily_budget'
    : countingCause
);

const resolveSuppressionFromReason = (
  reason: DeviceReason,
  budgetReleasableHeadroomHold: boolean,
): StarvationSuppressionNormalization => {
  const semantics = resolveStarvationSuppressionSemantics(reason);
  return {
    suppressionState: semantics.state,
    countingCause: reattributeHeadroomShortfallCause(semantics.countingCause, budgetReleasableHeadroomHold),
    pauseReason: semantics.pauseReason,
  };
};

const resolveStarvationSuppression = (
  device: DevicePlanDevice,
  inputDevice: PlanInputDevice | undefined,
  hasStandingDemand: boolean,
  budgetReleasableHeadroomHold: boolean,
): StarvationSuppressionNormalization => {
  if (
    !resolveStarvationDemand(inputDevice, hasStandingDemand)
    || !inputDevice
    || !device.control.commandAuthority
    || !inputDevice.control.commandAuthority
  ) {
    return noStarvationSuppression();
  }
  const reason = device.reason;
  const normalized = resolveSuppressionFromReason(reason, budgetReleasableHeadroomHold);
  if (normalized.suppressionState !== 'none') {
    return normalized;
  }

  if (device.plannedState === 'shed') {
    return {
      suppressionState: 'paused',
      countingCause: null,
      pauseReason: 'unknown_suppression_reason',
    };
  }

  return normalized;
};

const buildAppliedStateSummary = (
  desiredTarget: number | null,
  currentTarget: number | null,
  currentState: string,
): string => {
  if (desiredTarget === null) return currentState;
  return currentTarget !== null ? `${currentTarget.toFixed(1)}C` : 'unknown';
};

// A device wants energy it is not getting. For a device with a resolvable target
// that is EITHER a lowered setpoint (`targetDeficitActive`) OR a turn_off shed
// while the room sits below target — the second disjunct is load-bearing: a
// turn_off shed leaves the setpoint intact, so the setpoint comparison alone
// reads a device PELS has switched off for hours as fully satisfied, and every
// counter gated on `unmetDemand` records nothing. Devices with no resolvable
// target keep the plain off-and-not-inactive test.
const resolveUnmetDemand = (
  desiredTarget: number | null,
  includeDemandMetrics: boolean,
  targetDeficitActive: boolean,
  pelsHoldsBelowTarget: boolean,
  device: DevicePlanDevice,
): boolean => {
  if (desiredTarget !== null) return targetDeficitActive || (includeDemandMetrics && pelsHoldsBelowTarget);
  return includeDemandMetrics && device.currentState === 'off' && device.plannedState !== 'inactive';
};

/** Daily-budget demand evidence; the thermostat owns physical target comparisons. */
const resolveBudgetUnservedDenied = (
  device: DevicePlanDevice,
  setpoints: TemperatureSetpoints | null,
  suppression: StarvationSuppressionNormalization,
  eligible: boolean,
  heldBelowTarget: boolean,
  budgetReleasable: boolean,
): boolean => (
  eligible
  && budgetReleasable
  && heldBelowTarget
  && setpoints !== null
  && setpoints.roomShortOfIntended
  && suppression.countingCause === 'daily_budget'
  && isMeteredPlanDevice(device)
);

const resolveBudgetDemandRecovered = (
  device: DevicePlanDevice,
  inputDevice: PlanInputDevice | undefined,
  setpoints: TemperatureSetpoints | null,
): boolean => (
  device.available && inputDevice?.available === true
  && setpoints !== null && !setpoints.roomShortOfIntended
);

const buildDiagnosticsObservation = (
  context: PlanContext,
  power: MeasuredPower,
  restoreResult: RestorePlanResult,
  budgetPressureEligible: boolean,
  device: DevicePlanDevice,
  inputDevice: PlanInputDevice | undefined,
  smartTaskDriving: boolean,
): DeviceDiagnosticsPlanObservation => {
  // Producer-resolved on `MeasuredPower` (see the field doc there): daily pace binding
  // AND no physical limit (capacity or grid) also breached. Hourly-cap exhaustion forces
  // `softLimitSource` to 'capacity' (capacitySoftLimit → 0), so exhausted hours stay
  // in the capacity bucket too. Reading the shared field keeps this fold and the
  // device-reason re-attribution in `normalizeShedReasons` in lockstep — the breach
  // term is what stops the rescue widget offering "Let it run now" during a genuine
  // capacity breach while the card correctly keeps the headroom framing.
  const { budgetReleasableHeadroomHold } = power;
  // Demand metrics and the starvation lanes both ask the same question — does
  // being off mean this device is going without? — and the producer answered it
  // (`hasStandingDemand`). A charger with no car is not starved, and neither
  // this file nor its callers need to know that is what makes it different.
  const { hasStandingDemand } = device;
  const includeDemandMetrics = (hasStandingDemand || smartTaskDriving)
    && device.control.commandAuthority
    && device.available;
  const setpoints = resolveObservationSetpoints(context.temperatureSetpoints, inputDevice);
  const desiredTarget = setpoints === null ? null : setpoints.desiredC;
  const currentTarget = isTemperaturePlanDevice(device) ? device.currentTarget : null;
  const currentTemperatureC = resolveCurrentTemperatureC(device);
  const commandedTargetC = resolveCommandedTargetC(device);
  const pelsCommandsTurnOffShed = resolvePelsCommandsTurnOffShed(
    device,
    isTemperatureInputDevice(inputDevice),
  );
  const eligibility = resolveStarvationEligibility(device, inputDevice, hasStandingDemand);
  const eligibleForStarvation = eligibility.kind === 'eligible';
  const starvationSuppression = resolveStarvationSuppression(
    device,
    inputDevice,
    hasStandingDemand,
    budgetReleasableHeadroomHold,
  );
  const targetDeficitActive = includeDemandMetrics
    && setpoints !== null
    && currentTarget !== null
    && setpoints.targetShortOfDesired;
  const pelsHoldsBelowTarget = resolvePelsHoldsBelowTarget(device, inputDevice, setpoints, pelsCommandsTurnOffShed);
  const unmetDemand = resolveUnmetDemand(
    desiredTarget,
    includeDemandMetrics,
    targetDeficitActive,
    pelsHoldsBelowTarget,
    device,
  );

  return {
    deviceId: device.id,
    name: device.name,
    demand: {
      includeDemandMetrics,
      unmetDemand,
      blockCause: resolveDiagnosticsBlockCause(device, desiredTarget, targetDeficitActive, unmetDemand, restoreResult),
      targetDeficitActive,
      desiredStateSummary: desiredTarget !== null ? `${desiredTarget.toFixed(1)}C` : 'on',
      appliedStateSummary: buildAppliedStateSummary(desiredTarget, currentTarget, device.currentState),
      expectedPowerKw: device.expectedPowerKw,
      // Denied demand is priced as energy the budget kept from the device, which
      // takes a device PELS could have powered: one with a power reading. A
      // temperature device planned for its setpoints alone was never offered power
      // to deny, so holding it below target is not budget pressure.
      budgetPressureDenied: budgetPressureEligible && unmetDemand && isMeteredPlanDevice(device),
      budgetUnservedDenied: resolveBudgetUnservedDenied(
        device, setpoints, starvationSuppression, eligibleForStarvation, pelsHoldsBelowTarget,
        budgetReleasableHeadroomHold,
      ),
      budgetDemandRecovered: resolveBudgetDemandRecovered(device, inputDevice, setpoints),
    },
    starvation: {
      eligibleForStarvation,
      heldBackScope: resolveHeldBackScope(device, eligibility),
      currentTemperatureC,
      intendedTarget: resolveStarvationTarget(setpoints, inputDevice),
      commandedTargetC,
      targetStepC: setpoints === null ? null : setpoints.targetStepC,
      pelsCommandsTurnOffShed,
      pelsHoldsBelowTarget,
      ...starvationSuppression,
    },
  };
};

const resolveDiagnosticsBlockCause = (
  device: DevicePlanDevice,
  desiredTarget: number | null,
  targetDeficitActive: boolean,
  unmetDemand: boolean,
  restoreResult: RestorePlanResult,
): DeviceDiagnosticsBlockCause => {
  if (!unmetDemand) return 'not_blocked';

  if (desiredTarget !== null) {
    return resolveTemperatureBlockCause(device, targetDeficitActive, restoreResult);
  }

  if (device.plannedState === 'inactive' || device.plannedState === 'keep') {
    return 'not_blocked';
  }
  if (restoreResult.timing.activeOvershoot) {
    return 'headroom';
  }
  if (isBinaryDeviceBlockedByCooldown(device, restoreResult)) {
    return 'cooldown_backoff';
  }
  return 'headroom';
};

const resolveTemperatureBlockCause = (
  device: DevicePlanDevice,
  targetDeficitActive: boolean,
  restoreResult: RestorePlanResult,
): DeviceDiagnosticsBlockCause => {
  // The plan is already taking the device to what the owner wants unless it is
  // commanding the limit: the kept and surplus setpoints both reach the desired
  // target by construction (`TemperatureSetpoints.keepC`).
  const plannedToRecover = targetDeficitActive && !isLimitedBySetpoint(device);
  if (plannedToRecover) return 'not_blocked';
  if (restoreResult.timing.activeOvershoot) {
    return 'headroom';
  }
  if (restoreResult.timing.inCooldown || restoreResult.timing.inRestoreCooldown) {
    return 'cooldown_backoff';
  }
  return 'headroom';
};

const isBinaryDeviceBlockedByCooldown = (
  device: DevicePlanDevice,
  restoreResult: RestorePlanResult,
): boolean => (
  restoreResult.timing.inCooldown
  || restoreResult.timing.inRestoreCooldown
  || (restoreResult.restoredOneThisCycle && !restoreResult.restoredThisCycle.has(device.id))
);
