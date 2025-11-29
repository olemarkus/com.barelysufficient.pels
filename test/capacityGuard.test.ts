import CapacityGuard from '../capacityGuard';

describe('CapacityGuard', () => {
  it('sheds lowest-priority devices first to restore headroom', async () => {
    const shedOrder: string[] = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.2,
      dryRun: false,
      actuator: async (deviceId) => {
        shedOrder.push(deviceId);
      },
      intervalMs: 100000, // avoid ticking automatically
    });

    guard.requestOn('devA', 'A', 3, 5);
    guard.requestOn('devB', 'B', 2, 10);
    guard.reportTotalPower(7); // soft limit = 4.8 -> headroom = -2.2

    await guard.tick();

    expect(shedOrder).toEqual(['devA']); // priority 5 sheds before 10
  });

  it('denies allocation when plan limit is exceeded', () => {
    const guard = new CapacityGuard({ limitKw: 5, softMarginKw: 0.2, dryRun: true });
    const okFirst = guard.requestOn('devA', 'A', 3, 1);
    const okSecond = guard.requestOn('devB', 'B', 3, 2); // 3 + 3 > 4.8
    expect(okFirst).toBe(true);
    expect(okSecond).toBe(false);
  });

  it('sheds devices when total power overshoots soft limit', async () => {
    const shedOrder: string[] = [];
    const guard = new CapacityGuard({
      limitKw: 4,
      softMarginKw: 0.1, // soft = 3.9
      dryRun: false,
      actuator: async (deviceId) => {
        shedOrder.push(deviceId);
      },
      intervalMs: 100000,
    });

    guard.requestOn('devA', 'Heater', 1, 5);
    guard.requestOn('devB', 'Washer', 1.5, 1); // lower priority number = shed first

    guard.reportTotalPower(2); // below soft, no shed
    await guard.tick();
    expect(shedOrder).toEqual([]);

    guard.reportTotalPower(4.5); // headroom = -0.6, should shed devB (1.5kW)
    await guard.tick();
    expect(shedOrder).toEqual(['devB']);
  });

  it('respects hourly energy budget by allowing higher draw when budget remains', async () => {
    const shedOrder: string[] = [];
    let remainingHours = 0.5;
    let usedKWh = 2.5;
    const budgetKWh = 5;
    const guard = new CapacityGuard({
      dryRun: false,
      softMarginKw: 0,
      intervalMs: 100000,
      actuator: async (deviceId) => {
        shedOrder.push(deviceId);
      },
    });

    guard.setSoftLimitProvider(() => {
      const remainingKWh = Math.max(0, budgetKWh - usedKWh);
      return remainingKWh / remainingHours;
    });

    guard.requestOn('devA', 'A', 3, 5);
    guard.requestOn('devB', 'B', 2, 1); // shed first

    guard.reportTotalPower(6); // current draw
    await guard.tick();
    expect(shedOrder).toEqual(['devB']); // shed 2kW to get within dynamic soft limit (5kW)
  });
});
