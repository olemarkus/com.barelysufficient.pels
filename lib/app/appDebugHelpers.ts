import type { DeviceManager } from '../core/deviceManager';
import type { HomeyDeviceLike } from '../utils/types';
import { safeJsonStringify, sanitizeLogValue } from '../utils/logUtils';
import { resolveHomeyEnergyApiFromHomeyApi } from '../utils/homeyEnergy';

type UnknownRecord = Record<string, unknown>;

type EnergyApproximationValues = {
  usageOnW: number | null;
  usageOffW: number | null;
  energyW: number | null;
};

type EnergyInference = {
  inferredExpectedW: number | null;
  inferredSource: string | null;
};

type EnergyDebugPayload = EnergyApproximationValues & {
  onoff: boolean | null;
} & EnergyInference;

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null
);

const asFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const resolveEnergyContainer = (device: HomeyDeviceLike): UnknownRecord | null => {
  const record = device as unknown as UnknownRecord;
  if (isRecord(record.energyObj)) return record.energyObj;
  if (isRecord(record.energy)) return record.energy;
  return null;
};

const resolveOnOffValue = (device: HomeyDeviceLike): boolean | null => {
  const value = device.capabilitiesObj?.onoff?.value;
  return typeof value === 'boolean' ? value : null;
};

const resolveApproximationValues = (energy: UnknownRecord): EnergyApproximationValues => {
  const approx = isRecord(energy.approximation) ? energy.approximation : null;
  return {
    usageOnW: approx ? asFiniteNumber(approx.usageOn) : null,
    usageOffW: approx ? asFiniteNumber(approx.usageOff) : null,
    energyW: asFiniteNumber(energy.W),
  };
};

const inferExpectedW = (params: {
  onoff: boolean | null;
  values: EnergyApproximationValues;
}): EnergyInference => {
  const { onoff, values } = params;
  const {
    usageOnW,
    usageOffW,
    energyW,
  } = values;

  if (usageOnW !== null && usageOffW !== null) {
    const deltaW = Math.max(0, usageOnW - usageOffW);
    if (deltaW > 0) return { inferredExpectedW: deltaW, inferredSource: 'approximation_delta' };
  }
  if (usageOnW !== null) return { inferredExpectedW: usageOnW, inferredSource: 'approximation_on' };
  if (energyW !== null && onoff !== false) return { inferredExpectedW: energyW, inferredSource: 'energy_w' };
  return { inferredExpectedW: null, inferredSource: null };
};

const buildEnergyDebugPayload = (device: HomeyDeviceLike): EnergyDebugPayload | null => {
  const energy = resolveEnergyContainer(device);
  if (!energy) return null;

  const onoff = resolveOnOffValue(device);
  const values = resolveApproximationValues(energy);
  if (
    values.usageOnW === null
    && values.usageOffW === null
    && values.energyW === null
  ) {
    return null;
  }

  const inference = inferExpectedW({ onoff, values });
  return {
    onoff,
    ...values,
    ...inference,
  };
};

const logDeviceEnergyApproximation = (params: {
  device: HomeyDeviceLike;
  safeDeviceId: string;
  safeLabel: string;
  log: (msg: string, metadata?: unknown) => void;
}): void => {
  const { device, safeDeviceId, safeLabel, log } = params;
  const payload = buildEnergyDebugPayload(device);
  if (!payload) {
    log('Homey device energy approximation: not available', { deviceId: safeDeviceId, label: safeLabel });
    return;
  }
  log('Homey device energy approximation', {
    deviceId: safeDeviceId,
    label: safeLabel,
    ...payload,
  });
};

const logHomeyDeviceDetails = async (params: {
  deviceId: string;
  safeDeviceId: string;
  safeLabel: string;
  deviceManager: DeviceManager;
  log: (msg: string, metadata?: unknown) => void;
}): Promise<void> => {
  const {
    deviceId,
    safeDeviceId,
    safeLabel,
    deviceManager,
    log,
  } = params;
  const getDevice = deviceManager.getHomeyApi?.()?.devices?.getDevice;
  if (typeof getDevice !== 'function') {
    log('Homey device detail: not available', { deviceId: safeDeviceId, label: safeLabel });
    log('Homey device settings (from getDevice): not available', { deviceId: safeDeviceId, label: safeLabel });
    return;
  }
  const deviceDetail = await getDevice({ id: deviceId });
  log('Homey device detail', {
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify(deviceDetail),
  });
  if (!isRecord(deviceDetail) || !('settings' in deviceDetail)) {
    log('Homey device settings (from getDevice): not available', { deviceId: safeDeviceId, label: safeLabel });
    return;
  }
  log('Homey device settings (from getDevice)', {
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify(deviceDetail.settings),
  });
};

