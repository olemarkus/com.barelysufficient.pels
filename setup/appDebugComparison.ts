import type {
  DeviceDebugObservedSource,
  DeviceDebugObservedSources,
} from '../lib/device/deviceTransport';
import type {
  MeasuredPowerObservedProbe,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../lib/utils/types';
import type {
  DeviceStateComparison,
  DeviceStateComparisonSource,
  PelsObservedSourceSummary,
  PelsObservedSourcesSummary,
  PelsPlanDeviceSummary,
  PelsTargetSnapshotSummary,
  UnknownRecord,
} from './appDebugTypes';
import { asTimestampString, isRecord } from './appDebugPrimitives';

const getCapabilityEntry = (device: HomeyDeviceLike, capabilityId: string): UnknownRecord | null => {
  const entry = device.capabilitiesObj?.[capabilityId];
  return isRecord(entry) ? entry : null;
};

const asBinaryState = (value: unknown): string | undefined => {
  if (typeof value !== 'boolean') return undefined;
  return value ? 'on' : 'off';
};

/* eslint-disable complexity -- comparison serializer is a flat mapping of relevant state. */
export const buildHomeyStateComparisonSource = (
  device: HomeyDeviceLike | null,
): DeviceStateComparisonSource | null => {
  if (!device) return null;
  const record = device as unknown as UnknownRecord;
  const onoff = getCapabilityEntry(device, 'onoff');
  const target = getCapabilityEntry(device, 'target_temperature');
  const power = getCapabilityEntry(device, 'measure_power');
  return {
    ...(asBinaryState(onoff?.value) ? { sourceState: asBinaryState(onoff?.value) } : {}),
    ...(Object.prototype.hasOwnProperty.call(target ?? {}, 'value') ? { target: target?.value } : {}),
    ...(typeof power?.value === 'number' && Number.isFinite(power.value) ? { powerW: power.value as number } : {}),
    ...(asTimestampString(record.lastSeenAt) ? { lastSeenAt: asTimestampString(record.lastSeenAt) } : {}),
    ...(asTimestampString(onoff?.lastUpdated) ? { onoffLastUpdated: asTimestampString(onoff?.lastUpdated) } : {}),
    ...(asTimestampString(target?.lastUpdated) ? { targetLastUpdated: asTimestampString(target?.lastUpdated) } : {}),
    ...(asTimestampString(power?.lastUpdated) ? { powerLastUpdated: asTimestampString(power?.lastUpdated) } : {}),
  };
};
/* eslint-enable complexity */

const resolveComparisonPowerW = (
  snapshot: PelsTargetSnapshotSummary | (TargetDeviceSnapshot & MeasuredPowerObservedProbe),
): number | null => {
  if (typeof snapshot.measuredPowerKw === 'number') {
    return Math.round(snapshot.measuredPowerKw * 1000);
  }
  if (typeof snapshot.powerKw === 'number') {
    return Math.round(snapshot.powerKw * 1000);
  }
  return null;
};

export const buildPelsSnapshotComparisonSource = (
  snapshot: PelsTargetSnapshotSummary | TargetDeviceSnapshot | null,
): DeviceStateComparisonSource | null => {
  if (!snapshot) return null;
  const target = Array.isArray(snapshot.targets) ? snapshot.targets[0] : null;
  const powerW = resolveComparisonPowerW(snapshot);
  return {
    sourceState: (snapshot.binaryControl?.on ?? true) ? 'on' : 'off',
    ...(target ? { target: target.value } : {}),
    ...(powerW !== null ? { powerW } : {}),
    ...(asTimestampString(snapshot.lastUpdated) ? { lastSeenAt: asTimestampString(snapshot.lastUpdated) } : {}),
  };
};

export const buildPelsPlanComparisonSource = (
  device: PelsPlanDeviceSummary | null,
): DeviceStateComparison['pelsPlan'] => {
  if (!device) return null;
  return {
    currentState: device.currentState,
    plannedState: device.plannedState,
    currentTarget: device.currentTarget,
    plannedTarget: device.plannedTarget,
    ...(device.pendingTargetCommand ? { pendingTargetCommand: device.pendingTargetCommand } : {}),
  };
};

const buildObservedSourceSummary = (
  source: DeviceDebugObservedSource,
): PelsObservedSourceSummary => {
  return {
    observedAt: new Date(source.observedAt).toISOString(),
    path: source.path,
    state: buildPelsSnapshotComparisonSource(source.snapshot),
    ...(source.fetchSource ? { fetchSource: source.fetchSource } : {}),
    ...(source.capabilityId ? { capabilityId: source.capabilityId } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, 'value') ? { value: source.value } : {}),
    ...(typeof source.localEcho === 'boolean' ? { localEcho: source.localEcho } : {}),
    ...(typeof source.shouldReconcilePlan === 'boolean' ? { shouldReconcilePlan: source.shouldReconcilePlan } : {}),
    ...(typeof source.preservedLocalState === 'boolean'
      ? { preservedLocalState: source.preservedLocalState }
      : {}),
    ...(source.changes ? { changes: source.changes.map((change) => ({ ...change })) } : {}),
  };
};

const buildOptionalObservedSourceSummary = (
  source: DeviceDebugObservedSource | undefined,
): PelsObservedSourceSummary | null => (
  source ? buildObservedSourceSummary(source) : null
);

export const buildObservedSourcesSummary = (
  sources: DeviceDebugObservedSources | null | undefined,
): PelsObservedSourcesSummary | undefined => {
  if (!sources) return undefined;
  return {
    snapshotRefresh: buildOptionalObservedSourceSummary(sources.snapshotRefresh),
    deviceUpdate: buildOptionalObservedSourceSummary(sources.deviceUpdate),
    realtimeCapabilities: Object.fromEntries(
      Object.entries(sources.realtimeCapabilities).map(([capabilityId, source]) => [
        capabilityId,
        buildObservedSourceSummary(source),
      ]),
    ),
    localWrites: Object.fromEntries(
      Object.entries(sources.localWrites).map(([capabilityId, source]) => [
        capabilityId,
        buildObservedSourceSummary(source),
      ]),
    ),
  };
};
