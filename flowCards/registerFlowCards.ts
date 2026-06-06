/* eslint-disable max-lines -- Flow card registration stays centralized in this module. */
import { PriceLevel, PRICE_LEVEL_OPTIONS, PriceLevelOption } from '../lib/price/priceLevels';
import CapacityGuard from '../lib/power/capacityGuard';
import type { DecoratedDeviceSnapshot, TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { DeferredObjectiveActivePlansV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { FlowHomeyLike, HomeyDeviceLike } from '../lib/utils/types';
import type { ReportSteppedLoadActualStepResult } from '../lib/app/appDeviceControlHelpers';
import { registerExpectedPowerCard } from './expectedPower';
import { registerEvChargingPhaseCard } from './evChargingPhaseCard';
import type { HeadroomCardDeviceLike, HeadroomForDeviceDecision } from '../lib/plan/planHeadroomDevice';
import type { FlowReportedCapabilityId } from '../lib/device/transport/flowReportedCapabilities';
import type { FlowBackedCapabilityReportOutcome } from '../lib/app/appContext';
import {
  CAPACITY_LIMIT_KW,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
} from '../lib/utils/settingsKeys';
import { MAX_DAILY_BUDGET_KWH, MIN_DAILY_BUDGET_KWH } from '../lib/dailyBudget/dailyBudgetConstants';
import { incPerfCounters } from '../lib/utils/perfCounters';
import { startRuntimeSpan } from '../lib/utils/runtimeTrace';
import { normalizeError } from '../lib/utils/errorUtils';
import { evaluateLowestPriceCard, type LowestPriceCardId } from '../lib/price/priceLowestFlowEvaluator';
import type { CombinedHourlyPrice } from '../lib/price/priceTypes';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../lib/logging/logger';
import { emitGated } from '../lib/logging/deviationGate';
import type { LogDedupeEntry } from '../lib/logging/logDedupe';
import { PELS_MEASURE_STEP_CAPABILITY_ID } from '../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { isNativeSteppedLoadControlEnabled } from '../lib/device/nativeSteppedLoadWiring';
import {
  registerBudgetExemptionCards,
  registerBudgetExemptionCondition,
  registerCapacityControlCondition,
  registerDeviceCapacityControlCards,
  registerManagedDeviceCondition,
} from './deviceSettingsCards';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import {
  readFlowDeviceArg,
  readFlowNumberArg,
  readFlowRawArg,
  readFlowStringArg,
} from './flowArgParsers';
import { registerFlowBackedDeviceCards } from './flowBackedDeviceCards';
import { registerDeadlineObjectiveCards } from './deadlineObjectiveCards';
import { registerAllowSmartTaskRescueCard } from './smartTaskRescueCard';
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

const STEPPED_LOAD_POWER_CEILING_MARGIN_RATIO = 0.05;
const STEPPED_LOAD_POWER_CEILING_MARGIN_MAX_W = 150;
const EV_CHARGER_NOMINAL_VOLTAGE = 230;
const EV_SOC_CARD_ID = 'report_evcharger_battery_level';
// Per-device dedupe for the clamp-deviation warn: a stuck clamp emits once + a
// slow heartbeat instead of one line per inbound report. Bounded by device
// count; `shouldEmitOnChange` prunes idle entries (default 10 min window).
const STEPPED_LOAD_CLAMP_HEARTBEAT_MS = 10 * 60 * 1000;
const steppedLoadClampDedupe = new Map<string, LogDedupeEntry>();

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
  log: (...args: unknown[]) => void;
  debugStructured: StructuredDebugEmitter;
  error: (...args: unknown[]) => void;
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
      log: (...args: unknown[]) => deps.log(...args),
    });

    const operatingModeChangedTrigger = homey.flow.getTriggerCard('operating_mode_changed');
    operatingModeChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
      const chosenMode = deps.resolveModeName(readFlowStringArg(args, 'mode'));
      const stateMode = deps.resolveModeName(readFlowStringArg(state, 'mode'));
      if (!chosenMode || !stateMode) return false;
      return chosenMode.toLowerCase() === stateMode.toLowerCase();
    });
    operatingModeChangedTrigger.registerArgumentAutocompleteListener('mode', async (query: string) => (
      getModeOptions(deps, query)
    ));

    const priceLevelChangedTrigger = homey.flow.getTriggerCard('price_level_changed');
    priceLevelChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
      const chosenLevel = readPriceLevelArg(args);
      const statePriceLevel = readFlowStringArg(state, 'priceLevel');
      const stateLevel = (statePriceLevel.toLowerCase() || PriceLevel.UNKNOWN) as PriceLevel;
      return chosenLevel === stateLevel;
    });
    priceLevelChangedTrigger.registerArgumentAutocompleteListener('level', async (query: string) => (
      getPriceLevelOptions(query)
    ));

    const priceLevelIsCond = homey.flow.getConditionCard('price_level_is');
    priceLevelIsCond.registerRunListener(async (args: unknown) => {
      const chosenLevel = readPriceLevelArg(args);
      const currentLevel = deps.getCurrentPriceLevel();
      return chosenLevel === currentLevel;
    });
    priceLevelIsCond.registerArgumentAutocompleteListener('level', async (query: string) => (
      getPriceLevelOptions(query)
    ));

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

