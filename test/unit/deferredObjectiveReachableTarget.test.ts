import { describe, expect, it } from 'vitest';
import {
  resolveObjectiveProgress,
  resolveReachableTargetValue,
} from '../../lib/objectives/deferredObjectives/diagnosticProgress';
import type { DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import type { ObjectiveDeviceInput, ObjectiveStateOfCharge } from '../../lib/objectives/types';
import { partialDouble } from '../helpers/partialDouble';
import { resolveProgressEnergy } from '../../lib/objectives/deferredObjectives/diagnosticFields';
import type { PowerTrackerState } from '../../lib/power/tracker';

const evTask = partialDouble<DeferredObjectiveSettingsEntry>({ kind: 'ev_soc', targetPercent: 80, enforcement: 'soft' });
const heaterTask = partialDouble<DeferredObjectiveSettingsEntry>({ kind: 'temperature', targetTemperatureC: 65 });
const coolingTask = partialDouble<DeferredObjectiveSettingsEntry>({ kind: 'temperature', targetTemperatureC: 22 });

const charger = (level: ObjectiveStateOfCharge['level']): ObjectiveDeviceInput => partialDouble<ObjectiveDeviceInput>({
  objectiveSessionInactive: false,
  thermalDirection: 'heating',
  stateOfCharge: { level },
});

const thermostat = (
  currentTemperature: number,
  thermalDirection: 'heating' | 'cooling',
): ObjectiveDeviceInput => partialDouble<ObjectiveDeviceInput>({
  id: 'thermostat',
  name: 'Thermostat',
  objectiveSessionInactive: false,
  expectedPowerKw: 1,
  currentDrawKw: 1,
  currentTemperature,
  thermalDirection,
});

describe('resolveReachableTargetValue', () => {
  it('reports a lower car ceiling separately from the requested task target', () => {
    expect(resolveReachableTargetValue(evTask, charger({ kind: 'known', percent: 60, carChargeLimitPercent: 70 })))
      .toBe(70);
  });

  it('keeps the owner\'s target when the car stops above it, or no limit is known', () => {
    expect(resolveReachableTargetValue(evTask, charger({ kind: 'known', percent: 60, carChargeLimitPercent: 90 })))
      .toBe(80);
    expect(resolveReachableTargetValue(evTask, charger({ kind: 'known', percent: 60 }))).toBe(80);
    expect(resolveReachableTargetValue(evTask, charger({ kind: 'unavailable', reasonCode: 'not_connected' })))
      .toBe(80);
    expect(resolveReachableTargetValue(evTask, undefined)).toBe(80);
  });

  it('leaves a temperature task at its target', () => {
    expect(resolveReachableTargetValue(heaterTask, undefined)).toBe(65);
  });
});

describe('resolveObjectiveProgress under a car limit', () => {
  it('keeps the requested charge obligation despite a lower car limit', () => {
    const progress = resolveObjectiveProgress(evTask, charger({ kind: 'known', percent: 53, carChargeLimitPercent: 70 }), () => 0);
    expect(progress).toMatchObject({ remainingUnits: 27, currentValue: 53, reasonCode: null });
  });

  it('sizes the full 80% requested obligation even when the reported car limit is 70%', () => {
    const progress = resolveObjectiveProgress(
      evTask, charger({ kind: 'known', percent: 0, carChargeLimitPercent: 70 }), () => 0,
    );
    expect(progress.reasonCode).toBeNull();
    if (progress.reasonCode !== null) throw new Error('Expected trusted EV progress');
    const energy = resolveProgressEnergy({
      powerTracker: partialDouble<PowerTrackerState>({ objectiveProfiles: {} }),
      deviceId: 'ev', objective: evTask, remainingUnits: progress.remainingUnits, progress,
    });
    expect(progress.remainingUnits).toBe(80);
    expect(energy.energyNeededKWh).toBe(80);
    expect(energy.energyExpectedKWh).toBe(80);
  });

  it('remains unmet once the car sits at its lower limit', () => {
    const progress = resolveObjectiveProgress(evTask, charger({ kind: 'known', percent: 70, carChargeLimitPercent: 70 }), () => 0);
    expect(progress).toMatchObject({ remainingUnits: 10, reasonCode: null });
  });
});

describe('resolveObjectiveProgress for temperature tasks', () => {
  it('measures cooling shortfall above the target', () => {
    expect(resolveObjectiveProgress(coolingTask, thermostat(26, 'cooling'), () => 0)).toMatchObject({ remainingUnits: 4, currentValue: 26, reasonCode: null });
  });

  it('treats cooling below the target as complete', () => {
    expect(resolveObjectiveProgress(coolingTask, thermostat(19, 'cooling'), () => 0)).toMatchObject({ remainingUnits: 0, currentValue: 19, reasonCode: null });
  });

  it('keeps heating shortfall below the target', () => {
    expect(resolveObjectiveProgress(coolingTask, thermostat(18, 'heating'), () => 0)).toMatchObject({ remainingUnits: 4, currentValue: 18, reasonCode: null });
  });
});
