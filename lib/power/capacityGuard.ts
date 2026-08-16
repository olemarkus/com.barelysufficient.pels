import { randomUUID } from 'node:crypto';
import type { Logger as PinoLogger } from '../logging/logger';
import { getLogger } from '../logging/logger';
import type { HomeId } from '../utils/settingsKeys';

const moduleLogger = getLogger('power/capacity-guard');
import {
  buildNullCapacityStateSummary,
  type PlanCapacityStateSummary,
} from './capacityStateSummary';

type TriggerCallback = () => Promise<void> | void;
type ShortfallCallback = (deficitKw: number) => Promise<void> | void;
type ShortfallAlertCandidateCallback = (candidate: CapacityShortfallAlertCandidate) => void;
type ShortfallAlertConditionClearedCallback = () => void;
type SoftLimitProvider = () => number | null;
type ShortfallThresholdProvider = () => number | null;
type CapacityStateSummaryProvider = () => PlanCapacityStateSummary;
type CapacityGuardLogger = Pick<PinoLogger, 'info'>;

export type CapacityGuardOptions = {
  /**
   * Stable identity of the capacity controller that owns this guard.
   * Required so every hard-cap incident record is attributable.
   */
  homeId: HomeId;
  limitKw?: number;
  softMarginKw?: number;
  restoreMarginKw?: number;
  onSheddingStart?: TriggerCallback;
  onSheddingEnd?: TriggerCallback;
  onShortfall?: ShortfallCallback;
  onShortfallCleared?: TriggerCallback;
  onShortfallAlertCandidate?: ShortfallAlertCandidateCallback;
  onShortfallAlertConditionCleared?: ShortfallAlertConditionClearedCallback;
  structuredLog?: CapacityGuardLogger;
  capacityStateSummaryProvider?: CapacityStateSummaryProvider;
};

export type CapacityShortfallAlertCandidate = {
  incidentId: string;
  deficitKw: number;
  detectedAtMs: number;
};

const SHEDDING_CLEAR_HYSTERESIS_KW = 0.2;

