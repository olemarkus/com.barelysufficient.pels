// Wiring for the curtailment-surplus estimator (zero-export homes): joins the
// learned PV forecast (lib/solar), the transport's battery awareness
// (lib/device), and the plan engine's live surplus-lift state (lib/plan) into
// the flat deps the SDK-free estimator consumes. Lives in the neutral wiring
// layer so none of those domains depends on the others — lib/plan ↔ lib/solar
// edges are banned outright (dep-cruiser `no-plan-solar-coupling`); the term
// crosses into the planner only as the flat `getCurtailedSurplusKw` getter on
// the app context (late-bound in `createPlanEngine`).

import { CurtailmentSurplusEstimator, type CurtailmentPotential } from '../../lib/solar/curtailmentSurplus';
import { createCurtailmentHoldStore } from '../curtailmentHoldStateAdapter';
import { getLogger } from '../../lib/logging/logger';
import { isFiniteNumber } from '../../lib/utils/appTypeGuards';
import type { AppContext } from '../../lib/app/appContext';
import type { PvForecastController } from './createPvForecastService';

/**
 * Construct the curtailment-surplus estimator over the app context. The caller
 * (`AppServiceWiring.startPostStartupBackgroundTasks`) assigns its two seams
 * onto `ctx` (`recordCurtailmentSample` for the power pipeline,
 * `getCurtailedSurplusKw` for the plan wiring's late-bound getter). Push-fed
 * (no timers of its own), so there is no uninit handling. Called post-startup,
 * after the PV forecast exists; until then both ctx members are unset and every
 * consumer no-ops / reads null (fail-closed, the same post-boot precedent as
 * the budget-price PV inputs).
 */
// The estimator reads the potential on every 10 s pipeline tick, but each tick
// also feeds the PV forecast a sample, which invalidates its fit memo — an
// unmemoized read would re-fit over the whole 90-day history every tick (hot-path
// CPU on a cpuwarn-sensitive Homey). The potential only moves on the hourly
// irradiance grid / 3-hourly refresh / slow fit drift, so a short TTL loses
// nothing. Dogfood-tunable.
const POTENTIAL_MEMO_TTL_MS = 30_000;

export function wireCurtailmentSurplus(
  ctx: AppContext,
  getPvForecast: () => PvForecastController | undefined,
): CurtailmentSurplusEstimator {
  let potentialMemo: { hourStartMs: number; atMs: number; value: CurtailmentPotential | null } | undefined;
  const resolvePotential = (hourStartMs: number): CurtailmentPotential | null => {
    const service = getPvForecast()?.service;
    if (!service) return null;
    const kwh = service.forecast([hourStartMs])[0]?.generationKwh;
    const confidence = service.getFit()?.confidence;
    if (!isFiniteNumber(kwh) || confidence === undefined) return null;
    return { kw: kwh, confidence };
  };
  return new CurtailmentSurplusEstimator({
    // Forecast potential for a UTC hour-start: the 1-hour forecast kWh IS the
    // mean kW over that hour; the fit's confidence rides along so the estimator
    // can resolve its discount. Null (fail-closed) when the forecast is not yet
    // wired/armed, has no fit, or skips the hour (no forecast irradiance).
    getPotential: (hourStartMs): CurtailmentPotential | null => {
      const nowMs = Date.now();
      if (
        potentialMemo
        && potentialMemo.hourStartMs === hourStartMs
        && nowMs - potentialMemo.atMs < POTENTIAL_MEMO_TTL_MS
      ) {
        return potentialMemo.value;
      }
      const value = resolvePotential(hourStartMs);
      potentialMemo = { hourStartMs, atMs: nowMs, value };
      return value;
    },
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
