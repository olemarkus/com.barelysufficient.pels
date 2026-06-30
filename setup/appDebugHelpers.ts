/* eslint-disable functional/immutable-data -- debug payload assembly is local and not shared mutable state. */
import type Homey from 'homey';
import type { PowerCalibrationSnapshot } from '../packages/contracts/src/powerCalibration';
import type { DeviceTransport } from '../lib/device/deviceTransport';
import { DEVICES_API_PATH, getRawDevices } from '../lib/device/transport/managerHomeyApi';
import type { DevicePlan } from '../lib/plan/planTypes';
import type { HomeyDeviceLike } from '../lib/utils/types';
import { isHomeyDeviceLike } from '../lib/utils/types';
import { normalizeError } from '../lib/utils/errorUtils';
import { safeJsonStringify, sanitizeLogValue } from '../lib/utils/logUtils';
import { getLogger } from '../lib/logging/logger';
import type {
  DeviceDebugDump,
  DeviceStateComparison,
  PelsDeviceDebugState,
} from './appDebugTypes';
import {
  buildHomeyStateComparisonSource,
  buildObservedSourcesSummary,
  buildPelsPlanComparisonSource,
  buildPelsSnapshotComparisonSource,
} from './appDebugComparison';
import {
  buildAvailableSection,
  buildEnergyDebugPayload,
  buildUnavailableSection,
  compactHomeyDevice,
  compactPelsPlanDevice,
  compactPelsTargetSnapshot,
  filterRelevantSettings,
  getPelsPowerCalibration,
} from './appDebugCompaction';

const debugLogger = getLogger('devices/debug-dump');

const getRawManagerDeviceEntry = async (params: {
  deviceId: string;
}): Promise<HomeyDeviceLike | null> => {
  const { deviceId } = params;
  try {
    const devices = await getRawDevices(DEVICES_API_PATH);
    const list = Array.isArray(devices) ? devices : Object.values(devices || {});
    for (const entry of list) {
      if (isHomeyDeviceLike(entry) && entry.id === deviceId) {
        return entry;
      }
    }
    return null;
  } catch {
    return null;
  }
};

export async function getHomeyDevicesForDebug(params: {
  deviceManager: DeviceTransport;
}): Promise<HomeyDeviceLike[]> {
  const { deviceManager } = params;
  if (!deviceManager) return [];
  return deviceManager.getDevicesForDebug();
}

export async function getHomeyDevicesForDebugFromApp(app: Homey.App): Promise<HomeyDeviceLike[]> {
  const runtimeApp = app as Homey.App & { deviceManager?: DeviceTransport };
  if (!runtimeApp.deviceManager) return [];
  return getHomeyDevicesForDebug({ deviceManager: runtimeApp.deviceManager }).catch((err) => {
    runtimeApp.error?.('Failed to get Homey devices for debug', normalizeError(err));
    return [];
  });
}

