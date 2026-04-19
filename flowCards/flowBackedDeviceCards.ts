import type { HomeyDeviceLike } from '../lib/utils/types';
import type { FlowReportedCapabilityId } from '../lib/core/flowReportedCapabilities';
import { incPerfCounters } from '../lib/utils/perfCounters';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import type { FlowCardDeps } from './registerFlowCards';

type DeviceArg = RawFlowDeviceArg;

export function registerFlowBackedDeviceCards(deps: FlowCardDeps): void {
  const refreshTrigger = deps.homey.flow.getTriggerCard('flow_backed_device_refresh_requested');
  refreshTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: DeviceArg } | null;
    const statePayload = state as { deviceId?: string } | null;
    const chosenDeviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
    if (!chosenDeviceId || !statePayload?.deviceId) return false;
    return chosenDeviceId === statePayload.deviceId;
  });
  refreshTrigger.registerArgumentAutocompleteListener('device', async (query: string) => (
    getFlowBackedDeviceOptions(deps, query)
  ));

  registerFlowBackedCapabilityCard({
    deps,
    cardId: 'report_flow_backed_device_power',
    capabilityId: 'measure_power',
    parseValue: (rawValue) => {
      const power = parseFlowPowerInput(rawValue);
      if (power === null || power < 0) {
        throw new Error('Power must be provided as a non-negative number or text like "1750 W".');
      }
      return power;
    },
  });

  registerBooleanCapabilityCard({
    deps,
    cardId: 'report_flow_backed_device_onoff',
    capabilityId: 'onoff',
    errorMessage: 'On/off state must be on, off, true, or false.',
  });

  registerBooleanCapabilityCard({
    deps,
    cardId: 'report_flow_backed_device_evcharger_charging',
    capabilityId: 'evcharger_charging',
    errorMessage: 'Charging state must be on, off, true, or false.',
  });

  registerFlowBackedCapabilityCard({
    deps,
    cardId: 'report_flow_backed_device_evcharger_state',
    capabilityId: 'evcharger_charging_state',
    parseValue: (rawValue) => {
      const normalized = parseAutocompleteStringValue(rawValue);
      if (!normalized) throw new Error('EV charging state must be provided.');
      return normalized;
    },
    autocompleteArg: 'state',
    getAutocompleteOptions: getEvChargingStateOptions,
  });
}

function registerBooleanCapabilityCard(params: {
  deps: FlowCardDeps;
  cardId: string;
  capabilityId: Extract<FlowReportedCapabilityId, 'onoff' | 'evcharger_charging'>;
  errorMessage: string;
}): void {
  const { deps, cardId, capabilityId, errorMessage } = params;
  registerFlowBackedCapabilityCard({
    deps,
    cardId,
    capabilityId,
    parseValue: (rawValue) => parseBooleanFlowValue(rawValue, errorMessage),
    autocompleteArg: 'state',
    getAutocompleteOptions: getBooleanAutocompleteOptions,
  });
}

function registerFlowBackedCapabilityCard(params: {
  deps: FlowCardDeps;
  cardId: string;
  capabilityId: FlowReportedCapabilityId;
  parseValue: (rawValue: unknown) => boolean | number | string;
  autocompleteArg?: string;
  getAutocompleteOptions?: (query: string) => Array<{ id: string; name: string }>;
}): void {
  const {
    deps,
    cardId,
    capabilityId,
    parseValue,
    autocompleteArg,
    getAutocompleteOptions,
  } = params;
  const card = deps.homey.flow.getActionCard(cardId);
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: DeviceArg; state?: unknown; power_w?: unknown } | null;
    const deviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
    if (!deviceId) throw new Error('Device must be provided.');

    const rawValue = capabilityId === 'measure_power' ? payload?.power_w : payload?.state;
    const value = parseValue(rawValue);
    const result = deps.reportFlowBackedCapability({ deviceId, capabilityId, value });

    await deps.refreshSnapshot({ emitFlowBackedRefresh: false });
    if (result === 'changed') {
      requestPlanRebuildFromFlow(deps, cardId);
    }
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => (
    getFlowBackedDeviceOptions(deps, query)
  ));
  if (autocompleteArg && getAutocompleteOptions) {
    card.registerArgumentAutocompleteListener(autocompleteArg, async (query: string) => (
      getAutocompleteOptions(query)
    ));
  }
}

async function getFlowBackedDeviceOptions(
  deps: FlowCardDeps,
  query: string,
): Promise<Array<{ id: string; name: string }>> {
  const devices = await deps.getHomeyDevicesForFlow();
  return buildDeviceAutocompleteOptions(
    devices
      .filter((device): device is Pick<HomeyDeviceLike, 'id' | 'name'> => (
        typeof device.id === 'string' && typeof device.name === 'string'
      ))
      .map((device) => ({
        id: device.id,
        name: device.name,
      })),
    query,
  );
}

function getDeviceIdFromArg(arg: DeviceArg): string {
  return getDeviceIdFromFlowArg(arg);
}

function parseBooleanFlowValue(rawValue: unknown, errorMessage: string): boolean {
  if (typeof rawValue === 'boolean') return rawValue;
  const normalized = parseAutocompleteStringValue(rawValue).toLowerCase();
  if (normalized === 'true' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === 'off') return false;
  throw new Error(errorMessage);
}

function parseAutocompleteStringValue(rawValue: unknown): string {
  if (typeof rawValue === 'string') return rawValue.trim();
  if (typeof rawValue === 'object' && rawValue !== null && 'id' in rawValue) {
    const rawId = (rawValue as { id?: unknown }).id;
    return typeof rawId === 'string' ? rawId.trim() : '';
  }
  return String(rawValue ?? '').trim();
}

function getBooleanAutocompleteOptions(query: string): Array<{ id: string; name: string }> {
  const options = [
    { id: 'on', name: 'On' },
    { id: 'off', name: 'Off' },
  ];
  const normalizedQuery = (query || '').trim().toLowerCase();
  return options.filter((option) => (
    !normalizedQuery || option.id.includes(normalizedQuery) || option.name.toLowerCase().includes(normalizedQuery)
  ));
}

function getEvChargingStateOptions(query: string): Array<{ id: string; name: string }> {
  const options = [
    'plugged_in_charging',
    'plugged_in_paused',
    'plugged_in',
    'plugged_out',
    'plugged_in_discharging',
  ].map((state) => ({ id: state, name: state }));
  const normalizedQuery = (query || '').trim().toLowerCase();
  return options.filter((option) => !normalizedQuery || option.id.toLowerCase().includes(normalizedQuery));
}

export function parseFlowPowerInput(rawPower: unknown): number | null {
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

function requestPlanRebuildFromFlow(deps: FlowCardDeps, source: string): void {
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.flow_total',
    `plan_rebuild_requested.flow.${source}_total`,
  ]);
  deps.rebuildPlan(source);
}
