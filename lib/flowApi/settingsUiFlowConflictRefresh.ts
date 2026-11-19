import type {
  SettingsUiDeviceSnapshot,
  SettingsUiFlowConflictRefreshPayload,
  SettingsUiIgnoredPowerUsageFlows,
} from '../../packages/contracts/src/settingsUi/devices';
import type { ConfiguredPowerSourceRead } from '../ports/configuredPowerSource';
import type { FlowConflictRefreshResult } from './flowConflictRefreshCoordinator';
import type { PowerUsageFlowReporters } from './userFlows';

/** The trusted operations the Flow-conflict refresh use case needs. */
export type SettingsUiFlowConflictRefreshPort = {
  requestRefresh: () => Promise<FlowConflictRefreshResult>;
  readDevices: () => readonly SettingsUiDeviceSnapshot[];
  readPowerSource: () => ConfiguredPowerSourceRead;
};

// The power owner ignores "Report power usage" while Power meter is the source,
// so only then are these Flows leftovers. An unread source makes no claim.
const resolveIgnoredPowerUsageFlows = (
  reporters: PowerUsageFlowReporters,
  powerSource: ConfiguredPowerSourceRead,
): SettingsUiIgnoredPowerUsageFlows => {
  if (reporters.flowCount === 0) return { state: 'none' };
  if (powerSource.state !== 'resolved' || powerSource.value !== 'homey_energy') return { state: 'none' };
  return {
    state: 'present',
    flowCount: reporters.flowCount,
    ...(reporters.flowName === undefined ? {} : { flowName: reporters.flowName }),
  };
};

/**
 * Run an explicit scan and project the conflict-gated control facts the UI
 * must merge immediately plus normalized battery- and power-reporting facts used
 * by recommendations. An unavailable scan never exposes the previous snapshot
 * as if it were a fresh answer.
 */
export const refreshSettingsUiFlowConflictPayload = async (
  port: SettingsUiFlowConflictRefreshPort,
): Promise<SettingsUiFlowConflictRefreshPayload> => {
  const result = await port.requestRefresh();
  if (result.state === 'unavailable') {
    throw new Error('Homey Flows could not be checked right now');
  }
  const devices = port.readDevices().map((device) => ({
    id: device.id,
    ...(device.flowConflict ? { flowConflict: device.flowConflict } : {}),
    ...(device.controlAdapter ? { controlAdapter: device.controlAdapter } : {}),
  }));
  return {
    devices,
    evSocReporters: result.flowFacts.evSocReporters.map((reporter) => (
      reporter.flowName === undefined
        ? { chargerDeviceId: reporter.chargerDeviceId }
        : { chargerDeviceId: reporter.chargerDeviceId, flowName: reporter.flowName }
    )),
    ignoredPowerUsageFlows: resolveIgnoredPowerUsageFlows(
      result.flowFacts.powerUsageReporters,
      port.readPowerSource(),
    ),
  };
};
