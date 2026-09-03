import {
  buildDecisionSentence,
  computeEnergyBarScaleKWh,
  formatAboveSafePaceSubline,
  formatCheapestUpcomingHour,
  formatEnergyMeterMarkerLabels,
  formatEnergyUsedOfBudgetParts,
  formatHeroHeadline,
  formatPowerMeterMarkerLabels,
  formatProjectedEnergySubline,
  type DecisionSentenceInput,
  type PlanHeroMetaInput,
} from '../../packages/shared-domain/src/planHeroSummary';


const meta = (overrides: Partial<PlanHeroMetaInput> = {}): PlanHeroMetaInput => ({
  totalKw: 5.2,
  softLimitKw: 11.0,
  hardCapLimitKw: 14,
  controlledKw: 3.1,
  uncontrolledKw: 2.1,
  ...overrides,
});

describe('formatHeroHeadline', () => {
  it('formats an under-budget state', () => {
    const headline = formatHeroHeadline(meta());
    expect(headline.totalKw).toBeCloseTo(5.2);
    expect(headline.softLimitKw).toBeCloseTo(11.0);
    expect(headline.overSoftLimit).toBe(false);
    expect(headline.hardLimitKw).toBeCloseTo(14);
  });

  it('flags over-soft-limit state from the printed pair, total against safe pace', () => {
    const headline = formatHeroHeadline(meta({
      totalKw: 12,
      softLimitKw: 11,
    }));
    expect(headline.overSoftLimit).toBe(true);
  });

  it('never claims above-safe-pace while the total prints under the tick', () => {
    // Regression (2026-09-02): the state used to come from a planner-side
    // headroom, which could disagree with `softLimitKw - totalKw` — the hero
    // then said "Above safe pace" over a bar drawn under the tick.
    const headline = formatHeroHeadline(meta({ totalKw: 1.5, softLimitKw: 2.3 }));
    expect(headline.overSoftLimit).toBe(false);
  });

  it('carries the hard cap as a display value only — no instantaneous over-cap judgement', () => {
    // Regression: instantaneous kW above the cap is NOT a breach (the cap is
    // an hourly-average tariff-step ceiling). The headline must not derive any
    // over-cap state from power vs cap; the alert-tier hero state comes from
    // the projected-energy trajectory in the caller.
    const headline = formatHeroHeadline(meta({
      totalKw: 15,
      hardCapLimitKw: 14,
    }));
    expect(headline.hardLimitKw).toBe(14);
    expect(headline && 'overHardLimit' in headline).toBe(false);
  });


});

describe('formatEnergyUsedOfBudgetParts', () => {
  it('splits into a leading value and a trailing budget qualifier', () => {
    expect(formatEnergyUsedOfBudgetParts(0, 4.5)).toEqual({
      lead: '0.0',
      qualifier: 'of 4.5 kWh used',
    });
  });

  it('joins to the canonical one-decimal wording with a single space', () => {
    // Invariant: the hero's rendered text and any log breadcrumb composed from
    // these parts are the SAME sentence (feedback_ui_text_shared_with_logs), so
    // the joined form is pinned against literal copy rather than against a
    // second implementation of it.
    const joined = (used: number, budget: number): string => {
      const { lead, qualifier } = formatEnergyUsedOfBudgetParts(used, budget);
      return `${lead} ${qualifier}`;
    };
    expect(joined(4.2, 11)).toBe('4.2 of 11.0 kWh used');
    expect(joined(0, 4.5)).toBe('0.0 of 4.5 kWh used');
    expect(joined(1.25, 0.9)).toBe('1.3 of 0.9 kWh used');
  });
});

describe('formatProjectedEnergySubline', () => {
  it('returns null when no projection is available', () => {
    expect(formatProjectedEnergySubline(null)).toBeNull();
  });

  it('renders "projected X.XX kWh" with two-decimal precision', () => {
    expect(formatProjectedEnergySubline(2.347)).toBe('projected 2.35 kWh');
    expect(formatProjectedEnergySubline(5)).toBe('projected 5.00 kWh');
    expect(formatProjectedEnergySubline(0)).toBe('projected 0.00 kWh');
  });

  it('floors a negative projection at zero (net-export hour) — never prints a minus', () => {
    expect(formatProjectedEnergySubline(-1.42)).toBe('projected 0.00 kWh');
    expect(formatProjectedEnergySubline(-0.01)).toBe('projected 0.00 kWh');
  });
});

