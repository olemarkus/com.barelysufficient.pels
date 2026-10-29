import type { PelsHost } from '../../lib/app/pelsHost';
import { HomeyReportTransport, type HomeyReportRuntime } from '../../lib/diagnostics/homeyReportTransport';
import {
  SupportReportEvidenceSource, type SupportReportHomey, type SupportReportReads,
} from '../../lib/diagnostics/supportReportEvidence';
import { SupportReportService } from '../../lib/diagnostics/supportReportService';
import { createDeviceEventStore } from '../../lib/diagnostics/deviceEventStore';
import { createLogTailStore } from '../../lib/diagnostics/logTailStore';
import {
  readObjectiveForDeviceState, type ObjectiveSettingsStore,
} from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { SmartTaskCycleRecord } from '../../lib/objectives/deferredObjectives/smartTaskCycleRecord';
import type { AppContext } from '../../lib/app/appContext';
import { requireDeviceManager, requireHomeMembership, requirePlanService } from './contextGuards';

export type SupportReportApp = Pick<PelsHost,
  | 'deviceManager' | 'homeMembership' | 'planService' | 'homeRuntimeRead' | 'getDeviceLogUiPayload'
  | 'getLatestPlanSnapshotForUi' | 'getCapacityScalars' | 'getDailyBudgetUiPayload' | 'readPriceSetup'
  | 'getPriceTimelineForUi' | 'getUserdataDatabase'>
  & Pick<AppContext, 'deferredObjectiveActivePlanRecorder'>;

// Each read reaches the app when a report is captured. A service that is not
// running yet throws its guard's error, which capture records as unavailable.
export const createSupportReportReads = (
  app: SupportReportApp,
  objectiveSettings: ObjectiveSettingsStore,
  readSmartTaskCycle: (deviceId: string) => SmartTaskCycleRecord | undefined,
): SupportReportReads => ({
  getDeviceSnapshot: (deviceId) => requireDeviceManager(app).getSnapshotByDeviceId(deviceId),
  getHomeMembership: () => requireHomeMembership(app),
  getLatestDevicePlan: () => requirePlanService(app).getLatestPlanSnapshot(),
  readHome: (homeId) => app.homeRuntimeRead.readHome(homeId),
  getDeviceLogUiPayload: () => app.getDeviceLogUiPayload(),
  getLatestPlanSnapshotForUi: () => app.getLatestPlanSnapshotForUi(),
  getCapacityScalars: () => app.getCapacityScalars(),
  getDailyBudgetUiPayload: () => app.getDailyBudgetUiPayload(),
  readPriceSetup: () => app.readPriceSetup(),
  getPriceTimelineForUi: () => app.getPriceTimelineForUi(),
  getCarLinkDiagnostics: (deviceId) => requireDeviceManager(app).getCarLinkDiagnostics(deviceId),
  readSmartTask: (deviceId) => {
    const read = readObjectiveForDeviceState(objectiveSettings, deviceId);
    if (read.state === 'unavailable') throw new Error('Smart task settings are unavailable');
    if (read.state === 'none') return read;
    return {
      ...read,
      plan: app.deferredObjectiveActivePlanRecorder?.getActivePlan(deviceId),
      cycle: readSmartTaskCycle(deviceId),
    };
  },
  // Built per capture: the database opens after the report service is constructed.
  readDeviceEvents: (deviceIds, fromMs, toMs) => (
    createDeviceEventStore(app.getUserdataDatabase()).read(deviceIds, fromMs, toMs)),
  readLogTail: (fromMs, toMs, maxBytes, omittedEvents) => (
    createLogTailStore(app.getUserdataDatabase()).read(fromMs, toMs, maxBytes, omittedEvents)),
});

export const createSupportReports = (
  homey: SupportReportHomey & HomeyReportRuntime & { settings: ObjectiveSettingsStore },
  app: SupportReportApp,
  readSmartTaskCycle: (deviceId: string) => SmartTaskCycleRecord | undefined,
): SupportReportService => new SupportReportService(
  new SupportReportEvidenceSource(createSupportReportReads(app, homey.settings, readSmartTaskCycle), homey),
  new HomeyReportTransport(homey),
);
