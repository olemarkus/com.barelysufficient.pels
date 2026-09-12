import type { Logger as PinoLogger } from '../../logging/logger';
import { SWAP_RESERVATION_MAX_MS, SWAP_TIMEOUT_MS } from '../planConstants';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { getSteppedLoadStep } from '../../utils/deviceControlProfiles';
import type { DevicePlanDevice } from '../planTypes';

/**
 * A swap is ONE thing: a reservation a higher-priority device holds over the
 * draw of lower-priority devices paused to fund it.
 *
 * This is the MODEL, held live on `PlanEngineState` beside `RestoreBackoff` and
 * `ShedDecisions` — not a per-cycle projection of a record. It was briefly the
 * latter, and the renewable clock below is exactly why that cannot work: a DTO
 * with one timestamp slot cannot carry two clocks, so every renewal was
 * discarded microseconds after it was written and the reservation expired on
 * the first cycle the lane reopened. The state is in-process only (it dies with
 * the process, like every other planner clock), so there is no transport seam
 * to project across and nothing to validate on the way in.
 *
 * It used to be five parallel collections keyed by device id —
 * `pendingSwapTargets`, `pendingSwapTimestamps`, `swappedOutFor`,
 * `lastSwapPlanMeasurementTs`, `requestedTargetByDevice` — mutated by thirteen
 * free functions that each took the bag as their first argument, eight of them
 * tearing down some subset of it. Nothing represented "a swap", so every call
 * site re-derived which maps to touch (hence `clearSwapTarget` beside
 * `clearSwapTargetPreservingMeasurement`), and no invariant about a swap's
 * lifetime had anywhere to live. The one that mattered was consequently absent:
 * a reservation's clock must run only while the restore lane can serve it.
 *
 * Two clocks, because one is not enough. `wait` records WHEN the lane first
 * became able to serve this reservation, and the timeout runs from there, so it
 * bounds serviceable time rather than elapsed time. `openedAtMs` feeds an
 * absolute ceiling, so waiting cannot become immortality while a home sits
 * pinned under its budget for hours.
 *
 * `wait` is an observed transition, NOT a per-cycle renewal. Renewal was the
 * first attempt and it is wrong for the reason `AGENTS.md` gives directly: it
 * makes progress depend on RECEIVING rebuilds, and under `power_source = flow`
 * a gap between samples is ordinary cadence. A swap opened at t=0 with no
 * sample until t=60_001 would see its first serviceable cycle and be expired
 * on it against a deadline set before the lane ever shut — the original defect,
 * reproduced.
 *
 * Reservation state carries no optional fields. A reservation that cannot name
 * its target, its promise, its donors and its deadline is not one.
 */

/**
 * How completion is decided — the axis the promise was made on, captured once
 * at approval rather than re-derived per cycle from a four-deep `??` chain over
 * two optional step fields on the device and two more on the reservation.
 */
export type SwapPromise =
  | { readonly kind: 'binary' }
  | { readonly kind: 'stepped'; readonly stepId: string };

/**
 * Whether a lane that could serve THIS reservation has been seen yet, and if so
 * since when. The timeout runs from `sinceMs`, so a reservation that has never
 * been offered a serviceable cycle cannot run out of one.
 */
export type SwapWait =
  | { readonly kind: 'lane_shut' }
  | { readonly kind: 'serving'; readonly sinceMs: number };

export type SwapReservation = {
  readonly targetId: string;
  readonly promise: SwapPromise;
  readonly donorIds: ReadonlySet<string>;
  /** When the reservation was approved. Basis of the absolute ceiling. */
  readonly openedAtMs: number;
  readonly wait: SwapWait;
  /** The meter reading this reservation was planned against. */
  readonly planMeasurementTs: number;
};

/**
 * The promise a device's admitted plan update encodes: a stepped target
 * promises a rung, anything else promises only that it comes on.
 */
export function resolveSwapPromise(admittedUpdate: Partial<DevicePlanDevice>): SwapPromise {
  const stepId = admittedUpdate.targetStepId ?? admittedUpdate.desiredStepId;
  return stepId === undefined ? { kind: 'binary' } : { kind: 'stepped', stepId };
}

export class SwapLedger {
  /** Keyed by TARGET: at most one reservation per beneficiary. */
  private readonly reservations = new Map<string, SwapReservation>();

