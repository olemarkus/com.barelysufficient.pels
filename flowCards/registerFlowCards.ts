import { PriceLevel } from '../lib/price/priceLevels';
import CapacityGuard from '../lib/power/capacityGuard';
import type { DecoratedDeviceSnapshot } from '../packages/contracts/src/types';
import type { DeferredObjectiveActivePlansV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { FlowHomeyLike, HomeyDeviceLike } from '../lib/utils/types';
import type { ReportSteppedLoadActualStepResult } from '../setup/appDeviceControlHelpers';
import { registerExpectedPowerCard } from './expectedPower';
import { registerEvChargingPhaseCard } from './evChargingPhaseCard';
import type { HeadroomCardDeviceLike, HeadroomForDeviceDecision } from '../lib/plan/planHeadroomDevice';
import type { FlowReportedCapabilityId } from '../lib/device/transport/flowReportedCapabilities';
import type { FlowBackedCapabilityReportOutcome } from '../lib/app/appContext';
import { startRuntimeSpan } from '../lib/utils/runtimeTrace';
import type { CombinedHourlyPrice } from '../lib/price/priceTypes';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../lib/logging/logger';
import {
  registerBudgetExemptionCards,
  registerBudgetExemptionCondition,
  registerCapacityControlCondition,
  registerDeviceCapacityControlCards,
  registerManagedDeviceCondition,
} from './deviceSettingsCards';
import { registerFlowBackedDeviceCards } from './flowBackedDeviceCards';
import { registerDeadlineObjectiveCards } from './deadlineObjectiveCards';
import { registerAllowSmartTaskRescueCard } from './smartTaskRescueCard';
import { requestPlanRebuildFromFlow } from './flowCardShared';
import { registerCapacityAndModeCards, registerOperatingModeChangedTrigger } from './modeCards';
import {
  registerFlowPriceCards,
  registerLowestPriceCards,
  registerPriceLevelCards,
} from './priceFlowCards';
import { registerEvSocCard, registerHeadroomForDeviceCard } from './headroomAndEvSocCards';
import { registerSteppedLoadCards } from './steppedLoadFlowCards';
import type {
  DeferredObjectiveEndedBus,
  DeferredObjectiveHoursRemainingBus,
  DeferredObjectiveHoursRemainingTracker,
  DeferredObjectivePlanRevisionBus,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
  DeferredObjectiveStatusBus,
  ObjectiveWriteOutcome,
} from '../lib/objectives/deferredObjectives';

// Device-scoped objective writes the Flow cards delegate to. Both write the
// target device's OWN settings key + run the shared notify/flush/rebuild
// chokepoint in `lib/objectives/deferredObjectives/objectiveWrite.ts` (wired with the
// app's recorders in appInit). A per-key write touches only that one device, so
// it cannot clobber a sibling task. It can still REFUSE on a transient
// un-confirmable migration or untrustworthy absence read, so the wrappers
// forward the `ObjectiveWriteOutcome`; the Flow cards throw on a refusal so
// Homey surfaces a retryable failure rather than a silent (false) success.
export type UpsertDeferredObjectiveForDevice = (params: {
  deviceId: string;
  deviceName: string | null;
  entry: DeferredObjectiveSettingsEntry;
  rescue?: 'preserve' | 'replace';
}) => ObjectiveWriteOutcome;
export type ClearDeferredObjectiveForDevice = (params: {
  deviceId: string;
  deviceName: string | null;
}) => ObjectiveWriteOutcome;

export type FlowCardDeps = {
  homey: FlowHomeyLike;
  areFlowBackedCardsAvailable?: () => boolean;
  structuredLog?: {
    info: (payload: Record<string, unknown>) => void;
  };
  resolveModeName: (mode: string) => string;
  getAllModes: () => Set<string>;
  getCurrentOperatingMode: () => string;
  handleOperatingModeChange: (rawMode: string) => Promise<void>;
  getCurrentPriceLevel: () => PriceLevel;
  recordPowerSample: (powerW: number) => Promise<void>;
  getCapacityGuard: () => CapacityGuard | undefined;
  getHeadroom: () => number | null;
  setCapacityLimit: (kw: number) => void;
  // Decorated: the runtime snapshot carries the app-layer step-command
  // decoration (`desiredStepId` / `targetStepId`) that the clamp-deviation
  // check reads. The runtime already returns decorated objects; the type just
  // stops narrowing them away.
  getSnapshot: () => Promise<DecoratedDeviceSnapshot[]>;
  refreshSnapshot: (options?: { emitFlowBackedRefresh?: boolean }) => Promise<void>;
  getHomeyDevicesForFlow: () => Promise<HomeyDeviceLike[]>;
  reportFlowBackedCapability: (params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    value: boolean | number | string;
  }) => FlowBackedCapabilityReportOutcome;
  reportSteppedLoadActualStep: (
    deviceId: string,
    stepId: string,
  ) => Promise<ReportSteppedLoadActualStepResult> | ReportSteppedLoadActualStepResult;
  getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
  setExpectedOverride: (deviceId: string, kw: number) => boolean;
  storeFlowPriceData: (kind: 'today' | 'tomorrow', raw: unknown) => {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  };
  rebuildPlan: (source: string) => void;
  getDeferredObjectiveSettings?: () => DeferredObjectiveSettingsV1;
  // Required — the deadline / clear / rescue cards write each device's own
  // settings key through these (a per-key write cannot clobber a sibling).
  // Non-optional so a missing wiring is a build error, not a silent no-op.
  // Production always wires these via appInit.
  upsertDeferredObjectiveForDevice: UpsertDeferredObjectiveForDevice;
  clearDeferredObjectiveForDevice: ClearDeferredObjectiveForDevice;
  getDeferredObjectiveActivePlans?: () => DeferredObjectiveActivePlansV1 | null;
  getDeferredObjectiveStatusBus?: () => DeferredObjectiveStatusBus | undefined;
  getDeferredObjectivePlanRevisionBus?: () => DeferredObjectivePlanRevisionBus | undefined;
  getDeferredObjectiveEndedBus?: () => DeferredObjectiveEndedBus | undefined;
  getDeferredObjectiveHoursRemainingBus?: () => DeferredObjectiveHoursRemainingBus | undefined;
  getDeferredObjectiveHoursRemainingTracker?: () => DeferredObjectiveHoursRemainingTracker | undefined;
  evaluateHeadroomForDevice: (params: {
    devices: HeadroomCardDeviceLike[];
    deviceId: string;
    device?: HeadroomCardDeviceLike;
    headroom: number;
    requiredKw: number;
    cleanupMissingDevices?: boolean;
  }) => HeadroomForDeviceDecision | null;
  loadDailyBudgetSettings: () => void;
  updateDailyBudgetState: (options?: { forcePlanRebuild?: boolean }) => void;
  getCombinedHourlyPrices: () => CombinedHourlyPrice[];
  getTimeZone: () => string;
  getNow: () => Date;
  getStructuredLogger: (component: string) => PinoLogger | undefined;
  debugStructured: StructuredDebugEmitter;
};

