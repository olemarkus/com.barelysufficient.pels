import { ModePreparationResolver, type ModePreparationReads } from '../../lib/thermostat/modePreparation';
import {
  createTemperatureSetpointResolver, type TemperatureIntentReads,
} from '../../lib/thermostat/temperatureSetpoints';
import { readActiveTemperatureOverride } from '../../lib/overrides/deviceOverrides';
import type { ResolveTemperatureSetpoints } from '../../packages/planner-types/src/temperatureSetpoints';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeScope } from '../homeRuntime/homeScope';
import type { PlanInputSnapshotDevice } from '../../lib/planInput/runtimeDeviceRead';
import { toPlanDevice } from './toPlanDevice';

/**
 * Bind `lib/thermostat`'s setpoint resolver to one home's reads, for that home's
 * plan builder. Construction only: each read is the home's own member, passed
 * through unchanged, and no value is looked at here.
 *
 * The temperature-override read is bound here too, for the resolver, the write
 * fence and the smart-task lanes, so its owner is named in this one file.
 *
 * A file of its own for one reason: the setup-boundary check budgets how many
 * domain peers each wiring file names, and `createPlanEngine.ts` is at its
 * budget. Naming `lib/thermostat` here keeps that file's count where it was.
 */
/** A device's temperature override while it is in force, read through the key's owner. */
export const bindTemporaryTemperatureRead = (ctx: AppContext) => (deviceId: string): number | null => (
  readActiveTemperatureOverride(ctx.homey.settings, deviceId, ctx.getNow().getTime())?.targetC ?? null
);

export const bindTemperatureSetpoints = (
  scope: HomeScope,
  ctx: AppContext,
  getPreparedModeTargets: TemperatureIntentReads['getPreparedModeTargets'],
): ResolveTemperatureSetpoints => (
  createTemperatureSetpointResolver({
    getOperatingMode: scope.getOperatingMode,
    getModeDeviceTargets: scope.getModeDeviceTargets,
    getPriceOptimizationEnabled: scope.getPriceOptimizationEnabled,
    getPriceOptimizationSettings: scope.getPriceOptimizationSettings,
    getCurrentHourPriceLevel: scope.getCurrentHourPriceLevel,
    getThermalDirection: (deviceId) => ctx.observer.getThermalDirection(deviceId),
    getShedBehavior: (deviceId) => ctx.getShedBehavior(deviceId),
    getTemporaryTemperatureC: bindTemporaryTemperatureRead(ctx),
    getPreparedModeTargets,
  })
);

export const bindModePreparationResolver = (
  ctx: AppContext,
  modes: Pick<ModePreparationReads, 'currentMode' | 'modeTargets'>,
  occurrence: ModePreparationReads['occurrence'],
  runtimeDevice: (deviceId: string) => PlanInputSnapshotDevice | undefined,
  runtimeDevices: () => readonly PlanInputSnapshotDevice[],
  objectives: Pick<ModePreparationReads, 'smartTaskState' | 'leadMs'>,
): ModePreparationResolver => new ModePreparationResolver({
  ...modes,
  ...objectives,
  occurrence,
  readDevice: (deviceId) => {
    const device = runtimeDevice(deviceId);
    return device && toPlanDevice(ctx, device);
  },
  readPreviewDevices: () => runtimeDevices()
    .filter((device) => device.temperature !== undefined)
    .map((device) => toPlanDevice(ctx, device)),
  nowMs: () => ctx.getNow().getTime(),
  thermalDirection: (deviceId) => ctx.observer.getThermalDirection(deviceId),
  canSetTemperature: (deviceId) => ctx.observedTemperatureModeUpdates.allowsLimiting(deviceId),
  temporaryTemperatureC: bindTemporaryTemperatureRead(ctx),
});
