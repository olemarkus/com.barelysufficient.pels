import {
  HARD_CAP_TOOLTIP,
  HERO_INFO_TOOLTIP_TEXT,
  SAFE_PACE_TOOLTIP_BY_SOURCE,
  formatHardCapTooltip,
  formatSafePaceTooltip,
} from '../packages/shared-domain/src/planHeroTooltips';

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
  });
});
