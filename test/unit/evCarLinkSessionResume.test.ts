import { describe, expect, it } from 'vitest';
import type { CarObservation } from '../../lib/device/evCarLinkObservation';
import type { EvCarLinkChargerView } from '../../lib/device/evCarLinkChargerView';
import { resolveResumableSessions } from '../../lib/device/evCarLinkSessionResume';

/**
 * Picking a session back up after a restart. The persisted pair says who the car
 * WAS; both sides reporting connected now is what makes it who it IS.
 */

const charger = (overrides: Partial<EvCarLinkChargerView> = {}): EvCarLinkChargerView => ({
  id: 'charger-1',
  name: 'Elbillader',
  evChargingState: 'plugged_in_charging',
  controlOn: true,
  ...overrides,
});

const car = (overrides: Partial<CarObservation> = {}): CarObservation => ({
  name: 'Polestar 3',
  state: 'plugged_in_charging',
  stateAtMs: 5_000,
  socPct: 55,
  socAtMs: 5_000,
  ...overrides,
});

const resolve = (params: {
  sessions?: Record<string, { carId: string; sinceMs: number }>;
  chargers?: EvCarLinkChargerView[];
  cars?: Array<[string, CarObservation]>;
  settled?: string[];
}) => resolveResumableSessions({
  sessions: params.sessions ?? { 'charger-1': { carId: 'car-1', sinceMs: 1_000 } },
  chargers: params.chargers ?? [charger()],
  cars: new Map(params.cars ?? [['car-1', car()]]),
  isSettled: (id) => (params.settled ?? []).includes(id),
});

describe('resolveResumableSessions', () => {
  it('resumes when both the charger and its remembered car report connected', () => {
    expect(resolve({})).toEqual([{ chargerId: 'charger-1', carId: 'car-1', sinceMs: 1_000 }]);
  });

  it('carries the original session start rather than restamping it', () => {
    // The session did not begin again; PELS looked away and came back. Restamping
    // would date it from the restart and misreport how long the car has been on.
    expect(resolve({})[0].sinceMs).toBe(1_000);
  });

  it('does not resume when only the car reports connected', () => {
    // The everyday away case: the car is plugged in at work, which looks
    // identical from the car's side, while this charger has nothing on it.
    expect(resolve({ chargers: [charger({ evChargingState: 'plugged_out' })] })).toEqual([]);
  });

  it('does not resume when only the charger reports connected', () => {
    // Some other car is on it — a guest, or a household car PELS does not track.
    expect(resolve({ cars: [['car-1', car({ state: 'plugged_out' })]] })).toEqual([]);
  });

  it('does not resume a car that is no longer in Homey', () => {
    expect(resolve({ cars: [] })).toEqual([]);
  });

  it('resumes nothing without a persisted session', () => {
    // Snapshots written before sessions were persisted, and every charger whose
    // session ended normally.
    expect(resolve({ sessions: {} })).toEqual([]);
    expect(resolveResumableSessions({
      sessions: undefined, chargers: [charger()], cars: new Map(), isSettled: () => false,
    })).toEqual([]);
  });

  it('leaves a charger alone once it is settled', () => {
    // Already linked, or already resumed this run — resuming again would re-emit
    // on every correlation pass.
    expect(resolve({ settled: ['charger-1'] })).toEqual([]);
  });

  it('resumes each charger in a two-car, two-charger home', () => {
    // The case a "refuse when another car is connected" guard would break: both
    // cars are legitimately connected, each on its own charger.
    const resumed = resolveResumableSessions({
      sessions: {
        'charger-1': { carId: 'car-1', sinceMs: 1_000 },
        'charger-2': { carId: 'car-2', sinceMs: 2_000 },
      },
      chargers: [charger(), charger({ id: 'charger-2', name: 'Garasje' })],
      cars: new Map([['car-1', car()], ['car-2', car({ name: 'Zoe' })]]),
      isSettled: () => false,
    });
    expect(resumed.map((entry) => entry.carId)).toEqual(['car-1', 'car-2']);
  });
});
