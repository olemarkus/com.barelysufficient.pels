import type { PelsHost } from '../../lib/app/pelsHost';
import { HomeyReportTransport, type HomeyReportRuntime } from '../../lib/diagnostics/homeyReportTransport';
import {
  SupportReportEvidenceSource, type SupportReportHomey, type SupportReportReads,
} from '../../lib/diagnostics/supportReportEvidence';
import { SupportReportService } from '../../lib/diagnostics/supportReportService';
import { createDeviceEventStore } from '../../lib/diagnostics/deviceEventStore';
import { createLogTailStore } from '../../lib/diagnostics/logTailStore';
import { requireDeviceManager, requireHomeMembership, requirePlanService } from './contextGuards';

export type SupportReportApp = Pick<PelsHost,
  | 'deviceManager' | 'homeMembership' | 'planService' | 'homeRuntimeRead' | 'getDeviceLogUiPayload'
  | 'getLatestPlanSnapshotForUi' | 'getCapacityScalars' | 'getDailyBudgetUiPayload' | 'readPriceSetup'
  | 'getPriceTimelineForUi' | 'getUserdataDatabase'>;

// Each read reaches the app when a report is captured. A service that is not
// running yet throws its guard's error, which capture records as unavailable.
export const createSupportReportReads = (app: SupportReportApp): SupportReportReads => ({
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
  // Built per capture: the database opens after the report service is constructed.
  readDeviceEvents: (deviceIds, fromMs, toMs) => (
    createDeviceEventStore(app.getUserdataDatabase()).read(deviceIds, fromMs, toMs)),
  readLogTail: (fromMs, toMs, maxBytes) => createLogTailStore(app.getUserdataDatabase()).read(fromMs, toMs, maxBytes),
});

export const createSupportReports = (
  homey: SupportReportHomey & HomeyReportRuntime,
  app: SupportReportApp,
): SupportReportService => new SupportReportService(
  new SupportReportEvidenceSource(createSupportReportReads(app), homey),
  new HomeyReportTransport(homey),
);
