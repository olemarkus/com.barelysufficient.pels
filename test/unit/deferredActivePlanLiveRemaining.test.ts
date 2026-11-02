import type { DeferredObjectiveActivePlanV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { resolveLiveRemainingEnergy } from '../../packages/shared-domain/src/deferredActivePlanLiveRemaining';
import { resolveActivePlanFixture } from '../helpers/activePlanFixtures';

const NOW = new Date('2026-11-02T10:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;

const plan = (overrides: Partial<DeferredObjectiveActivePlanV1>): DeferredObjectiveActivePlanV1 => ({
  liveCompletion: { kind: 'unavailable' },
  deviceId: 'dev',
  deviceName: 'Device',
  objectiveKind: 'temperature',
  targetValue: 55,
  deadlineAtMs: NOW + 2 * HOUR,
  startedAtMs: NOW - HOUR,
  pending: false,
  objectiveSignature: 'sig',
  original: null,
  latest: {
    revision: 1,
    revisedAtMs: NOW - HOUR,
    computedFromPricesUpTo: null,
    reason: 'prices_arrived',
    progressDirection: 'increasing',
    hours: [{ startsAtMs: NOW, endsAtMs: NOW + HOUR, plannedKWh: 1 }],
    energyNeededKWh: 4.4,
    energyExpectedKWh: 4,
    rateMean: 0.4,
    planStatus: 'on_track',
  },
  ...overrides,
});

describe('resolveLiveRemainingEnergy', () => {
  test('an energy task needs its target less the energy delivered so far', () => {
    // SHS2 lab, run A: a 3.5 kWh task whose revision still read 3.5 kWh after 2.6 kWh went in.
    const energyPlan = resolveActivePlanFixture(plan({
      objectiveKind: 'energy',
      targetValue: 3.5,
      latest: { ...plan({}).latest!, energyNeededKWh: 3.5, energyExpectedKWh: undefined, rateMean: undefined },
    }), () => 2.6);
    const live = resolveLiveRemainingEnergy(energyPlan, 2.6);
    expect(live?.neededKWh).toBeCloseTo(0.9, 6);
    expect(live?.expectedKWh).toBeCloseTo(0.9, 6);
  });

  test('a heating task scales the units left now by the plan rate, keeping its buffer', () => {
    // Revision: 10 °C left at 0.4 kWh/°C = 4 kWh expected, 4.4 kWh booked (×1.1).
    const live = resolveLiveRemainingEnergy(resolveActivePlanFixture(plan({})), 50);
    expect(live?.expectedKWh).toBeCloseTo(2, 6);
    expect(live?.neededKWh).toBeCloseTo(2.2, 6);
  });

  test('a cooling task counts units left downwards', () => {
    const cooling = resolveActivePlanFixture(plan({
      targetValue: 18,
      latest: { ...plan({}).latest!, progressDirection: 'decreasing' },
    }));
    expect(resolveLiveRemainingEnergy(cooling, 21)?.expectedKWh).toBeCloseTo(1.2, 6);
  });

  test('a reached target needs nothing', () => {
    expect(resolveLiveRemainingEnergy(resolveActivePlanFixture(plan({})), 56))
      .toEqual({ neededKWh: 0, expectedKWh: 0 });
  });

  test('no buffer on the revision gives equal figures', () => {
    const steady = resolveActivePlanFixture(plan({
      objectiveKind: 'ev_soc',
      targetValue: 80,
      latest: { ...plan({}).latest!, energyNeededKWh: 4, energyExpectedKWh: undefined },
    }));
    expect(resolveLiveRemainingEnergy(steady, 75)).toEqual({ neededKWh: 2, expectedKWh: 2 });
  });

  test('gives no live answer without a reading, a rate, a direction or a revision', () => {
    expect(resolveLiveRemainingEnergy(resolveActivePlanFixture(plan({})), null)).toBeNull();
    expect(resolveLiveRemainingEnergy(resolveActivePlanFixture(plan({
      latest: { ...plan({}).latest!, rateMean: undefined },
    })), 50)).toBeNull();
    expect(resolveLiveRemainingEnergy(resolveActivePlanFixture(plan({
      latest: { ...plan({}).latest!, progressDirection: 'unknown' },
    })), 50)).toBeNull();
    expect(resolveLiveRemainingEnergy(resolveActivePlanFixture(plan({ latest: null })), 50)).toBeNull();
  });
});
