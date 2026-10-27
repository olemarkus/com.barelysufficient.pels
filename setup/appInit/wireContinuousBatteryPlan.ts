import type { InitializedAppContext } from '../../lib/app/appContext';
import { MAIN_HOME_ID } from '../../packages/shared-domain/src/settings/settingsKeys';
import { ContinuousBatteryPlanService } from '../../lib/battery/continuousBatteryPlanService';
import {
  createContinuousBatteryPlanSource, type ContinuousBatteryHorizonSources,
} from '../../lib/planInput/continuousBatteryHorizon';
import { requireBatteryControl } from './contextGuards';

/** The selector is ready here; setup only connects the source and owner. */
export function wireContinuousBatteryPlan(
  ctx: InitializedAppContext,
  getActiveTasks: ContinuousBatteryHorizonSources['getActiveTasks'],
  getSolarForecast: ContinuousBatteryHorizonSources['getSolarForecast'],
): void {
  const source = createContinuousBatteryPlanSource({
    getNowMs: () => ctx.getNow().getTime(),
    getDevices: () => ctx.homeMembership?.filterDevicesForHome(ctx.getPlanInputSnapshot(), MAIN_HOME_ID) ?? [],
    getControl: () => requireBatteryControl(ctx),
    getControllableDevices: () => ctx.deviceControlSettings.controllableDevices,
    getPriceTimeline: () => ctx.priceCoordinator.getPriceTimeline(),
    getPowerLimitSettings: () => ctx.capacitySettings,
    getActiveTasks,
    solarScope: ctx.batterySolarScope,
    getSolarForecast,
    getBackgroundKWh: (hourStartMs) => ctx.forecastBatteryBackgroundKWh(hourStartMs),
  });
  const owner = new ContinuousBatteryPlanService(ctx.homey.settings, source);
  // eslint-disable-next-line no-param-reassign, functional/immutable-data -- composition-root owner reads
  ctx.readContinuousBatteryPlan = (deviceId) => owner.read(deviceId);
  // eslint-disable-next-line no-param-reassign, functional/immutable-data -- composition-root owner command
  ctx.saveContinuousBatteryPlan = (deviceId, config) => owner.save(deviceId, config);
}
