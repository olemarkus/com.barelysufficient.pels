import type { PowerSource } from '../powerSource';
import type { TimerRegistry } from '../../utils/timerRegistry';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { HomeMeterRequest, LiveMeterReadings } from '../../ports/homeMeterReadings';

const HOMEY_ENERGY_POLL_INTERVAL_MS = 10_000;
const HOMEY_ENERGY_RESTART_RETRY_TIMER = 'homeyEnergyPollRestartRetry';
const HOMEY_ENERGY_RESTART_RETRY_INITIAL_MS = 1_000;
const HOMEY_ENERGY_RESTART_RETRY_MAX_MS = 60_000;
const HOMEY_ENERGY_RESTART_RETRY_MAX_EXPONENT = 6;

/**
 * Whole-home power source that polls Homey Energy every 10 s when the
 * `power_source` setting is `homey_energy`. Each poll reads every home's meter
 * from one report and hands the readings to the homes' request, which routes
 * them; this source knows nothing about which home a meter belongs to.
 *
 * Lives under `lib/power/sources/` because it produces the whole-home
 * power signal; the per-device shape of devices is irrelevant here.
 * The actual Homey SDK call (`readMeters`) is injected so this file
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
    /** This poll's meters, and where their readings go (`HomeMeters.request`). */
    requestHomeMeters: () => HomeMeterRequest;
    /** One live read of those meters; null when the read failed or nothing can read yet. */
    readMeters: (meterDeviceIds: readonly string[]) => Promise<LiveMeterReadings | null>;
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
    // The meters are captured before the read and every home's reading is
    // routed after the checks below, so a poll that went stale (a new meter
    // selection or power source restarted the source mid-read) delivers to no
    // home at all, Main or sub-home.
    const request = this.deps.requestHomeMeters();
    const readings = await this.deps.readMeters(request.meterDeviceIds);
    if (generation !== this.pollGeneration) {
      this.deps.debugStructured({ event: 'homey_energy_poll_discarded_stale' });
      return;
    }
    if (this.deps.getPowerSource() !== 'homey_energy') return;

    if (readings) {
      await request.record(readings);
      return;
    }

    this.deps.debugStructured({ event: 'homey_energy_poll_no_reading' });
  }
}
