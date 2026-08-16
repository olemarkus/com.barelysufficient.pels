import { randomUUID } from 'node:crypto';
import type { Logger as PinoLogger } from '../logging/logger';
import type { HomeId } from '../utils/settingsKeys';
import type { PlanCapacityStateSummary } from './capacityStateSummary';

type TriggerCallback = () => Promise<void> | void;
type ShortfallCallback = (deficitKw: number) => Promise<void> | void;
type ShortfallAlertCandidateCallback = (candidate: CapacityShortfallAlertCandidate) => void;
type ShortfallAlertConditionClearedCallback = () => void;
type SoftLimitProvider = () => number | null;
type CapacityGuardLogger = Pick<PinoLogger, 'info'>;

export type CapacityGuardOptions = {
  /**
   * Stable identity of the capacity controller that owns this guard.
   * Required so every hard-cap incident record is attributable.
   */
  homeId: HomeId;
  limitKw?: number;
  softMarginKw?: number;
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

/**
 * Headroom a restore must clear before the shedding latch releases: the restore
 * margin plus hysteresis, so a plan hovering at the threshold cannot flap the
 * latch between rebuilds. Both terms are fixed — the restore margin was a
 * constructor option that neither factory ever supplied, so it was always 0.2.
 */
export const SHEDDING_CLEAR_THRESHOLD_KW = 0.4;

/** Panic is a hard-cap question, so it is asked against the hard-cap budget. */
const isOverShortfallThreshold = (
  totalKw: number | null,
  shortfallThresholdKw: number,
): boolean => totalKw !== null && totalKw > shortfallThresholdKw;

/**
 * CapacityGuard - State container for capacity management.
 * The Plan (buildDevicePlanSnapshot) is the single decision-maker for shedding.
 * Guard tracks state (sheddingActive, shortfall) and provides shortfall hysteresis.
 */
export default class CapacityGuard {
  private static readonly SHORTFALL_CLEAR_MARGIN_KW = 0.2;
  private static readonly SHORTFALL_CLEAR_SUSTAIN_MS = 60000; // 60 seconds of sustained positive headroom

  private limitKw: number;
  private softMarginKw: number;
  private shortfallClearStartTime: number | null = null;

  // State - updated by Plan
  sheddingActive = false;
  private inShortfall = false;

  // Callbacks
  private onShortfall?: ShortfallCallback;
  private onShortfallCleared?: TriggerCallback;
  private onShortfallAlertCandidate?: ShortfallAlertCandidateCallback;
  private onShortfallAlertConditionCleared?: ShortfallAlertConditionClearedCallback;

  // Providers
  private softLimitProvider?: SoftLimitProvider;

  private structuredLog: CapacityGuardLogger;
  private homeId: HomeId;
  private incidentId: string | null = null;
  private incidentStartMs = 0;
  private shortfallHasCandidates: boolean | null = null;

  constructor(options: CapacityGuardOptions) {
    this.homeId = options.homeId;
    this.limitKw = options.limitKw ?? 10;
    this.softMarginKw = options.softMarginKw ?? 0.2;
    this.structuredLog = options.structuredLog;
    this.onShortfall = options.onShortfall;
    this.onShortfallCleared = options.onShortfallCleared;
    this.onShortfallAlertCandidate = options.onShortfallAlertCandidate;
    this.onShortfallAlertConditionCleared = options.onShortfallAlertConditionCleared;
  }

  // --- Configuration ---

  setLimit(limitKw: number): void {
    this.limitKw = Math.max(0, limitKw);
  }

  setSoftMargin(marginKw: number): void {
    this.softMarginKw = Math.max(0, marginKw);
  }

  setSoftLimitProvider(provider: SoftLimitProvider | undefined): void {
    this.softLimitProvider = provider;
  }

  // --- Limit calculations ---

  /**
   * Returns **two different quantities** depending on wiring, which is why the
   * name is `softLimit` and not one of the canonical ones. With a provider wired
   * it is `capacityPaceKw`, the dynamic hourly threshold. Otherwise it silently
   * substitutes `hourlyAllowanceKWh`, a different quantity that never decays at
   * the hour boundary. The accept test is `typeof === 'number' && >= 0`, which is
   * deliberately *not* a finiteness gate — `Infinity` passes and is returned
   * verbatim, contrary to the boundary rule in the root `AGENTS.md`.
   *
   * A caller cannot tell which quantity it received, and the substitution is not
   * uniformly safer: the static allowance is *stricter* than the pace mid-hour
   * (the pace can sit at several times the allowance while the hour is under-used)
   * and *looser* at the end of it (no drain, and it never reaches 0 on an
   * exhausted hour, where `computeDynamicSoftLimit` returns 0). So a wiring
   * regression silently shifts the limit in both directions, rather than failing
   * loudly.
   *
   * `notes/safe-pace-two-constraints.md` § "Canonical names" is the definition of
   * record and tracks the fix: surface the unresolved state explicitly, and settle
   * the caller contract (fail-closed, matching the stale-meter posture) in the same
   * change. Until then, treat this as unresolved-or-a-pace, never as a known pace.
   *
   * The note's revisit trigger fires on any new caller — add one only deliberately,
   * and note that `flowCards/headroomAndEvSocCards.ts` already consumes it with no
   * fallback of its own and publishes it to a structured log.
   */
  getSoftLimit(): number {
    if (this.softLimitProvider) {
      const dynamic = this.softLimitProvider();
      if (typeof dynamic === 'number' && dynamic >= 0) return dynamic;
    }
    return Math.max(0, this.limitKw - this.softMarginKw);
  }

  // --- State management (called by Plan) ---

  isSheddingActive(): boolean {
    return this.sheddingActive;
  }

  isInShortfall(): boolean {
    return this.inShortfall;
  }

  getCurrentIncidentId(): string | null {
    return this.incidentId;
  }

  /** Latch shedding on. Called by Plan once it has decided to shed. */
  activateShedding(): void {
    this.sheddingActive = true;
  }

  /**
   * Release the shedding latch, but only once `headroomKw` clears
   * `SHEDDING_CLEAR_THRESHOLD_KW` — a plan hovering at the threshold must not
   * flap the latch between rebuilds. A refusal is silent, so callers that need
   * to know what happened re-read `isSheddingActive()`.
   */
  releaseShedding(headroomKw: number): void {
    if (!this.sheddingActive) return;
    if (headroomKw < SHEDDING_CLEAR_THRESHOLD_KW) return;
    this.sheddingActive = false;
  }

  /**
   * Called by Plan after shedding decisions to check/update shortfall state.
   *
   * `totalKw` is the caller's resolved whole-home total (`null` = no
   * trustworthy reading). The guard holds no power of its own: the tracker is
   * the single latch, so the value and its freshness describe one sample
   * instead of two objects that can disagree.
   */
  async checkShortfall(params: {
    /** Whether there are still devices that could be shed. */
    hasCandidates: boolean;
    /** Current kW above the shortfall threshold. */
    deficitKw: number;
    totalKw: number | null;
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
    totalKw: number | null,
    shortfallThresholdKw: number,
    capacityStateSummary: PlanCapacityStateSummary,
  ): Promise<void> {
    this.incidentId = `inc_${randomUUID()}`;
    this.incidentStartMs = Date.now();
    const thresholdW = Math.round(shortfallThresholdKw * 1000);
    const powerW = Math.round((totalKw ?? 0) * 1000);
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
    totalKw: number | null,
  ): Promise<void> {
    const thresholdHeadroom = shortfallThreshold - (totalKw ?? 0);
    if (thresholdHeadroom >= CapacityGuard.SHORTFALL_CLEAR_MARGIN_KW) {
      await this.updateShortfallClearTimer(shortfallThreshold, totalKw);
      return;
    }
    this.resetShortfallClearTimer();
  }

  private async updateShortfallClearTimer(
    shortfallThreshold: number,
    totalKw: number | null,
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
      const powerW = Math.round((totalKw ?? 0) * 1000);
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
