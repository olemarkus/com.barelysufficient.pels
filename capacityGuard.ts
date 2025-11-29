type DesiredState = 'ON' | 'OFF' | 'SHED';

type ShedCallback = (deviceId: string, name: string) => Promise<void> | void;
type TriggerCallback = () => Promise<void> | void;
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
  actuator?: ActuatorCallback;
  intervalMs?: number;
  log?: (...args: any[]) => void;
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
  private onSheddingStart?: TriggerCallback;
  private onSheddingEnd?: TriggerCallback;
  private onDeviceShed?: ShedCallback;
  private actuator?: ActuatorCallback;
  private intervalMs: number;
  private log?: (...args: any[]) => void;
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
    this.controllables.set(deviceId, { name, powerKw, priority, desired: 'ON' });
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

  headroomBand(): 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' {
    const h = this.headroom();
    if (h === null) return 'UNKNOWN';
    if (h >= 1) return 'HIGH';
    if (h >= 0.2) return 'MEDIUM';
    return 'LOW';
  }

  getLastTotalPower(): number | null {
    return this.mainPowerKw;
  }

  getPlanMax(): number {
    return Math.max(0, this.getSoftLimit() - this.planReserveKw);
  }

  private getSoftLimit(): number {
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

  async tick(): Promise<void> {
    if (this.mainPowerKw === null) return;
    const soft = this.getSoftLimit();
    const headroom = soft - this.mainPowerKw;

    if (headroom < 0) {
      this.log?.(`Guard: overshoot detected. total=${this.mainPowerKw.toFixed(2)}kW soft=${soft.toFixed(2)}kW headroom=${headroom.toFixed(2)}kW`);
      await this.shedUntilHealthy(headroom);
    } else if (this.sheddingActive && headroom >= this.restoreMarginKw) {
      this.sheddingActive = false;
      await this.onSheddingEnd?.();
    }
  }

  private async shedUntilHealthy(initialHeadroom: number): Promise<void> {
    let headroom = initialHeadroom;

    const toShed = Array.from(this.controllables.entries())
      .filter(([, c]) => c.desired === 'ON')
      .sort((a, b) => a[1].priority - b[1].priority);

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

    if (this.sheddingActive && headroom >= this.restoreMarginKw) {
      this.sheddingActive = false;
      await this.onSheddingEnd?.();
    }
  }
}
