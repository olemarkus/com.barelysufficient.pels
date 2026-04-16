import { randomUUID } from 'node:crypto';
import type { Logger as PinoLogger } from '../logging/logger';
import {
  buildNullCapacityStateSummary,
  type PlanCapacityStateSummary,
} from './capacityStateSummary';

type TriggerCallback = () => Promise<void> | void;
type ShortfallCallback = (deficitKw: number) => Promise<void> | void;
type SoftLimitProvider = () => number | null;
type ShortfallThresholdProvider = () => number | null;
type CapacityStateSummaryProvider = () => PlanCapacityStateSummary;

export type CapacityGuardOptions = {
  limitKw?: number;
  softMarginKw?: number;
  restoreMarginKw?: number;
  onSheddingStart?: TriggerCallback;
  onSheddingEnd?: TriggerCallback;
  onShortfall?: ShortfallCallback;
  onShortfallCleared?: TriggerCallback;
  structuredLog?: PinoLogger;
  capacityStateSummaryProvider?: CapacityStateSummaryProvider;
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

  // Providers
  private softLimitProvider?: SoftLimitProvider;
  private shortfallThresholdProvider?: ShortfallThresholdProvider;
  private capacityStateSummaryProvider: CapacityStateSummaryProvider;

  private structuredLog?: PinoLogger;
  private incidentId: string | null = null;
  private incidentStartMs = 0;

  constructor(options: CapacityGuardOptions = {}) {
    this.limitKw = options.limitKw ?? 10;
    this.softMarginKw = options.softMarginKw ?? 0.2;
    this.structuredLog = options.structuredLog;
    this.restoreMarginKw = options.restoreMarginKw ?? 0.2;
    this.onSheddingStart = options.onSheddingStart;
    this.onSheddingEnd = options.onSheddingEnd;
    this.onShortfall = options.onShortfall;
    this.onShortfallCleared = options.onShortfallCleared;
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
  }

  getLastTotalPower(): number | null {
    return this.mainPowerKw;
  }

  // --- Limit calculations ---

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
    const shortfallThreshold = this.getShortfallThreshold();
    const thresholdExceeded = this.mainPowerKw !== null && this.mainPowerKw > shortfallThreshold;

    // Enter shortfall if over threshold AND no candidates left
    if (thresholdExceeded && !hasCandidates && !this.inShortfall) {
      await this.enterShortfall(deficitKw, capacityStateSummary);
      return;
    }

    // Check for shortfall clearing (requires sustained positive headroom)
    if (this.inShortfall) {
      await this.maybeClearShortfall(shortfallThreshold);
    }
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
    this.structuredLog?.info({
      event: 'hard_cap_shortfall_detected',
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
      this.structuredLog?.info({
        event: 'hard_cap_shortfall_recovery_started',
        incidentId: this.incidentId,
        sustainRequiredMs: CapacityGuard.SHORTFALL_CLEAR_SUSTAIN_MS,
      });
      return;
    }
    if (now - this.shortfallClearStartTime >= CapacityGuard.SHORTFALL_CLEAR_SUSTAIN_MS) {
      const powerW = Math.round((this.mainPowerKw ?? 0) * 1000);
      const thresholdW = Math.round(shortfallThreshold * 1000);
      this.structuredLog?.info({
        event: 'hard_cap_shortfall_recovered',
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
      this.structuredLog?.info({
        event: 'hard_cap_shortfall_recovery_reset',
        incidentId: this.incidentId,
      });
      this.shortfallClearStartTime = null;
    }
  }
}
