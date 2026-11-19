import { observeFlowSamplePhases } from '../phaseSourceFeed';
import {
  requireBatteryControl,
  requireDeviceManager,
  requireFlowHomey,
  requirePriceCoordinator,
} from './contextGuards';
import { registerFlowCards, type FlowCardDeps } from '../../flowCards/registerFlowCards';
import type { AppContext } from '../../lib/app/appContext';
import { createFlowPowerSampleReceiver } from '../../lib/power/flowPowerSample';
import { resolveObservedHeadroom } from '../../lib/power/lastTotalPower';
import {
  hasMainHomeSmartTaskAuthority,
  isSmartTaskDeviceInMainHome,
} from './smartTaskHomeScope';
import {
  clearObjectiveForDevice,
  readSmartTaskInProgress,
} from '../../lib/objectives/deferredObjectives';
import { createSmartTaskCommandPort } from '../appSmartTaskCommands';
import { buildDeferredObjectiveDeviceWriteDeps } from './deferredRecorders';
import {
  readConfiguredPowerSource,
} from '../powerSourceSettings';

export function registerAppFlowCards(
  ctx: AppContext,
  resolveModeName: (mode: string) => string,
  getAllModes: () => Set<string>,
  getCurrentOperatingMode: () => string,
  listDeviceTargetModes: FlowCardDeps['listDeviceTargetModes'],
  setDeviceModeTarget: FlowCardDeps['setDeviceModeTarget'],
): void {
  registerFlowCards({
    homey: requireFlowHomey(ctx),
    structuredLog: ctx.getStructuredLogger('devices'),
    resolveModeName,
    getAllModes,
    getCurrentOperatingMode,
    handleOperatingModeChange: (rawMode) => ctx.handleOperatingModeChange(rawMode),
    getCurrentPriceLevel: () => requirePriceCoordinator(ctx).getCurrentHourPriceLevel(),
    getPriceLevelChangesWithin: (window) => requirePriceCoordinator(ctx).getPriceLevelChangesWithin(window),
    areFlowBackedCardsAvailable: () => ctx.flowBacked.areFlowBackedCardsAvailable(),
    recordPowerSample: createFlowPowerSampleReceiver({
      readPowerSource: () => readConfiguredPowerSource(ctx.homey.settings),
      nowMs: () => ctx.getNow().getTime(),
      observePhases: (powerW, nowMs) => observeFlowSamplePhases(ctx, powerW, nowMs),
      recordPowerSample: (powerW, nowMs) => ctx.recordPowerSample(powerW, nowMs),
      noteAdmittedSample: () => ctx.homeMembership?.noteAdmittedFlowHomeSample(),
      log: ctx.getStructuredLogger('power'),
    }),
    // The power owner projects the accepted meter sample against the planner's
    // enabled capacity/grid ceiling, keeping the Flow condition on that limit.
    getHeadroom: () => resolveObservedHeadroom(ctx.powerTracker, ctx.computePhysicalPowerLimit()),
    getSnapshot: () => ctx.getFlowSnapshot(),
    getDeviceDescriptors: () => ctx.getFlowDeviceDescriptors(),
    getControllableDevices: () => ctx.deviceControlSettings.controllableDevices,
    confirmCarAssociation: (chargerId, carId) => requireDeviceManager(ctx).confirmCarAssociation(chargerId, carId),
    isWaitingForCarAssociation: (chargerId) => requireDeviceManager(ctx).isWaitingForCarAssociation(chargerId),
    getCarAssociationCarIds: (chargerId) => requireDeviceManager(ctx).getCarAssociationCarIds(chargerId),
    readCarAssociationCandidates: () => requireDeviceManager(ctx).readCarAssociationCandidates(),
    readBatteryControl: (deviceId) => requireBatteryControl(ctx).readControlCapability(deviceId),
    listDeviceTargetModes,
    setDeviceModeTarget,
    readSmartTaskInProgress: (deviceId) => (
      readSmartTaskInProgress(ctx.homey.settings, deviceId, ctx.getNow().getTime())
    ),
    normalizeTemperatureTarget: (deviceId, temperatureC) => (
      requireDeviceManager(ctx).resolveTemperatureTarget(deviceId, temperatureC)
    ),
    refreshSnapshot: (options) => ctx.refreshTargetDevicesSnapshot(options),
    getHomeyDevicesForFlow: () => ctx.flowBacked.getHomeyDevicesForFlow(),
    reportFlowBackedCapability: (deviceId, capabilityId, value) => (
      ctx.flowBacked.reportFlowBackedCapability(deviceId, capabilityId, value)
    ),
    reportSteppedLoadActualStep: (deviceId, stepId, planningPowerW) => (
      ctx.deviceControlHelpers.reportSteppedLoadActualStep(deviceId, stepId, planningPowerW)
    ),
    setExpectedOverride: (deviceId, kw) => ctx.flowBacked.setExpectedOverride(deviceId, kw),
    storeFlowPriceData: (kind, raw) => requirePriceCoordinator(ctx).storeFlowPriceData(kind, raw),
    // Flow and scheduled commands share the hardened per-device write and its recorder notifications.
    ...createSmartTaskCommandPort(ctx),
    clearDeferredObjectiveForDevice: (params) => clearObjectiveForDevice(
      buildDeferredObjectiveDeviceWriteDeps(ctx, ctx.getNow().getTime()),
      params,
    ),
    // Existing status follows durable membership, while new-task discovery
    // follows stricter current authority. A transient Main fence therefore
    // hides task creation without falsely erasing an existing task's status.
    isDeviceInMainHome: (deviceId) => isSmartTaskDeviceInMainHome(ctx, deviceId),
    hasMainHomeSmartTaskAuthority: (deviceId) => hasMainHomeSmartTaskAuthority(ctx, deviceId),
    getDeferredObjectiveActivePlans: () => (
      ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null
    ),
    deferredObjectiveStatusBus: ctx.deferredObjectiveStatusBus,
    deferredObjectivePlanRevisionBus: ctx.deferredObjectivePlanRevisionBus,
    deferredObjectiveEndedBus: ctx.deferredObjectiveEndedBus,
    deferredObjectiveHoursRemainingBus: ctx.deferredObjectiveHoursRemainingBus,
    deferredObjectiveHoursRemainingTracker: ctx.deferredObjectiveHoursRemainingTracker,
    evaluateHeadroomForDevice: (params) => ctx.evaluateHeadroomForDevice(params),
    getCombinedHourlyPrices: () => requirePriceCoordinator(ctx).getCombinedHourlyPrices(),
    getTimeZone: () => ctx.getTimeZone(),
    getNow: () => ctx.getNow(),
    getStructuredLogger: (component) => ctx.getStructuredLogger(component),
  });
}
