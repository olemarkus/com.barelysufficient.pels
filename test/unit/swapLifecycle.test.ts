import { describe, expect, it } from 'vitest';
import { SwapLedger, type SwapPromise } from '../../lib/plan/swap';
import { partialDouble } from '../helpers/partialDouble';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import { SWAP_RESERVATION_MAX_MS, SWAP_TIMEOUT_MS } from '../../lib/plan/planConstants';
import {
  buildPlanDevice as baseBuildPlanDevice,
  steppedPlanDevice as baseSteppedPlanDevice,
} from '../utils/planTestUtils';
import {
  type BinaryControlDiscriminantProbe,
  type DevicePlanDevice,
  type SteppedDiscriminantProbe,
  type TemperatureDiscriminantProbe,
  withBinaryDiscriminant,
} from '../../lib/plan/planTypes';

// Local wrappers that route a `binaryControl` override through the binary
// discriminant regrouper — the field moved off the `DevicePlanDevice` base onto
// the orthogonal binary cluster, so the shared builders no longer accept it as
// a flat override.
const buildPlanDevice = (
  overrides: Parameters<typeof baseBuildPlanDevice>[0] & BinaryControlDiscriminantProbe = {},
): DevicePlanDevice => {
  const { binaryControl, ...rest } = overrides;
  return withBinaryDiscriminant({
    ...baseBuildPlanDevice(rest),
    ...(binaryControl !== undefined ? { binaryControl } : {}),
  }) as DevicePlanDevice;
};

const steppedPlanDevice = (
  overrides: Partial<DevicePlanDevice> & SteppedDiscriminantProbe & TemperatureDiscriminantProbe
    & BinaryControlDiscriminantProbe = {},
): DevicePlanDevice => {
  const { binaryControl, ...rest } = overrides;
  return withBinaryDiscriminant({
    ...baseSteppedPlanDevice(rest),
    ...(binaryControl !== undefined ? { binaryControl } : {}),
  }) as DevicePlanDevice;
};

const BINARY_PROMISE: SwapPromise = { kind: 'binary' };
const steppedPromise = (stepId: string): SwapPromise => ({ kind: 'stepped', stepId });

const openLedger = (params: {
  promise: SwapPromise;
  donorIds?: readonly string[];
  planMeasurementTs?: number;
  openedAtMs?: number;
}): SwapLedger => {
  const ledger = new SwapLedger();
  ledger.open(
    'target',
    params.promise,
    new Set(params.donorIds ?? []),
    params.planMeasurementTs ?? 0,
    params.openedAtMs ?? 0,
  );
  return ledger;
};

/**
 * `reconcile` asks, per target, whether a lane that could serve it ran. These
 * specs are about the reservation's own lifetime, not about which lane is
 * eligible, so they answer the same for every device.
 */
const LANE_OPEN = (): boolean => true;
const LANE_SHUT = (): boolean => false;

/** The reservation is settled when the ledger no longer holds one. */
const holdsReservation = (ledger: SwapLedger): boolean => (
  ledger.reservationFor('target') !== undefined
);

/**
 * Completion has no public predicate of its own — it is observable as the
 * reservation being settled by a reconcile, which is the only way production
 * ever asks. Asserting through that keeps the spec on the real seam.
 */
const completes = (target: DevicePlanDevice, promise: SwapPromise): boolean => {
  const ledger = openLedger({ promise });
  ledger.reconcile(new Map([['target', target]]), 1_000, LANE_OPEN, undefined);
  return !holdsReservation(ledger);
};