export function getSheddingClearThresholdKw(restoreMarginKw: number): number {
  return restoreMarginKw + SHEDDING_CLEAR_HYSTERESIS_KW;
}

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
  private restoreMarginKw: number;
  private mainPowerKw: number | null = null;
  private shortfallClearStartTime: number | null = null;

  // State - updated by Plan
  sheddingActive = false;
  private inShortfall = false;

  // Callbacks
  private onSheddingStart?: TriggerCallback;
  private onSheddingEnd?: TriggerCallback;
  private onShortfall?: ShortfallCallback;
  private onShortfallCleared?: TriggerCallback;
  private onShortfallAlertCandidate?: ShortfallAlertCandidateCallback;
  private onShortfallAlertConditionCleared?: ShortfallAlertConditionClearedCallback;

  // Providers
  private softLimitProvider?: SoftLimitProvider;
  private shortfallThresholdProvider?: ShortfallThresholdProvider;
  private capacityStateSummaryProvider: CapacityStateSummaryProvider;

  private structuredLog?: CapacityGuardLogger;
  private homeId: HomeId;
  private incidentId: string | null = null;
  private incidentStartMs = 0;
  private shortfallHasCandidates: boolean | null = null;

  constructor(options: CapacityGuardOptions) {
    this.homeId = options.homeId;
    this.limitKw = options.limitKw ?? 10;
    this.softMarginKw = options.softMarginKw ?? 0.2;
    this.structuredLog = options.structuredLog;
    this.restoreMarginKw = options.restoreMarginKw ?? 0.2;
    this.onSheddingStart = options.onSheddingStart;
    this.onSheddingEnd = options.onSheddingEnd;
    this.onShortfall = options.onShortfall;
    this.onShortfallCleared = options.onShortfallCleared;
    this.onShortfallAlertCandidate = options.onShortfallAlertCandidate;
    this.onShortfallAlertConditionCleared = options.onShortfallAlertConditionCleared;
    this.capacityStateSummaryProvider = options.capacityStateSummaryProvider
      ?? buildNullCapacityStateSummary;
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

  setShortfallThresholdProvider(provider: ShortfallThresholdProvider | undefined): void {
    this.shortfallThresholdProvider = provider;
  }

  // --- Power tracking ---

  reportTotalPower(powerKw: number): void {
    if (!Number.isFinite(powerKw)) return;
    this.mainPowerKw = powerKw;
    if (this.shortfallHasCandidates === false && !this.isShortfallAlertConditionActive()) {
      this.onShortfallAlertConditionCleared?.();
    }
  }

  getLastTotalPower(): number | null {
    return this.mainPowerKw;
  }

  /**
   * Whether this home has a meter measurement to plan from at all.
   *
   * False only before the meter's first reading, and again after an in-place
   * meter swap (`resetLastTotalPower`) until the new meter reports. It is NOT a
   * freshness question — an old reading is still a measurement, and what a
   * doubtful one means is decided here in `lib/power`, never by a consumer.
   *
   * The planner does not build a plan while this is false: there is nothing to
   * plan from, and modelling that absence downstream would push a nullable or a
   * `kind: 'unknown'` into every consumer of a value that is otherwise always
   * trustworthy (root `AGENTS.md` → "Clean and trusted interfaces between
   * layers"). Gating is the alternative to that absence.
   */
  hasPowerMeasurement(): boolean {
    return this.mainPowerKw !== null;
  }

  /**
   * Clear the last observed total power back to "no sample yet". A per-home
   * capacity bundle (multi-home R7b) calls this on an in-place meter swap so a
   * rebuild before the NEW meter's first reading cannot shed/restore on the
   * PREVIOUS meter's stale load. The main home never invokes it.
   *
   * Since the build gate this is stronger than "`headroom()` reports null":
   * `hasPowerMeasurement()` goes false with it, so the bundle builds no plan at
   * all until the new meter reports.
   */
  resetLastTotalPower(): void {
    this.mainPowerKw = null;
    if (this.shortfallHasCandidates === false) {
      this.onShortfallAlertConditionCleared?.();
    }
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

  getShortfallThreshold(): number {
    if (this.shortfallThresholdProvider) {
      const threshold = this.shortfallThresholdProvider();
      if (typeof threshold === 'number' && threshold >= 0) return threshold;
    }
    // Shortfall (panic mode) should trigger at the hard cap, not the soft limit.
    // The soft limit (with margin) is for shedding decisions, but panic is only
    // when we actually exceed the contracted grid capacity limit.
    return this.limitKw;
  }

  headroom(): number | null {
    if (this.mainPowerKw === null) return null;
    return this.getSoftLimit() - this.mainPowerKw;
  }

  getHeadroom(): number | null {
    return this.headroom();
  }

  getRestoreMargin(): number {
    return this.restoreMarginKw;
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

  /**
   * Called by Plan after making shedding decisions.
   * Updates sheddingActive state and triggers callbacks.
   */
  async setSheddingActive(active: boolean, clearHeadroomKw?: number | null): Promise<void> {
    if (active && !this.sheddingActive) {
      this.sheddingActive = true;
      await this.onSheddingStart?.();
      return;
    }
    if (!active && this.sheddingActive) {
      const headroom = clearHeadroomKw ?? this.headroom();
      const clearThreshold = getSheddingClearThresholdKw(this.restoreMarginKw);
      if (headroom !== null && headroom < clearThreshold) {
        return;
      }
      this.sheddingActive = false;
      await this.onSheddingEnd?.();
    }
  }

  /**
   * Called by Plan after shedding decisions to check/update shortfall state.
   * @param hasCandidates - Whether there are still devices that could be shed
   * @param deficitKw - Current kW above the shortfall threshold
   */
  async checkShortfall(
    hasCandidates: boolean,
    deficitKw: number,
    capacityStateSummary?: PlanCapacityStateSummary,
  ): Promise<void> {
    this.shortfallHasCandidates = hasCandidates;
    const shortfallThreshold = this.getShortfallThreshold();
    const thresholdExceeded = this.mainPowerKw !== null && this.mainPowerKw > shortfallThreshold;
    const alertConditionActive = thresholdExceeded && !hasCandidates;

    // Enter shortfall if over threshold AND no candidates left
    const enterPromise = alertConditionActive && !this.inShortfall
      ? this.enterShortfall(deficitKw, capacityStateSummary)
      : null;
    this.publishShortfallAlertCondition(alertConditionActive, deficitKw);
    await enterPromise;

    // Check for shortfall clearing (requires sustained positive headroom)
    if (this.inShortfall) {
      await this.maybeClearShortfall(shortfallThreshold);
    }
  }

  public isShortfallAlertConditionActive(): boolean {
    return this.shortfallHasCandidates === false
      && this.mainPowerKw !== null
      && this.mainPowerKw > this.getShortfallThreshold();
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
    capacityStateSummary?: PlanCapacityStateSummary,
  ): Promise<void> {
    this.incidentId = `inc_${randomUUID()}`;
    this.incidentStartMs = Date.now();
    const thresholdW = Math.round(this.getShortfallThreshold() * 1000);
    const powerW = Math.round((this.mainPowerKw ?? 0) * 1000);
    const summary = capacityStateSummary ?? this.capacityStateSummaryProvider();
    (this.structuredLog ?? moduleLogger).info({
      event: 'hard_cap_shortfall_detected',
      homeId: this.homeId,
      incidentId: this.incidentId,
      powerW,
      thresholdW,
      headroomW: thresholdW - powerW,
      excessW: powerW - thresholdW,
      ...summary,
    });
    this.inShortfall = true;
    this.shortfallClearStartTime = null;
    await this.onShortfall?.(deficitKw);
  }

  private async maybeClearShortfall(shortfallThreshold: number): Promise<void> {
    const thresholdHeadroom = shortfallThreshold - (this.mainPowerKw ?? 0);
    if (thresholdHeadroom >= CapacityGuard.SHORTFALL_CLEAR_MARGIN_KW) {
      await this.updateShortfallClearTimer(shortfallThreshold);
      return;
    }
    this.resetShortfallClearTimer();
  }

  private async updateShortfallClearTimer(shortfallThreshold: number): Promise<void> {
    const now = Date.now();
    if (this.shortfallClearStartTime === null) {
      this.shortfallClearStartTime = now;
      (this.structuredLog ?? moduleLogger).info({
        event: 'hard_cap_shortfall_recovery_started',
        homeId: this.homeId,
        incidentId: this.incidentId,
        sustainRequiredMs: CapacityGuard.SHORTFALL_CLEAR_SUSTAIN_MS,
      });
      return;
    }
    if (now - this.shortfallClearStartTime >= CapacityGuard.SHORTFALL_CLEAR_SUSTAIN_MS) {
      const powerW = Math.round((this.mainPowerKw ?? 0) * 1000);
      const thresholdW = Math.round(shortfallThreshold * 1000);
      (this.structuredLog ?? moduleLogger).info({
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
      (this.structuredLog ?? moduleLogger).info({
        event: 'hard_cap_shortfall_recovery_reset',
        homeId: this.homeId,
        incidentId: this.incidentId,
      });
      this.shortfallClearStartTime = null;
    }
  }
}
