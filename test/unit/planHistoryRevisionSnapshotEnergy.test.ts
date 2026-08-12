// Unit tests for the energy figure `captureRevisionSnapshot` records on a
// history revision snapshot.
//
// This used to be stamped on afterwards by a separate helper, from the
// FINALIZE moment, onto both the original and the final snapshot — so the
// "original" requirement the miss attribution compared delivery against was
// really the energy still outstanding at the end. Each snapshot now carries its
// own revision's figure, captured here alongside `energyNeededKWh`.
import { captureRevisionSnapshot } from '../../lib/objectives/deferredObjectives/planHistoryV4Helpers';
import type { DeferredObjectiveActivePlanRevisionV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';

const HOUR_MS = 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 7, 11, 20, 0, 0);

const buildRevision = (
  overrides: Partial<DeferredObjectiveActivePlanRevisionV1> = {},
): DeferredObjectiveActivePlanRevisionV1 => ({
  revision: 1,
  revisedAtMs: BASE_MS,
  computedFromPricesUpTo: null,
  reason: 'objective_changed',
  hours: [{ startsAtMs: BASE_MS + HOUR_MS, plannedKWh: 2 }],
  energyNeededKWh: 24.14,
  planStatus: 'cannot_meet',
  ...overrides,
});

describe('captureRevisionSnapshot energy capture', () => {
  it('records the mean requirement of the revision it was captured from', () => {
    const snapshot = captureRevisionSnapshot(
      buildRevision({ energyNeededKWh: 24.14, energyExpectedKWh: 21.69 }),
      undefined,
    );
    expect(snapshot.energyExpectedKWh).toBe(21.69);
    expect(snapshot.energyNeededKWh).toBe(24.14);
  });

  it('resolves an omitted energyExpectedKWh to energyNeededKWh', () => {
    // The recorder omits the field when the two coincide (cold-start,
    // bootstrap, steady device), so absence encodes equality rather than
    // "unknown". Recording the resolved value keeps the snapshot self-contained
    // for the UI render path.
    const snapshot = captureRevisionSnapshot(
      buildRevision({ energyNeededKWh: 20 }),
      undefined,
    );
    expect(snapshot.energyExpectedKWh).toBe(20);
  });

  it('omits the field entirely for a satisfied objective rather than writing zero', () => {
    // Persistence-safety guard, not a nicety. `hasValidMissAttributionFields`
    // rejects a non-positive `energyExpectedKWh`, and a failed guard drops the
    // WHOLE history entry on load — taking `originalPlan`, `revisions[]` and
    // every unrelated valid field with it, after which the next flush persists
    // the reduced set. A satisfied objective has `energyNeededKWh === 0`, so
    // resolving-then-writing without the positivity gate would silently destroy
    // history entries.
    const snapshot = captureRevisionSnapshot(
      buildRevision({ energyNeededKWh: 0, planStatus: 'satisfied' }),
      undefined,
    );
    expect(snapshot.energyExpectedKWh).toBeUndefined();
    expect('energyExpectedKWh' in snapshot).toBe(false);
  });
});
