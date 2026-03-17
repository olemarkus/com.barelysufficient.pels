import type { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import type { PowerMeasurementUpdates } from './powerMeasurement';
import {
  formatBinaryState,
  formatTargetValue,
  getRecentLocalCapabilityWrite,
  type RecentLocalCapabilityWrites,
} from './deviceManagerRealtimeSupport';

const REALTIME_CONTROL_CAPABILITY_IDS = ['onoff', 'evcharger_charging'] as const;

export type RealtimeDeviceReconcileChange = {
  capabilityId: string;
  previousValue: string;
  nextValue: string;
};

type RealtimeReconcileResult = {
  shouldReconcilePlan: boolean;
  changes: RealtimeDeviceReconcileChange[];
};

export function updateLastKnownPower(params: {
  state: { lastKnownPowerKw: Record<string, number> };
  logger: Logger;
  deviceId: string;
  measuredKw: number;
  deviceLabel: string;
}): void {
  const {
    state,
    logger,
    deviceId,
    measuredKw,
    deviceLabel,
  } = params;
  const previousPeak = state.lastKnownPowerKw[deviceId] || 0;
  if (measuredKw > previousPeak) {
    state.lastKnownPowerKw[deviceId] = measuredKw;
    logger.debug(
      `Power estimate: updated peak power for ${deviceLabel}: ${measuredKw.toFixed(3)} kW `
      + `(was ${previousPeak.toFixed(3)} kW)`,
    );
  }
}

export function applyMeasurementUpdates(params: {
  state: {
    lastKnownPowerKw: Record<string, number>;
    lastMeterEnergyKwh: Record<string, { kwh: number; ts: number }>;
    lastMeasuredPowerKw: Record<string, { kw: number; ts: number }>;
  };
  logger: Logger;
  deviceId: string;
  updates: PowerMeasurementUpdates;
  deviceLabel: string;
}): void {
  const {
    state,
    logger,
    deviceId,
    updates,
    deviceLabel,
  } = params;
  if (updates.lastMeterEnergyKwh) {
    state.lastMeterEnergyKwh[deviceId] = updates.lastMeterEnergyKwh;
  }
  if (updates.lastMeasuredPowerKw) {
    state.lastMeasuredPowerKw[deviceId] = updates.lastMeasuredPowerKw;
    updateLastKnownPower({ state, logger, deviceId, measuredKw: updates.lastMeasuredPowerKw.kw, deviceLabel });
  }
}

export function reconcileRealtimeDeviceUpdate(params: {
  latestSnapshot: TargetDeviceSnapshot[];
  device: HomeyDeviceLike;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TargetDeviceSnapshot | null;
  recentLocalCapabilityWrites?: RecentLocalCapabilityWrites;
}): RealtimeReconcileResult {
  const {
    latestSnapshot,
    device,
    parseDevice,
    recentLocalCapabilityWrites,
  } = params;
  const deviceId = device.id || device.data?.id;
  if (!deviceId) return { shouldReconcilePlan: false, changes: [] };

  const parsed = parseDevice(device, Date.now());
  const snapshotIndex = latestSnapshot.findIndex((entry) => entry.id === deviceId);
  const previous = snapshotIndex >= 0 ? latestSnapshot[snapshotIndex] : null;
  if (!parsed) {
    if (snapshotIndex >= 0) {
      latestSnapshot.splice(snapshotIndex, 1);
      return { shouldReconcilePlan: false, changes: [] };
    }
    return { shouldReconcilePlan: false, changes: [] };
  }

  preserveRecentLocalBinaryState({
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
  });

  if (snapshotIndex >= 0) {
    latestSnapshot[snapshotIndex] = parsed;
  } else {
    latestSnapshot.push(parsed);
  }

  const changes = getPlanReconcileRealtimeChanges(previous, parsed);
  return {
    shouldReconcilePlan: changes.length > 0,
    changes,
  };
}

function preserveRecentLocalBinaryState(params: {
  previous: TargetDeviceSnapshot | null;
  parsed: TargetDeviceSnapshot;
  deviceId: string;
  recentLocalCapabilityWrites?: RecentLocalCapabilityWrites;
}): void {
  const {
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
  } = params;
  if (!previous || !recentLocalCapabilityWrites) return;
  const capabilityId = parsed.controlCapabilityId ?? previous.controlCapabilityId;
  if (capabilityId !== 'onoff' && capabilityId !== 'evcharger_charging') return;
  const localWrite = getRecentLocalCapabilityWrite({
    recentLocalCapabilityWrites,
    deviceId,
    capabilityId,
  });
  if (!localWrite || typeof localWrite.value !== 'boolean') return;
  if (typeof parsed.currentOn !== 'boolean') return;
  if (parsed.currentOn === localWrite.value) return;
  if (previous.currentOn !== localWrite.value) return;
  parsed.currentOn = previous.currentOn;
}

function getPlanReconcileRealtimeChanges(
  previous: TargetDeviceSnapshot | null,
  next: TargetDeviceSnapshot,
): RealtimeDeviceReconcileChange[] {
  if (!previous) return [];

  const changes: RealtimeDeviceReconcileChange[] = [];
  if (previous.currentOn !== next.currentOn) {
    changes.push({
      capabilityId: next.controlCapabilityId ?? previous.controlCapabilityId ?? 'onoff',
      previousValue: formatBinaryState(previous.currentOn),
      nextValue: formatBinaryState(next.currentOn),
    });
  }

  const previousTargetsById = new Map(previous.targets.map((target) => [target.id, target]));
  for (const nextTarget of next.targets) {
    const previousTarget = previousTargetsById.get(nextTarget.id);
    if (!previousTarget || previousTarget.value === nextTarget.value) continue;
    changes.push({
      capabilityId: nextTarget.id,
      previousValue: formatTargetValue(previousTarget.value, previousTarget.unit),
      nextValue: formatTargetValue(nextTarget.value, nextTarget.unit),
    });
  }

  return changes;
}

export function isRealtimeControlCapability(
  capabilityId: string,
): capabilityId is (typeof REALTIME_CONTROL_CAPABILITY_IDS)[number] {
  return REALTIME_CONTROL_CAPABILITY_IDS.includes(
    capabilityId as (typeof REALTIME_CONTROL_CAPABILITY_IDS)[number],
  );
}
