type TriggerCallback = () => Promise<void> | void;
type ShortfallCallback = (deficitKw: number) => Promise<void> | void;
type SoftLimitProvider = () => number | null;
type ShortfallThresholdProvider = () => number | null;

export type CapacityGuardOptions = {
  limitKw?: number;
  softMarginKw?: number;
  restoreMarginKw?: number;
  onSheddingStart?: TriggerCallback;
  onSheddingEnd?: TriggerCallback;
  onShortfall?: ShortfallCallback;
  onShortfallCleared?: TriggerCallback;
  log?: (...args: unknown[]) => void;
};

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

  private log?: (...args: unknown[]) => void;

  constructor(options: CapacityGuardOptions = {}) {
    this.limitKw = options.limitKw ?? 10;
    this.softMarginKw = options.softMarginKw ?? 0.2;
    this.restoreMarginKw = options.restoreMarginKw ?? 0.2;
    this.onSheddingStart = options.onSheddingStart;
    this.onSheddingEnd = options.onSheddingEnd;
    this.onShortfall = options.onShortfall;
    this.onShortfallCleared = options.onShortfallCleared;
    this.log = options.log;
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

  /**
   * Called by Plan after making shedding decisions.
   * Updates sheddingActive state and triggers callbacks.
   */
  async setSheddingActive(active: boolean): Promise<void> {
    if (active && !this.sheddingActive) {
      this.sheddingActive = true;
      await this.onSheddingStart?.();
    } else if (!active && this.sheddingActive) {
      this.sheddingActive = false;
      await this.onSheddingEnd?.();
    }
  }

  /**
   * Called by Plan after shedding decisions to check/update shortfall state.
   * @param hasCandidates - Whether there are still devices that could be shed
   * @param deficitKw - Current power deficit (negative headroom)
   */
  async checkShortfall(hasCandidates: boolean, deficitKw: number): Promise<void> {
    const shortfallThreshold = this.getShortfallThreshold();
    const thresholdExceeded = this.mainPowerKw !== null && this.mainPowerKw > shortfallThreshold;

    // Enter shortfall if over threshold AND no candidates left
    if (thresholdExceeded && !hasCandidates && !this.inShortfall) {
      await this.enterShortfall(deficitKw);
      return;
    }

    // Check for shortfall clearing (requires sustained positive headroom)
    if (this.inShortfall) {
      await this.maybeClearShortfall(shortfallThreshold);
    }
  }

  private async enterShortfall(deficitKw: number): Promise<void> {
    this.log?.(`Guard: shortfall detected - no more devices to shed, deficit=${deficitKw.toFixed(2)}kW`);
    this.inShortfall = true;
    this.shortfallClearStartTime = null;
    await this.onShortfall?.(deficitKw);
  }

  private async maybeClearShortfall(shortfallThreshold: number): Promise<void> {
    const thresholdHeadroom = shortfallThreshold - (this.mainPowerKw ?? 0);
    if (thresholdHeadroom >= CapacityGuard.SHORTFALL_CLEAR_MARGIN_KW) {
      await this.updateShortfallClearTimer();
      return;
    }
    this.resetShortfallClearTimer();
  }

  private async updateShortfallClearTimer(): Promise<void> {
    const now = Date.now();
    if (this.shortfallClearStartTime === null) {
      this.shortfallClearStartTime = now;
      this.log?.('Guard: positive headroom detected, waiting for sustained period before clearing shortfall');
      return;
    }
    if (now - this.shortfallClearStartTime >= CapacityGuard.SHORTFALL_CLEAR_SUSTAIN_MS) {
      this.log?.('Guard: shortfall cleared (sustained positive headroom)');
      this.inShortfall = false;
      this.shortfallClearStartTime = null;
      await this.onShortfallCleared?.();
    }
  }

  private resetShortfallClearTimer(): void {
    if (this.shortfallClearStartTime !== null) {
      this.log?.('Guard: headroom dropped, resetting shortfall clear timer');
      this.shortfallClearStartTime = null;
    }
  }
}
