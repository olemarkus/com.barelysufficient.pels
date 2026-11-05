// Wiring for the curtailment-surplus estimator (zero-export homes): joins the
// selected PV forecast (lib/solar), the transport's battery awareness
// (lib/device), and the plan engine's live surplus-lift state (lib/plan) into
// the flat deps the SDK-free estimator consumes. Lives in the neutral wiring
// layer so none of those domains depends on the others — lib/plan ↔ lib/solar
// edges are banned outright (dep-cruiser `no-plan-solar-coupling`); the term
// crosses into the planner only as the flat `getCurtailedSurplusKw` getter on
// the app context (late-bound in `createPlanEngine`).

import { CurtailmentSurplusEstimator } from '../../lib/solar/curtailmentSurplus';
import { createCurtailmentPotentialRead } from '../../lib/solar/curtailmentPotential';
import { createCurtailmentHoldStore } from '../curtailmentHoldStateAdapter';
import { getLogger } from '../../lib/logging/logger';
import type { AppContext } from '../../lib/app/appContext';
import type { SelectedPvForecast } from '../../lib/solar/pvForecastSource';

/**
 * Construct the curtailment-surplus estimator over the app context. The caller
 * (`AppServiceWiring.startPostStartupBackgroundTasks`) assigns its two seams
 * onto `ctx` (`recordCurtailmentSample` for the power pipeline,
 * `getCurtailedSurplusKw` for the plan wiring's late-bound getter). Push-fed
 * (no timers of its own), so there is no uninit handling. Called post-startup,
 * after the PV forecast exists; until then both ctx members are unset and every
 * consumer no-ops / reads null (fail-closed, the same post-boot precedent as
 * the budget-price PV inputs). The selected forecast is passed in already
 * resolved — this wiring never sees a "not selected yet" state.
 */
export function wireCurtailmentSurplus(
  ctx: AppContext,
  getSelectedPvForecast: () => SelectedPvForecast,
): CurtailmentSurplusEstimator {
  const potential = createCurtailmentPotentialRead(getSelectedPvForecast);
  return new CurtailmentSurplusEstimator({
    getPotential: potential.getPotential,
    hasHomeBattery: () => ctx.deviceManager?.hasBatteryDevices() ?? false,
    // "The lift is engaged" = at least one device's surplus raise is the BINDING
    // cause of its planned target — the post-normalization `surplusAbsorbActive`
    // bit (the same field the UI reads), NOT bare eligibility. A device can be
    // eligible while the raise adds no load: a sub-step `surplusDelta` rounds back
    // to the same setpoint, or a deadline/other floor already sets an equal/higher
    // target. Verifying against eligibility would open (and falsely confirm) a
    // window with no added draw, and leave `lastLiftEngaged` stuck true so a later
    // change that finally raises the target would start unverified.
    isSurplusLiftEngaged: () => Object.values(
      ctx.planEngine?.state.surplusAbsorbActiveByDevice ?? {},
    ).some((active) => active === true),
    // Refute-ladder persistence (crash-loop resilience): transition-only writes,
    // junk-tolerant boot read — see setup/curtailmentHoldStateAdapter.ts.
    holdStore: createCurtailmentHoldStore(ctx.homey.settings),
    logger: getLogger('solar'),
  });
}