function registerSteppedLoadCards(deps: FlowCardDeps): void {
  const desiredChangedTrigger = deps.homey.flow.getTriggerCard('desired_stepped_load_changed');
  desiredChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const chosenDeviceId = readFlowDeviceArg(args);
    const stateDeviceId = readFlowStringArg(state, 'deviceId');
    if (!chosenDeviceId || !stateDeviceId) return false;
    return chosenDeviceId === stateDeviceId;
  });
  desiredChangedTrigger.registerArgumentAutocompleteListener('device', async (query: string) => (
    getSteppedLoadDeviceOptions(deps, query)
  ));

  registerReportActualStepCard(deps);
  registerReportActualPowerCard(deps);
}

function registerReportActualStepCard(deps: FlowCardDeps): void {
  const reportActualStepCard = deps.homey.flow.getActionCard('report_stepped_load_actual_step');
  reportActualStepCard.registerRunListener(async (args: unknown) => {
    const deviceId = readFlowDeviceArg(args);
    const stepId = readFlowStringArg(args, 'step');
    const sourceCardId = 'report_stepped_load_actual_step';
    emitSteppedLoadReportReceivedLog({
      deps,
      sourceCardId,
      deviceId,
      reportedStepId: stepId || null,
    });
    try {
      if (!deviceId) {
        throw createSteppedLoadReportError('device_missing', 'Device must be provided.');
      }
      const nativeIgnored = await resolveNativeSteppedLoadFlowReportIgnore(deps, deviceId);
      if (nativeIgnored) {
        emitSteppedLoadReportResolvedLog({
          deps,
          sourceCardId,
          deviceId,
          deviceName: nativeIgnored.deviceName,
          resolvedStepId: stepId || null,
          outcome: 'unchanged',
          reasonCode: 'native_wiring_enabled',
        });
        return true;
      }
      if (!stepId) {
        throw createSteppedLoadReportError('step_missing', 'Step must be provided.');
      }
      const result = await deps.reportSteppedLoadActualStep(deviceId, stepId);
      const deviceName = await getBestEffortSteppedLoadDeviceName(deps, deviceId);
      await handleSteppedLoadReportResult({
        deps,
        result,
        source: sourceCardId,
        deviceId,
        deviceName,
        resolvedStepId: stepId,
      });
      return true;
    } catch (error) {
      emitSteppedLoadReportRejectedLog({
        deps,
        sourceCardId,
        deviceId,
        reportedStepId: stepId || null,
        error,
      });
      throw error;
    }
  });
  reportActualStepCard.registerArgumentAutocompleteListener('device', async (query: string) => (
    getSteppedLoadDeviceOptions(deps, query)
  ));
  reportActualStepCard.registerArgumentAutocompleteListener(
    'step',
    async (query: string, args?: Record<string, unknown>) => {
      const deviceId = readFlowDeviceArg(args);
      if (!deviceId) return [];
      const snapshot = await deps.getSnapshot();
      const device = snapshot.find((entry) => entry.id === deviceId && entry.controlModel === 'stepped_load');
      const steps = device?.steppedLoadProfile?.steps ?? [];
      const q = (query || '').toLowerCase();
      return steps
        .filter((step) => !q || step.id.toLowerCase().includes(q))
        .map((step) => ({ id: step.id, name: `${step.id} (${step.planningPowerW} W)` }));
    },
  );
}

function registerReportActualPowerCard(deps: FlowCardDeps): void {
  const reportActualPowerCard = deps.homey.flow.getActionCard('report_stepped_load_power');
  reportActualPowerCard.registerRunListener(async (args: unknown) => {
    const deviceId = readFlowDeviceArg(args);
    const rawPower = readFlowRawArg(args, 'power_w');
    const sourceCardId = 'report_stepped_load_power';
    emitSteppedLoadReportReceivedLog({
      deps,
      sourceCardId,
      deviceId,
      rawPowerInput: formatFlowValueForLog(rawPower),
    });
    try {
      if (!deviceId) {
        throw createSteppedLoadReportError('device_missing', 'Device must be provided.');
      }
      const nativeIgnored = await resolveNativeSteppedLoadFlowReportIgnore(deps, deviceId);
      if (nativeIgnored) {
        emitSteppedLoadReportResolvedLog({
          deps,
          sourceCardId,
          deviceId,
          deviceName: nativeIgnored.deviceName,
          resolvedStepId: null,
          outcome: 'unchanged',
          reasonCode: 'native_wiring_enabled',
        });
        return true;
      }
      const { stepId, deviceName, parsedPowerW } = await resolveSteppedLoadStepIdFromPowerInput({
        deps,
        deviceId,
        rawPower,
      });
      const result = await deps.reportSteppedLoadActualStep(deviceId, stepId);
      await handleSteppedLoadReportResult({
        deps,
        result,
        source: sourceCardId,
        deviceId,
        deviceName,
        resolvedStepId: stepId,
        parsedPowerW,
      });
      return true;
    } catch (error) {
      emitSteppedLoadReportRejectedLog({
        deps,
        sourceCardId,
        deviceId,
        rawPowerInput: formatFlowValueForLog(rawPower),
        error,
      });
      throw error;
    }
  });
  reportActualPowerCard.registerArgumentAutocompleteListener('device', async (query: string) => (
    getSteppedLoadDeviceOptions(deps, query)
  ));
}

