import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';

describe('CapacityGuard', () => {
  let originalNow: () => number;
  let mockTime: number;

  beforeEach(() => {
    originalNow = Date.now;
    mockTime = originalNow();
    vi.spyOn(Date, 'now').mockImplementation(() => mockTime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const advanceTime = (ms: number) => {
    mockTime += ms;
  };

  describe('Limit calculations', () => {
    it('returns default soft limit when no provider', () => {
      const guard = createTestCapacityGuard({ homeId: 'main', limitKw: 5, softMarginKw: 0.2 });
      expect(guard.getSoftLimit()).toBe(4.8);
    });

    it('uses soft limit provider when set', () => {
      const guard = createTestCapacityGuard({ homeId: 'main', limitKw: 5, softMarginKw: 0.2 });
      guard.setSoftLimitProvider(() => 3.5);
      expect(guard.getSoftLimit()).toBe(3.5);
    });

    it('uses shortfall threshold provider when set', () => {
      const guard = createTestCapacityGuard({ homeId: 'main', limitKw: 5, softMarginKw: 0.2 });
      guard.setShortfallThresholdProvider(() => 10.0);
      expect(guard.getShortfallThreshold()).toBe(10.0);
    });

    it('falls back to hard limit for shortfall threshold', () => {
      const guard = createTestCapacityGuard({ homeId: 'main', limitKw: 5, softMarginKw: 0.2 });
      expect(guard.getShortfallThreshold()).toBe(5);
    });
  });

  describe('Power tracking', () => {
    it('reports and retrieves total power', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });
      expect(guard.getLastTotalPower()).toBeNull();

      guard.reportTotalPower(3.5);
      expect(guard.getLastTotalPower()).toBe(3.5);
    });

    it('calculates headroom correctly', () => {
      const guard = createTestCapacityGuard({ homeId: 'main', limitKw: 5, softMarginKw: 0.2 });
      expect(guard.getHeadroom()).toBeNull();

      guard.reportTotalPower(3.0);
      expect(guard.getHeadroom()).toBeCloseTo(1.8, 5); // 4.8 - 3.0

      guard.reportTotalPower(5.0);
      expect(guard.getHeadroom()).toBeCloseTo(-0.2, 5); // 4.8 - 5.0
    });

    it('ignores invalid power values', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });
      guard.reportTotalPower(3.0);
      guard.reportTotalPower(NaN);
      expect(guard.getLastTotalPower()).toBe(3.0);
    });
  });

  describe('Shedding state', () => {
    it('starts with shedding inactive', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });
      expect(guard.isSheddingActive()).toBe(false);
    });

    it('can set shedding active', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });

      guard.setSheddingActive(true);
      expect(guard.isSheddingActive()).toBe(true);

      // Setting the same value is a no-op.
      guard.setSheddingActive(true);
      expect(guard.isSheddingActive()).toBe(true);

      // No power reported, so headroom is unknown and the clear is not refused.
      guard.setSheddingActive(false);
      expect(guard.isSheddingActive()).toBe(false);
    });

    it('uses override headroom when clearing shedding state', () => {
      const guard = createTestCapacityGuard({
        homeId: 'main',
        limitKw: 4,
        softMarginKw: 0.5,
      });

      guard.reportTotalPower(3.65);
      guard.setSheddingActive(true);
      // Guard headroom is 4 - 0.5 - 3.65 = -0.15, below the clear threshold;
      // the override clears it because 0.45 >= SHEDDING_CLEAR_THRESHOLD_KW.
      guard.setSheddingActive(false, 0.45);

      expect(guard.isSheddingActive()).toBe(false);
    });

    it('refuses to clear the latch while headroom is below the clear threshold', () => {
      const guard = createTestCapacityGuard({ homeId: 'main', limitKw: 4, softMarginKw: 0 });

      guard.reportTotalPower(3.65);
      guard.setSheddingActive(true);
      // 4 - 3.65 = 0.35 kW, short of the 0.4 kW clear threshold.
      guard.setSheddingActive(false);

      expect(guard.isSheddingActive()).toBe(true);
    });
  });

  describe('Shortfall detection', () => {
    it('starts without shortfall', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });
      expect(guard.isInShortfall()).toBe(false);
    });

    it('enters shortfall when hard cap exceeded and no candidates', async () => {
      const shortfallEvents: Array<{ type: string; deficit?: number }> = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: (deficit) => { shortfallEvents.push({ type: 'shortfall', deficit }); },
      });

      guard.reportTotalPower(5.5); // Over hard cap (5.0)
      await guard.checkShortfall(false, 0.5); // No candidates

      expect(shortfallEvents).toHaveLength(1);
      expect(shortfallEvents[0].type).toBe('shortfall');
      expect(guard.isInShortfall()).toBe(true);
    });

    it('does not enter shortfall when candidates remain', async () => {
      const shortfallEvents: string[] = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => { shortfallEvents.push('shortfall'); },
      });

      guard.reportTotalPower(5.5); // Over hard cap
      await guard.checkShortfall(true, 0.5); // Has candidates

      expect(shortfallEvents).toHaveLength(0);
      expect(guard.isInShortfall()).toBe(false);
    });

    it('does not enter shortfall when under hard cap', async () => {
      const shortfallEvents: string[] = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => { shortfallEvents.push('shortfall'); },
      });

      guard.reportTotalPower(4.9); // Under hard cap but over soft limit
      await guard.checkShortfall(false, 0);

      expect(shortfallEvents).toHaveLength(0);
      expect(guard.isInShortfall()).toBe(false);
    });

    it('does not emit duplicate structured shortfall event while in shortfall', async () => {
      const logEvents: Array<Record<string, unknown>> = [];
      const structuredLog: Pick<import('../../lib/logging/logger').Logger, 'info'> = {
        info: (obj: Record<string, unknown>) => { logEvents.push(obj); },
      };
      const options = {
        homeId: 'h_area',
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => {},
        structuredLog,
      };
      const guard = createTestCapacityGuard(options);

      guard.reportTotalPower(5.5);
      await guard.checkShortfall(false, 0.5);
      expect(guard.isInShortfall()).toBe(true);
      expect(logEvents).toHaveLength(1);
      expect(logEvents[0]).toMatchObject({
        event: 'hard_cap_shortfall_detected',
        homeId: 'h_area',
        powerW: 5500,
        thresholdW: 5000,
        headroomW: -500,
        excessW: 500,
        remainingReducibleControlledLoad: null,
        remainingActionableControlledLoad: null,
        actuationInFlight: null,
      });
      const firstIncidentId = logEvents[0].incidentId;
      expect(firstIncidentId).toBeDefined();

      // Second shortfall check while already in shortfall should not emit another event
      guard.reportTotalPower(6.0);
      await guard.checkShortfall(false, 1.0);
      expect(logEvents).toHaveLength(1); // No new event
    });

    it('publishes alert candidates separately from the slower incident-clear latch', async () => {
      const candidates: Array<{ incidentId: string; deficitKw: number }> = [];
      const conditionCleared = vi.fn();
      const guard = createTestCapacityGuard({
        homeId: 'main',
        limitKw: 5,
        onShortfallAlertCandidate: (entry) => { candidates.push(entry); },
        onShortfallAlertConditionCleared: conditionCleared,
      });

      guard.reportTotalPower(5.5);
      await guard.checkShortfall(false, 0.5);
      await guard.checkShortfall(false, 0.6);

      expect(guard.isInShortfall()).toBe(true);
      expect(guard.isShortfallAlertConditionActive()).toBe(true);
      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toMatchObject({
        incidentId: candidates[0].incidentId,
        deficitKw: 0.6,
      });

      guard.reportTotalPower(4.5);
      expect(guard.isShortfallAlertConditionActive()).toBe(false);
      expect(conditionCleared).toHaveBeenCalledOnce();

      // A later high sample cannot silently resume the old hold. The planner
      // must first reconfirm that no further limiting candidates exist.
      guard.reportTotalPower(5.6);
      expect(candidates).toHaveLength(2);
      await guard.checkShortfall(false, 0.7);
      expect(candidates).toHaveLength(3);

      guard.reportTotalPower(4.5);
      await guard.checkShortfall(true, 0);

      expect(conditionCleared).toHaveBeenCalledTimes(3);
      expect(guard.isInShortfall()).toBe(true);
    });

    it('publishes the alert candidate even when the immediate state write rejects', async () => {
      const candidate = vi.fn();
      const guard = createTestCapacityGuard({
        homeId: 'main',
        limitKw: 5,
        onShortfall: () => Promise.reject(new Error('settings unavailable')),
        onShortfallAlertCandidate: candidate,
      });

      guard.reportTotalPower(5.5);
      await expect(guard.checkShortfall(false, 0.5)).rejects.toThrow('settings unavailable');

      expect(candidate).toHaveBeenCalledOnce();
      expect(guard.isShortfallAlertConditionActive()).toBe(true);
    });

    it('logs hard-shortfall diagnostics, planned-shed counters, and source metadata', async () => {
      const logEvents: Array<Record<string, unknown>> = [];
      const structuredLog: Pick<import('../../lib/logging/logger').Logger, 'info'> = {
        info: (obj: Record<string, unknown>) => { logEvents.push(obj); },
      };
      const guard = createTestCapacityGuard({
      homeId: 'main',
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => {},
        structuredLog,
      });

      guard.reportTotalPower(5.38);
      await guard.checkShortfall(false, 0.38, {
        controlledDevices: 3,
        plannedShedDevices: 2,
        pendingPlannedShedDevices: 1,
        activePlannedShedDevices: 2,
        activeControlledDevices: 2,
        zeroDrawControlledDevices: 0,
        pendingControlledDevices: 1,
        blockedByCooldownDevices: 0,
        blockedByPenaltyDevices: 0,
        blockedByInvariantDevices: 0,
        summarySource: 'plan_input',
        summarySourceAtMs: 1234,
        controlledPowerW: 2875,
        uncontrolledPowerW: 2505,
        remainingReducibleControlledLoadW: 0,
        remainingReducibleControlledLoad: false,
        remainingActionableControlledLoadW: 0,
        remainingActionableControlledLoad: false,
        actuationInFlight: true,
      });

      expect(logEvents).toHaveLength(1);
      expect(logEvents[0]).toMatchObject({
        event: 'hard_cap_shortfall_detected',
        homeId: 'main',
        powerW: 5380,
        thresholdW: 5000,
        excessW: 380,
        controlledPowerW: 2875,
        uncontrolledPowerW: 2505,
        remainingReducibleControlledLoadW: 0,
        remainingReducibleControlledLoad: false,
        remainingActionableControlledLoadW: 0,
        remainingActionableControlledLoad: false,
        actuationInFlight: true,
      });
    });
  });

  describe('Shortfall clearing with hysteresis', () => {
    it('requires 60s sustained positive headroom to clear shortfall', async () => {
      const events: string[] = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
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
      const guard = createTestCapacityGuard({
      homeId: 'main',
        limitKw: 5,
        softMarginKw: 0.2,
        onShortfall: () => { events.push('shortfall'); },
        onShortfallCleared: () => { events.push('cleared'); },
      });

      // Enter shortfall
      guard.reportTotalPower(5.5);
      await guard.checkShortfall(false, 0.5);

      // Start timer
      guard.reportTotalPower(4.5);
      await guard.checkShortfall(true, 0);

      // Wait 30s
      advanceTime(30000);
      await guard.checkShortfall(true, 0);

      // Power spikes back over hard cap - resets timer
      guard.reportTotalPower(5.1); // Exceeds hard cap again
      await guard.checkShortfall(false, 0.1); // No candidates, re-enters shortfall state check

      // Drop back below - timer restarts from scratch
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

    it('emits recovery lifecycle events only after sustained hard-cap recovery', async () => {
      const logEvents: Array<Record<string, unknown>> = [];
      const structuredLog: Pick<import('../../lib/logging/logger').Logger, 'info'> = {
        info: (obj: Record<string, unknown>) => { logEvents.push(obj); },
      };
      const options = {
        homeId: 'h_area',
        limitKw: 5,
        structuredLog,
      };
      const guard = createTestCapacityGuard(options);

      guard.reportTotalPower(5.5);
      await guard.checkShortfall(false, 0.5);

      guard.reportTotalPower(4.7);
      await guard.checkShortfall(true, 0);
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
      ]);

      advanceTime(30_000);
      await guard.checkShortfall(true, 0);
      expect(logEvents).toHaveLength(2);

      guard.reportTotalPower(4.95);
      await guard.checkShortfall(true, 0);
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
        'hard_cap_shortfall_recovery_reset',
      ]);

      guard.reportTotalPower(4.7);
      await guard.checkShortfall(true, 0);
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
        'hard_cap_shortfall_recovery_reset',
        'hard_cap_shortfall_recovery_started',
      ]);

      advanceTime(61_000);
      await guard.checkShortfall(true, 0);
      expect(logEvents[4]).toMatchObject({
        event: 'hard_cap_shortfall_recovered',
        homeId: 'h_area',
        powerW: 4700,
        thresholdW: 5000,
        headroomW: 300,
      });
      expect(logEvents.every((event) => event.homeId === 'h_area')).toBe(true);
    });
  });

  describe('uses separate shortfall threshold', () => {
    it('uses shortfall threshold provider for detection', async () => {
      const events: string[] = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
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
