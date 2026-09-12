import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlanCycle, type PlanCycleSpec } from '../utils/planContextPowerFixture';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { MeasuredPower, PlanContext } from '../../lib/plan/planContext';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { applyRestorePlan } from '../../lib/plan/restore';
import { SWAP_TIMEOUT_MS } from '../../lib/plan/planConstants';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { buildPlanDevice } from '../utils/planTestUtils';
import { hasReservation, swappedOutFor } from '../utils/swapLedgerFixture';
import { partialDouble } from '../helpers/partialDouble';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import { reasonText } from '../utils/deviceReasonTestUtils';

/**
 * A swap reservation's lifetime, across cycles.
 *
 * Every other swap spec is single-cycle: it seeds one reservation, runs one
 * `applyRestorePlan`, and asserts either the approval arithmetic or the
 * settling rule for a target already at the requested step. None drives a
 * reservation across cycles, so none can observe what happens to one that is
 * waiting — which is the whole of its lifetime, and where a 0-for-16
 * production record hid behind a green suite.
 *
 * The invariant under test: a reservation's clock runs only while the restore
 * lane could actually serve it. Reconcile runs on every rebuild, and
 * `SWAP_TIMEOUT_MS` is the same 60 s as `SHED_COOLDOWN_MS` — which the swap's
 * own donor shed starts, via the executor's `recordShedActuation` — so a
 * reservation is shut out for exactly as long as it is allowed to live. Expiry
 * then does double damage, because releasing the reservation also releases the
 * donors paused to fund it.
 *
 * The last cycle is the one that matters: it reopens the lane. An earlier
 * version of this spec stopped while the lane was still shut and passed against
 * a build where the renewal was discarded by a DTO round-trip every rebuild.
 */

const FIXTURE_TOTAL_KW = 3;

const buildContext = (overrides: PlanCycleSpec = {}): { context: PlanContext; power: MeasuredPower } => (
  buildPlanCycle({ total: FIXTURE_TOTAL_KW, headroom: 1, hourBucketKey: '1970-01-01T00', ...overrides })
);

let capture: LoggerCapture;
beforeEach(() => { capture = captureLogger('debug', ['plan']); staleCleared.length = 0; });
afterEach(() => { capture.restore(); });

/**
 * `swap_stale_cleared` goes to the THREADED `deps.structuredLog`, not the
 * `plan`-topic capture, so a spec that omits it cannot see an expiry at all.
 */
const staleCleared: Record<string, unknown>[] = [];
const structuredLog = partialDouble<PinoLogger>({
  info: (payload: unknown) => {
    const record = asRecord(payload);
    if (record !== null && record['event'] === 'swap_stale_cleared') staleCleared.push(record);
  },
});
const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
);

const buildDeps = (lastTimestamp: number) => ({
  powerTracker: { lastTimestamp } as PowerTrackerState,
  normalizedShedFloorCByDevice: new Map(),
  getShedBehavior: () => ({ action: 'turn_off' as const }),
  structuredLog,
  log: vi.fn(),
  logDebug: vi.fn(),
});

/** The beneficiary: higher priority (10), off, wants 1 kW. */
const beneficiary = (): DevicePlanDevice => buildPlanDevice({
  id: 'dev-off', name: 'Off', priority: 10, currentState: 'off', measuredPowerKw: 0, expectedPowerKw: 1,
});

/** The donor: lower priority (90), on, drawing 2 kW. */
const donorOn = (): DevicePlanDevice => buildPlanDevice({
  id: 'dev-on', name: 'On', priority: 90, currentState: 'on', measuredPowerKw: 2, expectedPowerKw: 2,
});

/** The donor after the executor has actuated the swap's shed. */
const donorOff = (): DevicePlanDevice => buildPlanDevice({
  id: 'dev-on', name: 'On', priority: 90, currentState: 'off', measuredPowerKw: 0, expectedPowerKw: 2,
});

describe('swap reservation lifetime', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not expire a reservation that has never been serviceable', () => {
    const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(t0);
    const state = createPlanEngineState();

    // Cycle 1 — no headroom of its own, so only a swap can fund the restore.
    const first = applyRestorePlan({
      planDevices: [beneficiary(), donorOn()],
      ...buildContext({ headroomRaw: 0, headroom: 0 }),
      state,
      sheddingActive: false,
      deps: buildDeps(1_000),
    });
    expect(reasonText(first.planDevices.find((d) => d.id === 'dev-off')?.reason)).toBe('swap pending');
    expect(hasReservation(state, 'dev-off')).toBe(true);
    expect(swappedOutFor(state, 'dev-on')).toBe('dev-off');

    // Now the lane is shut for longer than the whole timeout window: shedding is
    // latched, so NO restore can be admitted however the swap is doing. The
    // reservation must not burn its life here — it has had no opportunity to
    // complete, and expiring it both abandons the swap and releases the donor
    // that the swap had already paid for.
    for (let elapsed = 10_000; elapsed <= SWAP_TIMEOUT_MS + 20_000; elapsed += 10_000) {
      vi.setSystemTime(t0 + elapsed);
      applyRestorePlan({
        planDevices: [beneficiary(), donorOff()],
        ...buildContext({ headroomRaw: -1, headroom: -1 }),
        state,
        sheddingActive: true,
        deps: buildDeps(1_000 + elapsed),
      });
    }

    expect(staleCleared).toHaveLength(0);
    expect(hasReservation(state, 'dev-off')).toBe(true);
    expect(swappedOutFor(state, 'dev-on')).toBe('dev-off');

    // The lane reopens. THIS is the cycle the reservation was waiting for, and
    // it must get a serviceable window here — not be expired on arrival
    // against a deadline set before the lane ever shut.
    vi.setSystemTime(t0 + SWAP_TIMEOUT_MS + 30_000);
    applyRestorePlan({
      planDevices: [beneficiary(), donorOff()],
      ...buildContext({ headroomRaw: 2, headroom: 2 }),
      state,
      sheddingActive: false,
      deps: buildDeps(1_000 + SWAP_TIMEOUT_MS + 30_000),
    });

    expect(staleCleared).toHaveLength(0);
    expect(hasReservation(state, 'dev-off')).toBe(true);
  });

  it('survives a serviceable cycle that is its first rebuild since approval', () => {
    // `power_source = flow` drives rebuilds off Flow events, so a gap longer
    // than the shed cooldown is ordinary cadence — there may be NO rebuild
    // between the approval and the cycle the lane reopens. The served window
    // therefore cannot be something the reservation accrues per shut cycle; it
    // has to begin when a serving lane is first SEEN.
    const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(t0);
    const state = createPlanEngineState();

    applyRestorePlan({
      planDevices: [beneficiary(), donorOn()],
      ...buildContext({ headroomRaw: 0, headroom: 0 }),
      state,
      sheddingActive: false,
      deps: buildDeps(1_000),
    });
    expect(hasReservation(state, 'dev-off')).toBe(true);

    // One rebuild, well past the timeout, and it is the first since approval.
    vi.setSystemTime(t0 + SWAP_TIMEOUT_MS + 30_000);
    applyRestorePlan({
      planDevices: [beneficiary(), donorOff()],
      ...buildContext({ headroomRaw: 2, headroom: 2 }),
      state,
      sheddingActive: false,
      deps: buildDeps(1_000 + SWAP_TIMEOUT_MS + 30_000),
    });

    expect(staleCleared).toHaveLength(0);
    expect(hasReservation(state, 'dev-off')).toBe(true);
    expect(swappedOutFor(state, 'dev-on')).toBe('dev-off');
  });
});
