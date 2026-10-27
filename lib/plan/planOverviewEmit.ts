/** Consumes the exact published presentation; never constructs another state. */
import {
  buildDeviceLogEntry,
  buildOverviewBatchEvent,
  buildOverviewEventForDevice,
  buildOverviewSignatureForDevice,
  buildLoggedReasonShape,
  buildPresentationSignatureForDevice,
  isCountdownWait,
  type OverviewDecisionFacts,
} from './deviceOverviewLog';
import type { DeviceOverviewLogRecorder } from '../diagnostics/deviceActivityRecorder';
import { getDebugEmitter, isDebugTopicEnabled } from '../logging/logger';
import type { SettingsUiPlanDevice, SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUiApi';

const emitOverviewDebug = getDebugEmitter('overview', 'overview');

/**
 * What each device last presented to the UI, and what its activity log last
 * recorded. They differ on purpose: a drifting temperature, a countdown, or a
 * thermostat switching its own element must still reach an open card, but is
 * not a state change to log.
 */
export class DeviceOverviewTransitions {
  private readonly presentationById = new Map<string, string>();
  private readonly loggedById = new Map<string, string>();
  /** The reason each device last showed outside a countdown wait, which the log keeps through one. */
  private readonly steadyReasonById = new Map<string, string | null>();

  /** Records log transitions; returns whether any presentation changed for the UI. */
  capture(
    snapshot: SettingsUiPlanSnapshot,
    logRecorder: DeviceOverviewLogRecorder,
    describeDecision: (deviceId: string) => OverviewDecisionFacts,
  ): boolean {
    const debugEnabled = isDebugTopicEnabled('overview');
    const events: Record<string, unknown>[] = [];
    const retained = new Set<string>();
    let presentationChanged = false;
    for (const device of snapshot.devices ?? []) {
      retained.add(device.id);
      const change = this.observe(device, describeDecision);
      if (change === 'unchanged') continue;
      presentationChanged = true;
      if (change !== 'state_changed') continue;
      logRecorder.record(device, buildDeviceLogEntry(device), this.loggedById.get(device.id) ?? '');
      if (debugEnabled) events.push(buildOverviewEventForDevice(device, describeDecision(device.id)));
    }
    this.forgetDevicesNotIn(retained);
    logRecorder.flush();
    if (events.length === 1 && events[0]) emitOverviewDebug(events[0]);
    else if (events.length > 1) emitOverviewDebug(buildOverviewBatchEvent(events));
    return presentationChanged;
  }

  private observe(
    device: SettingsUiPlanDevice,
    describeDecision: (deviceId: string) => OverviewDecisionFacts,
  ): 'unchanged' | 'presentation_changed' | 'state_changed' {
    const presentation = buildPresentationSignatureForDevice(device);
    if (this.presentationById.get(device.id) === presentation) return 'unchanged';
    this.presentationById.set(device.id, presentation);
    const { reason } = device.status;
    const shape = buildLoggedReasonShape(device.status, describeDecision(device.id));
    const wait = isCountdownWait(reason);
    const carried = wait && this.steadyReasonById.has(device.id) ? this.steadyReasonById.get(device.id) ?? null : shape;
    if (!wait) this.steadyReasonById.set(device.id, shape);
    if (this.loggedById.get(device.id) === buildOverviewSignatureForDevice(device, carried)) {
      return 'presentation_changed';
    }
    // A row written during a wait names the wait, so the log now holds that: the
    // reason coming back afterwards is a change the next row must show.
    if (wait) this.steadyReasonById.set(device.id, shape);
    this.loggedById.set(device.id, buildOverviewSignatureForDevice(device, wait ? shape : carried));
    return 'state_changed';
  }

  private forgetDevicesNotIn(retained: ReadonlySet<string>): void {
    for (const id of this.presentationById.keys()) {
      if (retained.has(id)) continue;
      this.presentationById.delete(id);
      this.loggedById.delete(id);
      this.steadyReasonById.delete(id);
    }
  }
}
