import type {
  SettingsUiDeviceSnapshot,
  SettingsUiFlowConflictRefreshPayload,
} from '../../packages/contracts/src/settingsUiApi';
import type { FlowConflictRefreshResult } from './flowConflictRefreshCoordinator';

/** The two trusted operations the Flow-conflict refresh use case needs. */
export type SettingsUiFlowConflictRefreshPort = {
  requestRefresh: () => Promise<FlowConflictRefreshResult>;
  readDevices: () => readonly SettingsUiDeviceSnapshot[];
};

/**
 * Run an explicit scan and project only the conflict-gated control facts the
 * settings UI must merge immediately. An unavailable scan never exposes the
 * previous snapshot as if it were a fresh answer.
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
  return { devices };
};
