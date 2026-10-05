import { describe, expect, it } from 'vitest';
import { resolveBatteryControlSurface } from '../../lib/device/batteryControlWiring';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const enumValues = (...ids: string[]) => ids.map((id) => ({ id, title: { en: id } }));

// Raw Homey `capabilitiesObj` entries carry `values` for an enum capability,
// which `DeviceCapabilityMap` does not model; the classifier reads it from the
// raw entry.
const device = (identity: Partial<HomeyDeviceLike> = {}): HomeyDeviceLike => ({
  id: 'battery-1', name: 'Battery', class: 'battery', ...identity,
});

const capabilityMap = (entries: Record<string, Record<string, unknown>>): DeviceCapabilityMap => (
  entries as DeviceCapabilityMap
);

describe('resolveBatteryControlSurface', () => {
  it('classifies a Marstek-like battery (signed ±2500 W, step 5, target_power_mode) as a setpoint', () => {
    const surface = resolveBatteryControlSurface(
      device({ driverId: 'homey:app:com.marstek:venus' }),
      ['measure_battery', 'measure_power', 'target_power', 'target_power_mode'],
      capabilityMap({
        target_power: { value: 0, setable: true, min: -2500, max: 2500, step: 5 },
        target_power_mode: {
          value: 'anti_feed',
          setable: true,
          values: enumValues('homey', 'anti_feed', 'trade_mode', 'manual'),
        },
      }),
    );

    expect(surface).toEqual({
      kind: 'setpoint',
      claim: {
        capabilityId: 'target_power_mode',
        homeyValue: 'homey',
        values: ['homey', 'anti_feed', 'trade_mode', 'manual'],
      },
      range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    });
  });

  it('classifies a Sessy (no target_power options, control_strategy enum) with Homey default range', () => {
    const surface = resolveBatteryControlSurface(
      device({ driverId: 'homey:app:nl.sessy:sessy' }),
      ['measure_battery', 'measure_power', 'target_power', 'control_strategy'],
      capabilityMap({
        target_power: { value: null, setable: true },
        control_strategy: {
          value: 'POWER_STRATEGY_NOM',
          setable: true,
          values: enumValues('POWER_STRATEGY_NOM', 'POWER_STRATEGY_API', 'POWER_STRATEGY_IDLE'),
        },
      }),
    );

    expect(surface).toEqual({
      kind: 'setpoint',
      claim: {
        capabilityId: 'control_strategy',
        homeyValue: 'POWER_STRATEGY_API',
        values: ['POWER_STRATEGY_NOM', 'POWER_STRATEGY_API', 'POWER_STRATEGY_IDLE'],
      },
      range: { minW: -25000, maxW: 25000, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
    });
  });

  it.each([
    ['owner URI', { ownerUri: 'homey:app:nl.sessy' }],
    ['driver URI', { driver: { uri: 'Homey:App:NL.Sessy' } }],
    ['bare driver id', { driverId: 'nl.sessy:sessy' }],
  ])('recognises a Sessy by its %s', (_label, identity) => {
    const surface = resolveBatteryControlSurface(
      device(identity),
      ['target_power', 'control_strategy'],
      capabilityMap({
        target_power: { setable: true },
        control_strategy: { setable: true, values: enumValues('POWER_STRATEGY_API') },
      }),
    );

    expect(surface).toMatchObject({ kind: 'setpoint', claim: { capabilityId: 'control_strategy' } });
  });

  it('does not read control_strategy as a claim on a driver outside the Sessy app', () => {
    const surface = resolveBatteryControlSurface(
      device({ driverId: 'homey:app:com.example.other:battery' }),
      ['target_power', 'control_strategy'],
      capabilityMap({
        target_power: { setable: true },
        control_strategy: { setable: true, values: enumValues('POWER_STRATEGY_API') },
      }),
    );

    expect(surface).toEqual({ kind: 'observe_only', reason: 'no_claim_capability' });
  });

  it('keeps a HomeWizard-like battery with no target_power observe-only', () => {
    const surface = resolveBatteryControlSurface(
      device(),
      ['measure_battery', 'measure_power', 'target_power_mode'],
      capabilityMap({
        target_power_mode: { value: 'device', setable: true, values: enumValues('device') },
      }),
    );

    expect(surface).toEqual({ kind: 'observe_only', reason: 'no_target_power' });
  });

  it('keeps a battery whose claim capability cannot select homey observe-only', () => {
    const surface = resolveBatteryControlSurface(
      device(),
      ['target_power', 'target_power_mode'],
      capabilityMap({
        target_power: { setable: true, min: -2000, max: 2000, step: 1 },
        target_power_mode: { setable: true, values: enumValues('device') },
      }),
    );

    expect(surface).toEqual({ kind: 'observe_only', reason: 'claim_value_missing' });
  });

  it('keeps a battery with a signed target_power but no claim capability observe-only', () => {
    const surface = resolveBatteryControlSurface(
      device(),
      ['target_power'],
      capabilityMap({ target_power: { setable: true, min: -2000, max: 2000, step: 1 } }),
    );

    expect(surface).toEqual({ kind: 'observe_only', reason: 'no_claim_capability' });
  });

  it('keeps a battery whose target_power is not setable observe-only', () => {
    const surface = resolveBatteryControlSurface(
      device(),
      ['target_power', 'target_power_mode'],
      capabilityMap({
        target_power: { setable: false, min: -2500, max: 2500, step: 5 },
        target_power_mode: { setable: true, values: enumValues('homey', 'manual') },
      }),
    );

    expect(surface).toEqual({ kind: 'observe_only', reason: 'target_power_not_setable' });
  });

  it('rejects a charge-only range (min >= 0) as not signed', () => {
    const surface = resolveBatteryControlSurface(
      device(),
      ['target_power', 'target_power_mode'],
      capabilityMap({
        target_power: { setable: true, min: 0, max: 2500, step: 5 },
        target_power_mode: { setable: true, values: enumValues('homey', 'manual') },
      }),
    );

    expect(surface).toEqual({ kind: 'observe_only', reason: 'not_signed_range' });
  });

  it.each([
    ['a non-finite max', { max: Number.POSITIVE_INFINITY }],
    ['a string step', { step: '5' }],
    ['a zero step', { step: 0 }],
    ['an exclude band that does not contain 0', { excludeMin: 100, excludeMax: 500 }],
  ])('rejects %s as not signed', (_label, junk) => {
    const surface = resolveBatteryControlSurface(
      device(),
      ['target_power', 'target_power_mode'],
      capabilityMap({
        target_power: { setable: true, min: -2500, max: 2500, step: 5, ...junk },
        target_power_mode: { setable: true, values: enumValues('homey', 'manual') },
      }),
    );

    expect(surface).toEqual({ kind: 'observe_only', reason: 'not_signed_range' });
  });

  it('carries a declared exclude band', () => {
    const surface = resolveBatteryControlSurface(
      device(),
      ['target_power', 'target_power_mode'],
      capabilityMap({
        target_power: { setable: true, min: -2500, max: 2500, step: 5, excludeMin: -100, excludeMax: 100 },
        target_power_mode: { setable: true, values: enumValues('homey', 'manual') },
      }),
    );

    expect(surface).toMatchObject({
      kind: 'setpoint',
      range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: -100, excludeMaxW: 100 },
    });
  });
});
