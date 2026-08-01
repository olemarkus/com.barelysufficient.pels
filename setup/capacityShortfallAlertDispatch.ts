import type { CapacityShortfallAlertCandidate } from '../lib/power/capacityGuard';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../packages/shared-domain/src/powerFreshness';
import { getLogger } from '../lib/logging/logger';
import { runWithoutContext } from '../lib/logging/alsContext';
import type { FlowPort } from '../lib/ports/homeyRuntime';
import type { HomeId } from '../lib/utils/settingsKeys';
import type { TimerRegistry } from '../lib/utils/timerRegistry';

const logger = getLogger('setup/capacity-shortfall-alert-dispatch');

const CAPACITY_SHORTFALL_ALERT_RETRY_MS = 1_000;

/**
 * Grid the sustained lane re-checks on. Homey Energy is polled every 10 s, so a
 * finer grid would measure sample noise rather than a sustained breach — and it
 * is why the `seconds` arg on `capacity_shortfall_sustained` is declared with
 * `step: 10`. The manifest and this constant must move together; a guard test
 * asserts they agree on both the compose source and the generated `app.json`.
 */
export const CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS = 10;

/**
 * Upper bound of the same arg's range. Past it no configured Flow is left to
 * serve, so the ticker stops rather than running for the whole incident.
 */
export const CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS = 600;

const STEP_MS = CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS * 1_000;

/**
 * Ticks one run may spend before it has served the whole arg range. `Math.floor`
 * because a non-divisible pair of constants would otherwise give a fractional
 * bound the `>=` comparison overruns to the next whole step.
 */
const MAX_STEPS_PER_RUN = Math.floor(
  CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS / CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS,
);

export type CapacityShortfallAlertDispatch = {
  onCandidate: (candidate: CapacityShortfallAlertCandidate) => void;
  onConditionCleared: () => void;
  onIncidentCleared: () => void;
};

/**
 * The `capacity_shortfall_sustained` trigger's Flow `state`, produced here and
 * read back by the card's run listener in `flowCards/capacityShortfallCards.ts`.
 * Homey hands the object straight back, so this type is the whole contract
 * between the two — it is shared rather than re-declared on each side because
 * the failure mode of a silent drift is asymmetric: losing `sustainedSeconds`
 * silences the card, while losing `previousSustainedSeconds` would let every
 * grid step match.
 *
 * `previousSustainedSeconds` is the high-water mark BEFORE this crossing, so a
 * listener fires exactly once per threshold per incident:
 * `previousSustainedSeconds < seconds <= sustainedSeconds`.
 */
export type CapacityShortfallSustainedCrossing = {
  sustainedSeconds: number;
  previousSustainedSeconds: number;
};

/**
 * The two cards this dispatcher owns, each bound to the log events that
 * describe it. Keeping the triple together is what stops a card id being paired
 * with another lane's events.
 */
const ALERT_CARDS = {
  immediate: {
    cardId: 'capacity_shortfall',
    triggeredEvent: 'hard_cap_shortfall_alert_triggered',
    failedEvent: 'hard_cap_shortfall_alert_failed',
  },
  sustained: {
    cardId: 'capacity_shortfall_sustained',
    triggeredEvent: 'hard_cap_shortfall_sustained_alert_triggered',
    failedEvent: 'hard_cap_shortfall_sustained_alert_failed',
  },
} as const;

/**
 * `rejected` is transient (the SDK threw) and worth not committing to;
 * `unavailable` means the card is not registered at all, which no retry fixes.
 */
type AlertDelivery = 'delivered' | 'rejected' | 'unavailable';

/** `state` is required exactly on the lane that carries one. */
type AlertTrigger =
  | { lane: 'immediate'; incidentId: string }
  | { lane: 'sustained'; incidentId: string; state: CapacityShortfallSustainedCrossing };

type AlertDropReason =
  'condition_cleared' | 'incident_cleared' | 'incident_replaced' | 'runtime_discarded';

