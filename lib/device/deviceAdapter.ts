import type { AppActionControlTarget } from '../ports/storageCommand';
import type { HubHomeLocation } from './hubHomeLocation';
import type { ChargingCurrentSetup, ChargingMissingCompanion } from '../../packages/contracts/src/chargingControl';
import type { DeviceControlAdapterSnapshot, HomeBatteryClaimCapabilityId, HomeBatteryClaimRejection,
  HomeBatteryMeterModes, HomeBatterySetpointRange, SteppedLoadProfile, SteppedLoadStep,
  TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';
import type { DeviceActionStep } from './flowActionCards';
import type { TargetPowerConfigWithReachability } from './targetPowerReachability';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceCapabilityMap } from './managerControl';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ChargerPhaseReport } from './chargerPhasePreset';
/**
 * Where an integration exposes its current ceiling: a capability, written
 * directly when the installed app declares it writable, or only the app's
 * action card.
 */
export type ChargingCurrentSurface =
  | { kind: 'capability'; capabilityId: string; writable: boolean }
  | { kind: 'action_only' };

/** A resolved command binding, separate from the charger's binary switch. */
export type ChargingCurrentBinding = {
  deviceId: string;
  current: ChargingCurrentSurface;
  actionId: string;
  appUri: string;
  /** What one current command reaches: a car, a whole installation, or this charger alone. */
  scope: { kind: 'vehicle' } | { kind: 'installation'; installationId: string } | { kind: 'charger' };
  sharesInstallation(device: HomeyDeviceLike): boolean;
  currentArguments(currentA: number): Readonly<Record<string, unknown>>;
};

export type CapabilityWrite = { capabilityId: string; value: unknown };
export type CapabilityUpdate = CapabilityWrite;
/** A live report's view and capability as that view reads it (`DeviceAdapter.routeReport`). */
export type CapabilityRoute = { deviceId: string; capabilityId: string };
/** Preparation before reclaiming a native watt target: stop first, or safely reset its owner. */
export type TargetPowerReassertionPreparation =
  | { kind: 'stop'; write: CapabilityWrite }
  | { kind: 'ready'; resetWrites: readonly CapabilityWrite[] };
export type AdapterSnapshot = Pick<TransportDeviceSnapshot,
  'controlAdapter' | 'capabilities' | 'binaryControl' | 'evChargingState' | 'reportedStepId' | 'steppedLoadProfile'
  | 'automaticPowerControl'>;
export type AdapterObservation = Pick<TransportDeviceSnapshot, 'controlAdapter' | 'capabilities'>;
/** A parsed device a session may claim, by its surface or by the identity it has observed. */
export type AdapterControlTarget = AdapterObservation & Pick<TransportDeviceSnapshot, 'id'>;
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
/** What a switch request sends: a capability write, or no device command at all. */
export type SwitchWrite =
  | { kind: 'write'; write: CapabilityWrite; readBackAsWritten: boolean }
  | { kind: 'none' };

/**
 * Canonical amp observation an integration adds to its overlay and control
 * events when the device echoes the current it accepted as its setting, while
 * its settled reading (`available_installation_current`) still waits for the
 * device's own draw reports. Common transport resolves it to an
 * `acknowledgedStep`; it never confirms a step on its own.
 */
export const ACKNOWLEDGED_CURRENT_CAPABILITY_ID = 'pels_acknowledged_current';

/** A native current control is a real device capability, not a vendor identity. */
export type NativeCurrentControl = {
  capabilityId: string;
  writeCapabilities: readonly string[];
  minimumChargingA: number;
  accepts(device: HomeyDeviceLike, values: DeviceCapabilityMap): boolean;
  /** Physical levels derived from the integration's settings and current limits. */
  automaticProfile(device: HomeyDeviceLike, values: DeviceCapabilityMap): SteppedLoadProfile | undefined;
  stepObservations(profile: SteppedLoadProfile, capabilities: DeviceCapabilityMap): readonly string[];
};

/**
 * A claim capability a home battery's app offers: the value that hands the
 * battery to Homey (and so to PELS), and what a write the app rejected means
 * (`HomeBatteryControlSurface` claim `rejection`).
 */