describe('swap reservation completion', () => {
  it('keeps a binary target pending until it is observed on', () => {
    expect(completes(
      buildPlanDevice({ id: 'target', currentState: 'off', binaryControl: { on: false } }),
      BINARY_PROMISE,
    )).toBe(false);
    expect(completes(
      buildPlanDevice({ id: 'target', currentState: 'on', binaryControl: { on: true } }),
      BINARY_PROMISE,
    )).toBe(true);
  });

  it('keeps a stepped target pending while reported at a lower promised step', () => {
    expect(completes(steppedPlanDevice({
      id: 'target', currentState: 'on', binaryControl: { on: true }, reportedStepId: 'medium',
    }), steppedPromise('max'))).toBe(false);
  });

  it('settles a stepped target once the promised step is reported', () => {
    expect(completes(steppedPlanDevice({
      id: 'target', currentState: 'on', binaryControl: { on: true }, reportedStepId: 'max',
    }), steppedPromise('medium'))).toBe(true);
  });

  it('settles a step-only target (no binary handle) on the step axis alone', () => {
    // Regression: a step-only stepper used to be short-circuited to "not
    // complete" by the binary gate, holding its donors until the timeout.
    expect(completes(steppedPlanDevice({
      id: 'target', currentOn: undefined, currentState: 'on', reportedStepId: 'max',
    }), steppedPromise('medium'))).toBe(true);
    expect(completes(steppedPlanDevice({
      id: 'target', currentOn: undefined, currentState: 'on', reportedStepId: 'low',
    }), steppedPromise('medium'))).toBe(false);
  });

  it('does not settle on an optimistic selectedStepId ahead of the reported step', () => {
    expect(completes(steppedPlanDevice({
      id: 'target',
      currentState: 'on',
      binaryControl: { on: true },
      selectedStepId: 'max',
      reportedStepId: 'medium',
    }), steppedPromise('max'))).toBe(false);
  });

  it('does not settle while reportedStepId is unknown even if selectedStepId reached the promise', () => {
    expect(completes(steppedPlanDevice({
      id: 'target',
      currentState: 'on',
      binaryControl: { on: true },
      selectedStepId: 'max',
      reportedStepId: undefined,
    }), steppedPromise('max'))).toBe(false);
  });

  it('never settles a stepped target whose reservation promised no step', () => {
    // A reservation with no step commitment has no criterion on the axis that
    // matters, so coming on is not arrival — the donors stay paid until it
    // reaches a rung or the reservation lapses.
    expect(completes(steppedPlanDevice({
      id: 'target',
      currentState: 'on',
      binaryControl: { on: true },
      reportedStepId: 'max',
      desiredStepId: undefined,
      targetStepId: undefined,
    }), BINARY_PROMISE)).toBe(false);
  });

  it('drops a reservation whose target left the plan', () => {
    const ledger = openLedger({ promise: BINARY_PROMISE, donorIds: ['lower'] });
    ledger.reconcile(new Map(), 1_000, LANE_OPEN, undefined);
    expect(holdsReservation(ledger)).toBe(false);
    expect(ledger.isDonor('lower')).toBe(false);
  });
});

describe('swap reservation blocking', () => {
  const offDevice = (id: string, priority: number): DevicePlanDevice => buildPlanDevice({
    id, name: id, priority, currentState: 'off', binaryControl: { on: false },
  });

  it('keeps a donor blocked until its reservation settles', () => {
    const incomplete = openLedger({ promise: BINARY_PROMISE, donorIds: ['lower'] });
    const deviceMap = new Map([
      ['target', offDevice('target', 1)],
      ['lower', offDevice('lower', 9)],
    ]);
    expect(incomplete.blockingTarget(deviceMap.get('lower')!, deviceMap)?.id).toBe('target');

    // Target now on, so the promise is kept and the donor is released.
    const settled = openLedger({ promise: BINARY_PROMISE, donorIds: ['lower'], planMeasurementTs: 123 });
    const onMap = new Map([
      ['target', buildPlanDevice({ id: 'target', name: 'Target', currentState: 'on', binaryControl: { on: true } })],
      ['lower', offDevice('lower', 9)],
    ]);
    expect(settled.blockingTarget(onMap.get('lower')!, onMap)).toBeUndefined();
    // The watermark outlives the reservation, so an orphan cannot re-plan the
    // same swap against the same reading.
    expect(settled.defersForMeasurement('target', 123)).toBe(true);
    expect(settled.defersForMeasurement('target', 124)).toBe(false);
  });

  it('blocks a lower-priority restore behind an incomplete equal-or-better target', () => {
    const ledger = openLedger({ promise: BINARY_PROMISE });
    const deviceMap = new Map([
      ['target', offDevice('target', 1)],
      ['lower', offDevice('lower', 9)],
    ]);
    expect(ledger.blockingTarget(deviceMap.get('lower')!, deviceMap)?.id).toBe('target');
  });

  it('does not block a higher-priority device behind a pending target', () => {
    const ledger = openLedger({ promise: BINARY_PROMISE });
    const deviceMap = new Map([
      ['target', offDevice('target', 9)],
      ['higher', offDevice('higher', 1)],
    ]);
    expect(ledger.blockingTarget(deviceMap.get('higher')!, deviceMap)).toBeUndefined();
  });

  it('does not block the target against its own reservation', () => {
    const ledger = openLedger({ promise: BINARY_PROMISE });
    const deviceMap = new Map([['target', offDevice('target', 1)]]);
    expect(ledger.blockingTarget(deviceMap.get('target')!, deviceMap)).toBeUndefined();
  });

  it('does not release a donor while the target only optimistically selected the step', () => {
    const ledger = openLedger({ promise: steppedPromise('max'), donorIds: ['lower'] });
    const deviceMap = new Map([
      ['target', steppedPlanDevice({
        id: 'target',
        name: 'Target',
        currentState: 'on',
        binaryControl: { on: true },
        selectedStepId: 'max',
        reportedStepId: 'low',
      })],
      ['lower', offDevice('lower', 9)],
    ]);
    expect(ledger.blockingTarget(deviceMap.get('lower')!, deviceMap)?.id).toBe('target');
    ledger.reconcile(deviceMap, 1_000, LANE_OPEN, undefined);
    expect(holdsReservation(ledger)).toBe(true);
    expect(ledger.isDonor('lower')).toBe(true);
  });
});

