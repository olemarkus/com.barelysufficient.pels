import { isFiniteNumber } from '../utils/appTypeGuards';
import type { PowerTrackerState } from './trackerTypes';

/**
 * The one reader of the latched whole-home total for the capacity path.
 *
 * `PowerTrackerState.lastPowerW` is the single latch: `recordPowerSample`
 * writes it from the same sample that stamps `lastTimestamp`, so a consumer
 * that reads the value here and its freshness from `resolvePowerSampleFreshness`
 * is describing one sample rather than joining two. It used to be copied into
 * `CapacityGuard.mainPowerKw` as well, which is exactly the join that could
 * disagree.
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
 * `SuffixedTrackerPersistence.resetFreshness`, which clears `lastPowerW` and
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
 * The latched sample's stamp, for consumers that exist only behind the
 * measurement gate (a plan build, a status write computed from one). The gate
 * (`hasPowerMeasurement`) implies a latched sample, and ingest stamps
 * `lastTimestamp` with `lastPowerW` on the same write — so absence here is a
 * gate violation, and it fails loud instead of handing a nullable onward.
 */
export function requireLastSampleAtMs(
  powerTracker: Pick<PowerTrackerState, 'lastPowerW' | 'lastTimestamp'>,
): number {
  const lastTimestamp = powerTracker.lastTimestamp;
  if (!isFiniteNumber(lastTimestamp)) {
    throw new Error('power sample stamp required — a gated consumer read an unsampled tracker');
  }
  return lastTimestamp;
}
