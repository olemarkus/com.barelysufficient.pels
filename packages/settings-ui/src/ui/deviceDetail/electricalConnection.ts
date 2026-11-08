import { state } from '../state.ts';
import { DEVICE_PHASE_CONNECTIONS } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import {
  isDevicePhaseConnectionMap,
  type DevicePhaseConnection,
} from '../../../../shared-domain/src/settings/devicePhaseConnections.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';
import type { MdFilledSelectElement } from '../dom.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import type { SettingsUiPhaseFootprintRead } from '../../../../contracts/src/settingsUi/devices.ts';
import { resolveDeviceDetailKind } from '../deviceKind.ts';

/**
 * "Electrical connection": which phases of the main fuse the device loads.
 * Automatic is the absence of an entry. Offered only with a three-phase
 * supply with neutral, the one supply where PELS holds each phase on its own.
 */

const AUTOMATIC = 'automatic';
const SELF_BALANCING: DevicePhaseConnection = 'self_balancing';

// Queried here rather than in `dom.ts` for the same reason as
// `respectExternalOff.ts`: one consumer, and `dom.ts` sits at its ceiling.
const rowEl = document.querySelector<HTMLElement>('#device-detail-electrical-connection-row');
const selectEl = document.querySelector<MdFilledSelectElement>('#device-detail-electrical-connection');
const sourceEl = document.querySelector<HTMLElement>('#device-detail-electrical-connection-source');

const runSerializedWrite = createSerializedAsyncRunner();

const readStrictMap = (value: unknown): Record<string, DevicePhaseConnection> | null => (
  isDevicePhaseConnectionMap(value) ? { ...value } : null
);

const parseSelected = (value: string | undefined): DevicePhaseConnection | null => (
  value === 'L1' || value === 'L2' || value === 'L3' || value === 'all' || value === SELF_BALANCING ? value : null
);

const syncSelfBalancingOption = (isEvCharger: boolean): void => {
  selectEl?.querySelector(`md-select-option[value="${SELF_BALANCING}"]`)?.toggleAttribute('hidden', !isEvCharger);
};

const phaseLabel = (phases: NonNullable<SettingsUiPhaseFootprintRead['phases']>): string => (
  phases === 'all' ? 'all three phases' : phases
);

/** How PELS knows, in the device page's words. Nothing to say until it has an answer. */
const formatPhaseSource = (read: SettingsUiPhaseFootprintRead | undefined): string => {
  if (read === undefined || read.phases === undefined) return '';
  const phases = phaseLabel(read.phases);
  if (read.source === 'learned') return `Learned: ${phases}.`;
  if (read.source === 'reported') return `Reported by the charger: ${phases}.`;
  return read.source === 'set' ? `Set by you: ${phases}.` : '';
};

export const syncElectricalConnectionRow = (
  deviceId: string | null,
  device: SettingsUiDeviceDetailItem | null,
): void => {
  if (!rowEl || !selectEl) return;
  const show = deviceId !== null && state.mainFuseSupply === 'three_phase_neutral';
  rowEl.hidden = !show;
  if (!show || deviceId === null) return;
  syncSelfBalancingOption(resolveDeviceDetailKind(device) === 'ev_charger');
  selectEl.value = state.devicePhaseConnectionMap[deviceId] ?? AUTOMATIC;
  if (sourceEl) sourceEl.textContent = formatPhaseSource(device?.phaseFootprintRead);
};

type ElectricalConnectionHandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  refreshOpenDeviceDetail: () => void;
};

export const initElectricalConnectionHandler = ({
  getCurrentDetailDeviceId,
  refreshOpenDeviceDetail,
}: ElectricalConnectionHandlerDeps): void => {
  selectEl?.addEventListener('change', () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !selectEl) return;
    const selected = parseSelected(selectEl.value);
    // Serialized like the other multi-edit detail settings, so two quick edits
    // cannot both start from the same pre-write map.
    void runSerializedWrite(async () => writeFreshSetting<Record<string, DevicePhaseConnection>>({
      key: DEVICE_PHASE_CONNECTIONS,
      context: 'device detail',
      logMessage: 'Failed to update electrical connection',
      toastMessage: 'Failed to update Electrical connection.',
      fallbackValue: state.devicePhaseConnectionMap,
      readFresh: readStrictMap,
      mutate: (currentMap) => {
        const nextMap = Object.fromEntries(Object.entries(currentMap).filter(([id]) => id !== deviceId));
        if (selected !== null) nextMap[deviceId] = selected;
        return nextMap;
      },
      commit: (nextMap) => {
        state.devicePhaseConnectionMap = nextMap;
        refreshOpenDeviceDetail();
      },
      rollback: refreshOpenDeviceDetail,
    }));
  });
};
