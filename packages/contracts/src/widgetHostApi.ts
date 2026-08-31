import type { DecoratedDeviceSnapshot } from './types.js';
import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
} from './deferredObjectivePlanPreview.js';
import type { StarvationRescueDevice } from './starvationRescue.js';
import type { DailyBudgetUiRead } from './dailyBudgetTypes.js';
import type { ResolvedDeferredObjectiveActivePlansV1 } from './deferredObjectiveActivePlans.js';
import type { SettingsUiDeferredObjectivePlanHistoryPayload } from './settingsUiApi.js';
import type { SmartTaskHomeScope } from './smartTaskHomeScope.js';

/**
 * Result of a widget-initiated deferred-objective write (create / rescue).
 * SINGLE declaration of this union: the runtime aliases it as
 * `SmartTaskWriteResult` (`setup/appSmartTaskApi.ts`) rather than mirroring it,
 * so `PelsApp.createDeferredObjective` / `rescueDeviceWithBudgetExemption` and
 * the widgets cannot drift apart.
 */
export type WidgetObjectiveWriteResult =
  | { ok: true }
  | {
    ok: false;
    reason: 'device_not_found' | 'device_not_planned' | 'device_not_eligible'
      | 'device_in_sub_home' | 'invalid_candidate' | 'write_refused';
  };

export type CreateSmartTaskCandidateDevicesRead =
  | { state: 'ready'; devices: DecoratedDeviceSnapshot[] }
  | { state: 'unavailable' };

/** create_smart_task widget host surface. */
export type CreateSmartTaskHostApi = {
  getCreateSmartTaskCandidateDevices(): CreateSmartTaskCandidateDevicesRead;
  resolveSmartTaskHomeScope(deviceId: string): SmartTaskHomeScope;
  previewDeferredObjectivePlan(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewEstimate;
  createDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): WidgetObjectiveWriteResult;
};

/** starvation_rescue widget host surface. */
export type StarvationRescueHostApi = {
  getStarvedRescueDevices(): StarvationRescueDevice[];
  resolveSmartTaskHomeScope(deviceId: string): SmartTaskHomeScope;
  previewStarvationRescuePlan(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): { estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean };
  rescueDeviceWithBudgetExemption(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): WidgetObjectiveWriteResult;
};

/** plan_budget widget host surface. */
export type DailyBudgetHostApi = {
  getDailyBudgetUiPayload(): DailyBudgetUiRead;
};

/** smart_tasks widget host surface. */
export type SmartTaskHistoryHostApi = {
  getDeferredObjectiveActivePlansUiPayload(): ResolvedDeferredObjectiveActivePlansV1 | null;
  getDeferredObjectivePlanHistoryRecentUiPayload(sinceMs: number): SettingsUiDeferredObjectivePlanHistoryPayload;
  getDeferredObjectivePlanHistoryUiPayload(): SettingsUiDeferredObjectivePlanHistoryPayload;
  getUiPickerDevices(): DecoratedDeviceSnapshot[];
};

/**
 * The full surface the PELS app class exposes to its widget node-entries
 * (`widgets/<name>/src/api.ts` run in the app process and reach the app via
 * `homey.app`). `PelsApp implements PelsWidgetHostApi`, and each widget types
 * `homey.app` as its own feature slice above — so a rename or signature change
 * fails to compile on BOTH sides instead of silently degrading to a runtime
 * "unavailable". (Each widget previously hand-rolled its own disconnected
 * partial view of these methods.) `homey.app` itself can still be `undefined`
 * while the app is unwired during restart, so consumers keep a presence guard;
 * this contract types the methods once the app exists.
 */
export type PelsWidgetHostApi =
  & CreateSmartTaskHostApi
  & StarvationRescueHostApi
  & DailyBudgetHostApi
  & SmartTaskHistoryHostApi;
