import { SteppedLoadTransportError } from '../ports/steppedLoadWrite';
import { DeviceAdapterSessions, getDeviceAdapter } from './deviceAdapterRegistry';
import { HubHomeLocation } from './hubHomeLocation';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ChargingCurrentRead, ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import type { ChargingInstallation } from '../../packages/contracts/src/types';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { HomeyDeviceLike } from '../utils/types';
import { readFlowCapabilityWrites, type FlowReadResult } from '../flowApi/readUserFlows';
import type { FlowCapabilityWrites, UserFlowFacts } from '../flowApi/userFlows';
import type { AcceptedFlowConflictSlice } from '../flowApi/acceptedFlowConflictStore';
import { normalizeError } from '../utils/errorUtils';
import { resolveHomeyHttpStatusCode } from '../utils/homeyHttpStatusError';
import { HomeyRequestInFlightError } from '../utils/homeyRequestInFlightError';
import { isBuiltInControlInEffect, type UnusedBuiltInControl } from './builtInControlFlowGate';
import {
  canSetChargingCurrent, hasSharedChargingInstallation, resolveChargingCurrentAdapter, resolveChargingCurrentAction,
  installationPresetWattsPerAmp, resolveInstallationCurrentTargetPowerObservation,
} from './chargingCurrentAdapter';
import type { CapabilityWrite, ChargingCurrentBinding } from './deviceAdapter';
import { ChargingInstallationControl } from './chargingInstallationControl';
import type { HomeyActionAccess } from './transport/homeyActionAccess';
import type { PowerSourceHome } from './transport/externalDevicePower';
import type { FlowActionCardInventory } from './flowActionCardInventory';
import type { Logger } from '../utils/types';
import type { DeviceControlSettings } from './deviceControlSettings';
import { getRawFromHomeyApi } from './transport/managerHomeyApi';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { hasNativeTargetPowerLadder, resolveTargetPowerSteppedControl } from './nativeSteppedLoadWiring';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { WATT_CONTROL_CAPABILITIES } from './targetPowerControlClaims';
import { resolveDeviceCompatibilityTargetPowerConfig } from './compatibility';

const SETTINGS_KEY = 'charging_current_control';
const MIN_CURRENT_A = 6;
const SECONDARY_CURRENT_ERROR = 'This charger shares its installation current; PELS sets it through another charger.';
const SHARED_CURRENT_UNAVAILABLE = 'PELS cannot set the shared current for this installation.';
const DEFAULT_SETUP: ChargingCurrentSetup = { method: 'flow', confirmation: 'none' };

/** What a Flow writes to set this binding's current: its capability, if any, and its action. */
function currentSettingCapabilities(adapter: ChargingCurrentBinding): string[] {
  return adapter.current.kind === 'capability' ? [adapter.current.capabilityId, adapter.actionId] : [adapter.actionId];
}

/** The Flows that write this binding's current, by Flow id. */
function currentSettingFlows(adapter: ChargingCurrentBinding, writes: FlowCapabilityWrites): Map<string, string> {
  const names = new Map<string, string>();
  for (const capability of currentSettingCapabilities(adapter)) {
    for (const [id, name] of writes.get(adapter.deviceId)?.get(capability) ?? []) names.set(id, name);
  }
  return names;
}

function readSetup(value: unknown): ChargingCurrentSetup | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('method' in value) || (value.method !== 'flow' && value.method !== 'built_in')) return undefined;
  if (!('confirmation' in value)) return undefined;
  const { confirmation } = value;
  if (confirmation !== 'none' && confirmation !== 'vehicle' && confirmation !== 'single_charger') return undefined;
  return { method: value.method, confirmation };
}

/** What a device parse reads from the current-route owner. */
export type ChargingCurrentParseRead = Pick<
  ChargingCurrentControl, 'requiresManualControl' | 'withdrawsCurrentLadder' | 'withholdsInstallationSteps'
  | 'isInstallationMain'
>;

/** Owns current-route selection. Binary control remains independent of this choice. */
export class ChargingCurrentControl {
  readonly sessions: DeviceAdapterSessions;
  private readonly homeLocation = new HubHomeLocation();
  private readonly setups = new Map<string, ChargingCurrentSetup>();
  private setupsReadState: 'unavailable' | 'resolved' = 'unavailable';
  // The last Flow list PELS accepted, seeded from the one saved before the
  // restart. Empty with nothing saved: nothing is held back, the same as a Flow
  // list with no writes.
  private flowWrites: FlowCapabilityWrites = new Map();
  // The charging devices the reads carried, for a device the committed list
  // does not hold yet: that list is adopted only after projection, so it is
  // empty for the first refresh after a boot and lacks a device new in this read.
  private readonly observedDevices = new Map<string, HomeyDeviceLike>();
  private readonly installations: ChargingInstallationControl;

