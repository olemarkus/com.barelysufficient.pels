import type Homey from 'homey';
import type { DeviceManager } from '../core/deviceManager';
import type { TimerRegistry } from './timerRegistry';

const HOMEY_ENERGY_POLL_INTERVAL_MS = 10_000;

export class AppHomeyEnergyHelpers {
  private pollInterval?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: {
    homey: Homey.App['homey'];
    timers: TimerRegistry;
    getDeviceManager: () => DeviceManager | undefined;
    recordPowerSample: (powerW: number) => Promise<void>;
    logDebug: (topic: 'devices', ...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  }) {}

  start(): void {
    if (this.pollInterval) {
      this.deps.timers.clear('homeyEnergyPoll');
      this.pollInterval = undefined;
    }
    if (this.deps.homey.settings.get('power_source') !== 'homey_energy') return;

    this.pollNow()
      .catch((error) => this.deps.error('Homey Energy initial poll failed', error));

    this.pollInterval = this.deps.timers.registerInterval('homeyEnergyPoll', setInterval(() => {
      this.pollNow()
        .catch((error) => this.deps.error('Homey Energy poll failed', error));
    }, HOMEY_ENERGY_POLL_INTERVAL_MS));
  }

  restart(): void {
    this.start();
  }

  stop(): void {
    if (!this.pollInterval) return;
    this.deps.timers.clear('homeyEnergyPoll');
    this.pollInterval = undefined;
  }

  async pollNow(): Promise<void> {
    const homePowerW = await this.deps.getDeviceManager()?.pollHomePowerW();
    if (typeof homePowerW === 'number') {
      this.deps.logDebug('devices', `Homey Energy poll: ${homePowerW}W`);
      await this.deps.recordPowerSample(homePowerW);
      return;
    }

    this.deps.logDebug('devices', 'Homey Energy poll: no cumulative power reading available');
  }
}
