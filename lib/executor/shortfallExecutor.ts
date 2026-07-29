import type CapacityGuard from '../power/capacityGuard';
import type { PlanEngineState } from '../plan/planState';
import { getLogger } from '../logging/logger';
import { incPerfCounter } from '../utils/perfCounters';
import type { HomeId } from '../utils/settingsKeys';

const logger = getLogger('executor/plan');

/**
 * Executor-facing dependencies for immediate hard-cap state transitions.
 * Setup owns the separately delayed user Flow alert; this executor owns only
 * durable PELS state materialization.
 */
export type ShortfallExecutorDeps = {
  /**
   * Producer-resolved display name used to attribute the immediate state log
   * to the same home that setup names on the separately delayed Flow alert.
   */
  getHomeDisplayName: () => string;
  /** Stable home id used to correlate structured enter, alert, and clear logs. */
  homeId: HomeId;
  setCapacityInShortfall: (inShortfall: boolean) => void;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
};

export class ShortfallExecutor {
  // Distinct from `state.inShortfall`: the builder can synchronize that shared
  // planner/persistence latch before a temporarily fenced enter callback lands.
  private stateSideEffectActive = false;
  constructor(private deps: ShortfallExecutorDeps, private state: PlanEngineState) {}

  public async handleShortfall(deficitKw: number): Promise<void> {
    if (this.stateSideEffectActive) return;

    const capacityGuard = this.deps.getCapacityGuard();
    const capacitySettings = this.deps.getCapacitySettings();
    const shortfallThreshold = capacityGuard
      ? capacityGuard.getShortfallThreshold()
      : capacitySettings.limitKw;
    const softLimit = capacityGuard ? capacityGuard.getSoftLimit() : capacitySettings.limitKw;
    const total = capacityGuard ? capacityGuard.getLastTotalPower() : null;
    const totalStr = total === null ? 'unknown' : total.toFixed(2);
    const home = this.deps.getHomeDisplayName();

    logger.info({
      event: 'executor_plan_log',
      home,
      homeId: this.deps.homeId,
      msg: `Capacity shortfall: projected hard-cap budget breach, over by `
        + `~${deficitKw.toFixed(2)}kW `
        + `(total ${totalStr}kW, `
        + `threshold ${shortfallThreshold.toFixed(2)}kW, `
        + `soft ${softLimit.toFixed(2)}kW)`,
    });

    if (!this.state.inShortfall) {
      // Persist first, then commit the in-memory latch. A failed durable write
      // must leave the immediate semantic transition retryable.
      this.deps.setCapacityInShortfall(true);
      this.state.inShortfall = true;
      incPerfCounter('settings_set.capacity_in_shortfall');
    }

    this.stateSideEffectActive = true;
  }

  public async handleShortfallCleared(): Promise<void> {
    if (!this.state.inShortfall && !this.stateSideEffectActive) return;

    logger.info({
      event: 'executor_plan_log',
      home: this.deps.getHomeDisplayName(),
      homeId: this.deps.homeId,
      msg: 'Capacity shortfall resolved',
    });
    if (this.state.inShortfall) {
      // Same commit ordering as enter: a failed durable write must leave the
      // in-memory latch retryable so a deferred clear is not silently consumed.
      this.deps.setCapacityInShortfall(false);
      this.state.inShortfall = false;
      incPerfCounter('settings_set.capacity_in_shortfall');
    }
    this.stateSideEffectActive = false;
  }
}
