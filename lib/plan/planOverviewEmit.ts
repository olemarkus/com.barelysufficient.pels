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
  type DeviceOverviewLogRecorder,
} from './deviceOverviewLog';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { ObservedTemperatureRead } from '../observer/observedDeviceStateProjection';
import type { DevicePlan } from './planTypes';
import { buildOverviewSteppedLoad } from './planOverviewSteppedState';
import {
  resolveOverviewTemperatureFacet,
} from './planOverviewTemperatureState';

export type OverviewEmitDeps = {
  isOverviewDebugEnabled?: () => boolean;
  overviewDebugStructured?: StructuredDebugEmitter;
  deviceOverviewLogRecorder?: DeviceOverviewLogRecorder;
  // Same observer-owned current pair the live read model overlays. This seam
  // must not reconstruct a second temperature view from the plan snapshot.
  getObservedTemperature: (deviceId: string) => ObservedTemperatureRead;
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
  getObservedTemperature: (deviceId: string) => ObservedTemperatureRead;
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
  const temperature = resolveOverviewTemperatureFacet(
    device,
    pass.getObservedTemperature(device.id),
  );
  const overviewDevice = {
    ...device,
    steppedLoad: buildOverviewSteppedLoad(device),
    ...(temperature.kind === 'present' ? { temperature: temperature.value } : {}),
    // The draw needs no adapter: the display/log helpers read `currentDrawKw`,
    // the producer-resolved field the plan device already carries — one value,
    // two seams, no second answer anywhere in the planner.
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

// The two producer maps are captured ONCE per pass (not per device) so the
// raw-snapshot scan stays O(n) and never re-enters the device manager per-device
// inside the plan/apply cycle. Mirrors the read model's own capture in
// `buildSettingsOverviewReadModel` — same two maps, so the two carriers of the
// overview shape resolve `controlModel` from identical inputs.
function buildOverviewPassContext(
  deps: OverviewEmitDeps,
  recorder: DeviceOverviewLogRecorder | undefined,
  debugEnabled: boolean,
): OverviewPassContext {
  return {
    recorder,
    debugEnabled,
    getObservedTemperature: deps.getObservedTemperature,
  };
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

  const pass = buildOverviewPassContext(deps, recorder, debugEnabled);

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
