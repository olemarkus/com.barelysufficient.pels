import {
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../../packages/shared-domain/src/planStateLabels';
import {
  buildDeviceOverviewTransitionSignature,
  formatDeviceOverview,
  getDeviceOverviewExpectedPowerKw,
  getDeviceOverviewReportedStepId,
} from '../../packages/shared-domain/src/deviceOverview';
import { formatDeviceReasonUserFacing } from '../../packages/shared-domain/src/planReasonSemantics';
import { isSteppedLoadDevice } from './planSteppedLoad';
import type {
  SettingsUiDeviceLogEntry,
  SettingsUiDeviceLogPayload,
} from '../../packages/contracts/src/settingsUiApi';
import type { DeviceControlModel } from '../../packages/contracts/src/types';
import type { DevicePlanDevice } from './planTypes';

// Per-device cap on retained transition entries. The recorder is purely
// in-memory (no persistence): a device-log view is a debugging aid for the
// current session, not an audit trail, so a small ring buffer keeps the RSS
// cost negligible against the 160 MB Homey ceiling while still covering a
// meaningful run of shed/restore activity.
export const DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE = 50;

// Cap on the number of distinct devices retained. An LRU eviction
// (`enforceDeviceCap`) bounds memory: when a brand-new device pushes the count
// past the cap, the least-recently-active device is dropped. We deliberately
// do NOT prune devices that transiently leave the plan — a device that briefly
// drops out (e.g. an SDK read blip) must keep its history rather than have it
// wiped; the LRU cap alone is sufficient to bound the Map.
export const DEVICE_OVERVIEW_LOG_MAX_DEVICES = 64;

export type DeviceOverviewLogRecord = SettingsUiDeviceLogEntry;

function resolveOverviewTargetStepId(device: DevicePlanDevice): string | null {
  return device.targetStepId ?? device.desiredStepId ?? null;
}

// The overview-transition signature: a change in this value is the boundary
// that drives both the device-log capture and the structured overview debug
// log, so the two surfaces report identical wording.
export function buildOverviewSignatureForDevice(device: DevicePlanDevice): string {
  return buildDeviceOverviewTransitionSignature(device);
}

// Restore the device's control model onto the overview/log device so the
// shared-domain helpers (which branch on `controlModel`) render and SIGN correctly.
// The planner no longer carries `controlModel`, so without this a non-stepped
// `temperature_target ↔ binary_power` flip collapses to `controlModel: null` on both
// poles and the signature can't distinguish it (leaving an open overview card stale).
// Precedence: the device's OWN stepped status (`isSteppedLoadDevice`, which reflects
// the decorated plan device's effective profile — native OR stored) wins first; only
// for non-stepped devices do we read the producer map for the three-way model. The map
// is built from the RAW `getSnapshot()`, whose `controlModel` is stepped-only, so it
// cannot be trusted to mark a stored-profile stepped device as stepped — hence the
// stepped check must come first. When neither resolves a model, return the device
// unchanged (the helpers treat a missing `controlModel` as non-stepped, signature
// records `null`). The `controlModel:` key is a WRITE, not a read, so the control-model
// containment guard (`check-control-model-vocab`) is satisfied — the planner still
// never BRANCHES on a `.controlModel` read.
export function resolveOverviewControlModel(
  device: DevicePlanDevice,
  controlModelById: Map<string, DeviceControlModel>,
): DevicePlanDevice & { controlModel?: DeviceControlModel } {
  // The decorated plan device's OWN stepped status wins first: a stored-profile
  // stepped device (`steppedLoadProfile` from `deviceControlProfiles`, not the raw
  // native snapshot) is stepped here but absent-stepped in the raw-derived map, so
  // applying the map first would mis-sign it as `binary_power`/`temperature_target`.
  if (isSteppedLoadDevice(device)) return { ...device, controlModel: 'stepped_load' as const };
  // Non-stepped: the producer map supplies the three-way `temperature_target ↔
  // binary_power` model the planner no longer carries.
  const producerControlModel = controlModelById.get(device.id);
  if (producerControlModel) return { ...device, controlModel: producerControlModel };
  return device;
}

// The structured per-device debug event emitted on an overview change.
export function buildOverviewEventForDevice(
  device: DevicePlanDevice,
  overview: ReturnType<typeof formatDeviceOverview>,
): Record<string, unknown> {
  return {
    component: 'overview',
    event: 'device_overview_changed',
    deviceId: device.id,
    deviceName: device.name,
    powerMsg: overview.powerMsg,
    stateMsg: overview.stateMsg,
    usageMsg: overview.usageMsg,
    statusMsg: overview.statusMsg,
    stateKind: resolvePlanStateKind(device),
    stateTone: resolvePlanStateTone(device),
    currentState: device.currentState,
    plannedState: device.plannedState,
    reasonCode: device.reason.code,
    reasonText: formatDeviceReasonUserFacing(device.reason),
    measuredPowerKw: device.measuredPowerKw ?? null,
    expectedPowerKw: getDeviceOverviewExpectedPowerKw(device) ?? null,
    reportedStepId: getDeviceOverviewReportedStepId(device) ?? null,
    targetStepId: resolveOverviewTargetStepId(device),
    desiredStepId: device.desiredStepId ?? null,
  };
}

// The batch event wrapping multiple per-device overview changes from one pass.
export function buildOverviewBatchEvent(
  changedDevices: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    component: 'overview',
    event: 'device_overview_changes',
    changedDeviceCount: changedDevices.length,
    devices: changedDevices,
  };
}

/**
 * Build a device-log entry from a plan device and its formatted overview.
 *
 * The four message fields are the verbatim shared-formatter output, so the
 * device-log view and the structured overview log report identical wording
 * (both consume `formatDeviceOverview`).
 */
export function buildDeviceLogEntry(
  device: DevicePlanDevice,
  overview: ReturnType<typeof formatDeviceOverview>,
): SettingsUiDeviceLogEntry {
  // Explicit fields (no object spread) so the caller's per-device loop stays
  // free of spread allocations (`no-restricted-syntax`).
  return {
    atMs: Date.now(),
    powerMsg: overview.powerMsg,
    stateMsg: overview.stateMsg,
    usageMsg: overview.usageMsg,
    statusMsg: overview.statusMsg,
    stateKind: resolvePlanStateKind(device),
    stateTone: resolvePlanStateTone(device),
  };
}

/**
 * In-memory ring buffer of device-overview transitions, keyed by device id and
 * stored most-recent-first. The plan service appends a record on each detected
 * overview-signature change — the SAME change boundary that drives the
 * structured overview transition log — so the device-log view and the backend
 * logs report identical wording (both consume `formatDeviceOverview`).
 *
 * This recorder runs regardless of whether the `overview` debug-log topic is
 * enabled: the verbose log line is gated, but capturing for the UI is not, so
 * the view has data without the user first turning on debug logging.
 */
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
