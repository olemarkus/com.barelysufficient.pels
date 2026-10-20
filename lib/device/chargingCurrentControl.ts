import { SteppedLoadRequestTimeoutError } from '../ports/steppedLoadWrite';
import { isHomeyRequestTimeout } from '../utils/errorUtils';
import { DeviceAdapterSessions } from './deviceAdapterRegistry';
import { HubHomeLocation } from './hubHomeLocation';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ChargingCurrentRead, ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { HomeyDeviceLike } from '../utils/types';
import { readFlowCapabilityWrites, type FlowReadResult } from '../flowApi/readUserFlows';
import type { FlowCapabilityWrites, UserFlowFacts } from '../flowApi/userFlows';
import type { AcceptedFlowConflictSlice } from '../flowApi/acceptedFlowConflictStore';
import { normalizeError } from '../utils/errorUtils';
import { isBuiltInControlInEffect } from './builtInControlFlowGate';
import {
  hasSharedChargingInstallation, resolveChargingCurrentAdapter, resolveChargingCurrentAction,
} from './chargingCurrentAdapter';
import type { ChargingCurrentBinding } from './deviceAdapter';
import { ChargingAccess, type ChargingAccessHomey } from './transport/chargingAccess';
import type { Logger } from '../utils/types';
import { getRawFromHomeyApi } from './transport/managerHomeyApi';

const SETTINGS_KEY = 'charging_current_control';
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

/** Owns current-route selection. Binary control remains independent of this choice. */
export class ChargingCurrentControl {
  readonly access: ChargingAccess;
  private readonly settings: SettingsPort;
  readonly sessions: DeviceAdapterSessions;
  private readonly homeLocation = new HubHomeLocation();
  private readonly setups = new Map<string, ChargingCurrentSetup>();
  // The last Flow list PELS accepted, seeded from the one saved before the
  // restart. Empty with nothing saved: nothing is held back, the same as a Flow
  // list with no writes.
  private flowWrites: FlowCapabilityWrites = new Map();
  // The charging devices the reads carried, for a device the committed list
  // does not hold yet: that list is adopted only after projection, so it is
  // empty for the first refresh after a boot and lacks a device new in this read.
  private readonly observedDevices = new Map<string, HomeyDeviceLike>();

  constructor(
    homey: ChargingAccessHomey,
    private readonly logger: Pick<Logger, 'structuredLog'>,
    private readonly getDevices: () => readonly HomeyDeviceLike[],
    private readonly readTrust: () => { connected: boolean; revision: number },
    private readonly flowWritesStore: AcceptedFlowConflictSlice<FlowCapabilityWrites>,
  ) {
    this.settings = homey.settings;
    this.access = new ChargingAccess(homey, logger);
    this.sessions = new DeviceAdapterSessions(this.homeLocation);
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
    this.sessions.setTrustEpoch(`${trust.connected}:${trust.revision}`);
    return trust.connected;
  }

  observeDevices(devices: readonly HomeyDeviceLike[], readAtMs: number): void {
    for (const device of devices) {
      if (resolveChargingCurrentAdapter(device)) this.observedDevices.set(device.id, device);
    }
    void this.homeLocation.refreshIfDue();
    if (this.synchronizeTrust()) this.sessions.observeDevices(devices, readAtMs);
  }

  assertControlAllowed(device: HomeyDeviceLike): void {
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
   * control and no Flow is known to set the same current
   * (`isBuiltInControlInEffect`). Otherwise the current goes through the
   * owner's Flow, as with Flow control selected.
   */
  routesBuiltIn(deviceId: string): boolean {
    return this.routesBuiltInFor(deviceId, this.setup(deviceId));
  }

  /** A full inventory: sessions keep only its devices, and so does the read-side lookup. */
  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    this.sessions.retainDevices(devices);
    const present = new Set(devices.map((device) => device.id));
    for (const id of this.observedDevices.keys()) if (!present.has(id)) this.observedDevices.delete(id);
  }

  // The committed record when there is one (realtime updates keep it current),
  // else the one the read being projected carried.
  private findDevice(deviceId: string): HomeyDeviceLike | undefined {
    return this.getDevices().find((entry) => entry.id === deviceId) ?? this.observedDevices.get(deviceId);
  }