type AlertRunEndReason =
  'condition_cleared' | 'incident_cleared' | 'runtime_discarded' | 'max_reached' | 'evidence_stale';

type AlertFailureReason =
  'trigger_unavailable' | 'trigger_rejected' | 'release_failed' | 'tick_failed';

/**
 * Everything one lane needs from the home runtime, including the single timer
 * key it owns. `isTemporarilyFenced` is an authority gate (prepared reconcile /
 * membership / meter source), NOT a debounce: it postpones a Flow trigger that
 * would otherwise be attributed to a home this runtime is not currently
 * authoritative for.
 */
type AlertLaneEnv = {
  homeId: HomeId;
  timers: TimerRegistry;
  timerKey: string;
  isDiscarded: () => boolean;
  isTemporarilyFenced: () => boolean;
  isConditionActive: () => boolean;
  getHomeDisplayName: () => string;
  flow: Pick<FlowPort, 'getTriggerCard'>;
  nowMs: () => number;
};

const triggerAlertCard = async (
  env: AlertLaneEnv,
  trigger: AlertTrigger,
): Promise<AlertDelivery> => {
  const card = ALERT_CARDS[trigger.lane];
  const state = trigger.lane === 'sustained' ? trigger.state : undefined;
  let home = '';
  try {
    // The home-name resolver and the card lookup are BOTH inside the try: a
    // Homey SDK read can throw transiently, and this runs during a hard-cap
    // breach, where an unhandled rejection would be the worst possible restart.
    home = env.getHomeDisplayName();
    const flowCard = env.flow.getTriggerCard(card.cardId);
    if (!flowCard || typeof flowCard.trigger !== 'function') {
      logger.error({
        event: card.failedEvent,
        home,
        homeId: env.homeId,
        incidentId: trigger.incidentId,
        cardId: card.cardId,
        reasonCode: 'trigger_unavailable' satisfies AlertFailureReason,
      });
      return 'unavailable';
    }
    // Keep the arg-less card's call shape at one argument: it has no `args`, so
    // a state object would be dead weight on the SDK seam.
    await (state ? flowCard.trigger({ home }, state) : flowCard.trigger({ home }));
    logger.info({
      event: card.triggeredEvent,
      home,
      homeId: env.homeId,
      incidentId: trigger.incidentId,
      ...state,
    });
    return 'delivered';
  } catch (err) {
    logger.error({
      event: card.failedEvent,
      home,
      homeId: env.homeId,
      incidentId: trigger.incidentId,
      cardId: card.cardId,
      reasonCode: 'trigger_rejected' satisfies AlertFailureReason,
      err,
    });
    return 'rejected';
  }
};

/**
 * Both lanes arm their timer this way. Clearing the key INSIDE the fired
 * callback, before `run`, is load-bearing: the registry must never hold a spent
 * handle, and `run` re-registers under the same key.
 */
const scheduleLaneTimer = (env: AlertLaneEnv, params: {
  delayMs: number;
  failedEvent: string;
  reasonCode: AlertFailureReason;
  getIncidentId: () => string | null;
  run: () => Promise<void>;
}): void => {
  env.timers.registerTimeout(env.timerKey, runWithoutContext(() => setTimeout(() => {
    env.timers.clear(env.timerKey);
    void params.run().catch((err: unknown) => logger.error({
      event: params.failedEvent,
      homeId: env.homeId,
      incidentId: params.getIncidentId(),
      reasonCode: params.reasonCode,
      err,
    }));
  }, params.delayMs)));
};

/**
 * `capacity_shortfall` — fires the moment PELS runs out of managed load to turn
 * down. There is no confirmation window here on purpose: a Flow author who
 * wants one uses `capacity_shortfall_sustained`, where the wait is a visible
 * card argument. One alert per incident.
 *
 * Not exported: the composite below owns the `isDiscarded` fence on the way in,
 * so this must not be wired up on its own.
 */
