import { getSteppedLoadOffStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import type { DeviceStatus, DeviceStatusCountdown } from '../../packages/contracts/src/deviceStatus';
import type { CarIdentificationState } from '../../packages/contracts/src/evCarLink';
import {
  CAR_ASSOCIATION_TIMED_OUT,
  WAITING_FOR_CAR_ASSOCIATION,
} from '../../packages/shared-domain/src/smartTaskCopy/pendingReasons';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import type { SettingsUiPlanDeviceStarvation } from '../../packages/contracts/src/settingsUi/plan';
import type { IdleClassification } from '../../packages/contracts/src/idleClassification';
import type { DeviceOverviewSnapshot } from '../../packages/contracts/src/deviceOverview';
import type { PriceTargetShift } from '../../packages/planner-types/src/temperatureSetpoints';
import type { DeviceControlAdapterSnapshot } from '../../packages/contracts/src/types';
import { isBuiltInSteppedLoadControlEnabled } from '../device/deviceActionProjection';
import {
  displayStateLabel, displayStateTone, isHoldReasonCode, resolveDisplayStateKind, resolveIntentStateKind,
} from '../../packages/shared-domain/src/planCardGrammar';
import {
  isSatisfiedTemperatureDevice, PLAN_STATE_AWAITING_BATTERY_LEVEL_STATUS, reportsSatisfiedTemperature,
  type PlanStateKind,
} from '../../packages/shared-domain/src/planStateLabels';
import {
  formatFairnessHoldCardLine, resolveHeldCardReasonLine, resolveHeldCardReasonVerb, resolveHeldCardStepView,
} from './planCardReasonLine';
import { formatDeviceReasonUserFacing, PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveSteppedStatusLine, resolveSteppedLevelFact,
  resolveSteppedTemperatureText } from './planSteppedCardText';
import {
  EV_CHARGING_STATE_LABELS,
  resolveSteppedEvExceptionLabel,
} from '../../packages/shared-domain/src/evChargingStateLabel';
import {
  resolveTemperatureLine, resolveTemperatureReasonLine, resolveBinarySurplusReasonLine,
} from './planTemperatureCardText';
import { formatIdleClassificationCopy } from '../observer/idleClassificationCopy';
import { toSimulationReasonLine } from './simulationReasonMood';
import { formatStepDisplayLabel } from '../../packages/shared-domain/src/steppedStepLabel';
import { resolveReportedLoadAfterPauseText, resolveSurplusHoldReportedLoadText,
  readDeviceReasonDetail } from '../../packages/shared-domain/src/planReasonFormatting';
import type { DevicePlanDevice } from './planTypes';

export type DeviceStatusInput = DeviceOverviewSnapshot & {
  carIdentificationState: CarIdentificationState;
  execution: DeviceExecutionState;
  starvation?: SettingsUiPlanDeviceStarvation;
  idleClassification?: IdleClassification;
  /** The plan device's own fact (`DevicePlanDevice.priceTargetShift`), spread in with it. */
  priceTargetShift: PriceTargetShift;
  /** The plan device's control adapter, spread in with it; absent on a device that has none. */
  controlAdapter?: DeviceControlAdapterSnapshot;
} & Pick<DevicePlanDevice, 'steppedFairnessHold' | 'steppedStepUpHold'>;

function resolveBaseKind(device: DeviceStatusInput): PlanStateKind {
  if (!device.controllable) return 'manual';
  if (!device.execution.available) return 'unavailable';
  // A running stepped device PELS keeps below its top step for lack of room is
  // held for as long as it waits, though the plan keeps it (`steppedStepUpHold`).
  if (device.plannedState === 'shed' || device.steppedStepUpHold === true) return 'held';
  if (device.execution.externalOffHeld || device.plannedState === 'inactive') return 'idle';
  if (device.execution.physicalState === 'off') {
    if (!device.execution.resumeExpected) return 'idle';
    // A hold (throttled restore, capacity, budget) keeps a device the plan would
    // resume off until it clears: the intent grammar reads it as held. Only a
    // command already in flight is resuming.
    const inFlight = device.execution.binaryProgress === 'pending' || device.execution.steppedTransitionPending;
    return !inFlight && isHoldReasonCode(device.reason.code) ? 'idle' : 'resuming';
  }
  if (isSatisfiedTemperatureDevice(device)) return 'idle';
  if (device.currentState === 'not_applicable' && resolveSteppedEvExceptionLabel(device) !== null) return 'idle';
  return 'active';
}

function resolveReportedLoadReason(device: DeviceStatusInput, held: boolean, dryRun: boolean): string | null {
  if (!held || device.currentDrawKw === undefined || device.currentDrawKw <= 0.05) return null;
  if (device.reason.code === PLAN_REASON_CODES.awaitingSolarSurplus) {
    return resolveSurplusHoldReportedLoadText({ currentDrawKw: device.currentDrawKw, dryRun });
  }
  return resolveReportedLoadAfterPauseText({ currentDrawKw: device.currentDrawKw,
    detail: readDeviceReasonDetail(device.reason), dryRun });
}

function resolveBinaryReason(
  device: DeviceStatusInput, kind: PlanStateKind, held: boolean, dryRun: boolean,
): string | null {
  const reported = resolveReportedLoadReason(device, held, dryRun);
  if (reported) return reported;
  const surplus = resolveBinarySurplusReasonLine(device, kind);
  if (surplus) return surplus;
  if (device.reason.code === PLAN_REASON_CODES.externalOffHold && device.currentState !== 'off') return null;
  if (held || device.starvation?.isStarved) return resolveHeldCardReasonLine(
    device.reason,
    device.starvation,
    resolveHeldCardReasonVerb({ ...resolveHeldCardStepView(device), currentState: device.currentState }),
  );
  return device.reason.code === PLAN_REASON_CODES.keep
    ? null : formatDeviceReasonUserFacing(device.reason);
}

// A step command nothing answers leaves the device where it is however often
// PELS asks, and the card would otherwise keep saying it is moving. The line
// names what carries the level back: the owner's Flow, or the device itself
// under built-in control. Simulation sends no commands, so it has none to say.
function resolveUnansweredStepLine(device: DeviceStatusInput, dryRun: boolean): string | null {
  if (dryRun || !device.execution.stepCommandUnanswered) return null;
  return isBuiltInSteppedLoadControlEnabled(device)
    ? 'Level change not confirmed by the device'
    : 'Level change not confirmed — check the Flow that reports the level back';
}

function resolveReason(device: DeviceStatusInput, dryRun: boolean): string | null {
  const kind = resolveBaseKind(device);
  const held = resolveIntentStateKind({ kind, reasonCode: device.reason.code,
    starved: device.starvation?.isStarved === true }) === 'held';
  // The shared line helpers resolve their own state kind unless handed one; give
  // them this status's kind so a reason line can never contradict the label.
  const resolved = { ...device, stateKind: kind };
  const stepped = device.steppedLoad;
  if (stepped) {
    return resolveUnansweredStepLine(device, dryRun)
      ?? resolveBinarySurplusReasonLine(device, kind)
      ?? resolveSteppedStatusLine(resolved, stepped.profile, 0, dryRun)
      // Settling at a reduced rung does not end the hold or change its cause.
      ?? (held ? resolveHeldCardReasonLine(
        device.reason,
        device.starvation,
        resolveHeldCardReasonVerb({ steppedLoadProfile: stepped.profile, currentState: device.currentState }),
      ) : null);
  }
  if (device.temperature) return resolveTemperatureReasonLine(resolved, dryRun);
  return resolveBinaryReason(device, kind, held, dryRun);
}

// A timed reason keeps its countdown even when its line says something else
// (what a paused device still reports): the card then shows it as its ring.
function buildCountdown(device: DeviceStatusInput, text: string, anchorMs: number): DeviceStatusCountdown | undefined {
  const timed = device.reason as { remainingSec?: number; countdownStartedAtMs?: number; countdownTotalSec?: number };
  if (timed.remainingSec === undefined) return undefined;
  const totalSec = timed.countdownTotalSec ?? timed.remainingSec;
  const endsAtMs = timed.countdownStartedAtMs === undefined
    ? anchorMs + timed.remainingSec * 1000 : timed.countdownStartedAtMs + totalSec * 1000;
  const remaining = `${timed.remainingSec}s`;
  if (!text.includes(remaining)) return { kind: 'beside_text', endsAtMs, totalSec };
  const [prefix, suffix] = text.split(remaining);
  return { kind: 'in_text', endsAtMs, totalSec, prefix: prefix ?? '', suffix: suffix ?? '' };
}

function buildReason(device: DeviceStatusInput, dryRun: boolean, nowMs: number): DeviceStatus['reason'] {
  const kind = resolveBaseKind(device);
  if (kind === 'unavailable' || kind === 'manual') return null;
  let text = resolveReason(device, dryRun);
  const identification = resolveCarIdentificationReason(device, text);
  if (identification) return identification;
  let idle;
  if (text === null && device.idleClassification && device.idleClassification !== 'near_target_idle') {
    idle = formatIdleClassificationCopy({ classification: device.idleClassification,
      currentTemperatureC: device.temperature?.currentTemperature,
      targetTemperatureC: device.temperature?.currentTarget });
    text = idle.statusLine;
  }
  if (text === null || text === '') return null;
  // A fairness hold lasts until other devices resume, not until a timer runs out:
  // the shed cooldown the cycle may carry beside it is not this line's countdown.
  const fairnessLine = device.steppedFairnessHold !== undefined
    && text === formatFairnessHoldCardLine(device.steppedFairnessHold, device.starvation);
  text = toSimulationReasonLine(text, dryRun);
  const countdown = fairnessLine ? undefined : buildCountdown(device, text, nowMs);
  return { text, ...(idle ? { tone: idle.tone, detail: idle.detail } : {}), ...(countdown ? { countdown } : {}) };
}

// A charger still identifying its car says so only where nothing else explains
// the card: no other reason, or the wait for a battery level it is itself. Any
// other reason (a hold for power or cheaper hours, a level change not confirmed)
// stays, since identifying the car would not change it.
function resolveCarIdentificationReason(
  device: DeviceStatusInput,
  reasonText: string | null,
): DeviceStatus['reason'] {
  if (device.carIdentificationState === 'not_waiting') return null;
  if (reasonText !== null && reasonText !== '' && reasonText !== PLAN_STATE_AWAITING_BATTERY_LEVEL_STATUS) return null;
  return device.carIdentificationState === 'timed_out'
    ? { text: CAR_ASSOCIATION_TIMED_OUT, tone: 'warning' }
    : { text: WAITING_FOR_CAR_ASSOCIATION };
}

// The observed rung a held stepped device's state word names, if any.
function resolvePhysicalStepId(device: DeviceStatusInput): string | null {
  if (!device.execution.available || device.execution.physicalState === 'off' || !device.steppedLoad) return null;
  return device.execution.observedStepId;
}

function resolvePhysicalFact(device: DeviceStatusInput): string | null {
  if (!device.execution.available) return null;
  if (device.execution.physicalState === 'off') return 'Off';
  const stepId = resolvePhysicalStepId(device);
  return stepId === null ? null : formatStepDisplayLabel(stepId);
}

function resolvePower(device: DeviceStatusInput, limited: boolean): Pick<DeviceStatus, 'powerText' | 'powerVariant'> {
  const measuredOnly = device.steppedLoad !== undefined || device.temperature !== undefined;
  const draw = device.currentDrawKw;
  if (limited && !measuredOnly && draw !== undefined && draw > 0.05) {
    return { powerText: `Reported ${draw.toFixed(1)} kW`, powerVariant: 'reported' };
  }
  if (measuredOnly) {
    return { powerText: draw === undefined ? null : `${draw.toFixed(1)} kW`, powerVariant: 'live' };
  }
  if (device.execution.physicalState === 'on' && draw !== undefined && draw > 0.05) {
    return { powerText: `${draw.toFixed(1)} kW`, powerVariant: 'live' };
  }
  return { powerText: device.expectedPowerKw > 0.05
    ? `≈ ${device.expectedPowerKw.toFixed(1)} kW when active` : null, powerVariant: 'expected' };
}

function resolveRail(device: DeviceStatusInput): DeviceStatus['rail'] {
  const profile = device.steppedLoad?.profile;
  if (!profile) return null;
  const offStep = getSteppedLoadOffStep(profile);
  const binaryOnlyOff = device.binaryControllable === true && offStep === null;
  const labels = profile.steps.map((step) => formatStepDisplayLabel(step.id));
  const railLabels = binaryOnlyOff ? ['Off', ...labels] : labels;
  let index = profile.steps.findIndex((step) => step.id === device.execution.observedStepId);
  if (device.execution.physicalState === 'off') {
    index = offStep ? profile.steps.indexOf(offStep) : -1;
  }
  let activeIndex: number | null = index < 0 ? null : index + Number(binaryOnlyOff);
  if (device.execution.physicalState === 'off' && binaryOnlyOff) activeIndex = 0;
  return { labels: railLabels, activeIndex };
}

// A charger's plug or car exception ("Unplugged", "Paused by the car") is a fact
// about the device, shown beside its level whatever PELS decided or holds. The
// one exception is the plain idle "Not charging" under the state word `Off`,
// which only restates it; under `Manual` it is the one line naming the plug
// state, so it stays there.
function resolveFactText(
  device: DeviceStatusInput,
  kind: DeviceStatus['kind'],
  stateWordNamesLevel: boolean,
): string | null {
  // A charger still identifying its car has no battery level to show, so the
  // card says so in the battery level's place (`resolveSteppedLevelFact`), or on
  // its own where no level fact shows, as on an off charger.
  const identifying = device.carIdentificationState !== 'not_waiting';
  if (!device.steppedLoad) {
    return resolveTemperatureLine(device) ?? (identifying ? 'Plugged in · no battery level' : null);
  }
  const temperature = resolveSteppedTemperatureText(device);
  if (temperature !== null) return temperature;
  const exception = resolveSteppedEvExceptionLabel(device);
  const lead = kind === 'off' && exception === EV_CHARGING_STATE_LABELS.plugged_in ? null : exception;
  const levelFact = resolveSteppedLevelFact(device, stateWordNamesLevel) ?? (identifying ? 'no battery level' : null);
  const fact = [lead, levelFact].filter((part): part is string => part !== null).join(' · ');
  return fact === '' ? null : `${fact.charAt(0).toUpperCase()}${fact.slice(1)}`;
}

// The device's measure as numbers: the temperature against the target PELS
// plans for, else a charger's known battery level. The fact line words the same
// facts where it has them.
function resolveReading(device: DeviceStatusInput): DeviceStatus['reading'] {
  if (device.temperature) {
    return {
      kind: 'temperature',
      currentC: device.temperature.currentTemperature,
      targetC: device.temperature.plannedTarget,
    };
  }
  const level = device.stateOfCharge?.level;
  return level?.kind === 'known' ? { kind: 'battery', percent: level.percent } : null;
}

function resolveCardKind(device: DeviceStatusInput): DeviceStatus['cardKind'] {
  if (device.steppedLoad) return 'stepped';
  return device.temperature ? 'temperature' : 'binary';
}

function resolveHoldCause(device: DeviceStatusInput): DeviceStatus['holdCause'] {
  if (device.reason.code === PLAN_REASON_CODES.deferredObjectiveAvoid) return 'smart_task';
  if (device.reason.code === PLAN_REASON_CODES.deferredObjectiveSatisfied) return 'smart_task_done';
  return device.reason.code === PLAN_REASON_CODES.dailyBudget ? 'daily_budget' : null;
}

// The target the card names. A planned target the executor is not driving (the
// device is held off, so no write goes out) is not a change in progress: a
// heater its finished smart task held off read `target 18 °C → 20 °C` for hours.
// The card shows the device's own target then, and the arrow only while PELS is
// actually moving it.
function withPresentedTarget(device: DeviceStatusInput): DeviceStatusInput {
  if (!device.temperature || device.execution.targetProgress !== 'undriven') return device;
  return { ...device, temperature: { ...device.temperature, plannedTarget: device.temperature.currentTarget } };
}

/** Presentation consumes executor conclusions; it never resolves control axes. */
export function buildDeviceStatus(device: DeviceStatusInput, dryRun: boolean, nowMs: number): DeviceStatus {
  const grammar = { kind: resolveBaseKind(device), reasonCode: device.reason.code,
    starved: device.starvation?.isStarved === true };
  const intentKind = resolveIntentStateKind(grammar);
  const kind = resolveDisplayStateKind({ ...grammar, dryRun, currentState: device.currentState,
    satisfiedTemperature: reportsSatisfiedTemperature(device) });
  const limited = intentKind === 'held';
  const physicalFact = kind === 'held' ? resolvePhysicalFact(device) : null;
  const label = [displayStateLabel(kind), physicalFact].filter(Boolean).join(' · ');
  const draw = device.currentDrawKw;
  const presented = withPresentedTarget(device);
  return {
    cardKind: resolveCardKind(device), kind, tone: displayStateTone(kind), label,
    ...resolvePower(device, limited),
    factText: resolveFactText(presented, kind, kind === 'held' && resolvePhysicalStepId(device) !== null),
    reading: resolveReading(presented),
    reason: buildReason(device, dryRun, nowMs), rail: resolveRail(device),
    limited, wouldLimit: dryRun && limited,
    canEaseOff: device.controllable && (kind === 'active' || (limited && (draw ?? 0) > 0)),
    controlOffDrawing: !device.controllable && (draw ?? 0) > 0,
    holdCause: resolveHoldCause(device),
  };
}