describe('re-approving a live reservation', () => {
  it('unions the donors and keeps the original ceiling basis', () => {
    // A target can be approved more than once — a boosted stepper climbing
    // rungs re-enters the swap path once its first donors are off and a fresher
    // reading lands. The earlier donors were still paused to fund it, so they
    // must stay on the reservation: replacing the set would strip their
    // `swapped_out` reason, stop them being waited on, and under-report what
    // the swap cost. And the absolute ceiling must not be pushed out by each
    // re-approval, or a re-swapping target lives forever.
    const ledger = openLedger({
      promise: steppedPromise('medium'), donorIds: ['first'], planMeasurementTs: 100, openedAtMs: 0,
    });
    ledger.open('target', steppedPromise('max'), new Set(['second']), 200, 30_000);

    expect(ledger.reservationFor('target')).toEqual({
      targetId: 'target',
      promise: steppedPromise('max'),
      donorIds: new Set(['first', 'second']),
      openedAtMs: 0,
      // A re-approval sheds again, so it goes back to waiting — but the
      // ceiling basis does not move.
      wait: { kind: 'lane_shut' },
      planMeasurementTs: 200,
    });
    expect(ledger.isDonor('first')).toBe(true);
    expect(ledger.isDonor('second')).toBe(true);
  });
});

