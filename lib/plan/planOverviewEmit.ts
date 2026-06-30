/**
 * Device-overview transition emission. Extracted from `PlanService` (slice:
 * overview/device-log capture) so rebuild orchestration stays readable. Pure
 * functions over a caller-owned `signatureByDeviceId` map — the map stays on
 * `PlanService` because tests reach for it directly, so it is threaded in as a
 * parameter rather than owned here. Behaviour is identical to the former
 * `PlanService.emitOverviewTransitions` / `recordOverviewChange` /
 * `emitOverviewDebugBatch` methods.
 */
import { formatDeviceOverview } from '../../packages/shared-domain/src/deviceOverview';
import {
  buildDeviceLogEntry,
  buildOverviewBatchEvent,
  buildOverviewEventForDevice,
  buildOverviewSignatureForDevice,
  resolveOverviewControlModel,
  type DeviceOverviewLogRecorder,
} from './deviceOverviewLog';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { DevicePlan } from './planTypes';
import type { DeviceControlModel } from '../../packages/contracts/src/types';

export type OverviewEmitDeps = {
  isOverviewDebugEnabled?: () => boolean;
  overviewDebugStructured?: StructuredDebugEmitter;
  deviceOverviewLogRecorder?: DeviceOverviewLogRecorder;
  getControlModelById?: () => Map<string, DeviceControlModel>;
  // Display-only staleness for the overview signature/log, sourced from the
  // observer (the plan device no longer carries `observationStale`). Mirrors the
  // live-card read model (`settingsOverviewReadModel`) so the device-log/activity
  // view and the live overview card agree on the gray "unresponsive" state.
  getObservationStale?: (deviceId: string) => boolean;
};

// Per-device: detect a change against the last-known signature, capture it
// into the device-log recorder, and (when debug logging is on) build the
// structured debug event. `captured` is true whenever the signature moved
// (independent of the debug topic), so the caller can decide to notify the
// open UI; `event` is the debug payload (null when nothing changed or debug
// is off).
type OverviewPassContext = {
  recorder: DeviceOverviewLogRecorder | undefined;
  debugEnabled: boolean;
  controlModelById: Map<string, DeviceControlModel>;
  getObservationStale: (deviceId: string) => boolean;
};

function recordOverviewChange(
  device: DevicePlan['devices'][number],
  signatureByDeviceId: Map<string, string>,
  pass: OverviewPassContext,
): { captured: boolean; event: Record<string, unknown> | null } {
  // The shared-domain overview/log helpers (and `formatDeviceOverview`) branch
  // on `controlModel`, a producer SETTING the plan device no longer carries.
  // Restore the device's real control model for the display/log seam from the
  // producer map captured ONCE per pass (`emitDeviceOverviewTransitions`) — a pure
  // by-id lookup, no per-device `deviceManager.getSnapshot()` re-entry inside the
  // plan/apply cycle (that breaks the SDK-boundary e2es). See
  // `resolveOverviewControlModel` for the full rationale. This is display, not
  // planning.
  const overviewDevice = {
    ...resolveOverviewControlModel(device, pass.controlModelById),
    // Display-only staleness, sourced from the observer (the plan device no longer
    // carries it) so the signature flips on a gray/"unresponsive" transition and the
    // device-log/debug surfaces match the live card — same provenance as the read
    // model's gray-state label. A WRITE, not a planner read of `.observationStale`.
    observationStale: pass.getObservationStale(device.id),
  };
  const signature = buildOverviewSignatureForDevice(overviewDevice);
  const previousSignature = signatureByDeviceId.get(device.id);
  signatureByDeviceId.set(device.id, signature);
  if (signature === previousSignature) return { captured: false, event: null };
  const overview = formatDeviceOverview(overviewDevice);
  pass.recorder?.record(device.id, buildDeviceLogEntry(overviewDevice, overview));
  return {
    captured: true,
    event: pass.debugEnabled ? buildOverviewEventForDevice(overviewDevice, overview) : null,
  };
}

function emitOverviewDebugBatch(
  changedDevices: Record<string, unknown>[],
  debugEnabled: boolean,
  overviewDebugStructured: StructuredDebugEmitter | undefined,
): void {
  if (!overviewDebugStructured || !debugEnabled) return;
  if (changedDevices.length === 1) {
    overviewDebugStructured(changedDevices[0]);
  } else if (changedDevices.length > 1) {
    overviewDebugStructured(buildOverviewBatchEvent(changedDevices));
  }
}

// Returns true when at least one device's overview signature changed (and was
// captured into the recorder / batched for debug), so the caller can refresh
// the open settings-UI activity-log view.
export function emitDeviceOverviewTransitions(
  plan: DevicePlan,
  signatureByDeviceId: Map<string, string>,
  deps: OverviewEmitDeps,
): boolean {
  // The recorder must capture even when the debug-log topic is off, so the
  // settings-UI device-log view has data without the user first enabling
  // debug logging. Bail only when there is nothing at all to do.
  const debugEnabled = (deps.isOverviewDebugEnabled?.() ?? false)
    && deps.overviewDebugStructured !== undefined;
  const recorder = deps.deviceOverviewLogRecorder;
  if (!debugEnabled && !recorder) return false;

  // Build the producer control-model map ONCE per pass (not per device) so the
  // raw-snapshot scan stays O(n) and never re-enters the device manager
  // per-device inside the plan/apply cycle. Mirrors the read-model's
  // `getDeviceTypeById` capture in `buildSettingsOverviewReadModel`.
  const controlModelById = deps.getControlModelById?.() ?? new Map<string, DeviceControlModel>();
  const getObservationStale = deps.getObservationStale ?? ((): boolean => false);
  const pass: OverviewPassContext = { recorder, debugEnabled, controlModelById, getObservationStale };

  const nextDeviceIds = new Set<string>();
  const changedDevices: Record<string, unknown>[] = [];
  let captured = false;
  for (const device of plan.devices) {
    nextDeviceIds.add(device.id);
    const result = recordOverviewChange(device, signatureByDeviceId, pass);
    if (result.captured) captured = true;
    if (result.event) changedDevices.push(result.event);
  }

  for (const deviceId of signatureByDeviceId.keys()) {
    if (!nextDeviceIds.has(deviceId)) {
      signatureByDeviceId.delete(deviceId);
    }
  }
  // The device-log recorder deliberately retains devices that transiently
  // leave the plan; its LRU device cap alone bounds memory (see
  // deviceOverviewLog.ts). So no prune-on-not-in-plan here.

  emitOverviewDebugBatch(changedDevices, debugEnabled, deps.overviewDebugStructured);
  return captured;
}
