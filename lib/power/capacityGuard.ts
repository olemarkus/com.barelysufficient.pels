import { randomUUID } from 'node:crypto';
import type { Logger as PinoLogger } from '../logging/logger';
import type { HomeId } from '../utils/settingsKeys';
import type { PlanCapacityStateSummary } from './capacityStateSummary';

type TriggerCallback = () => Promise<void> | void;
type ShortfallCallback = (deficitKw: number) => Promise<void> | void;
type ShortfallAlertCandidateCallback = (candidate: CapacityShortfallAlertCandidate) => void;
type ShortfallAlertConditionClearedCallback = () => void;
type CapacityGuardLogger = Pick<PinoLogger, 'info'>;

export type CapacityGuardOptions = {
  /**
   * Stable identity of the capacity controller that owns this guard.
   * Required so every hard-cap incident record is attributable.
   */
  homeId: HomeId;
  onShortfall?: ShortfallCallback;
  onShortfallCleared?: TriggerCallback;
  onShortfallAlertCandidate?: ShortfallAlertCandidateCallback;
  onShortfallAlertConditionCleared?: ShortfallAlertConditionClearedCallback;
  /**
   * Required: both factories always inject the home-attributed `capacity`
   * logger, so a module-logger default would only ever fire in a test and would
   * silently drop the `homeId` correlation every incident log depends on.
   */
  structuredLog: CapacityGuardLogger;
};

export type CapacityShortfallAlertCandidate = {
  incidentId: string;
  deficitKw: number;
  detectedAtMs: number;
};

/** Panic is a hard-cap question, so it is asked against the hard-cap budget. */
const isOverShortfallThreshold = (
  totalKw: number | null,
  shortfallThresholdKw: number,
): boolean => totalKw !== null && totalKw > shortfallThresholdKw;

/**
 * Latched state for one home's capacity control: the shedding latch and the
 * hard-cap shortfall incident.
 *
 * It holds no power reading and no capacity settings. The tracker is the single
 * power latch (`resolveLastTotalPowerKw`) and capacity settings are read from
 * their own store, so every threshold this class once relayed — the soft limit,
 * the shortfall threshold — is now resolved by the caller and passed in. What
 * remains is the state nothing else owns: the shedding latch with its clear
 * hysteresis, and the incident identity plus its sustained-recovery clock.
 *
 * The Plan (`buildDevicePlanSnapshot`) is still the single decision-maker for
 * shedding; this only records what it decided.
 */
export default class CapacityGuard {
  private static readonly SHORTFALL_CLEAR_MARGIN_KW = 0.2;
  private static readonly SHORTFALL_CLEAR_SUSTAIN_MS = 60000; // 60 seconds of sustained positive headroom

  private shortfallClearStartTime: number | null = null;

  private inShortfall = false;

  // Callbacks
  private onShortfall?: ShortfallCallback;
  private onShortfallCleared?: TriggerCallback;
  private onShortfallAlertCandidate?: ShortfallAlertCandidateCallback;
  private onShortfallAlertConditionCleared?: ShortfallAlertConditionClearedCallback;

  private structuredLog: CapacityGuardLogger;
  private homeId: HomeId;
  private incidentId: string | null = null;
  private incidentStartMs = 0;
  private shortfallHasCandidates: boolean | null = null;

  constructor(options: CapacityGuardOptions) {
    this.homeId = options.homeId;
    this.structuredLog = options.structuredLog;
    this.onShortfall = options.onShortfall;
    this.onShortfallCleared = options.onShortfallCleared;
    this.onShortfallAlertCandidate = options.onShortfallAlertCandidate;
    this.onShortfallAlertConditionCleared = options.onShortfallAlertConditionCleared;
  }

  // --- State management (called by Plan) ---

  isInShortfall(): boolean {
    return this.inShortfall;
  }

  getCurrentIncidentId(): string | null {
    return this.incidentId;
  }

