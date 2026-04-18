/* eslint-disable max-lines -- Flow card registration stays centralized in this module. */
import { PriceLevel, PRICE_LEVEL_OPTIONS, PriceLevelOption } from '../lib/price/priceLevels';
import CapacityGuard from '../lib/core/capacityGuard';
import { FlowHomeyLike, HomeyDeviceLike, TargetDeviceSnapshot } from '../lib/utils/types';
import type { ReportSteppedLoadActualStepResult } from '../lib/app/appDeviceControlHelpers';
import { registerExpectedPowerCard } from './expectedPower';
import type { HeadroomCardDeviceLike, HeadroomForDeviceDecision } from '../lib/plan/planHeadroomDevice';
import type { FlowReportedCapabilityId } from '../lib/core/flowReportedCapabilities';
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
import type { Logger as PinoLogger } from '../lib/logging/logger';
import {
  registerBudgetExemptionCards,
  registerBudgetExemptionCondition,
  registerCapacityControlCondition,
  registerDeviceCapacityControlCards,
  registerManagedDeviceCondition,
} from './deviceSettingsCards';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import { parseFlowPowerInput, registerFlowBackedDeviceCards } from './flowBackedDeviceCards';

type DeviceArg = RawFlowDeviceArg;

export type FlowCardDeps = {
  homey: FlowHomeyLike;
  resolveModeName: (mode: string) => string;
  getAllModes: () => Set<string>;
  getCurrentOperatingMode: () => string;
  handleOperatingModeChange: (rawMode: string) => Promise<void>;
  getCurrentPriceLevel: () => PriceLevel;
  recordPowerSample: (powerW: number) => Promise<void>;
  getCapacityGuard: () => CapacityGuard | undefined;
  getHeadroom: () => number | null;
  setCapacityLimit: (kw: number) => void;
  getSnapshot: () => Promise<TargetDeviceSnapshot[]>;
  refreshSnapshot: (options?: { emitFlowBackedRefresh?: boolean }) => Promise<void>;
  getHomeyDevicesForFlow: () => Promise<HomeyDeviceLike[]>;
  reportFlowBackedCapability: (params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    value: boolean | number | string;
  }) => 'changed' | 'unchanged';
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
  getCombinedHourlyPrices: () => unknown;
  getTimeZone: () => string;
  getNow: () => Date;
  getStructuredLogger: (component: string) => PinoLogger | undefined;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
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
      const payload = args as { mode?: string | { id?: string; name?: string } } | null;
      const statePayload = state as { mode?: string } | null;
      const argModeValue = (
        typeof payload?.mode === 'object' && payload?.mode !== null
          ? payload.mode.id
          : payload?.mode
      );
      const chosenModeRaw = (argModeValue || '').trim();
      const chosenMode = deps.resolveModeName(chosenModeRaw);
      const stateMode = deps.resolveModeName((statePayload?.mode || '').trim());
      if (!chosenMode || !stateMode) return false;
      return chosenMode.toLowerCase() === stateMode.toLowerCase();
    });
    operatingModeChangedTrigger.registerArgumentAutocompleteListener('mode', async (query: string) => (
      getModeOptions(deps, query)
    ));

    const priceLevelChangedTrigger = homey.flow.getTriggerCard('price_level_changed');
    priceLevelChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
      const payload = args as { level?: string | { id?: string; name?: string } } | null;
      const statePayload = state as { priceLevel?: PriceLevel } | null;
      const argLevelValue = (
        typeof payload?.level === 'object' && payload?.level !== null
          ? payload.level.id
          : payload?.level
      );
      const chosenLevelRaw = (argLevelValue || '').trim().toLowerCase();
      const chosenLevel = (chosenLevelRaw || PriceLevel.UNKNOWN) as PriceLevel;
      const stateLevel = (statePayload?.priceLevel || PriceLevel.UNKNOWN) as PriceLevel;
      return chosenLevel === stateLevel;
    });
    priceLevelChangedTrigger.registerArgumentAutocompleteListener('level', async (query: string) => (
      getPriceLevelOptions(query)
    ));

    const priceLevelIsCond = homey.flow.getConditionCard('price_level_is');
    priceLevelIsCond.registerRunListener(async (args: unknown) => {
      const payload = args as { level?: string | { id?: string; name?: string } } | null;
      const argLevelValue = (
        typeof payload?.level === 'object' && payload?.level !== null
          ? payload.level.id
          : payload?.level
      );
      const chosenLevel = ((argLevelValue || '').trim().toLowerCase() || PriceLevel.UNKNOWN) as PriceLevel;
      const currentLevel = deps.getCurrentPriceLevel();
      return chosenLevel === currentLevel;
    });
    priceLevelIsCond.registerArgumentAutocompleteListener('level', async (query: string) => (
      getPriceLevelOptions(query)
    ));

    registerHeadroomForDeviceCard(deps);
    registerCapacityAndModeCards(deps);
    registerFlowBackedDeviceCards(deps);
    registerSteppedLoadCards(deps);
    registerDeviceCapacityControlCards(deps);
    registerBudgetExemptionCards(deps);
    registerManagedDeviceCondition(deps);
    registerCapacityControlCondition(deps);
    registerBudgetExemptionCondition(deps);
    registerFlowPriceCards(deps);
    registerLowestPriceCards(deps);
  } finally {
    stopSpan();
  }
}

