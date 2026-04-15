import { roundLogValue, shouldEmitOnChange } from '../logging/logDedupe';
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
  observedCapabilityIds: string[];
};

export function updateLastKnownPower(params: {
  state: {
    lastKnownPowerKw: Record<string, number>;
    lastPeakPowerLogByDevice?: Map<string, { signature: string; emittedAt: number }>;
  };
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
  if (measuredKw <= previousPeak) return;

  state.lastKnownPowerKw[deviceId] = measuredKw;
  const previousPeakKw = roundLogValue(previousPeak, 2);
  const peakKw = roundLogValue(measuredKw, 2);
  const signature = JSON.stringify({ peakKw });
  if (!state.lastPeakPowerLogByDevice) return;
  if (!shouldEmitOnChange({
    state: state.lastPeakPowerLogByDevice,
    key: deviceId,
    signature,
    now: Date.now(),
  })) {
    return;
  }
  logger.structuredLog?.debug({
    event: 'power_estimate_peak_updated',
    deviceId,
    deviceName: deviceLabel,
    previousPeakKw,
    peakKw,
  });
}

export function applyMeasurementUpdates(params: {
  state: {
    lastKnownPowerKw: Record<string, number>;
    lastMeterEnergyKwh: Record<string, { kwh: number; ts: number }>;
    lastMeasuredPowerKw: Record<string, { kw: number; ts: number }>;
    lastPeakPowerLogByDevice?: Map<string, { signature: string; emittedAt: number }>;
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
  hasPendingBinarySettleWindow?: (deviceId: string, capabilityId: string) => boolean;
}): RealtimeReconcileResult {
  const {
    latestSnapshot,
    device,
    parseDevice,
    recentLocalCapabilityWrites,
    hasPendingBinarySettleWindow,
  } = params;
  const deviceId = device.id || device.data?.id;
  if (!deviceId) return { shouldReconcilePlan: false, changes: [], observedCapabilityIds: [] };

  const parsed = parseDevice(device, Date.now());
  const snapshotIndex = latestSnapshot.findIndex((entry) => entry.id === deviceId);
  const previous = snapshotIndex >= 0 ? latestSnapshot[snapshotIndex] : null;
  if (!parsed) {
    if (snapshotIndex >= 0) {
      latestSnapshot.splice(snapshotIndex, 1);
      return { shouldReconcilePlan: false, changes: [], observedCapabilityIds: [] };
    }
    return { shouldReconcilePlan: false, changes: [], observedCapabilityIds: [] };
  }

  // Only let the raw device value bypass local-state preservation when the settle
  // window is active AND the payload contains an explicit boolean for the control
  // capability. A device.update without the binary capability in its payload would
  // cause parseDevice to synthesize a default (getCurrentOn returns true when the
  // value is missing), which must not be treated as a real observation.
  const controlCapabilityId = parsed.controlCapabilityId ?? previous?.controlCapabilityId;
  const binaryValueExplicitlyObserved = typeof device.capabilitiesObj?.[controlCapabilityId ?? '']?.value === 'boolean';

  preserveRecentLocalBinaryState({
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
    hasPendingBinarySettleWindow,
    binaryValueExplicitlyObserved,
  });

  if (snapshotIndex >= 0) {
    latestSnapshot[snapshotIndex] = parsed;
  } else {
    latestSnapshot.push(parsed);
  }

  const changes = getPlanReconcileRealtimeChanges(previous, parsed);
  const observedCapabilityIds = getObservedCapabilityIds(previous, parsed);
  return {
    shouldReconcilePlan: changes.length > 0,
    changes,
    observedCapabilityIds,
  };
}

function preserveRecentLocalBinaryState(params: {
  previous: TargetDeviceSnapshot | null;
  parsed: TargetDeviceSnapshot;
  deviceId: string;
  recentLocalCapabilityWrites?: RecentLocalCapabilityWrites;
  hasPendingBinarySettleWindow?: (deviceId: string, capabilityId: string) => boolean;
  binaryValueExplicitlyObserved?: boolean;
}): void {
  const {
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
    hasPendingBinarySettleWindow,
    binaryValueExplicitlyObserved,
  } = params;
  if (!previous || !recentLocalCapabilityWrites) return;
  const capabilityId = parsed.controlCapabilityId ?? previous.controlCapabilityId;
  if (capabilityId !== 'onoff' && capabilityId !== 'evcharger_charging') return;
  // Skip preservation only when a settle window is active AND the payload contained
  // an explicit boolean value. Without an explicit observation, parseDevice may
  // synthesize a default (getCurrentOn returns true when the value is absent), which
  // must not be passed to the settle window as a real observation.
  if (hasPendingBinarySettleWindow?.(deviceId, capabilityId) && binaryValueExplicitlyObserved) return;
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
      previousValue: formatTargetValue(previousTarget.value, nextTarget.unit),
      nextValue: formatTargetValue(nextTarget.value, nextTarget.unit),
    });
  }

  return changes;
}

function getObservedCapabilityIds(
  previous: TargetDeviceSnapshot | null,
  next: TargetDeviceSnapshot,
): string[] {
  if (!previous) return [];

  const capabilityIds = new Set<string>();
  if (previous.currentOn !== next.currentOn) {
    capabilityIds.add(next.controlCapabilityId ?? previous.controlCapabilityId ?? 'onoff');
  }
  if (previous.measuredPowerKw !== next.measuredPowerKw) {
    capabilityIds.add('measure_power');
  }
  if (previous.evChargingState !== next.evChargingState) {
    capabilityIds.add('evcharger_charging_state');
  }

  const previousTargetsById = new Map(previous.targets.map((target) => [target.id, target]));
  for (const nextTarget of next.targets) {
    const previousTarget = previousTargetsById.get(nextTarget.id);
    if (!previousTarget || previousTarget.value === nextTarget.value) continue;
    capabilityIds.add(nextTarget.id);
  }

  return [...capabilityIds];
}

export function isRealtimeControlCapability(
  capabilityId: string,
): capabilityId is (typeof REALTIME_CONTROL_CAPABILITY_IDS)[number] {
  return REALTIME_CONTROL_CAPABILITY_IDS.includes(
    capabilityId as (typeof REALTIME_CONTROL_CAPABILITY_IDS)[number],
  );
}