export type HomeBatteryClaimBinding = {
  capabilityId: HomeBatteryClaimCapabilityId;
  homeyValue: string;
  rejection: HomeBatteryClaimRejection;
};

/** The `target_power` edges a driver leaves out are read as these, W, in the app's own sign. */
export type TargetPowerDefaults = { minW: number; maxW: number; stepW: number };

/**
 * How PELS drives a home battery, as its integration states it
 * (`notes/battery-vendor-bindings.md`). Common transport resolves the control
 * surface and the storage writes against it and names no app.
 *
 * `capability`: a writable signed `target_power`, taken over through the
 * first claim capability in `claims` that the battery declares setable with
 * its Homey value.
 * - `setpointSign`: `1` when a positive `target_power` charges (Homey's sign),
 *   `-1` when the app reads a positive value as discharge. PELS's own sign
 *   (positive charges) is kept everywhere above the transport; the declared
 *   range is flipped into it at parse and each setpoint back out at write.
 *   `measure_power` is not part of the binding: Homey's sign (positive
 *   charging) is what every battery app reports there.
 * - `rangeDefaults`: the edges read for a driver that declares none. Homey
 *   fills an undeclared edge with its own default, which reads as undeclared.
 * - `zeroSetpointW`: what PELS writes, in its own sign, for a 0 W setpoint:
 *   `0`, unless the app reads an exact 0 as one of its own modes. A hand-back
 *   still writes an exact 0.
 */
export type HomeBatteryCapabilityBinding = {
  kind: 'capability';
  claims: readonly HomeBatteryClaimBinding[];
  setpointSign: 1 | -1;
  rangeDefaults: TargetPowerDefaults;
  zeroSetpointW: number;
};

/**
 * How long one command lasts in the battery's app: until the next one
 * (`persistent`), or `lifetimeMs` after it was sent, when the app's own
 * countdown, or its own policy, drops it (`expires`). PELS sends an expiring
 * command again well before it runs out (`lib/executor/batteryExecutor.ts`).
 */
export type HomeBatteryCommandLifetime = { kind: 'persistent' } | { kind: 'expires'; lifetimeMs: number };

/**
 * A battery's app actions, resolved for one battery: the signed range PELS
 * may command, in PELS's sign, and the cards that carry each command out, in
 * order. `command` takes a setpoint already on the range's grid: positive
 * charges, negative discharges, 0 holds the battery idle under PELS. Every step
 * names a card id within the binding's app and the device it runs on; the host checks each against the
 * installed cards before PELS may drive the battery.
 */
export type HomeBatteryActions = {
  target: AppActionControlTarget;
  range: HomeBatterySetpointRange;
  command(setpointW: number): readonly DeviceActionStep[];
};

/**
 * The actions an integration resolved for a battery, or why it has none
 * (`reasonCode`: the integration's own words, logged, never matched).
 */
export type HomeBatteryTargetResolution =
  | { kind: 'resolved'; target: AppActionControlTarget }
  | { kind: 'unavailable'; reasonCode: string };

export type HomeBatteryActionsResolution =
  | { kind: 'resolved'; actions: HomeBatteryActions }
  | { kind: 'unavailable'; reasonCode: string };

/**
 * `app_actions`: a battery whose app offers control only through its own Flow
 * action cards. PELS runs them with the owner's Homey API key
 * (`HomeyActionAccess`), so the battery is drivable only while that key may
 * run Flow actions. The app reports no claim PELS could observe: PELS's own
 * claim record is the claim, and a takeover in the battery's app cannot be
 * seen.
 * - `appUri`: the battery's Homey app (`homey:app:<id>`), whose app-level
 *   cards are `<appUri>:<actionId>`.
 * - `commandLifetime`: how long the command for `setpointW` (PELS's sign, on
 *   the range's grid) lasts. An app may keep some commands and drop others.
 * - `resolve`: the actions for `device`, from the host's last full device
 *   inventory (`devices`, every device Homey lists, for an app whose control
 *   sits on a sibling device), or why there are none.
 */
