import type { DeviceDescriptorRead } from '../../packages/contracts/src/types';

/** Inventory scope for the aggregate generation/forecast shared by battery consumers. */
export type BatterySolarScopeSource = {
  mainDevices(): readonly Pick<DeviceDescriptorRead, 'id' | 'deviceClass'>[];
  allDevices(): readonly Pick<DeviceDescriptorRead, 'id' | 'deviceClass'>[];
};

/** An aggregate cannot attribute Main's share when another meter area also has PV. */
export function resolveBatterySolarScope(source: BatterySolarScopeSource): 'none' | 'main' | 'shared' {
  const main = source.mainDevices().filter(device => device.deviceClass === 'solarpanel');
  if (main.length === 0) return 'none';
  const mainIds = new Set(main.map(device => device.id));
  return source.allDevices().some(device => device.deviceClass === 'solarpanel' && !mainIds.has(device.id))
    ? 'shared' : 'main';
}
