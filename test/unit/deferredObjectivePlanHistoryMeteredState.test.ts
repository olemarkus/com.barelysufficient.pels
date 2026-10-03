// Unit tests for the persisted in-progress metered-delivery row (commitment, start
// progress, hour-start bookings): the boundary that resolves a saved row (including rows saved by an
// older build) into the state the plan-history recorder restores after a restart.
import {
  isPersistedMeteredDeliveryState,
  type MeteredRunCommitment,
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
  startProgressValue: 50,
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

describe('isPersistedMeteredDeliveryState commitment and start progress', () => {
  it.each<[string, MeteredRunCommitment]>([
    ['learning', { kind: 'learning', startProgressValue: 50 }],
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
    // A learning row is saved only with its start anchor.
    ['a learning commitment with no anchor', { commitment: { kind: 'learning' } }],
    ['a learning commitment with a null anchor', { commitment: { kind: 'learning', startProgressValue: null } }],
    ['a negative known commitment', { commitment: { kind: 'known', kwh: -1 } }],
    ['a non-finite start progress', { startProgressValue: Number.NaN }],
    ['a missing start progress', { startProgressValue: undefined }],
    ['a non-numeric start progress', { startProgressValue: 'fifty' }],
  ])('rejects %s', (_label, overrides) => {
    expect(isPersistedMeteredDeliveryState({ ...state(), ...overrides })).toBe(false);
  });
});

describe('migrateMeteredDeliveryState commitment and start progress', () => {
  it('resolves a row saved before start progress existed to an untrusted start', () => {
    const { startProgressValue: _start, ...legacy } = state();
    const migrated = migrateMeteredDeliveryState(legacy);
    expect(migrated).toEqual({ ...legacy, startProgressValue: null });
    expect(isPersistedMeteredDeliveryState(migrated)).toBe(true);
  });

  it('keeps a saved unknown commitment unknown and a saved learning one learning', () => {
    const asState = (raw: unknown) => raw as PersistedMeteredDeliveryState;
    expect(asState(migrateMeteredDeliveryState(state({ commitment: { kind: 'unknown' } }))).commitment)
      .toEqual({ kind: 'unknown' });
    expect(asState(migrateMeteredDeliveryState(state({ commitment: { kind: 'learning', startProgressValue: 50 } })))
      .commitment).toEqual({ kind: 'learning', startProgressValue: 50 });
  });
});
