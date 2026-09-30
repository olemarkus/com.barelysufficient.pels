/** Consumes the exact published presentation; never constructs another state. */
import {
  buildDeviceLogEntry,
  buildOverviewBatchEvent,
  buildOverviewEventForDevice,
  buildOverviewSignatureForDevice,
  type DeviceOverviewLogRecorder,
} from './deviceOverviewLog';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUiApi';

export type OverviewEmitDeps = {
  isOverviewDebugEnabled?: () => boolean;
  overviewDebugStructured?: StructuredDebugEmitter;
  deviceOverviewLogRecorder?: DeviceOverviewLogRecorder;
};

export function emitDeviceOverviewTransitions(
  snapshot: SettingsUiPlanSnapshot,
  signatures: Map<string, string>,
  deps: OverviewEmitDeps,
): boolean {
  const debugEnabled = deps.isOverviewDebugEnabled?.() === true && deps.overviewDebugStructured !== undefined;
  const events: Record<string, unknown>[] = [];
  const retained = new Set<string>();
  let captured = false;
  for (const device of snapshot.devices ?? []) {
    retained.add(device.id);
    const signature = buildOverviewSignatureForDevice(device);
    if (signatures.get(device.id) === signature) continue;
    signatures.set(device.id, signature);
    captured = true;
    deps.deviceOverviewLogRecorder?.record(device.id, buildDeviceLogEntry(device));
    // eslint-disable-next-line functional/immutable-data -- Local batch of changed presentations.
    if (debugEnabled) events.push(buildOverviewEventForDevice(device));
  }
  for (const id of signatures.keys()) if (!retained.has(id)) signatures.delete(id);
  if (events.length === 1 && events[0]) deps.overviewDebugStructured?.(events[0]);
  else if (events.length > 1) deps.overviewDebugStructured?.(buildOverviewBatchEvent(events));
  return captured;
}
