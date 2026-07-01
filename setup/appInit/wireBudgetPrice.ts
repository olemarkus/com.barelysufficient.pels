// Composes the forecast self-consumable solar surplus and injects it as the
// planning-price (budgetPrice) input — the cross-module seam that joins the PV
// forecast (lib/solar), the daily-budget gross background (lib/dailyBudget), and
// the price layer (lib/price). Lives in the neutral wiring layer so none of those
// domains depends on the others.
//
// surplus_h = max(0, PV_forecast_h − gross_background_h): PV first offsets the
// always-on gross uncontrolled load; only the remainder is surplus that flexible
// load can soak up at the (low/negative) export price. The expected managed draw —
// the blend denominator — is the capacity limit (the most a managed home could pull
// in an hour), a conservative, stable estimate that keeps the blend near `total`.

import { getZonedParts } from '../../lib/utils/dateUtils';
import { isFiniteNumber } from '../../lib/utils/appTypeGuards';
import type { AppContext } from '../../lib/app/appContext';

/**
 * Inject the forecast surplus as the planning-price input. The price coordinator,
 * daily-budget background, capacity, and timezone all come off the (public) app
 * context; only the PV forecast — an app-private field — is passed in. A no-op until
 * both the price coordinator and daily-budget service exist.
 */
export function wireBudgetPrice(
  ctx: AppContext,
  getForecastKwh: (hourStartMs: number) => number | undefined,
): void {
  const { priceCoordinator, dailyBudgetService } = ctx;
  if (!priceCoordinator || !dailyBudgetService) return;
  priceCoordinator.setBudgetPriceInputs({
    // A getter so a runtime capacity-limit change is reflected, not frozen at boot.
    get expectedManagedDrawKwh() { return ctx.capacitySettings.limitKw; },
    getSurplusKwh: (hourStartMs) => {
      const pvKwh = getForecastKwh(hourStartMs);
      const hourOfDay = getZonedParts(new Date(hourStartMs), ctx.getTimeZone()).hour;
      const backgroundKwh = dailyBudgetService.getGrossBackgroundKwh(hourOfDay);
      // Both must be known + finite. A missing gross background must NOT be
      // fabricated as 0 — that would treat the whole forecast as surplus on a
      // fresh/partial install, before the always-on load is accounted for.
      if (!isFiniteNumber(pvKwh) || !isFiniteNumber(backgroundKwh)) return undefined;
      return Math.max(0, pvKwh - backgroundKwh);
    },
  });
  // No forced recompute here: `getCombinedHourlyPrices()` is live, and a boot-time
  // recompute would re-fire `onCombinedPricesUpdated` mid-startup. Snapshot
  // freshness is instead handled by the PV-forecast completion hook the caller
  // registers right after this (`PvForecastController.setOnRefreshed` →
  // `updateCombinedPrices`), so the persisted planning price lands as soon as a
  // forecast refresh succeeds.
}
