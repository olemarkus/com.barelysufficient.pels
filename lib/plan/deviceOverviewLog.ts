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
import type { DeviceOverviewSteppedLoad } from '../../packages/shared-domain/src/deviceOverview';
import {
  formatDeviceReasonUserFacingForDevice,
  isActionSpecificRestoreWaitReasonCode,
  resolveHeldCardReasonLine,
  resolveHeldCardReasonVerb,
  resolveHeldCardStepView,
} from '../../packages/shared-domain/src/planCardReasonLine';
import { resolveIntentStateKind, resolveRawPlanStateKind } from '../../packages/shared-domain/src/planCardGrammar';
import type {
  SettingsUiDeviceLogEntry,
  SettingsUiDeviceLogPayload,
} from '../../packages/contracts/src/settingsUiApi';
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

/**
 * A plan device carrying the display fields the plan itself does not own:
 * the resolved `controlModel` and the observer's `observationStale`. Built once
 * per device by `planOverviewEmit.recordOverviewChange` and threaded through
 * every helper here.
 *
 * These helpers used to take a bare `DevicePlanDevice`, so nothing stopped a
 * caller handing them a device with no stepped cluster at all — which
 * `formatDeviceOverview` and the signature builder read as "not stepped".
 * Naming the shape makes that mistake visible at the call site.
 */
export type OverviewLogDevice = DevicePlanDevice & {
  steppedLoad?: DeviceOverviewSteppedLoad;
  observationStale?: boolean;
};

// The overview-transition signature: a change in this value is the boundary
// that drives both the device-log capture and the structured overview debug
// log, so the two surfaces report identical wording.
export function buildOverviewSignatureForDevice(device: OverviewLogDevice): string {
  return buildDeviceOverviewTransitionSignature(device);
}

// The structured per-device debug event emitted on an overview change.
export function buildOverviewEventForDevice(
  device: OverviewLogDevice,
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
    reasonText: formatDeviceReasonUserFacingForDevice(device),
    // The line the CARD actually rendered. Since 2026-08-02 the card and this
    // helper deliberately differ — the card states what the device needs, the
    // helper keeps the fuller cause — so logging only `reasonText` would leave a
    // support session unable to reconstruct what the owner was looking at
    // (feedback_ui_text_shared_with_logs). Both, not either.
    //
    // Gated on the same held/intent state the card gates on. The resolver is a
    // HELD ladder: called for a running or idle device it returns its terminal
    // "Waiting to resume" fallback, which would log a line no card ever showed —
    // the opposite of what this field is for. `null` when the card renders no
    // reason line.
    cardReasonText: resolveCardReasonTextForLog(device),
    currentDrawKw: device.currentDrawKw,
    expectedPowerKw: getDeviceOverviewExpectedPowerKw(device),
    reportedStepId: getDeviceOverviewReportedStepId(device) ?? null,
    // The step id the CARD shows — off the cluster, so it carries
    // `buildOverviewSteppedLoad`'s correction for a planner target the confirmed
    // ladder lacks. It used to read the raw plan-device ids, which meant this
    // log could name a rung the owner was never shown; the surrounding docblock
    // is explicit that the log and the card must report the same thing.
    targetStepId: device.steppedLoad?.targetStepId ?? null,
    // The planner's RAW intent, deliberately uncorrected and kept beside the
    // shown value: when the two differ, the device is aiming at a rung its
    // confirmed ladder does not have, and seeing both is how you diagnose that.
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

// Mirrors the card's own gate (`PlanDeviceCards` / `planTemperatureCardText`):
// the reason line renders only for a held card, so the logged copy of it must
// exist only there too. A device the planner left inactive but a hold reason is
// keeping back counts as held, which is why this uses the INTENT kind rather
// than the raw one.
function resolveCardReasonTextForLog(device: OverviewLogDevice): string | null {
  const kind = resolveIntentStateKind({
    kind: resolveRawPlanStateKind(device),
    reasonCode: device.reason.code,
    starved: false,
  });
  if (kind !== 'held' && !isActionSpecificRestoreWaitReasonCode(device.reason.code)) return null;
  return resolveHeldCardReasonLine({
    reason: device.reason,
    // Resolved here, with the plan layer's own guard, instead of being
    // re-derived inside the verb from a tag this carrier never had.
    verb: resolveHeldCardReasonVerb({
      ...resolveHeldCardStepView(device),
      currentState: device.currentState,
    }),
  });
}

/**
 * Build a device-log entry from a plan device and its formatted overview.
 *
 * The four message fields are the verbatim shared-formatter output, so the
 * device-log view and the structured overview log report identical wording
 * (both consume `formatDeviceOverview`).
 */
export function buildDeviceLogEntry(
  device: OverviewLogDevice,
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
