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

export const ANKER_SOLIX_MODES = [
  'homey', 'self_consumption', 'tou_mode', 'custom_mode', 'smart_mode', 'dynamic_pricing',
] as const;

/**
 * An Anker SOLIX at the SDK boundary, as com.anker.solix 1.1.0 declares it:
 * its own `target_power` where a positive value DISCHARGES (±10000 W, step
 * 100), taken over through `target_power_mode` = `homey`. Its `measure_power`
 * is Homey's sign, positive charging.
 */
export const buildAnkerSolixBatteryDevice = (params: { id: string; mode: string; measurePowerW?: number }): MockDevice => {
  const device = new MockDevice(
    params.id,
    'Anker SOLIX',
    ['measure_battery', 'measure_power', 'target_power', 'target_power_mode'],
    'battery',
  );
  device.setDriverIdentity({ driverId: 'homey:app:com.anker.solix:battery' });
  device.setCapabilityMetadata('target_power', { setable: true, min: -10000, max: 10000, step: 100, units: 'W' });
  device.setCapabilityMetadata('target_power_mode', {
    setable: true,
    values: ANKER_SOLIX_MODES.map((id) => ({ id })),
  });
  const quiet = { emitCapabilityEvent: false, emitDeviceUpdate: false };
  device.setActualCapabilityValue('measure_battery', 55, quiet);
  device.setActualCapabilityValue('measure_power', params.measurePowerW ?? 0, quiet);
  device.setActualCapabilityValue('target_power', 0, quiet);
  device.setActualCapabilityValue('target_power_mode', params.mode, quiet);
  return device;
};

export const ZINVOLT_MODES = ['homey', 'INACTIVE', 'SELF_USE', 'DYNAMIC', 'FEED'] as const;

/**
 * A Zinvolt at the SDK boundary, as com.zinvolt 1.1.0 declares its `power`
 * driver: Homey's signed `target_power` (-800..2000 W, step 10) taken over
 * through `target_power_mode` = `homey`. The app maps an exact 0 W setpoint
 * onto its own `INACTIVE` mode; a spec emulates that echo where it matters.
 */
export const buildZinvoltBatteryDevice = (params: { id: string; mode: string }): MockDevice => {
  const device = new MockDevice(
    params.id,
    'Zinvolt',
    ['measure_battery', 'measure_power', 'target_power', 'target_power_mode'],
    'battery',
  );
  device.setDriverIdentity({ driverId: 'homey:app:com.zinvolt:power' });
  device.setCapabilityMetadata('target_power', { setable: true, min: -800, max: 2000, step: 10, units: 'W' });
  device.setCapabilityMetadata('target_power_mode', {
    setable: true,
    values: ZINVOLT_MODES.map((id) => ({ id })),
  });
  const quiet = { emitCapabilityEvent: false, emitDeviceUpdate: false };
  device.setActualCapabilityValue('measure_battery', 55, quiet);
  device.setActualCapabilityValue('measure_power', 0, quiet);
  device.setActualCapabilityValue('target_power', 0, quiet);
  device.setActualCapabilityValue('target_power_mode', params.mode, quiet);
  return device;
};
