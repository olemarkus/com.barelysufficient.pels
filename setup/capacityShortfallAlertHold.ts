import type { CapacityShortfallAlertCandidate } from '../lib/power/capacityGuard';
import { getLogger } from '../lib/logging/logger';
import { runWithoutContext } from '../lib/logging/alsContext';
import type { FlowPort } from '../lib/ports/homeyRuntime';
import type { HomeId } from '../lib/utils/settingsKeys';
import type { TimerRegistry } from '../lib/utils/timerRegistry';

const logger = getLogger('setup/capacity-shortfall-alert-hold');

export const CAPACITY_SHORTFALL_ALERT_HOLD_MS = 10_000;
const CAPACITY_SHORTFALL_ALERT_RETRY_MS = 1_000;

export type CapacityShortfallAlertHold = {
  onCandidate: (candidate: CapacityShortfallAlertCandidate) => void;
  onConditionCleared: () => void;
  onIncidentCleared: () => void;
};

type PendingAlert = {
  candidate: CapacityShortfallAlertCandidate;
  startedAtMs: number;
};

export const createCapacityShortfallAlertHold = (params: {
  homeId: HomeId;
  timers: TimerRegistry;
  timerKey: string;
  isDiscarded: () => boolean;
  isTemporarilyFenced: () => boolean;
  isConditionActive: () => boolean;
  getHomeDisplayName: () => string;
  flow: Pick<FlowPort, 'getTriggerCard'>;
  nowMs?: () => number;
}): CapacityShortfallAlertHold => {
  const nowMs = params.nowMs ?? Date.now;
  let pending: PendingAlert | null = null;
  let deliveredIncidentId: string | null = null;

  const clearPending = (
    reasonCode: 'condition_cleared' | 'incident_cleared' | 'incident_replaced' | 'runtime_discarded',
  ): void => {
    const entry = pending;
    params.timers.clear(params.timerKey);
    pending = null;
    if (!entry) return;
    logger.info({
      event: 'hard_cap_shortfall_alert_hold_cancelled',
      homeId: params.homeId,
      incidentId: entry.candidate.incidentId,
      reasonCode,
      durationMs: Math.max(0, nowMs() - entry.startedAtMs),
      holdRequiredMs: CAPACITY_SHORTFALL_ALERT_HOLD_MS,
    });
  };

  const schedule = (delayMs: number): void => {
    const timeout = runWithoutContext(() => setTimeout(() => {
      params.timers.clear(params.timerKey);
      void releasePending().catch((err: unknown) => {
        logger.error({
          event: 'hard_cap_shortfall_alert_failed',
          homeId: params.homeId,
          reasonCode: 'release_failed',
          err,
        });
      });
    }, delayMs));
    params.timers.registerTimeout(params.timerKey, timeout);
  };

  const releasePending = async (): Promise<void> => {
    const entry = pending;
    if (!entry) return;
    if (params.isDiscarded()) {
      clearPending('runtime_discarded');
      return;
    }
    if (!params.isConditionActive()) {
      clearPending('condition_cleared');
      return;
    }
    if (params.isTemporarilyFenced()) {
      schedule(CAPACITY_SHORTFALL_ALERT_RETRY_MS);
      return;
    }

    const home = params.getHomeDisplayName();
    pending = null;
    deliveredIncidentId = entry.candidate.incidentId;
    try {
      const card = params.flow.getTriggerCard('capacity_shortfall');
      if (!card || typeof card.trigger !== 'function') {
        logger.error({
          event: 'hard_cap_shortfall_alert_failed',
          home,
          homeId: params.homeId,
          incidentId: entry.candidate.incidentId,
          reasonCode: 'trigger_unavailable',
        });
        return;
      }
      await card.trigger({ home });
      logger.info({
        event: 'hard_cap_shortfall_alert_triggered',
        home,
        homeId: params.homeId,
        incidentId: entry.candidate.incidentId,
        durationMs: Math.max(0, nowMs() - entry.startedAtMs),
        holdRequiredMs: CAPACITY_SHORTFALL_ALERT_HOLD_MS,
      });
    } catch (err) {
      logger.error({
        event: 'hard_cap_shortfall_alert_failed',
        home,
        homeId: params.homeId,
        incidentId: entry.candidate.incidentId,
        reasonCode: 'trigger_rejected',
        err,
      });
    }
  };

  return {
    onCandidate: (candidate) => {
      if (params.isDiscarded() || deliveredIncidentId === candidate.incidentId) return;
      if (pending?.candidate.incidentId === candidate.incidentId) return;
      if (pending) clearPending('incident_replaced');
      pending = { candidate, startedAtMs: nowMs() };
      logger.info({
        event: 'hard_cap_shortfall_alert_hold_started',
        homeId: params.homeId,
        incidentId: candidate.incidentId,
        deficitKw: candidate.deficitKw,
        holdRequiredMs: CAPACITY_SHORTFALL_ALERT_HOLD_MS,
      });
      schedule(CAPACITY_SHORTFALL_ALERT_HOLD_MS);
    },
    onConditionCleared: () => {
      if (pending) clearPending('condition_cleared');
    },
    onIncidentCleared: () => {
      if (pending) clearPending('incident_cleared');
      deliveredIncidentId = null;
    },
  };
};