describe('hero meter marker labels', () => {
  it('formats power markers with the numeric value in the visible legend label', () => {
    // The legend is the only touch-reachable home for these numbers (tippy
    // tooltips need hover), so the visible label carries the value.
    expect(formatPowerMeterMarkerLabels('target', 11)).toEqual({
      short: 'Safe pace now 11.0 kW',
      aria: 'Safe pace now 11.0 kW',
    });
    expect(formatPowerMeterMarkerLabels('cap', 14)).toEqual({
      short: 'Hard cap 14.0 kW',
      aria: 'Hard cap 14.0 kW',
    });
  });

  it('formats energy markers with short legend + screen-reader labels', () => {
    expect(formatEnergyMeterMarkerLabels('target', 5)).toEqual({
      short: 'Budget this hour',
      aria: 'Budget this hour 5.0 kWh',
    });
    expect(formatEnergyMeterMarkerLabels('projected', 4.4)).toEqual({
      short: 'Projected this hour',
      aria: 'Projected this hour 4.4 kWh',
    });
  });

  it('carries the value in the energy cap label — the kWh threshold appears nowhere else', () => {
    expect(formatEnergyMeterMarkerLabels('cap', 8)).toEqual({
      short: 'Hard cap this hour 8.0 kWh',
      aria: 'Hard cap this hour 8.0 kWh',
    });
  });
});