  /**
   * The last reading each device planned a swap against. Deliberately outlives
   * its reservation — it is what stops a device re-planning the same swap
   * against the same reading, which is why the old code needed two
   * near-identical clear functions to carry it through a teardown.
   */
  private readonly planWatermarks = new Map<string, number>();

  /**
   * Open a reservation, or EXTEND the one this target already holds. Replaces
   * four separate marking calls plus a builder.
   *
   * Extending matters because a target can be approved more than once: once its
   * first donors are confirmed off and a fresher reading lands, a boosted
   * stepped device climbing rungs re-enters `attemptSwapRestore` and swaps
   * again. The old model accumulated — `markDeviceSwappedOutFor` added to a
   * shared `swappedOutFor` map, so the target owned every donor it had ever
   * cost. A plain `set` here would instead drop the earlier donors: they would
   * lose their `swapped_out` reason for the priority rule's `swap_pending`,
   * stop being waited on by `hasPendingSwapSourcesStillOn`, vanish from
   * `swap_settled.donorCount` — the number that event exists to make auditable
   * — and reset `openedAtMs`, so each re-approval would push the absolute
   * ceiling further out.
   *
   * So the donor set unions and `openedAtMs` is preserved. The serviceable
   * window and the plan watermark DO advance: a re-approval is fresh work
   * against a fresh reading, which is exactly what that clock measures.
   */
  open(
    targetId: string,
    promise: SwapPromise,
    donorIds: ReadonlySet<string>,
    planMeasurementTs: number,
    nowMs: number,
  ): void {
    const existing = this.reservations.get(targetId);
    this.reservations.set(targetId, {
      targetId,
      promise,
      donorIds: existing === undefined ? donorIds : union(existing.donorIds, donorIds),
      openedAtMs: existing?.openedAtMs ?? nowMs,
      // Opening is never itself a served cycle: the approval sheds donors, and
      // the executor's shed arms the cooldown that shuts the restore lane. So a
      // reservation starts waiting, and its served window begins at the first
      // reconcile that sees a lane able to serve it. A re-approval resets the
      // wait for the same reason — it sheds again — while `openedAtMs` above
      // keeps the ceiling anchored to the original approval.
      wait: { kind: 'lane_shut' },
      planMeasurementTs,
    });
    this.planWatermarks.set(targetId, planMeasurementTs);
  }

  /**
   * Once per cycle: settle what has landed, expire what has had its chance.
   *
   * `laneServes` answers, per target, whether a lane that could admit THAT
   * device ran this cycle. Per target and not once per cycle, because the
   * budget-exempt lane filters its candidates to budget-exempt devices: a
   * non-exempt reservation surviving into a daily-budget shed would otherwise
   * burn its window against a lane that could never consider it.
   *
   * While no such lane has run, the reservation cannot make progress and is
   * not charged for the time — otherwise it dies without ever having been
   * offered the lane, and takes its donors' sacrifice with it.
   *
   * `SWAP_RESERVATION_MAX_MS` bounds the wait: past the ceiling a reservation
   * lapses however shut the lane has been, because one held across an
   * hours-long budget pin keeps its donors shed the whole time. The logged
   * `reasonCode` says which of the two clocks fired.
   */
  reconcile(
    deviceMap: ReadonlyMap<string, DevicePlanDevice>,
    nowMs: number,
    laneServes: (target: DevicePlanDevice) => boolean,
    structuredLog: PinoLogger | undefined,
  ): void {
    // Iterating the live map is safe: `set` on an existing key preserves
    // insertion order, and deleting the current or an unvisited key is defined
    // behaviour. A snapshot copy here allocated on every rebuild for nothing.
    for (const reservation of this.reservations.values()) {
      if (this.settleIfKept(reservation.targetId, deviceMap, structuredLog)) continue;
      const target = deviceMap.get(reservation.targetId);
      if (target === undefined) continue;
      const wait = resolveWait(reservation.wait, laneServes(target), nowMs);
      if (this.lapseIfSpent(reservation, wait, nowMs, structuredLog)) continue;
      if (wait !== reservation.wait) this.reservations.set(reservation.targetId, waiting(reservation, wait));
    }
  }

