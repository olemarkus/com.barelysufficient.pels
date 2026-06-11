import { describe, expect, it } from 'vitest';
import {
  USAGE_HERO_ON_PACE,
  USAGE_HERO_ON_TRACK,
  formatVsPaceChipLabel,
  formatVsTypicalChipLabel,
  formatProjectionLine,
  formatUsageComparisonLine,
  formatUsageCollectingLine,
} from '../../shared-domain/src/usageHeroStrings.ts';

describe('usageHeroStrings', () => {
  it('exposes the dead-band labels verbatim', () => {
    expect(USAGE_HERO_ON_PACE).toBe('On pace');
    expect(USAGE_HERO_ON_TRACK).toBe('On track');
  });

  it('formats the vs-pace chip with sign driven by diff', () => {
    expect(formatVsPaceChipLabel(1, 1)).toBe('+1.0 kWh vs pace');
    expect(formatVsPaceChipLabel(-1.5, 1.5)).toBe('−1.5 kWh vs pace');
  });

  it('formats the vs-typical chip with sign driven by projectedDiff', () => {
    expect(formatVsTypicalChipLabel(2, 2)).toBe('+2.0 kWh vs typical');
    expect(formatVsTypicalChipLabel(-4, 4)).toBe('−4.0 kWh vs typical');
  });

  it('formats the projection line, dropping the direction inside the dead-band', () => {
    expect(formatProjectionLine(12, 0.1, true)).toBe('On track for ~12.0 kWh by midnight.');
    expect(formatProjectionLine(15, 3, false)).toBe('On track for ~15.0 kWh by midnight (above typical).');
    expect(formatProjectionLine(8, -4, false)).toBe('On track for ~8.0 kWh by midnight (below typical).');
  });

  it('formats the day-aware comparison and collecting lines', () => {
    // Monday = 1
    expect(formatUsageComparisonLine('Mon, Jun 8', 1, 13.4))
      .toBe('Today · Mon, Jun 8. Your typical Monday runs 13.4 kWh.');
    expect(formatUsageCollectingLine('Mon, Jun 8'))
      .toBe('Today · Mon, Jun 8. Collecting history…');
  });
});
