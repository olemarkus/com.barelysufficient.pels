import type { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import type { PowerMeasurementUpdates } from './powerMeasurement';
import {
  formatBinaryState,
  formatTargetValue,
  getRecentLocalCapabilityWrite,
  type RecentLocalCapabilityWrites,
} from './deviceManagerRealtimeSupport';
import { logDeviceManagerRuntimeError } from './deviceManagerHomeyApi';

const REALTIME_POWER_CAPABILITY_PREFIX = 'measure_power';
const REALTIME_CONTROL_CAPABILITY_IDS = ['onoff', 'evcharger_charging'] as const;
const REALTIME_TARGET_CAPABILITY_PREFIX = 'target_temperature';

export type CapabilityInstance = { destroy?: () => void };
export type RealtimeDeviceReconcileChange = {
  capabilityId: string;
  previousValue: string;
  nextValue: string;
};

type RealtimeReconcileResult = {
  shouldReconcilePlan: boolean;
  changes: RealtimeDeviceReconcileChange[];
};

type MakeCapabilityInstance = (
  capabilityId: string,
  listener: (value: unknown) => void,
) => CapabilityInstance | Promise<CapabilityInstance>;

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

export function handlePowerUpdate(params: {
  state: {
    lastMeasuredPowerKw: Record<string, { kw: number; ts: number }>;
    lastKnownPowerKw: Record<string, number>;
  };
  logger: Logger;
  latestSnapshot: TargetDeviceSnapshot[];
  deviceId: string;
  label: string;
  value: number | null;
}): void {
  const {
    state,
    logger,
    latestSnapshot,
    deviceId,
    label,
    value,
  } = params;
  if (typeof value !== 'number' || !Number.isFinite(value)) return;

  const measuredKw = value / 1000;
  state.lastMeasuredPowerKw[deviceId] = { kw: measuredKw, ts: Date.now() };
  updateLastKnownPower({ state, logger, deviceId, measuredKw, deviceLabel: label });

  const snapshot = latestSnapshot.find((entry) => entry.id === deviceId);
  if (!snapshot) return;
  snapshot.measuredPowerKw = measuredKw;
  snapshot.powerKw = measuredKw;
}

export async function attachRealtimeDeviceUpdateListener(params: {
  devicesApi?: {
    connect?: () => Promise<void>;
    on?: (event: string, listener: (payload: HomeyDeviceLike) => void) => unknown;
  };
  alreadyAttached: boolean;
  listener: (device: HomeyDeviceLike) => void;
  eventName: string;
  logger: Logger;
}): Promise<boolean> {
  const { devicesApi, alreadyAttached, listener, eventName, logger } = params;
  if (!devicesApi || alreadyAttached) return alreadyAttached;
  const connect = devicesApi.connect;
  const on = devicesApi.on;
  if (typeof connect !== 'function' || typeof on !== 'function') return false;

  try {
    await connect.call(devicesApi);
    on.call(devicesApi, eventName, listener);
    logger.debug(`Real-time ${eventName} listener attached`);
    return true;
  } catch (error) {
    const message = `Failed to attach ${eventName} listener`;
    logDeviceManagerRuntimeError(logger, message, error);
    return false;
  }
}

export async function syncRealtimeDeviceUpdateListener(params: {
  devicesApi?: {
    connect?: () => Promise<void>;
    on?: (event: string, listener: (payload: HomeyDeviceLike) => void) => unknown;
    off?: (event: string, listener: (payload: HomeyDeviceLike) => void) => unknown;
    disconnect?: () => Promise<void>;
  };
  attached: boolean;
  devices: HomeyDeviceLike[];
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  listener: (device: HomeyDeviceLike) => void;
  eventName: string;
  logger: Logger;
}): Promise<boolean> {
  const {
    devicesApi,
    attached,
    devices,
    shouldTrackRealtimeDevice,
    listener,
    eventName,
    logger,
  } = params;
  const shouldAttach = devices.some((device) => {
    const deviceId = device.id || device.data?.id;
    return typeof deviceId === 'string' && shouldTrackRealtimeDevice(deviceId);
  });
  if (shouldAttach) {
    return attachRealtimeDeviceUpdateListener({
      devicesApi,
      alreadyAttached: attached,
      listener,
      eventName,
      logger,
    });
  }
  return detachRealtimeDeviceUpdateListener({
    devicesApi,
    attached,
    listener,
    eventName,
    logger,
  });
}

export function detachRealtimeDeviceUpdateListener(params: {
  devicesApi?: {
    off?: (event: string, listener: (payload: HomeyDeviceLike) => void) => unknown;
    disconnect?: () => Promise<void>;
  };
  attached: boolean;
  listener: (device: HomeyDeviceLike) => void;
  eventName: string;
  logger: Logger;
}): boolean {
  const {
    devicesApi,
    attached,
    listener,
    eventName,
    logger,
  } = params;
  if (!attached) {
    return false;
  }
  if (typeof devicesApi?.off !== 'function') {
    return attached;
  }
  try {
    devicesApi.off.call(devicesApi, eventName, listener);
    if (typeof devicesApi.disconnect === 'function') {
      void devicesApi.disconnect.call(devicesApi).catch((error: unknown) => {
        const message = `Failed to disconnect realtime ${eventName} listener`;
        logDeviceManagerRuntimeError(logger, message, error);
      });
    }
  } catch (error) {
    const message = `Failed to detach ${eventName} listener`;
    logDeviceManagerRuntimeError(logger, message, error);
    return attached;
  }
  return false;
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

export function getRealtimeCapabilityIds(device: HomeyDeviceLike): string[] {
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
  return capabilities.filter((capabilityId) => (
    isRealtimePowerCapability(capabilityId)
    || isRealtimeControlCapability(capabilityId)
    || capabilityId.startsWith(REALTIME_TARGET_CAPABILITY_PREFIX)
  ));
}

export function reconcileRealtimeCapabilityValue(params: {
  latestSnapshot: TargetDeviceSnapshot[];
  deviceId: string;
  capabilityId: string;
  value: unknown;
}): RealtimeReconcileResult {
  const { latestSnapshot, deviceId, capabilityId, value } = params;
  const snapshot = latestSnapshot.find((entry) => entry.id === deviceId);
  if (!snapshot) return { shouldReconcilePlan: false, changes: [] };

  if (isRealtimePowerCapability(capabilityId)) {
    return { shouldReconcilePlan: false, changes: [] };
  }
  if (isRealtimeControlCapability(capabilityId) && typeof value === 'boolean') {
    if (snapshot.currentOn === value) return { shouldReconcilePlan: false, changes: [] };
    const previousValue = formatBinaryState(snapshot.currentOn);
    snapshot.currentOn = value;
    return {
      shouldReconcilePlan: true,
      changes: [{
        capabilityId,
        previousValue,
        nextValue: formatBinaryState(value),
      }],
    };
  }
  if (capabilityId.startsWith(REALTIME_TARGET_CAPABILITY_PREFIX) && typeof value === 'number') {
    const target = snapshot.targets.find((entry) => entry.id === capabilityId);
    if (!target || target.value === value) return { shouldReconcilePlan: false, changes: [] };
    const previousValue = formatTargetValue(target.value, target.unit);
    target.value = value;
    return {
      shouldReconcilePlan: true,
      changes: [{
        capabilityId,
        previousValue,
        nextValue: formatTargetValue(value, target.unit),
      }],
    };
  }
  return { shouldReconcilePlan: false, changes: [] };
}

export function hasRealtimeCapabilityListener(params: {
  capabilityInstances: Map<string, CapabilityInstance>;
  deviceId: string;
  capabilityId: string;
}): boolean {
  const { capabilityInstances, deviceId, capabilityId } = params;
  return capabilityInstances.has(buildCapabilityListenerKey(deviceId, capabilityId));
}

export async function syncRealtimeCapabilityListeners(params: {
  devices: HomeyDeviceLike[];
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  capabilityInstances: Map<string, CapabilityInstance>;
  onCapabilityValue: (deviceId: string, deviceLabel: string, capabilityId: string, value: unknown) => void;
  logger: Logger;
}): Promise<void> {
  const {
    devices,
    shouldTrackRealtimeDevice,
    capabilityInstances,
    onCapabilityValue,
    logger,
  } = params;
  const desiredListenerKeys = new Set<string>();
  for (const device of devices) {
    await syncRealtimeCapabilityListenersForDevice({
      device,
      shouldTrackRealtimeDevice,
      desiredListenerKeys,
      capabilityInstances,
      onCapabilityValue,
      logger,
    });
  }

  destroyStaleRealtimeCapabilityListeners(capabilityInstances, desiredListenerKeys);
}

async function syncRealtimeCapabilityListenersForDevice(params: {
  device: HomeyDeviceLike;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  desiredListenerKeys: Set<string>;
  capabilityInstances: Map<string, CapabilityInstance>;
  onCapabilityValue: (deviceId: string, deviceLabel: string, capabilityId: string, value: unknown) => void;
  logger: Logger;
}): Promise<void> {
  const {
    device,
    shouldTrackRealtimeDevice,
    desiredListenerKeys,
    capabilityInstances,
    onCapabilityValue,
    logger,
  } = params;
  const deviceId = device.id || device.data?.id;
  if (typeof deviceId !== 'string' || !shouldTrackRealtimeDevice(deviceId)) return;
  const realtimeCapabilityIds = getRealtimeCapabilityIds(device);
  if (realtimeCapabilityIds.length === 0) return;
  const makeCapabilityInstance = (
    device as { makeCapabilityInstance?: MakeCapabilityInstance }
  ).makeCapabilityInstance;
  if (typeof makeCapabilityInstance !== 'function') return;

  try {
    for (const capabilityId of realtimeCapabilityIds) {
      await ensureRealtimeCapabilityListener({
        device,
        deviceId,
        capabilityId,
        desiredListenerKeys,
        capabilityInstances,
        makeCapabilityInstance,
        onCapabilityValue,
        logger,
      });
    }
  } catch (error) {
    const label = device.name || deviceId || 'unknown';
    const message = `Failed to attach capability listener for ${label}`;
    logDeviceManagerRuntimeError(logger, message, error);
  }
}

async function ensureRealtimeCapabilityListener(params: {
  device: HomeyDeviceLike;
  deviceId: string;
  capabilityId: string;
  desiredListenerKeys: Set<string>;
  capabilityInstances: Map<string, CapabilityInstance>;
  makeCapabilityInstance: MakeCapabilityInstance;
  onCapabilityValue: (deviceId: string, deviceLabel: string, capabilityId: string, value: unknown) => void;
  logger: Logger;
}): Promise<void> {
  const {
    device,
    deviceId,
    capabilityId,
    desiredListenerKeys,
    capabilityInstances,
    makeCapabilityInstance,
    onCapabilityValue,
    logger,
  } = params;
  const listenerKey = buildCapabilityListenerKey(deviceId, capabilityId);
  desiredListenerKeys.add(listenerKey);
  if (capabilityInstances.has(listenerKey)) return;

  const instance = await makeCapabilityInstance.call(
    device,
    capabilityId,
    (value: unknown) => {
      onCapabilityValue(deviceId, device.name || deviceId, capabilityId, value);
    },
  );
  capabilityInstances.set(listenerKey, instance);
  logger.debug(`Real-time ${capabilityId} listener attached for ${device.name || deviceId}`);
}

function destroyStaleRealtimeCapabilityListeners(
  capabilityInstances: Map<string, CapabilityInstance>,
  desiredListenerKeys: Set<string>,
): void {
  for (const [listenerKey, instance] of capabilityInstances.entries()) {
    if (desiredListenerKeys.has(listenerKey)) continue;
    try {
      if (typeof instance.destroy === 'function') instance.destroy();
    } catch (_) {
      // ignore listener cleanup failures during teardown/reconfiguration
    }
    capabilityInstances.delete(listenerKey);
  }
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

export function isRealtimePowerCapability(capabilityId: string): boolean {
  return capabilityId === REALTIME_POWER_CAPABILITY_PREFIX
    || capabilityId.startsWith(`${REALTIME_POWER_CAPABILITY_PREFIX}.`);
}

export function isRealtimeControlCapability(
  capabilityId: string,
): capabilityId is (typeof REALTIME_CONTROL_CAPABILITY_IDS)[number] {
  return REALTIME_CONTROL_CAPABILITY_IDS.includes(
    capabilityId as (typeof REALTIME_CONTROL_CAPABILITY_IDS)[number],
  );
}

function buildCapabilityListenerKey(deviceId: string, capabilityId: string): string {
  return `${deviceId}:${capabilityId}`;
}
