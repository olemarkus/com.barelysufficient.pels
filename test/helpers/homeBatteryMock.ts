import { MockDevice } from '../mocks/homey';

export const MARSTEK_CLAIM_VALUES = ['homey', 'anti_feed', 'trade_mode', 'manual'] as const;

/**
 * A Marstek-like home battery at the SDK boundary: Homey's signed
 * `target_power` (W, negative discharges) taken over through
 * `target_power_mode` = `homey`. Every value is dated, as Homey dates them.
 */
export const buildSetpointBatteryDevice = (params: {
  id: string;
  claimValue: string;
  targetPowerW?: number;
  stepW?: number;
  excludeW?: number;
}): MockDevice => {
  const device = new MockDevice(
    params.id,
    'Marstek Venus',
    ['measure_battery', 'measure_power', 'target_power', 'target_power_mode'],
    'battery',
  );
  device.setDriverIdentity({ driverId: 'homey:app:com.marstek:venus' });
  device.setCapabilityMetadata('target_power', {
    setable: true,
    min: -2500,
    max: 2500,
    step: params.stepW ?? 1,
    units: 'W',
    ...(params.excludeW !== undefined ? { excludeMin: -params.excludeW, excludeMax: params.excludeW } : {}),
  });
  device.setCapabilityMetadata('target_power_mode', {
    setable: true,
    values: MARSTEK_CLAIM_VALUES.map((id) => ({ id })),
  });
  const quiet = { emitCapabilityEvent: false, emitDeviceUpdate: false };
  device.setActualCapabilityValue('measure_battery', 55, quiet);
  device.setActualCapabilityValue('measure_power', params.targetPowerW ?? 0, quiet);
  device.setActualCapabilityValue('target_power', params.targetPowerW ?? 0, quiet);
  device.setActualCapabilityValue('target_power_mode', params.claimValue, quiet);
  return device;
};

export const SESSY_CONTROL_STRATEGIES = [
  'POWER_STRATEGY_API', 'POWER_STRATEGY_NOM', 'POWER_STRATEGY_ROI', 'POWER_STRATEGY_ECO',
  'POWER_STRATEGY_SESSY_CONNECT', 'POWER_STRATEGY_IDLE',
] as const;

/**
 * A Sessy at the SDK boundary, as nl.sessy declares it: `target_power` with no
 * min, max or step, taken over through `control_strategy` =
 * `POWER_STRATEGY_API`.
 */
export const buildSessyBatteryDevice = (params: { id: string; strategy: string }): MockDevice => {
  const device = new MockDevice(
    params.id,
    'Sessy',
    ['measure_battery', 'measure_power', 'target_power', 'control_strategy'],
    'battery',
  );
  device.setDriverIdentity({ driverId: 'homey:app:nl.sessy:sessy' });
  device.setCapabilityMetadata('target_power', { setable: true, units: 'W' });
  device.setCapabilityMetadata('control_strategy', {
    setable: true,
    values: SESSY_CONTROL_STRATEGIES.map((id) => ({ id })),
  });
  const quiet = { emitCapabilityEvent: false, emitDeviceUpdate: false };
  device.setActualCapabilityValue('measure_battery', 55, quiet);
  device.setActualCapabilityValue('measure_power', 0, quiet);
  device.setActualCapabilityValue('target_power', 0, quiet);
  device.setActualCapabilityValue('control_strategy', params.strategy, quiet);
  return device;
};
