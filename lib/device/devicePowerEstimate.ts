import { roundLogValue, shouldEmitOnChange } from '../logging/logDedupe';
import type { BinaryControlCapabilityId, ExpectedPowerSource } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { getLogger } from '../logging/logger';

const moduleLogger = getLogger('device/power-estimate');

/**
 * What PELS assumes a device draws while running when no source describes it.
 *
 * This is an answer, not a placeholder. `expectedPowerKw` is REQUIRED on every
 * contract it crosses, because every consumer — restore admission, the startup
 * reserve, smart-task step sizing, the card's `≈ … kW when active` line — needs a
 * number to size against, and each one used to invent its own when the field was
 * absent. Resolving it once here is what lets all of them stop.
 *
 * `EV_DEFAULT_EXPECTED_POWER_KW` is the typical single-phase charging start. It
 * lived in `getRestoreDrawKw` as a restore-axis fallback until this axis stopped
 * being optional; with expected power always positive that fallback was
 * unreachable, so the value moved to the rung that actually decides it.
 */
const DEFAULT_EXPECTED_POWER_KW = 1;
const EV_DEFAULT_EXPECTED_POWER_KW = 1.38;

export type PowerEstimateState = {
  expectedPowerKwOverrides?: Record<string, { kw: number; ts: number }>;
  lastKnownPowerKw?: Record<string, number>;
  lastEstimateDecisionLogByDevice?: Map<string, { signature: string; emittedAt: number }>;
  lastPeakPowerLogByDevice?: Map<string, { signature: string; emittedAt: number }>;
};

export type PowerEstimateResult = {
  expectedPowerKw: number;
  expectedPowerSource: ExpectedPowerSource;
  measuredPowerKw?: number;
  loadKw?: number;
  hasEnergyEstimate?: boolean;
};

export function estimatePower(params: {
  device: HomeyDeviceLike;
  deviceId: string;
  deviceLabel: string;
  controlCapabilityId?: BinaryControlCapabilityId;
  measuredPowerKw?: number;
  now: number;
  state: Required<PowerEstimateState>;
  logger: Logger;
}): PowerEstimateResult {
  const {
    device,
    deviceId,
    deviceLabel,
    controlCapabilityId,
    measuredPowerKw,
    now,
    state,
    logger,
  } = params;

  const loadW = getLoadSettingWatts(device);
  const result: PowerEstimateResult = {
    ...resolveExpectedPower({
      override: state.expectedPowerKwOverrides[deviceId],
      loadW,
      peakKw: state.lastKnownPowerKw[deviceId],
      energyEstimateW: getHomeyEnergyEstimateWatts(device),
      controlCapabilityId,
    }),
    measuredPowerKw,
    ...(loadW === null ? {} : { loadKw: loadW / 1000 }),
  };

  emitEstimateDecisionLog({ deviceId, deviceLabel, result, state, logger, now });
  return result;
}

/**
 * The one expected-power ladder.
 *
 * Order is the agreed precedence, and it is deliberately not a max: a manual
 * value is an INSTRUCTION and outranks everything, including a higher
 * measurement. Under-declaring is safe on the axis that matters, because restore
 * sizing takes `max(currentDraw, expected, planning)` — a device really pulling
 * more than its declared figure still reserves what it is drawing.
 *
 * `settings.load` sits above the learned peak by decision: a declared load is
 * what the owner's device says about itself, and the escape hatch for a wrong one
 * is the manual override on the rung above.
 *
 * There is no branch split. The load rung used to short-circuit the whole ladder,
 * so a metered device declaring a load never consulted its own meter and no
 * single order existed to agree on.
 */
