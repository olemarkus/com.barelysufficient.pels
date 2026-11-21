import {
  ScheduleActionExecutor, ScheduleService, createScheduleReceiptStore, requireScheduledTaskCandidates,
  type ScheduleRuntimePort,
} from '../lib/schedules';
import { registerScheduleFlowCards } from '../flowCards/scheduleCards';
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
  settings: ctx.homey.settings,
  getNowMs: () => ctx.getNow().getTime(),
});


type ScheduledModeCatalog = {
  getAllModes(): ReadonlySet<string>;
  resolveModeName(mode: string): string;
  getOperatingMode(): string;
};

export const createAppSchedules = (
  ctx: AppContext,
  modes: ScheduledModeCatalog,
  preparationResult: ScheduleRuntimePort['preparationResult'],
): ScheduleService => {
  const listTaskDevices = () => requireScheduledTaskCandidates(ctx.getCreateSmartTaskCandidateDevices());
  const executor = new ScheduleActionExecutor(createScheduledSmartTaskHost(ctx, listTaskDevices), ctx.homey.clock);
  const schedules = new ScheduleService({
    settings: ctx.homey.settings, clock: ctx.homey.clock, timers: ctx.timers,
    receipts: createScheduleReceiptStore(ctx.getUserdataDatabase()),
    getNowMs: () => ctx.getNow().getTime(),
    listModes: () => Array.from(modes.getAllModes()),
    resolveModeName: modes.resolveModeName,
    currentMode: modes.getOperatingMode,
    listTaskDevices,
    execute: (schedule, at) => executor.execute(schedule, at),
    preparationResult,
  });
  registerScheduleFlowCards(ctx.homey, schedules, listTaskDevices);
  return schedules;
};
