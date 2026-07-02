import { describe, expect, it } from 'vitest';
import {
  hasMaterialExhibitedExport,
  MATERIAL_EXHIBITED_EXPORT_KWH,
} from '../../packages/shared-domain/src/solar/exhibitedExport';

describe('hasMaterialExhibitedExport', () => {
  it('is false for an absent tracker or empty export families', () => {
    expect(hasMaterialExhibitedExport(null)).toBe(false);
    expect(hasMaterialExhibitedExport(undefined)).toBe(false);
    expect(hasMaterialExhibitedExport({})).toBe(false);
    expect(hasMaterialExhibitedExport({ exportBuckets: {}, exportDailyTotals: {} })).toBe(false);
  });

  it('is true once daily totals cross the material floor (365-day stable window)', () => {
    expect(hasMaterialExhibitedExport({ exportDailyTotals: { '2026-02-01': 4.5 } })).toBe(true);
  });

  it('sums across days so a floor crossing accumulates from small daily amounts', () => {
    expect(
      hasMaterialExhibitedExport({
        exportDailyTotals: { '2026-02-01': 0.4, '2026-02-02': 0.4, '2026-02-03': 0.4 },
      }),
    ).toBe(true);
  });

  it('is true on the hourly buckets alone (day-one install not yet folded to daily totals)', () => {
    expect(
      hasMaterialExhibitedExport({
        exportBuckets: { '2026-03-03T10:00:00.000Z': 0.8, '2026-03-03T11:00:00.000Z': 0.6 },
      }),
    ).toBe(true);
  });

  it('stays false for a sub-floor blip (no toggle flicker on a stray negative reading)', () => {
    expect(hasMaterialExhibitedExport({ exportBuckets: { '2026-03-03T10:00:00.000Z': 0.2 } })).toBe(false);
    expect(hasMaterialExhibitedExport({ exportDailyTotals: { '2026-02-01': 0.5 } })).toBe(false);
  });

  it('ignores non-finite and negative junk values at the boundary', () => {
    expect(
      hasMaterialExhibitedExport({
        exportDailyTotals: {
          a: Number.NaN,
          b: Number.POSITIVE_INFINITY,
          c: -50,
          d: MATERIAL_EXHIBITED_EXPORT_KWH,
        },
      }),
    ).toBe(true);
    expect(
      hasMaterialExhibitedExport({ exportDailyTotals: { a: Number.NaN, b: -50 } }),
    ).toBe(false);
  });
});
