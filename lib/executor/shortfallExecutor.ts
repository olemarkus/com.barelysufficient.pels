import { resolveLastTotalPowerKw } from '../power/lastTotalPower';
import type { PowerTrackerState } from '../power/tracker';
import { getLogger } from '../logging/logger';
import type { HomeId } from '../utils/settingsKeys';

const logger = getLogger('executor/plan');

/**
 * Executor-facing dependencies for the hard-cap shortfall's log lines. Setup
 * owns the separately delayed user Flow alert, and the published status
 * carries the shortfall itself (`capacityShortfall`, from the capacity guard).
 */
export type ShortfallExecutorDeps = {
  /**
   * Producer-resolved display name used to attribute the immediate state log
   * to the same home that setup names on the separately delayed Flow alert.
   */
  getHomeDisplayName: () => string;
  /** Stable home id used to correlate structured enter, alert, and clear logs. */
  homeId: HomeId;
  getPowerTracker: () => PowerTrackerState;
  /** `capacityPaceKw` — the planner's live hourly threshold, for the log line. */
  getCapacityPaceKw: () => number | null;
  /**
   * `computeShortfallThreshold` — the hard-cap budget threshold, for the log
   * line and nothing else. INJECTED rather than recomputed here: it is a
   * planner-owned number, and this layer importing `lib/plan/planBudget` to
   * re-derive it was an executor->planner edge bought for one log field. A
   * getter, not a value, so it is still read at the instant the line is
   * written — an eagerly captured number would describe a different moment.
   */
  getShortfallThresholdKw: () => number | null;
};

export class ShortfallExecutor {
  // Whether this incident's enter line was written, so the guard's repeated
  // callbacks log it once and the cleared line follows only an enter.
  private shortfallLogged = false;
  constructor(private deps: ShortfallExecutorDeps) {}

  public async handleShortfall(deficitKw: number): Promise<void> {
    if (this.shortfallLogged) return;

    const shortfallThreshold = this.deps.getShortfallThresholdKw();
    const softLimit = this.deps.getCapacityPaceKw();
    if (shortfallThreshold === null || softLimit === null) return;
    const total = resolveLastTotalPowerKw(this.deps.getPowerTracker());
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

    this.shortfallLogged = true;
  }

  public async handleShortfallCleared(): Promise<void> {
    if (!this.shortfallLogged) return;

    logger.info({
      event: 'executor_plan_log',
      home: this.deps.getHomeDisplayName(),
      homeId: this.deps.homeId,
      msg: 'Capacity shortfall resolved',
    });
    this.shortfallLogged = false;
  }
}
