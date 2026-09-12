import { SwapLedger, type SwapPromise } from '../../lib/plan/swap';
import type { PlanEngineState } from '../../lib/plan/planState';

/**
 * Seeding and reading swap reservations in specs.
 *
 * Specs used to hand-build `state.swapByDevice` as a record of six-optional
 * `SwapEntry` values and assert on `result.stateUpdates.swapByDevice`. Both are
 * gone: the ledger is the model, held live on `PlanEngineState`, so a spec
 * opens a reservation the way the planner does and reads it back off the same
 * object it handed in.
 */

export const steppedPromise = (stepId: string): SwapPromise => ({ kind: 'stepped', stepId });
export const binaryPromise: SwapPromise = { kind: 'binary' };

/** Open one reservation on a state's ledger, the way an approved swap does. */
export function seedSwapReservation(
  state: PlanEngineState,
  params: {
    targetId: string;
    promise?: SwapPromise;
    donorIds?: readonly string[];
    planMeasurementTs?: number;
    openedAtMs?: number;
  },
): void {
  state.swapLedger.open(
    params.targetId,
    params.promise ?? binaryPromise,
    new Set(params.donorIds ?? []),
    params.planMeasurementTs ?? 0,
    params.openedAtMs ?? Date.now(),
  );
}

/** A ledger with one reservation, for consumers that take a ledger directly. */
export function ledgerWithReservation(params: {
  targetId: string;
  promise?: SwapPromise;
  donorIds?: readonly string[];
  planMeasurementTs?: number;
  openedAtMs?: number;
}): SwapLedger {
  const ledger = new SwapLedger();
  ledger.open(
    params.targetId,
    params.promise ?? binaryPromise,
    new Set(params.donorIds ?? []),
    params.planMeasurementTs ?? 0,
    params.openedAtMs ?? Date.now(),
  );
  return ledger;
}

/** Whether a target still holds a reservation — the old `pendingTarget`. */
export const hasReservation = (state: PlanEngineState, targetId: string): boolean => (
  state.swapLedger.reservationFor(targetId) !== undefined
);

/** The target a donor was paused to fund — the old `swappedOutFor`. */
export const swappedOutFor = (state: PlanEngineState, donorId: string): string | undefined => (
  state.swapLedger.reservationHolding(donorId)?.targetId
);

/**
 * Drop every live reservation while keeping the plan watermarks — the state a
 * swap leaves behind once it has resolved, whether by completing or lapsing.
 *
 * Typed element access into the private map on purpose (`AGENTS.md` § testing
 * rules): a spec that needs this shape is simulating a resolution it cannot
 * reach through `reconcile` without also advancing the meter, which is the very
 * thing it is holding still. A production rename still breaks it.
 */
export function settleReservationsKeepingWatermarks(state: PlanEngineState): void {
  state.swapLedger['reservations'].clear();
}

/**
 * Seed a plan watermark with no live reservation — the orphan shape a resolved
 * swap leaves behind, which defers the next swap on the same meter reading.
 * Typed element access for the same reason as above.
 */
export function seedPlanWatermark(state: PlanEngineState, deviceId: string, measurementTs: number): void {
  state.swapLedger['planWatermarks'].set(deviceId, measurementTs);
}

/** Whether any reservation is live at all — the old `swapByDevice` being `{}`. */
export const hasAnyReservation = (state: PlanEngineState): boolean => (
  state.swapLedger['reservations'].size > 0
);

/**
 * Seed a reservation whose served window is already running, and started long
 * enough ago that the next reconcile spends it.
 *
 * A plain `seedSwapReservation` is NOT stale however far back `openedAtMs` is
 * put: the timeout runs from the moment a lane able to serve the reservation
 * was first seen, not from its approval — which is the whole point of the
 * two clocks. A spec that wants the expiry path has to say the window ran.
 */
export function seedServedSwapReservation(
  state: PlanEngineState,
  params: {
    targetId: string;
    promise?: SwapPromise;
    donorIds?: readonly string[];
    planMeasurementTs?: number;
    servedSinceMs: number;
  },
): void {
  seedSwapReservation(state, { ...params, openedAtMs: params.servedSinceMs });
  const reservations = state.swapLedger['reservations'];
  const opened = reservations.get(params.targetId);
  if (opened === undefined) throw new Error('fixture: reservation was not opened');
  reservations.set(params.targetId, { ...opened, wait: { kind: 'serving', sinceMs: params.servedSinceMs } });
}
