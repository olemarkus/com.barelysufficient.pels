import type { DeviceTransport } from '../../lib/device/deviceTransport';
import type { PowerSource } from '../../lib/power/powerSource';
import { HomeyEnergyPollSource } from '../../lib/power/sources/homeyEnergyPoll';
import type { PowerSamplePipeline } from '../powerSamplePipeline';
import type { StructuredDebugEmitter } from '../../lib/logging/logger';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';

/**
 * The slice of the app this factory reads. Structural rather than `PelsApp` so
 * `setup/` keeps its one-way dependency on the entry point.
 */
export type HomeyEnergyPollSourceHost = {
  readonly timers: TimerRegistry;
  getPowerSource(): PowerSource;
  readonly deviceManager?: Pick<DeviceTransport, 'pollHomePowerW'>;
  getStructuredDebugEmitter(component: 'devices', debugTopic: 'devices'): StructuredDebugEmitter;
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
): HomeyEnergyPollSource => new HomeyEnergyPollSource({
  getPowerSource: () => host.getPowerSource(),
  timers: host.timers,
  pollHomePower: async (authorizeFanOut) => (await host.deviceManager?.pollHomePowerW(authorizeFanOut)) ?? null,
  recordPowerSample: async (sample) => {
    await pipeline.recordPowerSample(sample.powerW, undefined, sample);
  },
  debugStructured: host.getStructuredDebugEmitter('devices', 'devices'),
  error: (...args) => host.error(...args),
});