const createImmediateLane = (env: AlertLaneEnv): CapacityShortfallAlertDispatch => {
  let deferred: { candidate: CapacityShortfallAlertCandidate; deferredAtMs: number } | null = null;
  let deliveredIncidentId: string | null = null;

  const fire = async (incidentId: string): Promise<AlertDelivery> => triggerAlertCard(env, {
    lane: 'immediate',
    incidentId,
  });

  const dropDeferred = (reasonCode: AlertDropReason): void => {
    const entry = deferred;
    env.timers.clear(env.timerKey);
    deferred = null;
    if (!entry) return;
    logger.info({
      event: 'hard_cap_shortfall_alert_dropped',
      homeId: env.homeId,
      incidentId: entry.candidate.incidentId,
      reasonCode,
      durationMs: Math.max(0, env.nowMs() - entry.deferredAtMs),
    });
  };

  const releaseDeferred = async (): Promise<void> => {
    const entry = deferred;
    if (!entry) return;
    if (env.isDiscarded()) {
      dropDeferred('runtime_discarded');
      return;
    }
    if (!env.isConditionActive()) {
      dropDeferred('condition_cleared');
      return;
    }
    if (env.isTemporarilyFenced()) {
      scheduleRetry();
      return;
    }
    deferred = null;
    deliveredIncidentId = entry.candidate.incidentId;
    await fire(entry.candidate.incidentId);
  };

  const scheduleRetry = (): void => scheduleLaneTimer(env, {
    delayMs: CAPACITY_SHORTFALL_ALERT_RETRY_MS,
    failedEvent: ALERT_CARDS.immediate.failedEvent,
    reasonCode: 'release_failed',
    getIncidentId: () => deferred?.candidate.incidentId ?? null,
    run: releaseDeferred,
  });

  return {
    onCandidate: (candidate) => {
      if (deliveredIncidentId === candidate.incidentId) return;
      if (deferred?.candidate.incidentId === candidate.incidentId) return;
      if (deferred) dropDeferred('incident_replaced');
      if (env.isTemporarilyFenced()) {
        deferred = { candidate, deferredAtMs: env.nowMs() };
        logger.info({
          event: 'hard_cap_shortfall_alert_deferred',
          homeId: env.homeId,
          incidentId: candidate.incidentId,
          deficitKw: candidate.deficitKw,
          reasonCode: 'authority_fenced',
        });
        scheduleRetry();
        return;
      }
      deliveredIncidentId = candidate.incidentId;
      // `fire` swallows a rejected Flow itself; this catches a home-name or
      // card lookup that throws on a runtime being torn down underneath us,
      // which would otherwise surface as an unhandled rejection.
      void fire(candidate.incidentId).catch((err: unknown) => logger.error({
        event: ALERT_CARDS.immediate.failedEvent,
        homeId: env.homeId,
        incidentId: candidate.incidentId,
        reasonCode: 'release_failed' satisfies AlertFailureReason,
        err,
      }));
    },
    onConditionCleared: () => {
      if (deferred) dropDeferred('condition_cleared');
    },
    onIncidentCleared: () => {
      if (deferred) dropDeferred('incident_cleared');
      deliveredIncidentId = null;
    },
  };
};

/**
 * `capacity_shortfall_sustained` — the threshold lives in each Flow's `seconds`
 * arg, so this lane cannot know which durations matter. It emits a crossing on
 * every step of its grid and lets the card's run listener decide which saved
 * Flows match.
 *
 * `highWaterSeconds` is what makes it one alert per threshold per incident: a
 * break restarts the clock but keeps the mark, so a flapping load cannot
 * re-fire a threshold that already alerted. Only a full incident clear resets
 * it.
 *
 * The run ends — rather than pausing — when the breach stops being evidenced:
 * "for at least X seconds" is a claim about an unbroken stretch, and a gap in
 * the evidence is a break whether the power recovered or the meter went quiet.
 *
 * Not exported: see `createImmediateLane`.
 */
