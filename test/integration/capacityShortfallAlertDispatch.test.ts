import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS,
  CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS,
  createCapacityShortfallAlertDispatch,
} from '../../setup/capacityShortfallAlertDispatch';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';
import { createMainCapacityGuard } from '../../setup/appInit/createMainCapacityGuard';
import type { AppContext } from '../../lib/app/appContext';
import type { FlowTriggerCard } from '../../lib/ports/homeyRuntime';
import type { HomeId } from '../../lib/utils/settingsKeys';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

type TriggerFn = FlowTriggerCard['trigger'];
type TriggerMock = ReturnType<typeof vi.fn<TriggerFn>>;

const okTrigger = (): TriggerMock => vi.fn<TriggerFn>().mockResolvedValue(undefined);

const STEP_MS = CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS * 1_000;
const IMMEDIATE_KEY = 'mainShortfallAlertImmediate';
const SUSTAINED_KEY = 'mainShortfallAlertSustained';

const candidate = {
  incidentId: 'inc_test',
  deficitKw: 1.2,
  detectedAtMs: Date.UTC(2025, 0, 15, 12, 0, 0),
};

/**
 * The stub discriminates on the requested card id rather than on argument
 * count, so a dispatcher that asked for the wrong card would surface as a
 * missing call instead of silently landing on the other lane's spy.
 */
const buildRig = (overrides: {
  isDiscarded?: () => boolean;
  isTemporarilyFenced?: () => boolean;
  isConditionActive?: () => boolean;
  homeId?: HomeId;
  getHomeDisplayName?: () => string;
  immediateTrigger?: TriggerMock;
  sustainedTrigger?: TriggerMock;
  timers?: TimerRegistry;
} = {}) => {
  const immediateTrigger = overrides.immediateTrigger ?? okTrigger();
  const sustainedTrigger = overrides.sustainedTrigger ?? okTrigger();
  const timers = overrides.timers ?? new TimerRegistry();
  const getTriggerCard = vi.fn((cardId: string): FlowTriggerCard => {
    if (cardId === 'capacity_shortfall') return { trigger: immediateTrigger };
    if (cardId === 'capacity_shortfall_sustained') return { trigger: sustainedTrigger };
    throw new Error(`unexpected card id: ${cardId}`);
  });
  const dispatch = createCapacityShortfallAlertDispatch({
    homeId: overrides.homeId ?? 'main',
    timers,
    immediateTimerKey: IMMEDIATE_KEY,
    sustainedTimerKey: SUSTAINED_KEY,
    isDiscarded: overrides.isDiscarded ?? (() => false),
    isTemporarilyFenced: overrides.isTemporarilyFenced ?? (() => false),
    isConditionActive: overrides.isConditionActive ?? (() => true),
    getHomeDisplayName: overrides.getHomeDisplayName ?? (() => 'Main home'),
    flow: { getTriggerCard },
  });
  return { dispatch, immediateTrigger, sustainedTrigger, timers, getTriggerCard };
};

const crossings = (trigger: TriggerMock): unknown[] => (
  trigger.mock.calls.map((call) => call[1])
);

