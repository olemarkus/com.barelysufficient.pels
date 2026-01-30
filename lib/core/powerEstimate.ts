import type { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import { getMeasuredPowerKw, type PowerMeasurementUpdates } from './powerMeasurement';

export type PowerEstimateState = {
  expectedPowerKwOverrides?: Record<string, { kw: number; ts: number }>;
  lastKnownPowerKw?: Record<string, number>;
  lastMeasuredPowerKw?: Record<string, { kw: number; ts: number }>;
  lastMeterEnergyKwh?: Record<string, { kwh: number; ts: number }>;
};

export type PowerEstimateResult = {
  powerKw?: number;
  expectedPowerKw?: number;
  expectedPowerSource?: TargetDeviceSnapshot['expectedPowerSource'];
  measuredPowerKw?: number;
  loadKw?: number;
};

export function estimatePower(params: {
  device: HomeyDeviceLike;
  deviceId: string;
  deviceLabel: string;
  powerRaw: unknown;
  meterPowerRaw: unknown;
  now: number;
  state: Required<PowerEstimateState>;
  logger: Logger;
  minSignificantPowerW: number;
  updateLastKnownPower: (deviceId: string, measuredKw: number, deviceLabel: string) => void;
  applyMeasurementUpdates: (deviceId: string, updates: PowerMeasurementUpdates, deviceLabel: string) => void;
}): PowerEstimateResult {
  const {
    device,
    deviceId,
    deviceLabel,
    powerRaw,
    meterPowerRaw,
    now,
    state,
    logger,
    minSignificantPowerW,
    updateLastKnownPower,
    applyMeasurementUpdates,
  } = params;

  const loadW = getLoadSettingWatts(device);
  const expectedOverride = state.expectedPowerKwOverrides[deviceId];
  const resolveMeasuredPower = () => {
    const measured = getMeasuredPowerKw({
      deviceId,
      deviceLabel,
      powerRaw,
      meterPowerRaw,
      now,
      minSignificantPowerW,
      state,
      logger,
    });
    if (measured.updates.lastMeterEnergyKwh || measured.updates.lastMeasuredPowerKw) {
      applyMeasurementUpdates(deviceId, measured.updates, deviceLabel);
    }
    return measured;
  };

  if (loadW !== null) {
    const measured = resolveMeasuredPower();
    const loadEstimate = getPowerFromLoad({
      deviceId,
      deviceLabel,
      loadW,
      expectedOverride,
      updateLastKnownPower,
      logger,
    });
    return {
      ...loadEstimate,
      measuredPowerKw: measured.measuredPowerKw,
    };
  }
  return getPowerFromMeasurement({
    deviceId,
    deviceLabel,
    expectedOverride,
    state,
    logger,
    resolveMeasuredPower,
  });
}

function getLoadSettingWatts(device: HomeyDeviceLike): number | null {
  const loadW = typeof device.settings?.load === 'number' ? device.settings.load : null;
  return loadW && loadW > 0 ? loadW : null;
}

function getPowerFromLoad(params: {
  deviceId: string;
  deviceLabel: string;
  loadW: number;
  expectedOverride?: { kw: number; ts: number };
  updateLastKnownPower: (deviceId: string, measuredKw: number, deviceLabel: string) => void;
  logger: Logger;
}): PowerEstimateResult {
  const { deviceId, deviceLabel, loadW, expectedOverride, updateLastKnownPower, logger } = params;
  const loadKw = loadW / 1000;
  updateLastKnownPower(deviceId, loadKw, deviceLabel);

  if (expectedOverride) {
    logger.debug(`Power estimate: using override (manual) for ${deviceLabel}: ${expectedOverride.kw.toFixed(3)} kW`);
    return {
      powerKw: expectedOverride.kw,
      expectedPowerKw: expectedOverride.kw,
      expectedPowerSource: 'manual',
      loadKw,
    };
  }
  logger.debug(`Power estimate: using settings.load for ${deviceLabel}: ${loadKw.toFixed(3)} kW`);
  return {
    powerKw: loadKw,
    expectedPowerKw: loadKw,
    expectedPowerSource: 'load-setting',
    loadKw,
  };
}

function getPowerFromMeasurement(params: {
  deviceId: string;
  deviceLabel: string;
  expectedOverride?: { kw: number; ts: number };
  state: Required<PowerEstimateState>;
  logger: Logger;
  resolveMeasuredPower: () => { measuredKw?: number; measuredPowerKw?: number };
}): PowerEstimateResult {
  const {
    deviceId,
    deviceLabel,
    expectedOverride,
    state,
    logger,
    resolveMeasuredPower,
  } = params;
  const measured = resolveMeasuredPower();
  const peak = state.lastKnownPowerKw[deviceId];

  if (expectedOverride) {
    return resolveOverrideEstimate({
      deviceLabel,
      expectedOverride,
      measuredKw: measured.measuredKw,
      logger,
    });
  }
  if (peak) {
    logger.debug(`Power estimate: using peak measured for ${deviceLabel}: ${peak.toFixed(3)} kW`);
    return {
      powerKw: peak,
      expectedPowerKw: peak,
      expectedPowerSource: 'measured-peak',
      measuredPowerKw: measured.measuredPowerKw,
    };
  }
  logger.debug(`Power estimate: fallback 1 kW for ${deviceLabel} (no measured/override/load)`);
  return {
    powerKw: 1,
    expectedPowerKw: undefined,
    expectedPowerSource: 'default',
    measuredPowerKw: measured.measuredPowerKw,
  };
}

function resolveOverrideEstimate(params: {
  deviceLabel: string;
  expectedOverride: { kw: number; ts: number };
  measuredKw?: number;
  logger: Logger;
}): PowerEstimateResult {
  const { deviceLabel, expectedOverride, measuredKw, logger } = params;
  const measuredValue = measuredKw ?? 0;
  if (measuredKw !== undefined && measuredValue > expectedOverride.kw) {
    logger.debug(`Power estimate: current ${measuredValue.toFixed(3)} kW > override ${expectedOverride.kw.toFixed(3)} kW for ${deviceLabel}`);
    return {
      powerKw: measuredValue,
      expectedPowerKw: measuredValue,
      expectedPowerSource: 'measured-peak',
      measuredPowerKw: measuredKw,
    };
  }
  logger.debug(`Power estimate: using override for ${deviceLabel}: ${expectedOverride.kw.toFixed(3)} kW`);
  return {
    powerKw: expectedOverride.kw,
    expectedPowerKw: expectedOverride.kw,
    expectedPowerSource: 'manual',
    measuredPowerKw: measuredKw,
  };
}
