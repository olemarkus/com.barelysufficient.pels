import {
  HARD_CAP_TOOLTIP,
  HERO_INFO_TOOLTIP_TEXT,
  SAFE_PACE_TOOLTIP_BY_SOURCE,
  formatHardCapTooltip,
  formatSafePaceComposition,
  formatSafePaceTooltip,
} from '../../packages/shared-domain/src/planHeroTooltips';

describe('planHeroTooltips', () => {
  describe('HERO_INFO_TOOLTIP_TEXT', () => {
    it('mentions both kW and kWh so the user can distinguish speed from distance', () => {
      expect(HERO_INFO_TOOLTIP_TEXT).toContain('kW');
      expect(HERO_INFO_TOOLTIP_TEXT).toContain('kWh');
      expect(HERO_INFO_TOOLTIP_TEXT).toContain('Safe pace');
    });
  });

  describe('SAFE_PACE_TOOLTIP_BY_SOURCE', () => {
    it('covers every soft-limit source', () => {
      expect(Object.keys(SAFE_PACE_TOOLTIP_BY_SOURCE).sort()).toEqual(['capacity', 'daily']);
    });

    it('starts each phrase lowercase so it reads after the "Safe pace now N kW — " stem', () => {
      for (const text of Object.values(SAFE_PACE_TOOLTIP_BY_SOURCE)) {
        expect(text[0]).toBe(text[0].toLowerCase());
      }
    });

    it('describes the dynamic budget pace, not "hourly power limit" jargon or a cap formula', () => {
      expect(SAFE_PACE_TOOLTIP_BY_SOURCE.capacity).not.toMatch(/hourly power limit/i);
      // The safe pace is the dynamic burst rate, not "hard cap minus safety
      // margin" (only true at the top of the hour) — the copy must not claim
      // the formula.
      expect(SAFE_PACE_TOOLTIP_BY_SOURCE.capacity).not.toMatch(/minus/i);
      expect(SAFE_PACE_TOOLTIP_BY_SOURCE.capacity).toMatch(/hourly pace/);
    });
  });

  describe('formatSafePaceTooltip', () => {
    it('renders the canonical "Safe pace now {kW} kW — {source}" string', () => {
      const text = formatSafePaceTooltip(6, 'capacity');
      expect(text).toBe(`Safe pace now 6.0 kW — ${SAFE_PACE_TOOLTIP_BY_SOURCE.capacity}`);
    });

    it('falls back to the capacity source when none is given', () => {
      expect(formatSafePaceTooltip(6, null)).toContain(SAFE_PACE_TOOLTIP_BY_SOURCE.capacity);
      expect(formatSafePaceTooltip(6, undefined)).toContain(SAFE_PACE_TOOLTIP_BY_SOURCE.capacity);
    });

    it('explains the budget pace and added allowance when both are available', () => {
      expect(formatSafePaceTooltip(12, 'daily', {
        budgetPaceKw: 5,
        projectedExemptKw: 7,
      })).toBe(
        'Safe pace now 12.0 kW — today\'s budget paces counted usage at 5.0 kW, plus 7.0 kW '
        + 'reserved for devices allowed beyond it; PELS starts reacting here.',
      );
    });

    // The 'both' cases that used to live here are gone with the variant. There
    // was never a producer for it — `resolveSoftLimitSource` answers 'capacity'
    // when the two paces coincide — so those tests asserted copy for a state the
    // app cannot reach.
    it('uses honest generic wording for a daily source without composition', () => {
      expect(formatSafePaceTooltip(5, 'daily')).toContain('may include power allowed beyond');
      expect(formatSafePaceTooltip(5, 'daily')).not.toContain('constraining');
    });
  });

  describe('formatSafePaceComposition', () => {
    it('formats a visible daily-budget composition line', () => {
      expect(formatSafePaceComposition(12, 'daily', {
        budgetPaceKw: 5,
        projectedExemptKw: 7,
      })).toBe(
        'Safe pace reserves 7.0 kW for devices allowed beyond today\'s budget; '
        + 'usage counted toward today\'s budget is paced at 5.0 kW.',
      );
    });

    it('keeps the displayed components equal to the displayed marker across rounding boundaries', () => {
      expect(formatSafePaceComposition(12.08, 'daily', {
        budgetPaceKw: 5.04,
        projectedExemptKw: 7.04,
      })).toBe(
        'Safe pace reserves 7.0 kW for devices allowed beyond today\'s budget; '
        + 'usage counted toward today\'s budget is paced at 5.1 kW.',
      );
    });

    it('suppresses capacity, zero, sub-rounding, missing, and malformed allowances', () => {
      expect(formatSafePaceComposition(12, 'capacity', { budgetPaceKw: 5, projectedExemptKw: 7 })).toBeNull();
      expect(formatSafePaceComposition(5, 'daily', { budgetPaceKw: 5, projectedExemptKw: 0 })).toBeNull();
      expect(formatSafePaceComposition(5.049, 'daily', { budgetPaceKw: 5, projectedExemptKw: 0.049 })).toBeNull();
      expect(formatSafePaceComposition(12, 'daily', { projectedExemptKw: 7 })).toBeNull();
      expect(formatSafePaceComposition(12, 'daily', {
        budgetPaceKw: Number.NaN,
        projectedExemptKw: 7,
      })).toBeNull();
      expect(formatSafePaceComposition(6, 'daily', { budgetPaceKw: -1, projectedExemptKw: 7 })).toBeNull();
      expect(formatSafePaceComposition(13, 'daily', { budgetPaceKw: 5, projectedExemptKw: 7 })).toBeNull();
    });
  });

  describe('formatHardCapTooltip', () => {
    it('renders the canonical "Hard cap {kW} kW — {HARD_CAP_TOOLTIP}" string', () => {
      expect(formatHardCapTooltip(8)).toBe(`Hard cap 8.0 kW — ${HARD_CAP_TOOLTIP}`);
    });

    it('frames the cap as the hourly tariff step, never as breaker protection', () => {
      // An hourly-average ceiling cannot prevent breaker trips
      // (notes/ui-terminology.md § "Hard cap is an hourly ceiling").
      expect(HARD_CAP_TOOLTIP).not.toMatch(/breaker/i);
      expect(HARD_CAP_TOOLTIP).toMatch(/tariff step/);
      expect(HARD_CAP_TOOLTIP).toMatch(/hour/);
    });
  });
});
