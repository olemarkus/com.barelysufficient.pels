/** Exclude countdown decay: identical states must not create a log every second. */
import type {
  SettingsUiDeviceLogEntry,
  SettingsUiDeviceLogPayload,
  SettingsUiPlanDeviceSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import type { DevicePlanDevice } from './planTypes';

export const DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE = 50;
export const DEVICE_OVERVIEW_LOG_MAX_DEVICES = 64;
export type DeviceOverviewLogRecord = SettingsUiDeviceLogEntry;
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
// tracks the pace every cycle ("0.8" → "0.9 kW more needed"), and an idle
// detail quotes the drifting temperature. The UI still receives the new text.
const toSentenceShape = (text: string): string => text.replace(/\d+(?:[.,]\d+)?/gu, '#');

/**
 * What makes a log entry: a change of state, reason, rail, power or a categorical
 * fact (a charger's plug turning `Unplugged`). The fact line's measured readings
 * (temperature, battery level) drift without being a state change, the reason's
 * figures move with the pace, and a countdown's end and length are re-anchored on
 * rebuilds that have no recorded start, so none of them may move the signature on
 * their own.
 */
export function buildOverviewSignatureForDevice(device: OverviewLogDevice): string {
  const status = { ...device.status,
    factText: device.status.factText === null ? null : toSentenceShape(device.status.factText) };
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

/** Bounded session history of the same presentation delivered to the UI. */
export class DeviceOverviewLogRecorder {
  private entriesByDeviceId = new Map<string, DeviceOverviewLogRecord[]>();

  record(deviceId: string, entry: DeviceOverviewLogRecord): void {
    const existing = this.entriesByDeviceId.get(deviceId) ?? [];
    // Most-recent-first; trim the oldest tail entries beyond the cap.
    const next = [entry, ...existing].slice(0, DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE);
    this.entriesByDeviceId.set(deviceId, next);
    this.enforceDeviceCap(deviceId);
  }

  getUiPayload(): SettingsUiDeviceLogPayload {
    const entriesByDeviceId: Record<string, DeviceOverviewLogRecord[]> = {};
    for (const [deviceId, entries] of this.entriesByDeviceId.entries()) {
      // Defensive copy so a consumer can't mutate the retained buffer.
      entriesByDeviceId[deviceId] = entries.slice();
    }
    return { version: 1, entriesByDeviceId };
  }

  // When a brand-new device pushes the count past the cap, evict the device
  // whose newest entry is the oldest (least-recently-active), never the device
  // just written to.
  private enforceDeviceCap(justWrittenDeviceId: string): void {
    if (this.entriesByDeviceId.size <= DEVICE_OVERVIEW_LOG_MAX_DEVICES) return;
    let evictId: string | null = null;
    let evictNewestAtMs = Number.POSITIVE_INFINITY;
    for (const [deviceId, entries] of this.entriesByDeviceId.entries()) {
      if (deviceId === justWrittenDeviceId) continue;
      const newestAtMs = entries[0]?.atMs ?? 0;
      if (newestAtMs < evictNewestAtMs) {
        evictNewestAtMs = newestAtMs;
        evictId = deviceId;
      }
    }
    if (evictId !== null) this.entriesByDeviceId.delete(evictId);
  }
}