async function handleSteppedLoadReportResult(params: {
  deps: FlowCardDeps;
  result: ReportSteppedLoadActualStepResult;
  source: string;
  deviceId: string;
  deviceName: string;
  resolvedStepId: string;
  parsedPowerW?: number;
}): Promise<void> {
  const {
    deps,
    result,
    source,
    deviceId,
    deviceName,
    resolvedStepId,
    parsedPowerW,
  } = params;
  if (result === 'invalid') {
    throw createSteppedLoadReportError(
      'invalid_step',
      'Device is not configured as a stepped load, or the reported step is invalid.',
    );
  }
  if (result === 'unchanged') {
    emitSteppedLoadReportResolvedLog({
      deps,
      sourceCardId: source,
      deviceId,
      deviceName,
      resolvedStepId,
      parsedPowerW,
      outcome: 'unchanged',
    });
    await emitSteppedLoadClampDeviationLog({
      deps, sourceCardId: source, deviceId, reportedStepId: resolvedStepId, parsedPowerW, now: deps.getNow().getTime(),
    });
    return;
  }
  await deps.refreshSnapshot();
  requestPlanRebuildFromFlow(deps, source);
  emitSteppedLoadReportResolvedLog({
    deps,
    sourceCardId: source,
    deviceId,
    deviceName,
    resolvedStepId,
    parsedPowerW,
    outcome: 'accepted',
  });
  await emitSteppedLoadClampDeviationLog({
    deps, sourceCardId: source, deviceId, reportedStepId: resolvedStepId, parsedPowerW, now: deps.getNow().getTime(),
  });
}

async function resolveNativeSteppedLoadFlowReportIgnore(
  deps: FlowCardDeps,
  deviceId: string,
): Promise<{ deviceName: string } | null> {
  try {
    const snapshot = await deps.getSnapshot();
    const device = snapshot.find((entry) => entry.id === deviceId);
    if (!device || !isNativeSteppedLoadControlEnabled(device)) return null;
    return { deviceName: device.name.trim() || deviceId };
  } catch {
    return null;
  }
}

async function resolveSteppedLoadStepIdFromPowerInput(params: {
  deps: FlowCardDeps;
  deviceId: string;
  rawPower: unknown;
}): Promise<{ stepId: string; deviceName: string; parsedPowerW: number }> {
  const { deps, deviceId, rawPower } = params;
  const device = await getSteppedLoadDeviceSnapshot(deps, deviceId);
  const powerW = parseSteppedLoadPowerInput({
    rawPower,
    device,
  });
  if (powerW === null) {
    throw createSteppedLoadReportError(
      'invalid_power_input',
      'Power must be provided as a number or text like "1750 W" or "6 A".',
    );
  }
  const steps = device?.steppedLoadProfile?.steps ?? [];
  const resolvedStep = resolveSteppedLoadStepFromPower(steps, powerW);
  if (!resolvedStep) {
    throw createSteppedLoadReportError(
      'no_matching_step',
      buildNoMatchingSteppedLoadPowerMessage(steps, powerW),
    );
  }
  if (resolvedStep === 'ambiguous') {
    throw createSteppedLoadReportError(
      'multiple_matching_steps',
      `Multiple configured stepped-load steps match ${powerW} W. Report the step directly instead.`,
    );
  }
  return {
    stepId: resolvedStep.id,
    deviceName: device.name.trim(),
    parsedPowerW: powerW,
  };
}

function parseSteppedLoadPowerInput(params: {
  rawPower: unknown;
  device: TargetDeviceSnapshot;
}): number | null {
  const { rawPower, device } = params;
  if (typeof rawPower === 'number' && Number.isFinite(rawPower)) {
    return Math.round(rawPower);
  }

  const normalized = String(rawPower ?? '').trim();
  if (!normalized) return null;

  const match = normalized.match(/^(-?\d+(?:[.,]\d+)?)\s*([WwAa])?$/);
  if (!match) return null;

  const value = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;

  const unit = match[2]?.toLowerCase();
  if (unit === 'a') {
    const phaseCount = resolveEvTargetPowerPhaseCount(device.targetPowerConfig);
    if (!phaseCount) {
      throw createSteppedLoadReportError(
        'invalid_power_input',
        'Amp reports are only supported for EV charger target-power presets.',
      );
    }
    return Math.round(value * EV_CHARGER_NOMINAL_VOLTAGE * phaseCount);
  }

  return Math.round(value);
}

function resolveEvTargetPowerPhaseCount(
  config: TargetDeviceSnapshot['targetPowerConfig'],
): 1 | 3 | null {
  if (!config || config.enabled === false) return null;
  if (config.preset === 'ev_charger_1_phase') return 1;
  if (config.preset === 'ev_charger_3_phase') return 3;
  return null;
}

