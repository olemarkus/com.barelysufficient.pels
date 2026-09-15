import { describe, expect, it, vi } from 'vitest';
import { PriceLevel } from '../../lib/price/priceLevels';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';
import type { TemperatureIntentReads } from '../../lib/thermostat/temperatureSetpoints';
import type { PlanInputDevice, TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';
import { partialDouble } from '../helpers/partialDouble';

// Only the fields the resolver reads: identity, the temperature facet, the
// capability metadata, and a smart task's deadline floor.
const device = (overrides: {
  currentTarget: number;
  currentTemperature: number;
  deadlineFloorTargetC?: number;
  step?: number;
}): PlanInputDevice => partialDouble<PlanInputDevice & TemperaturePlanInputKind>({
  id: 'unit',
  deviceType: 'temperature',
  currentTarget: overrides.currentTarget,
  currentTemperature: overrides.currentTemperature,
  targets: [{ id: 'target_temperature', value: overrides.currentTarget, unit: '°C', min: 5, max: 35, step: overrides.step ?? 0.5 }],
  ...(overrides.deadlineFloorTargetC !== undefined ? { deadlineFloorTargetC: overrides.deadlineFloorTargetC } : {}),
});

const resolve = (dev: PlanInputDevice, reads: Partial<TemperatureIntentReads>) => {
  const entry = fixtureTemperatureSetpoints(reads)([dev]).get('unit');
  if (!entry) throw new Error('expected an entry for a temperature device');
  return entry;
};

const priced = (level: PriceLevel, cheapDelta: number, expensiveDelta: number): Partial<TemperatureIntentReads> => ({
  getPriceOptimizationEnabled: () => true,
  getPriceOptimizationSettings: () => ({ unit: { enabled: true, cheapDelta, expensiveDelta } }),
  getCurrentHourPriceLevel: () => level,
});

const modeTarget = (targetC: number): Partial<TemperatureIntentReads> => ({
  getModeDeviceTargets: () => ({ Home: { unit: targetC } }),
});

describe('temperature setpoints, resolved before the planner', () => {
  it('shifts the price response the way that makes the device work harder, per direction', () => {
    const heater = resolve(device({ currentTarget: 21, currentTemperature: 20 }), {
      ...modeTarget(21), ...priced(PriceLevel.CHEAP, 2, -2),
    });
    const cooler = resolve(device({ currentTarget: 22, currentTemperature: 25 }), {
      ...modeTarget(22), ...priced(PriceLevel.CHEAP, 2, -2), getThermalDirection: () => 'cooling',
    });
    expect([heater.desiredC, heater.keepC]).toEqual([23, 23]);
    expect([cooler.desiredC, cooler.keepC]).toEqual([20, 20]);
  });

  it('holds the deadline floor on the demand side of the kept setpoint, per direction', () => {
    // A heater is kept at least as warm as the floor, a cooling unit at least as cold.
    expect(resolve(device({ currentTarget: 20, currentTemperature: 19, deadlineFloorTargetC: 23 }), modeTarget(20)).keepC)
      .toBe(23);
    expect(resolve(device({ currentTarget: 25, currentTemperature: 26, deadlineFloorTargetC: 22 }), {
      ...modeTarget(25), getThermalDirection: () => 'cooling',
    }).keepC).toBe(22);
    // A floor the kept setpoint already passes changes nothing.
    expect(resolve(device({ currentTarget: 20, currentTemperature: 26, deadlineFloorTargetC: 24 }), {
      ...modeTarget(20), getThermalDirection: () => 'cooling',
    }).keepC).toBe(20);
  });

  it('lifts for surplus off the bare mode target, towards more work, and wins over an expensive hour', () => {
    const surplus = {
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({
        unit: { enabled: true, cheapDelta: 0, expensiveDelta: -3, surplusWilling: true, surplusDelta: 2 },
      }),
      getCurrentHourPriceLevel: () => PriceLevel.EXPENSIVE,
    };
    const heater = resolve(device({ currentTarget: 21, currentTemperature: 20 }), { ...modeTarget(21), ...surplus });
    const cooler = resolve(device({ currentTarget: 22, currentTemperature: 25 }), {
      ...modeTarget(22), ...surplus, getThermalDirection: () => 'cooling',
    });
    expect([heater.keepC, heater.surplusC]).toEqual([18, 23]);
    expect([cooler.keepC, cooler.surplusC]).toEqual([25, 20]);
  });

  it('carries the configured limit normalized, and says whether it releases demand from the target held now', () => {
    const limitAt = (temperature: number): Partial<TemperatureIntentReads> => ({
      getShedBehavior: () => ({ action: 'set_temperature', temperature }),
    });
    const releases = (dev: PlanInputDevice, reads: Partial<TemperatureIntentReads>) => {
      const { shed } = resolve(dev, reads);
      return shed.action === 'set_temperature' ? shed.releasesDemand : shed.action;
    };
    expect(resolve(device({ currentTarget: 21, currentTemperature: 20 }), limitAt(16.3)).shed)
      .toEqual({ action: 'set_temperature', limitC: 16.5, releasesDemand: true, asksLessThanIntended: true });
    expect(releases(device({ currentTarget: 16, currentTemperature: 20 }), limitAt(16))).toBe(false);
    expect(releases(device({ currentTarget: 14, currentTemperature: 20 }), limitAt(16))).toBe(false);
    const cooling = { getThermalDirection: () => 'cooling' as const };
    expect(releases(device({ currentTarget: 22, currentTemperature: 25 }), { ...limitAt(28), ...cooling })).toBe(true);
    expect(releases(device({ currentTarget: 22, currentTemperature: 25 }), { ...limitAt(20), ...cooling })).toBe(false);
    expect(releases(device({ currentTarget: 22, currentTemperature: 25 }), {})).toBe('turn_off');
  });

  it('says whether the kept and surplus setpoints add demand over the target held now, per direction', () => {
    // A heater parked at a 16 °C limit with a 21 °C mode target resumes by going up.
    const heaterAtLimit = resolve(device({ currentTarget: 16, currentTemperature: 17 }), modeTarget(21));
    expect([heaterAtLimit.keepAddsDemand, heaterAtLimit.surplusAddsDemand]).toEqual([true, true]);
    // A cooling unit parked at a 28 °C limit resumes by going DOWN to its 22 °C target.
    const coolerAtLimit = resolve(device({ currentTarget: 28, currentTemperature: 27 }), {
      ...modeTarget(22), getThermalDirection: () => 'cooling',
    });
    expect(coolerAtLimit.keepAddsDemand).toBe(true);
    // A cooling unit at its limit whose mode target sits above that limit asks
    // for less by leaving it: not a resume.
    const coolerAboveLimit = resolve(device({ currentTarget: 28, currentTemperature: 27 }), {
      ...modeTarget(30), getThermalDirection: () => 'cooling',
    });
    expect(coolerAboveLimit.keepAddsDemand).toBe(false);
    // A heater at its limit in an expensive hour shifted below it: not a resume either.
    const heaterShiftedBelow = resolve(device({ currentTarget: 16, currentTemperature: 17 }), {
      ...modeTarget(17), ...priced(PriceLevel.EXPENSIVE, 0, -2),
    });
    expect(heaterShiftedBelow.keepAddsDemand).toBe(false);
  });

  it('judges "held back" and "short" on the device\'s own axis', () => {
    // A cooling unit coasting at 24 against an intended 22 is held back; the room
    // at 25 is short of 22; its target at 24 is short of the desired 22.
    const cooler = resolve(device({ currentTarget: 24, currentTemperature: 25 }), {
      ...modeTarget(22), ...priced(PriceLevel.EXPENSIVE, 0, -2), getThermalDirection: () => 'cooling',
    });
    expect(cooler.keepC).toBe(24);
    expect(cooler.keepAsksLessThanIntended).toBe(true);
    expect(cooler.roomShortOfIntended).toBe(true);
    expect(resolve(device({ currentTarget: 24, currentTemperature: 25 }), {
      ...modeTarget(22), getThermalDirection: () => 'cooling',
    }).targetShortOfDesired).toBe(true);
    // The same numbers on a heater are the comfortable side.
    const heater = resolve(device({ currentTarget: 24, currentTemperature: 25 }), modeTarget(22));
    expect([heater.keepAsksLessThanIntended, heater.roomShortOfIntended, heater.targetShortOfDesired]).toEqual([false, false, false]);
  });

  it('asks for the price level once per build, and only when a device can spend it', () => {
    const getCurrentHourPriceLevel = vi.fn(() => PriceLevel.CHEAP);
    const devices = ['a', 'b', 'c'].map((id) => partialDouble<PlanInputDevice & TemperaturePlanInputKind>({
      id, deviceType: 'temperature', currentTarget: 20, currentTemperature: 19, targets: [],
    }));
    fixtureTemperatureSetpoints({
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({ b: { enabled: true, cheapDelta: 1, expensiveDelta: -1 } }),
      getCurrentHourPriceLevel,
    })(devices);
    expect(getCurrentHourPriceLevel).toHaveBeenCalledTimes(1);

    const unconfigured = vi.fn(() => PriceLevel.CHEAP);
    fixtureTemperatureSetpoints({
      getPriceOptimizationEnabled: () => true,
      getCurrentHourPriceLevel: unconfigured,
    })(devices);
    expect(unconfigured).not.toHaveBeenCalled();
  });

  it('resolves nothing for a device that is not a temperature device', () => {
    const plug = partialDouble<PlanInputDevice>({ id: 'plug', deviceType: 'onoff', targets: [] });
    expect(fixtureTemperatureSetpoints()([plug]).size).toBe(0);
  });
});