  private routesBuiltInFor(deviceId: string, setup: ChargingCurrentSetup): boolean {
    const device = this.findDevice(deviceId);
    const adapter = device && resolveChargingCurrentAdapter(device);
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

  projectControl(source: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const setup = this.setup(source.id);
    return this.sessions.project(this.withCurrentRoute(source, setup), setup);
  }

  // A retained snapshot (one whose refresh read was rejected) is projected again
  // as it is, so a route that is now held back must lose the flag it carried.
  private withCurrentRoute(source: TransportDeviceSnapshot, setup: ChargingCurrentSetup): TransportDeviceSnapshot {
    if (!source.controlAdapter) return source;
    if (this.routesBuiltInFor(source.id, setup)) {
      return { ...source, controlAdapter: { ...source.controlAdapter, currentControl: 'built_in' } };
    }
    if (source.controlAdapter.currentControl === undefined) return source;
    const { currentControl: _heldBack, ...controlAdapter } = source.controlAdapter;
    return { ...source, controlAdapter };
  }

  setup(deviceId: string): ChargingCurrentSetup {
    this.sync();
    return this.setups.get(deviceId) ?? DEFAULT_SETUP;
  }

  /** The Flows that set a current now, read fresh; nothing is accepted here. */
  readFlows(): Promise<FlowReadResult> {
    return readFlowCapabilityWrites({ get: getRawFromHomeyApi });
  }

  async list(): Promise<ChargingCurrentRead[]> {
    return this.describe(await this.readFlows());
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
      if (!adapter) return [];
      const names = flows.status === 'ok'
        ? currentSettingFlows(adapter, flows.facts.writes) : new Map<string, string>();
      let flowCheck: ChargingCurrentRead['flowCheck'] = 'unavailable';
      if (flows.status === 'ok') flowCheck = names.size ? 'conflict' : 'clear';
      return [{
        deviceId: device.id, name: device.name, setup: this.setup(device.id),
        scope: adapter.scope.kind,
        capabilityWritable: adapter.current.kind === 'capability' && adapter.current.writable,
        sharedInstallation: hasSharedChargingInstallation(adapter, devices),
        flowCheck,
        flowNames: [...names.values()],
        currentRoute: this.routesBuiltIn(device.id) ? 'built_in' : 'flow',
      }];
    });
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
    if (device.scope === 'installation' && (setup.confirmation !== 'single_charger' || device.sharedInstallation)) {
      throw new Error('Built-in current control requires a single-charger installation.');
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
    if (!adapter || !this.routesBuiltIn(device.id)) {
      throw new Error('Built-in current control is not enabled.');
    }
    this.assertInstallation(adapter);
    if (!Number.isInteger(currentA) || currentA < 6 || currentA > 32) {
      throw new Error('Charging current must be 6–32 A.');
    }
    if (adapter.current.kind === 'capability' && adapter.current.writable) {
      await setCapability(adapter.current.capabilityId, currentA);
      return 'native_capability';
    }
    const inventory = await getRawFromHomeyApi('manager/flow/flowcardaction');
    // Selection can change while Homey is answering the metadata read.
    if (!this.routesBuiltIn(device.id)) throw new Error('Charging-current control changed.');
    this.assertInstallation(adapter);
    this.assertControlAllowed(device);
    await this.access.runCurrentAction(device.id, resolveChargingCurrentAction(adapter, inventory, currentA), () => {
      if (!this.routesBuiltIn(device.id)) throw new Error('Charging-current control changed.');
      this.assertControlAllowed(device);
      this.assertInstallation(adapter);
    }).catch((error: unknown) => {
      if (error instanceof Error && isHomeyRequestTimeout(error)) {
        throw new SteppedLoadRequestTimeoutError('homey_action', error);
      }
      throw error;
    });
    return 'homey_action';
  }

  private assertInstallation(adapter: ChargingCurrentBinding): void {
    if (adapter.scope.kind === 'installation' && (this.setup(adapter.deviceId).confirmation !== 'single_charger'
      || hasSharedChargingInstallation(adapter, this.getDevices()))) {
      throw new Error('Built-in current control requires a single-charger installation.');
    }
  }

  private sync(): void {
    try {
      const raw = this.settings.get(SETTINGS_KEY);
      if (raw == null && !this.settings.getKeys().includes(SETTINGS_KEY)) {
        this.setups.clear();
        return;
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
      const entries = Object.entries(raw).map(([id, value]) => [id, readSetup(value)] as const);
      if (entries.some(([, value]) => !value)) return;
      this.setups.clear();
      for (const [id, value] of entries) if (value) this.setups.set(id, value);
    } catch { /* A transient read preserves accepted configuration. */ }
  }
}
