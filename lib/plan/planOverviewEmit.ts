/** Consumes the exact published presentation; never constructs another state. */
import {
  buildDeviceLogEntry,
  buildOverviewBatchEvent,
  buildOverviewEventForDevice,
  buildOverviewSignatureForDevice,
  buildPresentationSignatureForDevice,
  type DeviceOverviewLogRecorder,
  type OverviewDecisionFacts,
} from './deviceOverviewLog';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { SettingsUiPlanDevice, SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUiApi';

export type OverviewEmitDeps = {
  isOverviewDebugEnabled: () => boolean;
  overviewDebugStructured: StructuredDebugEmitter;
  deviceOverviewLogRecorder: DeviceOverviewLogRecorder;
};

/**
 * What each device last presented to the UI, and what its activity log last
 * recorded. They differ on purpose: a drifting temperature or a re-anchored
 * countdown must still reach an open card, but is not a state change to log.
 */
export class DeviceOverviewTransitions {
  private readonly presentationById = new Map<string, string>();
  private readonly loggedById = new Map<string, string>();

  /** Records log transitions; returns whether any presentation changed for the UI. */
  capture(
    snapshot: SettingsUiPlanSnapshot,
    deps: OverviewEmitDeps,
    describeDecision: (deviceId: string) => OverviewDecisionFacts,
  ): boolean {
    const debugEnabled = deps.isOverviewDebugEnabled();
    const events: Record<string, unknown>[] = [];
    const retained = new Set<string>();
    let presentationChanged = false;
    for (const device of snapshot.devices ?? []) {
      retained.add(device.id);
      const change = this.observe(device);
      if (change === 'unchanged') continue;
      presentationChanged = true;
      if (change !== 'state_changed') continue;
      deps.deviceOverviewLogRecorder.record(device.id, buildDeviceLogEntry(device));
      if (debugEnabled) events.push(buildOverviewEventForDevice(device, describeDecision(device.id)));
    }
    this.forgetDevicesNotIn(retained);
    if (events.length === 1 && events[0]) deps.overviewDebugStructured(events[0]);
    else if (events.length > 1) deps.overviewDebugStructured(buildOverviewBatchEvent(events));
    return presentationChanged;
  }

  private observe(device: SettingsUiPlanDevice): 'unchanged' | 'presentation_changed' | 'state_changed' {
    const presentation = buildPresentationSignatureForDevice(device);
    if (this.presentationById.get(device.id) === presentation) return 'unchanged';
    this.presentationById.set(device.id, presentation);
    const logged = buildOverviewSignatureForDevice(device);
    if (this.loggedById.get(device.id) === logged) return 'presentation_changed';
    this.loggedById.set(device.id, logged);
    return 'state_changed';
  }

  private forgetDevicesNotIn(retained: ReadonlySet<string>): void {
    for (const id of this.presentationById.keys()) {
      if (retained.has(id)) continue;
      this.presentationById.delete(id);
      this.loggedById.delete(id);
    }
  }
}
