// Unit tests for the persisted in-progress metered-delivery row: the boundary
// that resolves a saved row (including rows saved by an older build) into the
// typed state the plan-history recorder restores after a restart.
import {
  isPersistedMeteredDeliveryState,
  type MeteredRunCommitment,
  migrateMeteredDeliveryState,
  type PersistedMeteredDeliveryState,
} from '../../lib/objectives/deferredObjectives/planHistoryMeteredState';

const HOUR_MS = 60 * 60 * 1000;

const state = (overrides: Partial<PersistedMeteredDeliveryState> = {}): PersistedMeteredDeliveryState => ({
  commitment: { kind: 'learning' },
  deviceId: 'dev',
  deadlineAtMs: 6 * HOUR_MS,
  startedAtMs: 0,
  startProgressValue: 50,
  deliveredKWh: 0,
  totalCost: 0,
  costDisplay: null,
  deliveryPriceComplete: true,
  hourlyContributions: [],
  hourStartBookings: [{ atMs: 0, bookedKWh: 2 }, { atMs: HOUR_MS, bookedKWh: 0 }],
  ...overrides,
});

describe('isPersistedMeteredDeliveryState', () => {
  it('accepts a run saved while still learning, with its start anchor and hour-start bookings', () => {
    expect(isPersistedMeteredDeliveryState(state())).toBe(true);
  });

  it.each<[string, MeteredRunCommitment]>([
    ['known', { kind: 'known', kwh: 3 }],
    ['unknown', { kind: 'unknown' }],
  ])('accepts a %s commitment', (_label, commitment) => {
    expect(isPersistedMeteredDeliveryState(state({ commitment }))).toBe(true);
  });

  it('accepts a run saved before any trusted progress reading', () => {
    expect(isPersistedMeteredDeliveryState(state({ startProgressValue: null }))).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown commitment kind', { commitment: { kind: 'guessing' } }],
    ['a negative known commitment', { commitment: { kind: 'known', kwh: -1 } }],
    ['a non-finite start progress', { startProgressValue: Number.NaN }],
    ['a missing start progress', { startProgressValue: undefined }],
    ['a negative hour-start booking', { hourStartBookings: [{ atMs: 0, bookedKWh: -0.5 }] }],
    ['a non-finite booked hour', { hourStartBookings: [{ atMs: Number.NaN, bookedKWh: 1 }] }],
    // The same guard as the finalized entry's (`isHourStartBooking`).
    ['a negative booked hour', { hourStartBookings: [{ atMs: -HOUR_MS, bookedKWh: 1 }] }],
    ['hour-start bookings that are not a list', { hourStartBookings: {} }],
  ])('rejects %s', (_label, overrides) => {
    expect(isPersistedMeteredDeliveryState({ ...state(), ...overrides })).toBe(false);
  });
});

describe('migrateMeteredDeliveryState', () => {
  it('resolves a row saved before commitments, start anchors and bookings existed', () => {
    const legacy = {
      deviceId: 'dev', deadlineAtMs: 10_000, startedAtMs: 1_000,
      deliveredKWh: 6, totalCost: 0, costDisplay: null,
      deliveryPriceComplete: false, hourlyContributions: [],
    };
    const migrated = migrateMeteredDeliveryState(legacy);
    expect(migrated).toEqual({
      ...legacy,
      commitment: { kind: 'unknown' },
      startProgressValue: null,
      hourStartBookings: [],
    });
    expect(isPersistedMeteredDeliveryState(migrated)).toBe(true);
  });

  it('keeps a saved unknown commitment unknown and a saved learning one learning', () => {
    expect((migrateMeteredDeliveryState(state({ commitment: { kind: 'unknown' } })) as PersistedMeteredDeliveryState)
      .commitment).toEqual({ kind: 'unknown' });
    expect((migrateMeteredDeliveryState(state()) as PersistedMeteredDeliveryState).commitment)
      .toEqual({ kind: 'learning' });
  });

  it('leaves a malformed field for the validator to reject rather than defaulting it', () => {
    const migrated = migrateMeteredDeliveryState({ ...state(), startProgressValue: 'fifty' });
    expect(isPersistedMeteredDeliveryState(migrated)).toBe(false);
  });
});