  /**
   * @param access The owner's Homey API key and the one runner of every app
   *   action card (`HomeyActionAccess`), built by the device transport and
   *   shared with the home-battery action host.
   */
  // eslint-disable-next-line max-params -- Direct owner collaborators, not an argument bag.
  constructor(
    private readonly settings: SettingsPort,
    readonly access: HomeyActionAccess,
    private readonly cardInventory: FlowActionCardInventory,
    private readonly logger: Pick<Logger, 'structuredLog'>,
    private readonly getDevices: () => readonly HomeyDeviceLike[],
    private readonly readTrust: () => { connected: boolean; revision: number },
    private readonly flowWritesStore: AcceptedFlowConflictSlice<FlowCapabilityWrites>,
    private readonly deviceSettings: Pick<
      DeviceControlSettings, 'resolveDevicePowerControlMode' | 'getDeviceTargetPowerConfig'
      | 'isManaged' | 'isControllable'
    >,
    resolveHome: PowerSourceHome = () => undefined,
  ) {
    this.sessions = new DeviceAdapterSessions(this.homeLocation, (device) => this.installations.accessOf(device));
    this.installations = new ChargingInstallationControl(
      this.sessions, (id) => this.findDevice(id), resolveHome, deviceSettings,
      (device) => this.hasInstallationRoute(device), logger,
    );
    // Unreadable, nothing is held back until the next scan; that scan's save
    // rewrites whatever rows the store still holds.
    try {
      this.flowWrites = this.flowWritesStore.read();
    } catch (error) {
      this.logger.structuredLog.error({ event: 'charging_flow_writes_read_failed', err: normalizeError(error) });
    }
  }

  // Saves only what the routes read, the current-setting Flows of the devices
  // with a charging-current binding; the store writes only the rows that
  // changed. Best-effort: a failed save costs only the restart window it
  // covers, and is retried by the next accept.
  private saveFlowWrites(): void {
    try {
      this.flowWritesStore.write(this.currentSettingWrites());
    } catch (error) {
      this.logger.structuredLog.error({ event: 'charging_flow_writes_save_failed', err: normalizeError(error) });
    }
  }

  private currentSettingWrites(): FlowCapabilityWrites {
    const relevant: FlowCapabilityWrites = new Map();
    for (const device of this.knownDevices()) {
      const adapter = resolveChargingCurrentAdapter(device);
      if (!adapter) continue;
      const capabilities = new Map<string, Map<string, string>>();
      for (const capability of currentSettingCapabilities(adapter)) {
        const flows = this.flowWrites.get(device.id)?.get(capability);
        if (flows && flows.size > 0) capabilities.set(capability, flows);
      }
      if (capabilities.size > 0) relevant.set(device.id, capabilities);
    }
    return relevant;
  }

  private knownDevices(): HomeyDeviceLike[] {
    const devices = new Map(this.observedDevices);
    for (const device of this.getDevices()) devices.set(device.id, device);
    return [...devices.values()];
  }

  /** Read before the first snapshot, so a home session can start on the first observation. */
  refreshHomeLocation(): Promise<void> { return this.homeLocation.refreshIfDue(); }

  synchronizeTrust(): boolean {
    const trust = this.readTrust();
    this.sessions.setTrustEpoch(trustEpochOf(trust));
    return trust.connected;
  }

  /** The live feed's trust epoch now: a full read records it before it fetches (`retainDevices`). */
  trustEpoch(): string { return trustEpochOf(this.readTrust()); }

  observeDevices(devices: readonly HomeyDeviceLike[], readAtMs: number): void {
    for (const device of devices) {
      if (resolveChargingCurrentAdapter(device) || this.sessions.sharedChargingMemberIds(device)) {
        this.observedDevices.set(device.id, device);
      }
    }
    void this.homeLocation.refreshIfDue();
    if (this.synchronizeTrust()) this.sessions.observeDevices(devices, readAtMs);
  }

