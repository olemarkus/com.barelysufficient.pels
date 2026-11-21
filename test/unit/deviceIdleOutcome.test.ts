import { vi } from 'vitest';
import type { TaskDeliveryCause, TaskDeliveryEvidence } from '../../packages/contracts/src/taskDelivery';
import type { TaskDeliveryFacts } from '../../lib/objectives/deferredObjectives/deliveryEvidence';
import {
  isDeviceIdleOutcome, observeDeviceIdleEvidence, reconcileIdleAtDeadline,
} from '../../lib/objectives/deferredObjectives/deviceIdleOutcome';
import type { InProgressRecord } from '../../lib/objectives/deferredObjectives/planHistoryInProgressState';
import { partialDouble } from '../helpers/partialDouble';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CONFIRMED_AT_MS = 15 * MINUTE_MS;

const accepted: TaskDeliveryEvidence = {
  energyIdle: { kind: 'accepted' },
  nonDelivery: { kind: 'confirmed', sinceMs: 0 },
  explanation: {
    kind: 'recorded',
    primary: { kind: 'blocked', cause: 'device_not_accepting' },
    intervals: [],
    contributors: [],
  },
};

const run = (overrides: Partial<InProgressRecord> = {}): InProgressRecord => partialDouble<InProgressRecord>({
  objectiveKind: 'energy',
  targetValue: 8,
  finalProgressValue: 3,
  startedAtMs: 0,
  deadlineAtMs: 3 * HOUR_MS,
  originalPlan: {
    energyNeededKWh: 8,
    planStatus: 'on_track',
    planningSpeedKw: 4,
    revisedAtMs: 0,
    hours: [{ startsAtMs: 0, endsAtMs: 2 * HOUR_MS, plannedKWh: 8 }],
  },
  deliveryEvidence: accepted,
  deviceIdleEvidence: {
    firstIdleAtMs: CONFIRMED_AT_MS,
    lastAcceptedAtMs: 3 * HOUR_MS - 30_000,
    permittedIdleMs: 80 * MINUTE_MS,
    planningSpeedKw: 4,
  },
  ...overrides,
});

const permittedIdle: TaskDeliveryFacts = {
  energyIdleEligible: true,
  obligation: 'claimed',
  control: { kind: 'permitted' },
  observation: { kind: 'not_drawing' },
  progress: { kind: 'known', value: 3 },
  deviceConstraint: { kind: 'none' },
  schedule: 'fits',
};

const withEarlierBlocker = (cause: TaskDeliveryCause, fromMs: number): TaskDeliveryEvidence => ({
  ...accepted,
  explanation: {
    kind: 'recorded',
    primary: { kind: 'blocked', cause: 'device_not_accepting' },
    contributors: [cause],
    intervals: [{ cause, fromMs, toMs: fromMs + 30_000 }],
  },
});

