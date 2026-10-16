/**
 * The mode-target fill pass the snapshot refresh runs, wired.
 *
 * It lives here rather than inline in `app.ts` because it needs a
 * control-resolution step — the mode-target pass takes the planner's device
 * type, so the snapshot goes through `toPlanDevice` first —
 * and that is not something the composition root should be doing beside a
 * settings handle.
 */
import type { AppContext } from '../../lib/app/appContext';
import { ModeDeviceTargetFill } from '../../lib/home/modeDeviceTargetFill';
import { listModeTargetFillDevices } from '../appDeviceSupport';
import { resolveHomeIdForModeCatalogSeed } from '../homeRuntime/homeOperatingMode';
import { createDefaultToPlanDeviceOptions } from '../../lib/planInput/projectPlanInputDevice';
import { toPlanDevice } from './toPlanDevice';

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
  ),
  (deviceId) => resolveHomeIdForModeCatalogSeed(ctx, deviceId),
  (event) => ctx.getStructuredLogger('devices')?.info(event),
);