function resolveSteppedLoadStepFromPower(
  steps: Array<{ id: string; planningPowerW: number }>,
  powerW: number,
): { id: string } | 'ambiguous' | null {
  const roundedSteps = steps.map((step) => ({
    step,
    roundedPowerW: Math.round(step.planningPowerW),
  }));
  const exactMatches = roundedSteps.filter(({ roundedPowerW }) => roundedPowerW === powerW);
  if (exactMatches.length === 1) return exactMatches[0].step;
  if (exactMatches.length > 1) return 'ambiguous';

  const ceilingMatches = roundedSteps
    .filter(({ roundedPowerW }) => {
      const deficitW = roundedPowerW - powerW;
      return deficitW >= 0 && deficitW <= getSteppedLoadPowerCeilingMarginW(roundedPowerW);
    })
    .sort((left, right) => (
      left.roundedPowerW - right.roundedPowerW || left.step.id.localeCompare(right.step.id)
    ));
  if (ceilingMatches.length === 0) return null;

  const nearestCeilingPowerW = ceilingMatches[0].roundedPowerW;
  const nearestMatches = ceilingMatches.filter(({ roundedPowerW }) => roundedPowerW === nearestCeilingPowerW);
  if (nearestMatches.length > 1) return 'ambiguous';

  return nearestMatches[0].step;
}

function getSteppedLoadPowerCeilingMarginW(stepPowerW: number): number {
  return Math.min(
    STEPPED_LOAD_POWER_CEILING_MARGIN_MAX_W,
    Math.max(0, stepPowerW * STEPPED_LOAD_POWER_CEILING_MARGIN_RATIO),
  );
}

function buildNoMatchingSteppedLoadPowerMessage(
  steps: Array<{ id: string; planningPowerW: number }>,
  powerW: number,
): string {
  const roundedSteps = steps
    .map((step) => ({ step, roundedPowerW: Math.round(step.planningPowerW) }))
    .sort((left, right) => (
      left.roundedPowerW - right.roundedPowerW || left.step.id.localeCompare(right.step.id)
    ));
  const closestUpward = roundedSteps.find(({ roundedPowerW }) => roundedPowerW >= powerW);
  if (closestUpward) {
    const marginW = getSteppedLoadPowerCeilingMarginW(closestUpward.roundedPowerW);
    const deficitW = closestUpward.roundedPowerW - powerW;
    return `No configured stepped-load step matches ${powerW} W. `
      + `Closest upward step is '${closestUpward.step.id}' at ${closestUpward.roundedPowerW} W, `
      + `with an allowed margin of ${formatWattsForMessage(marginW)} W below the step; `
      + `this report is ${formatWattsForMessage(deficitW)} W below.`;
  }

  const highest = roundedSteps.at(-1);
  if (highest) {
    return `No configured stepped-load step matches ${powerW} W. `
      + `No upward step exists; highest configured step is '${highest.step.id}' at ${highest.roundedPowerW} W.`;
  }

  return `No configured stepped-load step matches ${powerW} W. No configured steps are available.`;
}