export async function logHomeyDeviceForDebug(params: {
  deviceId: string;
  deviceManager: DeviceTransport;
  getPelsDeviceState?: (deviceId: string) => PelsDeviceDebugState | null;
  error: (msg: string, err: Error) => void;
}): Promise<boolean> {
  const {
    deviceId,
    deviceManager,
    getPelsDeviceState,
    error,
  } = params;
  if (!deviceId) return false;

  let devices: HomeyDeviceLike[];
  try {
    devices = await getHomeyDevicesForDebug({ deviceManager });
  } catch (err) {
    error('Failed to fetch Homey devices for debug', normalizeError(err));
    return false;
  }

  const device = devices.find((entry) => entry.id === deviceId);
  const safeDeviceId = sanitizeLogValue(deviceId);
  if (!device) {
    debugLogger.info({ event: 'homey_device_dump_device_not_found', deviceId: safeDeviceId });
    return false;
  }

  const label = device.name;
  const safeLabel = sanitizeLogValue(label) || safeDeviceId;
  const listSummary = compactHomeyDevice(device);
  const listSettings = filterRelevantSettings(device.settings);
  const dump: DeviceDebugDump = {
    homey: {
      summary: {
        ...buildAvailableSection(listSummary),
        source: 'listEntry',
      },
      settings: listSettings
        ? {
          ...buildAvailableSection(listSettings),
          source: 'listEntry',
        }
        : buildUnavailableSection(),
      energyApproximation: buildUnavailableSection(),
      comparison: buildUnavailableSection(),
    },
  };

  try {
    const energyApproximation = buildEnergyDebugPayload(device);
    dump.homey.energyApproximation = energyApproximation
      ? buildAvailableSection(energyApproximation)
      : buildUnavailableSection();
  } catch (err) {
    dump.homey.energyApproximation = buildUnavailableSection(normalizeError(err).message);
  }

  const rawManagerEntry = await getRawManagerDeviceEntry({ deviceId });

  if (typeof getPelsDeviceState === 'function') {
    try {
      dump.pels = getPelsDeviceState(deviceId) ?? {
        present: false,
        targetSnapshot: null,
        planDevice: null,
      };
    } catch (err) {
      dump.pels = {
        present: false,
        targetSnapshot: null,
        planDevice: null,
        error: normalizeError(err).message,
      };
    }
  }

  const comparisonPayload: DeviceStateComparison = {
    managerDevices: buildHomeyStateComparisonSource(rawManagerEntry),
    pelsSnapshot: buildPelsSnapshotComparisonSource(dump.pels?.targetSnapshot ?? null),
    pelsPlan: buildPelsPlanComparisonSource(dump.pels?.planDevice ?? null),
  };
  dump.homey.comparison = {
    ...buildAvailableSection(comparisonPayload),
    source: 'side_by_side',
  };

  debugLogger.info({
    event: 'homey_device_dump',
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify(dump),
  });
  return true;
}

// Comparison logging intentionally fans in multiple Homey and PELS state channels.
// eslint-disable-next-line complexity -- flat fan-in of independent state channels into one comparison payload.
export async function logHomeyDeviceComparisonForDebug(params: {
  deviceId: string;
  reason: string;
  expectedTarget?: number;
  observedTarget?: unknown;
  observedSource?: string;
  deviceManager: DeviceTransport;
  getPelsDeviceState?: (deviceId: string) => PelsDeviceDebugState | null;
  error: (msg: string, err: Error) => void;
}): Promise<boolean> {
  const {
    deviceId,
    reason,
    expectedTarget,
    observedTarget,
    observedSource,
    deviceManager,
    getPelsDeviceState,
    error,
  } = params;
  if (!deviceId) return false;

  let devices: HomeyDeviceLike[];
  try {
    devices = await getHomeyDevicesForDebug({ deviceManager });
  } catch (err) {
    error('Failed to fetch Homey devices for comparison debug', normalizeError(err));
    return false;
  }

  const device = devices.find((entry) => entry.id === deviceId);
  const safeDeviceId = sanitizeLogValue(deviceId);
  if (!device) {
    debugLogger.info({
      event: 'homey_pels_device_state_comparison_device_not_found',
      deviceId: safeDeviceId,
      reason,
    });
    return false;
  }

  const label = device.name;
  const safeLabel = sanitizeLogValue(label) || safeDeviceId;
  const rawManagerEntry = await getRawManagerDeviceEntry({ deviceId });
  const pelsState = typeof getPelsDeviceState === 'function'
    ? getPelsDeviceState(deviceId)
    : null;

  const comparisonPayload: DeviceStateComparison = {
    managerDevices: buildHomeyStateComparisonSource(rawManagerEntry),
    pelsSnapshot: buildPelsSnapshotComparisonSource(pelsState?.targetSnapshot ?? null),
    pelsPlan: buildPelsPlanComparisonSource(pelsState?.planDevice ?? null),
  };
  const observedSources = pelsState?.observedSources
    ?? buildObservedSourcesSummary(deviceManager.getDebugObservedSources?.(deviceId));

  debugLogger.info({
    event: 'homey_pels_device_state_comparison',
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify({
      reason,
      ...(typeof expectedTarget === 'number' ? { expectedTarget } : {}),
      ...(observedTarget !== undefined ? { observedTarget } : {}),
      ...(observedSource ? { observedSource } : {}),
      ...(observedSources ? { observedSources } : {}),
      comparison: comparisonPayload,
    }),
  });
  return true;
}