describe('buildDecisionSentence', () => {
  const baseline = (overrides: Partial<DecisionSentenceInput> = {}): DecisionSentenceInput => ({
    limitedCount: 0,
    resumingCount: 0,
    dryRun: false,
    projectedOverHardCap: false,
    projectedOverBudget: false,
    safePaceKw: 12,
    ...overrides,
  });

  it('returns the quiet-hour copy when nothing is happening', () => {
    expect(buildDecisionSentence(baseline())).toEqual({
      text: 'Quiet hour. Nothing to do.',
      positive: true,
    });
  });


  it('reports the on-pace-over-cap trajectory before active limiting', () => {
    expect(buildDecisionSentence(baseline({
      projectedOverHardCap: true,
      limitedCount: 2,
      sheddableManagedRunningCount: 1,
    })).text).toBe('On pace to exceed the hard cap this hour. Easing devices off.');
  });

  it('drops the action clause when nothing is left to ease off and no control-off device draws', () => {
    // Codex review (PR #1844): the trajectory can stay over the cap after the
    // hour has already banked the energy — every managed device settled off,
    // draw near zero. Claiming "Easing devices off." then is false.
    expect(buildDecisionSentence(baseline({
      projectedOverHardCap: true,
      capacityControlOffCount: 0,
      sheddableManagedRunningCount: 0,
    })).text).toBe('On pace to exceed the hard cap this hour.');
  });

  it('drops the action clause under simulation — PELS is not easing anything off', () => {
    // Simulation homes routinely project past the cap (nothing is being shed),
    // and the banner already says "devices stay as-is" — the sentence must not
    // claim action (hypothetical-voice rule, notes/overview-hero-spec.md).
    const result = buildDecisionSentence(baseline({
      projectedOverHardCap: true,
      dryRun: true,
      limitedCount: 2,
      capacityControlOffCount: 1,
      sheddableManagedRunningCount: 0,
    }));
    expect(result.text).toBe('On pace to exceed the hard cap this hour.');
    expect(result.text).not.toContain('Easing');
  });

  it('keeps the "easing off" copy on the over-cap trajectory while a managed device can still be shed', () => {
    // A controllable managed device is still running, so the cascade is not
    // exhausted even though a control-off device is also breaching.
    expect(buildDecisionSentence(baseline({
      projectedOverHardCap: true,
      limitedCount: 1,
      capacityControlOffCount: 1,
      sheddableManagedRunningCount: 1,
    })).text).toBe('On pace to exceed the hard cap this hour. Easing devices off.');
  });

  it('keeps the "easing off" copy on the over-cap trajectory while a managed device still draws', () => {
    expect(buildDecisionSentence(baseline({
      projectedOverHardCap: true,
      capacityControlOffCount: 0,
      sheddableManagedRunningCount: 2,
    })).text).toBe('On pace to exceed the hard cap this hour. Easing devices off.');
  });

  it('tells the honest story when the managed cascade is exhausted and a control-off device breaches', () => {
    expect(buildDecisionSentence(baseline({
      projectedOverHardCap: true,
      capacityControlOffCount: 1,
      sheddableManagedRunningCount: 0,
    }))).toEqual({
      text: 'Managed devices are already eased off. The remaining draw is from '
        + 'a device that has Power-limit control turned off. '
        + 'Turn its Power-limit control back on so PELS can ease it off.',
      positive: false,
    });
  });

  it('pluralises the control-off recourse when several devices are uncontrolled', () => {
    expect(buildDecisionSentence(baseline({
      projectedOverHardCap: true,
      capacityControlOffCount: 2,
      sheddableManagedRunningCount: 0,
    })).text).toBe(
      'Managed devices are already eased off. The remaining draw is from '
      + '2 devices that have Power-limit control turned off. '
      + 'Turn their Power-limit control back on so PELS can ease them off.',
    );
  });

  it('uses hypothetical voice in simulation mode without re-naming simulation', () => {
    // The banner + `Simulation mode` status chip already name simulation on the
    // Overview; the decision sentence drops the "if simulation mode were off"
    // tail so simulation is stated at most twice on the first viewport. It stays
    // hypothetical (`would`) so it never implies PELS acted.
    const text = buildDecisionSentence(baseline({
      dryRun: true,
      limitedCount: 2,
    })).text;
    expect(text).toBe('2 devices would be limited right now.');
    expect(text.toLowerCase()).not.toContain('simulation');
  });

  it('names the house and the safe-pace target when actively limiting', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 4,
      safePaceKw: 12.0,
    })).text).toBe('Holding back 4 devices so the house stays under 12.0 kW.');
  });

  it('singular-form devices when only one is held', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 1,
    })).text).toBe('Holding back 1 device so the house stays under 12.0 kW.');
  });

  it('omits the safe-pace clause when the value is unavailable', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 2,
      safePaceKw: null,
    })).text).toBe('Holding back 2 devices.');
  });

  it('describes resuming with a positive tone', () => {
    expect(buildDecisionSentence(baseline({
      resumingCount: 1,
    }))).toEqual({
      text: 'Bringing 1 device back online. Power has stayed under the safe pace.',
      positive: true,
    });
  });

  it('warns about projected overshoot without an em-dash', () => {
    expect(buildDecisionSentence(baseline({
      projectedOverBudget: true,
    })).text).toBe('On pace to overshoot this hour’s energy budget.');
  });

  it('frames every-device-waiting as the smart-task calm signal', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 1,
      deferredObjectiveAvoidCount: 1,
    }))).toEqual({
      text: 'Waiting for cheaper hours before running 1 device.',
      positive: true,
    });
  });

  it('blends the smart-task subset into the wider holding-back sentence', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 3,
      deferredObjectiveAvoidCount: 1,
    })).text).toBe('Holding back 3 devices, 1 waiting for cheaper hours.');
  });

  it('names today’s budget when every held device is on daily-budget pacing', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 2,
      dailyBudgetLimitedCount: 2,
    })).text).toBe('Holding back 2 devices to stay within today’s budget.');
  });

  it('falls through to capacity defense when no smart-task / daily-budget signal is present', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 2,
      deferredObjectiveAvoidCount: 0,
      dailyBudgetLimitedCount: 0,
    })).text).toBe('Holding back 2 devices so the house stays under 12.0 kW.');
  });

  it('prefers the smart-task framing over the daily-budget framing when both subsets fully overlap', () => {
    // Both `deferredObjectiveAvoidCount` and `dailyBudgetLimitedCount` can be
    // equal to `limitedCount` if a device's reason flipped between the two
    // mid-cycle in some future change. The smart-task framing wins because
    // it reflects the user's opt-in price-aware plan; daily-budget pacing is
    // the mechanism, not the intent.
    expect(buildDecisionSentence(baseline({
      limitedCount: 1,
      deferredObjectiveAvoidCount: 1,
      dailyBudgetLimitedCount: 1,
    })).text).toBe('Waiting for cheaper hours before running 1 device.');
  });
});

