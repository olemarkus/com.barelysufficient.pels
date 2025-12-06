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
    // Without a shortfall threshold provider, shortfall uses soft limit.
    // limitKw: 5, softMarginKw: 0.3 → soft limit = 4.7kW
    // Shortfall triggers when power > 4.7kW
    // Shortfall clears when headroom >= 0.2kW sustained for 60s (power <= 4.5kW)
    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.3, // soft limit = 4.7kW
      dryRun: true,
      intervalMs: 3000,
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // No controllables - exceeding soft limit (4.7kW) causes immediate shortfall
    guard.reportTotalPower(5.0); // 0.3kW over soft limit
    await guard.tick();

    expect(shortfallEvents).toHaveLength(1);
    expect(shortfallEvents[0].type).toBe('shortfall');
    expect(guard.isInShortfall()).toBe(true);

    // Power drops to 4.7kW (exactly at soft limit) - headroom = 0, not enough margin
    guard.reportTotalPower(4.7);
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // No new events
    expect(guard.isInShortfall()).toBe(true);

    // Power drops to 4.6kW - headroom = 0.1kW, still not enough margin (need 0.2)
    guard.reportTotalPower(4.6);
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1); // Still in shortfall
    expect(guard.isInShortfall()).toBe(true);

    // Power drops to 4.5kW - headroom = 0.2kW, meets margin but needs sustained time
    guard.reportTotalPower(4.5);
    advanceTime(3000);
    await guard.tick(); // starts timer

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
    // Without a shortfall threshold provider, shortfall uses soft limit.
    // limitKw: 5, softMarginKw: 0.3 → soft limit = 4.7kW
    // Shortfall clears when headroom >= 0.2kW sustained for 60s (power <= 4.5kW)
    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.3,
      dryRun: true,
      intervalMs: 3000,
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // Enter shortfall - power exceeds soft limit (4.7kW)
    guard.reportTotalPower(5.0);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(shortfallEvents[0].type).toBe('shortfall');

    // Power drops to 4.4kW - headroom = 0.3kW, meets margin, starts timer
    guard.reportTotalPower(4.4);
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Power spikes to 4.55kW - headroom = 0.15kW (below margin), resets timer
    guard.reportTotalPower(4.55);
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Power drops back to 4.4kW - timer restarts
    guard.reportTotalPower(4.4);
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Sustained positive headroom - advance 57s more (19 ticks of 3s)
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
    // Without a shortfall threshold provider, shortfall uses soft limit (4.7kW).
    // Timer resets when power exceeds soft limit again (back in overshoot)
    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.3, // soft limit = 4.7kW
      dryRun: true,
      intervalMs: 3000,
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // Enter shortfall - power exceeds soft limit (4.7kW)
    guard.reportTotalPower(5.0);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Start waiting period - power drops with margin (headroom = 0.3kW)
    guard.reportTotalPower(4.4);
    advanceTime(3000);
    await guard.tick(); // Timer starts
    advanceTime(3000);
    await guard.tick(); // 3s elapsed
    advanceTime(3000);
    await guard.tick(); // 6s elapsed
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Power spikes back above soft limit - timer resets (back in overshoot)
    guard.reportTotalPower(4.9); // headroom = -0.2kW
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Power drops again - timer restarts from zero
    guard.reportTotalPower(4.4);
    advanceTime(3000);
    await guard.tick(); // New timer starts

    // Advance 57s (19 more ticks) - 60s elapsed since reset
    for (let i = 0; i < 19; i++) {
      advanceTime(3000);
      await guard.tick();
    }
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    advanceTime(3000);
    await guard.tick(); // 63s elapsed - NOW should clear
    expect(shortfallEvents).toHaveLength(2);
    expect(shortfallEvents[1].type).toBe('cleared');
    expect(guard.isInShortfall()).toBe(false);
  });

  it('resets shortfall clear timer when headroom drops below margin during waiting period', async () => {
    // Without a shortfall threshold provider, shortfall uses soft limit (4.7kW).
    // Timer resets when headroom drops below 0.2kW margin (power > 4.5kW)
    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const guard = new CapacityGuard({
      limitKw: 5,
      softMarginKw: 0.3, // soft limit = 4.7kW
      dryRun: true,
      intervalMs: 3000,
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // Enter shortfall - power exceeds soft limit (4.7kW)
    guard.reportTotalPower(5.0);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Start waiting period - power at 4.4kW, headroom = 0.3kW (exceeds 0.2 margin)
    guard.reportTotalPower(4.4);
    advanceTime(3000);
    await guard.tick(); // Timer starts
    advanceTime(3000);
    await guard.tick(); // 3s elapsed
    advanceTime(3000);
    await guard.tick(); // 6s elapsed
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Power rises to 4.55kW - headroom = 0.15kW (below 0.2 margin), timer resets
    guard.reportTotalPower(4.55);
    advanceTime(3000);
    await guard.tick();
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    // Power drops back to 4.4kW - timer restarts
    guard.reportTotalPower(4.4);
    advanceTime(3000);
    await guard.tick(); // New timer starts

    // Advance 57s (19 more ticks)
    for (let i = 0; i < 19; i++) {
      advanceTime(3000);
      await guard.tick();
    }
    expect(shortfallEvents).toHaveLength(1);
    expect(guard.isInShortfall()).toBe(true);

    advanceTime(3000);
    await guard.tick(); // 63s - should clear
    expect(shortfallEvents).toHaveLength(2);
    expect(shortfallEvents[1].type).toBe('cleared');
    expect(guard.isInShortfall()).toBe(false);
  });

  it('should NOT trigger shortfall when over soft limit but under shortfall threshold (end-of-hour mode)', async () => {
    // In end-of-hour mode:
    // - Soft limit is artificially lowered (e.g., 6.8kW) to prepare for next hour
    // - Shortfall threshold remains high (e.g., 15kW) based on actual budget
    // - Shedding happens when power > soft limit
    // - Shortfall only triggers when power > shortfall threshold
    //
    // This prevents false shortfall alerts when we're just constraining to sustainable rate.

    const shortfallEvents: Array<{ type: 'shortfall' | 'cleared'; deficit?: number }> = [];
    const shedOrder: string[] = [];

    const guard = new CapacityGuard({
      limitKw: 15, // Not used when providers are set
      softMarginKw: 0,
      dryRun: false,
      intervalMs: 3000,
      actuator: async (deviceId) => {
        shedOrder.push(deviceId);
      },
      onShortfall: async (deficitKw) => {
        shortfallEvents.push({ type: 'shortfall', deficit: deficitKw });
      },
      onShortfallCleared: async () => {
        shortfallEvents.push({ type: 'cleared' });
      },
    });

    // Simulate end-of-hour: soft limit is artificially lowered for shedding
    guard.setSoftLimitProvider(() => 6.8);
    // But shortfall threshold remains at the actual budget-based limit (burst rate)
    guard.setShortfallThresholdProvider(() => 15.0);

    // Register one controllable device
    guard.requestOn('heater', 'Heater', 2.0, 1);

    // Total power is 7.3kW - over soft limit (6.8kW) but well under shortfall threshold (15kW)
    guard.reportTotalPower(7.3);
    await guard.tick();

    // The heater should be shed to try to get under soft limit
    expect(shedOrder).toEqual(['heater']);

    // Simulate: after shedding heater, uncontrolled load is still 7.3kW
    guard.reportTotalPower(7.3);
    await guard.tick();

    // Should NOT trigger shortfall - we're under the shortfall threshold (15kW)
    expect(shortfallEvents).toHaveLength(0);
    expect(guard.isInShortfall()).toBe(false);

    // Now simulate exceeding the shortfall threshold
    guard.reportTotalPower(16.0);
    await guard.tick();

    // NOW should trigger shortfall - we're over the threshold (15kW)
    expect(shortfallEvents).toHaveLength(1);
    expect(shortfallEvents[0].type).toBe('shortfall');
    expect(guard.isInShortfall()).toBe(true);
  });
});
