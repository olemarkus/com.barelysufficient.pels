import { describe, expect, it } from 'vitest';
import {
  resolveBatteryControlSurface,
  toTargetPowerCapabilityValue,
} from '../../lib/device/batteryControlWiring';
import type { HomeBatterySetpointRange } from '../../packages/contracts/src/types';
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
        rejection: 'unanswered',
      },
      range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    });
  });

  it('classifies a Sessy (no target_power options, control_strategy enum) with its own preset range', () => {
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
        // A rejected claim means its app refuses control (cloud login).
        rejection: 'app_refuses_control',
      },
      // The Sessy app's DISCHARGE (1800 W) and CHARGE (2200 W) presets, in PELS's sign.
      range: { minW: -1800, maxW: 2200, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
    });
  });

  it('keeps a range a Sessy declares over its preset range', () => {
    const surface = resolveBatteryControlSurface(
      device({ driverId: 'homey:app:nl.sessy:sessy' }),
      ['target_power', 'control_strategy'],
      capabilityMap({
        target_power: { setable: true, min: -3000, max: 3500, step: 10 },
        control_strategy: { setable: true, values: enumValues('POWER_STRATEGY_API') },
      }),
    );

    expect(surface).toMatchObject({
      kind: 'setpoint',
      range: { minW: -3000, maxW: 3500, stepW: 10, excludeMinW: 0, excludeMaxW: 0 },
    });
  });

  it('gives a battery outside the Sessy app that declares no range Homey\'s default range', () => {
    const surface = resolveBatteryControlSurface(
      device({ driverId: 'homey:app:com.marstek:venus' }),
      ['target_power', 'target_power_mode'],
      capabilityMap({
        target_power: { setable: true },
        target_power_mode: { setable: true, values: enumValues('homey', 'manual') },
      }),
    );

    expect(surface).toMatchObject({
      kind: 'setpoint',
      claim: { rejection: 'unanswered' },
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

const range = (overrides: Partial<HomeBatterySetpointRange> = {}): HomeBatterySetpointRange => ({
  minW: -2500, maxW: 2500, stepW: 1, excludeMinW: 0, excludeMaxW: 0, ...overrides,
});

describe('toTargetPowerCapabilityValue', () => {
  it.each([
    // Inside the band: to the nearer of 0 and the edge on its side.
    { setpointW: 990, range: range({ excludeMinW: -1000, excludeMaxW: 1000 }), expected: 1000 },
    { setpointW: -990, range: range({ excludeMinW: -1000, excludeMaxW: 1000 }), expected: -1000 },
    { setpointW: 300, range: range({ excludeMinW: -1000, excludeMaxW: 1000 }), expected: 0 },
    { setpointW: 500, range: range({ excludeMinW: -1000, excludeMaxW: 1000 }), expected: 0 },
    // The band is decided before the step: the edge, snapped away from zero.
    { setpointW: 140, range: range({ stepW: 100, excludeMinW: -150, excludeMaxW: 150 }), expected: 200 },
    { setpointW: -140, range: range({ stepW: 100, excludeMinW: -150, excludeMaxW: 150 }), expected: -200 },
    // A value just outside the band whose nearest step lies inside it.
    { setpointW: 125, range: range({ stepW: 100, excludeMinW: -120, excludeMaxW: 120 }), expected: 200 },
    // Half away from zero, symmetric for both signs.
    { setpointW: 250, range: range({ stepW: 100 }), expected: 300 },
    { setpointW: -250, range: range({ stepW: 100 }), expected: -300 },
    { setpointW: 249, range: range({ stepW: 100 }), expected: 200 },
    { setpointW: 40, range: range({ stepW: 100 }), expected: 0 },
    // Clamped to the declared range.
    { setpointW: 9000, range: range(), expected: 2500 },
    { setpointW: -9000, range: range(), expected: -2500 },
    // A fractional step is rounded to its own decimals, without float noise.
    { setpointW: 123.456, range: range({ stepW: 0.1 }), expected: 123.5 },
    { setpointW: 0.25, range: range({ stepW: 0.1 }), expected: 0.3 },
    { setpointW: -0.25, range: range({ stepW: 0.1 }), expected: -0.3 },
    { setpointW: 0.3, range: range({ stepW: 0.1 }), expected: 0.3 },
    { setpointW: 0, range: range({ excludeMinW: -1000, excludeMaxW: 1000 }), expected: 0 },
    // The edge is snapped onto the grid first: ±60 on a 50 W grid is ±100, so 35 is nearer 0.
    { setpointW: 35, range: range({ stepW: 50, excludeMinW: -60, excludeMaxW: 60 }), expected: 0 },
    { setpointW: -35, range: range({ stepW: 50, excludeMinW: -60, excludeMaxW: 60 }), expected: 0 },
    { setpointW: 55, range: range({ stepW: 50, excludeMinW: -60, excludeMaxW: 60 }), expected: 100 },
    // A band wider than the range leaves 0 as the only writable answer.
    { setpointW: 90, range: range({ minW: -100, maxW: 100, excludeMinW: -150, excludeMaxW: 150 }), expected: 0 },
    { setpointW: -100, range: range({ minW: -100, maxW: 100, excludeMinW: -150, excludeMaxW: 150 }), expected: 0 },
  ])('maps $setpointW W onto $range.stepW W steps and band [$range.excludeMinW, $range.excludeMaxW] as $expected', ({
    setpointW, range: setpointRange, expected,
  }) => {
    expect(toTargetPowerCapabilityValue(setpointW, setpointRange)).toBe(expected);
  });
});