describe('swap reservation expiry', () => {
  it('expires a reservation that has had a serviceable window, keeping the watermark', () => {
    const ledger = openLedger({
      promise: steppedPromise('max'), donorIds: ['lower'], planMeasurementTs: 123, openedAtMs: 0,
    });
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'off', binaryControl: { on: false } })],
      ['lower', buildPlanDevice({ id: 'lower', currentState: 'off', binaryControl: { on: false } })],
    ]);

    // Two cycles: the first starts the served window, the second spends it.
    ledger.reconcile(deviceMap, 1, LANE_OPEN, undefined);
    expect(holdsReservation(ledger)).toBe(true);
    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS + 2, LANE_OPEN, undefined);

    expect(holdsReservation(ledger)).toBe(false);
    expect(ledger.isDonor('lower')).toBe(false);
    expect(ledger.defersForMeasurement('target', 123)).toBe(true);
    expect(ledger.defersForMeasurement('target', 124)).toBe(false);
  });

  it('survives its first serviceable cycle even with no rebuild while the lane was shut', () => {
    // The flow-feed case. Under `power_source = flow` a rebuild happens when a
    // Flow event arrives, so a gap longer than the shed cooldown is ordinary
    // cadence — there may be NO reconcile at all between the approval and the
    // cycle the lane reopens. An earlier design renewed a deadline per shut
    // cycle, which made progress depend on receiving rebuilds: with no
    // intermediate cycle the deadline stayed at its opening value and the
    // reservation was expired on the very cycle it first became serviceable.
    const ledger = openLedger({ promise: steppedPromise('max'), donorIds: ['lower'], openedAtMs: 0 });
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'off', binaryControl: { on: false } })],
      ['lower', buildPlanDevice({ id: 'lower', currentState: 'off', binaryControl: { on: false } })],
    ]);

    // One reconcile, well past the timeout, and it is the FIRST one.
    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS + 1, LANE_OPEN, undefined);
    expect(holdsReservation(ledger)).toBe(true);
    expect(ledger.isDonor('lower')).toBe(true);

    // It now has a served window running from that cycle, and spends it.
    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS * 2 + 2, LANE_OPEN, undefined);
    expect(holdsReservation(ledger)).toBe(false);
  });

  it('charges a reservation only to a lane that could serve its own target', () => {
    // The budget-exempt lane filters candidates to exempt devices, so it can
    // never admit a non-exempt target — counting it as serviceable would burn
    // that reservation's window against a lane blind to it.
    const ledger = openLedger({ promise: steppedPromise('max'), donorIds: ['lower'], openedAtMs: 0 });
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'off', binaryControl: { on: false } })],
      ['lower', buildPlanDevice({ id: 'lower', currentState: 'off', binaryControl: { on: false } })],
    ]);
    const exemptLaneOnly = (target: DevicePlanDevice): boolean => target.budgetExempt === true;

    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS + 1, exemptLaneOnly, undefined);
    expect(holdsReservation(ledger)).toBe(true);
    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS * 3, exemptLaneOnly, undefined);
    expect(holdsReservation(ledger)).toBe(true);
  });

  it('renews rather than expires while the lane cannot serve it', () => {
    const ledger = openLedger({ promise: steppedPromise('max'), donorIds: ['lower'], openedAtMs: 0 });
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'off', binaryControl: { on: false } })],
      ['lower', buildPlanDevice({ id: 'lower', currentState: 'off', binaryControl: { on: false } })],
    ]);

    // Far past the timeout, but no restore could have been admitted — the
    // reservation has had no serviceable cycle, so it is not charged for one.
    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS * 5, LANE_SHUT, undefined);
    expect(holdsReservation(ledger)).toBe(true);
    expect(ledger.isDonor('lower')).toBe(true);

    // The clock restarts from the cycle the lane reopened, so it gets a full
    // window of real opportunity rather than none.
    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS * 5, LANE_OPEN, undefined);
    expect(holdsReservation(ledger)).toBe(true);

    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS * 6 + 1, LANE_OPEN, undefined);
    expect(holdsReservation(ledger)).toBe(false);
  });

  it('lapses at the absolute ceiling however long the lane stayed shut', () => {
    // Renewal must not become immortality: a home pinned under its daily budget
    // keeps the lane shut for hours, and a reservation held across that window
    // holds its donors shed the whole time — including against the
    // budget-exempt lane, which consults the ledger even while the ordinary
    // lane is closed.
    const ledger = openLedger({ promise: steppedPromise('max'), donorIds: ['lower'], openedAtMs: 0 });
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'off', binaryControl: { on: false } })],
      ['lower', buildPlanDevice({ id: 'lower', currentState: 'off', binaryControl: { on: false } })],
    ]);

    ledger.reconcile(deviceMap, SWAP_RESERVATION_MAX_MS - 1, LANE_SHUT, undefined);
    expect(holdsReservation(ledger)).toBe(true);

    ledger.reconcile(deviceMap, SWAP_RESERVATION_MAX_MS + 1, LANE_SHUT, undefined);
    expect(holdsReservation(ledger)).toBe(false);
    expect(ledger.isDonor('lower')).toBe(false);
  });

  it('names which clock expired a reservation', () => {
    const ceiling: Record<string, unknown>[] = [];
    const ceilingLedger = openLedger({ promise: BINARY_PROMISE, openedAtMs: 0 });
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'off', binaryControl: { on: false } })],
    ]);
    ceilingLedger.reconcile(deviceMap, SWAP_RESERVATION_MAX_MS + 1, LANE_SHUT, partialDouble<PinoLogger>({
      info: (payload: unknown) => { ceiling.push(payload as Record<string, unknown>); },
    }));
    expect(ceiling[0]).toMatchObject({
      reasonCode: 'reservation_ceiling',
      ageMs: SWAP_RESERVATION_MAX_MS + 1,
    });
  });

  it('emits one settle event naming how the reservation ended', () => {
    const kept: Record<string, unknown>[] = [];
    const keptLedger = openLedger({ promise: BINARY_PROMISE, donorIds: ['lower', 'other'] });
    const arrived = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'on', binaryControl: { on: true } })],
    ]);
    keptLedger.reconcile(arrived, 1_000, LANE_OPEN, partialDouble<PinoLogger>({
      info: (payload: unknown) => { kept.push(payload as Record<string, unknown>); },
    }));
    expect(kept).toEqual([
      { event: 'swap_settled', deviceId: 'target', outcome: 'promise_kept', donorCount: 2 },
    ]);

    // A second reconcile has nothing left to settle, so nothing is re-emitted.
    keptLedger.reconcile(arrived, 2_000, LANE_OPEN, partialDouble<PinoLogger>({
      info: (payload: unknown) => { kept.push(payload as Record<string, unknown>); },
    }));
    expect(kept).toHaveLength(1);

    const gone: Record<string, unknown>[] = [];
    const goneLedger = openLedger({ promise: BINARY_PROMISE, donorIds: ['lower'] });
    goneLedger.reconcile(new Map(), 1_000, LANE_OPEN, partialDouble<PinoLogger>({
      info: (payload: unknown) => { gone.push(payload as Record<string, unknown>); },
    }));
    expect(gone).toEqual([
      { event: 'swap_settled', deviceId: 'target', outcome: 'target_absent', donorCount: 1 },
    ]);
  });

  it('reports the age an expiry actually waited', () => {
    const ledger = openLedger({ promise: BINARY_PROMISE, openedAtMs: 0 });
    const deviceMap = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'off', binaryControl: { on: false } })],
    ]);
    const logged: Record<string, unknown>[] = [];
    // The served window opens at t=5 and is spent SWAP_TIMEOUT_MS + 7 later,
    // so `ageMs` and `servedMs` differ — which is the point of carrying both.
    ledger.reconcile(deviceMap, 5, LANE_OPEN, undefined);
    ledger.reconcile(deviceMap, SWAP_TIMEOUT_MS + 12, LANE_OPEN, partialDouble<PinoLogger>({
      info: (payload: unknown) => { logged.push(payload as Record<string, unknown>); },
    }));
    expect(logged).toEqual([
      {
        event: 'swap_stale_cleared',
        deviceId: 'target',
        ageMs: SWAP_TIMEOUT_MS + 12,
        servedMs: SWAP_TIMEOUT_MS + 7,
        reasonCode: 'served_window_expired',
      },
    ]);
  });
});