  /**
   * End the reservation if either clock has run out, and say which one did.
   *
   * `ageMs` is total age INCLUDING every cycle the lane was shut; `servedMs` is
   * the served window that ran out. Both, because they answer different
   * questions: whether 60 s of opportunity was too little, or whether the
   * reservation simply sat behind a shut lane for 15 minutes.
   */
  private lapseIfSpent(
    reservation: SwapReservation,
    wait: SwapWait,
    nowMs: number,
    structuredLog: PinoLogger | undefined,
  ): boolean {
    const servedOut = wait.kind === 'serving' && nowMs > wait.sinceMs + SWAP_TIMEOUT_MS;
    const lapsed = nowMs > reservation.openedAtMs + SWAP_RESERVATION_MAX_MS;
    if (!servedOut && !lapsed) return false;
    structuredLog?.info({
      event: 'swap_stale_cleared',
      deviceId: reservation.targetId,
      ageMs: nowMs - reservation.openedAtMs,
      servedMs: wait.kind === 'serving' ? nowMs - wait.sinceMs : 0,
      // `served_window_expired` is the case where a lane that could serve it
      // WAS open and the target failed to arrive; `reservation_ceiling` is the
      // case where one never opened for long enough.
      reasonCode: servedOut ? 'served_window_expired' : 'reservation_ceiling',
    });
    this.reservations.delete(reservation.targetId);
    return true;
  }

  /**
   * Drop the reservation if its target has arrived, or if the target is gone
   * from the plan entirely. Returns whether the reservation is now settled.
   *
   * Queried mid-pass as well as at reconcile, because a target can be admitted
   * during the cycle and its donors must be released against the same rule —
   * one owner for "has this swap finished", rather than the old inline clears
   * scattered through the blocking predicates.
   */
  private settleIfKept(
    targetId: string,
    deviceMap: ReadonlyMap<string, DevicePlanDevice>,
    structuredLog: PinoLogger | undefined,
  ): boolean {
    const reservation = this.reservations.get(targetId);
    if (reservation === undefined) return true;
    const target = deviceMap.get(targetId);
    if (target === undefined) {
      // The device left the plan, so its watermark has nothing left to guard.
      // The old `clearMissingSwapTarget` pruned this; keeping it would grow one
      // entry per device that was ever a swap target, for the process lifetime.
      this.reservations.delete(targetId);
      this.planWatermarks.delete(targetId);
      this.emitSettled(reservation, 'target_absent', structuredLog);
      return true;
    }
    if (isPromiseKept(target, reservation.promise)) {
      this.reservations.delete(targetId);
      this.emitSettled(reservation, 'promise_kept', structuredLog);
      return true;
    }
    return false;
  }

  /**
   * The happy path used to be silent, which is why 34.5 h of production logs
   * could not distinguish a swap system with a 0% completion rate from a
   * healthy one: only expiry emitted, so "16 stale clears" read the same as
   * "16 completions and no clears".
   */
  private emitSettled(
    reservation: SwapReservation,
    outcome: 'promise_kept' | 'target_absent',
    structuredLog: PinoLogger | undefined,
  ): void {
    structuredLog?.info({
      event: 'swap_settled',
      deviceId: reservation.targetId,
      outcome,
      donorCount: reservation.donorIds.size,
    });
  }

  /**
   * The target whose reservation keeps `dev` shed this cycle, if any: either
   * `dev` was paused to fund it, or it is pending at an equal-or-better
   * priority and so outranks `dev`'s own restore.
   *
   * Returns the blocking TARGET rather than marking `dev` itself. The marking
   * is the restore lane's job — doing it here is what made `swap/` import
   * `../restore/helpers`, a back-edge that made these two directories mutually
   * dependent for one `setRestorePlanDevice` call.
   */
  blockingTarget(
    dev: DevicePlanDevice,
    deviceMap: ReadonlyMap<string, DevicePlanDevice>,
  ): DevicePlanDevice | undefined {
    const holder = this.reservationHolding(dev.id);
    if (holder !== undefined && !this.settleIfKept(holder.targetId, deviceMap, undefined)) {
      return deviceMap.get(holder.targetId);
    }
    if (this.reservations.has(dev.id)) return undefined;
    const devPriority = dev.priority ?? 100;
    for (const reservation of this.reservations.values()) {
      // `settleIfKept` owns "has this swap finished", absent target included —
      // a second, quieter definition here would drop the watermark prune and
      // the settle event that branch is responsible for.
      if (this.settleIfKept(reservation.targetId, deviceMap, undefined)) continue;
      const target = deviceMap.get(reservation.targetId);
      if (target === undefined || (target.priority ?? 100) > devPriority) continue;
      return target;
    }
    return undefined;
  }