  /**
   * Called by Plan after shedding decisions to check/update shortfall state.
   *
   * `totalKw` is the caller's resolved whole-home total (`null` = no
   * trustworthy reading). The guard holds no power of its own: the tracker is
   * the single latch, so the value and its freshness describe one sample
   * instead of two objects that can disagree.
   *
   * An unmeasured cycle is a no-op: nothing enters, nothing clears, and the
   * recovery sustain is neither advanced nor restarted. Callers need not withhold
   * the call to keep an incident latched. (`hasCandidates` is still recorded: it
   * is a device-list fact the caller measured, not a power question.)
   */
  async checkShortfall(params: {
    /** Whether there are still devices that could be shed. */
    hasCandidates: boolean;
    /** Current kW above the shortfall threshold. */
    deficitKw: number;
    /**
     * The caller's resolved whole-home total. Both control-path callers hold a
     * plain number — `MeasuredPower.drawKw` in `lib/plan/admission/sheddingGuard`,
     * the finiteness-gated tracker latch in `lib/plan/rebuildScheduler`. There is
     * no absence to model here, so there is no branch for one.
     */
    totalKw: number;
    /**
     * `capacityPaceKw` on the hard-cap budget — resolved by the caller from
     * `computeShortfallThreshold`, which is a pure function of capacity
     * settings and the tracker. The guard used to relay it through a provider
     * with a hard-cap fallback; every caller already holds the inputs.
     */
    shortfallThresholdKw: number;
    capacityStateSummary: PlanCapacityStateSummary;
  }): Promise<void> {
    const {
      hasCandidates, deficitKw, totalKw, shortfallThresholdKw, capacityStateSummary,
    } = params;
    this.shortfallHasCandidates = hasCandidates;

    const alertConditionActive = !hasCandidates
      && isOverShortfallThreshold(totalKw, shortfallThresholdKw);

    // Enter shortfall if over threshold AND no candidates left
    const enterPromise = alertConditionActive && !this.inShortfall
      ? this.enterShortfall(deficitKw, totalKw, shortfallThresholdKw, capacityStateSummary)
      : null;
    this.publishShortfallAlertCondition(alertConditionActive, deficitKw);
    await enterPromise;

    // Check for shortfall clearing (requires sustained positive headroom)
    if (this.inShortfall) {
      await this.maybeClearShortfall(shortfallThresholdKw, totalKw);
    }
  }

  public isShortfallAlertConditionActive(totalKw: number | null, shortfallThresholdKw: number): boolean {
    return this.shortfallHasCandidates === false
      && isOverShortfallThreshold(totalKw, shortfallThresholdKw);
  }

  private publishShortfallAlertCondition(active: boolean, deficitKw: number): void {
    if (!active) {
      this.onShortfallAlertConditionCleared?.();
      return;
    }
    if (this.incidentId === null) return;
    this.onShortfallAlertCandidate?.({
      incidentId: this.incidentId,
      deficitKw,
      detectedAtMs: this.incidentStartMs,
    });
  }

  private async enterShortfall(
    deficitKw: number,
    totalKw: number,
    shortfallThresholdKw: number,
    capacityStateSummary: PlanCapacityStateSummary,
  ): Promise<void> {
    this.incidentId = `inc_${randomUUID()}`;
    this.incidentStartMs = Date.now();
    const thresholdW = Math.round(shortfallThresholdKw * 1000);
    const powerW = Math.round(totalKw * 1000);
    this.structuredLog.info({
      event: 'hard_cap_shortfall_detected',
      homeId: this.homeId,
      incidentId: this.incidentId,
      powerW,
      thresholdW,
      headroomW: thresholdW - powerW,
      excessW: powerW - thresholdW,
      ...capacityStateSummary,
    });
    this.inShortfall = true;
    this.shortfallClearStartTime = null;
    await this.onShortfall?.(deficitKw);
  }

  private async maybeClearShortfall(
    shortfallThreshold: number,
    totalKw: number,
  ): Promise<void> {
    const thresholdHeadroom = shortfallThreshold - totalKw;
    if (thresholdHeadroom >= CapacityGuard.SHORTFALL_CLEAR_MARGIN_KW) {
      await this.updateShortfallClearTimer(shortfallThreshold, totalKw);
      return;
    }
    this.resetShortfallClearTimer();
  }

  private async updateShortfallClearTimer(
    shortfallThreshold: number,
    totalKw: number,
  ): Promise<void> {
    const now = Date.now();
    if (this.shortfallClearStartTime === null) {
      this.shortfallClearStartTime = now;
      this.structuredLog.info({
        event: 'hard_cap_shortfall_recovery_started',
        homeId: this.homeId,
        incidentId: this.incidentId,
        sustainRequiredMs: CapacityGuard.SHORTFALL_CLEAR_SUSTAIN_MS,
      });
      return;
    }
    if (now - this.shortfallClearStartTime >= CapacityGuard.SHORTFALL_CLEAR_SUSTAIN_MS) {
      const powerW = Math.round(totalKw * 1000);
      const thresholdW = Math.round(shortfallThreshold * 1000);
      this.structuredLog.info({
        event: 'hard_cap_shortfall_recovered',
        homeId: this.homeId,
        incidentId: this.incidentId,
        powerW,
        thresholdW,
        headroomW: thresholdW - powerW,
        recoveryMs: this.incidentStartMs > 0 ? now - this.incidentStartMs : 0,
      });
      this.inShortfall = false;
      this.shortfallClearStartTime = null;
      this.incidentId = null;
      this.incidentStartMs = 0;
      await this.onShortfallCleared?.();
    }
  }

  private resetShortfallClearTimer(): void {
    if (this.shortfallClearStartTime !== null) {
      this.structuredLog.info({
        event: 'hard_cap_shortfall_recovery_reset',
        homeId: this.homeId,
        incidentId: this.incidentId,
      });
      this.shortfallClearStartTime = null;
    }
  }
}
