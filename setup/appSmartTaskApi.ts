import type { AppContext } from '../lib/app/appContext';
import type { PlanInputSnapshotDevice } from '../lib/planInput/runtimeDeviceRead';
import type { WidgetObjectiveWriteResult } from '../packages/contracts/src/widgetHostApi';
import type { TaskEvaluationSource } from '../lib/objectives/deferredObjectives/taskEvaluationCoordinator';
import { SmartTaskRequests } from '../lib/objectives/deferredObjectives/smartTaskRequests';
import { buildDeferredObjectiveDeviceWriteDeps, toPlanDevice } from './appInit';
import { resolveSmartTaskHomeScope } from './appInit/smartTaskHomeScope';
import { isRuntimePlannedDevice } from './appDeviceSupport';

export type SmartTaskWriteResult = WidgetObjectiveWriteResult;
export type AppSmartTaskApi = SmartTaskRequests<PlanInputSnapshotDevice>;

/** Bind live owner reads; the objectives service owns preview and write decisions. */
export const createAppSmartTaskApi = (ctx: AppContext, evaluation: TaskEvaluationSource): AppSmartTaskApi => (
  new SmartTaskRequests<PlanInputSnapshotDevice>({
    findPlanInputDevice: (deviceId) => ctx.getPlanInputSnapshot().find((entry) => entry.id === deviceId),
    isRuntimePlanned: isRuntimePlannedDevice,
    isPickerDevice: (deviceId) => ctx.getUiPickerDevices().some((entry) => entry.id === deviceId),
    resolveHomeScope: (deviceId) => resolveSmartTaskHomeScope(ctx, deviceId),
    store: ctx.homey.settings,
    getNow: () => ctx.getNow(),
    getActivePlanRecorder: () => ctx.deferredObjectiveActivePlanRecorder,
    getPlanHistoryRecorder: () => ctx.deferredObjectivePlanHistoryRecorder,
    openWrite: (nowMs) => buildDeferredObjectiveDeviceWriteDeps(ctx, nowMs),
    getDeviceConfiguration: () => ctx.deviceConfiguration,
    status: ctx.deferredObjectiveStatusBus,
    hoursRemaining: ctx.deferredObjectiveHoursRemainingTracker,
  }, {
    getDailyBudget: () => ctx.dailyBudgetService,
    getPrice: () => ctx.priceCoordinator,
    getPlan: () => ctx.planService,
    projectDevice: (device) => toPlanDevice(ctx, device),
  }, evaluation)
);
