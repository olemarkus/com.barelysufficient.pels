/**
 * The two settings-maintenance passes the snapshot refresh runs, wired.
 *
 * They live here rather than inline in `app.ts` because one of them needs a
 * control-resolution step — the mode-target pass takes the PLANNER's device
 * type, so the snapshot has to go through `toPlanDevice` first — and that is
 * not something the composition root should be doing beside a settings handle.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  disableUnsupportedDevices,
  persistFilledModeTargets,
  type ResolveOperatingModeForDevice,
} from '../appDeviceSupport';
import { resolveHomeIdForModeCatalogSeed, resolveOperatingModeForDevice } from '../homeRuntime/homeOperatingMode';
import { toPlanDevice } from './toPlanDevice';

export const createUnsupportedDeviceDemotion = (ctx: AppContext) => (
  snapshot: DecoratedDeviceSnapshot[],
  operatingModeResolver?: ResolveOperatingModeForDevice,
): void => disableUnsupportedDevices({
  snapshot,
  settings: ctx.homey.settings,
  // Overshoot defaults follow the OWNING home's effective mode.
  resolveOperatingModeForDevice: operatingModeResolver
    ?? ((deviceId) => resolveOperatingModeForDevice(ctx, deviceId)),
  debugStructured: ctx.getStructuredDebugEmitter('devices', 'devices'),
});

export const createModeTargetPersistence = (
  ctx: AppContext,
): ((snapshot: DecoratedDeviceSnapshot[]) => void) => (snapshot) => persistFilledModeTargets({
  // The settings UI reads the snapshot; this reads the plan projection of it.
  // The two disagree on purpose for a device whose owner switched temperature
  // control off — still a temperature device to the UI (that is what renders the
  // toggle and its saved targets), not one to control.
  devices: snapshot.map((device) => toPlanDevice(ctx, device)),
  settings: ctx.homey.settings,
  resolveHomeIdForDevice: (deviceId) => resolveHomeIdForModeCatalogSeed(ctx, deviceId),
  structuredLog: (event) => ctx.getStructuredLogger('devices')?.info(event),
  debugStructured: ctx.getStructuredDebugEmitter('devices', 'devices'),
});