const createSustainedLane = (env: AlertLaneEnv): CapacityShortfallAlertDispatch => {
  let incidentId: string | null = null;
  let running = false;
  let runToken = 0;
  let stepsThisRun = 0;
  let lastCandidateAtMs = 0;
  let highWaterSeconds = 0;
  // Set only when a run hit the step bound with nothing further to deliver, so
  // the incident stops re-arming. A run cut short by a break does NOT set it —
  // the next run gets the full range.
  let budgetExhausted = false;

  const stop = (reasonCode: AlertRunEndReason): void => {
    // A replacement bundle for the same home derives the SAME key, so a
    // discarded lane must never clear it — teardown already cancelled this
    // lane's own timer, and clearing again would cancel the replacement's
    // ticker instead.
    if (!env.isDiscarded()) env.timers.clear(env.timerKey);
    if (!running) return;
    running = false;
    // A break before anything fired is not worth a line.
    if (highWaterSeconds === 0 && reasonCode === 'condition_cleared') return;
    logger.info({
      event: 'hard_cap_shortfall_sustained_alert_ended',
      homeId: env.homeId,
      incidentId,
      reasonCode,
      sustainedSeconds: highWaterSeconds,
    });
  };

  const scheduleTick = (): void => scheduleLaneTimer(env, {
    delayMs: STEP_MS,
    failedEvent: ALERT_CARDS.sustained.failedEvent,
    reasonCode: 'tick_failed',
    getIncidentId: () => incidentId,
    run: runTick,
  });

  const runTick = async (): Promise<void> => {
    const runIncidentId = incidentId;
    const myRun = runToken;
    if (!running || runIncidentId === null) return;
    if (env.isDiscarded()) {
      stop('runtime_discarded');
      return;
    }
    if (!env.isConditionActive()) {
      stop('condition_cleared');
      return;
    }
    // `isConditionActive` reads the last power sample the guard ever saw, with
    // no freshness bound (nothing calls `resetLastTotalPower` in production).
    // A meter that stops reporting would therefore leave the predicate frozen
    // at "breaching" and let wall time alone walk the whole ladder, well before
    // the 10-minute stale-sample escalation notices. A republished candidate is
    // the only evidence the breach is still real, so a gap ends the run.
    if (env.nowMs() - lastCandidateAtMs > POWER_SAMPLE_STALE_THRESHOLD_MS) {
      stop('evidence_stale');
      return;
    }

    stepsThisRun += 1;
    // Duration comes from the ticks that actually ran, not from a wall-clock
    // delta: Node timers are monotonic, so an NTP correction cannot make one
    // tick claim the whole ladder at once (forward jump) or stall the backstop
    // forever (backward jump). An event-loop stall makes this under-count,
    // which only delays an alert.
    const sustainedSeconds = stepsThisRun * CAPACITY_SHORTFALL_SUSTAINED_STEP_SECONDS;

    // A fenced tick emits nothing but leaves the high-water mark alone, so the
    // next emitted crossing window still spans the thresholds it skipped.
    let crossingDelivered = false;
    if (!env.isTemporarilyFenced() && sustainedSeconds > highWaterSeconds) {
      const delivery = await triggerAlertCard(env, {
        lane: 'sustained',
        incidentId: runIncidentId,
        state: { sustainedSeconds, previousSustainedSeconds: highWaterSeconds },
      });
      // `unavailable` counts as delivered: an unregistered card is not
      // transient, and holding the mark back would re-log every step for the
      // life of the breach.
      crossingDelivered = delivery !== 'rejected';
    }

    // Establish that this run is still the live one BEFORE touching any shared
    // state. A trigger can stay pending across an incident clear and the next
    // incident's first candidate, and writing the old crossing's mark into the
    // new incident would suppress every threshold below it. `runToken` (not the
    // incident) identifies a run, because runs restart within one incident.
    // Teardown also clears timers by key, so re-registering here would cancel a
    // replacement bundle's ticker.
    if (!running || runToken !== myRun || incidentId !== runIncidentId) return;

    // Advance the mark only once the crossing actually reached Homey. A
    // transient rejection would otherwise burn the threshold it was carrying:
    // every later window starts above it, so a Flow set to that duration never
    // fires for this incident.
    if (crossingDelivered) highWaterSeconds = sustainedSeconds;

    if (env.isDiscarded()) {
      stop('runtime_discarded');
      return;
    }
    if (stepsThisRun >= MAX_STEPS_PER_RUN) {
      // Bar a restart only when this run had nothing left to deliver: fenced
      // throughout (so a mark-keyed bound would never engage and the incident
      // would re-arm forever), or the whole range served. A rejection at the
      // final crossing leaves the top threshold unserved, so that incident
      // earns another run.
      budgetExhausted = env.isTemporarilyFenced()
        || highWaterSeconds >= CAPACITY_SHORTFALL_SUSTAINED_MAX_SECONDS;
      stop('max_reached');
      return;
    }
    scheduleTick();
  };

  return {
    onCandidate: (candidate) => {
      lastCandidateAtMs = env.nowMs();
      if (incidentId !== candidate.incidentId) {
        incidentId = candidate.incidentId;
        highWaterSeconds = 0;
        budgetExhausted = false;
      } else if (running) {
        return;
      }
      if (budgetExhausted) return;
      running = true;
      runToken += 1;
      stepsThisRun = 0;
      scheduleTick();
    },
    // Ends the run outright. This card exists so a Flow can hold off actuating
    // until a breach has proven it is not a short overshoot, so a sample back
    // under the cap IS the situation resolving — the run should not carry its
    // accumulated seconds across it. A load that keeps dipping under the cap
    // therefore never accumulates toward a threshold, which is the intent: it
    // is a series of spikes, not a sustained breach.
    onConditionCleared: () => stop('condition_cleared'),
    onIncidentCleared: () => {
      stop('incident_cleared');
      incidentId = null;
      highWaterSeconds = 0;
      budgetExhausted = false;
    },
  };
};