function registerSteppedLoadCards(deps: FlowCardDeps): void {
  const desiredChangedTrigger = deps.homey.flow.getTriggerCard('desired_stepped_load_changed');
  desiredChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: DeviceArg } | null;
    const statePayload = state as { deviceId?: string } | null;
    const chosenDeviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
    if (!chosenDeviceId || !statePayload?.deviceId) return false;
    return chosenDeviceId === statePayload.deviceId;
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
    const payload = args as { device?: DeviceArg; step?: string | { id?: string; name?: string } } | null;
    const deviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
    const stepValue = typeof payload?.step === 'object' && payload?.step !== null
      ? payload.step.id
      : payload?.step;
    const stepId = (stepValue || '').trim();
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
      const deviceId = getDeviceIdFromArg(args?.device as DeviceArg);
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
    const payload = args as { device?: DeviceArg; power_w?: unknown } | null;
    const deviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
    const sourceCardId = 'report_stepped_load_power';
    emitSteppedLoadReportReceivedLog({
      deps,
      sourceCardId,
      deviceId,
      rawPowerInput: formatFlowValueForLog(payload?.power_w),
    });
    try {
      if (!deviceId) {
        throw createSteppedLoadReportError('device_missing', 'Device must be provided.');
      }
      const { stepId, deviceName, parsedPowerW } = await resolveSteppedLoadStepIdFromPowerInput({
        deps,
        deviceId,
        rawPower: payload?.power_w,
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
        rawPowerInput: formatFlowValueForLog(payload?.power_w),
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
}

async function resolveSteppedLoadStepIdFromPowerInput(params: {
  deps: FlowCardDeps;
  deviceId: string;
  rawPower: unknown;
}): Promise<{ stepId: string; deviceName: string; parsedPowerW: number }> {
  const { deps, deviceId, rawPower } = params;
  const powerW = parseFlowPowerInput(rawPower);
  if (powerW === null) {
    throw createSteppedLoadReportError(
      'invalid_power_input',
      'Power must be provided as a number or text like "1750 W".',
    );
  }
  const device = await getSteppedLoadDeviceSnapshot(deps, deviceId);
  const steps = device?.steppedLoadProfile?.steps ?? [];
  const matches = steps.filter((step) => Math.round(step.planningPowerW) === powerW);
  if (matches.length === 0) {
    throw createSteppedLoadReportError(
      'no_matching_step',
      `No configured stepped-load step matches ${powerW} W.`,
    );
  }
  if (matches.length > 1) {
    throw createSteppedLoadReportError(
      'multiple_matching_steps',
      `Multiple configured stepped-load steps match ${powerW} W. Report the step directly instead.`,
    );
  }
  return {
    stepId: matches[0].id,
    deviceName: device.name.trim(),
    parsedPowerW: powerW,
  };
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

function parseFlowPowerInput(rawPower: unknown): number | null {
  if (typeof rawPower === 'number' && Number.isFinite(rawPower)) {
    return Math.round(rawPower);
  }
  const normalized = String(rawPower ?? '').trim();
  if (!normalized) return null;
  const match = normalized.match(/^(-?\d+(?:[.,]\d+)?)\s*[Ww]?$/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
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
    reportedStepId: params.reportedStepId ?? null,
    rawPowerInput: params.rawPowerInput ?? null,
  });
}

function emitSteppedLoadReportResolvedLog(params: {
  deps: FlowCardDeps;
  sourceCardId: string;
  deviceId: string;
  deviceName: string;
  resolvedStepId: string;
  parsedPowerW?: number;
  outcome: 'accepted' | 'unchanged' | 'rejected';
  reasonCode?: string;
}): void {
  params.deps.getStructuredLogger('devices')?.info({
    event: 'stepped_load_report_resolved',
    sourceCardId: params.sourceCardId,
    deviceId: params.deviceId,
    deviceName: params.deviceName,
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
function registerFlowPriceCards(deps: FlowCardDeps): void {
  const setTodayCard = deps.homey.flow.getActionCard('set_external_prices_today');
  setTodayCard.registerRunListener(createPriceCardRunListener('today', deps));

  const setTomorrowCard = deps.homey.flow.getActionCard('set_external_prices_tomorrow');
  setTomorrowCard.registerRunListener(createPriceCardRunListener('tomorrow', deps));
}

function createPriceCardRunListener(kind: 'today' | 'tomorrow', deps: FlowCardDeps) {
  return async (args: unknown) => {
    try {
      const payload = args as { prices_json?: unknown } | null;
      const raw = payload?.prices_json;
      if (raw === null || raw === undefined || String(raw).trim() === '') {
        throw new Error('Price data is required.');
      }
      const result = deps.storeFlowPriceData(kind, raw);
      deps.log(`Flow: stored ${result.storedCount} hourly prices for ${result.dateKey} (${kind})`);
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

  const currentPrice = typeof result.currentPrice === 'number' ? result.currentPrice.toFixed(6) : 'n/a';
  const cutoff = typeof result.cutoff === 'number' ? result.cutoff.toFixed(6) : 'n/a';
  const statePrice = typeof currentPriceOverride === 'number' ? currentPriceOverride.toFixed(6) : 'n/a';
  deps.logDebug(
    `Flow ${source} ${cardId}: reason=${result.reason}, current=${currentPrice}, `
    + `state_current=${statePrice}, cutoff=${cutoff}, candidates=${result.candidateCount} `
    + `=> ${result.matches ? 'PASS' : 'FAIL'}`,
  );

  return result.matches;
}

function registerHeadroomForDeviceCard(deps: FlowCardDeps): void {
  const hasHeadroomForDeviceCond = deps.homey.flow.getConditionCard('has_headroom_for_device');
  hasHeadroomForDeviceCond.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: DeviceArg; required_kw?: number } | null;
    return checkHeadroomForDevice({
      device: payload?.device as DeviceArg,
      required_kw: Number(payload?.required_kw),
    }, deps);
  });
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
    const payload = args as { power?: number } | null;
    const power = Number(payload?.power);
    if (!Number.isFinite(power) || power < 0) {
      throw new Error('Power must be a non-negative number (W).');
    }
    await deps.recordPowerSample(power);
    return true;
  });

  const setLimitCard = deps.homey.flow.getActionCard('set_capacity_limit');
  setLimitCard.registerRunListener(async (args: unknown) => {
    const capacityGuard = deps.getCapacityGuard();
    if (!capacityGuard) return false;
    const payload = args as { limit_kw?: number } | null;
    const limit = Number(payload?.limit_kw);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error('Limit must be a positive number (kW).');
    }
    const previous = deps.homey.settings.get(CAPACITY_LIMIT_KW);
    deps.homey.settings.set(CAPACITY_LIMIT_KW, limit);
    deps.setCapacityLimit(limit);
    const previousText = typeof previous === 'number' ? `${previous} kW` : 'unset';
    deps.log(`Flow: capacity limit set to ${limit} kW (was ${previousText})`);
    return true;
  });

  const setDailyBudgetCard = deps.homey.flow.getActionCard('set_daily_budget_kwh');
  setDailyBudgetCard.registerRunListener(async (args: unknown) => {
    const payload = args as { budget_kwh?: number } | null;
    const raw = Number(payload?.budget_kwh);
    if (!Number.isFinite(raw)) {
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
      deps.log(`Flow: daily budget unchanged (${raw} kWh)`);
      return true;
    }

    deps.homey.settings.set(DAILY_BUDGET_KWH, raw);
    deps.homey.settings.set(DAILY_BUDGET_ENABLED, nextEnabled);
    if (isDisabling) {
      deps.log('Flow: daily budget disabled (0 kWh)');
    } else {
      deps.log(`Flow: daily budget set to ${raw} kWh`);
    }
    return true;
  });

  const setOperatingModeCard = deps.homey.flow.getActionCard('set_capacity_mode');
  setOperatingModeCard.registerRunListener(async (args: unknown) => {
    const payload = args as { mode?: string | { id?: string; name?: string } } | null;
    const modeValue = typeof payload?.mode === 'object' && payload?.mode !== null ? payload.mode.id : payload?.mode;
    const raw = (modeValue || '').trim();
    if (!raw) throw new Error('Mode must be provided');
    await deps.handleOperatingModeChange(raw);
    return true;
  });
  setOperatingModeCard.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));

  const hasCapacityCond = deps.homey.flow.getConditionCard('has_capacity_for');
  hasCapacityCond.registerRunListener(async (args: unknown) => {
    const payload = args as { required_kw?: number } | null;
    const headroom = deps.getHeadroom();
    if (headroom === null) return false;
    return headroom >= Number(payload?.required_kw);
  });

  const isOperatingModeCond = deps.homey.flow.getConditionCard('is_capacity_mode');
  isOperatingModeCond.registerRunListener(async (args: unknown) => {
    const payload = args as { mode?: string | { id?: string; name?: string } } | null;
    const modeValue = typeof payload?.mode === 'object' && payload?.mode !== null ? payload.mode.id : payload?.mode;
    const chosenModeRaw = (modeValue || '').trim();
    const chosenMode = deps.resolveModeName(chosenModeRaw);
    if (!chosenMode) return false;
    const activeMode = deps.getCurrentOperatingMode();
    const matches = activeMode.toLowerCase() === chosenMode.toLowerCase();
    if (!matches && chosenModeRaw !== chosenMode) {
      deps.logDebug(
        `Mode condition checked using alias '${chosenModeRaw}' -> `
        + `'${chosenMode}', but active mode is '${activeMode}'`,
      );
    }
    return matches;
  });
  isOperatingModeCond.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));
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

