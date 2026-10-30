/** What the activity log records of a card: its state changes, never a countdown or a drifting figure. */
import type { SettingsUiDeviceLogEntry } from '../../packages/contracts/src/settingsUi/devices';
import type { SettingsUiPlanDeviceSnapshot } from '../../packages/contracts/src/settingsUi/plan';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemanticsCore';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import type { DevicePlanDevice } from './planTypes';

export type OverviewLogDevice = SettingsUiPlanDeviceSnapshot;

/**
 * Whether the UI must be told: anything it renders, except a countdown's own
 * decay. The UI interpolates the text from the countdown's end, and a countdown
 * with no recorded start re-derives its length from what remains on each build.
 */
export function buildPresentationSignatureForDevice(device: OverviewLogDevice): string {
  const reason = device.status.reason;
  const countdown = reason?.countdown;
  if (!reason || !countdown) return JSON.stringify(device.status);
  return JSON.stringify({ ...device.status, reason: countdown.kind === 'in_text'
    ? { ...reason, text: null, countdown: {
      kind: countdown.kind, endsAtMs: countdown.endsAtMs, prefix: countdown.prefix, suffix: countdown.suffix,
    } }
    : { ...reason, countdown: { kind: countdown.kind, endsAtMs: countdown.endsAtMs } } });
}

// A figure moving inside the same sentence is not a state change: a shortfall
// tracks the pace every cycle ("0.8" → "0.9 kW more needed"), an idle detail
// quotes the drifting temperature, and a running device's draw wobbles across a
// 0.1 kW display boundary on most reports. The UI still receives the new text.
// A hold's length is one figure however it is worded: "Held 1 h 59 min" and
// "Held 2 h" are the same sentence.
const toSentenceShape = (text: string): string => text
  .replace(/\d+(?:[.,]\d+)?/gu, '#')
  .replace(/#\s+h\b(?:\s+#\s+min\b)?|#\s+min\b/gu, '#');
const toNullableSentenceShape = (text: string | null): string | null => (text === null ? null : toSentenceShape(text));

type OverviewStatusReason = OverviewLogDevice['status']['reason'];

/**
 * A reason that is itself a countdown, such as the pause after limiting a
 * device or the wait before resuming ("Waiting to resume — 270s"). The card
 * counts it down; the activity log never records one (owner, 2026-10-25): it
 * comes and goes with every device limited anywhere in the home.
 */
export const isCountdownWait = (reason: OverviewStatusReason): boolean => reason?.countdown?.kind === 'in_text';

/** A countdown wait's sentence without its countdown: "Waiting after limiting a device", "Waiting to resume". */
const withoutCountdown = (prefix: string, suffix: string): string => [
  prefix.replace(/\s*(?:—|\()\s*$/u, ''),
  // "… (60s)" leaves ")"; a simulation line goes on after the countdown, as in "… — 270s (simulation)".
  suffix.replace(/^\s*\)/u, '').trim(),
].filter((part) => part !== '').join(' ').trim();

type PlanReasonCode = DevicePlanDevice['reason']['code'];

/**
 * Every way of saying a device waits for power to resume or step up: a
 * shortfall, other devices ahead, the hour ending, a new reading, a swap. The
 * planner moves between them every few minutes while the device stays where it
 * is, so the activity log keeps them as one state (owner, 2026-10-27); the card
 * still names the current one. A silent meter and a failed start are not waits
 * for power, and neither is a smart task's or the owner's own hold.
 */
const WAITING_FOR_POWER_REASON_CODES: ReadonlySet<PlanReasonCode> = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.swapPending,
  PLAN_REASON_CODES.swappedOut,
  PLAN_REASON_CODES.hourlyBudget,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.endOfHourDrain,
  PLAN_REASON_CODES.shortfall,
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.waitingForOtherDevices,
  PLAN_REASON_CODES.insufficientHeadroom,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.gridImport,
  PLAN_REASON_CODES.reservedForStart,
]);

const WAITING_FOR_POWER_SHAPE = JSON.stringify({ waitingForPower: true });

/**
 * The reason as the log compares it: its sentence without figures or
 * countdown, with the hold cause that comes and goes with it. A countdown wait
 * has no hold cause of its own, so the log carries both through one together.
 * A wait for power is one shape, and on a device PELS leaves on (one that
 * waits to step up) it is no reason at all: the level it runs at is the fact.
 * A step command the device never answered replaces that line on the card, and
 * stays a reason of its own.
 */
