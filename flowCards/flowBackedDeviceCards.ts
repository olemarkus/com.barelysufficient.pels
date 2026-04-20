import type { HomeyDeviceLike } from '../lib/utils/types';
import type { FlowReportedCapabilityId } from '../lib/core/flowReportedCapabilities';
import { resolveFlowAugmentedDeviceType } from '../lib/core/flowReportedCapabilities';
import { getCapabilities, resolveDeviceClassKey } from '../lib/core/deviceManagerHelpers';
import { incPerfCounters } from '../lib/utils/perfCounters';
import { getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import type { FlowCardDeps } from './registerFlowCards';

type DeviceArg = RawFlowDeviceArg;
type FlowBackedCardTarget = 'binary' | 'evcharger' | 'binary_or_evcharger';

export function registerFlowBackedDeviceCards(deps: FlowCardDeps): void {
  registerFlowBackedRequestTrigger({
    deps,
    cardId: 'flow_backed_device_refresh_requested',
    target: 'binary_or_evcharger',
  });
  registerFlowBackedRequestTrigger({
    deps,
    cardId: 'flow_backed_device_turn_on_requested',
    target: 'binary',
    requiredMissingCapabilityId: 'onoff',
  });
  registerFlowBackedRequestTrigger({
    deps,
    cardId: 'flow_backed_device_turn_off_requested',
    target: 'binary',
    requiredMissingCapabilityId: 'onoff',
  });
  registerFlowBackedRequestTrigger({
    deps,
    cardId: 'flow_backed_device_start_charging_requested',
    target: 'evcharger',
    requiredMissingCapabilityId: 'evcharger_charging',
  });
  registerFlowBackedRequestTrigger({
    deps,
    cardId: 'flow_backed_device_stop_charging_requested',
    target: 'evcharger',
    requiredMissingCapabilityId: 'evcharger_charging',
  });

  registerBooleanCapabilityCard({
    deps,
    cardId: 'report_flow_backed_device_onoff',
    capabilityId: 'onoff',
    target: 'binary',
    errorMessage: 'On/off state must be on, off, true, or false.',
  });

  registerBooleanCapabilityCard({
    deps,
    cardId: 'report_flow_backed_device_evcharger_charging',
    capabilityId: 'evcharger_charging',
    target: 'evcharger',
    errorMessage: 'Charging state must be on, off, true, or false.',
  });

  registerBooleanCapabilityCard({
    deps,
    cardId: 'report_flow_backed_device_evcharger_car_connected',
    capabilityId: 'alarm_generic.car_connected',
    target: 'evcharger',
    errorMessage: 'Car connection state must be connected, disconnected, true, or false.',
    autocompleteArg: 'state',
    getAutocompleteOptions: getConnectionAutocompleteOptions,
  });
}

function registerFlowBackedRequestTrigger(params: {
  deps: FlowCardDeps;
  cardId: string;
  target: FlowBackedCardTarget;
  requiredMissingCapabilityId?: Extract<FlowReportedCapabilityId, 'onoff' | 'evcharger_charging'>;
}): void {
  const {
    deps,
    cardId,
    target,
    requiredMissingCapabilityId,
  } = params;
  const trigger = deps.homey.flow.getTriggerCard(cardId);
  trigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: DeviceArg } | null;
    const statePayload = state as { deviceId?: string } | null;
    const chosenDeviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
    if (!chosenDeviceId || !statePayload?.deviceId) return false;
    return chosenDeviceId === statePayload.deviceId;
  });
  trigger.registerArgumentAutocompleteListener('device', async (query: string) => (
    getFlowBackedDeviceOptions(deps, query, target, {
      requiredMissingCapabilityId,
    })
  ));
}

