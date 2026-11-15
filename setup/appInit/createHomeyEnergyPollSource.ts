import { readMainFusePhaseSource } from '../../lib/power/mainFusePhaseSource';
import type { MainFusePhaseCapabilities } from '../../packages/shared-domain/src/settings/mainFusePhaseSource';
import type { PowerSource } from '../../lib/power/powerSource';
import { HomeyEnergyPollSource } from '../../lib/power/sources/homeyEnergyPoll';
import type { PowerSamplePipeline } from '../powerSamplePipeline';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import { HomeMeters, type SubHomeMeters } from '../../lib/home/homeMeters';

// The snapshot refresh reads Main by the same rule as this poll.
export { resolveMainMeterRead } from '../../lib/home/homeMeters';
// Re-exported so `app.ts` constructs the store this poll fills without another
// module dependency (its `import-x/max-dependencies` ceiling is a ratchet).
export { MeterMonthlyPeaks } from '../../lib/power/meterMonthlyPeak';
import type { MainMeterSelectionSettings } from '../../lib/home/mainMeterSelection';
import type { LiveMeterReadings, MeterMonthlyPeakRead, MeterPhasesRead } from '../../lib/ports/homeMeterReadings';
import type { MeterMonthlyPeaks } from '../../lib/power/meterMonthlyPeak';
import type { PhaseReadingTracker } from '../../lib/power/phaseReading';

/**
 * The slice of the app this factory reads. Structural rather than `PelsApp` so
 * `setup/` keeps its one-way dependency on the entry point.
 */
export type HomeyEnergyPollSourceHost = {
  readonly timers: TimerRegistry;
  readonly homey: { readonly settings: MainMeterSelectionSettings };
  getPowerSource(): PowerSource;
  readonly deviceManager?: {
    readMeters(meterDeviceIds: readonly string[]): Promise<LiveMeterReadings | null>;
    readMeterPhases(meterDeviceId: string, ownerChoice: MainFusePhaseCapabilities | null): Promise<MeterPhasesRead>;
    readMeterMonthlyPeak(meterDeviceId: string): Promise<MeterMonthlyPeakRead>;
  };
  readonly capacityGuard?: { readonly phaseReadings: PhaseReadingTracker };
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
  /** The app's one store of the month peaks the polled meters report; this poll fills it. */
  meterMonthlyPeaks: MeterMonthlyPeaks,
): HomeyEnergyPollSource => {
  const homeMeters = new HomeMeters(
    host.homey.settings,
    async (sample) => {
      await pipeline.recordPowerSample(sample.powerW, undefined, sample);
    },
    () => host.getSubHomeMeters(),
    async (sample) => {
      const { capabilities } = readMainFusePhaseSource(host.homey.settings);
      const read = await host.deviceManager?.readMeterPhases(sample.meterDeviceId, capabilities);
      if (read) host.capacityGuard?.phaseReadings.admit(read, sample.powerW, Date.now());
    },
    async (meterDeviceIds, mainMeterDeviceId) => {
      const manager = host.deviceManager;
      if (manager === undefined) return;
      const read = (id: string) => manager.readMeterMonthlyPeak(id);
      await meterMonthlyPeaks.refresh(meterDeviceIds, mainMeterDeviceId, read, Date.now());
    },
  );
  return new HomeyEnergyPollSource({
    getPowerSource: () => host.getPowerSource(),
    // A Flow-source home that picked a phase meter still has phases to read.
    onInactive: () => {
      const { meterDeviceId } = readMainFusePhaseSource(host.homey.settings);
      if (meterDeviceId === null) host.capacityGuard?.phaseReadings.reset();
    },
    timers: host.timers,
    requestHomeMeters: () => homeMeters.request(),
    readMeters: async (meterDeviceIds) => (await host.deviceManager?.readMeters(meterDeviceIds)) ?? null,
    error: (...args) => host.error(...args),
  });
};
