import type { Logger } from '../utils/types';

type MeterState = {
  lastMeasuredPowerKw: Record<string, { kw: number; ts: number }>;
  lastMeterEnergyKwh: Record<string, { kwh: number; ts: number }>;
};

export type PowerMeasurementUpdates = {
  lastMeasuredPowerKw?: { kw: number; ts: number };
  lastMeterEnergyKwh?: { kwh: number; ts: number };
};

type PowerMeasurementResult = {
  measuredKw?: number;
  measuredPowerKw?: number;
  updates: PowerMeasurementUpdates;
};

export function getMeasuredPowerKw(params: {
  deviceId: string;
  deviceLabel: string;
  powerRaw: unknown;
  meterPowerRaw: unknown;
  now: number;
  minSignificantPowerW: number;
  state: MeterState;
  logger: Logger;
}): PowerMeasurementResult {
  const {
    deviceId,
    deviceLabel,
    powerRaw,
    meterPowerRaw,
    now,
    minSignificantPowerW,
    state,
    logger,
  } = params;

  const direct = resolveDirectPower({
    powerRaw,
    minSignificantPowerW,
    now,
    deviceLabel,
    logger,
  });
  if (direct) return direct;

  return resolveMeterDelta({
    deviceId,
    deviceLabel,
    meterPowerRaw,
    now,
    minSignificantPowerW,
    state,
    logger,
  });
}

const resolveDirectPower = (params: {
  powerRaw: unknown;
  minSignificantPowerW: number;
  now: number;
  deviceLabel: string;
  logger: Logger;
}): PowerMeasurementResult | null => {
  const {
    powerRaw,
    minSignificantPowerW,
    now,
    deviceLabel,
    logger,
  } = params;
  if (typeof powerRaw !== 'number' || !Number.isFinite(powerRaw)) {
    return null;
  }
  if (powerRaw === 0) {
    return { measuredKw: 0, measuredPowerKw: 0, updates: {} };
  }
  if (powerRaw > minSignificantPowerW) {
    const measuredKw = powerRaw / 1000;
    return {
      measuredKw,
      measuredPowerKw: measuredKw,
      updates: { lastMeasuredPowerKw: { kw: measuredKw, ts: now } },
    };
  }
  logger.debug(`Power estimate: ignoring low reading for ${deviceLabel}: ${powerRaw} W`);
  return null;
};

const resolveMeterDelta = (params: {
  deviceId: string;
  deviceLabel: string;
  meterPowerRaw: unknown;
  now: number;
  minSignificantPowerW: number;
  state: MeterState;
  logger: Logger;
}): PowerMeasurementResult => {
  const {
    deviceId,
    deviceLabel,
    meterPowerRaw,
    now,
    minSignificantPowerW,
    state,
    logger,
  } = params;
  if (typeof meterPowerRaw !== 'number' || !Number.isFinite(meterPowerRaw)) {
    return { updates: {} };
  }
  const previous = state.lastMeterEnergyKwh[deviceId];
  const meterUpdate = { lastMeterEnergyKwh: { kwh: meterPowerRaw, ts: now } };
  if (!previous) {
    return { updates: meterUpdate };
  }
  if (meterPowerRaw < previous.kwh) {
    logger.debug(`Power estimate: meter reset for ${deviceLabel} (prev ${previous.kwh}, now ${meterPowerRaw})`);
    return { updates: meterUpdate };
  }
  const deltaHours = (now - previous.ts) / (1000 * 60 * 60);
  if (!Number.isFinite(deltaHours) || deltaHours <= 0) {
    return { updates: meterUpdate };
  }
  const deltaKwh = meterPowerRaw - previous.kwh;
  const measuredKw = deltaKwh / deltaHours;
  if (!Number.isFinite(measuredKw)) {
    return { updates: meterUpdate };
  }
  if (measuredKw <= 0) {
    return { measuredKw: 0, measuredPowerKw: 0, updates: meterUpdate };
  }
  const measuredW = measuredKw * 1000;
  if (measuredW < minSignificantPowerW) {
    logger.debug(`Power estimate: ignoring low meter delta for ${deviceLabel}: ${measuredW.toFixed(1)} W`);
    return { updates: meterUpdate };
  }
  return {
    measuredKw,
    measuredPowerKw: measuredKw,
    updates: {
      ...meterUpdate,
      lastMeasuredPowerKw: { kw: measuredKw, ts: now },
    },
  };
};