describe('capacity shortfall alert dispatch', () => {
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

  it('refuses to share one timer key between the two lanes', () => {
    expect(() => createCapacityShortfallAlertDispatch({
      homeId: 'main',
      timers: new TimerRegistry(),
      immediateTimerKey: 'same',
      sustainedTimerKey: 'same',
      isDiscarded: () => false,
      isTemporarilyFenced: () => false,
      isConditionActive: () => true,
      getHomeDisplayName: () => 'Main home',
      flow: { getTriggerCard: vi.fn() },
    })).toThrow(/distinct timer keys/);
  });

  it('fires the immediate alert once per incident with no confirmation window', async () => {
    const { dispatch, immediateTrigger, getTriggerCard } = buildRig();

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(0);
    expect(getTriggerCard).toHaveBeenCalledWith('capacity_shortfall');
    expect(immediateTrigger).toHaveBeenCalledExactlyOnceWith({ home: 'Main home' });
    expect(logCapture.findEvent('hard_cap_shortfall_alert_triggered')).toMatchObject({
      homeId: 'main',
      incidentId: candidate.incidentId,
    });

    // Repeat candidates for the same incident arrive on every plan rebuild.
    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(0);
    expect(immediateTrigger).toHaveBeenCalledTimes(1);
  });

  it('keeps the Main-home state action and its Flow card in the same cycle', async () => {
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
    await vi.advanceTimersByTimeAsync(0);

    expect(handleShortfall).toHaveBeenCalledExactlyOnceWith(0.5);
    expect(triggerAlert).toHaveBeenCalledExactlyOnceWith({ home: 'Main home' });
  });

  it('emits a sustained crossing on every grid step while the breach lasts', async () => {
    const { dispatch, sustainedTrigger, getTriggerCard } = buildRig();

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS - 1);
    expect(sustainedTrigger).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1 + STEP_MS * 2);
    expect(getTriggerCard).toHaveBeenCalledWith('capacity_shortfall_sustained');
    // Every step, in order, with no gap or repeat.
    expect(crossings(sustainedTrigger)).toEqual([
      { sustainedSeconds: 10, previousSustainedSeconds: 0 },
      { sustainedSeconds: 20, previousSustainedSeconds: 10 },
      { sustainedSeconds: 30, previousSustainedSeconds: 20 },
    ]);
    expect(logCapture.findEvent('hard_cap_shortfall_sustained_alert_triggered')).toMatchObject({
      homeId: 'main',
      incidentId: candidate.incidentId,
      sustainedSeconds: 10,
      previousSustainedSeconds: 0,
    });
  });

  it('does not let repeated short spikes accumulate toward a threshold', async () => {
    // The point of the card is to hold off actuating until a breach proves it
    // is not a brief overshoot. A load that keeps dropping back under the cap
    // is a series of spikes, each of which resolved on its own, so the seconds
    // must not carry across them: a Flow set above one step stays silent.
    let conditionActive = true;
    const { dispatch, sustainedTrigger } = buildRig({
      isConditionActive: () => conditionActive,
    });

    dispatch.onCandidate(candidate);
    for (let poll = 0; poll < 12; poll += 1) {
      conditionActive = poll % 2 === 0;
      if (conditionActive) dispatch.onCandidate(candidate);
      else dispatch.onConditionCleared();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    }

    expect(crossings(sustainedTrigger)).toEqual([
      { sustainedSeconds: 10, previousSustainedSeconds: 0 },
    ]);
  });

  it('ends the run when a tick observes the breach has cleared', async () => {
    let conditionActive = true;
    const { dispatch, sustainedTrigger } = buildRig({
      homeId: 'h_annex',
      getHomeDisplayName: () => 'Annex',
      isConditionActive: () => conditionActive,
    });

    dispatch.onCandidate(candidate);
    conditionActive = false;
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);

    expect(sustainedTrigger).not.toHaveBeenCalled();
    // A break before anything fired is not worth a log line; the plan rebuild
    // cadence would emit one per cycle.
    expect(logCapture.findEvents('hard_cap_shortfall_sustained_alert_ended')).toHaveLength(0);
  });

  it('ends the run when the breach stops being evidenced', async () => {
    // Frozen at "breaching": nothing resets the guard's last power reading, so
    // a meter that stops reporting leaves this true indefinitely.
    const { dispatch, sustainedTrigger } = buildRig();

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_THRESHOLD_MS + STEP_MS);

    const emitted = sustainedTrigger.mock.calls.length;
    expect(emitted).toBe(POWER_SAMPLE_STALE_THRESHOLD_MS / STEP_MS);
    expect(logCapture.findEvent('hard_cap_shortfall_sustained_alert_ended')).toMatchObject({
      reasonCode: 'evidence_stale',
    });

    // Wall time alone must not walk the rest of the ladder.
    await vi.advanceTimersByTimeAsync(STEP_MS * 10);
    expect(sustainedTrigger).toHaveBeenCalledTimes(emitted);
  });

  it('does not re-fire a threshold an earlier run already crossed', async () => {
    let conditionActive = true;
    const { dispatch, sustainedTrigger } = buildRig({
      isConditionActive: () => conditionActive,
    });

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    expect(sustainedTrigger).toHaveBeenCalledTimes(2);

    // A break long enough for a tick to observe it ends the run.
    conditionActive = false;
    await vi.advanceTimersByTimeAsync(STEP_MS);
    conditionActive = true;

    // Same incident: the clock restarts but 10 s and 20 s already alerted, so
    // the next crossing has to climb past the high-water mark first.
    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    expect(sustainedTrigger).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(crossings(sustainedTrigger).at(-1)).toEqual(
      { sustainedSeconds: 30, previousSustainedSeconds: 20 },
    );
  });

  it('keeps a crossing alive when the Flow rejects it', async () => {
    // The mark must not advance on a transient rejection: every later window
    // would start above the threshold that failed, so a Flow set to that
    // duration would never fire for the incident.
    const sustainedTrigger = vi.fn<TriggerFn>()
      .mockRejectedValueOnce(new Error('Flow unavailable'))
      .mockResolvedValue(undefined);
    const { dispatch } = buildRig({ sustainedTrigger });

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);

    expect(crossings(sustainedTrigger)).toEqual([
      { sustainedSeconds: 10, previousSustainedSeconds: 0 },
      { sustainedSeconds: 20, previousSustainedSeconds: 0 },
    ]);
    expect(logCapture.findEvent('hard_cap_shortfall_sustained_alert_failed')).toMatchObject({
      reasonCode: 'trigger_rejected',
    });
  });

  it('re-arms both lanes once the incident clears', async () => {
    const { dispatch, immediateTrigger, sustainedTrigger } = buildRig();

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    dispatch.onIncidentCleared();

    dispatch.onCandidate({ ...candidate, incidentId: 'inc_next' });
    await vi.advanceTimersByTimeAsync(STEP_MS);

    expect(immediateTrigger).toHaveBeenCalledTimes(2);
    expect(crossings(sustainedTrigger)).toEqual([
      { sustainedSeconds: 10, previousSustainedSeconds: 0 },
      { sustainedSeconds: 10, previousSustainedSeconds: 0 },
    ]);
  });

  it('bounds the ticker per incident even when every step is fenced', async () => {
    // A fenced run emits nothing, so `highWaterSeconds` never advances. If the
    // backstop keyed on the mark instead of on steps spent, each candidate
    // would restart a fresh 600 s run for the life of the incident.
    let authorityFenced = true;
    const timers = new TimerRegistry();
    const { dispatch, sustainedTrigger } = buildRig({
      timers,
      isTemporarilyFenced: () => authorityFenced,
    });
    const maxSteps = CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS
      / CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS;

    for (let step = 0; step < maxSteps + 5; step += 1) {
      dispatch.onCandidate(candidate);
      await vi.advanceTimersByTimeAsync(STEP_MS);
    }

    expect(sustainedTrigger).not.toHaveBeenCalled();
    expect(logCapture.findEvent('hard_cap_shortfall_sustained_alert_ended')).toMatchObject({
      reasonCode: 'max_reached',
    });
    // The candidates after the bound must not re-arm it.
    authorityFenced = false;
    dispatch.onCandidate(candidate);
    expect(timers.has(SUSTAINED_KEY)).toBe(false);
  });

  it('stops ticking once the arg range is exhausted', async () => {
    const timers = new TimerRegistry();
    const { dispatch, sustainedTrigger } = buildRig({ timers });
    const expectedSteps = CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS
      / CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS;

    // The guard republishes the candidate on every rebuild while the breach
    // lasts; that is what keeps the run evidenced past the freshness window.
    for (let step = 0; step < expectedSteps + 5; step += 1) {
      dispatch.onCandidate(candidate);
      await vi.advanceTimersByTimeAsync(STEP_MS);
    }

    expect(sustainedTrigger).toHaveBeenCalledTimes(expectedSteps);
    expect(crossings(sustainedTrigger).at(-1)).toEqual({
      sustainedSeconds: CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS,
      previousSustainedSeconds: CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS
        - CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS,
    });
    // Pins the restart guard: without it the loop's trailing candidates would
    // re-arm the ticker.
    expect(timers.has(SUSTAINED_KEY)).toBe(false);
    expect(logCapture.findEvent('hard_cap_shortfall_sustained_alert_ended')).toMatchObject({
      reasonCode: 'max_reached',
      sustainedSeconds: CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS,
    });
  });

  it('gives a run that follows a break the whole arg range', async () => {
    // The step bound is per run, not per incident. A short breach followed by a
    // recovery and then a continuous 600 s breach must still reach 600 s — an
    // incident-wide budget would have spent a step on the first breach and
    // stopped the second run at 590 s, leaving the top threshold unfirable.
    let conditionActive = true;
    const { dispatch, sustainedTrigger } = buildRig({
      isConditionActive: () => conditionActive,
    });
    const maxSteps = CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS
      / CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS;

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    conditionActive = false;
    await vi.advanceTimersByTimeAsync(STEP_MS);
    conditionActive = true;

    for (let step = 0; step < maxSteps; step += 1) {
      dispatch.onCandidate(candidate);
      await vi.advanceTimersByTimeAsync(STEP_MS);
    }

    expect(crossings(sustainedTrigger).at(-1)).toEqual({
      sustainedSeconds: CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS,
      previousSustainedSeconds: CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS
        - CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS,
    });
  });

  it('does not write a crossing that was in flight into the next incident', async () => {
    // A pending trigger can outlive its incident. Committing its high-water
    // mark afterwards would suppress every threshold below it for the NEW
    // incident, which has its own clock.
    let resolveTrigger: (() => void) | undefined;
    const sustainedTrigger = vi.fn<TriggerFn>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveTrigger = resolve; }))
      .mockResolvedValue(undefined);
    const { dispatch } = buildRig({ sustainedTrigger });

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(sustainedTrigger).toHaveBeenCalledTimes(1);

    dispatch.onIncidentCleared();
    dispatch.onCandidate({ ...candidate, incidentId: 'inc_next' });
    resolveTrigger?.();
    await vi.advanceTimersByTimeAsync(STEP_MS);

    // The new incident starts its ladder from zero and emits its own first
    // crossing. A stale write would leave its mark at 10, so `10 > 10` would be
    // false and the second crossing would never appear at all — hence asserting
    // the whole list, not just the last entry.
    expect(crossings(sustainedTrigger)).toEqual([
      { sustainedSeconds: 10, previousSustainedSeconds: 0 },
      { sustainedSeconds: 10, previousSustainedSeconds: 0 },
    ]);
  });

  it('holds a fenced alert across retries rather than dropping it', async () => {
    let authorityFenced = true;
    const timers = new TimerRegistry();
    const { dispatch, immediateTrigger } = buildRig({
      homeId: 'h_annex',
      getHomeDisplayName: () => 'Annex',
      timers,
      isTemporarilyFenced: () => authorityFenced,
    });

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(0);
    expect(immediateTrigger).not.toHaveBeenCalled();
    expect(logCapture.findEvent('hard_cap_shortfall_alert_deferred')).toMatchObject({
      incidentId: candidate.incidentId,
      reasonCode: 'authority_fenced',
    });

    // Several retries while still fenced must keep the alert armed. A sub-home
    // is routinely fenced for longer than one second at boot.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(immediateTrigger).not.toHaveBeenCalled();
    expect(timers.has(IMMEDIATE_KEY)).toBe(true);

    authorityFenced = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(immediateTrigger).toHaveBeenCalledExactlyOnceWith({ home: 'Annex' });
  });

  it('drops a fenced alert whose breach recovered before the fence lifted', async () => {
    let conditionActive = true;
    const { dispatch, immediateTrigger } = buildRig({
      isTemporarilyFenced: () => true,
      isConditionActive: () => conditionActive,
    });

    dispatch.onCandidate(candidate);
    conditionActive = false;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(immediateTrigger).not.toHaveBeenCalled();
    expect(logCapture.findEvent('hard_cap_shortfall_alert_dropped')).toMatchObject({
      incidentId: candidate.incidentId,
      reasonCode: 'condition_cleared',
      durationMs: 1_000,
    });
  });

  it('drops a fenced alert for a runtime that was discarded while it waited', async () => {
    let discarded = false;
    const { dispatch, immediateTrigger } = buildRig({
      homeId: 'h_annex',
      getHomeDisplayName: () => 'Annex',
      isTemporarilyFenced: () => true,
      isDiscarded: () => discarded,
    });

    // Arm first, THEN discard — otherwise the composite gate short-circuits and
    // the release-time discard check is never exercised.
    dispatch.onCandidate(candidate);
    discarded = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(immediateTrigger).not.toHaveBeenCalled();
    expect(logCapture.findEvent('hard_cap_shortfall_alert_dropped')).toMatchObject({
      incidentId: candidate.incidentId,
      reasonCode: 'runtime_discarded',
    });
  });

  it('drops a pending alert when the incident clears', async () => {
    const { dispatch, immediateTrigger } = buildRig({ isTemporarilyFenced: () => true });

    dispatch.onCandidate(candidate);
    dispatch.onIncidentCleared();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(immediateTrigger).not.toHaveBeenCalled();
    expect(logCapture.findEvent('hard_cap_shortfall_alert_dropped')).toMatchObject({
      reasonCode: 'incident_cleared',
    });
  });

  it('ends a running sustained lane when the runtime is discarded mid-run', async () => {
    let discarded = false;
    const { dispatch, sustainedTrigger } = buildRig({ isDiscarded: () => discarded });

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(sustainedTrigger).toHaveBeenCalledTimes(1);

    discarded = true;
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);

    expect(sustainedTrigger).toHaveBeenCalledTimes(1);
    expect(logCapture.findEvent('hard_cap_shortfall_sustained_alert_ended')).toMatchObject({
      reasonCode: 'runtime_discarded',
      sustainedSeconds: 10,
    });
  });

  it('leaves a replacement bundle\'s timer alone when a discarded lane stops', async () => {
    // A replacement bundle for the same home derives the identical timer key.
    // A discarded lane clearing it would cancel the new bundle's ticker, and
    // the new incident would never advance its ladder.
    let discarded = false;
    const timers = new TimerRegistry();
    const { dispatch } = buildRig({ timers, isDiscarded: () => discarded });

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    discarded = true;

    // Stand in for the replacement bundle taking over the key.
    const replacement = setTimeout(() => undefined, STEP_MS);
    timers.registerTimeout(SUSTAINED_KEY, replacement);

    dispatch.onIncidentCleared();
    expect(timers.has(SUSTAINED_KEY)).toBe(true);
  });

  it('does not re-arm a ticker that was torn down while a crossing was in flight', async () => {
    // Teardown clears timers by key, and a replacement bundle for the same home
    // derives the identical key — so a stale tick that re-registers would
    // cancel the new bundle's ticker.
    let resolveTrigger: (() => void) | undefined;
    const sustainedTrigger = vi.fn<TriggerFn>(() => new Promise<void>((resolve) => {
      resolveTrigger = resolve;
    }));
    const timers = new TimerRegistry();
    const { dispatch } = buildRig({ timers, sustainedTrigger });

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(sustainedTrigger).toHaveBeenCalledTimes(1);

    dispatch.onIncidentCleared();
    resolveTrigger?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(timers.has(SUSTAINED_KEY)).toBe(false);
  });

  it('logs a rejected immediate Flow separately without claiming it triggered', async () => {
    const immediateTrigger = vi.fn<TriggerFn>().mockRejectedValue(new Error('Flow unavailable'));
    const { dispatch } = buildRig({ immediateTrigger });

    dispatch.onCandidate(candidate);
    await vi.advanceTimersByTimeAsync(0);

    expect(logCapture.findEvents('hard_cap_shortfall_alert_triggered')).toHaveLength(0);
    expect(logCapture.findEvent('hard_cap_shortfall_alert_failed')).toMatchObject({
      homeId: 'main',
      incidentId: candidate.incidentId,
      reasonCode: 'trigger_rejected',
    });
  });
});
