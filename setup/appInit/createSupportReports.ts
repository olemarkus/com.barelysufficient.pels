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
import { requireDeviceManager, requireHomeMembership, requirePlanService } from './contextGuards';

export type SupportReportApp = Pick<PelsHost,
  | 'deviceManager' | 'homeMembership' | 'planService' | 'homeRuntimeRead' | 'getDeviceLogUiPayload'
  | 'getLatestPlanSnapshotForUi' | 'getCapacityScalars' | 'getDailyBudgetUiPayload' | 'readPriceSetup'
  | 'getPriceTimelineForUi' | 'getUserdataDatabase' | 'getDeferredObjectiveActivePlansUiPayload'>;

// Each read reaches the app when a report is captured. A service that is not
// running yet throws its guard's error, which capture records as unavailable.
export const createSupportReportReads = (
  app: SupportReportApp,
  objectiveSettings: ObjectiveSettingsStore,
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
    const activePlan = app.getDeferredObjectiveActivePlansUiPayload()?.plansByDeviceId[deviceId];
    return { state: 'present', entry: read.entry, activePlan };
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
): SupportReportService => new SupportReportService(
  new SupportReportEvidenceSource(createSupportReportReads(app, homey.settings), homey),
  new HomeyReportTransport(homey),
);
