import { describe, expect, it } from 'vitest';
import {
  FALL_WINDOW_MS,
  MAX_FALLS_PER_DEVICE,
  PowerFigureChecks,
  resolveAgreeingFallKw,
  resolvePowerFigureCheck,
  type PowerFigureCheckDevice,
} from '../../lib/device/powerFigureCheck';
import type { HomeMeterFall, HomeMeterFallRepository, HomeMeterFallsByDeviceId } from '../../lib/device/homeMeterFallStore';
import type { DeviceTransportPowerState } from '../../lib/device/transport/transportTypes';
import type { ExpectedPowerSource } from '../../packages/contracts/src/types';

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const MINUTE = 60_000;

const falls = (...kws: number[]): HomeMeterFall[] => kws.map((fallKw, index) => ({
  atMs: NOW - (kws.length - index) * 60 * MINUTE, fallKw,
}));

// Five lone switch-offs of a water heater that agree at about 4.5 kW, and three
// where other load moved in the same minute (one install, 2026-11).
const HEATER_FALLS = falls(4.25, 1.8, 4.45, 4.48, 1.87, 4.5, 3.69, 4.51);
// A floor thermostat in a busy house: no group of five agrees.
const SCATTERED_FALLS = falls(1.57, 0.6, 1.12, 0.41, 1.19, 5.15);

const powerState = (overrides: Partial<DeviceTransportPowerState> = {}): DeviceTransportPowerState => ({
  expectedPowerKwOverrides: {},
  lastKnownPowerKw: {},
  ...overrides,
});

const onOff = (expectedPowerKw: number, expectedPowerSource: ExpectedPowerSource): PowerFigureCheckDevice => ({
  id: 'heater', expectedPowerKw, expectedPowerSource, isEvCharger: false, isBatteryOrSolar: false,
});

const stepped = (highestW: number): PowerFigureCheckDevice => ({
  ...onOff(1, 'measured-peak'),
  steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: '100w', planningPowerW: 100 },
    { id: `${highestW}w`, planningPowerW: highestW }] },
});

describe('resolveAgreeingFallKw', () => {
  it('takes the median of the largest group of falls that agree', () => {
    expect(resolveAgreeingFallKw(HEATER_FALLS)).toBeCloseTo(4.465, 3);
  });

  it('answers nothing when no five falls agree', () => {
    expect(resolveAgreeingFallKw(SCATTERED_FALLS)).toBeNull();
    expect(resolveAgreeingFallKw(falls(2, 2, 2, 2))).toBeNull();
  });

  it('ignores falls where the home rose', () => {
    expect(resolveAgreeingFallKw(falls(-3, -3, -3, -3, -3, 2, 2, 2, 2))).toBeNull();
  });
});

