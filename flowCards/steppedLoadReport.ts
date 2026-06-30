import type {
  DecoratedDeviceSnapshot,
  SteppedLoadDescriptorFields,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../packages/contracts/src/types';
import { isSteppedLoadSnapshot } from '../packages/shared-domain/src/steppedLoadObservedState';
import { normalizeError } from '../lib/utils/errorUtils';
import { emitGated } from '../lib/logging/deviationGate';
import type { LogDedupeEntry } from '../lib/logging/logDedupe';
import { PELS_MEASURE_STEP_CAPABILITY_ID } from '../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { FlowCardDeps } from './registerFlowCards';

const STEPPED_LOAD_POWER_CEILING_MARGIN_RATIO = 0.05;
const STEPPED_LOAD_POWER_CEILING_MARGIN_MAX_W = 150;
const EV_CHARGER_NOMINAL_VOLTAGE = 230;
// Per-device dedupe for the clamp-deviation warn: a stuck clamp emits once + a
// slow heartbeat instead of one line per inbound report. Bounded by device
// count; `shouldEmitOnChange` prunes idle entries (default 10 min window).
const STEPPED_LOAD_CLAMP_HEARTBEAT_MS = 10 * 60 * 1000;
const steppedLoadClampDedupe = new Map<string, LogDedupeEntry>();

export async function resolveSteppedLoadStepIdFromPowerInput(params: {
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
  device: TargetDeviceSnapshot & SteppedLoadDescriptorFields;
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
  config: TargetPowerSteppedLoadConfig | undefined,
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

export async function getBestEffortSteppedLoadDeviceName(
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

export function createSteppedLoadReportError(code: SteppedLoadReportErrorCode, message: string): Error {
  return new SteppedLoadReportError(code, message);
}

async function getSteppedLoadDeviceSnapshot(
  deps: FlowCardDeps,
  deviceId: string,
): Promise<TargetDeviceSnapshot & { controlModel: 'stepped_load' } & SteppedLoadDescriptorFields> {
  const snapshot = await deps.getSnapshot();
  const device = snapshot.find((entry) => entry.id === deviceId);
  if (!device) {
    throw createSteppedLoadReportError('device_not_found', `Device '${deviceId}' was not found in the snapshot.`);
  }
  if (device.controlModel !== 'stepped_load' || !isSteppedLoadSnapshot(device)) {
    throw createSteppedLoadReportError(
      'not_stepped_load',
      `Device '${device.name.trim()}' is not configured as a stepped load.`,
    );
  }
  return device as TargetDeviceSnapshot & { controlModel: 'stepped_load' } & SteppedLoadDescriptorFields;
}

export function emitSteppedLoadReportReceivedLog(params: {
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

export function emitSteppedLoadReportResolvedLog(params: {
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

export function emitSteppedLoadReportRejectedLog(params: {
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

export function formatFlowValueForLog(value: unknown): string | number | null {
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
export async function emitSteppedLoadClampDeviationLog(params: {
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
  const steps = isSteppedLoadSnapshot(device) ? device.steppedLoadProfile.steps : [];
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
