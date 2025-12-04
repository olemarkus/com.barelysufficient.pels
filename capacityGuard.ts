type DesiredState = 'ON' | 'OFF' | 'SHED';

type ShedCallback = (deviceId: string, name: string) => Promise<void> | void;
type TriggerCallback = () => Promise<void> | void;
type ShortfallCallback = (deficitKw: number) => Promise<void> | void;
type ActuatorCallback = (deviceId: string, name: string) => Promise<void> | void;
type SoftLimitProvider = () => number | null;

export interface CapacityGuardOptions {
  limitKw?: number;
  softMarginKw?: number;
  restoreMarginKw?: number;
  planReserveKw?: number;
  dryRun?: boolean;
  onSheddingStart?: TriggerCallback;
  onSheddingEnd?: TriggerCallback;
  onDeviceShed?: ShedCallback;
  onShortfall?: ShortfallCallback;
  onShortfallCleared?: TriggerCallback;
  actuator?: ActuatorCallback;
  intervalMs?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic logging callbacks
  log?: (...args: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic logging callbacks
  errorLog?: (...args: any[]) => void;
}

export default class CapacityGuard {
  private limitKw: number;
  private softMarginKw: number;
  private restoreMarginKw: number;
  private planReserveKw: number;
  private dryRun: boolean;
  private mainPowerKw: number | null = null;
  private allocatedKw = 0;
  private controllables: Map<string, { name: string; powerKw: number; priority: number; desired: DesiredState }> = new Map();
  private interval: NodeJS.Timeout | null = null;
  private sheddingActive = false;
  private inShortfall = false;
  private onSheddingStart?: TriggerCallback;
  private onSheddingEnd?: TriggerCallback;
  private onDeviceShed?: ShedCallback;
  private onShortfall?: ShortfallCallback;
  private onShortfallCleared?: TriggerCallback;
  private actuator?: ActuatorCallback;
  private intervalMs: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic logging callbacks
  private log?: (...args: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic logging callbacks
  private errorLog?: (...args: any[]) => void;
  private softLimitProvider?: SoftLimitProvider;

  constructor(options: CapacityGuardOptions = {}) {
    this.limitKw = options.limitKw ?? 10;
    this.softMarginKw = options.softMarginKw ?? 0.2;
    this.restoreMarginKw = options.restoreMarginKw ?? 0.2;
    this.planReserveKw = options.planReserveKw ?? 0;
    this.dryRun = options.dryRun ?? true;
    this.onSheddingStart = options.onSheddingStart;
    this.onSheddingEnd = options.onSheddingEnd;
    this.onDeviceShed = options.onDeviceShed;
    this.onShortfall = options.onShortfall;
    this.onShortfallCleared = options.onShortfallCleared;
    this.actuator = options.actuator;
    this.intervalMs = options.intervalMs ?? 3000;
    this.log = options.log;
    this.errorLog = options.errorLog;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.tick().catch((err) => this.errorLog?.('Capacity guard tick failed', err));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  setLimit(limitKw: number): void {
    this.limitKw = Math.max(0, limitKw);
  }

  setSoftMargin(marginKw: number): void {
    this.softMarginKw = Math.max(0, marginKw);
  }

  setSoftLimitProvider(provider: SoftLimitProvider | undefined): void {
    this.softLimitProvider = provider;
  }

  setDryRun(dryRun: boolean, actuator?: ActuatorCallback): void {
    this.dryRun = dryRun;
    if (actuator) this.actuator = actuator;
  }

  reportTotalPower(powerKw: number): void {
    if (!Number.isFinite(powerKw)) return;
    this.mainPowerKw = powerKw;
  }

  requestOn(deviceId: string, name: string, powerKw: number, priority = 100): boolean {
    if (!Number.isFinite(powerKw) || powerKw < 0) return false;
    const planMax = this.getPlanMax();
    if (this.allocatedKw + powerKw > planMax) {
      return false;
    }
    this.controllables.set(deviceId, {
      name, powerKw, priority, desired: 'ON',
    });
    this.recomputeAllocation();
    return true;
  }

  forceOff(deviceId: string): void {
    const device = this.controllables.get(deviceId);
    if (!device) return;
    device.desired = 'OFF';
    this.controllables.set(deviceId, device);
    this.recomputeAllocation();
  }

  hasCapacity(requiredKw: number): boolean {
    if (!Number.isFinite(requiredKw) || requiredKw < 0) return false;
    return this.allocatedKw + requiredKw <= this.getPlanMax();
  }

  headroom(): number | null {
    if (this.mainPowerKw === null) return null;
    return this.getSoftLimit() - this.mainPowerKw;
  }

  isSheddingActive(): boolean {
    return this.sheddingActive;
  }

  getHeadroom(): number | null {
    return this.headroom();
  }

  getLastTotalPower(): number | null {
    return this.mainPowerKw;
  }

  getPlanMax(): number {
    return Math.max(0, this.getSoftLimit() - this.planReserveKw);
  }

  getSoftLimit(): number {
    if (this.softLimitProvider) {
      const dynamic = this.softLimitProvider();
      if (typeof dynamic === 'number' && dynamic >= 0) return dynamic;
    }
    return Math.max(0, this.limitKw - this.softMarginKw);
  }

  private recomputeAllocation(): void {
    let total = 0;
    this.controllables.forEach((c) => {
      if (c.desired === 'ON') total += c.powerKw;
    });
    this.allocatedKw = total;
  }

  /**
   * Replace the controllable set with a supplied list (used by app snapshot sync).
   */
  setControllables(devices: Array<{ id: string; name: string; powerKw: number; priority: number; on?: boolean }>): void {
    this.controllables.clear();
    for (const dev of devices) {
      if (!dev || !dev.id) continue;
      const power = Number.isFinite(dev.powerKw) && dev.powerKw >= 0 ? dev.powerKw : 0;
      const priority = Number.isFinite(dev.priority) ? dev.priority : 100;
      const desired: DesiredState = dev.on ? 'ON' : 'OFF';
      this.controllables.set(dev.id, {
        name: dev.name,
        powerKw: power,
        priority,
        desired,
      });
    }
    this.recomputeAllocation();
  }

  async tick(): Promise<void> {
    if (this.mainPowerKw === null) return;
    const soft = this.getSoftLimit();
    const headroom = soft - this.mainPowerKw;

    if (headroom < 0) {
      this.log?.(`Guard: overshoot detected. total=${this.mainPowerKw.toFixed(2)}kW soft=${soft.toFixed(2)}kW headroom=${headroom.toFixed(2)}kW`);
      // Ensure sheddingActive is set even if we can't shed anything (uncontrolled load exceeds limit)
      if (!this.sheddingActive) {
        this.sheddingActive = true;
        await this.onSheddingStart?.();
      }
      await this.shedUntilHealthy(headroom);
    } else {
      // Headroom is positive - clear shortfall if we were in one
      if (this.inShortfall) {
        this.log?.('Guard: shortfall cleared (headroom now positive)');
        this.inShortfall = false;
        await this.onShortfallCleared?.();
      }
      if (this.sheddingActive && headroom >= this.restoreMarginKw) {
        this.sheddingActive = false;
        await this.onSheddingEnd?.();
      }
    }
  }

  private async shedUntilHealthy(initialHeadroom: number): Promise<void> {
    let headroom = initialHeadroom;

    // Sort by priority descending: higher number = less important = shed first
    // Priority 1 = most important = shed last
    const toShed = Array.from(this.controllables.entries())
      .filter(([, c]) => c.desired === 'ON')
      .sort((a, b) => b[1].priority - a[1].priority);

    // Log the shed order for debugging
    this.log?.(`Guard: shed candidates (least→most important): ${toShed.map(([, c]) => `${c.name}(p${c.priority})`).join(', ')}`);

    let shedThisTick = false;
    for (const [deviceId, device] of toShed) {
      if (headroom >= 0) break;
      device.desired = 'SHED';
      this.controllables.set(deviceId, device);
      this.recomputeAllocation();
      shedThisTick = true;
      this.log?.(`Guard: shedding ${device.name} (${device.powerKw.toFixed(2)}kW) dryRun=${this.dryRun}`);
      await this.onDeviceShed?.(deviceId, device.name);
      if (!this.dryRun && this.actuator) {
        await this.actuator(deviceId, device.name);
      }
      headroom += device.powerKw;
    }

    if (shedThisTick && !this.sheddingActive) {
      this.sheddingActive = true;
      await this.onSheddingStart?.();
    }

    // Detect shortfall: overshoot remains after shedding all available devices
    // This happens when uncontrolled load exceeds our limit or all controllables are already shed
    const remainingToShed = Array.from(this.controllables.values()).filter((c) => c.desired === 'ON').length;
    const nowInShortfall = headroom < 0 && remainingToShed === 0;
    if (nowInShortfall && !this.inShortfall) {
      const deficitKw = -headroom;
      this.log?.(`Guard: shortfall detected - no more devices to shed, deficit=${deficitKw.toFixed(2)}kW`);
      this.inShortfall = true;
      await this.onShortfall?.(deficitKw);
    } else if (this.inShortfall && headroom >= 0) {
      // Shortfall clears when we have positive headroom (power dropped or limit increased)
      this.log?.('Guard: shortfall cleared');
      this.inShortfall = false;
      await this.onShortfallCleared?.();
    }

    // Only end shedding if headroom is truly positive with margin
    // Don't end shedding just because we ran out of things to shed
    if (this.sheddingActive && headroom >= this.restoreMarginKw) {
      this.sheddingActive = false;
      await this.onSheddingEnd?.();
    }
  }

  isInShortfall(): boolean {
    return this.inShortfall;
  }
}
