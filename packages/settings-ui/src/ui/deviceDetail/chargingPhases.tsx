import { render } from 'preact';
import type { ChargingPhaseSettingsMap, ChargingPhaseName } from '../../../../contracts/src/chargingPhases.ts';
import { CHARGING_PHASE_SETTINGS_KEY, isChargingPhaseSettingsMap } from '../../../../shared-domain/src/settings/chargingPhases.ts';
import { DEVICE_PHASE_CONNECTIONS } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import { isDevicePhaseConnectionMap, type DevicePhaseConnection } from '../../../../shared-domain/src/settings/devicePhaseConnections.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { state } from '../state.ts';
import { ChargingPhasesView } from '../views/ChargingPhases.tsx';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

const serialize = createSerializedAsyncRunner();

export function renderChargingPhases(
  deviceId: string | null,
  device: SettingsUiDeviceDetailItem | null,
  refreshOpenDeviceDetail: () => void,
): void {
  const container = document.getElementById('device-detail-charging-phases');
  if (!container) return;
  const read = device?.chargingPhaseControl;
  if (deviceId === null || !read || read.kind !== 'supported') { render(null, container); return; }
  const connection = state.devicePhaseConnectionMap[deviceId];
  const singlePhase: ChargingPhaseName | 'unselected' = connection === 'three_L1' ? 'L1'
    : connection === 'three_L2' ? 'L2' : connection === 'three_L3' ? 'L3' : 'unselected';
  render(<ChargingPhasesView key={deviceId} read={read} singlePhase={singlePhase}
    onSave={(mode, phase) => serialize(async () => {
      // Resolve the installation before enabling it. Both writes merge a fresh map so other chargers survive.
      if (mode !== 'charger') {
        if (phase === 'unselected') return false;
        const saved = await writeFreshSetting<Record<string, DevicePhaseConnection>>({
          key: DEVICE_PHASE_CONNECTIONS, context: 'charging phases',
          logMessage: 'Failed to save charging phase connection', toastMessage: 'Electrical connection could not be saved.',
          fallbackValue: state.devicePhaseConnectionMap,
          readFresh: (value) => isDevicePhaseConnectionMap(value) ? { ...value } : null,
          mutate: (current) => ({ ...current, [deviceId]: `three_${phase}` as DevicePhaseConnection }),
          commit: (next) => { state.devicePhaseConnectionMap = next; },
        });
        if (!saved) return false;
      }
      const saved = await writeFreshSetting<ChargingPhaseSettingsMap>({
        key: CHARGING_PHASE_SETTINGS_KEY, context: 'charging phases',
        logMessage: 'Failed to save charging phases', toastMessage: 'Charging phases could not be saved.',
        fallbackValue: state.chargingPhaseSettings,
        readFresh: (value) => isChargingPhaseSettingsMap(value) ? value : null,
        mutate: (current) => {
          const next = Object.fromEntries(Object.entries(current).filter(([id]) => id !== deviceId));
          return mode === 'charger' ? next : { ...next, [deviceId]: { mode, installationConfirmed: true } };
        },
        commit: (next) => { state.chargingPhaseSettings = next; },
      });
      if (!saved) return false;
      refreshOpenDeviceDetail();
      document.dispatchEvent(new Event('charging-control-changed'));
      return true;
    })}
  />, container);
}
