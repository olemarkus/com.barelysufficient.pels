import CapacityGuard from '../capacityGuard';

describe('CapacityGuard', () => {
  let mockNow: number;

  beforeEach(() => {
    mockNow = 1000000; // Start at some fixed time
    jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Helper to advance mock time
  const advanceTime = (ms: number) => {
    mockNow += ms;
  };

  it('sheds higher priority NUMBER devices first (priority 1 = most important, shed last)', async () => {
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

    // devA has priority 10 (less important), devB has priority 1 (most important)
    guard.requestOn('devA', 'A', 3, 10);
    guard.requestOn('devB', 'B', 2, 1);
    guard.reportTotalPower(7); // soft limit = 4.8 -> headroom = -2.2

    await guard.tick();

    // devA (priority 10, less important) should be shed first
    expect(shedOrder).toEqual(['devA']);
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

    guard.requestOn('devA', 'Heater', 1, 1); // priority 1 = most important
    guard.requestOn('devB', 'Washer', 1.5, 10); // priority 10 = less important, shed first

    guard.reportTotalPower(2); // below soft, no shed
    await guard.tick();
    expect(shedOrder).toEqual([]);

    guard.reportTotalPower(4.5); // headroom = -0.6, should shed devB (priority 10, less important)
    await guard.tick();
    expect(shedOrder).toEqual(['devB']);
  });

  it('respects hourly energy budget by allowing higher draw when budget remains', async () => {
    const shedOrder: string[] = [];
    const remainingHours = 0.5;
    const usedKWh = 2.5;
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

    // devA has priority 10 (less important), devB has priority 1 (most important)
    guard.requestOn('devA', 'A', 3, 10);
    guard.requestOn('devB', 'B', 2, 1);

    guard.reportTotalPower(6); // current draw
    await guard.tick();
    // devA (priority 10, less important) should be shed first
    expect(shedOrder).toEqual(['devA']);
  });

  it('requires hysteresis margin before clearing shortfall', async () => {
    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.3, // soft limit = 4.7
      dryRun: true,
      intervalMs: 3000, // 3 second tick interval
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // No controllables - any overshoot causes immediate shortfall
    guard.reportTotalPower(5.0); // headroom = 4.7 - 5.0 = -0.3
    await guard.tick();

    expect(shortfallEvents).toHaveLength(1);
    expect(shortfallEvents[0].type).toBe('shortfall');
    expect(guard.isInShortfall()).toBe(true);

    // Power drops slightly but still negative headroom - should stay in shortfall
    guard.reportTotalPower(4.75); // headroom = 4.7 - 4.75 = -0.05
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // No new events
    expect(guard.isInShortfall()).toBe(true);

    // Power drops to exactly soft limit - headroom = 0, but not enough margin to clear
    guard.reportTotalPower(4.7); // headroom = 0
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // Still no cleared event
    expect(guard.isInShortfall()).toBe(true);

    // Power drops slightly below soft limit - headroom = +0.1, still not enough margin
    guard.reportTotalPower(4.6); // headroom = +0.1
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // Still no cleared event (margin not met)
    expect(guard.isInShortfall()).toBe(true);

    // Power drops enough to provide 0.2 kW hysteresis margin
    // But now also needs sustained time - simulate ticks to get > 60s
    guard.reportTotalPower(4.5); // headroom = +0.2
    advanceTime(3000);
    await guard.tick(); // tick 1 - starts timer at T

    // Advance 57s (19 more ticks of 3s each) - still under 60s
    for (let i = 0; i < 19; i++) {
      advanceTime(3000);
      await guard.tick();
    }
    expect(shortfallEvents).toHaveLength(1); // elapsed 60s, not yet (needs > 60s)
    expect(guard.isInShortfall()).toBe(true);

    advanceTime(3000);
    await guard.tick(); // elapsed 63s > 60s, NOW should clear
    expect(shortfallEvents).toHaveLength(2);
    expect(shortfallEvents[1].type).toBe('cleared');
    expect(guard.isInShortfall()).toBe(false);
  });

  it('requires sustained positive headroom before clearing shortfall (time-based hysteresis)', async () => {
    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.3, // soft limit = 4.7
      dryRun: true,
      intervalMs: 3000, // 3 second tick interval
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // Enter shortfall
    guard.reportTotalPower(5.0); // headroom = -0.3
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(shortfallEvents[0].type).toBe('shortfall');

    // Power drops to positive headroom with margin - but needs sustained time
    guard.reportTotalPower(4.5); // headroom = +0.2 (meets margin requirement)
    advanceTime(3000);
    await guard.tick();
    // First tick with positive headroom - should NOT clear yet (needs sustained period)
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Power spikes back up briefly - resets the timer
    guard.reportTotalPower(4.8); // headroom = -0.1 (back in overshoot)
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // Still in shortfall
    expect(guard.isInShortfall()).toBe(true);

    // Power drops again - timer restarts
    guard.reportTotalPower(4.5); // headroom = +0.2
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // First tick of new sustained period - timer starts
    expect(guard.isInShortfall()).toBe(true);

    // Sustained positive headroom - need more ticks to exceed 60s
    // Advance 57s more (19 ticks of 3s)
    for (let i = 0; i < 19; i++) {
      advanceTime(3000);
      await guard.tick();
    }
    expect(shortfallEvents).toHaveLength(1); // elapsed 60s, still waiting
    expect(guard.isInShortfall()).toBe(true);

    // Next tick - NOW should clear (63s > 60s)
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(2);
    expect(shortfallEvents[1].type).toBe('cleared');
    expect(guard.isInShortfall()).toBe(false);
  });

  it('resets shortfall clear timer when power spikes back into overshoot during waiting period', async () => {
    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.3, // soft limit = 4.7
      dryRun: true,
      intervalMs: 3000,
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // Enter shortfall
    guard.reportTotalPower(5.0); // headroom = -0.3
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Start waiting period with positive headroom
    guard.reportTotalPower(4.5); // headroom = +0.2
    advanceTime(3000);
    await guard.tick(); // Timer starts
    advanceTime(3000);
    await guard.tick(); // 3s elapsed
    advanceTime(3000);
    await guard.tick(); // 6s elapsed
    expect(shortfallEvents).toHaveLength(1); // Still waiting
    expect(guard.isInShortfall()).toBe(true);

    // Power spikes back into overshoot at 6s - timer should reset
    guard.reportTotalPower(5.2); // headroom = -0.5
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // Still in shortfall (no new shortfall event since already in shortfall)
    expect(guard.isInShortfall()).toBe(true);

    // Power drops again - timer restarts from zero
    guard.reportTotalPower(4.5); // headroom = +0.2
    advanceTime(3000);
    await guard.tick(); // New timer starts at 0s

    // Advance 57s (19 more ticks) - only 60s elapsed since reset
    for (let i = 0; i < 19; i++) {
      advanceTime(3000);
      await guard.tick();
    }
    expect(shortfallEvents).toHaveLength(1); // Still waiting (60s since reset, needs > 60s)
    expect(guard.isInShortfall()).toBe(true);

    advanceTime(3000);
    await guard.tick(); // 63s elapsed - NOW should clear
    expect(shortfallEvents).toHaveLength(2);
    expect(shortfallEvents[1].type).toBe('cleared');
    expect(guard.isInShortfall()).toBe(false);
  });

  it('resets shortfall clear timer when headroom drops below margin during waiting period', async () => {
    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.3, // soft limit = 4.7
      dryRun: true,
      intervalMs: 3000,
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // Enter shortfall
    guard.reportTotalPower(5.0); // headroom = -0.3
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Start waiting period with positive headroom meeting margin
    guard.reportTotalPower(4.5); // headroom = +0.2 (exactly at margin)
    advanceTime(3000);
    await guard.tick(); // Timer starts
    advanceTime(3000);
    await guard.tick(); // 3s elapsed
    advanceTime(3000);
    await guard.tick(); // 6s elapsed
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Power rises slightly - headroom drops below margin but still positive
    guard.reportTotalPower(4.6); // headroom = +0.1 (below 0.2 margin)
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // Timer should reset
    expect(guard.isInShortfall()).toBe(true);

    // Power drops back to good headroom - timer restarts
    guard.reportTotalPower(4.5); // headroom = +0.2
    advanceTime(3000);
    await guard.tick(); // New timer starts

    // Advance 57s (19 more ticks) - still at 60s
    for (let i = 0; i < 19; i++) {
      advanceTime(3000);
      await guard.tick();
    }
    expect(shortfallEvents).toHaveLength(1); // elapsed 60s - still waiting
    expect(guard.isInShortfall()).toBe(true);

    advanceTime(3000);
    await guard.tick(); // 63s - should clear
    expect(shortfallEvents).toHaveLength(2);
    expect(shortfallEvents[1].type).toBe('cleared');
    expect(guard.isInShortfall()).toBe(false);
  });
});
