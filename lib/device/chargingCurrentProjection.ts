import type { ChargingInstallation } from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ChargingCurrentRead } from '../../packages/contracts/src/chargingControl';
import type { ChargingCurrentBinding } from './deviceAdapter';

export function projectedInstallationRole(installation: ChargingInstallation | undefined, deviceId: string) {
  if (!installation) return undefined;
  return installation.mainId === deviceId ? 'main' : 'secondary';
}

export function describeCurrentBinding(adapter: ChargingCurrentBinding | undefined): Pick<
  ChargingCurrentRead, 'scope' | 'capabilityWritable' | 'supportsAppAction'
> {
  return {
    scope: adapter?.scope.kind ?? 'installation',
    capabilityWritable: adapter?.current.kind === 'capability' && adapter.current.writable,
    supportsAppAction: adapter?.supportsAppAction === true,
  };
}

export function withChargingInstallation(
  source: TransportDeviceSnapshot, chargingInstallation: ChargingInstallation | undefined,
): TransportDeviceSnapshot {
  if (!chargingInstallation) {
    if (source.controlAdapter?.chargingInstallation === undefined) return source;
    const { chargingInstallation: _dropped, ...controlAdapter } = source.controlAdapter;
    return { ...source, controlAdapter };
  }
  return { ...source, controlAdapter: {
    kind: 'capability_adapter', activationRequired: false, activationEnabled: false,
    ...source.controlAdapter, chargingInstallation,
  } };
}

// A retained snapshot (one whose refresh read was rejected) is projected again
// as it is, so a route that is now held back must lose the flag it carried.
export function withCurrentRoute(source: TransportDeviceSnapshot, builtIn: boolean): TransportDeviceSnapshot {
  if (builtIn) {
    return { ...source, controlAdapter: {
      kind: 'capability_adapter', activationRequired: false, activationEnabled: false,
      ...source.controlAdapter, currentControl: 'built_in',
    } };
  }
  if (!source.controlAdapter) return source;
  if (source.controlAdapter.currentControl === undefined) return source;
  const { currentControl: _heldBack, ...controlAdapter } = source.controlAdapter;
  return { ...source, controlAdapter };
}