  /** `capabilityId`: the capability a write sets; refused on a charging installation's secondary. */
  assertControlAllowed(device: HomeyDeviceLike, capabilityId?: string): void {
    if (capabilityId !== undefined) this.assertInstallationWrite(device.id, capabilityId);
    const connected = this.synchronizeTrust();
    this.sessions.assertAllowed(device, this.setup(device.id), connected);
  }

  /**
   * Accepts a readable Flow list. Answers whether it changed which devices PELS
   * sets the current of itself, so the caller can re-project the snapshot.
   */
  acceptFlowFacts(facts: UserFlowFacts): boolean {
    const before = this.builtInRouteKey();
    this.flowWrites = facts.writes;
    this.saveFlowWrites();
    return this.builtInRouteKey() !== before;
  }

  /** The Flow list last accepted, for a caller that may have to restore it. */
  get acceptedFlowWrites(): FlowCapabilityWrites { return this.flowWrites; }

  /** Puts back an earlier accepted list, when applying a later one failed. */
  restoreFlowWrites(writes: FlowCapabilityWrites): void {
    this.flowWrites = writes;
    this.saveFlowWrites();
  }

  /**
   * Whether PELS sets this device's current itself: the owner selected built-in
   * control, the installed app offers a way to set it (`canSetChargingCurrent`)
   * and no Flow is known to set the same current (`isBuiltInControlInEffect`).
   * Otherwise the current goes through the owner's Flow, as with Flow control
   * selected.
   */
  routesBuiltIn(deviceId: string): boolean {
    return this.routesBuiltInFor(deviceId, this.setup(deviceId));
  }

  /**
   * A full inventory: sessions keep only its devices, and so does the read-side lookup.
   * It proves a device it lacks is absent only when it was fetched under the trust epoch in
   * force now (`startedUnder`, from `trustEpoch` before the fetch) and dropped no payload at
   * the parse; otherwise a session keeps failing closed on a companion it does not see.
   */
  retainDevices(devices: readonly HomeyDeviceLike[], startedUnder: string, rejectedPayloads: number): void {
    // Synchronized first, so the record survives the observation that follows in the same refresh.
    this.synchronizeTrust();
    const inventory = rejectedPayloads === 0 && startedUnder === this.trustEpoch() ? 'complete' : 'partial';
    this.sessions.retainDevices(devices, inventory);
    if (inventory !== 'complete') return;
    const present = new Set(devices.map((device) => device.id));
    for (const id of this.observedDevices.keys()) if (!present.has(id)) this.observedDevices.delete(id);
    this.installations.logChanges(devices);
  }

  // The committed record when there is one (realtime updates keep it current),
  // else the one the read being projected carried.
  private findDevice(deviceId: string): HomeyDeviceLike | undefined {
    return this.getDevices().find((entry) => entry.id === deviceId) ?? this.observedDevices.get(deviceId);
  }

  /**
   * Whether nothing sets this device's current: built-in control is not in
   * effect (not selected, or selected while the installed app offers no way to
   * set the current) and no Flow is known to set it either. Its level changes
   * then reach no one until the owner finishes Charging current setup. A shared
   * installation is left to its coordinating Flow.
   */
  lacksCurrentRoute(deviceId: string): boolean {
    const device = this.findDevice(deviceId);
    const adapter = device && resolveChargingCurrentAdapter(device);
    if (!device || !adapter || this.automaticWattsOwnRoute(device)) return false;
    if (this.isInstallationSecondary(deviceId)) return false;
    if (hasSharedChargingInstallation(adapter, this.knownDevices()) && !this.isInstallationMain(deviceId)) {
      return false;
    }
    return !this.routesBuiltIn(deviceId) && currentSettingFlows(adapter, this.flowWrites).size === 0;
  }

  /**
   * Why PELS does not set the device's level itself although it could, for its
   * card. A Flow that holds built-in control back (`flowConflict`, also set for
   * the built-in control of devices without a charging-current binding) is
   * named first, then a selected built-in control the app can no longer carry
   * out, then an unfinished setup.
   */
  unusedBuiltInControl(
    deviceId: string,
    snapshot: Pick<TransportDeviceSnapshot, 'flowConflict'> | undefined,
  ): UnusedBuiltInControl {
    if (snapshot?.flowConflict !== undefined) return 'held_by_flow';
    if (this.isInstallationSecondary(deviceId)) return 'none';
    const device = this.findDevice(deviceId);
    if (device && this.withholdsInstallationSteps(device)) return 'none';
    if (device && this.withdrawsCurrentLadder(device)) return 'needs_app_update';
    return this.lacksCurrentRoute(deviceId) ? 'not_set_up' : 'none';
  }

