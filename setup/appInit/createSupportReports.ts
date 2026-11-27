import type { PelsHost } from '../../lib/app/pelsHost';
import { readInstalledAppVersions } from '../../lib/diagnostics/supportReportHomeyApps';
import { HomeyReportTransport, type HomeyReportRuntime } from '../../lib/diagnostics/homeyReportTransport';
import {
  SupportReportEvidenceSource, type SupportReportHomey, type SupportReportReads,
} from '../../lib/diagnostics/supportReportEvidence';
import { SupportReportService } from '../../lib/diagnostics/supportReportService';
import { readSmartTaskDeviceIds, readSmartTaskRuns } from '../../lib/diagnostics/supportReportSmartTasks';
import { createDeviceEventStore } from '../../lib/diagnostics/deviceEventStore';
import { createLogTailStore } from '../../lib/diagnostics/logTailStore';
import type { HeatingShadowCollector } from '../../lib/diagnostics/heatingShadowCollector';
import { type AppMemoryUsageSampler, captureAppMemorySnapshot } from '../../lib/diagnostics/appMemoryFootprint';
import {
  readObjectiveForDeviceState, type ObjectiveSettingsStore,
} from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { SmartTaskCycleRecord } from '../../lib/objectives/deferredObjectives/smartTaskCycleRecord';
import type { AppContext } from '../../lib/app/appContext';
import { readMainMeterSelection } from '../mainMeterSettings';
import { readPowerSourceChoice } from '../powerSourceChoice';
import { requireDeviceManager, requireHomeMembership, requirePlanService } from './contextGuards';

export type SupportReportApp = Pick<PelsHost,
  | 'deviceManager' | 'homeMembership' | 'planService' | 'homeRuntimeRead' | 'getDeviceLogUiPayload'
  | 'getLatestPlanSnapshotForUi' | 'getCapacityScalars' | 'capacityGuard'
  | 'getDailyBudgetUiPayload' | 'readPriceSetup'
  | 'getPriceTimelineForUi' | 'getUserdataDatabase' | 'readSchedules' | 'powerTracker'
  | 'flowBacked' | 'getSettingsUiManagedDevices'>
  & Pick<PelsHost, 'readDeviceDiagnosticConfiguration'>
  & Pick<AppContext, 'deferredObjectiveActivePlanRecorder' | 'deferredObjectivePlanHistoryRecorder'>;

// Each read reaches the app when a report is captured. A service that is not
// running yet throws its guard's error, which capture records as unavailable.
export const createSupportReportReads = (
  app: SupportReportApp,
  objectiveSettings: ObjectiveSettingsStore,
  readSmartTaskCycle: (deviceId: string) => SmartTaskCycleRecord | undefined,
  heatingShadow: Pick<HeatingShadowCollector, 'readDaily'>,
  appMemory: AppMemoryUsageSampler,
  readAppVersions: SupportReportReads['readInstalledAppVersions'],
): SupportReportReads => ({
  readDeviceDiagnosticConfiguration: app.readDeviceDiagnosticConfiguration,
  getDeviceSnapshot: (deviceId) => requireDeviceManager(app).getSnapshotByDeviceId(deviceId),
  getEvChargingCurrentDiagnostics: (deviceId, nowMs) => (
    requireDeviceManager(app).getEvChargingCurrentDiagnostics(deviceId, nowMs)),
  readHomeyDevices: (collect) => requireDeviceManager(app).readDevicesForDiagnostics(collect),
  readInstalledAppVersions: readAppVersions,
  getHomeMembership: () => requireHomeMembership(app),
  getLatestDevicePlan: () => requirePlanService(app).getLatestPlanSnapshot(),
  readHome: (homeId) => app.homeRuntimeRead.readHome(homeId),
  getDeviceLogUiPayload: () => app.getDeviceLogUiPayload(),
  getLatestPlanSnapshotForUi: () => app.getLatestPlanSnapshotForUi(),
  getCapacityScalars: () => app.getCapacityScalars(),
  readPowerSourceChoice: () => readPowerSourceChoice(objectiveSettings),
  readMainMeterSelection: () => readMainMeterSelection(objectiveSettings),
  getPhaseReadingEvidence: () => ({
    reading: app.capacityGuard.phaseReadings.current(),
    meterCapabilityIds: app.capacityGuard.phaseReadings.meterCapabilityIds(),
  }),
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
  readSmartTaskDeviceIds: () => readSmartTaskDeviceIds(objectiveSettings),
  readSmartTaskRuns: () => {
    if (!app.deferredObjectivePlanHistoryRecorder) throw new Error('Smart task history is not running');
    return readSmartTaskRuns(app.deferredObjectivePlanHistoryRecorder);
  },
  readSchedules: () => {
    const read = app.readSchedules();
    if (!read.ok) throw new Error(read.error);
    return read.data;
  },
  readObjectiveProfiles: () => app.powerTracker.objectiveProfiles,
  readHeatingShadowDaily: (capturedAtMs) => heatingShadow.readDaily(capturedAtMs),
  readPowerFigureChecks: (nowMs) => (
    app.flowBacked.powerFigureChecks.readAll(app.getSettingsUiManagedDevices(), nowMs)
  ),
  readWriteAnswerTimes: (nowMs) => {
    const transport = requireDeviceManager(app);
    return transport.writeAnswerTimes.describe(nowMs, (id) => transport.getSnapshotByDeviceId(id)?.name ?? null);
  },
  readMeterResponseTimings: (nowMs) => (
    app.flowBacked.meterResponseTimings.readAll(app.getSettingsUiManagedDevices(), nowMs)
  ),
  readAppMemory: () => captureAppMemorySnapshot(appMemory),
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
  heatingShadow: Pick<HeatingShadowCollector, 'readDaily'>,
  appMemory: AppMemoryUsageSampler,
): SupportReportService => new SupportReportService(
  new SupportReportEvidenceSource(
    createSupportReportReads(
      app, homey.settings, readSmartTaskCycle, heatingShadow, appMemory, () => readInstalledAppVersions(homey),
    ),
    homey,
  ),
  new HomeyReportTransport(homey),
);