export type HomeBatteryActionBinding = {
  kind: 'app_actions';
  appUri: string;
  commandLifetime(setpointW: number): HomeBatteryCommandLifetime;
  resolve(device: HomeyDeviceLike, devices: readonly HomeyDeviceLike[]): HomeBatteryActionsResolution;
  /** Hand-back is independent of the command range and admission gates. */
  resolveTarget(device: HomeyDeviceLike, devices: readonly HomeyDeviceLike[]): HomeBatteryTargetResolution;
  /** The adapter's upgrade policy for claims written before target identities were persisted. */
  resolveLegacyTarget(device: HomeyDeviceLike, devices: readonly HomeyDeviceLike[]): HomeBatteryTargetResolution;
  /**
   * The cards that return the recorded `target` to its own mode. `devices` is
   * the same inventory as `resolve`'s, for an app whose card depends on which
   * driver the target device runs.
   */
  handBack(target: AppActionControlTarget, devices: readonly HomeyDeviceLike[]): readonly DeviceActionStep[];
};

/**
 * `meter_modes`: a battery with no power setpoint that follows the whole-home
 * meter in a mode PELS writes to its claim capability (`HomeBatteryResponse`
 * `follows_meter`). PELS records the mode it held before the first write and
 * restores it on hand-back, as for any claim capability.
 * - `modes`: the claim capability's value for each kind of command.
 * - `resolvePowers`: the most the battery discharges and charges, W, from its
 *   own reads; the charge power is also its one grid-charge power. `undefined`
 *   while the device reports neither, when PELS only watches it.
 */
export type HomeBatteryModeBinding = {
  kind: 'meter_modes';
  claimCapabilityId: HomeBatteryClaimCapabilityId;
  rejection: HomeBatteryClaimRejection;
  modes: Omit<HomeBatteryMeterModes, 'gridChargeW'>;
  resolvePowers(capabilityObj: DeviceCapabilityMap): { maxDischargeW: number; maxChargeW: number } | undefined;
};

export type HomeBatteryBinding = HomeBatteryCapabilityBinding | HomeBatteryActionBinding | HomeBatteryModeBinding;

/** The host owns I/O; an integration owns the meaning of its reads and writes. */
export type DeviceAdapter = {
  matches(device: HomeyDeviceLike): boolean;
  matchesCapabilities(capabilities: readonly string[]): boolean;
  identity(device: HomeyDeviceLike): HomeyDeviceLike;
  overlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay;
  /** Resolve owner configuration against the physical target-power control. */
  configureTargetPower(
    device: HomeyDeviceLike, config: TargetPowerConfigWithReachability,
  ): TargetPowerConfigWithReachability;
  /** Convert vendor target watts into the configured planning units. */
  targetPowerReading(device: HomeyDeviceLike, config: TargetPowerSteppedLoadConfig, value: number): number;
  stepCommand(device: HomeyDeviceLike, step: SteppedLoadStep, command: CapabilityWrite): CapabilityWrite;
  stepActivationOrder: 'current_before_start' | 'start_before_current';
  /** Reads the device's own stop evidence from the accepted inventory; never starts a device. */
  prepareTargetPowerReassertion(
    device: HomeyDeviceLike, inventory: readonly HomeyDeviceLike[],
  ): TargetPowerReassertionPreparation;
  /**
   * One live report as PELS reads it, for every device the adapter matches. `device` is the
   * device's last accepted read with this report already applied.
   */
  normalize(
    snapshot: AdapterSnapshot, capabilityId: string, value: unknown, device: HomeyDeviceLike,
  ): CapabilityUpdate[];
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
  /** How PELS drives this device when it is a home battery; read only for a battery. */
  homeBatteryBinding(device: HomeyDeviceLike): HomeBatteryBinding;
  readBackAfterWrite: boolean;
  /** Whether standard production-cap writes are suitable for repeated live control. */
  supportsProductionLimits: boolean;
  /**
   * A whole-device read as PELS accepts it: the devices PELS reads from one
   * Homey device. An integration whose app keeps a standard quantity under its
   * own capability name reads it under the standard one, and one whose app
   * keeps two loads on one device reads each as its own device. The first view
   * keeps the Homey device's id; every other view has an id of the
   * integration's own that no Homey device can have. Applied once per read
   * (`resolveDeviceViews`), before validation, so everything past it (merges,
   * the accepted read, parsing) sees only views and standard names.
   */
  projectRead(device: HomeyDeviceLike): readonly HomeyDeviceLike[];
  /**
   * Where a live report for the Homey device belongs: which view, and the
   * capability as that view names it. `device` is the accepted read of the
   * first view, the one that keeps the Homey id.
   */
  routeReport(device: HomeyDeviceLike, capabilityId: string): CapabilityRoute;
  /**
   * The device's own capability for a write PELS requests on a view by its
   * standard name, for every write that is not the binary switch: the inverse
   * of `projectRead`.
   */
  capabilityWrite(view: HomeyDeviceLike, request: CapabilityWrite): CapabilityWrite;
  /** The Homey device a view is read from and written to. */
  sourceDeviceId(view: HomeyDeviceLike): string;
  /** `sessions`: the transport's adapter sessions, for what they have observed of the device. */
  switchWrite(snapshot: TransportDeviceSnapshot, request: CapabilityWrite, sessions: SessionEvidence): SwitchWrite;
  recoverSwitchWrite(
    snapshot: TransportDeviceSnapshot, raw: HomeyDeviceLike, request: CapabilityWrite, sessions: SessionEvidence,
  ): SwitchWrite;
  createSession(home: HubHomeLocation): DeviceAdapterSession;
};