function getDeviceIdFromArg(arg: DeviceArg): string {
  return getDeviceIdFromFlowArg(arg);
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
  args: { device: DeviceArg; required_kw: number },
  deps: FlowCardDeps,
): Promise<boolean> {
  const capacityGuard = deps.getCapacityGuard();
  if (!capacityGuard) return false;
  const deviceId = getDeviceIdFromArg(args.device);
  const requiredKw = Number(args.required_kw);
  if (!deviceId || !Number.isFinite(requiredKw) || requiredKw < 0) return false;

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
  const softLimit = capacityGuard.getSoftLimit();
  const currentPower = capacityGuard.getLastTotalPower();
  const deviceName = deviceSnap ? deviceSnap.name : `device ${deviceId}`;
  const expectedPowerKwStr = deviceSnap?.expectedPowerKw !== undefined
    ? deviceSnap.expectedPowerKw.toFixed(2)
    : 'unknown';
  const sourceStr = deviceSnap?.expectedPowerSource ? ` (${deviceSnap.expectedPowerSource})` : '';
  const cooldownStr = decision.cooldownSource && typeof decision.cooldownRemainingSec === 'number'
    ? `, cooldown=${decision.cooldownSource} (${decision.cooldownRemainingSec}s remaining)`
    : '';
  const penaltyStr = decision.penaltyLevel > 0
    ? `, activation penalty=L${decision.penaltyLevel} `
      + `(clear=${decision.clearRemainingSec ?? 0}s)`
    : '';

  deps.logDebug(
    `Headroom check for device "${deviceName}": `
    + `soft limit=${softLimit.toFixed(2)}kW, `
    + `current power=${currentPower?.toFixed(2) ?? 'unknown'}kW, `
    + `device consumption=${decision.observedKw.toFixed(2)}kW (${decision.observedKwSource}), `
    + `expected power=${expectedPowerKwStr}kW${sourceStr}, `
    + `headroom for device=${decision.calculatedHeadroomForDeviceKw.toFixed(2)}kW `
    + `(required=${requiredKw.toFixed(2)}kW, effective=${decision.requiredKwWithPenalty.toFixed(2)}kW)`
    + `${cooldownStr}${penaltyStr} → ${decision.allowed ? 'PASS' : 'FAIL'}`,
  );
}
