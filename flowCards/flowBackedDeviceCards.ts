import type { BinaryControlCapabilityId } from '../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../lib/utils/types';
import type { FlowReportedCapabilityId } from '../lib/device/transport/flowReportedCapabilities';
import type { FlowBackedCapabilityReportOutcome } from '../lib/device/flowBackedCapabilityReport';
import { resolveFlowAugmentedDeviceType } from '../lib/device/transport/flowReportedCapabilities';
import { getCapabilities, resolveDeviceClassKey } from '../lib/device/transport/managerHelpers';
import { incPerfCounter } from '../lib/utils/perfCounters';
import { readFlowDeviceArg, readFlowRawArg } from './flowArgParsers';
import type { FlowCardDeps } from './registerFlowCards';
import { getLogger } from '../lib/logging/logger';

const moduleLogger = getLogger('flowcards/flow-backed-device');

type FlowBackedCardTarget = 'binary' | 'evcharger' | 'binary_or_evcharger';

export function resolveFlowBackedBinaryTriggerCardId(
  capabilityId: BinaryControlCapabilityId,
  desired: boolean,
): string {
  if (capabilityId === 'evcharger_charging') {
    return desired
      ? 'flow_backed_device_start_charging_requested'
      : 'flow_backed_device_stop_charging_requested';
  }
  return desired
    ? 'flow_backed_device_turn_on_requested'
    : 'flow_backed_device_turn_off_requested';
}

export function registerFlowBackedDeviceCards(deps: FlowCardDeps): void {
  registerFlowBackedRequestTrigger(deps, 'flow_backed_device_refresh_requested', 'binary_or_evcharger');
  registerFlowBackedRequestTrigger(deps, 'flow_backed_device_turn_on_requested', 'binary', 'onoff');
  registerFlowBackedRequestTrigger(deps, 'flow_backed_device_turn_off_requested', 'binary', 'onoff');
  registerFlowBackedRequestTrigger(
    deps, 'flow_backed_device_start_charging_requested', 'evcharger', 'evcharger_charging',
  );
  registerFlowBackedRequestTrigger(
    deps, 'flow_backed_device_stop_charging_requested', 'evcharger', 'evcharger_charging',
  );

  registerBooleanCapabilityCard(
    deps,
    'report_flow_backed_device_onoff',
    'onoff',
    'binary',
    'On/off state must be on, off, true, or false.',
  );

  registerBooleanCapabilityCard(
    deps,
    'report_flow_backed_device_evcharger_charging',
    'evcharger_charging',
    'evcharger',
    'Charging state must be on, off, true, or false.',
  );

  registerBooleanCapabilityCard(
    deps,
    'report_flow_backed_device_evcharger_car_connected',
    'alarm_generic.car_connected',
    'evcharger',
    'Car connection state must be connected, disconnected, true, or false.',
    getConnectionAutocompleteOptions,
  );

  registerBooleanCapabilityCard(
    deps,
    'report_flow_backed_device_evcharger_resumable',
    'pels_evcharger_resumable',
    'evcharger',
    'Resumable state must be yes, no, true, or false.',
    getYesNoAutocompleteOptions,
  );
}

function registerFlowBackedRequestTrigger(
  deps: FlowCardDeps,
  cardId: string,
  target: FlowBackedCardTarget,
  requiredMissingCapabilityId?: Extract<FlowReportedCapabilityId, 'onoff' | 'evcharger_charging'>,
): void {
  const trigger = deps.homey.flow.getTriggerCard(cardId);
  trigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const chosenDeviceId = readFlowDeviceArg(args);
    const stateDeviceId = readStateDeviceId(state);
    if (!chosenDeviceId || !stateDeviceId) return false;
    return chosenDeviceId === stateDeviceId;
  });
  trigger.registerArgumentAutocompleteListener('device', async (query: string) => (
    getFlowBackedDeviceOptions(deps, query, target, {
      requiredMissingCapabilityId,
    })
  ));
}

function readStateDeviceId(state: unknown): string {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return '';
  const id = (state as { deviceId?: unknown }).deviceId;
  return typeof id === 'string' ? id.trim() : '';
}

function registerBooleanCapabilityCard(
  deps: FlowCardDeps,
  cardId: string,
  capabilityId: Extract<
    FlowReportedCapabilityId,
    'onoff' | 'evcharger_charging' | 'alarm_generic.car_connected' | 'pels_evcharger_resumable'
  >,
  target: FlowBackedCardTarget,
  errorMessage: string,
  getStateOptions: (query: string) => Array<{ id: string; name: string }> = getBooleanAutocompleteOptions,
): void {
  const card = deps.homey.flow.getActionCard(cardId);
  card.registerRunListener(async (args: unknown) => {
    const deviceId = readFlowDeviceArg(args);
    if (!deviceId) throw new Error('Device must be provided.');
    const device = await requireSupportedFlowBackedDevice(deps, deviceId, target);

    const value = parseBooleanFlowValue(readFlowRawArg(args, 'state'), errorMessage);
    const nativeCapabilityPresent = isCapabilityProvidedNatively({
      device,
      capabilityId,
    });
    const reportOutcome = deps.reportFlowBackedCapability(deviceId, capabilityId, value);
    emitFlowBackedCapabilityReportLog(
      deps, cardId, device, capabilityId, value, reportOutcome, nativeCapabilityPresent,
    );

    if (!reportOutcome.refreshSnapshot) {
      incPerfCounter('refresh_skipped_noop');
      return true;
    }

    await deps.refreshSnapshot({ emitFlowBackedRefresh: false });
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => (
    getFlowBackedDeviceOptions(deps, query, target)
  ));
  card.registerArgumentAutocompleteListener('state', async (query: string) => getStateOptions(query));
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

function parseBooleanFlowValue(rawValue: unknown, errorMessage: string): boolean {
  if (typeof rawValue === 'boolean') return rawValue;
  const normalized = parseAutocompleteStringValue(rawValue).toLowerCase();
  if (normalized === 'true' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === 'off') return false;
  if (normalized === 'yes') return true;
  if (normalized === 'no') return false;
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

function emitFlowBackedCapabilityReportLog(
  deps: FlowCardDeps,
  cardId: string,
  device: HomeyDeviceLike,
  capabilityId: FlowReportedCapabilityId,
  value: boolean,
  reportOutcome: FlowBackedCapabilityReportOutcome,
  nativeCapabilityPresent: boolean,
): void {
  let event = 'flow_backed_capability_report_unchanged';
  if (nativeCapabilityPresent) {
    event = 'flow_backed_capability_report_native_overlap';
  } else if (reportOutcome.kind === 'state_changed') {
    event = 'flow_backed_capability_reported';
  } else if (reportOutcome.kind === 'freshness_only') {
    event = 'flow_backed_capability_report_freshness_updated';
  }
  (deps.structuredLog ?? moduleLogger).info({
    event,
    sourceCardId: cardId,
    deviceId: device.id,
    deviceName: device.name,
    capabilityId,
    value,
    reportKind: reportOutcome.kind,
    valueChanged: reportOutcome.valueChanged,
    freshnessAdvanced: reportOutcome.freshnessAdvanced,
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

function getYesNoAutocompleteOptions(query: string): Array<{ id: string; name: string }> {
  const options = [
    { id: 'yes', name: 'Yes' },
    { id: 'no', name: 'No' },
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
  const deviceClassKey = resolveDeviceClassKey(device);
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
  if (capabilityId === 'alarm_generic.car_connected') return false;
  const capabilities = getCapabilities(device);
  return capabilities.includes(capabilityId);
}