describe('formatCheapestUpcomingHour', () => {
  const clock = (timestampMs: number): string => {
    const d = new Date(timestampMs);
    return `${d.getUTCHours().toString().padStart(2, '0')}:00`;
  };

  const HOUR = 60 * 60 * 1000;
  const NOW_MS = Date.UTC(2026, 4, 17, 20, 0, 0);

  it('returns null when no hours are upcoming', () => {
    expect(formatCheapestUpcomingHour({
      hours: [{ startsAtMs: NOW_MS - HOUR, price: 5 }],
      nowMs: NOW_MS,
      unitLabel: 'øre/kWh',
      formatClockTime: clock,
    })).toBeNull();
  });

  it('picks the cheapest upcoming hour within the default horizon', () => {
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: NOW_MS + HOUR, price: 40 },
        { startsAtMs: NOW_MS + 6 * HOUR, price: 18 },
        { startsAtMs: NOW_MS + 12 * HOUR, price: 35 },
      ],
      nowMs: NOW_MS,
      unitLabel: 'øre/kWh',
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 02:00, 18 øre/kWh.');
  });

  it('drops hours past the horizon window', () => {
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: NOW_MS + HOUR, price: 50 },
        { startsAtMs: NOW_MS + 30 * HOUR, price: 2 }, // outside default 18h horizon
      ],
      nowMs: NOW_MS,
      unitLabel: 'øre/kWh',
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 21:00, 50 øre/kWh.');
  });

  it('formats non-øre units with two decimals', () => {
    expect(formatCheapestUpcomingHour({
      hours: [{ startsAtMs: NOW_MS + HOUR, price: 1.25 }],
      nowMs: NOW_MS,
      unitLabel: 'kr/kWh',
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 21:00, 1.25 kr/kWh.');
  });

  it('prefers the earlier hour when prices differ only below display precision', () => {
    // Exact production values (Norgespris flat band, 2026-08-02): the 23:00
    // hour carried a 1e-14 øre float residue that beat 22:00 on a raw `<`
    // compare, so the hero named the later hour of two visually identical ones.
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: NOW_MS + HOUR, price: 86.0875 },
        { startsAtMs: NOW_MS + 2 * HOUR, price: 72.9625 },
        { startsAtMs: NOW_MS + 3 * HOUR, price: 72.962_499_999_999_99 },
      ],
      nowMs: NOW_MS,
      unitLabel: 'kr/kWh',
      divisor: 100,
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 22:00, 0.73 kr/kWh.');
  });

  it('still picks a later hour that is genuinely cheaper at display precision', () => {
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: NOW_MS + HOUR, price: 72.9 },
        { startsAtMs: NOW_MS + 2 * HOUR, price: 71 },
      ],
      nowMs: NOW_MS,
      unitLabel: 'kr/kWh',
      divisor: 100,
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 22:00, 0.71 kr/kWh.');
  });

  it('treats prices straddling zero inside the display bucket as a tie and never prints -0.00', () => {
    // +0.4 øre and -0.4 øre both display as 0.00 kr/kWh, so the earlier hour
    // wins; rendering from the display-rounded value keeps the sign of -0 out
    // of the subline.
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: NOW_MS + HOUR, price: 0.4 },
        { startsAtMs: NOW_MS + 2 * HOUR, price: -0.4 },
      ],
      nowMs: NOW_MS,
      unitLabel: 'kr/kWh',
      divisor: 100,
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 21:00, 0.00 kr/kWh.');
  });

  it('breaks a display-price tie by earliest start even when hours arrive unsorted', () => {
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: NOW_MS + 3 * HOUR, price: 18.2 },
        { startsAtMs: NOW_MS + HOUR, price: 18.4 }, // both round to 18 øre
        { startsAtMs: NOW_MS + 2 * HOUR, price: 40 },
      ],
      nowMs: NOW_MS,
      unitLabel: 'øre/kWh',
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 21:00, 18 øre/kWh.');
  });
});