const logHomeyDeviceSettingsObj = async (params: {
  deviceId: string;
  safeDeviceId: string;
  safeLabel: string;
  deviceManager: DeviceManager;
  log: (msg: string, metadata?: unknown) => void;
}): Promise<void> => {
  const {
    deviceId,
    safeDeviceId,
    safeLabel,
    deviceManager,
    log,
  } = params;
  const getDeviceSettingsObj = deviceManager.getHomeyApi?.()?.devices?.getDeviceSettingsObj;
  if (typeof getDeviceSettingsObj !== 'function') {
    log('Homey device settings object: not available', { deviceId: safeDeviceId, label: safeLabel });
    return;
  }
  const settingsObj = await getDeviceSettingsObj({ id: deviceId });
  log('Homey device settings object', {
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify(settingsObj),
  });
};

const logHomeyEnergyLiveReport = async (params: {
  deviceManager: DeviceManager;
  log: (msg: string, metadata?: unknown) => void;
}): Promise<void> => {
  const { deviceManager, log } = params;
  const energyApi = resolveHomeyEnergyApiFromHomeyApi(deviceManager.getHomeyApi?.());
  if (!energyApi || typeof energyApi.getLiveReport !== 'function') {
    log('Homey energy live report: not available');
    return;
  }
  const liveReport = await energyApi.getLiveReport({});
  log('Homey energy live report', { payload: safeJsonStringify(liveReport) });
};

export async function getHomeyDevicesForDebug(params: {
  deviceManager: DeviceManager;
}): Promise<HomeyDeviceLike[]> {
  const { deviceManager } = params;
  if (!deviceManager) return [];
  return deviceManager.getDevicesForDebug();
}

export async function logHomeyDeviceForDebug(params: {
  deviceId: string;
  deviceManager: DeviceManager;
  log: (msg: string, metadata?: unknown) => void;
  error: (msg: string, err: Error) => void;
}): Promise<boolean> {
  const { deviceId, deviceManager, log, error } = params;
  if (!deviceId) return false;

  let devices: HomeyDeviceLike[] = [];
  try {
    devices = await getHomeyDevicesForDebug({ deviceManager });
  } catch (err) {
    error('Failed to fetch Homey devices for debug', err as Error);
    return false;
  }

  const device = devices.find((entry) => entry.id === deviceId);
  const safeDeviceId = sanitizeLogValue(deviceId);
  if (!device) {
    log('Homey device dump: device not found', { deviceId: safeDeviceId });
    return false;
  }

  const label = device.name || deviceId;
  const safeLabel = sanitizeLogValue(label) || safeDeviceId;
  log('Homey device dump', {
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify(device),
  });
  log('Homey device settings (from list entry)', {
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify(device.settings),
  });

  try {
    logDeviceEnergyApproximation({
      device,
      safeDeviceId,
      safeLabel,
      log,
    });
  } catch (err) {
    error('Homey device energy approximation debug failed', err as Error);
  }

  try {
    await logHomeyDeviceDetails({
      deviceId,
      safeDeviceId,
      safeLabel,
      deviceManager,
      log,
    });
  } catch (err) {
    error('Homey device detail debug failed', err as Error);
  }

  try {
    await logHomeyDeviceSettingsObj({
      deviceId,
      safeDeviceId,
      safeLabel,
      deviceManager,
      log,
    });
  } catch (err) {
    error('Homey device settings object debug failed', err as Error);
  }

  try {
    await logHomeyEnergyLiveReport({ deviceManager, log });
  } catch (err) {
    error('Homey energy live report debug failed', err as Error);
  }

  return true;
}