function formatWattsForMessage(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

async function getBestEffortSteppedLoadDeviceName(
  deps: FlowCardDeps,
  deviceId: string,
): Promise<string> {
  try {
    const snapshot = await deps.getSnapshot();
    return snapshot.find((entry) => entry.id === deviceId)?.name.trim() || deviceId;
  } catch {
    return deviceId;
  }
}

type SteppedLoadReportErrorCode =
  | 'device_missing'
  | 'device_not_found'
  | 'step_missing'
  | 'invalid_power_input'
  | 'not_stepped_load'
  | 'invalid_step'
  | 'no_matching_step'
  | 'multiple_matching_steps';

class SteppedLoadReportError extends Error {
  constructor(
    readonly code: SteppedLoadReportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SteppedLoadReportError';
  }
}

function createSteppedLoadReportError(code: SteppedLoadReportErrorCode, message: string): Error {
  return new SteppedLoadReportError(code, message);
}

async function getSteppedLoadDeviceSnapshot(
  deps: FlowCardDeps,
  deviceId: string,
): Promise<TargetDeviceSnapshot & { controlModel: 'stepped_load' }> {
  const snapshot = await deps.getSnapshot();
  const device = snapshot.find((entry) => entry.id === deviceId);
  if (!device) {
    throw createSteppedLoadReportError('device_not_found', `Device '${deviceId}' was not found in the snapshot.`);
  }
  if (device.controlModel !== 'stepped_load' || !device.steppedLoadProfile) {
    throw createSteppedLoadReportError(
      'not_stepped_load',
      `Device '${device.name.trim()}' is not configured as a stepped load.`,
    );
  }
  return device as TargetDeviceSnapshot & { controlModel: 'stepped_load' };
}

function emitSteppedLoadReportReceivedLog(params: {
  deps: FlowCardDeps;
  sourceCardId: string;
  deviceId?: string;
  reportedStepId?: string | null;
  rawPowerInput?: string | number | null;
}): void {
  params.deps.getStructuredLogger('devices')?.info({
    event: 'stepped_load_report_received',
    sourceCardId: params.sourceCardId,
    deviceId: params.deviceId ?? null,
    capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    reportedStepId: params.reportedStepId ?? null,
    rawPowerInput: params.rawPowerInput ?? null,
  });
}

function emitSteppedLoadReportResolvedLog(params: {
  deps: FlowCardDeps;
  sourceCardId: string;
  deviceId: string;
  deviceName: string;
  resolvedStepId: string | null;
  parsedPowerW?: number;
  outcome: 'accepted' | 'unchanged' | 'rejected';
  reasonCode?: string;
}): void {
  params.deps.getStructuredLogger('devices')?.info({
    event: 'stepped_load_report_resolved',
    sourceCardId: params.sourceCardId,
    deviceId: params.deviceId,
    deviceName: params.deviceName,
    capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    resolvedStepId: params.resolvedStepId,
    parsedPowerW: params.parsedPowerW ?? null,
    outcome: params.outcome,
    reasonCode: params.reasonCode ?? null,
  });
}

function emitSteppedLoadReportRejectedLog(params: {
  deps: FlowCardDeps;
  sourceCardId: string;
  deviceId?: string;
  reportedStepId?: string | null;
  rawPowerInput?: string | number | null;
  error: unknown;
}): void {
  const normalizedError = normalizeError(params.error);
  const reasonCode = params.error instanceof SteppedLoadReportError
    ? params.error.code
    : 'unexpected_error';
  params.deps.getStructuredLogger('devices')?.warn({
    event: 'stepped_load_report_rejected',
    sourceCardId: params.sourceCardId,
    deviceId: params.deviceId ?? null,
    capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    reportedStepId: params.reportedStepId ?? null,
    rawPowerInput: params.rawPowerInput ?? null,
    reasonCode,
    errorMessage: normalizedError.message,
  });
}

function formatFlowValueForLog(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Deviation-gated diagnostic: when a stepped load reports materially less power
 * than the step PELS is holding it at, the device is clamping (e.g. an EV
 * charger limited below its commanded current). The routine accepted/unchanged
 * report is already logged at info; this adds ONE self-contained warn that joins
 * the *commanded* step to the *reported* power so the clamp is diagnosable from a
 * no-debug 100-line report without a reproduce round-trip.
 *
 * A downward shortfall beyond the configured ceiling margin is the signal;
 * upward reports and within-margin wobble route to nothing extra.
 */
async function emitSteppedLoadClampDeviationLog(params: {
  deps: FlowCardDeps;
  sourceCardId: string;
  deviceId: string;
  reportedStepId: string;
  parsedPowerW?: number;
  now: number;
}): Promise<void> {
  const {
    deps, sourceCardId, deviceId, reportedStepId, parsedPowerW, now,
  } = params;
  // Best-effort diagnostic: a failure here (e.g. a transient snapshot read)
  // must never turn an accepted report into a rejected one.
  let snapshot: DecoratedDeviceSnapshot[];
  try {
    snapshot = await deps.getSnapshot();
  } catch {
    return;
  }
  const device = snapshot.find((entry) => entry.id === deviceId);
  if (!device) return;
  // A still-pending step command means the device may simply be mid-ramp toward
  // the commanded step — a lower report is expected, not a clamp. Only judge a
  // settled command.
  if (device.stepCommandPending === true) return;
  const commandedStepId = device.desiredStepId ?? device.targetStepId;
  if (!commandedStepId || commandedStepId === reportedStepId) return;
  const steps = device.steppedLoadProfile?.steps ?? [];
  const commandedStep = steps.find((step) => step.id === commandedStepId);
  if (!commandedStep) return;
  const reportedStep = steps.find((step) => step.id === reportedStepId);
  const reportedW = parsedPowerW
    ?? (reportedStep ? Math.round(reportedStep.planningPowerW) : undefined);
  if (reportedW === undefined) return;
  const expectedW = Math.round(commandedStep.planningPowerW);
  const deltaW = expectedW - Math.round(reportedW);
  if (deltaW <= getSteppedLoadPowerCeilingMarginW(expectedW)) return;

  emitGated({
    logger: deps.getStructuredLogger('devices'),
    debugEmitter: () => {},
    event: 'stepped_load_report_clamp_detected',
    surprise: { level: 'warn', reasonCode: 'stepped_load_clamp' },
    dedupe: {
      state: steppedLoadClampDedupe,
      key: deviceId,
      now,
      repeatAfterMs: STEPPED_LOAD_CLAMP_HEARTBEAT_MS,
    },
    fields: {
      component: 'devices',
      sourceCardId,
      deviceId,
      deviceName: device.name,
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      commandedStepId,
      reportedStepId,
      expectedW,
      reportedW: Math.round(reportedW),
      deltaW,
    },
  });
}
function registerFlowPriceCards(deps: FlowCardDeps): void {
  const setTodayCard = deps.homey.flow.getActionCard('set_external_prices_today');
  setTodayCard.registerRunListener(createPriceCardRunListener('today', deps));

  const setTomorrowCard = deps.homey.flow.getActionCard('set_external_prices_tomorrow');
  setTomorrowCard.registerRunListener(createPriceCardRunListener('tomorrow', deps));
}

function createPriceCardRunListener(kind: 'today' | 'tomorrow', deps: FlowCardDeps) {
  return async (args: unknown) => {
    try {
      const raw = readFlowRawArg(args, 'prices_json');
      if (raw === null || raw === undefined || String(raw).trim() === '') {
        throw new Error('Price data is required.');
      }
      const result = deps.storeFlowPriceData(kind, raw);
      deps.getStructuredLogger('price')?.info({
        event: 'flow_prices_stored',
        priceKind: kind,
        dateKey: result.dateKey,
        storedCount: result.storedCount,
      });
      return true;
    } catch (error) {
      const normalizedError = normalizeError(error);
      deps.error(`Flow: Failed to store ${kind} prices from flow tag.`, normalizedError);
      throw normalizedError;
    }
  };
}

function registerLowestPriceCards(deps: FlowCardDeps): void {
  const cardIds: LowestPriceCardId[] = ['price_lowest_before', 'price_lowest_today'];

  for (const cardId of cardIds) {
    const conditionCard = deps.homey.flow.getConditionCard(cardId);
    conditionCard.registerRunListener(async (args: unknown) => (
      evaluateLowestPriceFlowCard(cardId, args, 'condition', deps)
    ));

    const triggerCard = deps.homey.flow.getTriggerCard(cardId);
    triggerCard.registerRunListener(async (args: unknown, state?: unknown) => (
      evaluateLowestPriceFlowCard(cardId, args, 'trigger', deps, state)
    ));
  }
}

function evaluateLowestPriceFlowCard(
  cardId: LowestPriceCardId,
  args: unknown,
  source: 'trigger' | 'condition',
  deps: FlowCardDeps,
  state?: unknown,
): boolean {
  const triggerState = source === 'trigger' && state && typeof state === 'object'
    ? state as Record<string, unknown>
    : null;
  const stateCurrentPriceRaw = Number(triggerState?.current_price);
  const currentPriceOverride = Number.isFinite(stateCurrentPriceRaw) ? stateCurrentPriceRaw : undefined;
  const triggeredAtRaw = triggerState?.triggered_at;
  const triggeredAt = typeof triggeredAtRaw === 'string' ? new Date(triggeredAtRaw) : null;
  const now = triggeredAt && Number.isFinite(triggeredAt.getTime()) ? triggeredAt : deps.getNow();

  const result = evaluateLowestPriceCard({
    cardId,
    args,
    combinedPrices: deps.getCombinedHourlyPrices(),
    timeZone: deps.getTimeZone(),
    now,
    currentPriceOverride,
  });

  deps.debugStructured({
    event: 'price_lowest_card_evaluated',
    source,
    cardId,
    reason: result.reason,
    currentPrice: result.currentPrice,
    stateCurrentPrice: currentPriceOverride ?? null,
    cutoff: result.cutoff,
    candidateCount: result.candidateCount,
    matches: result.matches,
  });

  return result.matches;
}

function registerHeadroomForDeviceCard(deps: FlowCardDeps): void {
  const hasHeadroomForDeviceCond = deps.homey.flow.getConditionCard('has_headroom_for_device');
  hasHeadroomForDeviceCond.registerRunListener(async (args: unknown) => (
    checkHeadroomForDevice({
      deviceId: readFlowDeviceArg(args),
      requiredKw: readFlowNumberArg(args, 'required_kw'),
    }, deps)
  ));
  hasHeadroomForDeviceCond.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(
      snapshot.filter((d) => d.controllable !== false && (!d.loadKw || d.loadKw <= 0)),
      query,
    );
  });
}