function registerBooleanCapabilityCard(params: {
  deps: FlowCardDeps;
  cardId: string;
  capabilityId: Extract<FlowReportedCapabilityId, 'onoff' | 'evcharger_charging' | 'alarm_generic.car_connected'>;
  target: FlowBackedCardTarget;
  errorMessage: string;
  autocompleteArg?: string;
  getAutocompleteOptions?: (query: string) => Array<{ id: string; name: string }>;
}): void {
  const {
    deps,
    cardId,
    capabilityId,
    target,
    errorMessage,
    autocompleteArg = 'state',
    getAutocompleteOptions = getBooleanAutocompleteOptions,
  } = params;
  registerFlowBackedCapabilityCard({
    deps,
    cardId,
    capabilityId,
    target,
    parseValue: (rawValue) => parseBooleanFlowValue(rawValue, errorMessage),
    autocompleteArg,
    getAutocompleteOptions,
  });
}

function registerFlowBackedCapabilityCard(params: {
  deps: FlowCardDeps;
  cardId: string;
  capabilityId: FlowReportedCapabilityId;
  target: FlowBackedCardTarget;
  parseValue: (rawValue: unknown) => boolean | number | string;
  autocompleteArg?: string;
  getAutocompleteOptions?: (query: string) => Array<{ id: string; name: string }>;
}): void {
  const {
    deps,
    cardId,
    capabilityId,
    target,
    parseValue,
    autocompleteArg,
    getAutocompleteOptions,
  } = params;
  const card = deps.homey.flow.getActionCard(cardId);
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: DeviceArg; state?: unknown } | null;
    const deviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
    if (!deviceId) throw new Error('Device must be provided.');
    const device = await requireSupportedFlowBackedDevice(deps, deviceId, target);

    const value = parseValue(payload?.state);
    const nativeCapabilityPresent = isCapabilityProvidedNatively({
      device,
      capabilityId,
    });
    const result = deps.reportFlowBackedCapability({ deviceId, capabilityId, value });
    emitFlowBackedCapabilityReportLog({
      deps,
      cardId,
      device,
      capabilityId,
      value,
      result,
      nativeCapabilityPresent,
    });

    await deps.refreshSnapshot({ emitFlowBackedRefresh: false });
    if (result === 'changed') {
      requestPlanRebuildFromFlow(deps, cardId);
    }
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => (
    getFlowBackedDeviceOptions(deps, query, target)
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
  target: FlowBackedCardTarget,
  options: {
    requiredMissingCapabilityId?: Extract<FlowReportedCapabilityId, 'onoff' | 'evcharger_charging'>;
  } = {},
): Promise<Array<{ id: string; name: string }>> {
  const devices = await deps.getHomeyDevicesForFlow();
  return buildFlowBackedDeviceAutocompleteOptions(devices, query, target, options);
}

function getDeviceIdFromArg(arg: DeviceArg): string {
  return getDeviceIdFromFlowArg(arg);
}

