// Integration-tier: the curtailment-surplus wiring predicate that decides when a
// verify window opens. Exercises the REAL estimator wired through the REAL
// `wireCurtailmentSurplus`, with only the outward seams faked (PV forecast,
// device-manager battery awareness, Homey settings for the hold store).
//
// The load-bearing assertion is fix-2: `isSurplusLiftEngaged` must source from
// the post-normalization `surplusAbsorbActiveByDevice` map (a raise that is the
// BINDING cause of a target), NOT bare `surplusEligibilityByDevice`. A device
// can be eligible while the raise adds no load (sub-step delta rounds to the same
// setpoint, or a floor already set an equal/higher target); verifying against
// eligibility would open/confirm a window with no added draw.
//
// Window state is not publicly exposed, so it is observed through its downstream
// effect on `getCurtailedSurplusKw`: a window that an import REFUTES puts the
// term on the 15-min hold ladder (null well past the 90 s import latch), whereas
// an import with NO open window is a bare latch (the term returns after 90 s).
import { describe, expect, it } from 'vitest';
import { wireCurtailmentSurplus } from '../../setup/appInit/wireCurtailmentSurplus';
import { CURTAIL_IMPORT_HOLD_DOWN_MS } from '../../lib/solar/curtailmentSurplus';
import type { AppContext } from '../../lib/app/appContext';
import type { SelectedPvForecast } from '../../lib/solar/pvForecastSource';

const T0 = Date.UTC(2026, 5, 19, 12, 0, 0); // hour-aligned noon
const TICK = 10_000;
// A tick comfortably past the 90 s import latch — where a bare latch has cleared
// but a 15-min refute hold has not.
const PAST_LATCH = CURTAIL_IMPORT_HOLD_DOWN_MS + 2 * TICK;

type LiftMaps = {
  surplusAbsorbActiveByDevice: Record<string, boolean>;
  surplusEligibilityByDevice: Record<string, { eligible?: boolean }>;
};

// A forecast fixed at 3 kW potential / high confidence ⇒ term = 0.9×3 − 0.5 = 2.2 kW.
const fakeForecast = (): SelectedPvForecast => ({
  sourceId: 'learned',
  forecast: (hourStarts: readonly number[]) => hourStarts.map((hourStartMs) => ({ hourStartMs, generationKwh: 3 })),
  getConfidence: () => 'high',
});

const makeCtx = (state: LiftMaps): AppContext => {
  const settings = new Map<string, unknown>();
  return {
    deviceManager: { hasBatteryDevices: () => false },
    planEngine: { state },
    homey: {
      settings: {
        get: (key: string) => settings.get(key),
        set: (key: string, value: unknown) => { settings.set(key, value); },
      },
    },
  } as unknown as AppContext;
};

describe('wireCurtailmentSurplus — the lift-state predicate that gates verification', () => {
  it('a BINDING surplus raise opens a window; a following import refutes onto the 15-min hold', () => {
    const active: Record<string, boolean> = {};
    const ctx = makeCtx({ surplusAbsorbActiveByDevice: active, surplusEligibilityByDevice: {} });
    const est = wireCurtailmentSurplus(ctx, () => fakeForecast());

    est.recordSample(0, 500, T0); // arm (no lift yet)
    active.tank = true; // the raise becomes the binding cause of the target
    est.recordSample(2_000, 500, T0 + TICK); // rising edge opens window; import refutes

    const at = T0 + TICK + PAST_LATCH;
    est.recordSample(0, 500, at);
    // Still null past the bare 90 s latch ⇒ it is on the 15-min refute hold.
    expect(est.getCurtailedSurplusKw(at)).toBeNull();
  });

  it('a NON-BINDING eligibility opens NO window: an import is a bare latch, not a refute hold', () => {
    // Eligible (the OLD predicate would have fired) but the raise is not binding —
    // exactly the sub-step-rounds-to-same-target / floored-elsewhere case.
    const ctx = makeCtx({
      surplusAbsorbActiveByDevice: {}, // never binding
      surplusEligibilityByDevice: { tank: { eligible: true } },
    });
    const est = wireCurtailmentSurplus(ctx, () => fakeForecast());

    est.recordSample(0, 500, T0); // arm
    est.recordSample(2_000, 500, T0 + TICK); // import while merely "eligible"

    const at = T0 + TICK + PAST_LATCH;
    est.recordSample(0, 500, at);
    // No window opened, so the import was only a 90 s latch — the term is back.
    expect(est.getCurtailedSurplusKw(at)).toBeCloseTo(2.2, 6);
  });

  it('a source flip inside the memo TTL is resolved fresh, not served from the old source', () => {
    // The owner can change `pv_forecast_source` mid-hour and the settings
    // handler rebuilds prices immediately. Keyed on the hour alone, the memo
    // would keep authorizing curtailment load from the deselected source for
    // the rest of the 30 s TTL.
    const learnedCalls: number[] = [];
    const homeyCalls: number[] = [];
    const learned: SelectedPvForecast = {
      sourceId: 'learned',
      forecast: (hourStarts) => {
        learnedCalls.push(hourStarts.length);
        return hourStarts.map((hourStartMs) => ({ hourStartMs, generationKwh: 3 }));
      },
      getConfidence: () => 'high',
    };
    // Homey selected but carrying nothing usable ⇒ no potential at all.
    const homey: SelectedPvForecast = {
      sourceId: 'homey_energy',
      forecast: (hourStarts) => {
        homeyCalls.push(hourStarts.length);
        return [];
      },
      getConfidence: () => null,
    };
    let selected: SelectedPvForecast = learned;
    const ctx = makeCtx({ surplusAbsorbActiveByDevice: {}, surplusEligibilityByDevice: {} });
    const est = wireCurtailmentSurplus(ctx, () => selected);

    est.recordSample(0, 500, T0);
    expect(est.getCurtailedSurplusKw(T0)).toBeCloseTo(2.2, 6);
    expect(learnedCalls.length).toBeGreaterThan(0);

    // Same hour, well inside the 30 s TTL — only the SOURCE changed.
    selected = homey;
    est.recordSample(0, 500, T0 + TICK);
    expect(est.getCurtailedSurplusKw(T0 + TICK)).toBeNull();
    expect(homeyCalls.length).toBeGreaterThan(0);
  });
});