describe('energy task device-idle outcome', () => {
  it('retains feasible planning speed and only adds confirmed, contiguous permitted time', () => {
    const record = run({ deviceIdleEvidence: undefined, deliveryEvidence: { ...accepted, energyIdle: undefined } });
    const first = observeDeviceIdleEvidence(record, permittedIdle, accepted, CONFIRMED_AT_MS, 30_000);
    expect(first).toEqual({
      firstIdleAtMs: CONFIRMED_AT_MS, lastAcceptedAtMs: CONFIRMED_AT_MS, permittedIdleMs: 0, planningSpeedKw: 4,
    });

    const withoutBookings = run({ originalPlan: null, deviceIdleEvidence: first });
    expect(observeDeviceIdleEvidence(withoutBookings, permittedIdle, accepted, CONFIRMED_AT_MS + 30_000, 30_000))
      .toMatchObject({ permittedIdleMs: 30_000, planningSpeedKw: 4 });

    expect(observeDeviceIdleEvidence(withoutBookings, permittedIdle, accepted, CONFIRMED_AT_MS + HOUR_MS, HOUR_MS))
      .toMatchObject({ permittedIdleMs: 0 });
    expect(observeDeviceIdleEvidence(
      withoutBookings,
      { ...permittedIdle, obligation: 'deferred' },
      accepted,
      CONFIRMED_AT_MS + 30_000,
      30_000,
    )).toMatchObject({ permittedIdleMs: 0, lastAcceptedAtMs: CONFIRMED_AT_MS + 30_000 });
  });

  it('credits the continuous permitted watch once it confirms', () => {
    const watching: TaskDeliveryEvidence = {
      ...accepted, energyIdle: undefined, nonDelivery: { kind: 'watching', sinceMs: 0 },
    };
    const record = run({ deviceIdleEvidence: undefined, deliveryEvidence: watching });
    const confirming = observeDeviceIdleEvidence(record, permittedIdle, accepted, CONFIRMED_AT_MS, 30_000);
    expect(confirming).toMatchObject({ firstIdleAtMs: 0, permittedIdleMs: CONFIRMED_AT_MS });
    expect(observeDeviceIdleEvidence(record, permittedIdle, accepted, CONFIRMED_AT_MS, CONFIRMED_AT_MS))
      .toMatchObject({ permittedIdleMs: 0 });
  });

  it('uses the device reading at the deadline to invalidate a retained idle verdict', () => {
    const record = run({ deviceId: 'relay' });
    const drawAtDeadline = vi.fn(() => 2);
    expect(isDeviceIdleOutcome(reconcileIdleAtDeadline(record, drawAtDeadline))).toBe(false);
    expect(drawAtDeadline).toHaveBeenCalledWith('relay', record.deadlineAtMs);
    expect(isDeviceIdleOutcome(reconcileIdleAtDeadline(record, () => 0))).toBe(true);
  });

  it('requires a booking that could cover the requested delivery', () => {
    const record = run({
      deviceIdleEvidence: undefined,
      originalPlan: {
        energyNeededKWh: 8,
        planStatus: 'at_risk',
        planningSpeedKw: 4,
        revisedAtMs: 0,
        hours: [{ startsAtMs: 0, endsAtMs: HOUR_MS, plannedKWh: 4 }],
      },
    });
    expect(observeDeviceIdleEvidence(record, permittedIdle, accepted, CONFIRMED_AT_MS, 0)).toBeUndefined();
  });

  it('requires enough permitted idle to explain the deficit, including an earlier resumed burst', () => {
    expect(isDeviceIdleOutcome(run())).toBe(true);
    expect(isDeviceIdleOutcome(run({ finalProgressValue: 1 }))).toBe(false);
    expect(isDeviceIdleOutcome(run({ finalProgressValue: 8 }))).toBe(false);
  });

  it('allows a later rate shortage but leaves an independently short or held run as a miss', () => {
    expect(isDeviceIdleOutcome(run({ deliveryEvidence: withEarlierBlocker('rate_insufficient', CONFIRMED_AT_MS) })))
      .toBe(true);
    expect(isDeviceIdleOutcome(run({ deliveryEvidence: withEarlierBlocker('rate_insufficient', MINUTE_MS) })))
      .toBe(false);
    expect(isDeviceIdleOutcome(run({ deliveryEvidence: withEarlierBlocker('capacity_limited', HOUR_MS) })))
      .toBe(false);
  });

  it('keeps an accepted stop through a deferred window but requires revalidation after uncertain observations', () => {
    const held: TaskDeliveryEvidence = {
      ...accepted,
      explanation: { kind: 'recorded', primary: { kind: 'clear' }, intervals: [], contributors: [] },
    };
    expect(isDeviceIdleOutcome(run({ deliveryEvidence: held }))).toBe(true);
    expect(isDeviceIdleOutcome(run({ deliveryEvidence: { ...held, energyIdle: { kind: 'uncertain' } } }))).toBe(false);
  });

  it('requires a reviewed task near expiry so an unobserved final stretch cannot settle the result', () => {
    expect(isDeviceIdleOutcome(run({ deadlineAtMs: 4 * HOUR_MS }))).toBe(false);
  });
});
