import type { PowerSource } from '../../lib/power/powerSource';
import { HomeyEnergyPollSource } from '../../lib/power/sources/homeyEnergyPoll';
import type { PowerSamplePipeline } from '../powerSamplePipeline';
import { getDebugEmitter } from '../../lib/logging/logger';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import { HomeMeters, type SubHomeMeters } from '../../lib/home/homeMeters';

// The snapshot refresh reads Main by the same rule as this poll.
export { resolveMainMeterRead } from '../../lib/home/homeMeters';
import type { MainMeterSelectionSettings } from '../../lib/home/mainMeterSelection';
import type { LiveMeterReadings } from '../../lib/ports/homeMeterReadings';

/**
 * The slice of the app this factory reads. Structural rather than `PelsApp` so
 * `setup/` keeps its one-way dependency on the entry point.
 */
export type HomeyEnergyPollSourceHost = {
  readonly timers: TimerRegistry;
  readonly homey: { readonly settings: MainMeterSelectionSettings };
  getPowerSource(): PowerSource;
  readonly deviceManager?: { readMeters(meterDeviceIds: readonly string[]): Promise<LiveMeterReadings | null> };
  /** The sub-homes, once the registry exists. */
  getSubHomeMeters(): SubHomeMeters | undefined;
  error(...args: unknown[]): void;
};

/**
 * Boot wiring for the whole-home power poll (`power_source = homey_energy`).
 *
 * Moved out of `app.ts` per `setup/AGENTS.md`, and paired with
 * `createGenerationPollSource`: the two sources are complementary — exactly one
 * runs for any configured source — so they are constructed by sibling factories
 * rather than one inline and one extracted.
 *
 * Every host field is read lazily inside a closure, so this may be constructed
 * during `PelsApp` field initialisation before `deviceManager` exists.
 */
export const createHomeyEnergyPollSource = (
  host: HomeyEnergyPollSourceHost,
  pipeline: Pick<PowerSamplePipeline, 'recordPowerSample'>,
): HomeyEnergyPollSource => {
  const homeMeters = new HomeMeters(
    host.homey.settings,
    async (sample) => {
      await pipeline.recordPowerSample(sample.powerW, undefined, sample);
    },
    () => host.getSubHomeMeters(),
  );
  return new HomeyEnergyPollSource({
    getPowerSource: () => host.getPowerSource(),
    timers: host.timers,
    requestHomeMeters: () => homeMeters.request(),
    readMeters: async (meterDeviceIds) => (await host.deviceManager?.readMeters(meterDeviceIds)) ?? null,
    debugStructured: getDebugEmitter('devices', 'devices'),
    error: (...args) => host.error(...args),
  });
};
