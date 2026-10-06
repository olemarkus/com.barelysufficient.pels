import type { DeviceDescriptorRead } from '../packages/contracts/src/types';
import type { ModeTargetSelection } from '../lib/home/modeDeviceTargetWrite';
import { writeDevicePriceAdjustment } from '../lib/price/priceOptimizationSettingsStore';
import { writeTemperatureControlMode } from '../lib/device/temperatureControlSettings';
import {
  MAX_PRICE_ADJUSTMENT_C,
  type PriceAdjustmentKind,
} from '../packages/shared-domain/src/settings/priceOptimization';
import {
  readTemperatureControlModes,
  type TemperatureControlMode,
} from '../packages/shared-domain/src/settings/temperatureControl';
import type { FlowCardDeps } from './registerFlowCards';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import {
  readFlowDeviceArg,
  readFlowNumberArg,
  readFlowRawArg,
  readFlowStringArg,
} from './flowArgParsers';

/**
 * Flow cards for the per-device temperature settings the settings UI edits:
 * the temperature in each mode, the price adjustments, and what happens when
 * the temperature changes outside PELS. Each card writes the setting through
 * its owner, which also holds the rules for what may be written; the card
 * parses its arguments and turns the owner's answer into a message. No card
 * holds state of its own: a Flow that wants a temporary change sets the value
 * back itself.
 */

// The "When the temperature changes outside PELS" row shows for every
// temperature device; the per-mode and price sections only for one PELS manages.
type DeviceGate = (device: DeviceDescriptorRead) => boolean;

const isTemperatureDevice: DeviceGate = (device) => !device.isBatteryOrSolar && device.deviceType === 'temperature';

const isManagedTemperatureDevice: DeviceGate = (device) => isTemperatureDevice(device) && device.managed === true;

const ACTIVE_MODE_OPTION = {
  id: 'active-mode',
  name: 'Active mode',
  description: 'The mode in force when the Flow runs',
  activeMode: true,
} as const;

const PRICE_ADJUSTMENT_LABELS: Record<PriceAdjustmentKind, string> = {
  cheap_hour_boost: 'Cheap-hour boost',
  expensive_hour_reduction: 'Expensive-hour reduction',
};

export function registerTemperatureSettingsCards(deps: FlowCardDeps): void {
  registerModeTemperatureCard(deps);
  registerPriceAdjustmentCard(deps);
  registerTemperatureControlModeCard(deps);
}

function registerModeTemperatureCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('set_device_mode_temperature');
  card.registerRunListener(async (args: unknown) => {
    const device = await requireDevice(args, deps, isManagedTemperatureDevice);
    const temperature = readFlowNumberArg(args, 'temperature');
    if (temperature === null) throw new Error('Temperature must be a number.');
    const selection = readModeSelection(args);
    const targetC = normalizeTemperature(deps, device.id, temperature);
    const edit = deps.setDeviceModeTarget(device.id, selection, targetC);
    if (edit.state === 'unknown_mode') {
      throw new Error(selection.kind === 'active'
        ? 'The active mode has no saved temperature yet. Set one in the device\'s Temperature per mode section first.'
        : `There is no mode named "${selection.name}" any more. Choose the mode again.`);
    }
    if (edit.state === 'unavailable') throw new Error('PELS could not save the temperature. Try again shortly.');
    logSettingSaved(deps, device, { setting: 'mode_temperature', outcome: edit.state, mode: edit.mode, targetC });
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => (
    getDeviceOptions(deps, query, isManagedTemperatureDevice)
  ));
  card.registerArgumentAutocompleteListener('mode', async (query: string, args?: Record<string, unknown>) => {
    const deviceId = readFlowDeviceArg(args);
    const modes = (deviceId ? deps.listDeviceTargetModes(deviceId) : null) ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    return [
      ACTIVE_MODE_OPTION,
      ...modes.map((mode) => ({ id: mode, name: mode })),
    ].filter((option) => !normalizedQuery || option.name.toLowerCase().includes(normalizedQuery));
  });
}

function registerPriceAdjustmentCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('set_device_price_adjustment');
  card.registerRunListener(async (args: unknown) => {
    const device = await requireDevice(args, deps, isManagedTemperatureDevice);
    const kind = readPriceAdjustmentKind(args);
    const sizeC = readFlowNumberArg(args, 'amount');
    const outcome = sizeC === null
      ? 'out_of_range'
      : writeDevicePriceAdjustment(deps.homey.settings, device.id, kind, sizeC);
    if (outcome === 'out_of_range') {
      throw new Error(`${PRICE_ADJUSTMENT_LABELS[kind]} must be between 0 and ${MAX_PRICE_ADJUSTMENT_C} °C.`);
    }
    if (outcome === 'price_control_off') {
      throw new Error('Turn on Price-based control in this device\'s Setup section in PELS first.');
    }
    if (outcome === 'unavailable') throw new Error('PELS could not save the price adjustment. Try again shortly.');
    logSettingSaved(deps, device, { setting: kind, outcome, sizeC });
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => (
    getDeviceOptions(deps, query, isManagedTemperatureDevice)
  ));
}

function registerTemperatureControlModeCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('set_device_temperature_control_mode');
  card.registerRunListener(async (args: unknown) => {
    const device = await requireDevice(args, deps, isTemperatureDevice);
    const mode = readTemperatureControlModeArg(args);
    const outcome = writeTemperatureControlMode(
      deps.homey.settings, device.id, mode, deps.readSmartTaskInProgress(device.id),
    );
    if (outcome === 'blocked_by_smart_task') {
      throw new Error(
        'Clear this device\'s active Smart task first. Until then, only Return to mode target is allowed.',
      );
    }
    if (outcome === 'unavailable') throw new Error('PELS could not save the choice. Try again shortly.');
    logSettingSaved(deps, device, { setting: 'temperature_control_mode', outcome, mode });
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => (
    getDeviceOptions(deps, query, isTemperatureDevice)
  ));
}

async function requireDevice(
  args: unknown,
  deps: FlowCardDeps,
  gate: DeviceGate,
): Promise<DeviceDescriptorRead> {
  const deviceId = readFlowDeviceArg(args);
  if (!deviceId) throw new Error('Choose a device.');
  const descriptors = await deps.getDeviceDescriptors();
  const device = descriptors.find((entry) => entry.id === deviceId);
  if (!device) throw new Error('PELS does not know this device.');
  if (!gate(device)) {
    throw new Error(gate === isTemperatureDevice
      ? `${device.name} is not a temperature device.`
      : `${device.name} is not a temperature device managed by PELS.`);
  }
  return device;
}

async function getDeviceOptions(
  deps: FlowCardDeps,
  query: string,
  gate: DeviceGate,
): Promise<Array<{ id: string; name: string }>> {
  const descriptors = await deps.getDeviceDescriptors();
  return buildDeviceAutocompleteOptions(descriptors.filter(gate), query);
}

function readModeSelection(args: unknown): ModeTargetSelection {
  const raw = readFlowRawArg(args, 'mode');
  if (raw !== null && typeof raw === 'object' && (raw as { activeMode?: unknown }).activeMode === true) {
    return { kind: 'active' };
  }
  const name = readFlowStringArg(args, 'mode');
  if (!name) throw new Error('Choose a mode.');
  return { kind: 'named', name };
}

function normalizeTemperature(deps: FlowCardDeps, deviceId: string, temperature: number): number {
  try {
    return deps.normalizeTemperatureTarget(deviceId, temperature);
  } catch {
    throw new Error('PELS cannot set a temperature on this device right now.');
  }
}

function readPriceAdjustmentKind(args: unknown): PriceAdjustmentKind {
  const raw = readFlowStringArg(args, 'adjustment');
  if (raw === 'cheap_hour_boost' || raw === 'expensive_hour_reduction') return raw;
  throw new Error('Choose Cheap-hour boost or Expensive-hour reduction.');
}

function readTemperatureControlModeArg(args: unknown): TemperatureControlMode {
  const raw = readFlowStringArg(args, 'choice');
  const mode = readTemperatureControlModes({ choice: raw })?.choice;
  if (!mode) throw new Error('Choose what happens when the temperature changes outside PELS.');
  return mode;
}

function logSettingSaved(
  deps: FlowCardDeps,
  device: DeviceDescriptorRead,
  change: { setting: string; outcome: 'written' | 'unchanged' } & Record<string, unknown>,
): void {
  deps.getStructuredLogger('devices')?.info({
    event: 'flow_device_setting_saved',
    deviceId: device.id,
    deviceName: device.name,
    ...change,
  });
}
