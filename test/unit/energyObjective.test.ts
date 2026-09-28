import { describe, expect, it } from 'vitest';
import {
  resolveObjectiveProgress,
  resolveReachableTargetValue,
} from '../../lib/objectives/deferredObjectives/diagnosticProgress';
import { resolveProfileEnergy } from '../../lib/objectives/deferredObjectives/profileEnergyResolution';
import {
  buildObjectiveSignature,
  buildObjectiveSignatureForEntry,
  compareObjectiveSignatures,
} from '../../lib/objectives/deferredObjectives/activePlanSignature';
import { normalizeDeferredObjectiveSettingsEntry } from '../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { resolveObjectiveTargetValue } from '../../packages/shared-domain/src/deferredObjectiveValues';
import type { DeferredObjectiveEnergySettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { partialDouble } from '../helpers/partialDouble';

// "Feed this device N kWh by the deadline": progress is the energy fed since the
// task started, handed in by the delivery tracker; the rate is exact.

const DEADLINE_MS = 1_800_000_000_000;

const energyTask: DeferredObjectiveEnergySettingsEntry = {
  enabled: true,
  kind: 'energy',
  enforcement: 'soft',
  targetEnergyKWh: 16,
  deadlineAtMs: DEADLINE_MS,
};

const relay = (overrides: Partial<ObjectiveDeviceInput> = {}): ObjectiveDeviceInput => partialDouble<ObjectiveDeviceInput>({
  id: 'relay',
  objectiveSessionInactive: false,
  ...overrides,
});

describe('energy task progress', () => {
  it('counts the energy still owed from the energy fed so far', () => {
    const readDelivered = (deviceId: string, deadlineAtMs: number): number => (
      deviceId === 'relay' && deadlineAtMs === DEADLINE_MS ? 6.5 : 0
    );
    expect(resolveObjectiveProgress(energyTask, relay(), readDelivered)).toEqual({
      remainingUnits: 9.5,
      progressDirection: 'increasing',
      currentValue: 6.5,
      reasonCode: null,
    });
  });

  it('owes nothing once the target is fed, and never a negative amount', () => {
    expect(resolveObjectiveProgress(energyTask, relay(), () => 17)).toMatchObject({
      remainingUnits: 0,
      currentValue: 17,
      reasonCode: null,
    });
  });

  it('reads no level off the device: a device with no temperature or charge still makes progress', () => {
    const bare = relay({ currentTemperature: undefined, stateOfCharge: undefined });
    expect(resolveObjectiveProgress(energyTask, bare, () => 0)).toMatchObject({
      remainingUnits: 16,
      reasonCode: null,
    });
  });

  it('pauses on a charger with no session, as a battery-level task does', () => {
    expect(resolveObjectiveProgress(energyTask, relay({ objectiveSessionInactive: true }), () => 3)).toEqual({
      remainingUnits: 0,
      progressDirection: 'increasing',
      currentValue: 3,
      reasonCode: 'objective_invalid_session',
    });
  });

  it('reaches its own target', () => {
    expect(resolveReachableTargetValue(energyTask, relay())).toBe(16);
    expect(resolveObjectiveTargetValue(energyTask)).toBe(16);
  });
});

describe('energy task rate', () => {
  it('is exact, whatever the device has learned per °C or per %', () => {
    const tracker: PowerTrackerState = {
      objectiveProfiles: {
        relay: {
          updatedAtMs: 0,
          lastSample: { observedAtMs: 0, value: 50 },
          acceptedSamples: 20,
          rejectedSamples: 0,
          kwhPerUnit: {
            mean: 0.23, m2: 0, min: 0.23, max: 0.23, sampleCount: 20, confidence: 'high', lastUpdatedMs: 0,
          },
        },
      },
    };
    expect(resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'relay',
      objectiveKind: 'energy',
      enforcement: 'soft',
      remainingUnits: 9.5,
      progressDirection: 'increasing',
    })).toEqual({
      energyNeededKWh: 9.5,
      energyExpectedKWh: 9.5,
      kWhPerUnit: 1,
      kWhPerUnitBuffered: 1,
      kWhPerUnitMean: null,
      rateConfidence: null,
      displayConfidence: 'high',
      kwhPerUnitSource: 'exact',
      reasonCode: null,
    });
  });
});

describe('energy task signature', () => {
  it('carries the kWh target, so a target edit is an objective change', () => {
    const at16 = buildObjectiveSignatureForEntry(energyTask, 'increasing');
    const at20 = buildObjectiveSignatureForEntry({ ...energyTask, targetEnergyKWh: 20 }, 'increasing');
    expect(at16).not.toBe(at20);
    expect(JSON.parse(at16)).toEqual(['energy', null, null, DEADLINE_MS, 'soft', 'increasing', 16]);
    expect(compareObjectiveSignatures(at16, at20)).toEqual({ changed: true, directionOnly: false, rescueOnly: false });
    // A rescue toggle alone still reads as a rescue change on an energy task.
    const withRescue = buildObjectiveSignatureForEntry({ ...energyTask, rescue: { exemptFromBudget: 'always' } }, 'increasing');
    expect(compareObjectiveSignatures(at16, withRescue)).toEqual({ changed: true, directionOnly: false, rescueOnly: true });
  });

  it("leaves every other kind's shipped signature unchanged", () => {
    expect(buildObjectiveSignature({
      objectiveKind: 'temperature',
      targetValue: 65,
      deadlineAtMs: DEADLINE_MS,
      enforcement: 'soft',
      progressDirection: 'increasing',
    })).toBe(JSON.stringify(['temperature', 65, null, DEADLINE_MS, 'soft', 'increasing']));
    expect(buildObjectiveSignature({
      objectiveKind: 'ev_soc',
      targetValue: 80,
      deadlineAtMs: DEADLINE_MS,
      enforcement: 'hard',
      progressDirection: 'increasing',
    })).toBe(JSON.stringify(['ev_soc', null, 80, DEADLINE_MS, 'hard', 'increasing']));
  });
});

describe('energy task settings', () => {
  it('keeps a valid entry, rescue permission included', () => {
    expect(normalizeDeferredObjectiveSettingsEntry({ ...energyTask, rescue: { exemptFromBudget: 'always' } }))
      .toEqual({ ...energyTask, rescue: { exemptFromBudget: 'always' } });
  });

  it.each([
    ['a zero target', { targetEnergyKWh: 0 }],
    ["a target past the card's ceiling", { targetEnergyKWh: 250 }],
    ['a non-finite target', { targetEnergyKWh: Number.NaN }],
    ['a hard enforcement', { enforcement: 'hard' }],
  ])('drops an entry with %s', (_label, overrides) => {
    expect(normalizeDeferredObjectiveSettingsEntry({ ...energyTask, ...overrides })).toBeNull();
  });
});
