import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { buildNullCapacityStateSummary } from '../../lib/power/capacityStateSummary';

// The guard no longer resolves the hard-cap budget itself; callers pass it in.
const TEST_SHORTFALL_THRESHOLD_KW = 5;

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

  });

  describe('Shedding state', () => {
    it('starts with shedding inactive', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });
      expect(guard.isSheddingActive()).toBe(false);
    });

    it('latches on and stays latched while re-activated', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });

      guard.activateShedding();
      expect(guard.isSheddingActive()).toBe(true);

      guard.activateShedding();
      expect(guard.isSheddingActive()).toBe(true);

      guard.releaseShedding(1.5);
      expect(guard.isSheddingActive()).toBe(false);
    });

    it('releases once headroom clears the threshold', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });

      guard.activateShedding();
      guard.releaseShedding(0.45);

      expect(guard.isSheddingActive()).toBe(false);
    });

    it('refuses to release while headroom is below the clear threshold', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });

      guard.activateShedding();
      // 0.35 kW is short of the 0.4 kW clear threshold.
      guard.releaseShedding(0.35);

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

      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.5,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    }); // No candidates

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

      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0.5,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    }); // Has candidates

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

      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0,
      totalKw: 4.9,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

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

      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.5,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
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
      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 1.0,
      totalKw: 6.0,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
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

      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.5,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.6,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

      expect(guard.isInShortfall()).toBe(true);
      expect(guard.isShortfallAlertConditionActive(5.5, TEST_SHORTFALL_THRESHOLD_KW)).toBe(true);
      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toMatchObject({
        incidentId: candidates[0].incidentId,
        deficitKw: 0.6,
      });

      // The predicate is evaluated against the total the caller passes, so a
      // lower reading reports the condition clear immediately — the alert
      // dispatch polls this closure over the live tracker latch and re-checks
      // it before firing a deferred alert, which is what actually protects the
      // Flow. The push callback below is the slower confirmation.
      expect(guard.isShortfallAlertConditionActive(4.5, TEST_SHORTFALL_THRESHOLD_KW)).toBe(false);

      // A later high sample cannot silently resume the old hold. The planner
      // must first reconfirm that no further limiting candidates exist.
      expect(candidates).toHaveLength(2);
      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.7,
      totalKw: 5.6,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(candidates).toHaveLength(3);

      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

      expect(conditionCleared).toHaveBeenCalledOnce();
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

      await expect(guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.5,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    })).rejects.toThrow('settings unavailable');

      expect(candidate).toHaveBeenCalledOnce();
      expect(guard.isShortfallAlertConditionActive(5.5, TEST_SHORTFALL_THRESHOLD_KW)).toBe(true);
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

      await guard.checkShortfall({
        hasCandidates: false,
        deficitKw: 0.38,
        totalKw: 5.38,
        shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
        capacityStateSummary: {
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
        },
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
      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.7,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(guard.isInShortfall()).toBe(true);
      expect(events).toEqual(['shortfall']);

      // Power drops below threshold with margin
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(guard.isInShortfall()).toBe(true); // Timer started

      // Wait 30s - not enough
      advanceTime(30000);
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(guard.isInShortfall()).toBe(true);

      // Wait another 31s (total 61s) - should clear
      advanceTime(31000);
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
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
      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.5,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

      // Start timer
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

      // Wait 30s
      advanceTime(30000);
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

      // Power spikes back over hard cap - resets timer
      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.1,
      totalKw: 5.1,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    }); // No candidates, re-enters shortfall state check

      // Drop back below - timer restarts from scratch
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    }); // Timer starts here

      // Wait 59s - not quite enough
      advanceTime(59000);
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(guard.isInShortfall()).toBe(true);

      // Wait 2s more (total 61s from restart) - NOW should clear
      advanceTime(2000);
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
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

      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 0.5,
      totalKw: 5.5,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.7,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
      ]);

      advanceTime(30_000);
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.7,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(logEvents).toHaveLength(2);

      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.95,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
        'hard_cap_shortfall_recovery_reset',
      ]);

      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.7,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
        'hard_cap_shortfall_recovery_reset',
        'hard_cap_shortfall_recovery_started',
      ]);

      advanceTime(61_000);
      await guard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw: 4.7,
      shortfallThresholdKw: TEST_SHORTFALL_THRESHOLD_KW,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });
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

      // The panic threshold is the caller's to resolve and is deliberately
      // higher than the shedding soft limit.
      guard.setSoftLimitProvider(() => 3.0);

      // Power is 5kW - over soft limit (3) but under shortfall threshold (6)
      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 2.0,
      totalKw: 5.0,
      shortfallThresholdKw: 6,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

      expect(events).toHaveLength(0); // No shortfall
      expect(guard.isInShortfall()).toBe(false);

      // Power exceeds shortfall threshold
      await guard.checkShortfall({
      hasCandidates: false,
      deficitKw: 4.0,
      totalKw: 7.0,
      shortfallThresholdKw: 6,
      capacityStateSummary: buildNullCapacityStateSummary(),
    });

      expect(events).toEqual(['shortfall']);
      expect(guard.isInShortfall()).toBe(true);
    });
  });
});
