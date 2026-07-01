import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderBudgetOverview, type BudgetOverviewProps } from '../src/ui/views/BudgetOverview.tsx';

/* -------------------------------------------------------------------------- *
 * Budget hero managed/background split bar.
 *
 * The Budget hero renders today's managed vs background attribution as a
 * compact labeled stacked bar (replacing the former dim
 * "Managed … · Background …" meta text) so the split is glanceable at arm's
 * length: segment widths carry the shares, the label row carries the exact
 * kWh values with the same swatch colours the Hourly plan chart stacks with.
 * -------------------------------------------------------------------------- */

const buildProps = (overrides: Partial<BudgetOverviewProps> = {}): BudgetOverviewProps => ({
  localView: 'plan',
  view: 'today',
  hero: {
    headlineLabel: 'Projected today',
    comparison: '9.0 / 12.0 kWh',
    delta: null,
    budgetRemainingLine: null,
    split: {
      managedKWh: 1.8, backgroundKWh: 2.7, beforeSolar: false, budgetKWh: 12, usedKWh: 4.5,
    },
    priceTagline: null,
    exportPriceLine: null,
    decision: null,
    heroTone: 'ok',
  },
  chart: null,
  confidence: null,
  adjust: {
    draft: { enabled: true, dailyBudgetKWh: 60, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    active: { enabled: true, dailyBudgetKWh: 60, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    candidate: null,
    activeChart: null,
    candidateChart: null,
    comparisonDayView: 'today',
    comparisonDayLabel: 'Today',
    comparisonShowPrice: false,
    status: 'clean',
    busy: false,
    hardCapKw: 12,
    safetyMarginKw: 1,
  },
  allocationWarning: null,
  priceLevelChip: null,
  weatherInsight: null,
  adjustReturnTarget: 'plan',
  onReturnToSettings: () => {},
  onLocalViewChange: () => {},
  onDayChange: () => {},
  onChartModeChange: () => {},
  onChartUnitChange: () => {},
  onAdjustFieldChange: () => {},
  onPreview: () => {},
  onApply: () => {},
  onDiscard: () => {},
  ...overrides,
});

const withSplit = (
  split: BudgetOverviewProps['hero']['split'],
): BudgetOverviewProps => {
  const base = buildProps();
  return { ...base, hero: { ...base.hero, split } };
};

let mount: HTMLElement;

beforeEach(() => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('BudgetHero managed/background split bar', () => {
  it('scales the two segments against the daily budget so the empty track is the remaining kWh', () => {
    renderBudgetOverview(mount, buildProps());
    const split = mount.querySelector<HTMLElement>('#budget-redesign-split');
    expect(split).not.toBeNull();

    const managedSeg = split?.querySelector<HTMLElement>('.budget-hero-split__seg--managed');
    const backgroundSeg = split?.querySelector<HTMLElement>('.budget-hero-split__seg--background');
    expect(managedSeg).not.toBeNull();
    expect(backgroundSeg).not.toBeNull();
    // Widths are shares of the 12 kWh BUDGET, not of the used total — the
    // meter must not glance-read "budget exhausted" on a 4.5-of-12 day:
    // managed 1.8/12 = 15%, background 2.7/12 = 22.5%, remaining 62.5% of
    // the track stays empty (the 7.5 kWh left).
    expect(managedSeg?.style.width).toBe('15%');
    expect(backgroundSeg?.style.width).toBe('22.5%');
    // Under budget: no overflow tone anywhere.
    expect(split?.querySelector('[data-over-budget]')).toBeNull();

    // Label row: swatch + value per side, in the chart legend's vocabulary.
    expect(split?.textContent).toContain('Managed 1.8 kWh');
    expect(split?.textContent).toContain('Background 2.7 kWh');
    expect(split?.querySelector('.budget-chart-legend__swatch--managed')).not.toBeNull();
    expect(split?.querySelector('.budget-chart-legend__swatch--background')).not.toBeNull();
    expect(split?.textContent).not.toContain('Before solar:');
  });

  it('fills the track and marks the trailing segment with the overflow tone when over budget', () => {
    renderBudgetOverview(mount, withSplit({
      managedKWh: 5.0, backgroundKWh: 9.0, beforeSolar: false, budgetKWh: 12, usedKWh: 14.0,
    }));
    const split = mount.querySelector<HTMLElement>('#budget-redesign-split');
    const managedSeg = split?.querySelector<HTMLElement>('.budget-hero-split__seg--managed');
    const backgroundSeg = split?.querySelector<HTMLElement>('.budget-hero-split__seg--background');
    // Over budget the scale grows to the used total, so the bar is exactly
    // full: 5/14 + 9/14 = 100%.
    expect(managedSeg?.style.width).toBe(`${(5 / 14) * 100}%`);
    expect(backgroundSeg?.style.width).toBe(`${(9 / 14) * 100}%`);
    // Overflow grammar from the Overview power bar: the trailing rendered
    // segment carries the tone, and only that one.
    expect(backgroundSeg?.hasAttribute('data-over-budget')).toBe(true);
    expect(managedSeg?.hasAttribute('data-over-budget')).toBe(false);
  });

  it('paints the NET usage on before-solar days while the labels keep the gross figures', () => {
    renderBudgetOverview(mount, withSplit({
      managedKWh: 2.0, backgroundKWh: 1.0, beforeSolar: true, budgetKWh: 12, usedKWh: 0.6,
    }));
    const split = mount.querySelector<HTMLElement>('#budget-redesign-split');
    expect(split?.textContent).toContain('Before solar:');
    expect(split?.textContent).toContain('Managed 2.0 kWh');
    expect(split?.textContent).toContain('Background 1.0 kWh');
    // Gross 3.0 kWh scales down to the 0.6 kWh net that actually counted
    // against the budget: managed = 2.0 × (0.6/3) / 12 ≈ 3.33%.
    const managedSeg = split?.querySelector<HTMLElement>('.budget-hero-split__seg--managed');
    const backgroundSeg = split?.querySelector<HTMLElement>('.budget-hero-split__seg--background');
    expect(Number.parseFloat(managedSeg?.style.width ?? '')).toBeCloseTo((2.0 * (0.6 / 3) / 12) * 100, 6);
    expect(Number.parseFloat(backgroundSeg?.style.width ?? '')).toBeCloseTo((1.0 * (0.6 / 3) / 12) * 100, 6);
  });

  it('keeps the empty track when nothing is used yet (full budget left)', () => {
    renderBudgetOverview(mount, withSplit({
      managedKWh: 0, backgroundKWh: 0, beforeSolar: false, budgetKWh: 12, usedKWh: 0,
    }));
    const split = mount.querySelector<HTMLElement>('#budget-redesign-split');
    expect(split).not.toBeNull();
    // The empty meter IS the message — the whole budget remains.
    expect(split?.querySelector('.budget-hero-split__track')).not.toBeNull();
    expect(split?.querySelector('.budget-hero-split__seg--managed')).toBeNull();
    expect(split?.querySelector('.budget-hero-split__seg--background')).toBeNull();
    expect(split?.textContent).toContain('Managed 0.0 kWh');
  });

  it('drops the track (labels only) when no budget is configured', () => {
    renderBudgetOverview(mount, withSplit({
      managedKWh: 1.8, backgroundKWh: 2.7, beforeSolar: false, budgetKWh: null, usedKWh: 4.5,
    }));
    const split = mount.querySelector<HTMLElement>('#budget-redesign-split');
    expect(split).not.toBeNull();
    expect(split?.querySelector('.budget-hero-split__track')).toBeNull();
    expect(split?.textContent).toContain('Managed 1.8 kWh');
  });

  it('renders no split DOM at all when the hero carries no split', () => {
    renderBudgetOverview(mount, withSplit(null));
    expect(mount.querySelector('#budget-redesign-split')).toBeNull();
  });
});