  // Automatic watts own the route; an existing manual current choice stays in force.
  private automaticWattsOwnRoute(device: HomeyDeviceLike): boolean {
    return hasNativeTargetPowerLadder(device.capabilities, device.capabilitiesObj)
      && this.deviceSettings.resolveDevicePowerControlMode(
        device.id, this.requiresManualControl(device.id),
      ) === 'automatic';
  }

  private routesBuiltInFor(deviceId: string, setup: ChargingCurrentSetup): boolean {
    const device = this.findDevice(deviceId);
    if (device && this.automaticWattsOwnRoute(device)) return false;
    if (this.isInstallationSecondary(deviceId)) return false;
    const adapter = device && resolveChargingCurrentAdapter(device);
    // A saved choice whose app now offers no current write (a read-only
    // capability without an app action) routes nothing: the device leaves
    // current stepping until the app is updated or a Flow is chosen.
    if (adapter && (!canSetChargingCurrent(adapter) || !this.permitsInstallationCurrent(adapter, setup))) return false;
    return isBuiltInControlInEffect(
      setup.method === 'built_in',
      adapter !== undefined && currentSettingFlows(adapter, this.flowWrites).size > 0,
    );
  }

  // The devices PELS sets the current of itself, as one comparable key.
  private builtInRouteKey(): string {
    return this.knownDevices().filter((device) => this.routesBuiltIn(device.id)).map((device) => device.id)
      .sort().join('|');
  }

  /**
   * What the device's app answered a write PELS sent: `failure` is null when it
   * accepted it. Only an HTTP error status is a refusal; a write with no answer
   * (a timeout) may still land and says nothing about the device. Returns whether
   * a session now reads the device differently, so the transport projects it again.
   */
  observeWriteOutcome(deviceId: string, write: CapabilityWrite, failure: { error: unknown } | null): boolean {
    if (failure === null) return this.sessions.observeAcceptedWrite(deviceId, write);
    if (resolveHomeyHttpStatusCode(failure.error) === undefined) return false;
    return this.sessions.observeRefusedWrite(deviceId, write, normalizeError(failure.error).message, Date.now());
  }

  projectControl(source: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const setup = this.setup(source.id);
    return this.withChargingInstallation(this.sessions.project(this.withCurrentRoute(source, setup), setup));
  }

  chargingInstallation(deviceId: string): ChargingInstallation | undefined {
    const device = this.findDevice(deviceId);
    return device && this.installations.installationOf(device);
  }

  private hasInstallationRoute(main: HomeyDeviceLike): boolean {
    if (this.automaticWattsOwnRoute(main)) {
      return this.sessions.targetPowerClaims.resolve(main, Date.now()) !== 'refused';
    }
    const adapter = resolveChargingCurrentAdapter(main);
    return this.setup(main.id).method === 'built_in' && this.hasManualInstallationLadder(main)
      && adapter !== undefined && currentSettingFlows(adapter, this.flowWrites).size === 0;
  }

  private hasManualInstallationLadder(main: HomeyDeviceLike): boolean {
    const adapter = resolveChargingCurrentAdapter(main);
    const saved = this.deviceSettings.getDeviceTargetPowerConfig(main.id)
      ?? resolveDeviceCompatibilityTargetPowerConfig(main);
    return adapter !== undefined && canSetChargingCurrent(adapter) && saved !== undefined
      && resolveTargetPowerSteppedControl(getDeviceAdapter(main).configureTargetPower(main, saved)) !== undefined;
  }

  private assertInstallationWrite(deviceId: string, capabilityId: string): void {
    const device = this.findDevice(deviceId);
    if (!device) return;
    const adapter = resolveChargingCurrentAdapter(device);
    const currentCapability = adapter?.current.kind === 'capability' ? adapter.current.capabilityId : undefined;
    if (capabilityId === currentCapability || WATT_CONTROL_CAPABILITIES.includes(capabilityId)) {
      this.assertInstallationStepAllowed(deviceId);
    }
  }

