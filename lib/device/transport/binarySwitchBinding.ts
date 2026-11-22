import { isBinarySwitchCapability } from '../../../packages/shared-domain/src/settings/deviceBinarySwitches';
import type { DeviceControlSettings } from '../deviceControlSettings';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { toCapabilityTimestampMs } from '../managerControl';
import { plainDeviceAdapter } from '../standardDeviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';

export type BinarySwitchSettings = Pick<DeviceControlSettings,
  'getBinarySwitchSelection' | 'getBinarySwitchRevision' | 'isBinarySwitchWriteCurrent' | 'getDeviceControlProfile'>;

export function supportsBinarySwitchSetup(device: HomeyDeviceLike): boolean {
  return getDeviceAdapter(device) === plainDeviceAdapter
    && !['evcharger', 'battery', 'solarpanel', 'car', 'vehicle'].includes(device.class.trim().toLowerCase())
    && !device.capabilities.includes('target_power');
}

function declaresReadableSwitch(device: HomeyDeviceLike, id: string): boolean {
  if (!isBinarySwitchCapability(id)) return false;
  const entry = device.capabilitiesObj[id];
  return device.capabilities.includes(id) && entry?.setable === true && entry.getable !== false;
}

export function availableBinarySwitches(device: HomeyDeviceLike): { id: string; name: string }[] {
  if (!supportsBinarySwitchSetup(device)) return [];
  return device.capabilities.flatMap((id) => {
    const entry = device.capabilitiesObj[id];
    if (id === 'onoff' || !declaresReadableSwitch(device, id) || typeof entry?.value !== 'boolean'
        || toCapabilityTimestampMs(entry.lastUpdated) === undefined) return [];
    const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : undefined;
    const suffix = id.slice('onoff.'.length);
    const name = title ?? suffix.charAt(0).toUpperCase() + suffix.slice(1);
    return [{ id, name }];
  });
}

export function selectedBinarySwitch(
  device: HomeyDeviceLike, settings: BinarySwitchSettings | undefined,
): HomeyDeviceLike['selectedBinarySwitch'] {
  if (!settings) return undefined;
  const id = settings.getBinarySwitchSelection(device.id);
  if (id === undefined) return undefined;
  const previous = device.selectedBinarySwitch;
  const eligible = supportsBinarySwitchSetup(device) && !settings.getDeviceControlProfile(device.id);
  const priorMetadata = previous?.id === id && previous.declaredReadableSwitch
    && !device.capabilities.includes(id) && device.capabilitiesObj[id] === undefined;
  return {
    id,
    revision: settings.getBinarySwitchRevision(device.id),
    declaredReadableSwitch: eligible && (declaresReadableSwitch(device, id) || priorMetadata),
  };
}

/** Copies and compares observations only within the same selected physical switch. */
export function sameBinarySwitchBinding(previous: TransportDeviceSnapshot, next: TransportDeviceSnapshot): boolean {
  return previous.binaryCapabilityId === next.binaryCapabilityId
    && previous.binarySwitchSelectionRevision === next.binarySwitchSelectionRevision;
}

type Binding = { revision: number; capabilityId: string | undefined; generation: number };

/** The authority to execute a plan's switch intent follows a particular accepted binding. */
export class BinarySwitchBindings {
  private readonly accepted = new Map<string, Binding>();
  private nextGeneration = 0;

  constructor(readonly settings: BinarySwitchSettings | undefined) {}

  selection(device: HomeyDeviceLike) { return selectedBinarySwitch(device, this.settings); }

  commit(deviceId: string, capabilityId: string | undefined): number | undefined {
    const revision = this.settings?.getBinarySwitchRevision(deviceId) ?? 0;
    const previous = this.accepted.get(deviceId);
    if (revision === 0 && previous === undefined) return undefined;
    if (previous?.revision === revision && previous.capabilityId === capabilityId) return previous.generation;
    this.nextGeneration += 1;
    this.accepted.set(deviceId, { revision, capabilityId, generation: this.nextGeneration });
    return this.nextGeneration;
  }

  allows(deviceId: string, generation: number | undefined): boolean {
    const current = this.accepted.get(deviceId);
    return generation === current?.generation
      && (current?.revision ?? 0) === (this.settings?.getBinarySwitchRevision(deviceId) ?? 0)
      && this.settings?.isBinarySwitchWriteCurrent(deviceId) !== false;
  }
}