function registerCapacityAndModeCards(deps: FlowCardDeps): void {
  const reportPowerCard = deps.homey.flow.getActionCard('report_power_usage');
  reportPowerCard.registerRunListener(async (args: unknown) => {
    const power = readFlowNumberArg(args, 'power');
    if (power === null || power < 0) {
      throw new Error('Power must be a non-negative number (W).');
    }
    await deps.recordPowerSample(power);
    return true;
  });

  const setLimitCard = deps.homey.flow.getActionCard('set_capacity_limit');
  setLimitCard.registerRunListener(async (args: unknown) => {
    const capacityGuard = deps.getCapacityGuard();
    if (!capacityGuard) return false;
    const limit = readFlowNumberArg(args, 'limit_kw');
    if (limit === null || limit <= 0) {
      throw new Error('Limit must be a positive number (kW).');
    }
    const previous = deps.homey.settings.get(CAPACITY_LIMIT_KW);
    deps.homey.settings.set(CAPACITY_LIMIT_KW, limit);
    deps.setCapacityLimit(limit);
    deps.getStructuredLogger('capacity')?.info({
      event: 'capacity_limit_set',
      limitKw: limit,
      previousLimitKw: typeof previous === 'number' ? previous : null,
    });
    return true;
  });

  const setDailyBudgetCard = deps.homey.flow.getActionCard('set_daily_budget_kwh');
  setDailyBudgetCard.registerRunListener(async (args: unknown) => {
    const raw = readFlowNumberArg(args, 'budget_kwh');
    if (raw === null) {
      throw new Error('Daily budget must be a number (kWh).');
    }
    if (raw < 0) {
      throw new Error('Daily budget must be non-negative (kWh).');
    }
    const isDisabling = raw === 0;
    if (!isDisabling && (raw < MIN_DAILY_BUDGET_KWH || raw > MAX_DAILY_BUDGET_KWH)) {
      const errorMessage = `Daily budget must be 0 (to disable) or between ${MIN_DAILY_BUDGET_KWH} `
        + `and ${MAX_DAILY_BUDGET_KWH} kWh.`;
      throw new Error(errorMessage);
    }

    const previousBudget = deps.homey.settings.get(DAILY_BUDGET_KWH);
    const previousEnabled = deps.homey.settings.get(DAILY_BUDGET_ENABLED) === true;
    const nextEnabled = !isDisabling;
    const unchangedBudget = typeof previousBudget === 'number' && previousBudget === raw;
    const unchangedEnabled = previousEnabled === nextEnabled;
    if (unchangedBudget && unchangedEnabled) {
      deps.getStructuredLogger('daily_budget')?.info({
        event: 'daily_budget_flow_updated',
        budgetKwh: raw,
        enabled: previousEnabled,
        changed: false,
      });
      return true;
    }

    deps.homey.settings.set(DAILY_BUDGET_KWH, raw);
    deps.homey.settings.set(DAILY_BUDGET_ENABLED, nextEnabled);
    deps.getStructuredLogger('daily_budget')?.info({
      event: 'daily_budget_flow_updated',
      budgetKwh: raw,
      enabled: nextEnabled,
      changed: true,
    });
    return true;
  });

  const setOperatingModeCard = deps.homey.flow.getActionCard('set_capacity_mode');
  setOperatingModeCard.registerRunListener(async (args: unknown) => {
    const raw = readFlowStringArg(args, 'mode');
    if (!raw) throw new Error('Mode must be provided');
    await deps.handleOperatingModeChange(raw);
    return true;
  });
  setOperatingModeCard.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));

  const hasCapacityCond = deps.homey.flow.getConditionCard('has_capacity_for');
  hasCapacityCond.registerRunListener(async (args: unknown) => {
    const requiredKw = readFlowNumberArg(args, 'required_kw');
    if (requiredKw === null) return false;
    const headroom = deps.getHeadroom();
    if (headroom === null) return false;
    return headroom >= requiredKw;
  });

  const isOperatingModeCond = deps.homey.flow.getConditionCard('is_capacity_mode');
  isOperatingModeCond.registerRunListener(async (args: unknown) => {
    const chosenModeRaw = readFlowStringArg(args, 'mode');
    const chosenMode = deps.resolveModeName(chosenModeRaw);
    if (!chosenMode) return false;
    const activeMode = deps.getCurrentOperatingMode();
    const matches = activeMode.toLowerCase() === chosenMode.toLowerCase();
    if (!matches && chosenModeRaw !== chosenMode) {
      deps.debugStructured({
        event: 'mode_condition_alias_mismatch',
        requestedAlias: chosenModeRaw,
        resolvedMode: chosenMode,
        activeMode,
      });
    }
    return matches;
  });
  isOperatingModeCond.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));
}

function registerEvSocCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard(EV_SOC_CARD_ID);
  card.registerRunListener(async (args: unknown) => handleEvSocCardRun(deps, args));
  card.registerArgumentAutocompleteListener('device', async (query: string) => (
    getEvChargerDeviceOptions(deps, query)
  ));
}

async function handleEvSocCardRun(deps: FlowCardDeps, args: unknown): Promise<boolean> {
  const { chargerDeviceId, percent } = parseEvSocCardArgs(args);
  const charger = await requireEvChargerSnapshot(deps, chargerDeviceId);
  const observedAtMs = Date.now();
  const reportOutcome = deps.reportFlowBackedCapability({
    deviceId: chargerDeviceId,
    capabilityId: 'measure_battery',
    value: percent,
  });

  if (reportOutcome.refreshSnapshot) {
    await deps.refreshSnapshot({ emitFlowBackedRefresh: false });
  }
  if (reportOutcome.rebuildPlan) {
    requestPlanRebuildFromFlow(deps, EV_SOC_CARD_ID);
  }

  const updatedCharger = await getBestEffortEvChargerSnapshot(deps, chargerDeviceId);
  deps.getStructuredLogger('devices')?.info(buildEvSocLogPayload({
    charger,
    chargerDeviceId,
    updatedCharger,
    percent,
    observedAtMs,
  }));

  return true;
}

async function getBestEffortEvChargerSnapshot(
  deps: FlowCardDeps,
  chargerDeviceId: string,
): Promise<TargetDeviceSnapshot | undefined> {
  try {
    return await getDeviceSnapshotById(deps, chargerDeviceId);
  } catch (error: unknown) {
    const normalizedError = normalizeError(error);
    deps.debugStructured({
      event: 'ev_charger_snapshot_reload_failed',
      deviceId: chargerDeviceId,
      error: normalizedError.message,
    });
    return undefined;
  }
}

function parseEvSocCardArgs(args: unknown): {
  chargerDeviceId: string;
  percent: number;
} {
  const chargerDeviceId = readFlowDeviceArg(args);
  if (!chargerDeviceId) {
    throw new Error('Charger device must be provided.');
  }
  return {
    chargerDeviceId,
    percent: parseEvSocPercent(readFlowRawArg(args, 'battery_percent')),
  };
}

function buildEvSocLogPayload(params: {
  charger: TargetDeviceSnapshot;
  chargerDeviceId: string;
  updatedCharger: TargetDeviceSnapshot | undefined;
  percent: number;
  observedAtMs: number;
}) {
  const { charger, chargerDeviceId, updatedCharger, percent, observedAtMs } = params;
  return {
    event: 'ev_soc_reported',
    chargerDeviceId,
    chargerName: updatedCharger?.name ?? charger.name,
    percent,
    observedAtMs: updatedCharger?.stateOfCharge?.observedAtMs ?? observedAtMs,
    status: updatedCharger?.stateOfCharge?.status ?? 'unknown',
  };
}

