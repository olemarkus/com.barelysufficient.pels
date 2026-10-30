import type { SettingsPort } from '../ports/homeyRuntime';
import { FLOW_REPORTED_DEVICE_CAPABILITIES } from '../utils/settingsKeys';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import {
  parseFlowReportedCapabilities,
  type FlowReportedCapabilitiesByDevice,
} from './transport/flowReportedCapabilities';

export type FlowReportedCapabilitiesRead =
  | { state: 'resolved'; capabilities: FlowReportedCapabilitiesByDevice }
  | { state: 'unavailable' };

/** Only an explicit empty record or a key list without the key proves there are no saved reports. */
export function readFlowReportedCapabilitiesSetting(
  settings: Pick<SettingsPort, 'get' | 'getKeys'>,
): FlowReportedCapabilitiesRead {
  try {
    const raw = settings.get(FLOW_REPORTED_DEVICE_CAPABILITIES);
    const keyList = readSettingsKeyList(settings);
    if (keyList.status === 'unavailable') return { state: 'unavailable' };
    if (raw === null || raw === undefined) {
      return keyList.keys.includes(FLOW_REPORTED_DEVICE_CAPABILITIES)
        ? { state: 'unavailable' } : { state: 'resolved', capabilities: {} };
    }
    if (!isUnknownRecord(raw)) return { state: 'unavailable' };
    const capabilities = parseFlowReportedCapabilities(raw);
    return Object.keys(raw).length > 0 && Object.keys(capabilities).length === 0
      ? { state: 'unavailable' } : { state: 'resolved', capabilities };
  } catch {
    return { state: 'unavailable' };
  }
}