function resolveExpectedPower(params: {
  override?: { kw: number; ts: number };
  loadW: number | null;
  peakKw?: number;
  energyEstimateW: number | null;
  controlCapabilityId?: BinaryControlCapabilityId;
}): Pick<PowerEstimateResult, 'expectedPowerKw' | 'expectedPowerSource' | 'hasEnergyEstimate'> {
  const { override, loadW, peakKw, energyEstimateW, controlCapabilityId } = params;

  // Gated like every other rung. The two writers of the override map validate
  // before storing, so this is defence in depth rather than a known hole — but
  // this contract's whole promise is that `expectedPowerKw` is finite and
  // positive, and a rung that forwards an external number unchecked leaves that
  // promise resting on writers it does not control. A junk override falls
  // through to the next rung instead of resolving.
  const overrideKw = toFiniteNumber(override?.kw);
  if (overrideKw !== null && overrideKw > 0) {
    return { expectedPowerKw: overrideKw, expectedPowerSource: 'manual' };
  }
  if (loadW !== null) return { expectedPowerKw: loadW / 1000, expectedPowerSource: 'load-setting' };
  if (peakKw !== undefined && peakKw > 0) {
    return { expectedPowerKw: peakKw, expectedPowerSource: 'measured-peak' };
  }
  if (energyEstimateW !== null) {
    return {
      expectedPowerKw: energyEstimateW / 1000,
      expectedPowerSource: 'homey-energy',
      hasEnergyEstimate: true,
    };
  }
  return {
    expectedPowerKw: controlCapabilityId === 'evcharger_charging'
      ? EV_DEFAULT_EXPECTED_POWER_KW
      : DEFAULT_EXPECTED_POWER_KW,
    expectedPowerSource: 'default',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveCurrentOnState(device: HomeyDeviceLike): boolean | null {
  const raw = device.capabilitiesObj?.onoff?.value;
  return typeof raw === 'boolean' ? raw : null;
}

function resolveEnergyContainer(device: HomeyDeviceLike): Record<string, unknown> | null {
  if (isRecord(device.energyObj)) return device.energyObj;
  if (isRecord(device.energy)) return device.energy;
  return null;
}

function resolveSettingsEnergyWatts(device: HomeyDeviceLike): number | null {
  const settings = isRecord(device.settings) ? device.settings : null;
  if (!settings) return null;

  const usageOnW = toFiniteNumber(settings.energy_value_on);
  const usageOffW = toFiniteNumber(settings.energy_value_off);

  if (usageOnW !== null && usageOffW !== null) {
    const controllableDeltaW = Math.max(0, usageOnW - usageOffW);
    if (controllableDeltaW > 0) return controllableDeltaW;
  }

  if (usageOnW !== null && usageOnW > 0) return usageOnW;
  return null;
}

function resolveApproximationWatts(energy: Record<string, unknown>): number | null {
  const approx = isRecord(energy.approximation) ? energy.approximation : null;
  if (!approx) return null;

  const usageOnW = toFiniteNumber(approx.usageOn);
  const usageOffW = toFiniteNumber(approx.usageOff);

  if (usageOnW !== null && usageOffW !== null) {
    const controllableDeltaW = Math.max(0, usageOnW - usageOffW);
    if (controllableDeltaW > 0) return controllableDeltaW;
  }

  if (usageOnW !== null && usageOnW > 0) return usageOnW;
  return null;
}

function resolveEnergyWattFallback(
  energy: Record<string, unknown>,
  currentOn: boolean | null,
): number | null {
  const energyW = toFiniteNumber(energy.W);
  if (energyW === null || energyW <= 0 || currentOn === false) return null;
  return energyW;
}

function getHomeyEnergyEstimateWatts(device: HomeyDeviceLike): number | null {
  const settingsEnergyW = resolveSettingsEnergyWatts(device);
  if (settingsEnergyW !== null) return settingsEnergyW;

  const energy = resolveEnergyContainer(device);
  if (!energy) return null;

  const approximationW = resolveApproximationWatts(energy);
  if (approximationW !== null) return approximationW;

  return resolveEnergyWattFallback(energy, resolveCurrentOnState(device));
}

function getLoadSettingWatts(device: HomeyDeviceLike): number | null {
  // `toFiniteNumber` (not a bare `typeof === 'number'`) so a non-finite settings
  // value is dropped at the boundary: a raw `Infinity` would pass the old
  // `loadW && loadW > 0` guard and propagate as an infinite power estimate.
  const loadW = toFiniteNumber(device.settings?.load);
  return loadW !== null && loadW > 0 ? loadW : null;
}

function emitEstimateDecisionLog(params: {
  deviceId: string;
  deviceLabel: string;
  result: PowerEstimateResult;
  state: Required<PowerEstimateState>;
  logger: Logger;
  now: number;
}): void {
  const { deviceId, deviceLabel, result, state, logger, now } = params;
  const decision = buildEstimateDecisionLogFields(params);
  const signature = JSON.stringify({
    source: decision.source,
    estimatedKw: decision.estimatedKw,
    measuredPowerKw: decision.measuredPowerKw,
    loadKw: decision.loadKw,
    peakMeasuredKw: decision.peakMeasuredKw,
    hasEnergyEstimate: result.hasEnergyEstimate === true,
  });
  if (!shouldEmitOnChange({
    state: state.lastEstimateDecisionLogByDevice,
    key: deviceId,
    signature,
    now,
  })) {
    return;
  }
  (logger.structuredLog ?? moduleLogger).debug({
    event: 'power_estimate_source_changed',
    deviceId,
    deviceName: deviceLabel,
    source: decision.source,
    estimatedKw: decision.estimatedKw,
    measuredPowerKw: decision.measuredPowerKw ?? undefined,
    loadKw: decision.loadKw ?? undefined,
    peakMeasuredKw: decision.peakMeasuredKw ?? undefined,
    hasEnergyEstimate: result.hasEnergyEstimate === true ? true : undefined,
  });
}

// `source: 'default'` is the whole fallback story now, so the separate
// `fallbackReason` field is gone: `default_1kw` restated the source (and would
// have lied about an EV charger's 1.38 kW), and `override_exceeded` described a
// promotion that no longer exists — a measurement above a manual override does
// not supersede it.
function buildEstimateDecisionLogFields(params: {
  deviceId: string;
  result: PowerEstimateResult;
  state: Required<PowerEstimateState>;
}): {
  source: ExpectedPowerSource;
  estimatedKw: number;
  measuredPowerKw: number | null;
  loadKw: number | null;
  peakMeasuredKw: number | null;
} {
  const { deviceId, result, state } = params;
  return {
    source: result.expectedPowerSource,
    estimatedKw: roundLogValue(result.expectedPowerKw, 2),
    measuredPowerKw: roundMaybeKw(result.measuredPowerKw),
    loadKw: roundMaybeKw(result.loadKw),
    peakMeasuredKw: resolvePeakMeasuredKw(result.expectedPowerSource, deviceId, state),
  };
}

function roundMaybeKw(value: number | undefined): number | null {
  return typeof value === 'number' ? roundLogValue(value, 2) : null;
}

function resolvePeakMeasuredKw(
  source: ExpectedPowerSource,
  deviceId: string,
  state: Required<PowerEstimateState>,
): number | null {
  if (source !== 'measured-peak') return null;
  return roundMaybeKw(state.lastKnownPowerKw[deviceId]);
}
