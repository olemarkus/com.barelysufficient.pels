import {
  buildProjectionCumulative,
  formatBudgetChartTooltip,
} from '../src/ui/budgetRedesignChart.ts';

describe('Budget redesign chart helpers', () => {
  it('keeps real zeroes but omits missing tooltip values', () => {
    expect(formatBudgetChartTooltip([
      { seriesName: 'Actual', value: 0 },
      { seriesName: 'Projection', value: null },
      { seriesName: 'Plan', value: undefined },
      { seriesName: 'Price', value: 1.23 },
    ], 'kr/kWh')).toBe('Actual: 0.00 kWh<br/>Price: 1.23 kr/kWh');
  });

  it('includes the current-hour remainder in the today projection', () => {
    expect(buildProjectionCumulative({
      planned: [1, 1, 1],
      actualCumulative: [0.4, null, null],
      actualUpToIndex: 0,
      view: 'today',
    })).toEqual([1, 2, 3]);
  });

  it('does not subtract over-plan current-hour usage from the projection', () => {
    expect(buildProjectionCumulative({
      planned: [1, 1, 1],
      actualCumulative: [1.2, null, null],
      actualUpToIndex: 0,
      view: 'today',
    })).toEqual([1.2, 2.2, 3.2]);
  });
});
