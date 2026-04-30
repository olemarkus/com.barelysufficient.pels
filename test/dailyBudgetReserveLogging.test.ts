import { logUncontrolledReserveDebug } from '../lib/dailyBudget/dailyBudgetReserveLogging';

describe('daily budget reserve logging', () => {
  it('logs the selected unmanaged reserve mode', () => {
    const structuredDebug = vi.fn();

    logUncontrolledReserveDebug({
      plan: {
        plannedKWh: [],
        priceData: {
          priceShapingActive: false,
          priceFactors: [],
        },
        shouldLog: true,
        uncontrolledReserveDiagnostics: {
          totalReservedKWh: 1,
          averageQuantile: 0.6,
          lowConfidenceHours: 0,
          volatileHours: [],
          hours: [],
        },
      },
      reserveMode: 1,
      structuredDebug,
    });

    expect(structuredDebug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'uncontrolled_reserve_plan',
      mode: 'conservative',
    }));
  });
});