  reservationFor(targetId: string): SwapReservation | undefined {
    return this.reservations.get(targetId);
  }

  /** The reservation `donorId` was paused to fund. */
  reservationHolding(donorId: string): SwapReservation | undefined {
    for (const reservation of this.reservations.values()) {
      if (reservation.donorIds.has(donorId)) return reservation;
    }
    return undefined;
  }

  isDonor(donorId: string): boolean {
    return this.reservationHolding(donorId) !== undefined;
  }

  /**
   * A pending target stays pending until a reading fresher than the one it
   * planned against lands — re-admitting it against the same reading would
   * double-count the draw its own swap just freed.
   */
  keepsPending(targetId: string, measurementTs: number | null): boolean {
    const reservation = this.reservations.get(targetId);
    if (reservation === undefined) return false;
    if (measurementTs === null) return true;
    return measurementTs <= reservation.planMeasurementTs;
  }

  /**
   * A device with no live reservation but a watermark must still wait for a
   * fresher reading before planning another swap against the same one.
   */
  defersForMeasurement(deviceId: string, measurementTs: number | null): boolean {
    if (this.reservations.has(deviceId)) return false;
    const watermark = this.planWatermarks.get(deviceId);
    if (watermark === undefined) return false;
    return measurementTs === null || measurementTs <= watermark;
  }
}

/**
 * The served window starts the first time a lane that could serve this
 * reservation is seen, and is not restarted while one keeps running. It resets
 * only when the lane closes again, which is a real loss of opportunity rather
 * than a missed sample.
 */
function resolveWait(current: SwapWait, laneOpen: boolean, nowMs: number): SwapWait {
  if (!laneOpen) return current.kind === 'lane_shut' ? current : { kind: 'lane_shut' };
  return current.kind === 'serving' ? current : { kind: 'serving', sinceMs: nowMs };
}

/** Donor sets merge rather than replace — see `open`. */
function union(left: ReadonlySet<string>, right: ReadonlySet<string>): ReadonlySet<string> {
  const merged = new Set(left);
  for (const id of right) merged.add(id);
  return merged;
}

/** The same reservation carrying a new wait state. */
function waiting(reservation: SwapReservation, wait: SwapWait): SwapReservation {
  return {
    targetId: reservation.targetId,
    promise: reservation.promise,
    donorIds: reservation.donorIds,
    openedAtMs: reservation.openedAtMs,
    wait,
    planMeasurementTs: reservation.planMeasurementTs,
  };
}

/**
 * Completion from CONFIRMED evidence only. A stepped target's `reportedStepId`
 * is the device's own word; `selectedStepId` can be an observer-resolved
 * planning fallback that has not materialized, and treating that as arrival
 * releases the donors before the target actually draws.
 */
function isPromiseKept(target: DevicePlanDevice, promise: SwapPromise): boolean {
  // A step-only stepper has no binary handle, so its completion is decided
  // entirely on the step axis — it must not be short-circuited here for being
  // non-binary, or its donors are held until the reservation times out.
  if (isBinaryPlanDevice(target) && !target.currentOn) return false;
  if (!isSteppedLoadDevice(target)) return isBinaryPlanDevice(target);
  // A stepped target whose reservation carries no step commitment has no
  // criterion on the axis that matters, so it never completes. Holding the
  // donors is the conservative read: releasing them for a target that only
  // came on, without reaching the rung the swap was approved for, gives the
  // power back before the beneficiary has actually claimed it.
  if (promise.kind === 'binary') return false;
  const promised = getSteppedLoadStep(target.steppedLoadProfile, promise.stepId);
  const reported = getSteppedLoadStep(target.steppedLoadProfile, target.reportedStepId);
  if (!promised || !reported) return false;
  return reported.planningPowerW >= promised.planningPowerW;
}
