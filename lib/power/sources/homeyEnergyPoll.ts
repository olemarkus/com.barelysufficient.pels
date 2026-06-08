import type { HomeyRuntime } from '../../ports/homeyRuntime';
import type { TimerRegistry } from '../../app/timerRegistry';
import type { StructuredDebugEmitter } from '../../logging/logger';

const HOMEY_ENERGY_POLL_INTERVAL_MS = 10_000;

/**
 * Whole-home power source that polls Homey Energy every 10 s when the
 * `power_source` setting is `homey_energy`. Hands each sample to the
 * injected `recordPowerSample(watts)` callback — knows nothing about
 * what the consumer does with it.
 *
 * Lives under `lib/power/sources/` because it produces the whole-home
 * power signal; the per-device shape of devices is irrelevant here.
 * The actual Homey SDK call (`pollHomePower`) is injected so this file
 * does not depend on `lib/device/` (per the power mandate codified in
 * `.dependency-cruiser.cjs`).
 */
export class HomeyEnergyPollSource {
  private pollInterval?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: {
    homey: HomeyRuntime;
    timers: TimerRegistry;
    pollHomePower: () => Promise<number | null | undefined>;
    recordPowerSample: (powerW: number) => Promise<void>;
    debugStructured: StructuredDebugEmitter;
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
    const homePowerW = await this.deps.pollHomePower();
    if (typeof homePowerW === 'number') {
      this.deps.debugStructured({ event: 'homey_energy_poll', homePowerW });
      await this.deps.recordPowerSample(homePowerW);
      return;
    }

    this.deps.debugStructured({ event: 'homey_energy_poll_no_reading' });
  }
}