  /** Recheck the current authority even when the requested step predates a home or mode change. */
  assertInstallationStepAllowed(deviceId: string): void {
    const device = this.findDevice(deviceId);
    const access = device && this.installations.accessOf(device);
    if (access === 'secondary') throw new Error(SECONDARY_CURRENT_ERROR);
    if (access === 'blocked') throw new Error(SHARED_CURRENT_UNAVAILABLE);
  }

  /**
   * The installation's level, in watts on the main's own ladder, read from the
   * main as its integration reads it (`DeviceAdapter.installationLevelW`).
   * `undefined` for a device that is not a charging installation's main.
   */
  installationLevelW(deviceId: string): number | undefined {
    const device = this.findDevice(deviceId);
    if (!device || this.chargingInstallation(deviceId)?.role !== 'main') return undefined;
    const adapter = getDeviceAdapter(device);
    return this.routesBuiltIn(deviceId) ? this.builtInInstallationLevelW(device) : adapter.installationLevelW(device);
  }

  installationWattsPerAmp(deviceId: string): number | undefined {
    const device = this.findDevice(deviceId);
    if (!device) return undefined;
    const integration = getDeviceAdapter(device);
    if (!this.routesBuiltIn(deviceId)) return integration.installationWattsPerAmp(device);
    const config = this.deviceSettings.getDeviceTargetPowerConfig(deviceId)
      ?? resolveDeviceCompatibilityTargetPowerConfig(device);
    return config && installationPresetWattsPerAmp(integration.configureTargetPower(device, config));
  }

  private builtInInstallationLevelW(device: HomeyDeviceLike): number | undefined {
    const binding = resolveChargingCurrentAdapter(device);
    if (binding?.current.kind !== 'capability') return undefined;
    const current = device.capabilitiesObj[binding.current.capabilityId];
    const savedConfig = this.deviceSettings.getDeviceTargetPowerConfig(device.id)
      ?? resolveDeviceCompatibilityTargetPowerConfig(device);
    if (!current || !savedConfig) return undefined;
    const config = getDeviceAdapter(device).configureTargetPower(device, savedConfig);
    const level = resolveInstallationCurrentTargetPowerObservation(config, current);
    if (!level) return undefined;
    return typeof current.value === 'number' && current.value < MIN_CURRENT_A ? 0 : level.value;
  }

  isInstallationMain(deviceId: string): boolean {
    return this.chargingInstallation(deviceId)?.role === 'main';
  }

  /** A member whose switch is independent and whose current comes from the installation. */
  private isInstallationSecondary(deviceId: string): boolean {
    return this.chargingInstallation(deviceId)?.role === 'secondary';
  }

  /** Ownership and claim changes require reparsing the current route, not just updating the published role. */
  needsInstallationRefresh(snapshot: TransportDeviceSnapshot): boolean {
    const device = this.findDevice(snapshot.id);
    const access = device && this.installations.accessOf(device);
    if (access === 'blocked') {
      return snapshot.controlAdapter?.chargingInstallation !== undefined || snapshot.steppedLoadProfile !== undefined;
    }
    return access !== snapshot.controlAdapter?.chargingInstallation?.role;
  }

