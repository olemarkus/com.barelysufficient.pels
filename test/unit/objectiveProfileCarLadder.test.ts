import type { ObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';
import { withResolvedCurrentDraw } from '../utils/objectiveSampleDevice';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { updateObjectiveProfilesFromSnapshot } from '../../lib/objectives/profiles';
import {
  CAR_OBJECTIVE_PROFILE_MAX_CARS,
  CAR_OBJECTIVE_PROFILE_MAX_CHARGERS_PER_CAR,
  CAR_OBJECTIVE_PROFILE_RETENTION_MS,
  pruneCarObjectiveProfiles,
  type CarObjectiveProfiles,
} from '../../lib/objectives/carProfiles';
import { resolveObjectiveProfileSubject } from '../../lib/objectives/profileLadder';
import {
  MIN_CAR_RATE_SAMPLES_OVER_CHARGER,
  resolveProfileEnergy,
} from '../../lib/objectives/deferredObjectives/profileEnergyResolution';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../packages/shared-domain/src/objectiveProfileBootstrap';
import type { DeviceObjectiveProfile, ObjectiveDeviceInput } from '../../lib/objectives/types';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type {
  MeasuredPowerObservedProbe,
  StateOfChargeObservedProbe,
  TargetDeviceSnapshot,
  ThermalDirection,
} from '../../packages/contracts/src/types';
import { partialDouble } from '../helpers/partialDouble';

// Per-car learning of kWh per percent: a level read off an associated car feeds
// that car's profile on the charger; a level that arrived on the charger device
// feeds the charger's own profile. The lookup walks (car, charger) → (car, any
// charger) → (charger) → bootstrap.

const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 60 * 60 * 1000;

const charger = (params: {
  deviceId: string;
  percent: number;
  atMs: number;
  measuredPowerKw: number;
  carId?: string;
}): TargetDeviceSnapshot & StateOfChargeObservedProbe & MeasuredPowerObservedProbe & {
  currentDrawKw: number;
  observedQuantity: ObjectiveObservedQuantity;
  thermalDirection: ThermalDirection;
} => withResolvedCurrentDraw({
  available: true,
  id: params.deviceId,
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: params.deviceId,
  targets: [],
  deviceClass: 'evcharger',
  deviceType: 'onoff',
  isEvCharger: true,
  isBatteryOrSolar: false,
  binaryControllable: true,
  managed: true,
  binaryControl: { on: true },
  measuredPowerKw: params.measuredPowerKw,
  stateOfCharge: stateOfChargeFixture({
    percent: params.percent,
    observedAtMs: params.atMs,
    ...(params.carId === undefined ? {} : { carId: params.carId }),
  }),
});

/**
 * Charges `sessions` hourly windows of 10 % each at `powerKw`, so every accepted
 * window learns `powerKw / 10` kWh per percent.
 */
const chargeHourly = (state: PowerTrackerState, params: {
  deviceId: string;
  carId?: string;
  powerKw: number;
  windows: number;
  fromMs: number;
}): PowerTrackerState => {
  let next = state;
  for (let index = 0; index <= params.windows; index += 1) {
    next = updateObjectiveProfilesFromSnapshot(next, [charger({
      deviceId: params.deviceId,
      percent: 20 + index * 10,
      atMs: params.fromMs + index * hourMs,
      measuredPowerKw: params.powerKw,
      ...(params.carId === undefined ? {} : { carId: params.carId }),
    })], params.fromMs + index * hourMs, undefined);
  }
  return next;
};

const resolveRate = (state: PowerTrackerState, deviceId: string, carId: string | null) => {
  const result = resolveProfileEnergy(state, { deviceId, carId }, 'ev_soc', 'soft', 10, 'increasing', 40);
  if (result.reasonCode !== null) throw new Error('expected an EV rate');
  return result;
};

describe('per-car objective profiles', () => {
  describe('learning', () => {
    it('feeds a car-sourced level into that car on this charger, never the charger itself', () => {
      const state = chargeHourly({}, { deviceId: 'garage', carId: 'car-a', powerKw: 7, windows: 2, fromMs: startMs });

      expect(state.objectiveProfiles?.garage).toBeUndefined();
      const profile = state.carObjectiveProfiles?.['car-a']?.garage;
      expect(profile?.kwhPerUnit?.sampleCount).toBe(2);
      expect(profile?.kwhPerUnit?.mean).toBeCloseTo(0.7, 6);
    });

    it('feeds a level that arrived on the charger device into the charger profile', () => {
      const state = chargeHourly({}, { deviceId: 'garage', powerKw: 7, windows: 2, fromMs: startMs });

      expect(state.carObjectiveProfiles).toBeUndefined();
      expect(state.objectiveProfiles?.garage?.kwhPerUnit?.mean).toBeCloseTo(0.7, 6);
    });

    it('keeps two cars on one charger apart', () => {
      let state = chargeHourly({}, { deviceId: 'garage', carId: 'small', powerKw: 4, windows: 3, fromMs: startMs });
      state = chargeHourly(state, {
        deviceId: 'garage', carId: 'large', powerKw: 11, windows: 3, fromMs: startMs + 10 * hourMs,
      });

      expect(state.carObjectiveProfiles?.small?.garage?.kwhPerUnit?.mean).toBeCloseTo(0.4, 6);
      expect(state.carObjectiveProfiles?.large?.garage?.kwhPerUnit?.mean).toBeCloseTo(1.1, 6);
      expect(resolveRate(state, 'garage', 'small').kWhPerUnit).toBeCloseTo(0.4, 6);
      expect(resolveRate(state, 'garage', 'large').kWhPerUnit).toBeCloseTo(1.1, 6);
    });

    it('keeps the charger profile, learned before per-car learning, while car-sourced samples flow', () => {
      // The upgrade: the persisted per-device profile is left where it is and
      // becomes the charger rung. A car-sourced sample does not touch it, and
      // the charger still reporting a level keeps it from being pruned.
      let state = chargeHourly({}, { deviceId: 'garage', powerKw: 9, windows: 3, fromMs: startMs });
      const migrated = state.objectiveProfiles?.garage;
      state = chargeHourly(state, {
        deviceId: 'garage',
        carId: 'car-a',
        powerKw: 7,
        windows: 1,
        fromMs: startMs + 40 * 24 * hourMs,
      });

      expect(state.objectiveProfiles?.garage).toBe(migrated);
    });
  });

  describe('lookup ladder', () => {
    it('prefers this car on this charger once it has enough evidence', () => {
      let state = chargeHourly({}, { deviceId: 'garage', powerKw: 9, windows: 4, fromMs: startMs });
      state = chargeHourly(state, {
        deviceId: 'garage',
        carId: 'car-a',
        powerKw: 6,
        windows: MIN_CAR_RATE_SAMPLES_OVER_CHARGER,
        fromMs: startMs + 10 * hourMs,
      });

      expect(resolveRate(state, 'garage', 'car-a').kWhPerUnit).toBeCloseTo(0.6, 6);
    });

    it('stays on the charger rate while the car rate rests on fewer windows', () => {
      let state = chargeHourly({}, { deviceId: 'garage', powerKw: 9, windows: 4, fromMs: startMs });
      state = chargeHourly(state, {
        deviceId: 'garage',
        carId: 'car-a',
        powerKw: 6,
        windows: MIN_CAR_RATE_SAMPLES_OVER_CHARGER - 1,
        fromMs: startMs + 10 * hourMs,
      });

      expect(resolveRate(state, 'garage', 'car-a').kWhPerUnit).toBeCloseTo(0.9, 6);
    });

    it('uses a thin car rate over the bootstrap when nothing else has learned', () => {
      const state = chargeHourly({}, { deviceId: 'garage', carId: 'car-a', powerKw: 6, windows: 1, fromMs: startMs });

      const result = resolveRate(state, 'garage', 'car-a');
      expect(result.kwhPerUnitSource).toBe('learned');
      expect(result.kWhPerUnit).toBeCloseTo(0.6, 6);
    });

    it('sizes a car on a new charger from its rate on the others', () => {
      let state = chargeHourly({}, { deviceId: 'cabin', powerKw: 9, windows: 4, fromMs: startMs });
      state = chargeHourly(state, {
        deviceId: 'garage', carId: 'car-a', powerKw: 6, windows: 3, fromMs: startMs + 10 * hourMs,
      });
      state = chargeHourly(state, {
        deviceId: 'work', carId: 'car-a', powerKw: 8, windows: 3, fromMs: startMs + 20 * hourMs,
      });

      // Pooled across garage (0.6) and work (0.8), ahead of the cabin
      // charger's own 0.9.
      expect(resolveRate(state, 'cabin', 'car-a').kWhPerUnit).toBeCloseTo(0.7, 6);
    });

    it('falls back to the charger rate when the car is not known', () => {
      let state = chargeHourly({}, { deviceId: 'garage', powerKw: 9, windows: 2, fromMs: startMs });
      state = chargeHourly(state, {
        deviceId: 'garage', carId: 'car-a', powerKw: 6, windows: 4, fromMs: startMs + 10 * hourMs,
      });

      expect(resolveRate(state, 'garage', null).kWhPerUnit).toBeCloseTo(0.9, 6);
    });

    it('falls back to the bootstrap rate when no rung has learned anything', () => {
      const result = resolveRate({}, 'garage', 'car-a');

      expect(result.kwhPerUnitSource).toBe('bootstrap');
      expect(result.kWhPerUnit).toBe(BOOTSTRAP_EV_SOC_KWH_PER_PERCENT);
    });

    it('reads the car from the producer-resolved level', () => {
      const device = (level: NonNullable<ObjectiveDeviceInput['stateOfCharge']>['level']): ObjectiveDeviceInput => (
        partialDouble<ObjectiveDeviceInput>({ id: 'garage', stateOfCharge: { level } })
      );

      expect(resolveObjectiveProfileSubject(device({ kind: 'known', percent: 40, carId: 'car-a' })))
        .toEqual({ deviceId: 'garage', carId: 'car-a' });
      expect(resolveObjectiveProfileSubject(device({ kind: 'known', percent: 40, carId: null })))
        .toEqual({ deviceId: 'garage', carId: null });
      expect(resolveObjectiveProfileSubject(device({ kind: 'unavailable', reasonCode: 'not_connected' })))
        .toEqual({ deviceId: 'garage', carId: null });
    });
  });

  describe('bound', () => {
    const profileAt = (updatedAtMs: number): DeviceObjectiveProfile => ({
      updatedAtMs,
      lastSample: { observedAtMs: updatedAtMs, value: 50 },
      acceptedSamples: 1,
      rejectedSamples: 0,
    });

    it('returns the same map when nothing goes', () => {
      const profiles: CarObjectiveProfiles = { 'car-a': { garage: profileAt(startMs) } };

      expect(pruneCarObjectiveProfiles(profiles, [], startMs + hourMs)).toBe(profiles);
    });

    it('drops a pair past retention unless it reported this cycle', () => {
      const nowMs = startMs + CAR_OBJECTIVE_PROFILE_RETENTION_MS + hourMs;
      const profiles: CarObjectiveProfiles = {
        'car-a': { garage: profileAt(startMs), work: profileAt(startMs) },
      };

      expect(pruneCarObjectiveProfiles(profiles, [{ carId: 'car-a', deviceId: 'work' }], nowMs))
        .toEqual({ 'car-a': { work: profileAt(startMs) } });
    });

    it('keeps the most recent chargers per car and the most recent cars', () => {
      const chargers = Object.fromEntries(
        Array.from({ length: CAR_OBJECTIVE_PROFILE_MAX_CHARGERS_PER_CAR + 2 }, (_, index) => (
          [`charger-${index}`, profileAt(startMs + 1_000 + index)]
        )),
      );
      const cars: CarObjectiveProfiles = Object.fromEntries(
        Array.from({ length: CAR_OBJECTIVE_PROFILE_MAX_CARS + 2 }, (_, index) => (
          [`car-${index}`, { garage: profileAt(startMs + 100 + index) }]
        )),
      );

      const pruned = pruneCarObjectiveProfiles(
        { ...cars, busy: chargers }, [{ carId: 'car-0', deviceId: 'garage' }], startMs + 2_000,
      );

      expect(Object.keys(pruned)).toHaveLength(CAR_OBJECTIVE_PROFILE_MAX_CARS);
      // Reporting this cycle outranks recency; the oldest of the rest go.
      expect(pruned['car-0']).toBeDefined();
      expect(pruned['car-1']).toBeUndefined();
      expect(pruned['car-9']).toBeDefined();
      const busy = pruned.busy ?? {};
      expect(Object.keys(busy)).toHaveLength(CAR_OBJECTIVE_PROFILE_MAX_CHARGERS_PER_CAR);
      expect(busy['charger-0']).toBeUndefined();
      expect(busy[`charger-${CAR_OBJECTIVE_PROFILE_MAX_CHARGERS_PER_CAR + 1}`]).toBeDefined();
    });

    it('bounds the profiles the sample path keeps', () => {
      let state: PowerTrackerState = {};
      for (let index = 0; index < CAR_OBJECTIVE_PROFILE_MAX_CARS + 3; index += 1) {
        state = updateObjectiveProfilesFromSnapshot(state, [charger({
          deviceId: 'garage', percent: 40, atMs: startMs + index * hourMs, measuredPowerKw: 7, carId: `car-${index}`,
        })], startMs + index * hourMs, undefined);
      }

      expect(Object.keys(state.carObjectiveProfiles ?? {})).toHaveLength(CAR_OBJECTIVE_PROFILE_MAX_CARS);
      expect(state.carObjectiveProfiles?.[`car-${CAR_OBJECTIVE_PROFILE_MAX_CARS + 2}`]).toBeDefined();
    });
  });
});
