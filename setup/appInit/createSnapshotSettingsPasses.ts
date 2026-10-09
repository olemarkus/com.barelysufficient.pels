/**
 * The two settings-maintenance passes the snapshot refresh runs, wired.
 *
 * They live here rather than inline in `app.ts` because one of them needs a
 * control-resolution step — the mode-target pass takes the planner's device
 * type, so the snapshot goes through `toPlanDevice` first —
 * and that is not something the composition root should be doing beside a
 * settings handle.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { HomeModeCatalog } from '../../lib/home/homeModeCatalog';
import { ModeDeviceTargetFill } from '../../lib/home/modeDeviceTargetFill';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  seedTemperatureShedFloorDefaults,
  listModeTargetFillDevices,
  type ResolveOperatingModeForDevice,
} from '../appDeviceSupport';
import { resolveHomeIdForModeCatalogSeed, resolveOperatingModeForDevice } from '../homeRuntime/homeOperatingMode';
import { createDefaultToPlanDeviceOptions } from '../../lib/planInput/projectPlanInputDevice';
import { toPlanDevice } from './toPlanDevice';

export const createTemperatureShedFloorDefaults = (ctx: AppContext, homeModeCatalog: HomeModeCatalog) => (
  snapshot: DecoratedDeviceSnapshot[],
  operatingModeResolver?: ResolveOperatingModeForDevice,
): void => seedTemperatureShedFloorDefaults({
  snapshot,
  settings: ctx.homey.settings,
  // Overshoot defaults follow the OWNING home's effective mode.
  resolveOperatingModeForDevice: operatingModeResolver
    ?? ((deviceId) => resolveOperatingModeForDevice(homeModeCatalog, deviceId)),
  debugStructured: ctx.getStructuredDebugEmitter('devices', 'devices'),
});

/**
 * The app's one mode-target fill pass. Construct it once: what it already filled
 * lives on the instance, and a second instance would forget it.
 */
export const createModeDeviceTargetFill = (ctx: AppContext): ModeDeviceTargetFill => new ModeDeviceTargetFill(
  ctx.homey.settings,
  // This settings pass needs the same runtime configuration and observer values
  // used by planning; inventory metadata stays on DeviceReads.
  () => listModeTargetFillDevices(
    ctx.getPlanInputSnapshot().map((device) => toPlanDevice(
      ctx,
      device,
      createDefaultToPlanDeviceOptions(),
    )),
    ctx.homey.settings,
  ),
  (deviceId) => resolveHomeIdForModeCatalogSeed(ctx, deviceId),
  (event) => ctx.getStructuredLogger('devices')?.info(event),
);
