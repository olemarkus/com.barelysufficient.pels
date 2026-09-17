import { randomUUID } from 'node:crypto';
import type { Logger as PinoLogger } from '../logging/logger';
import type { HomeId } from '../utils/settingsKeys';
import type { PlanInputCapacityStateSummary } from './capacityStateSummary';

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
  /**
   * The four incident callbacks are required for the same reason as the
   * logger: the one factory (`createHomeCapacityGuard`) always wires them, so
   * an optional here would only ever be absent in a test — and a guard missing
   * its alert callbacks silently never alerts.
   */
  onShortfall: ShortfallCallback;
  onShortfallCleared: TriggerCallback;
  onShortfallAlertCandidate: ShortfallAlertCandidateCallback;
  onShortfallAlertConditionCleared: ShortfallAlertConditionClearedCallback;
  /**
   * Required: the one factory always injects the home-attributed `capacity`
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
export const isOverShortfallThreshold = (
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
 * shedding; this only records what it decided. That is why the two ways in are
 * shaped differently: a plan verdict (`recordPlanVerdict`) carries the evidence
 * an incident is recorded with, and a bare reading (`recordReading`) carries
 * none and so cannot open one.
 */
export default class CapacityGuard {
  private static readonly SHORTFALL_CLEAR_MARGIN_KW = 0.2;
  private static readonly SHORTFALL_CLEAR_SUSTAIN_MS = 60000; // 60 seconds of sustained positive headroom

  private shortfallClearStartTime: number | null = null;

  private inShortfall = false;

  // Callbacks
  private onShortfall: ShortfallCallback;
  private onShortfallCleared: TriggerCallback;
  private onShortfallAlertCandidate: ShortfallAlertCandidateCallback;
  private onShortfallAlertConditionCleared: ShortfallAlertConditionClearedCallback;

  private structuredLog: CapacityGuardLogger;
  private homeId: HomeId;
  private incidentId: string | null = null;
  private incidentStartMs = 0;
  /** The last plan verdict over the threshold found nothing left it could shed. */
  private planLeftNothingToShed = false;

  /** Whether the selected capacity period has enough coverage to judge a shortfall. */
  private shortfallReportingAvailable = false;

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
   * The plan's verdict on a reading over the shortfall threshold: the capacity
   * state its build decided from, whose `remainingActionableControlledLoad` says
   * whether its shed candidates could still relieve anything, and
   * `shedReliefInFlight` whether a shed it already decided has yet to land.
   * Opens an incident only when nothing is left AND nothing is on its way — the
   * build that sheds the last device has not run out of options, it has just
   * used one, and the reading it decided from predates the relief. It is the
   * only call that can open one.
   *
   * Only `reportShortfallToGuard` (`lib/plan/shedding/shortfallVerdict.ts`)
   * builds one, because only a plan build holds the device list and the
   * candidates the question is asked of. A rebuild that changed nothing is not
   * a verdict: the planner also changes nothing when it
   * chooses to wait out a shed grace, and the rebuild throttle once read one as
   * the other, opening incidents and firing the owner's Flow with kilowatts
   * still reducible.
   */
  async recordPlanVerdict(
    totalKw: number,
    shortfallThresholdKw: number,
    capacityStateSummary: PlanInputCapacityStateSummary,
  ): Promise<void> {
    this.shortfallReportingAvailable = true;
    this.planLeftNothingToShed = !capacityStateSummary.remainingActionableControlledLoad
      && !capacityStateSummary.shedReliefInFlight;
    const alertConditionActive = this.isShortfallAlertConditionActive(totalKw, shortfallThresholdKw);
    const enterPromise = alertConditionActive && !this.inShortfall
      ? this.enterShortfall(totalKw, shortfallThresholdKw, capacityStateSummary)
      : null;
    this.publishShortfallAlertCondition(alertConditionActive, totalKw - shortfallThresholdKw);
    await enterPromise;
    await this.maybeClearShortfall(shortfallThresholdKw, totalKw);
  }

  /**
   * The current period is deliberately fail-closed for control but has too
   * little coverage to support an incident verdict. Suppress alert delivery
   * without fabricating recovery evidence or resetting an in-flight recovery
   * timer; the next complete-period plan verdict makes reporting available.
   */
  recordShortfallUnavailable(): void {
    this.shortfallReportingAvailable = false;
    this.publishShortfallAlertCondition(false, 0);
  }

  /**
   * A reading that came with no plan verdict. While the selected period is
   * complete, it moves the recovery clock against the last verdict but can
   * never open an incident. While reporting is unavailable it is a no-op: the
   * throttle's synthetic threshold must neither reset nor advance recovery.
   *
   * `totalKw` is the caller's resolved whole-home total. Both callers hold a
   * plain number — `MeasuredPower.drawKw` in `lib/plan/shedding/shortfallVerdict`,
   * the finiteness-gated tracker latch in `lib/plan/rebuildScheduler` — so there
   * is no absence to model here.
   */
  async recordReading(
    totalKw: number,
    shortfallThresholdKw: number,
    thresholdAuthority: 'last_verdict' | 'complete_period' = 'last_verdict',
  ): Promise<void> {
    if (thresholdAuthority === 'complete_period') this.shortfallReportingAvailable = true;
    if (!this.shortfallReportingAvailable) return;
    const alertConditionActive = this.isShortfallAlertConditionActive(totalKw, shortfallThresholdKw);
    this.publishShortfallAlertCondition(alertConditionActive, totalKw - shortfallThresholdKw);
    await this.maybeClearShortfall(shortfallThresholdKw, totalKw);
  }

  public isShortfallAlertConditionActive(totalKw: number | null, shortfallThresholdKw: number): boolean {
    return this.shortfallReportingAvailable
      && this.planLeftNothingToShed
      && isOverShortfallThreshold(totalKw, shortfallThresholdKw);
  }

  private publishShortfallAlertCondition(active: boolean, deficitKw: number): void {
    if (!active) {
      this.onShortfallAlertConditionCleared();
      return;
    }
    if (this.incidentId === null) return;
    this.onShortfallAlertCandidate({
      incidentId: this.incidentId,
      deficitKw,
      detectedAtMs: this.incidentStartMs,
    });
  }

  private async enterShortfall(
    totalKw: number,
    shortfallThresholdKw: number,
    capacityStateSummary: PlanInputCapacityStateSummary,
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
    await this.onShortfall(totalKw - shortfallThresholdKw);
  }

  private async maybeClearShortfall(
    shortfallThreshold: number,
    totalKw: number,
  ): Promise<void> {
    if (!this.inShortfall) return;
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
      // The verdict was about a reading this incident has recovered from; the
      // next breach gets its own before anything reads the alert condition.
      this.planLeftNothingToShed = false;
      await this.onShortfallCleared();
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
