/** Exclude countdown decay: identical states must not create a log every second. */
import type {
  SettingsUiDeviceLogEntry,
  SettingsUiPlanDeviceSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
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
const toSentenceShape = (text: string): string => text.replace(/\d+(?:[.,]\d+)?/gu, '#');
const toNullableSentenceShape = (text: string | null): string | null => (text === null ? null : toSentenceShape(text));

/**
 * What makes a log entry: a change of state, reason, rail, kind of power line
 * (live, reported, expected or none) or a categorical fact (a charger's plug
 * turning `Unplugged`). The live power reading and the fact line's measured
 * readings (temperature, battery level, also carried as the status `reading`)
 * drift without being a state change, the reason's figures move with the pace,
 * and a countdown's end and length are re-anchored on rebuilds that have no
 * recorded start, so none of them may move the signature on their own.
 */
export function buildOverviewSignatureForDevice(device: OverviewLogDevice): string {
  const status = { ...device.status,
    powerText: toNullableSentenceShape(device.status.powerText),
    factText: toNullableSentenceShape(device.status.factText),
    // The same measured figures as numbers: only which kind of reading it is
    // can move the signature.
    reading: device.status.reading?.kind ?? null };
  const reason = status.reason;
  if (!reason) return JSON.stringify(status);
  const { countdown, detail } = reason;
  return JSON.stringify({ ...status, reason: {
    ...reason,
    text: countdown?.kind === 'in_text' ? null : toSentenceShape(reason.text),
    ...(detail === undefined ? {} : { detail: toSentenceShape(detail) }),
    ...(countdown ? { countdown: countdown.kind === 'in_text'
      ? { kind: countdown.kind, prefix: toSentenceShape(countdown.prefix), suffix: toSentenceShape(countdown.suffix) }
      : { kind: countdown.kind } } : {}),
  } });
}

export function buildDeviceLogEntry(device: OverviewLogDevice, atMs = Date.now()): SettingsUiDeviceLogEntry {
  return {
    atMs,
    stateMsg: device.status.label,
    stateKind: device.status.kind,
    stateTone: device.status.tone,
    powerMsg: device.status.powerText,
    usageMsg: device.status.factText ?? '',
    statusMsg: device.status.reason?.text ?? '',
  };
}

/**
 * What the planner decided and the executor holds for a device, beside what it
 * presented: observed, planned, commanded and pending stay distinct in the log
 * (`lib/device/AGENTS.md`). Debug-only; never on the UI wire.
 */
export type OverviewDecisionFacts = Pick<DevicePlanDevice, 'plannedState'> & {
  reasonCode: DevicePlanDevice['reason']['code'];
} & Pick<DeviceExecutionState,
  'desiredStepId' | 'observedStepId' | 'binaryProgress' | 'stepProgress' | 'targetProgress'>;

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
