import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes';
import { hasRecordedAnyExport } from './exhibitedExport';

/**
 * Can this home's solar-surplus pool ever be non-zero?
 *
 * The pool is `-signedNetKw + addBack + max(0, inferredSurplusKw)`
 * (`composeSurplusPool`), and `addBack` only ever returns power an already-
 * absorbing device is drawing — it cannot open the pool by itself. So the pool
 * is reachable exactly when the home can produce EITHER measured export OR an
 * inferred curtailment term.
 *
 * This gates the standing `surplusOnly` posture, and the question is not
 * academic: a device stamped `surplusOnly` in a home whose pool can never open
 * is held OFF **forever** by `resolveSurplusHold`, with no time-based escape and
 * no UI recourse. That is the failure this predicate exists to prevent — it once
 * shipped as a source-name gate (`meteredPowerSource`), which was correct in
 * effect and wrong in reasoning, and its removal re-opened the trap for every
 * flow home whose Flow predates signed watts.
 *
 * Deliberately a RUNTIME fact about accumulated evidence, never the configured
 * power source: both sources report signed net, and production reaches both, so
 * a flow home sending `import − export` is as capable of surplus as a Homey
 * Energy one. What differs is what the home has actually been observed to do.
 *
 * Both disjuncts are load-bearing — neither alone is safe:
 * - Export alone would deadlock a ZERO-EXPORT home, whose inverter throttles so
 *   net pins ~0 and measured export never appears. That is precisely the home
 *   `lib/solar/curtailmentSurplus.ts` exists to serve, so gating on export alone
 *   would trade one permanent hold for another.
 * - Curtailment alone would exclude a plainly exporting home whose estimator is
 *   dormant (no co-temporal production reading, e.g. any flow home today).
 *
 * The export half uses `hasRecordedAnyExport`, deliberately NOT the 1 kWh
 * materiality floor that gates the export-PRICE surfaces. The question here is
 * whether the feed can express export AT ALL, and a single recorded negative
 * sample settles it. The materiality floor would instead blank the posture for
 * the first ~20 minutes of a home's first sunny afternoon — precisely when the
 * owner is watching to see whether the feature they just enabled works.
 *
 * Absence resolves FALSE. That is the better default, but NOT a free one, and it
 * should not be read as passive: an unstamped device rejoins the generic managed
 * binary restore lane, which will turn it ON from grid headroom. So a wrong
 * `false` spends money, while a wrong `true` holds the device off indefinitely.
 * Indefinite beats recoverable, hence the direction — but both disjuncts must be
 * durable rather than merely correct while the process is up, which is why the
 * curtailment latch is persisted (`CurtailmentPersistedHoldState.armed`).
 */
export const resolveSurplusPoolReachable = (params: {
  tracker: PowerTrackerState | null | undefined;
  /**
   * Whether the curtailment-surplus estimator can STRUCTURALLY contribute for
   * this home — resolved by the estimator itself
   * (`CurtailmentSurplusEstimator.canContributeSurplus`), which owns the notion.
   * Its transient nulls (stale co-sample, import latch, refute hold) are
   * deliberately NOT folded in: those come and go by the minute, and a posture
   * that flapped with them would turn a dump load on and off all afternoon.
   */
  curtailmentCanContribute: boolean;
}): boolean => (
  hasRecordedAnyExport(params.tracker) || params.curtailmentCanContribute
);