/** Whether a full device list proves that a device it lacks is absent (`DeviceAdapterSession.retainDevices`). */
export type InventoryCompleteness = 'complete' | 'partial';

/** What a write resolution may read from the transport's adapter sessions. */
export type SessionEvidence = Pick<DeviceAdapterSession, 'hasCarStopEvidence'>;

/** Session details remain behind resolved eligibility. */
export type DeviceAdapterSession = {
  /** `readAtMs`: when the read that produced `device` started. */
  observeDevice(device: HomeyDeviceLike, readAtMs: number): void;
  observeCapability(deviceId: string, capabilityId: string, value: unknown): void;
  /** A full inventory: every device Homey lists, as last accepted. */
  /**
   * `inventory`: `complete` when the list proves a device it lacks is absent: read under the
   * current trust epoch, with no payload dropped at the parse.
   */
  retainDevices(devices: readonly HomeyDeviceLike[], inventory: InventoryCompleteness): void;
  /**
   * The capabilities a read of `device` is parsed without, as if it did not
   * declare them: a control it cannot hold alone, as the last full inventory
   * (`retainDevices`) shows it.
   */
  withheldCapabilities(device: HomeyDeviceLike): readonly string[];
  setTrustEpoch(epoch: string): void;
  observedIds(): string[];
  observes(deviceId: string): boolean;
  controls(snapshot: AdapterControlTarget): boolean;
  /** Positive observed evidence that the car stopped accepting energy, not a controller-off command. */
  hasCarStopEvidence(deviceId: string): boolean;
  /** A companion device the owner could pair to make control of `deviceId` more reliable. */
  missingCompanion(deviceId: string): ChargingMissingCompanion;
  project(snapshot: TransportDeviceSnapshot, setup: ChargingCurrentSetup): TransportDeviceSnapshot;
  assertAllowed(device: HomeyDeviceLike, setup: ChargingCurrentSetup, connected: boolean): void;
  controlEvents(deviceId: string, capabilityId: string, value: unknown): CapabilityUpdate[];
};

/**
 * A charger's live reports are rewritten only while its built-in control is
 * on; otherwise each report stands as the device sent it.
 */
export const whileBuiltInControlEnabled = (
  normalize: DeviceAdapter['normalize'],
): DeviceAdapter['normalize'] => (snapshot, capabilityId, value, device) => (
  snapshot.controlAdapter?.activationEnabled === true
    ? normalize(snapshot, capabilityId, value, device) : [{ capabilityId, value }]
);

export function isNativeSteppedLoadControlEnabled(snapshot: Pick<TransportDeviceSnapshot, 'controlAdapter'>): boolean {
  return snapshot.controlAdapter?.kind === 'capability_adapter'
    && snapshot.controlAdapter.activationAvailable !== undefined
    && snapshot.controlAdapter.activationEnabled === true;
}
