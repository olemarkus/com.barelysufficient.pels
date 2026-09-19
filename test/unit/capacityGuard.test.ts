import { createTestCapacityGuard, planVerdictSummaryFixture } from '../helpers/createTestCapacityGuard';

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

  describe('Shortfall detection', () => {
    it('starts without shortfall', () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });
      expect(guard.isInShortfall()).toBe(false);
    });

    it('enters shortfall when hard cap exceeded and no candidates', async () => {
      const shortfallEvents: Array<{ type: string; deficit?: number }> = [];
      const guard = createTestCapacityGuard({ homeId: 'main', onShortfall: (deficit) => { shortfallEvents.push({ type: 'shortfall', deficit }); },
      });

      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false })); // No candidates

      expect(shortfallEvents).toHaveLength(1);
      expect(shortfallEvents[0].type).toBe('shortfall');
      expect(guard.isInShortfall()).toBe(true);
    });

    it('does not enter shortfall when candidates remain', async () => {
      const shortfallEvents: string[] = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
        onShortfall: () => { shortfallEvents.push('shortfall'); },
      });

      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: true })); // Has candidates

      expect(shortfallEvents).toHaveLength(0);
      expect(guard.isInShortfall()).toBe(false);
    });

    it('does not enter shortfall when under hard cap', async () => {
      const shortfallEvents: string[] = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
        onShortfall: () => { shortfallEvents.push('shortfall'); },
      });

      await guard.recordReading(4.9, TEST_SHORTFALL_THRESHOLD_KW);

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
        onShortfall: () => {},
        structuredLog,
      };
      const guard = createTestCapacityGuard(options);

      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
      expect(guard.isInShortfall()).toBe(true);
      expect(logEvents).toHaveLength(1);
      expect(logEvents[0]).toMatchObject({
        event: 'hard_cap_shortfall_detected',
        homeId: 'h_area',
        powerW: 5500,
        thresholdW: 5000,
        headroomW: -500,
        excessW: 500,
        summarySource: 'plan_input',
        remainingReducibleControlledLoad: false,
        remainingActionableControlledLoad: false,
        actuationInFlight: false,
      });
      const firstIncidentId = logEvents[0].incidentId;
      expect(firstIncidentId).toBeDefined();

      // Second shortfall check while already in shortfall should not emit another event
      await guard.recordPlanVerdict(6.0, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
      expect(logEvents).toHaveLength(1); // No new event
    });

    it('publishes alert candidates separately from the slower incident-clear latch', async () => {
      const candidates: Array<{ incidentId: string; deficitKw: number }> = [];
      const conditionCleared = vi.fn();
      const guard = createTestCapacityGuard({
        homeId: 'main',
        onShortfallAlertCandidate: (entry) => { candidates.push(entry); },
        onShortfallAlertConditionCleared: conditionCleared,
      });

      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
      await guard.recordPlanVerdict(5.75, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));

      expect(guard.isInShortfall()).toBe(true);
      expect(guard.isShortfallAlertConditionActive(5.5, TEST_SHORTFALL_THRESHOLD_KW)).toBe(true);
      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toMatchObject({
        incidentId: candidates[0].incidentId,
        deficitKw: 0.75,
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
      await guard.recordPlanVerdict(5.6, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
      expect(candidates).toHaveLength(3);

      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);

      expect(conditionCleared).toHaveBeenCalledOnce();
      expect(guard.isInShortfall()).toBe(true);
    });

    it('opens no incident from a reading, however far over the threshold', async () => {
      const onShortfall = vi.fn();
      const candidate = vi.fn();
      const guard = createTestCapacityGuard({ homeId: 'main', onShortfall, onShortfallAlertCandidate: candidate });

      // No plan verdict came with it, so nothing says the house is out of options.
      await guard.recordReading(9, TEST_SHORTFALL_THRESHOLD_KW);
      // Nor does a verdict from an earlier reading that still had candidates.
      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: true }));
      await guard.recordReading(9, TEST_SHORTFALL_THRESHOLD_KW);

      expect(guard.isInShortfall()).toBe(false);
      expect(onShortfall).not.toHaveBeenCalled();
      expect(candidate).not.toHaveBeenCalled();
    });

    it('judges a reading taken inside a latched incident against the last plan verdict', async () => {
      const candidates: Array<{ incidentId: string; deficitKw: number }> = [];
      const conditionCleared = vi.fn();
      const guard = createTestCapacityGuard({
        homeId: 'main',
        onShortfallAlertCandidate: (entry) => { candidates.push(entry); },
        onShortfallAlertConditionCleared: conditionCleared,
      });

      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
      // The throttle skipped the rebuild: the plan's "nothing left" still stands.
      await guard.recordReading(5.25, TEST_SHORTFALL_THRESHOLD_KW);
      expect(candidates.map((entry) => entry.deficitKw)).toEqual([0.5, 0.25]);

      // A later build found something to shed. A reading after it stays clear.
      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: true }));
      await guard.recordReading(5.5, TEST_SHORTFALL_THRESHOLD_KW);
      expect(candidates).toHaveLength(2);
      expect(conditionCleared).toHaveBeenCalledTimes(2);
      expect(guard.isInShortfall()).toBe(true);
    });

    it('waits for shed relief already on its way before calling the house out of options', async () => {
      const onShortfall = vi.fn();
      const guard = createTestCapacityGuard({ homeId: 'main', onShortfall });

      // The build that limits the last device decided from a reading its own
      // shed has not yet touched: nothing left, but relief is on its way.
      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({
        actionableLoadRemains: false,
        shedReliefInFlight: true,
      }));
      expect(guard.isInShortfall()).toBe(false);

      // It landed and the house is still over: now PELS is out of options.
      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
      expect(onShortfall).toHaveBeenCalledOnce();
      expect(guard.isInShortfall()).toBe(true);
    });

    it('forgets the verdict once its incident recovers', async () => {
      const guard = createTestCapacityGuard({ homeId: 'main' });
      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      advanceTime(61_000);
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      expect(guard.isInShortfall()).toBe(false);

      // The next breach is judged on its own verdict, not the recovered one's.
      expect(guard.isShortfallAlertConditionActive(9, TEST_SHORTFALL_THRESHOLD_KW)).toBe(false);
    });

    it('publishes the alert candidate even when the immediate state write rejects', async () => {
      const candidate = vi.fn();
      const guard = createTestCapacityGuard({ homeId: 'main', onShortfall: () => Promise.reject(new Error('settings unavailable')), onShortfallAlertCandidate: candidate });

      await expect(guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }))).rejects.toThrow('settings unavailable');

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
        onShortfall: () => {},
        structuredLog,
      });

      await guard.recordPlanVerdict(5.38, TEST_SHORTFALL_THRESHOLD_KW, {
        controlledDevices: 3,
        plannedShedDevices: 2,
        pendingPlannedShedDevices: 1,
        activePlannedShedDevices: 2,
        activeControlledDevices: 2,
        zeroDrawControlledDevices: 0,
        pendingControlledDevices: 1,
        summarySource: 'plan_input',
        summarySourceAtMs: 1234,
        controlledPowerW: 2875,
        uncontrolledPowerW: 2505,
        remainingReducibleControlledLoadW: 0,
        remainingReducibleControlledLoad: false,
        remainingActionableControlledLoadW: 0,
        remainingActionableControlledLoad: false,
        shedReliefInFlight: false,
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
    it('preserves recovery state while the selected period is incomplete', async () => {
      const events: string[] = [];
      const guard = createTestCapacityGuard({
        homeId: 'main',
        onShortfall: () => { events.push('shortfall'); },
        onShortfallCleared: () => { events.push('cleared'); },
      });

      await guard.recordPlanVerdict(
        5.5,
        TEST_SHORTFALL_THRESHOLD_KW,
        planVerdictSummaryFixture({ actionableLoadRemains: false }),
      );
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      advanceTime(61_000);
      guard.recordShortfallUnavailable();

      // The throttle's zero threshold must not let export clear the incident.
      await guard.recordReading(-1, 0);
      expect(guard.isInShortfall()).toBe(true);
      expect(events).toEqual(['shortfall']);

      // A complete-period reading restores threshold authority. The valid
      // recovery evidence from before the gap was preserved, so it may clear.
      await guard.recordCompletePeriodReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      expect(guard.isInShortfall()).toBe(false);
      expect(events).toEqual(['shortfall', 'cleared']);
    });

    it('requires 60s sustained positive headroom to clear shortfall', async () => {
      const events: string[] = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
        onShortfall: () => { events.push('shortfall'); },
        onShortfallCleared: () => { events.push('cleared'); },
      });

      // Enter shortfall
      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));
      expect(guard.isInShortfall()).toBe(true);
      expect(events).toEqual(['shortfall']);

      // Power drops below threshold with margin
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      expect(guard.isInShortfall()).toBe(true); // Timer started

      // Wait 30s - not enough
      advanceTime(30000);
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      expect(guard.isInShortfall()).toBe(true);

      // Wait another 31s (total 61s) - should clear
      advanceTime(31000);
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      expect(guard.isInShortfall()).toBe(false);
      expect(events).toEqual(['shortfall', 'cleared']);
    });

    it('resets timer when headroom drops', async () => {
      const events: string[] = [];
      const guard = createTestCapacityGuard({
      homeId: 'main',
        onShortfall: () => { events.push('shortfall'); },
        onShortfallCleared: () => { events.push('cleared'); },
      });

      // Enter shortfall
      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));

      // Start timer
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);

      // Wait 30s
      advanceTime(30000);
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);

      // Power spikes back over hard cap - resets timer
      await guard.recordPlanVerdict(5.1, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false })); // No candidates, re-enters shortfall state check

      // Drop back below - timer restarts from scratch
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW); // Timer starts here

      // Wait 59s - not quite enough
      advanceTime(59000);
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      expect(guard.isInShortfall()).toBe(true);

      // Wait 2s more (total 61s from restart) - NOW should clear
      advanceTime(2000);
      await guard.recordReading(4.5, TEST_SHORTFALL_THRESHOLD_KW);
      expect(guard.isInShortfall()).toBe(false);
    });

    it('emits recovery lifecycle events only after sustained hard-cap recovery', async () => {
      const logEvents: Array<Record<string, unknown>> = [];
      const structuredLog: Pick<import('../../lib/logging/logger').Logger, 'info'> = {
        info: (obj: Record<string, unknown>) => { logEvents.push(obj); },
      };
      const options = {
        homeId: 'h_area',
        structuredLog,
      };
      const guard = createTestCapacityGuard(options);

      await guard.recordPlanVerdict(5.5, TEST_SHORTFALL_THRESHOLD_KW, planVerdictSummaryFixture({ actionableLoadRemains: false }));

      await guard.recordReading(4.7, TEST_SHORTFALL_THRESHOLD_KW);
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
      ]);

      advanceTime(30_000);
      await guard.recordReading(4.7, TEST_SHORTFALL_THRESHOLD_KW);
      expect(logEvents).toHaveLength(2);

      await guard.recordReading(4.95, TEST_SHORTFALL_THRESHOLD_KW);
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
        'hard_cap_shortfall_recovery_reset',
      ]);

      await guard.recordReading(4.7, TEST_SHORTFALL_THRESHOLD_KW);
      expect(logEvents.map((event) => event.event)).toEqual([
        'hard_cap_shortfall_detected',
        'hard_cap_shortfall_recovery_started',
        'hard_cap_shortfall_recovery_reset',
        'hard_cap_shortfall_recovery_started',
      ]);

      advanceTime(61_000);
      await guard.recordReading(4.7, TEST_SHORTFALL_THRESHOLD_KW);
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
        onShortfall: () => { events.push('shortfall'); },
      });

      // The panic threshold is the caller's to resolve and is deliberately
      // higher than the shedding soft limit.

      // Power is 5kW - over soft limit (3) but under shortfall threshold (6)
      await guard.recordReading(5.0, 6);

      expect(events).toHaveLength(0); // No shortfall
      expect(guard.isInShortfall()).toBe(false);

      // Power exceeds shortfall threshold
      await guard.recordPlanVerdict(7.0, 6, planVerdictSummaryFixture({ actionableLoadRemains: false }));

      expect(events).toEqual(['shortfall']);
      expect(guard.isInShortfall()).toBe(true);
    });
  });
});
