import { TeslaChargingSession, type HomeLocation } from './teslaChargingSession';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { isTeslaChargingDevice } from './chargingCurrentAdapter';
import type { ChargingCurrentRead, ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { HomeyDeviceLike } from '../utils/types';
import { readFlowCapabilityWrites } from '../flowApi/readUserFlows';
import {
  hasSharedChargingInstallation, resolveChargingCurrentAdapter, resolveChargingCurrentAction,
} from './chargingCurrentAdapter';
import type { ChargingCurrentAdapter } from './chargingCurrentAdapter';
import { ChargingAccess, type ChargingAccessHomey } from './transport/chargingAccess';
import type { Logger } from '../utils/types';
import { getRawFromHomeyApi } from './transport/managerHomeyApi';

const SETTINGS_KEY = 'charging_current_control';
const DEFAULT_SETUP: ChargingCurrentSetup = { method: 'flow', confirmation: 'none' };

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
  private revision = 0;
  private savedRepresentation = '';
  readonly access: ChargingAccess;
  private readonly settings: SettingsPort;
  readonly homeSession: TeslaChargingSession;
  private readonly setups = new Map<string, ChargingCurrentSetup>();

  constructor(
    homey: ChargingAccessHomey & { geolocation: HomeLocation },
    logger: Pick<Logger, 'structuredLog'>,
    private readonly getDevices: () => readonly HomeyDeviceLike[],
    private readonly readTrust: () => { connected: boolean; revision: number },
  ) {
    this.settings = homey.settings;
    this.access = new ChargingAccess(homey, logger);
    this.homeSession = new TeslaChargingSession(homey.geolocation);
  }

  synchronizeTrust(): boolean {
    const trust = this.readTrust();
    this.homeSession.setTrustEpoch(`${trust.connected}:${trust.revision}`);
    return trust.connected;
  }

  observeDevices(devices: readonly HomeyDeviceLike[]): void {
    if (this.synchronizeTrust()) this.homeSession.observeDevices(devices);
  }

  assertControlAllowed(device: HomeyDeviceLike): void {
    if (isTeslaChargingDevice(device) && !this.synchronizeTrust()) {
      throw new Error('Tesla charging requires a connected Homey device feed.');
    }
    if (isTeslaChargingDevice(device)
      && (this.setup(device.id).confirmation !== 'vehicle' || !this.homeSession.isAllowed(device.id))) {
      throw new Error('Tesla charging requires a confirmed stationary AC charging session at home.');
    }
  }

  projectHomeControl(source: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const setup = this.setup(source.id);
    const snapshot = setup.method === 'built_in' && source.controlAdapter
      ? { ...source, controlAdapter: { ...source.controlAdapter, currentControl: 'built_in' as const } }
      : source;
    if (snapshot.binaryWriteCapabilityId !== 'charging_on'
      || (this.setup(snapshot.id).confirmation === 'vehicle' && this.homeSession.isAllowed(snapshot.id))) {
      return snapshot;
    }
    // This is power attributable to this home, not power at a remote charge point.
    return { ...snapshot, available: false, measuredPowerKw: 0 };
  }

  get generation(): number { this.sync(); return this.revision; }

  setup(deviceId: string): ChargingCurrentSetup {
    this.sync();
    return this.setups.get(deviceId) ?? DEFAULT_SETUP;
  }

  async list(): Promise<ChargingCurrentRead[]> {
    const devices = this.getDevices();
    const flows = await readFlowCapabilityWrites({ get: getRawFromHomeyApi });
    return devices.flatMap((device) => {
      const adapter = resolveChargingCurrentAdapter(device);
      if (!adapter) return [];
      const names = new Map<string, string>();
      if (flows.status === 'ok') {
        for (const capability of [adapter.currentCapabilityId, adapter.actionId]) {
          for (const [id, name] of flows.facts.writes.get(device.id)?.get(capability) ?? []) names.set(id, name);
        }
      }
      let flowCheck: ChargingCurrentRead['flowCheck'] = 'unavailable';
      if (flows.status === 'ok') flowCheck = names.size ? 'conflict' : 'clear';
      return [{
        deviceId: device.id, name: device.name, setup: this.setup(device.id),
        scope: adapter.scope.kind, capabilityWritable: adapter.currentWritable,
        sharedInstallation: hasSharedChargingInstallation(adapter, devices),
        flowCheck,
        flowNames: [...names.values()],
      }];
    });
  }

  async save(deviceId: string, body: unknown): Promise<void> {
    const setup = readSetup(body);
    if (!setup) throw new Error('Choose a charging-current control method.');
    const device = (await this.list()).find((entry) => entry.deviceId === deviceId);
    if (!device) throw new Error('This device has no supported charging-current control.');
    if ((device.scope === 'vehicle' && setup.confirmation === 'single_charger')
      || (device.scope === 'installation' && setup.confirmation === 'vehicle')) {
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
    this.revision++;
    this.setups.set(deviceId, setup);
    this.savedRepresentation = JSON.stringify(saved);
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
    if (!adapter || this.setup(device.id).method !== 'built_in') {
      throw new Error('Built-in current control is not enabled.');
    }
    this.assertInstallation(adapter);
    if (!Number.isInteger(currentA) || currentA < 6 || currentA > 32) {
      throw new Error('Charging current must be 6–32 A.');
    }
    if (adapter.currentWritable) {
      await setCapability(adapter.currentCapabilityId, currentA);
      return 'native_capability';
    }
    const inventory = await getRawFromHomeyApi('manager/flow/flowcardaction');
    // Selection can change while Homey is answering the metadata read.
    if (this.setup(device.id).method !== 'built_in') throw new Error('Charging-current control changed.');
    this.assertInstallation(adapter);
    this.assertControlAllowed(device);
    await this.access.runCurrentAction(device.id, resolveChargingCurrentAction(adapter, inventory, currentA), () => {
      if (this.setup(device.id).method !== 'built_in') throw new Error('Charging-current control changed.');
      this.assertControlAllowed(device);
      this.assertInstallation(adapter);
    });
    return 'homey_action';
  }

  private assertInstallation(adapter: ChargingCurrentAdapter): void {
    if (adapter.scope.kind === 'installation' && (this.setup(adapter.deviceId).confirmation !== 'single_charger'
      || hasSharedChargingInstallation(adapter, this.getDevices()))) {
      throw new Error('Built-in current control requires a single-charger installation.');
    }
  }

  private sync(): void {
    try {
      const raw = this.settings.get(SETTINGS_KEY);
      if (raw == null && !this.settings.getKeys().includes(SETTINGS_KEY)) {
        if (this.setups.size > 0) this.revision++;
        this.savedRepresentation = '';
        this.setups.clear();
        return;
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
      const entries = Object.entries(raw).map(([id, value]) => [id, readSetup(value)] as const);
      if (entries.some(([, value]) => !value)) return;
      const representation = JSON.stringify(raw);
      if (representation !== this.savedRepresentation) this.revision++;
      this.savedRepresentation = representation;
      this.setups.clear();
      for (const [id, value] of entries) if (value) this.setups.set(id, value);
    } catch { /* A transient read preserves accepted configuration. */ }
  }
}