function parseBooleanFlowValue(rawValue: unknown, errorMessage: string): boolean {
  if (typeof rawValue === 'boolean') return rawValue;
  const normalized = parseAutocompleteStringValue(rawValue).toLowerCase();
  if (normalized === 'true' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === 'off') return false;
  if (normalized === 'connected') return true;
  if (normalized === 'disconnected') return false;
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

function emitFlowBackedCapabilityReportLog(params: {
  deps: FlowCardDeps;
  cardId: string;
  device: HomeyDeviceLike;
  capabilityId: FlowReportedCapabilityId;
  value: boolean | number | string;
  result: 'changed' | 'unchanged';
  nativeCapabilityPresent: boolean;
}): void {
  const {
    deps,
    cardId,
    device,
    capabilityId,
    value,
    result,
    nativeCapabilityPresent,
  } = params;
  let event = 'flow_backed_capability_report_unchanged';
  if (nativeCapabilityPresent) {
    event = 'flow_backed_capability_report_native_overlap';
  } else if (result === 'changed') {
    event = 'flow_backed_capability_reported';
  }
  deps.structuredLog?.info({
    event,
    sourceCardId: cardId,
    deviceId: device.id,
    deviceName: device.name,
    capabilityId,
    value,
    nativeCapabilityPresent,
    zone: resolveZoneLabel(device) || undefined,
  });
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

function getConnectionAutocompleteOptions(query: string): Array<{ id: string; name: string }> {
  const options = [
    { id: 'connected', name: 'Connected' },
    { id: 'disconnected', name: 'Disconnected' },
  ];
  const normalizedQuery = (query || '').trim().toLowerCase();
  return options.filter((option) => (
    !normalizedQuery || option.id.includes(normalizedQuery) || option.name.toLowerCase().includes(normalizedQuery)
  ));
}

function buildFlowBackedDeviceAutocompleteOptions(
  devices: HomeyDeviceLike[],
  query: string,
  target: FlowBackedCardTarget,
  options: {
    requiredMissingCapabilityId?: Extract<FlowReportedCapabilityId, 'onoff' | 'evcharger_charging'>;
  } = {},
): Array<{ id: string; name: string }> {
  const normalizedQuery = (query || '').trim().toLowerCase();
  const { requiredMissingCapabilityId } = options;
  const filteredDevices = devices.filter((
    device,
  ): device is Pick<HomeyDeviceLike, 'id' | 'name' | 'zone' | 'zoneName' | 'class' | 'capabilities'> => (
    typeof device.id === 'string'
    && typeof device.name === 'string'
    && isSupportedFlowBackedDevice(device, target)
    && (!requiredMissingCapabilityId || !isCapabilityProvidedNatively({
      device,
      capabilityId: requiredMissingCapabilityId,
    }))
  ));
  const nameCounts = new Map<string, number>();
  for (const device of filteredDevices) {
    nameCounts.set(device.name, (nameCounts.get(device.name) ?? 0) + 1);
  }

  return filteredDevices
    .filter((device) => {
      const zoneLabel = resolveZoneLabel(device).toLowerCase();
      return (
        !normalizedQuery
        || device.name.toLowerCase().includes(normalizedQuery)
        || device.id.toLowerCase().includes(normalizedQuery)
        || zoneLabel.includes(normalizedQuery)
      );
    })
    .map((device) => {
      const zoneLabel = resolveZoneLabel(device);
      const duplicateName = (nameCounts.get(device.name) ?? 0) > 1;
      return {
        id: device.id,
        name: duplicateName && zoneLabel ? `${device.name} (${zoneLabel})` : device.name,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function requireSupportedFlowBackedDevice(
  deps: FlowCardDeps,
  deviceId: string,
  target: FlowBackedCardTarget,
): Promise<HomeyDeviceLike> {
  const devices = await deps.getHomeyDevicesForFlow();
  const device = devices.find((entry) => entry.id === deviceId);
  if (!device || !isSupportedFlowBackedDevice(device, target)) {
    throw new Error('Selected device is not supported for this card.');
  }
  return device;
}

function isSupportedFlowBackedDevice(device: HomeyDeviceLike, target: FlowBackedCardTarget): boolean {
  const category = resolveFlowBackedDeviceCategory(device);
  if (target === 'binary') return category === 'binary';
  if (target === 'evcharger') return category === 'evcharger';
  return category === 'binary' || category === 'evcharger';
}

function resolveFlowBackedDeviceCategory(device: HomeyDeviceLike): FlowBackedCardTarget | 'unsupported' {
  const deviceClassKey = resolveDeviceClassKey({
    device,
    experimentalEvSupportEnabled: true,
  });
  if (!deviceClassKey) return 'unsupported';
  const capabilities = getCapabilities(device);
  const targetCapabilityIds = capabilities.filter((capabilityId) => capabilityId.startsWith('target_temperature'));
  return resolveFlowAugmentedDeviceType({
    deviceClassKey,
    targetCapabilityIds,
  });
}

function resolveZoneLabel(device: Pick<HomeyDeviceLike, 'zone' | 'zoneName'>): string {
  const zone = device.zone;
  if (zone && typeof zone === 'object' && 'name' in zone && typeof zone.name === 'string') {
    return zone.name.trim();
  }
  if (typeof zone === 'string') return zone.trim();
  if (typeof device.zoneName === 'string') return device.zoneName.trim();
  return '';
}

function isCapabilityProvidedNatively(params: {
  device: HomeyDeviceLike;
  capabilityId: FlowReportedCapabilityId;
}): boolean {
  const { device, capabilityId } = params;
  const capabilities = getCapabilities(device);
  return capabilities.includes(capabilityId);
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
