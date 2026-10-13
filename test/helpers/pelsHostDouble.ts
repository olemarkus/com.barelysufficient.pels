import { vi } from 'vitest';
import type { PelsHost } from '../../lib/app/pelsHost';
import { createPlanStatusRegistry } from '../../lib/plan/planStatusRegistry';
import { createEmptyPowerCalibrationSnapshot } from '../../lib/device/devicePowerCalibration';
import { NO_PRICE_SOURCE_PAYLOADS } from '../../setup/settingsUiApi';
import { createFixturePriorityQuery } from './modePriorityFixtures';
import { observedDeviceReadsDouble } from './observedDeviceReadsDouble';

const notWired = (member: string) => (): never => {
  throw new Error(`pelsHostDouble: ${member} is not wired in this fixture`);
};

/**
 * The running app as `homey.app` carries it, for a fixture that only cares
 * about a few members: the members it provides win, and every other member is
 * an inert default — nothing measured, nothing stored, every optional service
 * handle absent, and a command that throws if a spec reaches it unprepared.
 *
 * The defaults sit on the double's PROTOTYPE, and the fixture's own property
 * descriptors are copied onto it rather than spread, so a fixture's getters (a
 * `powerTracker` a spec reassigns) stay live.
 */
export const pelsHostDouble = <T extends object>(fixture: T): T & PelsHost => {
  const defaults: PelsHost = {
    log: vi.fn(),
    error: vi.fn(),
    planStatuses: createPlanStatusRegistry(),
    deviceManager: undefined,
    planService: undefined,
    priceCoordinator: undefined,
    batteryControl: undefined,
    homeMembership: undefined,
    homeRuntimeRead: { readHome: () => ({ state: 'unavailable' }) },
    powerTracker: {},
    getTrackerStore: notWired('getTrackerStore'),
    observer: observedDeviceReadsDouble(),
    isSurplusPoolReachable: () => false,
    getLatestPlanSnapshotForUi: () => null,
    getPowerCalibrationSnapshot: () => createEmptyPowerCalibrationSnapshot(),
    refreshTargetDevicesSnapshot: async () => undefined,
    getCapacityScalars: notWired('getCapacityScalars'),
    getCurrentMonthCapacityPeakKw: () => null,
    getPriceSourcePayloadsForUi: () => NO_PRICE_SOURCE_PAYLOADS,
    getPvForecastSourceUiStatus: () => ({ kind: 'unknown' }),
    getHomeyPriceFormulaUiStatus: () => ({ kind: 'unknown' }),
    getPowerhourSourceUiStatus: () => ({ kind: 'unknown' }),
    getModePrioritiesForUi: createFixturePriorityQuery(),
    getSettingsUiManagedDevices: () => [],
    refreshFlowConflictsForUi: notWired('refreshFlowConflictsForUi'),
    replacePowerTrackerForUi: notWired('replacePowerTrackerForUi'),
    readHardCapConfiguration: () => ({ state: 'unavailable' }),
    readPriceOptimizationSetup: () => ({ state: 'unavailable' }),
    readPriceSetup: () => ({ state: 'unavailable' }),
    suggestPriceSetup: async () => ({ gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'none' } }),
    readPriceLevelSummary: () => ({ state: 'unavailable' }),
    previewDailyBudgetModel: notWired('previewDailyBudgetModel'),
    applyDailyBudgetModel: notWired('applyDailyBudgetModel'),
    getDeviceDiagnosticsUiPayload: () => ({ generatedAt: 0, windowDays: 21, diagnosticsByDeviceId: {} }),
    getDeviceLogUiPayload: () => ({ version: 1, entriesByDeviceId: {} }),
    getWeatherAdvisorReadout: async () => ({ kind: 'inactive' }),
    createDeferredObjective: notWired('createDeferredObjective'),
    createNewDeferredObjective: notWired('createNewDeferredObjective'),
    cancelDeferredObjective: notWired('cancelDeferredObjective'),
    getApiStructuredLogger: () => undefined,
    getCreateSmartTaskCandidateDevices: () => ({ state: 'unavailable' }),
    resolveSmartTaskHomeScope: () => 'unavailable',
    previewDeferredObjectivePlan: notWired('previewDeferredObjectivePlan'),
    getStarvedRescueDevices: () => [],
    previewStarvationRescuePlan: notWired('previewStarvationRescuePlan'),
    rescueDeviceWithBudgetExemption: notWired('rescueDeviceWithBudgetExemption'),
    getDailyBudgetUiPayload: () => ({ kind: 'unavailable' }),
    getCombinedPricesForUi: () => null,
    getPriceTimelineForUi: () => ({ state: 'unavailable', reason: 'no_prices' }),
    getDeferredObjectiveActivePlansUiPayload: () => null,
    getDeferredObjectivePlanHistoryRecentUiPayload: () => ({ version: 1, entriesByDeviceId: {} }),
    getDeferredObjectivePlanHistoryUiPayload: () => ({ version: 1, entriesByDeviceId: {} }),
    getUiPickerDevices: () => [],
  };
  return Object.defineProperties(
    Object.create(defaults) as T & PelsHost,
    Object.getOwnPropertyDescriptors(fixture),
  );
};
