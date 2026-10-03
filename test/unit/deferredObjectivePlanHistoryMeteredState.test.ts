// Unit tests for the persisted in-progress metered-delivery row's hour-start
// bookings: the boundary that resolves a saved row (including rows saved by an
// older build) into the state the plan-history recorder restores after a restart.
import {
  isPersistedMeteredDeliveryState,
  migrateMeteredDeliveryState,
  type PersistedMeteredDeliveryState,
} from '../../lib/objectives/deferredObjectives/planHistoryMeteredState';

const HOUR_MS = 60 * 60 * 1000;

const state = (overrides: Partial<PersistedMeteredDeliveryState> = {}): PersistedMeteredDeliveryState => ({
  deliveryEvidence: { explanation: { kind: 'legacy_unrecorded' }, nonDelivery: { kind: 'none' } },
  commitment: { kind: 'known', kwh: 5 },
  deviceId: 'dev',
  deadlineAtMs: 6 * HOUR_MS,
  startedAtMs: 0,
  deliveredKWh: 0,
  totalCost: 0,
  costDisplay: null,
  deliveryPriceComplete: true,
  hourlyContributions: [],
  hourStartBookings: [{ atMs: 0, bookedKWh: 2 }, { atMs: HOUR_MS, bookedKWh: 0 }],
  ...overrides,
});

describe('isPersistedMeteredDeliveryState hour-start bookings', () => {
  it('accepts a row with hour-start bookings, zero bookings included', () => {
    expect(isPersistedMeteredDeliveryState(state())).toBe(true);
  });

  it('accepts a row with no hour recorded yet', () => {
    expect(isPersistedMeteredDeliveryState(state({ hourStartBookings: [] }))).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a negative booking', { hourStartBookings: [{ atMs: 0, bookedKWh: -0.5 }] }],
    ['a non-finite booked hour', { hourStartBookings: [{ atMs: Number.NaN, bookedKWh: 1 }] }],
    // The same guard as the finalized entry's (`isHourStartBooking`).
    ['a negative booked hour', { hourStartBookings: [{ atMs: -HOUR_MS, bookedKWh: 1 }] }],
    ['hour-start bookings that are not a list', { hourStartBookings: {} }],
    ['missing hour-start bookings', { hourStartBookings: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(isPersistedMeteredDeliveryState({ ...state(), ...overrides })).toBe(false);
  });
});

describe('migrateMeteredDeliveryState hour-start bookings', () => {
  it('resolves a row saved before hour-start bookings existed to none captured', () => {
    const { hourStartBookings: _bookings, ...legacy } = state();
    const migrated = migrateMeteredDeliveryState(legacy);
    expect(migrated).toEqual({ ...legacy, hourStartBookings: [] });
    expect(isPersistedMeteredDeliveryState(migrated)).toBe(true);
  });

  it('keeps saved bookings as written and leaves a malformed list for the validator', () => {
    expect((migrateMeteredDeliveryState(state()) as PersistedMeteredDeliveryState).hourStartBookings)
      .toEqual(state().hourStartBookings);
    const malformed = migrateMeteredDeliveryState({ ...state(), hourStartBookings: 'none' });
    expect(isPersistedMeteredDeliveryState(malformed)).toBe(false);
  });
});
