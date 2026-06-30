import { isSteppedLoadSnapshot } from '../packages/shared-domain/src/steppedLoadObservedState';
import type { ReportSteppedLoadActualStepResult } from '../setup/appDeviceControlHelpers';
import { isNativeSteppedLoadControlEnabled } from '../lib/device/nativeSteppedLoadWiring';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import {
  readFlowDeviceArg,
  readFlowRawArg,
  readFlowStringArg,
} from './flowArgParsers';
import { requestPlanRebuildFromFlow } from './flowCardShared';
import {
  createSteppedLoadReportError,
  emitSteppedLoadClampDeviationLog,
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