  private withChargingInstallation(source: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const chargingInstallation = this.chargingInstallation(source.id);
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
  private withCurrentRoute(source: TransportDeviceSnapshot, setup: ChargingCurrentSetup): TransportDeviceSnapshot {
    if (this.routesBuiltInFor(source.id, setup)) {
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

  setup(deviceId: string): ChargingCurrentSetup {
    this.sync();
    return this.setups.get(deviceId) ?? DEFAULT_SETUP;
  }

  /** An unread legacy route cannot authorize a new automatic takeover. */
  requiresManualControl(deviceId: string): boolean {
    this.sync();
    return this.setupsReadState === 'unavailable' || this.setups.has(deviceId);
  }

  withholdsInstallationSteps(device: HomeyDeviceLike): boolean {
    const access = this.installations.accessOf(device);
    return access === 'secondary' || access === 'blocked';
  }

  /**
   * Whether the device's saved built-in current choice has no current write left:
   * the installed app reports current read-only, offers no app action PELS
   * runs, and no Flow is known to set the current instead. Such a charger gets
   * no current ladder, so PELS limits it on its switch until the owner updates
   * the app or chooses a Flow.
   */
  withdrawsCurrentLadder(device: HomeyDeviceLike): boolean {
    const adapter = resolveChargingCurrentAdapter(device);
    if (this.withholdsInstallationSteps(device)) return true;
    return adapter !== undefined && !canSetChargingCurrent(adapter)
      && this.setup(device.id).method === 'built_in'
      && currentSettingFlows(adapter, this.flowWrites).size === 0;
  }

  /** The Flows that set a current now, read fresh; nothing is accepted here. */
  readFlows(): Promise<FlowReadResult> {
    return readFlowCapabilityWrites({ get: getRawFromHomeyApi });
  }

  async list(): Promise<ChargingCurrentRead[]> {
    return this.describe(await this.readFlows());
  }

  private describeCurrentBinding(adapter: ChargingCurrentBinding | undefined): Pick<
    ChargingCurrentRead, 'scope' | 'capabilityWritable' | 'supportsAppAction'
  > {
    return {
      scope: adapter?.scope.kind ?? 'installation',
      capabilityWritable: adapter?.current.kind === 'capability' && adapter.current.writable,
      supportsAppAction: adapter?.supportsAppAction === true,
    };
  }

  /**
   * The setup read for a Flow read. `currentRoute` is the route in effect,
   * from the Flow list last accepted (`BuiltInControlFlowConflicts`
   * applies a readable one before the settings page reads this).
   */
  describe(flows: FlowReadResult): ChargingCurrentRead[] {
    const devices = this.getDevices();
    return devices.flatMap((device) => {
      const adapter = resolveChargingCurrentAdapter(device);
      const chargingInstallation = this.describeInstallation(device);
      if (!adapter && !chargingInstallation) return [];
      const names = flows.status === 'ok' && adapter
        ? currentSettingFlows(adapter, flows.facts.writes) : new Map<string, string>();
      let flowCheck: ChargingCurrentRead['flowCheck'] = 'unavailable';
      if (flows.status === 'ok') flowCheck = names.size ? 'conflict' : 'clear';
      return [{
        deviceId: device.id, name: device.name, setup: this.setup(device.id),
        ...this.describeCurrentBinding(adapter),
        sharedInstallation: chargingInstallation?.role === 'secondary'
          || (!chargingInstallation && adapter !== undefined && hasSharedChargingInstallation(adapter, devices)),
        chargingInstallation,
        flowCheck,
        flowNames: [...names.values()],
        currentRoute: this.routesBuiltIn(device.id) ? 'built_in' : 'flow',
        missingCompanion: this.sessions.missingCompanion(device.id),
      }];
    });
  }

  private describeInstallation(device: HomeyDeviceLike): ChargingCurrentRead['chargingInstallation'] {
    const main = this.installations.eligibleMainOf(device);
    if (!main) return undefined;
    const automatic = this.automaticWattsOwnRoute(main);
    if (!automatic && !this.hasManualInstallationLadder(main)) return undefined;
    const role = device.id === main.id ? 'main' : 'secondary';
    return {
      role, mainName: main.name,
      automaticWatts: role === 'main' && automatic
        && this.sessions.targetPowerClaims.resolve(main, Date.now()) !== 'refused',
    };
  }

  async save(deviceId: string, body: unknown): Promise<void> {
    const setup = readSetup(body);
    if (!setup) throw new Error('Choose a charging-current control method.');
    const device = (await this.list()).find((entry) => entry.deviceId === deviceId);
    if (!device) throw new Error('This device has no supported charging-current control.');
    if ((device.scope === 'vehicle' && setup.confirmation === 'single_charger')
      || (device.scope === 'installation' && setup.confirmation === 'vehicle')
      || (device.scope === 'charger' && setup.confirmation !== 'none')) {
      throw new Error('Confirm the control scope shown for this device.');
    }
    const revokingVehicleControl = device.scope === 'vehicle' && setup.confirmation === 'none';
    if (setup.method === 'built_in' && !revokingVehicleControl) {
      this.assertBuiltInActivationAllowed(device, setup);
    }
    const next = new Map(this.setups);
    next.set(deviceId, setup);
    const saved = Object.fromEntries(next);
    this.settings.set(SETTINGS_KEY, saved);
    this.setups.set(deviceId, setup);
  }

  private assertBuiltInActivationAllowed(device: ChargingCurrentRead, setup: ChargingCurrentSetup): void {
    if (device.flowCheck !== 'clear') {
      throw new Error('Remove the current-setting Flow action and check again before enabling built-in control.');
    }
    if (device.chargingInstallation?.role === 'secondary') {
      throw new Error(SECONDARY_CURRENT_ERROR);
    }
    if (device.scope === 'installation' && device.chargingInstallation?.role !== 'main'
      && (setup.confirmation !== 'single_charger' || device.sharedInstallation)) {
      throw new Error('Built-in current control requires a single-charger installation.');
    }
    if (!device.capabilityWritable && !device.supportsAppAction) {
      throw new Error('Update the charger app or use a Flow to set charging current.');
    }
    if (!device.capabilityWritable && this.access.status().state !== 'ready') {
      throw new Error('Check the Homey API key before enabling built-in control.');
    }
  }

  /** No fallback: an unavailable selected route must not run an owner's Flow. */
  async writeCurrent(
    device: HomeyDeviceLike,
    currentA: number,
    setCapability: (capabilityId: string, value: number) => Promise<unknown>,
  ): Promise<'native_capability' | 'homey_action'> {
    this.assertControlAllowed(device);
    const adapter = resolveChargingCurrentAdapter(device);
    if (adapter && this.setup(device.id).method === 'built_in') this.assertInstallation(adapter);
    if (!adapter || !this.routesBuiltIn(device.id)) {
      throw new Error('Built-in current control is not enabled.');
    }
    if (!Number.isInteger(currentA) || currentA < MIN_CURRENT_A || currentA > 32) {
      throw new Error('Charging current must be 6–32 A.');
    }
    if (adapter.current.kind === 'capability' && adapter.current.writable) {
      await setCapability(adapter.current.capabilityId, currentA);
      return 'native_capability';
    }
    if (!adapter.supportsAppAction) {
      throw new Error('Update the charger app or use a Flow to set charging current.');
    }
    // Refuse a busy device before reading the action metadata: the next plan
    // rebuild asks again, and each ask must stay local until the earlier action answers.
    if (this.access.isActionInFlight(device.id)) {
      throw new SteppedLoadTransportError('homey_action', new HomeyRequestInFlightError());
    }
    const action = await this.cardInventory.resolve((cards) => resolveChargingCurrentAction(adapter, cards, currentA))
      .catch((cause: unknown) => {
        throw new Error('Unable to read charging-current action metadata', { cause });
      });
    // Selection can change while Homey is answering the metadata read.
    if (!this.routesBuiltIn(device.id)) throw new Error('Charging-current control changed.');
    this.assertInstallation(adapter);
    this.assertControlAllowed(device);
    if (action === undefined) throw new Error('The charging-current action is unavailable in Homey.');
    await this.access.runAction(device.id, action, 'charging_current', () => {
      if (!this.routesBuiltIn(device.id)) throw new Error('Charging-current control changed.');
      this.assertControlAllowed(device);
      this.assertInstallation(adapter);
    }).catch((error: unknown) => {
      this.cardInventory.retrySoon();
      throw new SteppedLoadTransportError('homey_action', error);
    });
    return 'homey_action';
  }

  private permitsInstallationCurrent(adapter: ChargingCurrentBinding, setup: ChargingCurrentSetup): boolean {
    if (adapter.scope.kind !== 'installation' || this.isInstallationMain(adapter.deviceId)) return true;
    return setup.confirmation === 'single_charger' && !hasSharedChargingInstallation(adapter, this.knownDevices());
  }

  private assertInstallation(adapter: ChargingCurrentBinding): void {
    if (!this.permitsInstallationCurrent(adapter, this.setup(adapter.deviceId))) {
      throw new Error('Built-in current control requires a single-charger installation.');
    }
  }

  private sync(): void {
    try {
      const raw = this.settings.get(SETTINGS_KEY);
      if (raw === null || raw === undefined) {
        const keys = readSettingsKeyList(this.settings);
        if (keys.status === 'resolved' && !keys.keys.includes(SETTINGS_KEY)) {
          this.setups.clear();
          this.setupsReadState = 'resolved';
          return;
        }
      }
      if (!isUnknownRecord(raw)) return;
      const entries = Object.entries(raw).map(([id, value]) => [id, readSetup(value)] as const);
      if (entries.some(([, value]) => !value)) return;
      this.setups.clear();
      for (const [id, value] of entries) if (value) this.setups.set(id, value);
      this.setupsReadState = 'resolved';
    } catch { /* A transient read preserves accepted configuration. */ }
  }
}

function trustEpochOf(trust: { connected: boolean; revision: number }): string {
  return `${trust.connected}:${trust.revision}`;
}