/**
 * Dispatches the two hard-cap alert Flow triggers for ONE home, off the same
 * `CapacityGuard` alert-condition callbacks. PELS limits managed devices
 * immediately regardless of either lane; these only decide when a user's Flow
 * starts.
 */
export const createCapacityShortfallAlertDispatch = (params: {
  homeId: HomeId;
  timers: TimerRegistry;
  /**
   * One key per lane, passed in rather than derived from a base, so the wiring
   * that NAMES a timer is the wiring that clears it on teardown.
   */
  immediateTimerKey: string;
  sustainedTimerKey: string;
  isDiscarded: () => boolean;
  isTemporarilyFenced: () => boolean;
  isConditionActive: () => boolean;
  getHomeDisplayName: () => string;
  flow: Pick<FlowPort, 'getTriggerCard'>;
  nowMs?: () => number;
}): CapacityShortfallAlertDispatch => {
  if (params.immediateTimerKey === params.sustainedTimerKey) {
    // Sharing a key would make every immediate-lane retry cancel the sustained
    // ticker, silently. Assert rather than default (`setup/AGENTS.md`).
    throw new Error('capacity shortfall alert lanes need distinct timer keys');
  }
  const base = { ...params, nowMs: params.nowMs ?? Date.now };
  const immediate = createImmediateLane({ ...base, timerKey: params.immediateTimerKey });
  const sustained = createSustainedLane({ ...base, timerKey: params.sustainedTimerKey });

  return {
    onCandidate: (candidate) => {
      if (base.isDiscarded()) return;
      immediate.onCandidate(candidate);
      sustained.onCandidate(candidate);
    },
    onConditionCleared: () => {
      immediate.onConditionCleared();
      sustained.onConditionCleared();
    },
    onIncidentCleared: () => {
      immediate.onIncidentCleared();
      sustained.onIncidentCleared();
    },
  };
};
