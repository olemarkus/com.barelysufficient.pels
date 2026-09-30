import { getSteppedLoadOffStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import type { DeviceExecutionState, DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import type { SettingsUiPlanDeviceStarvation } from '../../packages/contracts/src/settingsUiApi';
import type { IdleClassification } from '../../packages/contracts/src/idleClassification';
import type { DeviceOverviewSnapshot } from '../../packages/shared-domain/src/deviceOverview';
import {
  displayStateLabel, displayStateTone, resolveDisplayStateKind, resolveIntentStateKind,
} from '../../packages/shared-domain/src/planCardGrammar';
import { isSatisfiedTargetOnlyDevice, type PlanStateKind } from '../../packages/shared-domain/src/planStateLabels';
import {
  resolveHeldCardReasonLine, resolveHeldCardReasonVerb, resolveHeldCardStepView,
} from '../../packages/shared-domain/src/planCardReasonLine';
import { formatDeviceReasonUserFacing, PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveSteppedStatusLine, resolveSteppedEvExceptionLabel, resolveSteppedLevelFact,
  resolveSteppedTemperatureText } from '../../packages/shared-domain/src/planSteppedCardText';
import {
  resolveTemperatureLine, resolveTemperatureReasonLine, resolveBinarySurplusReasonLine,
} from '../../packages/shared-domain/src/planTemperatureCardText';
import { formatIdleClassificationCopy } from '../../packages/shared-domain/src/idleClassificationCopy';
import { toSimulationReasonLine } from '../../packages/shared-domain/src/simulationReasonMood';
import { formatStepDisplayLabel } from '../../packages/shared-domain/src/steppedStepLabel';
import { resolveReportedLoadAfterPauseText, resolveSurplusHoldReportedLoadText,
  readDeviceReasonDetail } from '../../packages/shared-domain/src/planReasonFormatting';

export type DeviceStatusInput = DeviceOverviewSnapshot & {
  execution: DeviceExecutionState;
  starvation?: SettingsUiPlanDeviceStarvation;
  idleClassification?: IdleClassification;
};

function resolveBaseKind(device: DeviceStatusInput): PlanStateKind {
  if (!device.controllable) return 'manual';
  if (!device.execution.available) return 'unavailable';
  if (device.plannedState === 'shed') return 'held';
  if (device.execution.externalOffHeld || device.plannedState === 'inactive') return 'idle';
  if (device.execution.physicalState === 'off') {
    return device.execution.resumeExpected ? 'resuming' : 'idle';
  }
  if (isSatisfiedTargetOnlyDevice(device)) return 'idle';
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

function resolveReason(device: DeviceStatusInput, dryRun: boolean): string | null {
  const kind = resolveBaseKind(device);
  const held = resolveIntentStateKind({ kind, reasonCode: device.reason.code,
    starved: device.starvation?.isStarved === true }) === 'held';
  const stepped = device.steppedLoad;
  if (stepped) {
    return resolveBinarySurplusReasonLine(device, kind)
      ?? resolveSteppedStatusLine(device, stepped.profile, 0, dryRun)
      ?? resolveSteppedEvExceptionLabel(device);
  }
  if (device.temperature) return resolveTemperatureReasonLine(device, dryRun);
  const reported = resolveReportedLoadReason(device, held, dryRun);
  if (reported) return reported;
  const surplus = resolveBinarySurplusReasonLine(device, kind);
  if (surplus) return surplus;
  if (device.reason.code === PLAN_REASON_CODES.externalOffHold && device.currentState !== 'off') return null;
  if (held || device.starvation?.isStarved) return resolveHeldCardReasonLine({
    reason: device.reason, starvation: device.starvation,
    verb: resolveHeldCardReasonVerb({ ...resolveHeldCardStepView(device), currentState: device.currentState }),
  });
  return device.reason.code === PLAN_REASON_CODES.keep
    ? null : formatDeviceReasonUserFacing(device.reason);
}

function buildCountdown(device: DeviceStatusInput, text: string, anchorMs: number) {
  const timed = device.reason as { remainingSec?: number; countdownStartedAtMs?: number; countdownTotalSec?: number };
  if (timed.remainingSec === undefined || !text.includes(`${timed.remainingSec}s`)) return undefined;
  const [prefix, suffix] = text.split(`${timed.remainingSec}s`);
  const totalSec = timed.countdownTotalSec ?? timed.remainingSec;
  const endsAtMs = timed.countdownStartedAtMs === undefined
    ? anchorMs + timed.remainingSec * 1000 : timed.countdownStartedAtMs + totalSec * 1000;
  return { endsAtMs, totalSec, prefix: prefix ?? '', suffix: suffix ?? '' };
}

function buildReason(device: DeviceStatusInput, dryRun: boolean, nowMs: number): DeviceStatus['reason'] {
  const kind = resolveBaseKind(device);
  if (kind === 'unavailable' || kind === 'manual') return null;
  let text = resolveReason(device, dryRun);
  let idle;
  if (text === null && device.idleClassification && device.idleClassification !== 'near_target_idle') {
    idle = formatIdleClassificationCopy({ classification: device.idleClassification,
      currentTemperatureC: device.temperature?.currentTemperature,
      targetTemperatureC: device.temperature?.currentTarget });
    text = idle.statusLine;
  }
  if (text === null || text === '') return null;
  text = toSimulationReasonLine(text, dryRun);
  const countdown = buildCountdown(device, text, nowMs);
  return { text, ...(idle ? { tone: idle.tone, detail: idle.detail } : {}), ...(countdown ? { countdown } : {}) };
}

function resolvePhysicalFact(device: DeviceStatusInput): string | null {
  if (!device.execution.available) return null;
  if (device.execution.physicalState === 'off') return 'Off';
  if (device.steppedLoad && device.execution.observedStepId !== null) {
    return formatStepDisplayLabel(device.execution.observedStepId);
  }
  return null;
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

function resolveCardKind(device: DeviceStatusInput): DeviceStatus['cardKind'] {
  if (device.steppedLoad) return 'stepped';
  return device.temperature ? 'temperature' : 'binary';
}

function resolveHoldCause(device: DeviceStatusInput): DeviceStatus['holdCause'] {
  if (device.reason.code === PLAN_REASON_CODES.deferredObjectiveAvoid) return 'smart_task';
  return device.reason.code === PLAN_REASON_CODES.dailyBudget ? 'daily_budget' : null;
}

/** Presentation consumes executor conclusions; it never resolves control axes. */
export function buildDeviceStatus(device: DeviceStatusInput, dryRun: boolean, nowMs: number): DeviceStatus {
  const grammar = { kind: resolveBaseKind(device), reasonCode: device.reason.code,
    starved: device.starvation?.isStarved === true };
  const intentKind = resolveIntentStateKind(grammar);
  const displayKind = resolveDisplayStateKind({ ...grammar, dryRun, currentState: device.currentState,
    satisfiedTargetOnly: isSatisfiedTargetOnlyDevice(device) });
  const kind = displayKind === 'unknown' ? 'unavailable' : displayKind;
  const limited = intentKind === 'held';
  const physicalFact = kind === 'held' ? resolvePhysicalFact(device) : null;
  const label = [displayStateLabel(kind), physicalFact].filter(Boolean).join(' · ');
  const draw = device.currentDrawKw;
  const factText = device.steppedLoad
    ? resolveSteppedTemperatureText(device) ?? resolveSteppedLevelFact(device)
    : resolveTemperatureLine(device);
  return {
    cardKind: resolveCardKind(device), kind, tone: displayStateTone(kind), label,
    ...resolvePower(device, limited), factText,
    reason: buildReason(device, dryRun, nowMs), rail: resolveRail(device),
    limited, wouldLimit: dryRun && limited,
    canEaseOff: device.controllable && (kind === 'active' || (limited && (draw ?? 0) > 0)),
    controlOffDrawing: !device.controllable && (draw ?? 0) > 0,
    holdCause: resolveHoldCause(device),
  };
}
