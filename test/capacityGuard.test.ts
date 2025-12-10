import CapacityGuard from '../capacityGuard';

describe('CapacityGuard', () => {
  let originalNow: () => number;
  let mockTime: number;

  beforeEach(() => {
    originalNow = Date.now;
    mockTime = originalNow();
    jest.spyOn(Date, 'now').mockImplementation(() => mockTime);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const advanceTime = (ms: number) => {
    mockTime += ms;
  };

  describe('Limit calculations', () => {
    it('returns default soft limit when no provider', () => {
      const guard = new CapacityGuard({ limitKw: 5, softMarginKw: 0.2 });
      expect(guard.getSoftLimit()).toBe(4.8);
    });

    it('uses soft limit provider when set', () => {
      const guard = new CapacityGuard({ limitKw: 5, softMarginKw: 0.2 });
      guard.setSoftLimitProvider(() => 3.5);
      expect(guard.getSoftLimit()).toBe(3.5);
    });

    it('uses shortfall threshold provider when set', () => {
      const guard = new CapacityGuard({ limitKw: 5, softMarginKw: 0.2 });
      guard.setShortfallThresholdProvider(() => 10.0);
      expect(guard.getShortfallThreshold()).toBe(10.0);
    });

    it('falls back to soft limit for shortfall threshold', () => {
      const guard = new CapacityGuard({ limitKw: 5, softMarginKw: 0.2 });
      expect(guard.getShortfallThreshold()).toBe(4.8);
    });
  });

  describe('Power tracking', () => {
    it('reports and retrieves total power', () => {
      const guard = new CapacityGuard();
      expect(guard.getLastTotalPower()).toBeNull();

      guard.reportTotalPower(3.5);
      expect(guard.getLastTotalPower()).toBe(3.5);
    });

    it('calculates headroom correctly', () => {
      const guard = new CapacityGuard({ limitKw: 5, softMarginKw: 0.2 });
      expect(guard.getHeadroom()).toBeNull();

      guard.reportTotalPower(3.0);
      expect(guard.getHeadroom()).toBeCloseTo(1.8, 5); // 4.8 - 3.0

      guard.reportTotalPower(5.0);
      expect(guard.getHeadroom()).toBeCloseTo(-0.2, 5); // 4.8 - 5.0
    });

    it('ignores invalid power values', () => {
      const guard = new CapacityGuard();
      guard.reportTotalPower(3.0);
      guard.reportTotalPower(NaN);
      expect(guard.getLastTotalPower()).toBe(3.0);
    });
  });

  describe('Shedding state', () => {
    it('starts with shedding inactive', () => {
      const guard = new CapacityGuard();
      expect(guard.isSheddingActive()).toBe(false);
    });

    it('can set shedding active', async () => {
      const callbacks: string[] = [];
      const guard = new CapacityGuard({
        onSheddingStart: () => { callbacks.push('start'); },
        onSheddingEnd: () => { callbacks.push('end'); },
      });

      await guard.setSheddingActive(true);
      expect(guard.isSheddingActive()).toBe(true);
      expect(callbacks).toEqual(['start']);

      // Setting same value doesn't trigger callback
      await guard.setSheddingActive(true);
      expect(callbacks).toEqual(['start']);

      await guard.setSheddingActive(false);
      expect(guard.isSheddingActive()).toBe(false);
      expect(callbacks).toEqual(['start', 'end']);
    });
  });

  describe('Shortfall detection', () => {
    it('starts without shortfall', () => {
      const guard = new CapacityGuard();
      expect(guard.isInShortfall()).toBe(false);
    });

    it('enters shortfall when threshold exceeded and no candidates', async () => {
      const shortfallEvents: Array<{ type: string; deficit?: number }> = [];
      const guard = new CapacityGuard({
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: (deficit) => { shortfallEvents.push({ type: 'shortfall', deficit }); },
      });

      guard.reportTotalPower(5.5); // Over threshold (4.8)
      await guard.checkShortfall(false, 0.7); // No candidates

      expect(shortfallEvents).toHaveLength(1);
      expect(shortfallEvents[0].type).toBe('shortfall');
      expect(guard.isInShortfall()).toBe(true);
    });

    it('does not enter shortfall when candidates remain', async () => {
      const shortfallEvents: string[] = [];
      const guard = new CapacityGuard({
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => { shortfallEvents.push('shortfall'); },
      });

      guard.reportTotalPower(5.5);
      await guard.checkShortfall(true, 0.7); // Has candidates

      expect(shortfallEvents).toHaveLength(0);
      expect(guard.isInShortfall()).toBe(false);
    });

    it('does not enter shortfall when under threshold', async () => {
      const shortfallEvents: string[] = [];
      const guard = new CapacityGuard({
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => { shortfallEvents.push('shortfall'); },
      });

      guard.reportTotalPower(4.0); // Under threshold
      await guard.checkShortfall(false, 0);

      expect(shortfallEvents).toHaveLength(0);
      expect(guard.isInShortfall()).toBe(false);
    });
  });

  describe('Shortfall clearing with hysteresis', () => {
    it('requires 60s sustained positive headroom to clear shortfall', async () => {
      const events: string[] = [];
      const guard = new CapacityGuard({
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => { events.push('shortfall'); },
        onShortfallCleared: () => { events.push('cleared'); },
      });

      // Enter shortfall
      guard.reportTotalPower(5.5);
      await guard.checkShortfall(false, 0.7);
      expect(guard.isInShortfall()).toBe(true);
      expect(events).toEqual(['shortfall']);

      // Power drops below threshold with margin
      guard.reportTotalPower(4.5); // Headroom = 0.3kW
      await guard.checkShortfall(true, 0);
      expect(guard.isInShortfall()).toBe(true); // Timer started

      // Wait 30s - not enough
      advanceTime(30000);
      await guard.checkShortfall(true, 0);
      expect(guard.isInShortfall()).toBe(true);

      // Wait another 31s (total 61s) - should clear
      advanceTime(31000);
      await guard.checkShortfall(true, 0);
      expect(guard.isInShortfall()).toBe(false);
      expect(events).toEqual(['shortfall', 'cleared']);
    });

    it('resets timer when headroom drops', async () => {
      const events: string[] = [];
      const guard = new CapacityGuard({
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => { events.push('shortfall'); },
        onShortfallCleared: () => { events.push('cleared'); },
      });

      // Enter shortfall
      guard.reportTotalPower(5.5);
      await guard.checkShortfall(false, 0.7);

      // Start timer
      guard.reportTotalPower(4.5);
      await guard.checkShortfall(true, 0);

      // Wait 30s
      advanceTime(30000);
      await guard.checkShortfall(true, 0);

      // Power spikes - resets timer
      guard.reportTotalPower(4.7); // Headroom = 0.1kW (below 0.2 margin)
      await guard.checkShortfall(true, 0);

      // Resume good headroom - timer restarts from scratch
      guard.reportTotalPower(4.5);
      await guard.checkShortfall(true, 0); // Timer starts here

      // Wait 59s - not quite enough
      advanceTime(59000);
      await guard.checkShortfall(true, 0);
      expect(guard.isInShortfall()).toBe(true);

      // Wait 2s more (total 61s from restart) - NOW should clear
      advanceTime(2000);
      await guard.checkShortfall(true, 0);
      expect(guard.isInShortfall()).toBe(false);
    });
  });

  describe('uses separate shortfall threshold', () => {
    it('uses shortfall threshold provider for detection', async () => {
      const events: string[] = [];
      const guard = new CapacityGuard({
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => { events.push('shortfall'); },
      });

      // Set higher shortfall threshold (e.g., for end-of-hour where soft limit is lowered)
      guard.setSoftLimitProvider(() => 3.0); // Lowered for shedding
      guard.setShortfallThresholdProvider(() => 6.0); // Real limit for shortfall

      // Power is 5kW - over soft limit (3) but under shortfall threshold (6)
      guard.reportTotalPower(5.0);
      await guard.checkShortfall(false, 2.0);

      expect(events).toHaveLength(0); // No shortfall
      expect(guard.isInShortfall()).toBe(false);

      // Power exceeds shortfall threshold
      guard.reportTotalPower(7.0);
      await guard.checkShortfall(false, 4.0);

      expect(events).toEqual(['shortfall']);
      expect(guard.isInShortfall()).toBe(true);
    });
  });
});
