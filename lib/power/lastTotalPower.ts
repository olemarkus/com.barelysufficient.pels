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