function getModeOptions(deps: FlowCardDeps, query: string): Array<{ id: string; name: string }> {
  const q = (query || '').toLowerCase();
  return Array.from(deps.getAllModes())
    .filter((m) => !q || m.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((m) => ({ id: m, name: m }));
}

function getPriceLevelOptions(query: string): Array<{ id: string; name: string }> {
  const q = (query || '').toLowerCase();
  return PRICE_LEVEL_OPTIONS
    .filter((opt: PriceLevelOption) => !q || opt.name.toLowerCase().includes(q))
    .map((opt: PriceLevelOption) => ({ id: opt.id, name: opt.name }));
}

function readPriceLevelArg(args: unknown): PriceLevel {
  const raw = readFlowStringArg(args, 'level').toLowerCase();
  return (raw || PriceLevel.UNKNOWN) as PriceLevel;
}

async function getSteppedLoadDeviceOptions(
  deps: FlowCardDeps,
  query: string,
): Promise<Array<{ id: string; name: string }>> {
  const snapshot = await deps.getSnapshot();
  return buildDeviceAutocompleteOptions(
    snapshot.filter((device) => (
      device.controlModel === 'stepped_load' && device.steppedLoadProfile?.model === 'stepped_load'
    )),
    query,
  );
}

async function getEvChargerDeviceOptions(
  deps: FlowCardDeps,
  query: string,
): Promise<Array<{ id: string; name: string }>> {
  const snapshot = await deps.getSnapshot();
  return buildDeviceAutocompleteOptions(
    snapshot.filter((device) => device.deviceClass === 'evcharger'),
    query,
  );
}

async function getDeviceSnapshotById(
  deps: FlowCardDeps,
  deviceId: string,
): Promise<TargetDeviceSnapshot | undefined> {
  const snapshot = await deps.getSnapshot();
  return snapshot.find((entry) => entry.id === deviceId);
}

async function requireEvChargerSnapshot(
  deps: FlowCardDeps,
  chargerDeviceId: string,
): Promise<TargetDeviceSnapshot> {
  const snapshot = await deps.getSnapshot();
  const charger = snapshot.find((entry) => entry.id === chargerDeviceId);
  if (!charger) {
    throw new Error(`Charger '${chargerDeviceId}' was not found in the snapshot.`);
  }
  if (charger.deviceClass !== 'evcharger') {
    throw new Error(`Device '${charger.name.trim()}' is not an EV charger.`);
  }
  return charger;
}

function parseEvSocPercent(rawValue: unknown): number {
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    throw new Error('Battery level must be a number between 0 and 100.');
  }
  const percent = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(percent)) {
    throw new Error('Battery level must be a number between 0 and 100.');
  }
  if (percent < 0 || percent > 100) {
    throw new Error('Battery level must be between 0 and 100.');
  }
  return Math.round(percent * 10) / 10;
}

function requestPlanRebuildFromFlow(deps: FlowCardDeps, source: string): void {
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.flow_total',
    `plan_rebuild_requested.flow.${source}_total`,
  ]);
  deps.rebuildPlan(source);
}

async function checkHeadroomForDevice(
  args: { deviceId: string; requiredKw: number | null },
  deps: FlowCardDeps,
): Promise<boolean> {
  const capacityGuard = deps.getCapacityGuard();
  if (!capacityGuard) return false;
  const { deviceId, requiredKw } = args;
  if (!deviceId || requiredKw === null || requiredKw < 0) return false;

  const headroom = deps.getHeadroom();
  if (headroom === null) return false;

  const snapshot = await deps.getSnapshot();
  const deviceSnap = snapshot.find((d) => d.id === deviceId);
  if (!deviceSnap) return false;

  const decision = deps.evaluateHeadroomForDevice({
    devices: snapshot,
    deviceId,
    device: deviceSnap,
    headroom,
    requiredKw,
    cleanupMissingDevices: true,
  });
  if (!decision) return false;
  if (decision.stateChanged) {
    requestPlanRebuildFromFlow(deps, 'flow_headroom_cooldown');
  }
  logHeadroomCheck({
    deps,
    capacityGuard,
    deviceSnap,
    deviceId,
    requiredKw,
    decision,
  });

  return decision.allowed;
}

function logHeadroomCheck(params: {
  deps: FlowCardDeps;
  capacityGuard: CapacityGuard;
  deviceSnap: TargetDeviceSnapshot | undefined;
  deviceId: string;
  requiredKw: number;
  decision: HeadroomForDeviceDecision;
}): void {
  const {
    deps,
    capacityGuard,
    deviceSnap,
    deviceId,
    requiredKw,
    decision,
  } = params;
  deps.debugStructured({
    event: 'headroom_for_device_checked',
    deviceId,
    deviceName: deviceSnap?.name,
    softLimitKw: capacityGuard.getSoftLimit(),
    currentPowerKw: capacityGuard.getLastTotalPower() ?? null,
    deviceConsumptionKw: decision.observedKw,
    expectedPowerKw: deviceSnap?.expectedPowerKw ?? null,
    expectedPowerSource: deviceSnap?.expectedPowerSource ?? null,
    requiredKw,
    effectiveRequiredKw: decision.requiredKwWithPenalty,
    headroomForDeviceKw: decision.calculatedHeadroomForDeviceKw,
    cooldownSource: decision.cooldownSource ?? null,
    cooldownRemainingSec: decision.cooldownRemainingSec ?? null,
    penaltyLevel: decision.penaltyLevel,
    clearRemainingSec: decision.clearRemainingSec ?? null,
    allowed: decision.allowed,
  });
}