export async function logHomeyDeviceForDebugFromApp(params: {
  app: Homey.App;
  deviceId: string;
}): Promise<boolean> {
  const { app, deviceId } = params;
  const runtimeApp = app as Homey.App & {
    deviceManager?: DeviceTransport;
    planService?: { getLatestPlanSnapshot?: () => DevicePlan | null };
    powerCalibrationStore?: { getSnapshot?: () => PowerCalibrationSnapshot };
  };
  if (!runtimeApp.deviceManager) return false;
  return logHomeyDeviceForDebug({
    deviceId,
    deviceManager: runtimeApp.deviceManager,
    getPelsDeviceState: (targetDeviceId) => {
      const targetSnapshot = compactPelsTargetSnapshot(
        runtimeApp.deviceManager?.getSnapshot?.()
          ?.find((entry) => entry.id === targetDeviceId) ?? null,
      );
      const planDevice = compactPelsPlanDevice(
        runtimeApp.planService?.getLatestPlanSnapshot?.()
          ?.devices.find((entry) => entry.id === targetDeviceId) ?? null,
      );
      const powerCalibration = getPelsPowerCalibration(
        runtimeApp.powerCalibrationStore?.getSnapshot?.(),
        targetDeviceId,
      );
      return {
        present: Boolean(targetSnapshot || planDevice || powerCalibration),
        targetSnapshot,
        planDevice,
        powerCalibration,
        observedSources: buildObservedSourcesSummary(
          runtimeApp.deviceManager?.getDebugObservedSources?.(targetDeviceId),
        ),
      };
    },
    error: (msg, err) => runtimeApp.error?.(msg, err),
  });
}

export async function logHomeyDeviceComparisonForDebugFromApp(params: {
  app: Homey.App;
  deviceId: string;
  reason: string;
  expectedTarget?: number;
  observedTarget?: unknown;
  observedSource?: string;
}): Promise<boolean> {
  const {
    app,
    deviceId,
    reason,
    expectedTarget,
    observedTarget,
    observedSource,
  } = params;
  const runtimeApp = app as Homey.App & {
    deviceManager?: DeviceTransport;
    planService?: { getLatestPlanSnapshot?: () => DevicePlan | null };
    powerCalibrationStore?: { getSnapshot?: () => PowerCalibrationSnapshot };
  };
  if (!runtimeApp.deviceManager) return false;
  return logHomeyDeviceComparisonForDebug({
    deviceId,
    reason,
    expectedTarget,
    observedTarget,
    observedSource,
    deviceManager: runtimeApp.deviceManager,
    getPelsDeviceState: (targetDeviceId) => {
      const targetSnapshot = compactPelsTargetSnapshot(
        runtimeApp.deviceManager?.getSnapshot?.()
          ?.find((entry) => entry.id === targetDeviceId) ?? null,
      );
      const planDevice = compactPelsPlanDevice(
        runtimeApp.planService?.getLatestPlanSnapshot?.()
          ?.devices.find((entry) => entry.id === targetDeviceId) ?? null,
      );
      const powerCalibration = getPelsPowerCalibration(
        runtimeApp.powerCalibrationStore?.getSnapshot?.(),
        targetDeviceId,
      );
      return {
        present: Boolean(targetSnapshot || planDevice || powerCalibration),
        targetSnapshot,
        planDevice,
        powerCalibration,
        observedSources: buildObservedSourcesSummary(
          runtimeApp.deviceManager?.getDebugObservedSources?.(targetDeviceId),
        ),
      };
    },
    error: (msg, err) => runtimeApp.error?.(msg, err),
  });
}
