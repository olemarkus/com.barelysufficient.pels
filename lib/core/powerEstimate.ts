import { roundLogValue, shouldEmitOnChange } from '../logging/logDedupe';
import type { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import { getMeasuredPowerKw, type PowerMeasurementUpdates } from './powerMeasurement';

export type PowerEstimateState = {
  expectedPowerKwOverrides?: Record<string, { kw: number; ts: number }>;
  lastKnownPowerKw?: Record<string, number>;
  lastMeasuredPowerKw?: Record<string, { kw: number; ts: number }>;
  lastMeterEnergyKwh?: Record<string, { kwh: number; ts: number }>;
  lastEstimateDecisionLogByDevice?: Map<string, { signature: string; emittedAt: number }>;
  lastPeakPowerLogByDevice?: Map<string, { signature: string; emittedAt: number }>;
};

export type PowerEstimateResult = {
  powerKw?: number;
  expectedPowerKw?: number;
  expectedPowerSource?: TargetDeviceSnapshot['expectedPowerSource'];
  measuredPowerKw?: number;
  loadKw?: number;
  hasEnergyEstimate?: boolean;
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
  const energyEstimateW = getHomeyEnergyEstimateWatts(device);
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

  const result = loadW !== null
    ? (() => {
      const measured = resolveMeasuredPower();
      return {
        ...getPowerFromLoad({
          deviceId,
          deviceLabel,
          loadW,
          expectedOverride,
          updateLastKnownPower,
        }),
        measuredPowerKw: measured.measuredPowerKw,
      };
    })()
    : getPowerFromMeasurement({
      deviceId,
      expectedOverride,
      energyEstimateW,
      state,
      resolveMeasuredPower,
    });

  emitEstimateDecisionLog({
    deviceId,
    deviceLabel,
    expectedOverride,
    result,
    state,
    logger,
    now,
  });
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveCurrentOnState(device: HomeyDeviceLike): boolean | null {
  const raw = device.capabilitiesObj?.onoff?.value;
  return typeof raw === 'boolean' ? raw : null;
}

function resolveEnergyContainer(device: HomeyDeviceLike): Record<string, unknown> | null {
  if (isRecord(device.energyObj)) return device.energyObj;
  if (isRecord(device.energy)) return device.energy;
  return null;
}

function resolveSettingsEnergyWatts(device: HomeyDeviceLike): number | null {
  const settings = isRecord(device.settings) ? device.settings : null;
  if (!settings) return null;

  const usageOnW = toFiniteNumber(settings.energy_value_on);
  const usageOffW = toFiniteNumber(settings.energy_value_off);

  if (usageOnW !== null && usageOffW !== null) {
    const controllableDeltaW = Math.max(0, usageOnW - usageOffW);
    if (controllableDeltaW > 0) return controllableDeltaW;
  }

  if (usageOnW !== null && usageOnW > 0) return usageOnW;
  return null;
}

function resolveApproximationWatts(energy: Record<string, unknown>): number | null {
  const approx = isRecord(energy.approximation) ? energy.approximation : null;
  if (!approx) return null;

  const usageOnW = toFiniteNumber(approx.usageOn);
  const usageOffW = toFiniteNumber(approx.usageOff);

  if (usageOnW !== null && usageOffW !== null) {
    const controllableDeltaW = Math.max(0, usageOnW - usageOffW);
    if (controllableDeltaW > 0) return controllableDeltaW;
  }

  if (usageOnW !== null && usageOnW > 0) return usageOnW;
  return null;
}

function resolveEnergyWattFallback(
  energy: Record<string, unknown>,
  currentOn: boolean | null,
): number | null {
  const energyW = toFiniteNumber(energy.W);
  if (energyW === null || energyW <= 0 || currentOn === false) return null;
  return energyW;
}

function getHomeyEnergyEstimateWatts(device: HomeyDeviceLike): number | null {
  const settingsEnergyW = resolveSettingsEnergyWatts(device);
  if (settingsEnergyW !== null) return settingsEnergyW;

  const energy = resolveEnergyContainer(device);
  if (!energy) return null;

  const approximationW = resolveApproximationWatts(energy);
  if (approximationW !== null) return approximationW;

  return resolveEnergyWattFallback(energy, resolveCurrentOnState(device));
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
}): PowerEstimateResult {
  const { deviceId, deviceLabel, loadW, expectedOverride, updateLastKnownPower } = params;
  const loadKw = loadW / 1000;
  updateLastKnownPower(deviceId, loadKw, deviceLabel);

  if (expectedOverride) {
    return {
      powerKw: expectedOverride.kw,
      expectedPowerKw: expectedOverride.kw,
      expectedPowerSource: 'manual',
      loadKw,
    };
  }
  return {
    powerKw: loadKw,
    expectedPowerKw: loadKw,
    expectedPowerSource: 'load-setting',
    loadKw,
  };
}

function getPowerFromMeasurement(params: {
  deviceId: string;
  expectedOverride?: { kw: number; ts: number };
  energyEstimateW: number | null;
  state: Required<PowerEstimateState>;
  resolveMeasuredPower: () => { measuredKw?: number; measuredPowerKw?: number };
}): PowerEstimateResult {
  const {
    deviceId,
    expectedOverride,
    energyEstimateW,
    state,
    resolveMeasuredPower,
  } = params;
  const measured = resolveMeasuredPower();
  const peak = state.lastKnownPowerKw[deviceId];

  if (expectedOverride) {
    return resolveOverrideEstimate({
      expectedOverride,
      measuredKw: measured.measuredKw,
    });
  }
  if (peak) {
    return {
      powerKw: peak,
      expectedPowerKw: peak,
      expectedPowerSource: 'measured-peak',
      measuredPowerKw: measured.measuredPowerKw,
    };
  }
  if (energyEstimateW !== null) {
    const energyEstimateKw = energyEstimateW / 1000;
    return {
      powerKw: energyEstimateKw,
      expectedPowerKw: energyEstimateKw,
      expectedPowerSource: 'homey-energy',
      measuredPowerKw: measured.measuredPowerKw,
      hasEnergyEstimate: true,
    };
  }
  return {
    powerKw: 1,
    expectedPowerKw: undefined,
    expectedPowerSource: 'default',
    measuredPowerKw: measured.measuredPowerKw,
  };
}

function resolveOverrideEstimate(params: {
  expectedOverride: { kw: number; ts: number };
  measuredKw?: number;
}): PowerEstimateResult {
  const { expectedOverride, measuredKw } = params;
  const measuredValue = measuredKw ?? 0;
  if (measuredKw !== undefined && measuredValue > expectedOverride.kw) {
    return {
      powerKw: measuredValue,
      expectedPowerKw: measuredValue,
      expectedPowerSource: 'measured-peak',
      measuredPowerKw: measuredKw,
    };
  }
  return {
    powerKw: expectedOverride.kw,
    expectedPowerKw: expectedOverride.kw,
    expectedPowerSource: 'manual',
    measuredPowerKw: measuredKw,
  };
}

function emitEstimateDecisionLog(params: {
  deviceId: string;
  deviceLabel: string;
  expectedOverride?: { kw: number; ts: number };
  result: PowerEstimateResult;
  state: Required<PowerEstimateState>;
  logger: Logger;
  now: number;
}): void {
  const {
    deviceId,
    deviceLabel,
    expectedOverride,
    result,
    state,
    logger,
    now,
  } = params;
  const source = result.expectedPowerSource ?? null;
  const estimatedKw = typeof result.powerKw === 'number'
    ? roundLogValue(result.powerKw, 2)
    : typeof result.expectedPowerKw === 'number'
      ? roundLogValue(result.expectedPowerKw, 2)
      : null;
  const measuredPowerKw = typeof result.measuredPowerKw === 'number'
    ? roundLogValue(result.measuredPowerKw, 2)
    : null;
  const loadKw = typeof result.loadKw === 'number' ? roundLogValue(result.loadKw, 2) : null;
  const peakMeasuredKw = source === 'measured-peak' && typeof state.lastKnownPowerKw[deviceId] === 'number'
    ? roundLogValue(state.lastKnownPowerKw[deviceId], 2)
    : null;
  const fallbackReason = source === 'default'
    ? 'default_1kw'
    : source === 'measured-peak' && expectedOverride !== undefined
      ? 'override_exceeded'
      : null;
  const signature = JSON.stringify({
    source,
    estimatedKw,
    measuredPowerKw,
    loadKw,
    peakMeasuredKw,
    fallbackReason,
    hasEnergyEstimate: result.hasEnergyEstimate === true,
  });
  if (!shouldEmitOnChange({
    state: state.lastEstimateDecisionLogByDevice,
    key: deviceId,
    signature,
    now,
  })) {
    return;
  }
  logger.structuredLog?.debug({
    event: 'power_estimate_source_changed',
    deviceId,
    deviceName: deviceLabel,
    source,
    estimatedKw: estimatedKw ?? undefined,
    measuredPowerKw: measuredPowerKw ?? undefined,
    loadKw: loadKw ?? undefined,
    peakMeasuredKw: peakMeasuredKw ?? undefined,
    fallbackReason: fallbackReason ?? undefined,
    hasEnergyEstimate: result.hasEnergyEstimate === true ? true : undefined,
  });
}
