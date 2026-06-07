// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderPreviewChart } from '../../widgets/create_smart_task/src/public/previewChart';

const HOUR_MS = 60 * 60 * 1000;
const container = (): HTMLElement => document.createElement('div');
const hours = (count: number, priceAt: (index: number) => number | null) => (
  Array.from({ length: count }, (_value, index) => ({ startsAtMs: index * HOUR_MS, price: priceAt(index) }))
);

describe('renderPreviewChart', () => {
  it('returns false and renders nothing with fewer than two points', () => {
    const el = container();
    expect(renderPreviewChart(el, { priceSeries: hours(1, () => 5), scheduledHours: [] })).toBe(false);
    expect(el.querySelector('svg')).toBeNull();
  });

  it('returns false when no point carries a finite price', () => {
    const el = container();
    expect(renderPreviewChart(el, { priceSeries: hours(4, () => null), scheduledHours: [] })).toBe(false);
    expect(el.querySelector('svg')).toBeNull();
  });

  it('draws a flat line with no NaN when every price is equal (degenerate y-scale)', () => {
    const el = container();
    expect(renderPreviewChart(el, { priceSeries: hours(4, () => 50), scheduledHours: [] })).toBe(true);
    const path = el.querySelector('.pchart__line');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('d') ?? '').not.toMatch(/NaN/);
  });

  it('merges contiguous scheduled hours into one band and dots each chosen hour', () => {
    const el = container();
    renderPreviewChart(el, {
      priceSeries: hours(10, (index) => 40 + index),
      scheduledHours: [{ startsAtMs: 7 * HOUR_MS, plannedKWh: 2 }, { startsAtMs: 8 * HOUR_MS, plannedKWh: 2 }],
    });
    expect(el.querySelectorAll('.pchart__band').length).toBe(1);
    expect(el.querySelectorAll('.pchart__dot').length).toBe(2);
  });

  it('two non-adjacent scheduled hours render two separate bands', () => {
    const el = container();
    renderPreviewChart(el, {
      priceSeries: hours(10, (index) => 40 + index),
      scheduledHours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 2 }, { startsAtMs: 8 * HOUR_MS, plannedKWh: 2 }],
    });
    expect(el.querySelectorAll('.pchart__band').length).toBe(2);
  });

  it('breaks the line across a null-price gap (the pen lifts: a second M command)', () => {
    const el = container();
    const series = hours(4, (index) => (index === 2 ? null : 10 + index));
    renderPreviewChart(el, { priceSeries: series, scheduledHours: [] });
    const d = el.querySelector('.pchart__line')?.getAttribute('d') ?? '';
    expect((d.match(/M/g) ?? []).length).toBe(2);
  });

  it('clears prior content on re-render (no stale SVG accumulates)', () => {
    const el = container();
    renderPreviewChart(el, { priceSeries: hours(4, () => 50), scheduledHours: [] });
    renderPreviewChart(el, { priceSeries: hours(4, () => 60), scheduledHours: [] });
    expect(el.querySelectorAll('svg').length).toBe(1);
  });
});