describe('resolvePowerFigureCheck', () => {
  it('names the source of an on/off device figure the home meter contradicts', () => {
    const cases: [ExpectedPowerSource, string][] = [
      ['load-setting', 'load_setting'], ['measured-peak', 'device_reading'],
      ['homey-energy', 'homey_energy'], ['default', 'default'],
    ];
    for (const [source, figure] of cases) {
      expect(resolvePowerFigureCheck(onOff(2.6, source), HEATER_FALLS, powerState(), NOW)).toEqual({
        measuredKw: expect.closeTo(4.465, 3), figureKw: 2.6, figure,
      });
    }
  });

  it('tells a typed figure from one a Flow set', () => {
    const typed = powerState({ expectedPowerKwOverrides: { heater: { kw: 2.6, ts: 1, origin: 'settings' } } });
    const byFlow = powerState({ expectedPowerKwOverrides: { heater: { kw: 2.6, ts: 1, origin: 'flow' } } });
    expect(resolvePowerFigureCheck(onOff(2.6, 'manual'), HEATER_FALLS, typed, NOW)?.figure).toBe('typed');
    expect(resolvePowerFigureCheck(onOff(2.6, 'manual'), HEATER_FALLS, byFlow, NOW)?.figure).toBe('flow');
  });

  it('stays quiet unless the home meter is both 1.5 times and 0.4 kW above the figure', () => {
    expect(resolvePowerFigureCheck(onOff(3.1, 'default'), HEATER_FALLS, powerState(), NOW)).toBeUndefined();
    const small = falls(0.95, 0.95, 0.95, 0.95, 0.95);
    expect(resolvePowerFigureCheck(onOff(0.6, 'default'), small, powerState(), NOW)).toBeUndefined();
    expect(resolvePowerFigureCheck(onOff(0.5, 'default'), small, powerState(), NOW)?.measuredKw).toBe(0.95);
    expect(resolvePowerFigureCheck(onOff(2, 'default'), SCATTERED_FALLS, powerState(), NOW)).toBeUndefined();
  });

  it('forgets falls older than the window', () => {
    const old = HEATER_FALLS.map((fall) => ({ ...fall, atMs: fall.atMs - FALL_WINDOW_MS }));
    expect(resolvePowerFigureCheck(onOff(2.6, 'default'), old, powerState(), NOW)).toBeUndefined();
  });

  it('leaves chargers and batteries out', () => {
    for (const flags of [{ isEvCharger: true }, { isBatteryOrSolar: true }]) {
      expect(resolvePowerFigureCheck({ ...onOff(2.6, 'default'), ...flags }, HEATER_FALLS, powerState(), NOW))
        .toBeUndefined();
    }
  });

  it('checks a stepped device by its own highest reading against its highest level', () => {
    const peaks = powerState({ lastKnownPowerKw: { heater: { kw: 0.9, observedAtMs: NOW - MINUTE } } });
    expect(resolvePowerFigureCheck(stepped(200), [], peaks, NOW)).toEqual({
      measuredKw: 0.9, figureKw: 0.2, figure: 'highest_level',
    });
    expect(resolvePowerFigureCheck(stepped(700), [], peaks, NOW)).toBeUndefined();
    expect(resolvePowerFigureCheck(stepped(200), HEATER_FALLS, powerState(), NOW)).toBeUndefined();
  });
});

const memoryRepository = (initial: HomeMeterFallsByDeviceId = new Map()) => {
  let stored = initial;
  const writes: HomeMeterFallsByDeviceId[] = [];
  const repository: HomeMeterFallRepository = {
    read: () => stored,
    write: (next) => { stored = next; writes.push(next); },
  };
  return { repository, writes, stored: () => stored };
};

describe('PowerFigureChecks', () => {
  it('records lone switch-offs and reads them back for the check', () => {
    const { repository, stored } = memoryRepository();
    const checks = new PowerFigureChecks(() => repository, () => powerState());
    for (const fall of HEATER_FALLS) {
      checks.recordSoleSwitchOffFall({ deviceId: 'heater', decidedAtMs: fall.atMs, fallKw: fall.fallKw });
    }
    expect(stored().get('heater')).toHaveLength(HEATER_FALLS.length);
    expect(checks.read(onOff(2.6, 'default'), NOW)?.figure).toBe('default');
    expect(checks.readAll([{ ...onOff(2.6, 'default'), name: 'VVB' }], NOW)).toEqual([
      expect.objectContaining({ deviceId: 'heater', deviceName: 'VVB', figure: 'default' }),
    ]);
  });

  it('keeps the newest falls inside the window', () => {
    const { repository, stored } = memoryRepository(new Map([['heater', [{ atMs: NOW - FALL_WINDOW_MS - 1, fallKw: 9 }]]]));
    const checks = new PowerFigureChecks(() => repository, () => powerState());
    for (let index = 0; index < MAX_FALLS_PER_DEVICE + 3; index += 1) {
      checks.recordSoleSwitchOffFall({ deviceId: 'heater', decidedAtMs: NOW + index, fallKw: index });
    }
    const kept = stored().get('heater') ?? [];
    expect(kept).toHaveLength(MAX_FALLS_PER_DEVICE);
    expect(kept[0]?.fallKw).toBe(3);
  });

  it('records nothing while the stored falls cannot be read, so no write drops them', () => {
    const { writes } = memoryRepository();
    const checks = new PowerFigureChecks(() => ({
      read: () => { throw new Error('disk'); },
      write: (next) => { writes.push(next); },
    }), () => powerState());
    checks.recordSoleSwitchOffFall({ deviceId: 'heater', decidedAtMs: NOW, fallKw: 4 });
    expect(writes).toHaveLength(0);
    expect(checks.read(onOff(2.6, 'default'), NOW)).toBeUndefined();
    expect(() => checks.readAll([{ ...onOff(2.6, 'default'), name: 'VVB' }], NOW)).toThrow();
  });
});
