import { describe, expect, it } from 'vitest';
import { buildChargeByStartMs } from '../src/ui/deadlinePlanHourMaps.ts';
import { resolveScrubHourIndex } from '../src/ui/deadlineChartScrub.ts';
import { resolveRunBands, integratePlannedStaircase } from '../../shared-domain/src/deferredPlanHistoryChartData.ts';
import { formatScheduledHoursWindow } from '../../shared-domain/src/smartTaskDeadlineFormat.ts';
import { formatCheapestHoursCaption } from '../../shared-domain/src/deadlineLabels.ts';
import { resolveHistoryDetailHourlyStrip } from '../../shared-domain/src/deferredPlanHistoryHourlyStrip.ts';
import { renderPreviewChart } from '../../../widgets/_shared/smartTaskCreate/previewChart.ts';

const start = Date.parse('2026-10-25T01:00:00Z');
const quarter = 15 * 60 * 1000;
const booking = (index: number) => ({
  startsAtMs: start + index * quarter,
  endsAtMs: start + (index + 1) * quarter,
  plannedKWh: 0.5,
});

// A cheap first and third quarter must never look like one uninterrupted run.
describe('native-period Smart-task presentation', () => {
  it('keeps separated quarter bookings as distinct ranges and bands', () => {
    const hours = [booking(0), booking(2)];
    expect(formatScheduledHoursWindow(hours, 'UTC')).toBe('01:00–01:15, 01:30–01:45');
    expect(resolveRunBands(hours, start, start + 4 * quarter)).toEqual([
      { fromMs: start, toMs: start + quarter },
      { fromMs: start + 2 * quarter, toMs: start + 3 * quarter },
    ]);
    expect(resolveScrubHourIndex(hours, start + 2 * quarter + 1)).toBe(1);
  });

  it('projects an hourly commitment onto quarters without multiplying its energy', () => {
    const periods = [0, 1, 2, 3].map((index) => ({
      startsAtMs: start + index * quarter, endMs: start + (index + 1) * quarter,
      price: 0.2, planningPrice: 0.2,
    }));
    const result = buildChargeByStartMs({
      hours: [{ startsAtMs: start, endsAtMs: start + 4 * quarter, plannedKWh: 2 }],
    }, periods);
    expect([...result.values()]).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('integrates clipped quarter energy over its actual coverage', () => {
    const from = start + 5 * 60000;
    const points = integratePlannedStaircase({
      hours: [{ startsAtMs: start, coversFromMs: from, endsAtMs: start + quarter, plannedKWh: 1 }],
      kwhPerUnitMean: 0.5,
    }, 40, start + 10 * 60000, start + quarter, 65);
    expect(points[points.length - 1]).toEqual({ atMs: start + quarter, value: 41 });
  });

  it('describes total duration rather than counting periods as hours', () => {
    const periods = [0, 1, 2, 3].map((index) => ({ ...booking(index), priceValue: 0.2 }));
    expect(formatCheapestHoursCaption([periods[0]!, periods[2]!], periods, 'kr/kWh'))
      .toBe('Scheduled 30m · avg 0.20 kr/kWh');
  });

  it('keeps recorded quarter delivery and money prices separate', () => {
    const result = resolveHistoryDetailHourlyStrip({
      startedAtMs: start, deadlineAtMs: start + 2 * quarter,
      originalPlan: null, finalPlan: null,
      hourlyContributions: [
        { atMs: start, endsAtMs: start + quarter, deliveredKWh: 0.5, priceValue: -0.2, tone: 'cheap' },
        { atMs: start + quarter, endsAtMs: start + 2 * quarter, deliveredKWh: 0.5, priceValue: 0.8, tone: 'expensive' },
      ],
    });
    expect(result.mode).toBe('present');
    if (result.mode === 'absent') return;
    expect(result.buckets.map((period) => [period.kwh, period.priceValue])).toEqual([[0.5, -0.2], [0.5, 0.8]]);
  });

  it('preserves energy and money when restored hourly history overlaps new quarters', () => {
    const result = resolveHistoryDetailHourlyStrip({
      startedAtMs: start, deadlineAtMs: start + 4 * quarter, originalPlan: null, finalPlan: null,
      hourlyContributions: [
        { atMs: start, endsAtMs: start + 4 * quarter, deliveredKWh: 1, priceValue: 0.2, tone: 'cheap' },
        { atMs: start + quarter, endsAtMs: start + 2 * quarter, deliveredKWh: 0.5, priceValue: 0.8, tone: 'expensive' },
      ],
    });
    if (result.mode === 'absent') throw new Error('Expected recorded delivery');
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({ kwh: 1.5, priceIsAverage: true });
    expect(result.buckets[0]!.priceValue).toBeCloseTo(0.4);
    expect(result.buckets[0]!.kwh * result.buckets[0]!.priceValue!).toBeCloseTo(0.6);
  });

  it('keeps partial first and last period delivery inside the task window', () => {
    const result = resolveHistoryDetailHourlyStrip({
      startedAtMs: start + 10 * 60000, deadlineAtMs: start + 35 * 60000, originalPlan: null, finalPlan: null,
      hourlyContributions: [
        { atMs: start, endsAtMs: start + quarter, deliveredKWh: 0.1, priceValue: 0.2, tone: 'cheap' },
        { atMs: start + 2 * quarter, endsAtMs: start + 3 * quarter, deliveredKWh: 0.1, priceValue: 0.8, tone: 'expensive' },
      ],
    });
    if (result.mode === 'absent') throw new Error('Expected recorded delivery');
    expect(result.windowStartMs).toBe(start + 10 * 60000);
    expect(result.windowEndMs).toBe(start + 35 * 60000);
    expect(result.buckets.filter((period) => period.delivered).map((period) => period.kwh)).toEqual([0.1, 0.1]);
  });

  it('draws preview gaps using real time and separate run bands', () => {
    const container = document.createElement('div');
    renderPreviewChart(container, {
      priceSeries: [0, 2].map((index) => ({ ...booking(index), price: 0.2 })),
      scheduledHours: [booking(0), booking(2)],
    });
    expect(container.querySelectorAll('.pchart__band')).toHaveLength(2);
    expect(container.querySelector('.pchart__line')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
  });
});
