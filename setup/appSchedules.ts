import {
  ScheduleActionExecutor, ScheduleService, createScheduleReceiptStore, requireScheduledTaskCandidates,
  type ScheduleRuntimePort,
} from '../lib/schedules';
import { registerScheduleFlowCards } from '../flowCards/scheduleCards';

import type { AppContext } from '../lib/app/appContext';
import { createScheduledSmartTaskHost } from './appSmartTaskCommands';

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
