import {
  HARD_CAP_TOOLTIP,
  HERO_INFO_TOOLTIP_TEXT,
  SAFE_PACE_TOOLTIP_BY_SOURCE,
  formatHardCapTooltip,
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
      expect(Object.keys(SAFE_PACE_TOOLTIP_BY_SOURCE).sort()).toEqual(['both', 'capacity', 'daily']);
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
      expect(SAFE_PACE_TOOLTIP_BY_SOURCE.capacity).toMatch(/energy budget/);
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
