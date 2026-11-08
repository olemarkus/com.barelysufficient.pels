import type { InitializedAppContext } from '../../lib/app/appContext';
import { MAIN_HOME_ID } from '../../packages/shared-domain/src/settings/settingsKeys';
import { ContinuousBatteryPlanService } from '../../lib/battery/continuousBatteryPlanService';
import {
  createContinuousBatteryPlanSource, type ContinuousBatteryHorizonSources,
} from '../../lib/battery/continuousBatteryHorizon';
import type { TaskReservationSource } from '../../lib/ports/taskReservations';
import { requireBatteryControl, requireHomeMembership } from './contextGuards';

/** The selector is ready here; setup only connects the source and owner. */
export function wireContinuousBatteryPlan(
  ctx: InitializedAppContext,
  taskReservations: TaskReservationSource,
  getSolarForecast: ContinuousBatteryHorizonSources['getSolarForecast'],
  getPrioritiesForDevices: ContinuousBatteryHorizonSources['getPrioritiesForDevices'],
): void {
  requireHomeMembership(ctx);
  const source = createContinuousBatteryPlanSource({
    getNowMs: () => ctx.getNow().getTime(),
    // Membership exists for the active lifetime; runUninit clears it before
    // retained settings readers are detached, when no devices is intentional.
    getDevices: () => ctx.homeMembership?.filterDevicesForHome(ctx.getDeviceSurfaces(), MAIN_HOME_ID) ?? [],
    getControl: () => requireBatteryControl(ctx),
    getControllableDevices: () => ctx.deviceControlSettings.controllableDevices,
    getPrioritiesForDevices,
    getPriceTimeline: () => ctx.priceCoordinator.getPriceTimeline(),
    getPowerLimitSettings: () => ctx.capacitySettings,
    taskReservations,
    solarScope: ctx.batterySolarScope,
    getSolarForecast,
    getBackgroundKWh: (hourStartMs) => ctx.forecastBatteryBackgroundKWh(hourStartMs),
  });
  const owner = new ContinuousBatteryPlanService(ctx.homey.settings, source);
  // eslint-disable-next-line no-param-reassign, functional/immutable-data -- composition-root owner reads
  ctx.readContinuousBatteryPlan = (deviceId) => owner.read(deviceId);
  // eslint-disable-next-line no-param-reassign, functional/immutable-data -- composition-root owner reads
  ctx.hasEnabledContinuousBatteryPlan = () => owner.hasEnabledPlan();
}