export function buildLoggedReasonShape(
  status: OverviewLogDevice['status'],
  decision: Pick<OverviewDecisionFacts, 'reasonCode' | 'stepCommandUnanswered'>,
): string | null {
  const { reason, holdCause } = status;
  if (WAITING_FOR_POWER_REASON_CODES.has(decision.reasonCode) && !decision.stepCommandUnanswered) {
    return status.kind === 'active' || status.kind === 'idle' ? null : WAITING_FOR_POWER_SHAPE;
  }
  if (!reason) return holdCause === null ? null : JSON.stringify({ holdCause });
  const { countdown, detail, text, ...rest } = reason;
  return JSON.stringify({
    ...rest,
    text: toSentenceShape(countdown?.kind === 'in_text' ? withoutCountdown(countdown.prefix, countdown.suffix) : text),
    ...(detail === undefined ? {} : { detail: toSentenceShape(detail) }),
    holdCause,
  });
}

/**
 * What makes a log entry: a change of state, reason, rail, kind of power line
 * (live, reported, expected or none) or a categorical fact (a charger's plug
 * turning `Unplugged`). The live power reading and the fact line's measured
 * readings (temperature, battery level, also carried as the status `reading`)
 * drift without being a state change, and the reason's figures move with the
 * pace, so none of them may move the signature on their own.
 *
 * A device PELS leaves on is one state whether it is running or resting: a
 * thermostat holding its target switches its own element every few minutes,
 * and those switches would fill a busy device's history in hours. `reason` is
 * the reason and hold cause as the log keeps them (`buildLoggedReasonShape`),
 * or the ones the log carries through a countdown wait (`DeviceOverviewTransitions`).
 */
export function buildOverviewSignatureForDevice(device: OverviewLogDevice, reason: string | null): string {
  const { kind, label, tone, canEaseOff, reason: _reason, holdCause: _holdCause, ...status } = device.status;
  const leftOn = kind === 'active' || kind === 'idle';
  return JSON.stringify({
    ...status,
    kind: leftOn ? 'left_on' : kind,
    // For a device left on, the ease-off control follows whether it is running.
    ...(leftOn ? {} : { label, tone, canEaseOff }),
    powerText: toNullableSentenceShape(status.powerText),
    factText: toNullableSentenceShape(status.factText),
    // The same measured figures as numbers: only which kind of reading it is
    // can move the signature.
    reading: status.reading?.kind ?? null,
    reason,
  });
}

/** The reason line as the log stores it: the card's sentence, a countdown wait without its countdown. */
const loggedReasonText = (reason: OverviewStatusReason): string => {
  if (!reason) return '';
  const { countdown } = reason;
  return countdown?.kind === 'in_text' ? withoutCountdown(countdown.prefix, countdown.suffix) : reason.text;
};

export function buildDeviceLogEntry(device: OverviewLogDevice, atMs = Date.now()): SettingsUiDeviceLogEntry {
  return {
    atMs,
    stateMsg: device.status.label,
    stateKind: device.status.kind,
    stateTone: device.status.tone,
    powerMsg: device.status.powerText,
    usageMsg: device.status.factText ?? '',
    statusMsg: loggedReasonText(device.status.reason),
  };
}

/**
 * What the planner decided and the executor holds for a device, beside what it
 * presented: observed, planned, commanded and pending stay distinct in the log
 * (`lib/device/AGENTS.md`). The activity log reads the reason code and whether
 * a step command went unanswered (`buildLoggedReasonShape`); the debug event
 * carries all of them. Never on the UI wire.
 */
export type OverviewDecisionFacts = Pick<DevicePlanDevice, 'plannedState'> & {
  reasonCode: DevicePlanDevice['reason']['code'];
} & Pick<DeviceExecutionState, 'desiredStepId' | 'observedStepId' | 'binaryProgress' | 'stepProgress'
  | 'targetProgress' | 'stepCommandUnanswered'>;

export function buildOverviewEventForDevice(
  device: OverviewLogDevice,
  decision: OverviewDecisionFacts,
): Record<string, unknown> {
  return {
    component: 'overview', event: 'device_overview_changed',
    deviceId: device.id, deviceName: device.name,
    ...buildDeviceLogEntry(device),
    cardReasonText: device.status.reason?.text ?? null,
    ...(device.currentDrawKw !== undefined ? { currentDrawKw: device.currentDrawKw } : {}),
    ...decision,
  };
}

export function buildOverviewBatchEvent(devices: Record<string, unknown>[]): Record<string, unknown> {
  return { component: 'overview', event: 'device_overview_changes', changedDeviceCount: devices.length, devices };
}
