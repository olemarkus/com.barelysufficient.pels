import { describe, expect, it } from 'vitest';
import {
  resolveObjectiveProgress,
  resolveReachableTargetValue,
} from '../../lib/objectives/deferredObjectives/diagnosticProgress';
import type { DeferredObjectiveSettingsEntry } from '../../lib/objectives/deferredObjectives/settings';
import type { ObjectiveDeviceInput, ObjectiveStateOfCharge } from '../../lib/objectives/types';
import { partialDouble } from '../helpers/partialDouble';

/**
 * An EV smart task whose car stops charging below the task's target is capped
 * at the car's own limit (owner ruling 2026-09-26): no plan can charge a car
 * that stops itself at 70 % to 80 %, so energy is sized to 70 % and the task is
 * met there. The limit is the one the device layer lends with the car's level.
 */

const evTask = partialDouble<DeferredObjectiveSettingsEntry>({ kind: 'ev_soc', targetPercent: 80 });
const heaterTask = partialDouble<DeferredObjectiveSettingsEntry>({ kind: 'temperature', targetTemperatureC: 65 });

const charger = (level: ObjectiveStateOfCharge['level']): ObjectiveDeviceInput => partialDouble<ObjectiveDeviceInput>({
  objectiveSessionInactive: false,
  stateOfCharge: { level },
});

describe('resolveReachableTargetValue', () => {
  it('caps an EV task at the car\'s own charge limit when it is lower', () => {
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
  it('sizes the remaining charge to the car\'s limit, not the task\'s target', () => {
    const progress = resolveObjectiveProgress({
      objective: evTask,
      device: charger({ kind: 'known', percent: 53, carChargeLimitPercent: 70 }),
    });
    expect(progress).toMatchObject({ remainingUnits: 17, currentPercent: 53, reasonCode: null });
  });

  it('has nothing left once the car sits at its limit', () => {
    const progress = resolveObjectiveProgress({
      objective: evTask,
      device: charger({ kind: 'known', percent: 70, carChargeLimitPercent: 70 }),
    });
    expect(progress).toMatchObject({ remainingUnits: 0, reasonCode: null });
  });
});
