import type { DevicePowerSetupEntry } from '../../../contracts/src/settingsUi/devices.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { HOMEY_ENERGY_SETUP_REASON } from '../../../shared-domain/src/homeyEnergySetup.ts';
import type { SetupDraft } from './devicePowerSetupWrites.ts';

export const CHOOSE_SWITCH = 'pels-choose-switch';
export type SetupOption = { value: string; label: string; disabled?: boolean };
const unavailableReason = (state: DevicePowerSetupEntry['sources'][number]['state']): string => {
  switch (state) {
    case 'managed': return 'Turn off Managed by PELS to use this socket';
    case 'assigned': return 'Already measures another device';
    case 'unavailable': return 'Unavailable as a power source';
    default: return '';
  }
};

export function sourceOptions(entry: DevicePowerSetupEntry | undefined, selected: string): SetupOption[] {
  const options = (entry?.sources ?? []).map((socket) => {
    const reason = unavailableReason(socket.state);
    const name = formatDisplayDeviceName(socket.name);
    return { value: socket.id, label: reason ? `${name} (${reason})` : name, disabled: reason !== '' };
  });
  if (selected && !options.some(({ value }) => value === selected)) {
    options.push({ value: selected, label: 'Metering socket unavailable', disabled: true });
  }
  // "This device" only when it has a reading of its own to use.
  const ownLabel = entry?.ownPowerW === undefined ? 'None' : 'This device';
  return [{ value: '', label: ownLabel }, ...options];
}

export function sourceHelp(
  entry: DevicePowerSetupEntry | undefined, selected: string, offersHomeyEnergy: boolean,
): string {
  if (!entry) return '';
  const socket = entry.sources.find(({ id }) => id === selected);
  if (selected && selected === entry.sourceId && !entry.sourceReady) {
    return socket ? `Waiting for a power reading from ${formatDisplayDeviceName(socket.name)}.`
      : 'The configured metering socket is unavailable. Choose another power source.';
  }
  if (socket?.state && socket.state !== 'selectable') return unavailableReason(socket.state);
  const own = entry.ownPowerW;
  if (socket) {
    const name = formatDisplayDeviceName(socket.name);
    const assignment = own === undefined ? `PELS reads this device's power from ${name}.`
      : `PELS uses ${name} instead of this device's own reading.`;
    return socket.measuredPowerW === undefined ? assignment
      : `${assignment} Latest reading: ${socket.measuredPowerW.toLocaleString()} W.`;
  }
  if (own !== undefined) return `Uses this device's own reading, now ${own.toLocaleString()} W.`;
  return unmeteredSourceHelp(entry, offersHomeyEnergy && !selected);
}

function unmeteredSourceHelp(entry: DevicePowerSetupEntry, offersHomeyEnergy: boolean): string {
  const meterHelp = entry.sources.some(({ state }) => state === 'selectable' || state === 'managed')
    ? 'This device has no power reading. Choose a metering socket to measure it.'
    : 'No metering socket is available. Add one in Homey, then refresh devices.';
  return offersHomeyEnergy
    ? `${meterHelp} ${HOMEY_ENERGY_SETUP_REASON} to use a fixed power estimate.`
    : meterHelp;
}

export function switchOptions(
  entry: DevicePowerSetupEntry | undefined, selected: string, guided: boolean,
): SetupOption[] {
  const options: SetupOption[] = (entry?.binarySwitches ?? []).map(({ id, name }) => ({ value: id, label: name }));
  if (selected && selected !== CHOOSE_SWITCH && !options.some(({ value }) => value === selected)) {
    options.push({ value: selected, label: 'Selected switch unavailable', disabled: true });
  }
  if (guided) {
    if (entry?.defaultBinarySwitchAvailable) options.unshift({ value: '', label: 'Default on/off switch' });
    return [{ value: CHOOSE_SWITCH, label: 'Choose a switch', disabled: true }, ...options];
  }
  const defaultLabel = entry?.defaultBinarySwitchAvailable === false ? 'No on/off control' : 'Default';
  return [{ value: '', label: defaultLabel }, ...options];
}

export function hasUsableSwitch(entry: DevicePowerSetupEntry | undefined, switchId: string): boolean {
  if (switchId) return entry?.binarySwitches?.some(({ id }) => id === switchId) ?? false;
  return entry?.defaultBinarySwitchAvailable === true;
}

export const hasSwitchChoice = (entry: DevicePowerSetupEntry): boolean => (
  Boolean(entry.binarySwitches?.length || entry.binarySwitchId)
);

export function canReviewWiring(entry: DevicePowerSetupEntry, draft: SetupDraft): boolean {
  if (hasSwitchChoice(entry) && !hasUsableSwitch(entry, draft.switchId)) return false;
  if (draft.source) return entry.sources.some(({ id, state }) => id === draft.source && state === 'selectable');
  return draft.lastResort || entry.ownPowerW !== undefined;
}
