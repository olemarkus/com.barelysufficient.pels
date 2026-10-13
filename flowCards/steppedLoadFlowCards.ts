import { isSteppedLoadSnapshot } from '../packages/shared-domain/src/steppedLoadObservedState';
import type { ReportSteppedLoadActualStepResult } from '../lib/executor/steppedCommandState';
import { isBuiltInSteppedLoadControlEnabled } from '../lib/device/nativeSteppedLoadWiring';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import {
  readFlowDeviceArg,
  readFlowRawArg,
  readFlowStringArg,
} from './flowArgParsers';
import {
  createSteppedLoadReportError,
  emitSteppedLoadClampDeviationLog,
  emitSteppedLoadReportNativeIgnoredLog,
  emitSteppedLoadReportReceivedLog,
  emitSteppedLoadReportRejectedLog,
  emitSteppedLoadReportResolvedLog,
  formatFlowValueForLog,
  getBestEffortSteppedLoadDeviceName,
  resolveSteppedLoadStepIdFromPowerInput,
} from './steppedLoadReport';
import type { FlowCardDeps } from './registerFlowCards';

export function registerSteppedLoadCards(deps: FlowCardDeps): void {
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

  const requestValid = deps.homey.flow.getConditionCard('stepped_load_request_valid');
  requestValid.registerRunListener((args: unknown) => {
    const deviceId = readFlowDeviceArg(args);
    const requestId = readFlowStringArg(args, 'request_id');
    return Boolean(deviceId && requestId && deps.isSteppedRequestValid(deviceId, requestId));
  });
  requestValid.registerArgumentAutocompleteListener('device', async (query: string) => (
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
    emitSteppedLoadReportReceivedLog(deps, sourceCardId, deviceId, stepId || null, null);
    try {
      if (!deviceId) {
        throw createSteppedLoadReportError('device_missing', 'Device must be provided.');
      }
      const nativeIgnored = await resolveNativeSteppedLoadFlowReportIgnore(deps, deviceId);
      if (nativeIgnored) {
        emitSteppedLoadReportNativeIgnoredLog(deps, sourceCardId, deviceId, nativeIgnored.deviceName, stepId || null);
        return true;
      }
      if (!stepId) {
        throw createSteppedLoadReportError('step_missing', 'Step must be provided.');
      }
      const result = await deps.reportSteppedLoadActualStep(deviceId, stepId);
      const deviceName = await getBestEffortSteppedLoadDeviceName(deps, deviceId);
      await handleSteppedLoadReportResult(deps, result, sourceCardId, deviceId, deviceName, stepId, undefined);
      return true;
    } catch (error) {
      emitSteppedLoadReportRejectedLog(deps, sourceCardId, deviceId, stepId || null, null, error);
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
      // The step ladder is descriptor config; listing its rungs asks nothing
      // about the device's current step.
      const descriptors = await deps.getDeviceDescriptors();
      const device = descriptors.find((entry) => entry.id === deviceId);
      const steps = device && isSteppedLoadSnapshot(device) ? device.steppedLoadProfile.steps : [];
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
    emitSteppedLoadReportReceivedLog(deps, sourceCardId, deviceId, null, formatFlowValueForLog(rawPower));
    try {
      if (!deviceId) {
        throw createSteppedLoadReportError('device_missing', 'Device must be provided.');
      }
      const nativeIgnored = await resolveNativeSteppedLoadFlowReportIgnore(deps, deviceId);
      if (nativeIgnored) {
        emitSteppedLoadReportNativeIgnoredLog(deps, sourceCardId, deviceId, nativeIgnored.deviceName, null);
        return true;
      }
      const { stepId, deviceName, parsedPowerW } = await resolveSteppedLoadStepIdFromPowerInput(
        deps, deviceId, rawPower,
      );
      const result = await deps.reportSteppedLoadActualStep(deviceId, stepId, parsedPowerW);
      await handleSteppedLoadReportResult(deps, result, sourceCardId, deviceId, deviceName, stepId, parsedPowerW);
      return true;
    } catch (error) {
      emitSteppedLoadReportRejectedLog(deps, sourceCardId, deviceId, null, formatFlowValueForLog(rawPower), error);
      throw error;
    }
  });
  reportActualPowerCard.registerArgumentAutocompleteListener('device', async (query: string) => (
    getSteppedLoadDeviceOptions(deps, query)
  ));
}

async function handleSteppedLoadReportResult(
  deps: FlowCardDeps,
  result: ReportSteppedLoadActualStepResult,
  sourceCardId: string,
  deviceId: string,
  deviceName: string,
  resolvedStepId: string,
  parsedPowerW: number | undefined,
): Promise<void> {
  if (result === 'invalid') {
    throw createSteppedLoadReportError(
      'invalid_step',
      'Device is not configured as a stepped load, or the reported step is invalid.',
    );
  }
  const outcome = result === 'unchanged' ? 'unchanged' : 'accepted';
  if (outcome === 'accepted') await deps.refreshSnapshot();
  emitSteppedLoadReportResolvedLog(deps, sourceCardId, deviceId, deviceName, resolvedStepId, outcome, parsedPowerW);
  await emitSteppedLoadClampDeviationLog(
    deps, sourceCardId, deviceId, resolvedStepId, parsedPowerW, deps.getNow().getTime(),
  );
}

async function resolveNativeSteppedLoadFlowReportIgnore(
  deps: FlowCardDeps,
  deviceId: string,
): Promise<{ deviceName: string } | null> {
  try {
    const descriptors = await deps.getDeviceDescriptors();
    const device = descriptors.find((entry) => entry.id === deviceId);
    if (!device || !isBuiltInSteppedLoadControlEnabled(device)) return null;
    return { deviceName: device.name.trim() || deviceId };
  } catch {
    return null;
  }
}

async function getSteppedLoadDeviceOptions(
  deps: FlowCardDeps,
  query: string,
): Promise<Array<{ id: string; name: string }>> {
  const descriptors = await deps.getDeviceDescriptors();
  return buildDeviceAutocompleteOptions(
    descriptors.filter((device) => isSteppedLoadSnapshot(device)),
    query,
  );
}
