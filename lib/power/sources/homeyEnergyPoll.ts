import type { PowerSource } from '../powerSource';
import type { TimerRegistry } from '../../utils/timerRegistry';
import type { StructuredDebugEmitter } from '../../logging/logger';

const HOMEY_ENERGY_POLL_INTERVAL_MS = 10_000;

export type HomeyEnergyPowerSample = {
  powerW: number;
  generationW?: number;
};

/**
 * Whole-home power source that polls Homey Energy every 10 s when the
 * `power_source` setting is `homey_energy`. Hands each co-temporal net power
 * and generation sample to the injected callback — knows nothing about what
 * the consumer does with it.
 *
 * Lives under `lib/power/sources/` because it produces the whole-home
 * power signal; the per-device shape of devices is irrelevant here.
 * The actual Homey SDK call (`pollHomePower`) is injected so this file
 * does not depend on `lib/device/` (per the power mandate codified in
 * `.dependency-cruiser.cjs`).
 */
export class HomeyEnergyPollSource {
  private pollInterval?: ReturnType<typeof setInterval>;
  // Bumped on every (re)start. A poll that was already awaiting the SDK when
  // the configuration changed (e.g. a new whole-home meter selection triggers
  // a restart) resolved its inputs before the read — recording it afterwards
  // would write the previous meter's watts over the fresh sample, so stale
  // generations are discarded instead.
  private pollGeneration = 0;

  constructor(private readonly deps: {
    getPowerSource: () => PowerSource;
    timers: TimerRegistry;
    pollHomePower: () => Promise<HomeyEnergyPowerSample | null | undefined>;
    recordPowerSample: (sample: HomeyEnergyPowerSample) => Promise<void>;
    debugStructured: StructuredDebugEmitter;
    error: (...args: unknown[]) => void;
  }) {}

  start(): void {
    this.pollGeneration += 1;
    if (this.pollInterval) {
      this.deps.timers.clear('homeyEnergyPoll');
      this.pollInterval = undefined;
    }
    if (this.deps.getPowerSource() !== 'homey_energy') return;

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
    const generation = this.pollGeneration;
    const sample = await this.deps.pollHomePower();
    if (generation !== this.pollGeneration) {
      this.deps.debugStructured({ event: 'homey_energy_poll_discarded_stale' });
      return;
    }
    if (this.deps.getPowerSource() !== 'homey_energy') return;

    if (sample) {
      this.deps.debugStructured({
        event: 'homey_energy_poll',
        homePowerW: sample.powerW,
        generationW: sample.generationW,
      });
      await this.deps.recordPowerSample(sample);
      return;
    }

    this.deps.debugStructured({ event: 'homey_energy_poll_no_reading' });
  }
}