describe('swap measurement gating', () => {
  it('keeps a pending target pending against the reading it planned on', () => {
    const ledger = openLedger({ promise: BINARY_PROMISE, planMeasurementTs: 100 });
    expect(ledger.keepsPending('target', 100)).toBe(true);
    expect(ledger.keepsPending('target', 101)).toBe(false);
    expect(ledger.keepsPending('target', null)).toBe(true);
  });

  it('does not keep a device pending on watermark alone', () => {
    // A watermark with no live reservation: the shape left behind after a swap
    // COMPLETED, which is what defers the next swap on the same reading. The
    // target must still be in the plan — a target that left it has nothing left
    // to guard, so its watermark is pruned instead.
    const ledger = openLedger({ promise: BINARY_PROMISE, planMeasurementTs: 100 });
    const arrived = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'on', binaryControl: { on: true } })],
    ]);
    ledger.reconcile(arrived, 1_000, LANE_OPEN, undefined);
    expect(ledger.keepsPending('target', null)).toBe(false);
  });

  it('defers a fresh swap until a reading newer than the watermark arrives', () => {
    // A watermark with no live reservation: the shape left behind after a swap
    // COMPLETED, which is what defers the next swap on the same reading. The
    // target must still be in the plan — a target that left it has nothing left
    // to guard, so its watermark is pruned instead.
    const ledger = openLedger({ promise: BINARY_PROMISE, planMeasurementTs: 100 });
    const arrived = new Map([
      ['target', buildPlanDevice({ id: 'target', currentState: 'on', binaryControl: { on: true } })],
    ]);
    ledger.reconcile(arrived, 1_000, LANE_OPEN, undefined);
    expect(ledger.defersForMeasurement('target', null)).toBe(true);
    expect(ledger.defersForMeasurement('target', 100)).toBe(true);
    expect(ledger.defersForMeasurement('target', 101)).toBe(false);
  });

  it('does not defer a device with a live reservation', () => {
    const ledger = openLedger({ promise: BINARY_PROMISE, planMeasurementTs: 100 });
    expect(ledger.defersForMeasurement('target', 100)).toBe(false);
  });
});

