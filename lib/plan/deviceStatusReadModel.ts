import { getSteppedLoadOffStep, getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import type { DeviceStatus, DeviceStatusCountdown } from '../../packages/contracts/src/deviceStatus';
import {
  CAR_ASSOCIATION_SELECTED_CARS_UNPLUGGED,
  CAR_ASSOCIATION_TIMED_OUT,
  WAITING_FOR_CAR_ASSOCIATION,
} from '../../packages/shared-domain/src/smartTaskCopy/pendingReasons';
import { isBuiltInSteppedLoadControlEnabled } from '../device/deviceActionProjection';
import type { UnusedBuiltInControl } from '../device/builtInControlFlowGate';
import {
  displayStateLabel, displayStateTone, isHoldReasonCode, resolveDisplayStateKind, resolveIntentStateKind,
} from '../../packages/shared-domain/src/planCardGrammar';
import {
  isSatisfiedTemperatureDevice, PLAN_STATE_AWAITING_BATTERY_LEVEL_STATUS, reportsSatisfiedTemperature,
  type PlanStateKind,
} from '../../packages/shared-domain/src/planStateLabels';
import {
  formatFairnessHoldCardLine, isCeilingHoldReasonCode, resolveHeldCardReasonLine,
  resolveHeldCardReasonVerb, resolveHeldCardStepView,
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
  formatTemperatureTarget,
} from './planTemperatureCardText';
import { formatIdleClassificationCopy } from '../observer/idleClassificationCopy';
import { toSimulationReasonLine } from './simulationReasonMood';
import { formatStepDisplayLabel } from '../../packages/shared-domain/src/steppedStepLabel';
import { resolveReportedLoadAfterPauseText, resolveSurplusHoldReportedLoadText,
  readDeviceReasonDetail } from '../../packages/shared-domain/src/planReasonFormatting';
import { HOMEY_ENERGY_SETUP_REASON } from '../../packages/shared-domain/src/homeyEnergySetup';
import { formatDisplayDeviceName } from '../../packages/shared-domain/src/displayDeviceName';
import type { DeviceStatusInput } from './deviceStatusInput';

/** The reason line of a card Homey reports unavailable, as the Tesla adapter words it. */
export const HOMEY_UNAVAILABLE_REASON_TEXT = 'Homey reports this device unavailable';

/** The reason line of a Manual card whose owner did not grant PELS control of it. */
export const MANUAL_REASON_TEXT = 'Power-limit control is off';

/** The reason line of a Manual card PELS may control but has no power reading from. */
export const NO_POWER_READING_REASON_TEXT = 'No power reading from this device';

function resolveBaseKind(device: DeviceStatusInput): PlanStateKind {
  if (!hasDeviceControl(device)) return 'manual';
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

function hasDeviceControl(device: DeviceStatusInput): boolean {
  if (resolveRunningLastResortReadingKw(device) !== undefined) return false;
  if (device.lastResort?.metered && device.currentState === 'off'
    && device.lastResortOwnedOffAtMs === undefined && device.plannedState !== 'shed') return false;
  return device.controllable || (device.temperature !== undefined && device.execution.targetProgress !== 'undriven');
}

function resolveRunningLastResortReadingKw(device: DeviceStatusInput): number | undefined {
  if (device.lastResort && device.execution.available && device.execution.physicalState === 'on'
    && device.execution.binaryProgress !== 'pending') return device.currentDrawKw;
  return undefined;
}

const TARGET_POWER_CONTROL_REFUSED_LINE = 'PELS can only turn it on and off: its app does not accept level control';

function relayPowerReason(device: DeviceStatusInput): string | null {
  if (device.execution.physicalState !== 'off') return null;
  const evidence = device.execution.relayShedPowerEvidence;
  if (evidence === 'awaiting_power') return 'Waiting for a power reading after switch-off';
  if (device.currentDrawKw === undefined || device.currentDrawKw <= 0.05) return null;
  const draw = `${device.currentDrawKw.toFixed(1)} kW`;
  if (evidence === 'off_with_draw') return `Reports off, still drawing ${draw}`;
  return evidence === 'post_command' || evidence === 'relieved' ? `Reported ${draw} after switch-off` : null;
}

function resolveReportedLoadReason(device: DeviceStatusInput, held: boolean, dryRun: boolean): string | null {
  if (!held) return null;
  const relayEvidence = dryRun ? null : relayPowerReason(device);
  if (relayEvidence) return relayEvidence;
  if (device.currentDrawKw === undefined || device.currentDrawKw <= 0.05) return null;
  if (device.reason.code === PLAN_REASON_CODES.awaitingSolarSurplus) {
    return resolveSurplusHoldReportedLoadText({ currentDrawKw: device.currentDrawKw, dryRun });
  }
  return resolveReportedLoadAfterPauseText({ currentDrawKw: device.currentDrawKw,
    detail: readDeviceReasonDetail(device.reason), dryRun });
}

function resolveBinaryReason(device: DeviceStatusInput, kind: PlanStateKind, held: boolean): string | null {
  const surplus = resolveBinarySurplusReasonLine(device, kind);
  if (surplus) return surplus;
  if (device.reason.code === PLAN_REASON_CODES.externalOffHold && device.currentState !== 'off') return null;
  if (held || device.starvation?.isStarved) return resolveHeldCardReasonLine(
    device.reason,
    device.starvation,
    resolveHeldCardReasonVerb({ ...resolveHeldCardStepView(device), currentState: device.currentState }),
  );
  if (device.reason.code !== PLAN_REASON_CODES.keep) return formatDeviceReasonUserFacing(device.reason);
  // A kept device has nothing else to say, so the card says why it has no level.
  return device.targetPowerControlRefused ? TARGET_POWER_CONTROL_REFUSED_LINE : null;
}

// A step command nothing answers leaves the device where it is however often
// PELS asks, and the card would otherwise keep saying it is moving. The line
// names what carries the level back: the device itself under built-in control,
// else the owner's Flow. A device whose built-in control a Flow holds back is
// pointed at built-in control instead, which needs no Flow to report back. A
// charger with neither built-in control nor a current-setting Flow has nothing
// applying its level, so it is pointed at its unfinished setup.
// Simulation sends no commands, so it has none to say.
const UNANSWERED_STEP_LINES: Record<UnusedBuiltInControl, string> = {
  none: 'Level change not confirmed — check the Flow that reports the level back',
  held_by_flow: 'Level change not confirmed — disable your Flow to use built-in control',
  not_set_up: 'Level change not applied — finish Charging current setup',
  needs_app_update: 'Level change not applied — update the charger app',
};

function resolveUnansweredStepLine(device: DeviceStatusInput, dryRun: boolean): string | null {
  if (dryRun || !device.execution.stepCommandUnanswered) return null;
  if (isBuiltInSteppedLoadControlEnabled(device)) return 'Level change not confirmed by the device';
  return UNANSWERED_STEP_LINES[device.unusedBuiltInControl];
}

// A power-limit or hold line describes the device first; preparation only explains an otherwise
// unexplained mode-preparation target.
function resolveModePreparationLine(device: DeviceStatusInput, dryRun: boolean, held: boolean): string | null {
  if (!device.modePreparation || dryRun || held || device.execution.externalOffHeld) return null;
  return `Getting ready for ${device.modePreparation.mode} at ${device.modePreparation.at}`;
}

function resolveReason(device: DeviceStatusInput, dryRun: boolean, powerPredatesSwitchOff: boolean): string | null {
  const kind = resolveBaseKind(device);
  const held = resolveIntentStateKind({ kind, reasonCode: device.reason.code,
    starved: device.starvation?.isStarved === true }) === 'held';
  // The shared line helpers resolve their own state kind unless handed one; give
  // them this status's kind so a reason line can never contradict the label.
  const resolved = { ...device, stateKind: kind };
  const stepped = device.steppedLoad;
  if (stepped) {
    const reason = resolveBinarySurplusReasonLine(device, kind)
      ?? resolveSteppedStatusLine(resolved, stepped.profile, 0, dryRun)
      // Settling at a reduced rung does not end the hold or change its cause.
      ?? (held ? resolveHeldCardReasonLine(
        device.reason,
        device.starvation,
        resolveHeldCardReasonVerb({ steppedLoadProfile: stepped.profile, currentState: device.currentState }),
      ) : null);
    return reason ?? resolveModePreparationLine(device, dryRun, held);
  }
  if (device.temperature) {
    return resolveTemperatureReasonLine(resolved, dryRun) ?? resolveModePreparationLine(device, dryRun, held);
  }
  const reported = powerPredatesSwitchOff ? null : resolveReportedLoadReason(device, held, dryRun);
  return reported ?? resolveBinaryReason(device, kind, held);
}

const ADDITIONAL_SIMULATION_POWER_HOLDS: ReadonlySet<string> = new Set([
  PLAN_REASON_CODES.shortfall,
  PLAN_REASON_CODES.hourlyBudget,
  PLAN_REASON_CODES.endOfHourDrain,
  PLAN_REASON_CODES.phaseLimit,
  PLAN_REASON_CODES.meterSilent,
]);

// A device still on, or controlled by target alone, has not delivered the
// simulated limit. Describe its decided command before the ordinary hold line.
function resolveSimulatedActionLine(device: DeviceStatusInput): string | null {
  if (device.execution.physicalState === 'off' || device.steppedFairnessHold || device.steppedStepUpHold) return null;
  const powerHold = isCeilingHoldReasonCode(device.reason.code)
    || ADDITIONAL_SIMULATION_POWER_HOLDS.has(device.reason.code);
  if (!powerHold || resolveIntentStateKind({ kind: resolveBaseKind(device), reasonCode: device.reason.code,
    starved: device.starvation?.isStarved === true }) !== 'held') return null;
  const execution = device.execution;
  if (execution.physicalState === 'on' && execution.desiredBinary === 'off') return 'Would turn off (simulation)';
  return resolveSimulatedLevelLine(device) ?? resolveSimulatedTargetLine(device);
}

function resolveSimulatedLevelLine(device: DeviceStatusInput): string | null {
  const execution = device.execution;
  if (device.steppedLoad && execution.desiredStepId !== execution.observedStepId) {
    const step = getSteppedLoadStep(device.steppedLoad.profile, execution.desiredStepId);
    if (step) return `Would set level to ${formatStepDisplayLabel(step.id)} (simulation)`;
  }
  return null;
}

function resolveSimulatedTargetLine(device: DeviceStatusInput): string | null {
  if (device.temperature && device.execution.targetProgress !== 'undriven'
    && device.temperature.plannedTarget !== device.temperature.currentTarget) {
    return `Would set target to ${formatTemperatureTarget(device.temperature.plannedTarget)} °C (simulation)`;
  }
  return null;
}

function resolveOrdinarySimulatedTargetLine(device: DeviceStatusInput): string | null {
  if (!device.execution.available || device.execution.externalOffHeld
    || device.execution.physicalState === 'off' || device.steppedFairnessHold || device.steppedStepUpHold) return null;
  const kind = resolveIntentStateKind({ kind: resolveBaseKind(device), reasonCode: device.reason.code,
    starved: device.starvation?.isStarved === true });
  return kind === 'held' || kind === 'manual' || kind === 'resuming' ? null : resolveSimulatedTargetLine(device);
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

const resolvePhaseSettingOffer = (device: DeviceStatusInput): { offersPhaseSetting?: true } => (
  device.reason.code === PLAN_REASON_CODES.phaseLimit && device.phaseFootprint?.kind === 'unknown'
    ? { offersPhaseSetting: true } : {}
);

function buildReason(
  device: DeviceStatusInput, dryRun: boolean, nowMs: number, powerPredatesSwitchOff: boolean,
): DeviceStatus['reason'] {
  const simulatedAction = dryRun ? resolveSimulatedActionLine(device) : null;
  if (simulatedAction) {
    return { text: simulatedAction, ...resolvePhaseSettingOffer(device), ...resolveCarConfirmationOffer(device) };
  }
  const ordinary = buildOrdinaryReason(device, dryRun, nowMs, powerPredatesSwitchOff);
  if (ordinary?.text === TARGET_POWER_CONTROL_REFUSED_LINE) return { ...ordinary, tone: 'warning' };
  const target = dryRun && ordinary === null ? resolveOrdinarySimulatedTargetLine(device) : null;
  return target === null ? ordinary : { text: target };
}

/**
 * Why PELS does not control a device, for the two states that say so.
 *
 * Every device but a Tesla is unavailable only when Homey says so, and a Tesla's
 * adapter explains its own (`buildUnavailableAdapterStatus`). An available device
 * whose plan could not be built for it says nothing here.
 */
function resolveNotControlledReason(
  device: DeviceStatusInput, kind: 'unavailable' | 'manual',
): DeviceStatus['reason'] {
  if (kind === 'manual') return resolveManualReason(device);
  return device.available ? null : { text: HOMEY_UNAVAILABLE_REASON_TEXT };
}

function resolveMeteringSocketReason(socketName: string | undefined): DeviceStatus['reason'] {
  const name = formatDisplayDeviceName(socketName ?? '');
  const text = name
    ? `Waiting for a power reading from ${name}. Check the socket in Homey.`
    : 'Metering socket unavailable. Choose another power source under External sensors.';
  return { text, tone: 'warning' };
}

/**
 * Why a Manual card is Manual, named only from a fact that says so. PELS holds
 * authority over a device when the owner granted it, the device has a power
 * reading, and it has something PELS could switch or step
 * (`resolveDeviceControlPosture`).
 *
 * Missing power setup names the setting or assigned socket to check first.
 * Otherwise, without the grant the line names the owner's Power-limit control setting
 * rather than asking for it, because a device left unlimited on purpose (a
 * fridge, a PC) is fine. With the grant but no power reading it says that. Any
 * other Manual card (a thermostat whose only control is switched off, or a plan
 * built before the owner's grant) says nothing rather than name a setting the
 * owner has already turned on.
 */
function resolveManualReason(device: DeviceStatusInput): DeviceStatus['reason'] {
  if (device.lastResort) {
    if (resolveRunningLastResortReadingKw(device) !== undefined) {
      return { text: 'Has its own power reading. Turn off last-resort control under Power limiting.' };
    }
    return { text: device.currentState === 'off' && device.controllable && device.execution.available
      ? 'Turn on the device manually to resume control'
      : 'Check the last-resort settings in Devices' };
  }
  const requirement = device.powerSetupRequirement;
  if (requirement !== null) {
    if (requirement.kind === 'metering_socket') return resolveMeteringSocketReason(requirement.socketName);
    const lastResortOffered = device.binaryControllable && !device.isEvCharger && !device.temperature
      && !device.steppedLoad;
    const text = lastResortOffered
      ? `${HOMEY_ENERGY_SETUP_REASON} or set up last-resort control under Power limiting`
      : HOMEY_ENERGY_SETUP_REASON;
    return { text, tone: 'warning', offersHomeyEnergySetup: true };
  }
  if (!device.standingCommandGrant) return { text: MANUAL_REASON_TEXT };
  return device.hasPowerReading ? null : { text: NO_POWER_READING_REASON_TEXT };
}

function buildUnansweredStepReason(device: DeviceStatusInput, dryRun: boolean, nowMs: number): DeviceStatus['reason'] {
  if (!device.steppedLoad) return null;
  const text = resolveUnansweredStepLine(device, dryRun);
  if (text === null) return null;
  const phase = resolvePhaseSettingOffer(device);
  const car = resolveCarConfirmationOffer(device);
  const countdown = buildCountdown(device, text, nowMs);
  return {
    text,
    ...(countdown ? { countdown } : {}),
    ...phase,
    ...car,
    ...(!phase.offersPhaseSetting && !car.offersCarConfirmation ? { offersProblemReport: true } : {}),
  };
}

function buildOrdinaryReason(
  device: DeviceStatusInput, dryRun: boolean, nowMs: number, powerPredatesSwitchOff: boolean,
): DeviceStatus['reason'] {
  const kind = resolveBaseKind(device);
  if (kind === 'unavailable' || kind === 'manual') return resolveNotControlledReason(device, kind);
  const unansweredStep = buildUnansweredStepReason(device, dryRun, nowMs);
  if (unansweredStep) return unansweredStep;
  let text = resolveReason(device, dryRun, powerPredatesSwitchOff);
  const identification = resolveCarIdentificationReason(device, text);
  if (identification) return identification;
  let idle;
  if (text === null && device.idleClassification && device.idleClassification !== 'near_target_idle') {
    idle = formatIdleClassificationCopy({ classification: device.idleClassification,
      currentTemperatureC: device.temperature?.currentTemperature,
      targetTemperatureC: device.temperature?.currentTarget });
    text = idle.statusLine;
  }
  if (!text) return null;
  // A fairness hold lasts until other devices resume, not until a timer runs out:
  // the shed cooldown the cycle may carry beside it is not this line's countdown.
  const fairnessLine = device.steppedFairnessHold !== undefined
    && text === formatFairnessHoldCardLine(device.steppedFairnessHold, device.starvation);
  text = toSimulationReasonLine(text, dryRun);
  const countdown = fairnessLine ? undefined : buildCountdown(device, text, nowMs);
  return {
    text,
    ...(idle ? { tone: idle.tone, detail: idle.detail } : {}),
    ...(countdown ? { countdown } : {}),
    ...resolvePhaseSettingOffer(device),
    ...resolveCarConfirmationOffer(device),
  };
}

// A charger still identifying its car says so only where nothing else explains
// the card: no other reason, or the wait for a battery level it is itself. Any
// other reason (a hold for power or cheaper hours, a level change not confirmed)
// stays, since identifying the car would not change it.
function resolveCarIdentificationReason(
  device: DeviceStatusInput,
  reasonText: string | null,
): DeviceStatus['reason'] {
  const state = device.carIdentificationState;
  if (state === 'not_waiting') return null;
  if (reasonText !== null && reasonText !== '' && reasonText !== PLAN_STATE_AWAITING_BATTERY_LEVEL_STATUS) return null;
  if (state === 'timed_out') return { text: CAR_ASSOCIATION_TIMED_OUT, tone: 'warning', offersCarConfirmation: true };
  if (state === 'selected_cars_unplugged') {
    return { text: CAR_ASSOCIATION_SELECTED_CARS_UNPLUGGED, offersCarConfirmation: true };
  }
  return { text: WAITING_FOR_CAR_ASSOCIATION };
}

// A charger whose car PELS will not identify by itself offers the confirmation
// even when another reason holds the line: a hold for power does not end the
// wait for the car, and the reason line has room for one cause only.
const resolveCarConfirmationOffer = (device: DeviceStatusInput): { offersCarConfirmation?: true } => (
  device.carIdentificationState === 'timed_out' || device.carIdentificationState === 'selected_cars_unplugged'
    ? { offersCarConfirmation: true } : {}
);

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

function resolvePower(
  device: DeviceStatusInput, limited: boolean, dryRun: boolean, previousPower: number | undefined,
): Pick<DeviceStatus, 'powerText' | 'powerVariant'> {
  const reportedKw = resolveRunningLastResortReadingKw(device);
  if (reportedKw !== undefined) return { powerText: `${reportedKw.toFixed(1)} kW`, powerVariant: 'live' };
  if (device.powerSetupRequirement !== null || device.lastResort) return { powerText: null, powerVariant: 'expected' };
  return resolveStandardPower(device, limited, dryRun, previousPower);
}

function resolveStandardPower(
  device: DeviceStatusInput, limited: boolean, dryRun: boolean, previousPower: number | undefined,
): Pick<DeviceStatus, 'powerText' | 'powerVariant'> {
  if (previousPower !== undefined) {
    return { powerText: `Last reported ${previousPower.toFixed(1)} kW`, powerVariant: 'before_switch_off' };
  }
  const measuredOnly = device.steppedLoad !== undefined || device.temperature !== undefined;
  const draw = device.currentDrawKw;
  if (limited && !measuredOnly && draw !== undefined && draw > 0.05) {
    return dryRun
      ? { powerText: `${draw.toFixed(1)} kW`, powerVariant: 'live' }
      : { powerText: `Reported ${draw.toFixed(1)} kW`, powerVariant: 'reported' };
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

function resolvePowerBeforeSwitchOff(
  device: DeviceStatusInput, kind: DeviceStatus['kind'], dryRun: boolean,
): number | undefined {
  if (dryRun || kind !== 'held' || !device.binaryControllable || device.isEvCharger
    || device.powerSetupRequirement !== null || device.temperature
    || device.steppedLoad || device.execution.physicalState !== 'off'
    || device.execution.binaryProgress === 'pending'
    || device.reason.code === PLAN_REASON_CODES.awaitingSolarSurplus) return undefined;
  const power = device.powerBeforeSwitchOffKw;
  return power !== undefined && power > 0.05 ? power : undefined;
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
  if (device.reason.code === PLAN_REASON_CODES.deferredObjectiveAvoid
    || device.reason.code === PLAN_REASON_CODES.deferredObjectiveWaitingForPlan) return 'smart_task';
  if (device.reason.code === PLAN_REASON_CODES.deferredObjectiveSatisfied) return 'smart_task_done';
  return device.reason.code === PLAN_REASON_CODES.dailyBudget ? 'daily_budget' : null;
}

// The target the fact line names: the device's own setpoint and, after the
// arrow, the one PELS will write the next time it writes to the device
// (`target 28 °C → 22 °C`), also while PELS holds the device off and no write
// goes out yet (owner ruling 2026-11-17).
//
// One hold is different. A Smart task that reached its target holds its device
// until the ready-by time, and the plan's target is still the task's: that keeps
// a lower mode target from being written over it meanwhile. PELS does not write
// it to a device it holds off, and when the hold ends the task is over and the
// mode's target applies. Naming the task's target there promises a change that
// does not come, so the card names the device's own setpoint alone.
function withPresentedTarget(device: DeviceStatusInput): DeviceStatusInput {
  if (!device.temperature || device.execution.targetProgress !== 'undriven') return device;
  if (device.reason.code !== PLAN_REASON_CODES.deferredObjectiveSatisfied) return device;
  return { ...device, temperature: { ...device.temperature, plannedTarget: device.temperature.currentTarget } };
}

// Why the planned setpoint is not simply the mode's: named only where the card
// data says so. A mode target needs no explanation, so it has none.
function resolvePlannedTargetSource(device: DeviceStatusInput): string {
  if (device.temporaryTemperatureActive === true) return ' (override)';
  const shift = device.priceTargetShift;
  return shift.kind === 'shifted' ? ` (${shift.direction} while power is ${shift.priceLevel})` : '';
}

// When PELS writes the planned setpoint, by what holds the device now.
function resolvePlannedTargetTiming(device: DeviceStatusInput, planned: string, source: string): string {
  if (device.execution.targetProgress !== 'undriven') return `PELS is setting ${planned}${source}.`;
  if (device.reason.code === PLAN_REASON_CODES.deferredObjectiveAvoid) {
    return `PELS sets ${planned} when the Smart task runs.`;
  }
  if (device.reason.code === PLAN_REASON_CODES.externalOffHold) {
    return `PELS sets ${planned} when the device is turned on${source}.`;
  }
  return `PELS sets ${planned} when it resumes the device${source}.`;
}

/**
 * The device page header's sentence for a setpoint that differs from the planned
 * one: what the device is set to, what PELS will set, when, and why that value.
 * The fact line carries the same pair in short form; the header has room to say
 * which side is which.
 */
function resolveTargetDetail(presented: DeviceStatusInput, dryRun: boolean): string | undefined {
  const { temperature } = presented;
  if (!temperature || temperature.currentTarget === temperature.plannedTarget) return undefined;
  const set = `Set to ${formatTemperatureTarget(temperature.currentTarget)} °C.`;
  const planned = `${formatTemperatureTarget(temperature.plannedTarget)} °C`;
  const source = resolvePlannedTargetSource(presented);
  if (dryRun) return `${set} In simulation PELS changes nothing; it would set ${planned}${source}.`;
  return `${set} ${resolvePlannedTargetTiming(presented, planned, source)}`;
}

/** An adapter may explain a control refusal without changing any command gate. */
function buildUnavailableAdapterStatus(device: DeviceStatusInput): DeviceStatus | null {
  const status = device.adapterUnavailableStatus;
  if (!device.controllable || device.execution.available || !status) return null;
  const reading = resolveReading(device);
  const battery = reading?.kind === 'battery' ? `${Math.round(reading.percent)} %` : null;
  return {
    cardKind: resolveCardKind(device), kind: status.kind,
    tone: displayStateTone(status.kind), label: displayStateLabel(status.kind),
    powerText: null, powerVariant: 'live',
    factText: status.factText === null ? null : [status.factText, battery].filter(Boolean).join(' · '), reading,
    reason: status.reasonText === null ? null : { text: status.reasonText },
    rail: null, limited: false, wouldLimit: false, canEaseOff: false,
    controlOffDrawing: false, holdCause: null,
  };
}

const optionalTargetDetail = (targetDetail: string | undefined): { targetDetail?: string } => (
  targetDetail === undefined ? {} : { targetDetail }
);

const isControlOffDrawing = (device: DeviceStatusInput): boolean => (
  (device.currentDrawKw ?? 0) > 0
  && (!device.controllable || resolveRunningLastResortReadingKw(device) !== undefined)
);

/** Presentation consumes executor conclusions; it never resolves control axes. */
export function buildDeviceStatus(device: DeviceStatusInput, dryRun: boolean, nowMs: number): DeviceStatus {
  const adapterStatus = buildUnavailableAdapterStatus(device);
  if (adapterStatus) return adapterStatus;
  const grammar = { kind: resolveBaseKind(device), reasonCode: device.reason.code,
    starved: device.starvation?.isStarved === true };
  const intentKind = resolveIntentStateKind(grammar);
  const kind = resolveDisplayStateKind({ ...grammar, dryRun, currentState: device.currentState,
    satisfiedTemperature: reportsSatisfiedTemperature(device) });
  const limited = intentKind === 'held';
  const physicalFact = kind === 'held' ? resolvePhysicalFact(device) : null;
  const stateLabel = device.lastResort && kind === 'active' ? 'On' : displayStateLabel(kind);
  const label = [stateLabel, physicalFact].filter(Boolean).join(' · ');
  const cardKind = resolveCardKind(device);
  const presented = withPresentedTarget(device);
  const draw = device.currentDrawKw;
  const previousPower = resolvePowerBeforeSwitchOff(device, kind, dryRun);
  const powerPredatesSwitchOff = previousPower !== undefined;
  return {
    cardKind, kind, tone: displayStateTone(kind), label,
    ...resolvePower(device, limited, dryRun, previousPower),
    factText: resolveFactText(presented, kind, kind === 'held' && resolvePhysicalStepId(device) !== null),
    reading: resolveReading(presented),
    ...optionalTargetDetail(resolveTargetDetail(presented, dryRun)),
    reason: buildReason(device, dryRun, nowMs, powerPredatesSwitchOff), rail: resolveRail(device),
    limited, wouldLimit: dryRun && limited,
    canEaseOff: device.controllable && (kind === 'active' || (limited && !powerPredatesSwitchOff && (draw ?? 0) > 0)),
    controlOffDrawing: isControlOffDrawing(device),
    holdCause: resolveHoldCause(device),
    ...resolveCardMarks(device, cardKind),
  };
}

/** The card's optional marks for holds, overrides and control warnings. */
function resolveCardMarks(
  device: DeviceStatusInput,
  cardKind: DeviceStatus['cardKind'],
): Pick<DeviceStatus, 'heldForPhase' | 'override' | 'needsChargerAppUpdate' | 'powerLimitingNeedsReading'> {
  const powerLimitingNeedsReading = cardKind === 'temperature'
    && device.execution.available && device.execution.targetProgress !== 'undriven'
    && device.powerLimitControlEnabled && !device.hasPowerReading && device.powerSetupRequirement === null;
  return {
    ...(powerLimitingNeedsReading ? { powerLimitingNeedsReading: true as const } : {}),
    ...(device.reason.code === PLAN_REASON_CODES.phaseLimit ? { heldForPhase: device.reason.phase } : {}),
    ...(device.temporaryTemperatureActive === true ? { override: true as const } : {}),
    ...(device.unusedBuiltInControl === 'needs_app_update' ? { needsChargerAppUpdate: true as const } : {}),
  };
}