export function registerFlowCards(deps: FlowCardDeps): void {
  const stopSpan = startRuntimeSpan('flow_cards_register');
  const { homey } = deps;
  try {
    registerExpectedPowerCard(homey, {
      getSnapshot: () => deps.getSnapshot(),
      getDeviceLoadSetting: (deviceId) => deps.getDeviceLoadSetting(deviceId),
      setExpectedOverride: (deviceId, kw) => deps.setExpectedOverride(deviceId, kw),
      refreshSnapshot: () => deps.refreshSnapshot(),
      rebuildPlan: () => requestPlanRebuildFromFlow(deps, 'expected_power'),
      getStructuredLogger: (component: string) => deps.getStructuredLogger(component),
    });

    registerOperatingModeChangedTrigger(deps);
    registerPriceLevelCards(deps);
    registerHeadroomForDeviceCard(deps);
    registerCapacityAndModeCards(deps);
    registerEvSocCard(deps);
    if (deps.areFlowBackedCardsAvailable?.() !== false) {
      registerFlowBackedDeviceCards(deps);
    }
    registerSteppedLoadCards(deps);
    registerEvChargingPhaseCard(deps);
    registerDeviceCapacityControlCards(deps);
    registerBudgetExemptionCards(deps);
    registerManagedDeviceCondition(deps);
    registerCapacityControlCondition(deps);
    registerBudgetExemptionCondition(deps);
    registerFlowPriceCards(deps);
    registerLowestPriceCards(deps);
    registerDeadlineObjectiveCards(deps);
    registerAllowSmartTaskRescueCard(deps);
  } finally {
    stopSpan();
  }
}
