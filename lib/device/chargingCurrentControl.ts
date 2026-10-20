import { SteppedLoadRequestTimeoutError } from '../ports/steppedLoadWrite';
import { isHomeyRequestTimeout } from '../utils/errorUtils';
import { DeviceAdapterSessions } from './deviceAdapterRegistry';
import { HubHomeLocation } from './hubHomeLocation';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ChargingCurrentRead, ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { HomeyDeviceLike } from '../utils/types';
import { readFlowCapabilityWrites } from '../flowApi/readUserFlows';
import type { FlowCapabilityWrites, UserFlowFacts } from '../flowApi/userFlows';
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

/** The Flows that write this binding's current, by Flow id. */
function currentSettingFlows(adapter: ChargingCurrentBinding, writes: FlowCapabilityWrites): Map<string, string> {
  const capabilities = adapter.current.kind === 'capability'
    ? [adapter.current.capabilityId, adapter.actionId] : [adapter.actionId];
  const names = new Map<string, string>();
  for (const capability of capabilities) {
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
  // The last Flow list PELS accepted. Empty until the first one: with nothing
  // known, nothing is held back, the same as a Flow list with no writes.
  private flowWrites: FlowCapabilityWrites = new Map();
  private previousFlowWrites: FlowCapabilityWrites = new Map();

  constructor(
    homey: ChargingAccessHomey,
    logger: Pick<Logger, 'structuredLog'>,
    private readonly getDevices: () => readonly HomeyDeviceLike[],
    private readonly readTrust: () => { connected: boolean; revision: number },
  ) {
    this.settings = homey.settings;
    this.access = new ChargingAccess(homey, logger);
    this.sessions = new DeviceAdapterSessions(this.homeLocation);
  }

  /** Read before the first snapshot, so a home session can start on the first observation. */
  refreshHomeLocation(): Promise<void> { return this.homeLocation.refreshIfDue(); }

  synchronizeTrust(): boolean {
    const trust = this.readTrust();
    this.sessions.setTrustEpoch(`${trust.connected}:${trust.revision}`);
    return trust.connected;
  }

  observeDevices(devices: readonly HomeyDeviceLike[], readAtMs: number): void {
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
    this.previousFlowWrites = this.flowWrites;
    this.flowWrites = facts.writes;
    return this.builtInRouteKey() !== before;
  }

  /** Restores the Flow list accepted before the last one, when re-projecting for it failed. */
  revertFlowFacts(): void {
    this.flowWrites = this.previousFlowWrites;
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

  // The device is looked up in the last committed device list, so one that
  // first appears in a refresh is projected without its Flow check for that
  // refresh: a device newly added to Homey with a conflicting Flow reads as
  // built-in for one cycle.
  private routesBuiltInFor(deviceId: string, setup: ChargingCurrentSetup): boolean {
    const device = this.getDevices().find((entry) => entry.id === deviceId);
    const adapter = device && resolveChargingCurrentAdapter(device);
    return isBuiltInControlInEffect(
      setup.method === 'built_in',
      adapter !== undefined && currentSettingFlows(adapter, this.flowWrites).size > 0,
    );
  }

  /** The devices PELS sets the current of itself, as one comparable key. */
  builtInRouteKey(): string {
    return this.getDevices().filter((device) => this.routesBuiltIn(device.id)).map((device) => device.id)
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

  async list(): Promise<ChargingCurrentRead[]> {
    const devices = this.getDevices();
    const flows = await readFlowCapabilityWrites({ get: getRawFromHomeyApi });
    // A readable list is the freshest PELS has: the runtime adopts it, so the
    // route this read reports is the one in effect. The caller re-projects when
    // `builtInRouteKey` moved.
    if (flows.status === 'ok') this.acceptFlowFacts(flows.facts);
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
