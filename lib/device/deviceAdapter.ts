import type { HubHomeLocation } from './hubHomeLocation';
import type { ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import type { DeviceControlAdapterSnapshot, SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceCapabilityMap } from './managerControl';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ChargerPhaseReport } from './chargerPhasePreset';
/** A resolved command binding, separate from the charger's binary switch. */
export type ChargingCurrentBinding = {
  deviceId: string;
  currentCapabilityId: string;
  currentWritable: boolean;
  actionId: string;
  appUri: string;
  scope: { kind: 'vehicle' } | { kind: 'installation'; installationId: string };
  sharesInstallation(device: HomeyDeviceLike): boolean;
  currentArguments(currentA: number): Readonly<Record<string, unknown>>;
};

export type CapabilityWrite = { capabilityId: string; value: unknown };
export type CapabilityUpdate = CapabilityWrite;
export type AdapterSnapshot = Pick<TransportDeviceSnapshot,
  'controlAdapter' | 'capabilities' | 'binaryControl' | 'evChargingState' | 'reportedStepId' | 'steppedLoadProfile'>;
export type AdapterObservation = Pick<TransportDeviceSnapshot, 'controlAdapter' | 'capabilities'>;
export type DeviceReadRule = 'boolean' | 'number' | 'string' | ((value: unknown) => boolean);
export type DeviceReadRules = Readonly<Record<string, DeviceReadRule>>;
export type DeviceEvOverlay = { capabilities: string[]; capabilityObj: DeviceCapabilityMap } & (
  | { kind: 'standard' }
  | { kind: 'adapted'; controlAdapter: DeviceControlAdapterSnapshot;
      binaryTarget: BinaryTarget }
);
export type BinaryTarget =
  | { kind: 'canonical' }
  | { kind: 'capability'; writeCapabilityId: string; observationCapabilityId: string };
export type SwitchWrite = { write: CapabilityWrite; readBackAsWritten: boolean };

/** A native current control is a real device capability, not a vendor identity. */
export type NativeCurrentControl = {
  capabilityId: string;
  writeCapabilities: readonly string[];
  minimumChargingA: number;
  accepts(device: HomeyDeviceLike, values: DeviceCapabilityMap): boolean;
  stepObservations(profile: SteppedLoadProfile, capabilities: DeviceCapabilityMap): readonly string[];
};

/** The host owns I/O; an integration owns the meaning of its reads and writes. */
export type DeviceAdapter = {
  matches(device: HomeyDeviceLike): boolean;
  matchesCapabilities(capabilities: readonly string[]): boolean;
  identity(device: HomeyDeviceLike): HomeyDeviceLike;
  overlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay;
  normalize(snapshot: AdapterSnapshot, capabilityId: string, value: unknown): CapabilityUpdate[];
  observation(device: HomeyDeviceLike): DeviceCapabilityMap;
  finalizeObservation(
    control: DeviceControlAdapterSnapshot,
    capabilities: readonly string[],
    values: DeviceCapabilityMap,
  ): DeviceCapabilityMap;
  readRules(device: HomeyDeviceLike): DeviceReadRules;
  retainsPlugObservation(device: HomeyDeviceLike): boolean;
  phaseReport(device: HomeyDeviceLike): ChargerPhaseReport;
  currentBindings(device: HomeyDeviceLike): ChargingCurrentBinding[];
  nativeCurrentControls: readonly NativeCurrentControl[];
  readBackAfterWrite: boolean;
  switchWrite(snapshot: TransportDeviceSnapshot, request: CapabilityWrite): SwitchWrite;
  recoverSwitchWrite(snapshot: TransportDeviceSnapshot, raw: HomeyDeviceLike, request: CapabilityWrite): SwitchWrite;
  createSession(home: HubHomeLocation): DeviceAdapterSession;
};

/** Session details remain behind resolved eligibility. */
export type DeviceAdapterSession = {
  observeDevice(device: HomeyDeviceLike): void;
  observeCapability(deviceId: string, capabilityId: string, value: unknown): void;
  retainDevices(devices: readonly HomeyDeviceLike[]): void;
  setTrustEpoch(epoch: string): void;
  observedIds(): string[];
  observes(deviceId: string): boolean;
  controls(snapshot: AdapterObservation): boolean;
  project(snapshot: TransportDeviceSnapshot, setup: ChargingCurrentSetup): TransportDeviceSnapshot;
  assertAllowed(device: HomeyDeviceLike, setup: ChargingCurrentSetup, connected: boolean): void;
  controlEvents(deviceId: string, capabilityId: string, value: unknown): CapabilityUpdate[];
};

export function isNativeSteppedLoadControlEnabled(snapshot: Pick<TransportDeviceSnapshot, 'controlAdapter'>): boolean {
  return snapshot.controlAdapter?.kind === 'capability_adapter'
    && snapshot.controlAdapter.activationAvailable !== undefined
    && snapshot.controlAdapter.activationEnabled === true;
}
