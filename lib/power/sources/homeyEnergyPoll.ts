import type { PowerSource } from '../powerSource';
import type { TimerRegistry } from '../../utils/timerRegistry';
import type { StructuredDebugEmitter } from '../../logging/logger';

const HOMEY_ENERGY_POLL_INTERVAL_MS = 10_000;
const HOMEY_ENERGY_RESTART_RETRY_TIMER = 'homeyEnergyPollRestartRetry';
const HOMEY_ENERGY_RESTART_RETRY_INITIAL_MS = 1_000;
const HOMEY_ENERGY_RESTART_RETRY_MAX_MS = 60_000;
const HOMEY_ENERGY_RESTART_RETRY_MAX_EXPONENT = 6;

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
  private restartRetryAttempt = 0;

  constructor(private readonly deps: {
    getPowerSource: () => PowerSource;
    timers: TimerRegistry;
    // `authorizeFanOut` lets the read gate its sub-home meter fan-out on THIS
    // poll's liveness — the fan-out fires inside the read, before the discard
    // checks below, so a stale-generation poll must not deliver it.
    pollHomePower: (authorizeFanOut: () => boolean) => Promise<HomeyEnergyPowerSample | null | undefined>;
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
    this.deps.timers.clear(HOMEY_ENERGY_RESTART_RETRY_TIMER);
    let powerSource: PowerSource;
    try {
      powerSource = this.deps.getPowerSource();
    } catch (error) {
      this.deps.error('Homey Energy poll source read failed; retrying', error);
      this.scheduleRestartRetry();
      return;
    }
    this.restartRetryAttempt = 0;
    if (powerSource !== 'homey_energy') return;

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

  /** Invalidate an old-selection poll before queued settings work restarts it. */
  invalidate(): void {
    this.pollGeneration += 1;
  }

  stop(): void {
    this.pollGeneration += 1;
    this.deps.timers.clear(HOMEY_ENERGY_RESTART_RETRY_TIMER);
    this.restartRetryAttempt = 0;
    if (this.pollInterval) {
      this.deps.timers.clear('homeyEnergyPoll');
      this.pollInterval = undefined;
    }
  }

  private scheduleRestartRetry(): void {
    const exponent = Math.min(
      this.restartRetryAttempt,
      HOMEY_ENERGY_RESTART_RETRY_MAX_EXPONENT,
    );
    const delayMs = Math.min(
      HOMEY_ENERGY_RESTART_RETRY_INITIAL_MS * (2 ** exponent),
      HOMEY_ENERGY_RESTART_RETRY_MAX_MS,
    );
    this.restartRetryAttempt = Math.min(
      this.restartRetryAttempt + 1,
      HOMEY_ENERGY_RESTART_RETRY_MAX_EXPONENT,
    );
    this.deps.timers.registerTimeout(
      HOMEY_ENERGY_RESTART_RETRY_TIMER,
      setTimeout(() => {
        this.deps.timers.clear(HOMEY_ENERGY_RESTART_RETRY_TIMER);
        this.start();
      }, delayMs),
    );
  }

  async pollNow(): Promise<void> {
    const generation = this.pollGeneration;
    // Authorize the sub-home meter fan-out (dispatched inside the read, before the
    // discard checks below) only while THIS poll is still current: same generation
    // AND source unchanged. Without it a stale-generation poll's fan-out could
    // deliver an out-of-order sub-meter sample that resolves after its replacement.
    const authorizeFanOut = (): boolean => (
      generation === this.pollGeneration && this.deps.getPowerSource() === 'homey_energy'
    );
    const sample = await this.deps.pollHomePower(authorizeFanOut);
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
