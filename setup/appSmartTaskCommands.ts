import type { AppContext } from '../lib/app/appContext';
import type { SmartTaskCommandPort } from '../lib/objectives/deferredObjectives/smartTaskCommands';
import { readAllObjectives, upsertObjectiveForDevice } from '../lib/objectives/deferredObjectives';
import { buildDeferredObjectiveDeviceWriteDeps } from './appInit/deferredRecorders';
import { resolveSmartTaskHomeScope } from './appInit/smartTaskHomeScope';
import type { SmartTaskCandidateDevice } from '../packages/contracts/src/smartTaskEdit';

/** Bind the live store and hardened per-device write; commands stay with objectives. */
export const createSmartTaskCommandPort = (ctx: AppContext): SmartTaskCommandPort => ({
  getDeferredObjectiveSettings: () => readAllObjectives(ctx.homey.settings),
  upsertDeferredObjectiveForDevice: (deviceId, deviceName, entry, rescue) => upsertObjectiveForDevice(
    buildDeferredObjectiveDeviceWriteDeps(ctx, ctx.getNow().getTime()),
    deviceId, deviceName, entry, rescue,
  ),
});

export const createScheduledSmartTaskHost = (ctx: AppContext, listTaskDevices: () => SmartTaskCandidateDevice[]) => ({
  ...createSmartTaskCommandPort(ctx),
  listTaskDevices,
  resolveSmartTaskHomeScope: (deviceId: string) => resolveSmartTaskHomeScope(ctx, deviceId),
  handleOperatingModeChange: (mode: string) => ctx.handleOperatingModeChange(mode),
});
