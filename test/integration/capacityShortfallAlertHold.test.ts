import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_SHORTFALL_ALERT_HOLD_MS,
  createCapacityShortfallAlertHold,
} from '../../setup/capacityShortfallAlertHold';
import { createMainCapacityGuard } from '../../setup/appInit/createMainCapacityGuard';
import type { AppContext } from '../../lib/app/appContext';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

const candidate = {
  incidentId: 'inc_test',
  deficitKw: 1.2,
  detectedAtMs: Date.UTC(2025, 0, 15, 12, 0, 0),
};

describe('capacity shortfall alert hold', () => {
  let logCapture: LoggerCapture;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(candidate.detectedAtMs);
    logCapture = captureLogger();
  });

  afterEach(() => {
    logCapture.restore();
    vi.useRealTimers();
  });

  it('releases one alert only after ten continuous seconds', async () => {
    const triggerAlert = vi.fn().mockResolvedValue(undefined);
    const hold = createCapacityShortfallAlertHold({
      homeId: 'main',
      timers: new TimerRegistry(),
      timerKey: 'mainShortfallAlertHold',
      isDiscarded: () => false,
      isTemporarilyFenced: () => false,
      isConditionActive: () => true,
      getHomeDisplayName: () => 'Main home',
      flow: { getTriggerCard: vi.fn(() => ({ trigger: triggerAlert })) },
    });

    hold.onCandidate(candidate);
    hold.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(CAPACITY_SHORTFALL_ALERT_HOLD_MS - 1);
    expect(triggerAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(triggerAlert).toHaveBeenCalledExactlyOnceWith({ home: 'Main home' });
    expect(logCapture.findEvents('hard_cap_shortfall_alert_hold_started')).toHaveLength(1);
    expect(logCapture.findEvent('hard_cap_shortfall_alert_triggered')).toMatchObject({
      homeId: 'main',
      incidentId: candidate.incidentId,
      durationMs: CAPACITY_SHORTFALL_ALERT_HOLD_MS,
    });

    hold.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(CAPACITY_SHORTFALL_ALERT_HOLD_MS);
    expect(triggerAlert).toHaveBeenCalledTimes(1);
  });

  it('keeps the Main-home state action immediate while holding its Flow card', async () => {
    const triggerAlert = vi.fn().mockResolvedValue(undefined);
    const handleShortfall = vi.fn().mockResolvedValue(undefined);
    const timers = new TimerRegistry();
    const ctx = {
      timers,
      capacitySettings: { limitKw: 5, marginKw: 0 },
      homey: {
        flow: { getTriggerCard: vi.fn(() => ({ trigger: triggerAlert })) },
      },
      planService: {
        handleShortfall,
        handleShortfallCleared: vi.fn().mockResolvedValue(undefined),
        computeShortfallThreshold: () => 5,
        getLatestPlanSnapshot: () => null,
        getLatestPlanSnapshotUpdatedAtMs: () => null,
      },
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const { guard } = createMainCapacityGuard({
      ctx,
      isDiscarded: () => false,
      isTemporarilyFenced: () => false,
      isPreparedReconcileActive: () => false,
    });

    guard.reportTotalPower(5.5);
    await guard.checkShortfall(false, 0.5);
    expect(handleShortfall).toHaveBeenCalledExactlyOnceWith(0.5);
    expect(triggerAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CAPACITY_SHORTFALL_ALERT_HOLD_MS - 1);
    expect(triggerAlert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(triggerAlert).toHaveBeenCalledExactlyOnceWith({ home: 'Main home' });
  });

  it('cancels a recovered candidate and gives re-entry a fresh hold', async () => {
    let conditionActive = true;
    const triggerAlert = vi.fn().mockResolvedValue(undefined);
    const hold = createCapacityShortfallAlertHold({
      homeId: 'h_annex',
      timers: new TimerRegistry(),
      timerKey: 'home:h_annex:shortfallAlertHold',
      isDiscarded: () => false,
      isTemporarilyFenced: () => false,
      isConditionActive: () => conditionActive,
      getHomeDisplayName: () => 'Annex',
      flow: { getTriggerCard: vi.fn(() => ({ trigger: triggerAlert })) },
    });

    hold.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(9_000);
    conditionActive = false;
    hold.onConditionCleared();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(triggerAlert).not.toHaveBeenCalled();

    conditionActive = true;
    hold.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(CAPACITY_SHORTFALL_ALERT_HOLD_MS);
    expect(triggerAlert).toHaveBeenCalledOnce();
    expect(logCapture.findEvent('hard_cap_shortfall_alert_hold_cancelled')).toMatchObject({
      homeId: 'h_annex',
      incidentId: candidate.incidentId,
      reasonCode: 'condition_cleared',
      durationMs: 9_000,
    });
  });

  it('waits behind an authority fence and drops a torn-down runtime', async () => {
    let authorityFenced = true;
    let discarded = false;
    const triggerAlert = vi.fn().mockResolvedValue(undefined);
    const timers = new TimerRegistry();
    const hold = createCapacityShortfallAlertHold({
      homeId: 'h_annex',
      timers,
      timerKey: 'home:h_annex:shortfallAlertHold',
      isDiscarded: () => discarded,
      isTemporarilyFenced: () => authorityFenced,
      isConditionActive: () => true,
      getHomeDisplayName: () => 'Annex',
      flow: { getTriggerCard: vi.fn(() => ({ trigger: triggerAlert })) },
    });

    hold.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(CAPACITY_SHORTFALL_ALERT_HOLD_MS);
    expect(triggerAlert).not.toHaveBeenCalled();
    expect(timers.has('home:h_annex:shortfallAlertHold')).toBe(true);

    authorityFenced = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(triggerAlert).toHaveBeenCalledOnce();

    hold.onIncidentCleared();
    hold.onCandidate({ ...candidate, incidentId: 'inc_next' });
    discarded = true;
    await vi.advanceTimersByTimeAsync(CAPACITY_SHORTFALL_ALERT_HOLD_MS);
    expect(triggerAlert).toHaveBeenCalledTimes(1);
    expect(logCapture.findEvents('hard_cap_shortfall_alert_hold_cancelled').at(-1)).toMatchObject({
      incidentId: 'inc_next',
      reasonCode: 'runtime_discarded',
    });
  });

  it('logs a rejected Flow separately without claiming it triggered', async () => {
    const triggerAlert = vi.fn().mockRejectedValue(new Error('Flow unavailable'));
    const hold = createCapacityShortfallAlertHold({
      homeId: 'main',
      timers: new TimerRegistry(),
      timerKey: 'mainShortfallAlertHold',
      isDiscarded: () => false,
      isTemporarilyFenced: () => false,
      isConditionActive: () => true,
      getHomeDisplayName: () => 'Main home',
      flow: { getTriggerCard: vi.fn(() => ({ trigger: triggerAlert })) },
    });

    hold.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(CAPACITY_SHORTFALL_ALERT_HOLD_MS);

    expect(logCapture.findEvents('hard_cap_shortfall_alert_triggered')).toHaveLength(0);
    expect(logCapture.findEvent('hard_cap_shortfall_alert_failed')).toMatchObject({
      homeId: 'main',
      incidentId: candidate.incidentId,
      reasonCode: 'trigger_rejected',
    });
  });
});