describe('above-threshold subline formatters', () => {
  it('renders the overshoot as total minus safe pace, with the safe pace reference', () => {
    expect(formatAboveSafePaceSubline(6.5, 5.0)).toBe('1.5 kW above safe pace (5.0 kW)');
  });

  it('clamps overshoot to zero when the total is under the pace but still surfaces the reference', () => {
    expect(formatAboveSafePaceSubline(3.0, 5.0)).toBe('0.0 kW above safe pace (5.0 kW)');
  });
});

describe('computeEnergyBarScaleKWh — projected marker alignment', () => {
  // Regression for the 2026-05-16 fix: when projected is below budget, the
  // marker's visual position must match the printed `projected / budget`
  // ratio. Earlier behaviour multiplied the scale by 1.05 even in the
  // under-budget branch, so the dot sat ~5 % low.
  it('uses budget as the upper bound when projected is at or below budget', () => {
    expect(computeEnergyBarScaleKWh(2.3, 1.95, 1.0)).toBe(2.3);
    // Projection / scale lines up with printed ratio (1.95 / 2.3 ≈ 0.848).
    expect(1.95 / computeEnergyBarScaleKWh(2.3, 1.95, 1.0)).toBeCloseTo(0.848, 2);
  });

  it('opens headroom past budget when projected overshoots so the overshoot is visible', () => {
    expect(computeEnergyBarScaleKWh(2.3, 2.6, 1.0)).toBeCloseTo(2.6 * 1.05, 5);
  });

  it('uses budget when projected is null and used is below budget', () => {
    expect(computeEnergyBarScaleKWh(2.3, null, 1.0)).toBe(2.3);
  });

  it('opens headroom past budget when used alone overshoots without a projection', () => {
    expect(computeEnergyBarScaleKWh(2.3, null, 2.5)).toBeCloseTo(2.5 * 1.05, 5);
  });

  // Regression: prod 2026-07-25. The energy bar's hard-cap marker only renders
  // while the cap is on-scale, and the cap normally sits ABOVE the budget
  // (budget = cap − safety margin). Omitting it from the scale dropped the tick
  // in exactly the healthy case, so the cap was never shown in the unit it
  // governs and appeared only as a kW tick on the instantaneous power bar —
  // where "6.7 kW now" beside "Hard cap 5.0 kW" reads as a breach it is not.
  it('keeps the hard cap on-scale when it sits above the budget', () => {
    // The reported case: budget 3.2, used 1.1, projected 1.97, cap 5.0.
    expect(computeEnergyBarScaleKWh(3.2, 1.97, 1.1, 5.0)).toBe(5.0);
  });

  it('does not shrink the scale when the cap is below the overshoot', () => {
    expect(computeEnergyBarScaleKWh(2.3, 2.6, 1.0, 2.4)).toBeCloseTo(2.6 * 1.05, 5);
  });

  it('ignores a missing or non-finite cap', () => {
    expect(computeEnergyBarScaleKWh(2.3, 1.95, 1.0, null)).toBe(2.3);
    expect(computeEnergyBarScaleKWh(2.3, 1.95, 1.0, Number.NaN)).toBe(2.3);
    // An infinite cap would otherwise become the scale and collapse the bar to
    // a sliver — the finiteness gate is what keeps the budget tick readable.
    expect(computeEnergyBarScaleKWh(2.3, 1.95, 1.0, Number.POSITIVE_INFINITY)).toBe(2.3);
    expect(computeEnergyBarScaleKWh(2.3, 1.95, 1.0, Number.NEGATIVE_INFINITY)).toBe(2.3);
    expect(computeEnergyBarScaleKWh(2.3, 1.95, 1.0)).toBe(2.3);
  });
});
