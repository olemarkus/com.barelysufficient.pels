import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import type { PowerTrackerState } from './trackerTypes';
import { resolveFrozenSinceMs, resolveSuspectSinceMs } from './heldReading';

/**
 * The one reader of the latched whole-home total for the capacity path.
 *
 * `PowerTrackerState.lastPowerW` is the single latch: `recordPowerSample`
 * writes it from the same sample that stamps `lastTimestamp` and the held
 * reading, so a consumer that reads the value here and its age from
 * `resolveMeterEvidenceAtMs` is describing one sample rather than joining
 * two. It used to be copied into `CapacityGuard.mainPowerKw` as well, which is
 * exactly the join that could disagree.
 *
 * `null` means no trustworthy reading: either no sample has landed yet, or the
 * meter identity changed and the freshness reset cleared the latch
 * (`resetPersistedHomeTrackerFreshness`). Junk is gated here rather than at each
 * caller, so a non-finite latch can never reach a sum, comparison or control
 * decision.
 *
 * The value is **signed and unfloored** on purpose: it is net grid import, so it
 * legitimately goes negative while exporting, and `headroom = limit - total`
 * must grow when it does. Do not clamp it
 * (`notes/safe-pace-two-constraints.md` § "P_nonExempt is signed").
 */
export function resolveLastTotalPowerKw(
  powerTracker: Pick<PowerTrackerState, 'lastPowerW'>,
): number | null {
  const lastPowerW = powerTracker.lastPowerW;
  return isFiniteNumber(lastPowerW) ? lastPowerW / 1000 : null;
}

/**
 * Whether this home has a meter measurement to plan from at all — the
 * `planBuildGate`'s predicate (`lib/power/powerMeasurementGate.ts`).
 *
 * False only before the meter's first reading, and again once a freshness reset
 * clears the latch. It is NOT a freshness question: an old reading is still a
 * measurement, and what a doubtful one means is decided here in `lib/power`,
 * never by a consumer.
 *
 * Asked of the tracker rather than of `CapacityGuard`, because the tracker is
 * the single power latch — and because the guard's `resetLastTotalPower`, which
 * the gate's own docblock named as the meter-swap mechanism, never had a
 * production caller. The reset that does run on an in-place swap is
 * `HomeTrackerPersistence.resetFreshness`, which clears `lastPowerW` and
 * `lastTimestamp` together, so this answers false again exactly when it should.
 */
export function hasPowerMeasurement(
  powerTracker: Pick<PowerTrackerState, 'lastPowerW' | 'lastTimestamp'>,
): boolean {
  // BOTH halves of the latch: ingest writes them together, so a persisted
  // blob carrying one without the other is a half-latch no real sample
  // produced — the gate stays shut on it, exactly matching the reading
  // resolver's own invariant (`resolvePowerCycleReading` fails loud on a
  // half-latch reaching a build).
  return resolveLastTotalPowerKw(powerTracker) !== null
    && isFiniteNumber(powerTracker.lastTimestamp);
}

/**
 * The latched whole-home total, for consumers reached only from an ADMITTED
 * sample — the tracker persists `lastPowerW` before it awaits them, and every
 * producer into `recordPowerSample` finiteness-gates its watts first (the Flow
 * card via `readFlowNumberArg`, Homey Energy via `extractLiveMeterPowerWatts`).
 * So absence here is a contract violation, not a reading to interpret, and it
 * fails loud rather than handing a nullable — or a fabricated stand-in — onward.
 * The twin of `requireDisplayedPowerUpdateMs` below, and of `resolvePowerCycleReading`.
 */
export function requireLastTotalPowerKw(
  powerTracker: Pick<PowerTrackerState, 'lastPowerW'>,
): number {
  const totalKw = resolveLastTotalPowerKw(powerTracker);
  if (totalKw === null) {
    throw new Error('whole-home total required — a consumer of an admitted sample read an unsampled tracker');
  }
  return totalKw;
}

/**
 * The displayed power-update stamp (`resolveDisplayedPowerUpdateMs`), for
 * consumers that exist only behind the measurement gate (a status write
 * computed from a plan build). The gate (`hasPowerMeasurement`) implies a
 * latched sample, so absence here is a gate violation, and it fails loud
 * instead of handing a nullable onward.
 */
export function requireDisplayedPowerUpdateMs(powerTracker: PowerTrackerState): number {
  const stamp = resolveDisplayedPowerUpdateMs(powerTracker);
  if (stamp === undefined) {
    throw new Error('power update stamp required — a gated consumer read an unsampled tracker');
  }
  return stamp;
}

/**
 * The newest evidence that the whole-home meter is alive, as control counts it
 * — the stamp the silence policy and the cycle reading age. Every admitted
 * sample is that evidence, except once the reading is frozen: held on one value
 * the home's measured load has contradicted for ten minutes
 * (`lib/power/heldReading.ts`). Then it is only as current as the moment the
 * reading took that value. `undefined` when nothing is latched.
 */
export function resolveMeterEvidenceAtMs(powerTracker: PowerTrackerState): number | undefined {
  const stamp = resolveFrozenSinceMs(powerTracker) ?? powerTracker.lastTimestamp;
  return isFiniteNumber(stamp) ? stamp : undefined;
}

/**
 * The same stamp as the owner is shown it — by the no-readings banner, the
 * headroom widget and the published status. It moves back to when the reading
 * took its value as soon as the reading is suspect, well before control treats
 * it as silent, so the owner hears of a meter that looks dead before PELS acts
 * on it, and hears of one control never acts on (a load that came back before
 * the reading froze). `undefined` when nothing is latched.
 */
export function resolveDisplayedPowerUpdateMs(powerTracker: PowerTrackerState): number | undefined {
  const stamp = resolveSuspectSinceMs(powerTracker) ?? powerTracker.lastTimestamp;
  return isFiniteNumber(stamp) ? stamp : undefined;
}
