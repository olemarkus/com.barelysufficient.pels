import type { ChargingInstallation } from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ChargingCurrentRead, ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
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

export function describeCurrentFlowCheck(
  names: ReadonlyMap<string, string> | undefined,
): Pick<ChargingCurrentRead, 'flowCheck' | 'flowNames'> {
  if (!names) return { flowCheck: 'unavailable', flowNames: [] };
  return { flowCheck: names.size > 0 ? 'conflict' : 'clear', flowNames: [...names.values()] };
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

export function withCurrentActionHold(
  source: TransportDeviceSnapshot, reason: string | undefined,
): TransportDeviceSnapshot {
  const { controlAdapter } = source;
  // A charging charger stays commandable so the planner can stop it; the
  // transport still refuses its starts and current writes (`assertControlAllowed`).
  if (reason === undefined || !controlAdapter || controlAdapter.unavailableStatus || source.evCharging === true) {
    return source;
  }
  return { ...source, controlAdapter: {
    ...controlAdapter, unavailableStatus: { kind: 'idle', factText: null, reasonText: reason },
  } };
}

export function readChargingCurrentSetup(value: unknown): ChargingCurrentSetup | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('method' in value) || (value.method !== 'flow' && value.method !== 'built_in')) return undefined;
  if (!('confirmation' in value)) return undefined;
  const { confirmation } = value;
  if (confirmation !== 'none' && confirmation !== 'vehicle' && confirmation !== 'single_charger') return undefined;
  return { method: value.method, confirmation };
}

export function lazyChargingCurrentSetup(read: () => ChargingCurrentSetup): () => ChargingCurrentSetup {
  let setup: ChargingCurrentSetup | undefined;
  return () => setup ??= read();
}

export function trustEpochOf(trust: { connected: boolean; revision: number }): string {
  return `${trust.connected}:${trust.revision}`;
}
