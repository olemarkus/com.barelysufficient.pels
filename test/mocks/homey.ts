import { createMockImagesManager } from './homeyImages';
import { EventEmitter } from 'events';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';

type MockCapabilityMutationBehavior = {
  updateActual?: boolean;
  updateApi?: boolean;
  emitCapabilityEvent?: boolean;
  emitDeviceUpdate?: boolean;
};

type MockApiWriteBehavior = MockCapabilityMutationBehavior & {
  accept?: boolean;
};

type MockCapabilityBehaviorConfig = {
  onApiWrite?: MockApiWriteBehavior;
  onExternalChange?: MockCapabilityMutationBehavior;
};

type MockCapabilityMetadata = {
  units?: string;
  min?: number;
  max?: number;
  step?: number;
  setable?: boolean;
};

const DEFAULT_API_WRITE_BEHAVIOR: Required<MockApiWriteBehavior> = {
  accept: true,
  updateActual: true,
  updateApi: true,
  emitCapabilityEvent: false,
  emitDeviceUpdate: false,
};

const DEFAULT_EXTERNAL_CHANGE_BEHAVIOR: Required<MockCapabilityMutationBehavior> = {
  updateActual: true,
  updateApi: true,
  emitCapabilityEvent: true,
  emitDeviceUpdate: true,
};

export class MockSettings extends EventEmitter {
  private store = new Map<string, unknown>();

  // Mirror the real SDK's `ManagerSettings.get()`: an unset key (never written,
  // or `unset`) answers `null`, NOT `undefined`. A bare `Map.get` here disagrees
  // with the device at exactly the branch boundary readers classify absence on,
  // which is how a reader gated only on `=== undefined` shipped green (the
  // v2.20.0 temperature-control policy regression). Do not "simplify" this back.
  get(key: string) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  set(key: string, value: unknown) {
    this.store.set(key, value);
    this.emit('set', key);
  }

  unset(key: string) {
    this.store.delete(key);
    this.emit('unset', key);
  }

  // Mirror the real SDK's `ManagerSettings.getKeys()`. The live key list is
  // derived from the backing store, so `set`/`unset` keep it consistent.
  getKeys(): string[] {
    return Array.from(this.store.keys());
  }

  clear() {
    this.store.clear();
  }
}

export class MockDevice {
  private capabilityValues = new Map<string, unknown>();
  private actualCapabilityValues = new Map<string, unknown>();
  private lastRequestedCapabilityValues = new Map<string, unknown>();
  private capabilityUpdatedAt = new Map<string, string>();
  private actualCapabilityUpdatedAt = new Map<string, string>();
  private settings: Record<string, unknown> = {};
  private behaviorByCapability = new Map<string, MockCapabilityBehaviorConfig>();
  private capabilityMetadata = new Map<string, MockCapabilityMetadata>();
  private capabilityListeners = new Map<string, Set<(value: unknown) => void>>();
  // Mirrors the real SDK's `device.available` (offline = false). Defaults online.
  private available = true;
  // Raw `device.zone` payload (either SDK shape: zone-id string, or
  // `{ id, name }` object). Undefined = omitted from the API payload.
  private zone: string | { id: string; name: string } | undefined;
  // Driver identity (`ownerUri` / `driverUri` / `driverId`) as the real device
  // API payload carries it; omitted entirely when unset.
  private driverIdentity: { ownerUri?: string; driverUri?: string; driverId?: string } = {};

  constructor(
    private id: string,
    private name: string,
    private capabilities: string[],
    private deviceClass: string = 'heater',
  ) {
    if (capabilities.includes('target_temperature')) {
      this.capabilityValues.set('target_temperature', 21);
      this.actualCapabilityValues.set('target_temperature', 21);
      this.capabilityValues.set('measure_temperature', 20);
      this.actualCapabilityValues.set('measure_temperature', 20);
    }
  }

  private getNormalizedCapabilities(): string[] {
    const normalized = new Set(this.capabilities);
    if (normalized.has('target_temperature')) {
      normalized.add('measure_power');
      normalized.add('measure_temperature');
    }
    if (normalized.has('onoff')) {
      normalized.add('measure_power');
    }
    return Array.from(normalized);
  }

  get idValue() {
    return this.id;
  }

  async ready(): Promise<void> {
    return;
  }

  getCapabilities(): string[] {
    return this.getNormalizedCapabilities();
  }

  getName(): string {
    return this.name;
  }

  getDeviceClass(): string {
    return this.deviceClass;
  }

  // Toggle the device's availability, mirroring the real SDK's `device.available`
  // (offline = false). The next snapshot fetch reflects it.
  setAvailable(available: boolean): void {
    this.available = available;
  }

  async getCapabilityValue(capabilityId: string): Promise<unknown> {
    return this.capabilityValues.get(capabilityId);
  }

  async setCapabilityValue(capabilityId: string, value: unknown): Promise<void> {
    this.lastRequestedCapabilityValues.set(capabilityId, value);
    const behavior = this.resolveApiWriteBehavior(capabilityId);
    if (!behavior.accept) {
      throw new Error(`Mock capability write rejected for ${this.name}:${capabilityId}`);
    }
    this.applyCapabilityMutation(capabilityId, value, behavior);
  }

  getSetCapabilityValue(capabilityId: string) {
    if (this.lastRequestedCapabilityValues.has(capabilityId)) {
      return this.lastRequestedCapabilityValues.get(capabilityId);
    }
    return this.capabilityValues.get(capabilityId);
  }

  async getSettings(): Promise<Record<string, unknown>> {
    return this.settings;
  }

  setSettings(settings: Record<string, unknown>): void {
    this.settings = settings;
  }

  getActualCapabilityValue(capabilityId: string): unknown {
    return this.actualCapabilityValues.get(capabilityId);
  }

  getCapabilityLastUpdated(capabilityId: string): string | undefined {
    return this.capabilityUpdatedAt.get(capabilityId);
  }

  getActualCapabilityLastUpdated(capabilityId: string): string | undefined {
    return this.actualCapabilityUpdatedAt.get(capabilityId);
  }

  setApiCapabilityValue(
    capabilityId: string,
    value: unknown,
    behavior: MockCapabilityMutationBehavior = {},
  ): void {
    this.applyCapabilityMutation(capabilityId, value, {
      updateActual: false,
      updateApi: true,
      emitCapabilityEvent: false,
      emitDeviceUpdate: false,
      ...behavior,
    });
  }

  setActualCapabilityValue(
    capabilityId: string,
    value: unknown,
    behavior: MockCapabilityMutationBehavior = {},
  ): void {
    const resolvedBehavior = this.resolveExternalChangeBehavior(capabilityId, behavior);
    this.applyCapabilityMutation(capabilityId, value, resolvedBehavior);
  }

  syncActualToApi(capabilityId?: string, behavior: MockCapabilityMutationBehavior = {}): void {
    const capabilityIds = capabilityId ? [capabilityId] : Array.from(this.actualCapabilityValues.keys());
    for (const nextCapabilityId of capabilityIds) {
      if (!this.actualCapabilityValues.has(nextCapabilityId)) continue;
      this.applyCapabilityMutation(nextCapabilityId, this.actualCapabilityValues.get(nextCapabilityId), {
        updateActual: false,
        updateApi: true,
        emitCapabilityEvent: false,
        emitDeviceUpdate: false,
        ...behavior,
      });
    }
  }

  tapTile(behavior: MockCapabilityMutationBehavior = {}): void {
    const nextValue = this.actualCapabilityValues.get('onoff') !== true;
    this.setActualCapabilityValue('onoff', nextValue, behavior);
  }

  configureCapabilityBehavior(capabilityId: string, config: MockCapabilityBehaviorConfig): void {
    this.behaviorByCapability.set(capabilityId, config);
  }

  setCapabilityMetadata(capabilityId: string, metadata: MockCapabilityMetadata): void {
    this.capabilityMetadata.set(capabilityId, { ...metadata });
  }

  clearCapabilityBehavior(capabilityId: string): void {
    this.behaviorByCapability.delete(capabilityId);
  }

  makeCapabilityInstance(
    capabilityId: string,
    listener: (value: unknown) => void,
  ): { destroy: () => void } {
    let listeners = this.capabilityListeners.get(capabilityId);
    if (!listeners) {
      listeners = new Set<(value: unknown) => void>();
      this.capabilityListeners.set(capabilityId, listeners);
    }
    listeners.add(listener);
    return {
      destroy: () => {
        listeners?.delete(listener);
        if (listeners && listeners.size === 0) {
          this.capabilityListeners.delete(capabilityId);
        }
      },
    };
  }

  emitCapabilityValue(capabilityId: string, value?: unknown): void {
    const listeners = this.capabilityListeners.get(capabilityId);
    if (!listeners || listeners.size === 0) return;
    const nextValue = arguments.length >= 2 ? value : this.capabilityValues.get(capabilityId);
    for (const listener of Array.from(listeners)) {
      listener(nextValue);
    }
  }

  emitDeviceUpdate(): void {
    emitMockHomeyApiDeviceUpdate(this.toHomeyApiDevice());
  }

  /**
   * Configure the driver identity the device API payload carries. Real Homey
   * devices expose these; PELS reads them to recognise vendor wiring (e.g. the
   * Høiax native stepped-load overlay in `nativeSteppedLoadWiring.ts`), so a
   * mock without them cannot exercise those paths.
   */
  setDriverIdentity(identity: { ownerUri?: string; driverUri?: string; driverId?: string }): void {
    // Drop explicitly-undefined keys rather than storing them: spreading those
    // into the payload would leave `ownerUri: undefined` present, which is not
    // what a real device API answers for an absent field and makes mock payloads
    // noisier to diff.
    this.driverIdentity = Object.fromEntries(
      Object.entries(identity).filter(([, value]) => value !== undefined),
    );
  }

  /** Configure the raw `zone` value the device API payload carries (either SDK shape). */
  setZone(zone: string | { id: string; name: string } | undefined): void {
    this.zone = zone;
  }

  toHomeyApiDevice(): Record<string, unknown> {
    const caps = this.getCapabilities();
    const capabilitiesObj: Record<string, unknown> = {};
    for (const cap of caps) {
      const nextValue = this.capabilityValues.get(cap);
      const entry: Record<string, unknown> = { id: cap, value: nextValue };
      const metadata = this.capabilityMetadata.get(cap);
      const lastUpdated = this.capabilityUpdatedAt.get(cap);
      if (metadata?.units) entry.units = metadata.units;
      if (typeof metadata?.min === 'number') entry.min = metadata.min;
      if (typeof metadata?.max === 'number') entry.max = metadata.max;
      if (typeof metadata?.step === 'number') entry.step = metadata.step;
      if (typeof metadata?.setable === 'boolean') entry.setable = metadata.setable;
      if (lastUpdated) entry.lastUpdated = lastUpdated;
      capabilitiesObj[cap] = entry;
    }
    return {
      id: this.idValue,
      data: { id: this.idValue },
      name: this.getName(),
      class: this.getDeviceClass(),
      capabilities: caps,
      capabilitiesObj,
      settings: this.settings,
      makeCapabilityInstance: this.makeCapabilityInstance.bind(this),
      available: this.available,
      ready: true,
      ...(this.zone !== undefined ? { zone: this.zone } : {}),
      ...this.driverIdentity,
    };
  }

  private resolveApiWriteBehavior(capabilityId: string): Required<MockApiWriteBehavior> {
    return {
      ...DEFAULT_API_WRITE_BEHAVIOR,
      ...(this.behaviorByCapability.get(capabilityId)?.onApiWrite ?? {}),
    };
  }

  private resolveExternalChangeBehavior(
    capabilityId: string,
    overrides: MockCapabilityMutationBehavior,
  ): Required<MockCapabilityMutationBehavior> {
    return {
      ...DEFAULT_EXTERNAL_CHANGE_BEHAVIOR,
      ...(this.behaviorByCapability.get(capabilityId)?.onExternalChange ?? {}),
      ...overrides,
    };
  }

  private applyCapabilityMutation(
    capabilityId: string,
    value: unknown,
    behavior: MockCapabilityMutationBehavior,
  ): void {
    const nowIso = new Date().toISOString();
    if (behavior.updateActual !== false) {
      this.actualCapabilityValues.set(capabilityId, value);
      this.actualCapabilityUpdatedAt.set(capabilityId, nowIso);
    }
    if (behavior.updateApi !== false) {
      this.capabilityValues.set(capabilityId, value);
      this.capabilityUpdatedAt.set(capabilityId, nowIso);
    }
    if (behavior.emitCapabilityEvent) {
      this.emitCapabilityValue(capabilityId, value);
    }
    if (behavior.emitDeviceUpdate) {
      this.emitDeviceUpdate();
    }
  }
}

export class MockDriver {
  constructor(
    public id: string,
    private devices: MockDevice[],
  ) { }

  async ready(): Promise<void> {
    return;
  }

  getDevices(): MockDevice[] {
    return this.devices;
  }
}

let autoEnableMockDevices = false;
const mockHomeyEmitter = new EventEmitter();
const mockSdkDevicesApiEmitter = new EventEmitter();
mockSdkDevicesApiEmitter.setMaxListeners(0);

export const setAutoEnableMockDevices = (enabled: boolean): void => {
  autoEnableMockDevices = enabled;
};

export const emitMockSdkDeviceUpdate = (device: Record<string, unknown>): void => {
  mockSdkDevicesApiEmitter.emit('realtime', 'device.update', device);
};


// Legacy aliases
export const emitMockHomeyApiDeviceUpdate = emitMockSdkDeviceUpdate;

const buildControllableDevices = (drivers: Record<string, MockDriver>): Record<string, boolean> => {
  const controllable: Record<string, boolean> = {};
  for (const driver of Object.values(drivers)) {
    for (const device of driver.getDevices()) {
      controllable[device.idValue] = true;
    }
  }
  return controllable;
};

// Helper to find a device instance by ID across all mock drivers
const findMockDeviceById = (deviceId: string): MockDevice | null => {
  const drivers = mockHomeyInstance.drivers.getDrivers();
  for (const driver of Object.values(drivers)) {
    for (const device of driver.getDevices()) {
      if (device.idValue === deviceId) {
        return device;
      }
    }
  }
  return null;
};


/** A Flow token as `flow.createToken` registers it, plus the call record specs assert against. */
// Homey's two production trigger ports disagree about the token type — `object` in
// `lib/device/transport/transportTypes.ts`, `Record<string, unknown>` in
// `lib/ports/homeyRuntime.ts`. The mock's `trigger` accepts the looser one so both wire up,
// and records the stricter view, which is what the specs assert against. One reconciliation
// here beats one cast in every spec that reads a recorded token.
const asTriggerRecord = (value?: object): Record<string, unknown> | undefined => (
  value as Record<string, unknown> | undefined
);

export type MockFlowToken = {
  value: unknown;
  type?: string;
  title?: string;
  setValueCount: number;
  setValueCalls: unknown[];
};

export const mockHomeyInstance = {
  on(event: string, listener: (...args: unknown[]) => void) {
    mockHomeyEmitter.on(event, listener);
    return mockHomeyInstance;
  },
  off(event: string, listener: (...args: unknown[]) => void) {
    mockHomeyEmitter.off(event, listener);
    return mockHomeyInstance;
  },
  removeListener(event: string, listener: (...args: unknown[]) => void) {
    mockHomeyEmitter.removeListener(event, listener);
    return mockHomeyInstance;
  },
  emit(event: string, ...args: unknown[]) {
    return mockHomeyEmitter.emit(event, ...args);
  },
  removeAllListeners(event?: string) {
    mockHomeyEmitter.removeAllListeners(event);
    return mockHomeyInstance;
  },
  settings: new MockSettings(),
  // The one `any` left in this file, and deliberately so. Typing this slot makes
  // `getLatestPlanSnapshotForTests` return a real `DevicePlan | null`, which surfaces 154 errors
  // across 7 specs: ~89 unguarded `plan.devices` reads, ~45 possibly-undefined array indexes,
  // and 20 reads of `plannedTarget` that need the temperature discriminant first (it is
  // `?: never` on the other arms of `DevicePlanDevice`). Those 20 are real — the assertions have
  // been reading through `any` — but fixing them is plan-domain work, not a typing chore, so it
  // gets its own change. `reportUnusedDisableDirectives` retires this line the day that lands.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  app: null as any,
  platform: 'local',
  platformVersion: 2,
  version: '1.0.0',
  // Minimal app.json manifest — the weather MET fetcher reads id/version/contact
  // off it to build the mandatory User-Agent.
  manifest: {
    id: 'com.barelysufficient.pels',
    version: '1.0.0',
    homepage: 'https://pels.barelysufficient.org/',
  },
  clock: {
    getTimezone: () => 'Europe/Oslo',
  },
  // Raw location served by the owner-authenticated Homey Web API route.
  // Defaults to Oslo-ish coordinates; mutate via setMockGeolocation.
  location: {
    _latitude: 59.91,
    _longitude: 10.75,
  },
  images: createMockImagesManager(),
  cloud: {
    getHomeyId: async () => 'mock-homey-id',
  },
  zones: {
    // Raw payload served for `manager/zones/zone`. Configurable via
    // `setMockZones`; `null` makes the route throw (drives the transport's
    // failed-fetch / cached-tree-retained path).
    _zones: {} as Record<string, unknown> | null,
  },
  api: {
    getOwnerApiToken: async () => 'mock-token',
    getLocalUrl: async () => 'http://localhost',
    energy: {
      fetchDynamicElectricityPrices: async () => ([]),
      getCurrency: async () => ({ currency: 'NOK' }),
    },
    _realtimeEvents: [] as Array<{ event: string; data: unknown }>,
    realtime: async (event: string, data: unknown) => {
      // Track realtime events for testing
      mockHomeyInstance.api._realtimeEvents.push({ event, data });
    },
    clearRealtimeEvents: () => {
      mockHomeyInstance.api._realtimeEvents = [];
    },
    get: async (path: string) => {
      // Return devices from mock drivers when API is called
      if (path === 'manager/devices/device' || path === 'manager/devices' || path === 'devices') {
        const drivers = mockHomeyInstance.drivers.getDrivers();
        const devices: Record<string, unknown> = {};
        for (const driver of Object.values(drivers)) {
          for (const device of driver.getDevices()) {
            devices[device.idValue] = device.toHomeyApiDevice();
          }
        }
        return devices;
      }
      // Targeted by-id fetch (`getRawDevice`): `manager/devices/device/<id>`.
      // The real transport reads a single device on a targeted refresh; the mock
      // serves it from the same driver-backed devices so per-id rejection (a 404
      // for one flaky/removed device) is expressible at this SDK seam.
      const byIdMatch = path.match(/^manager\/devices\/device\/([^/]+)$/);
      if (byIdMatch) {
        const device = findMockDeviceById(byIdMatch[1]);
        if (!device) {
          throw new Error(`Mock API GET 404 for device: ${byIdMatch[1]}`);
        }
        return device.toHomeyApiDevice();
      }
      if (path === 'manager/energy/live') {
        return { items: [] };
      }
      if (path === 'manager/geolocation/option/location') {
        return {
          value: {
            latitude: mockHomeyInstance.location._latitude,
            longitude: mockHomeyInstance.location._longitude,
            accuracy: 10,
          },
        };
      }
      if (path === 'manager/zones/zone') {
        const zones = mockHomeyInstance.zones._zones;
        if (zones === null) {
          throw new Error('Mock API GET zones unavailable');
        }
        return zones;
      }
      throw new Error(`Mock API GET not implemented for: ${path}`);
    },
    put: async (path: string, body?: unknown) => {
      // Handle capability value setting: manager/devices/device/{id}/capability/{capId}
      const capMatch = path.match(/^manager\/devices\/device\/(.+?)\/capability\/(.+)$/);
      if (capMatch) {
        const [, deviceId, capabilityId] = capMatch;
        const device = findMockDeviceById(deviceId);
        if (device) {
          // The SDK's `api.put` body is arbitrary; this mock serves only the capability
          // write, so the shape is asserted here, where it is actually interpreted.
          await device.setCapabilityValue(capabilityId, (body as { value?: unknown } | undefined)?.value);
        }
        return;
      }
      throw new Error(`Mock API PUT not implemented for: ${path}`);
    },
    post: async (path: string, body?: unknown) => {
      const flowMatch = path.match(/^manager\/flow\/flowcardaction\/(.+?)\/(.+?)\/run$/);
      if (flowMatch) {
        return {
          ok: true,
          path,
          body,
        };
      }
      throw new Error(`Mock API POST not implemented for: ${path}`);
    },
    getApi: (uri: string) => {
      if (uri === 'homey:manager:devices') {
        return mockSdkDevicesApiEmitter;
      }
      throw new Error(`Mock getApi not implemented for: ${uri}`);
    },
  },
  flow: {
    _tokens: {} as Record<string, MockFlowToken>,
    _actionCardListeners: {} as Record<string, (args: unknown) => Promise<unknown>>,
    _conditionCardListeners: {} as Record<string, (args: unknown) => Promise<unknown>>,
    _triggerCardRunListeners: {} as Record<string, (args: unknown, state: unknown) => Promise<unknown>>,
    // Tokens/state mirror the production `FlowTriggerCard` port in lib/ports/homeyRuntime.ts,
    // so a spec reading a token off a recorded trigger sees the same shape the runtime passes.
    _triggerCardTriggers: {} as Record<string, Array<{
      tokens?: Record<string, unknown>;
      state?: Record<string, unknown>;
    }>>,
    _actionCardAutocompleteListeners: {} as Record<string, Record<string, (query: string) => Promise<unknown>>>,
    _conditionCardAutocompleteListeners: {} as Record<string, Record<string, (query: string) => Promise<unknown>>>,
    _triggerCardAutocompleteListeners: {} as Record<string, Record<string, (query: string) => Promise<unknown>>>,
    createToken: async (id: string, opts: { value: unknown; type?: string; title?: string }) => {
      const entry: MockFlowToken = {
        value: opts.value,
        type: opts.type,
        title: opts.title,
        setValueCount: 0,
        setValueCalls: [],
      };
      mockHomeyInstance.flow._tokens[id] = entry;
      return {
        setValue: async (nextValue: unknown) => {
          entry.value = nextValue;
          entry.setValueCount += 1;
          entry.setValueCalls.push(nextValue);
        },
      };
    },
    getActionCard: (cardId: string) => ({
      registerRunListener: (listener: (args: unknown) => Promise<unknown>) => {
        mockHomeyInstance.flow._actionCardListeners[cardId] = listener;
      },
      registerArgumentAutocompleteListener: (arg: string, listener: (query: string) => Promise<unknown>) => {
        if (!mockHomeyInstance.flow._actionCardAutocompleteListeners[cardId]) {
          mockHomeyInstance.flow._actionCardAutocompleteListeners[cardId] = {};
        }
        mockHomeyInstance.flow._actionCardAutocompleteListeners[cardId][arg] = listener;
      },
    }),
    getConditionCard: (cardId: string) => ({
      registerRunListener: (listener: (args: unknown) => Promise<unknown>) => {
        mockHomeyInstance.flow._conditionCardListeners[cardId] = listener;
      },
      registerArgumentAutocompleteListener: (arg: string, listener: (query: string) => Promise<unknown>) => {
        if (!mockHomeyInstance.flow._conditionCardAutocompleteListeners[cardId]) {
          mockHomeyInstance.flow._conditionCardAutocompleteListeners[cardId] = {};
        }
        mockHomeyInstance.flow._conditionCardAutocompleteListeners[cardId][arg] = listener;
      },
    }),
    getTriggerCard: (cardId: string) => ({
      registerRunListener: (listener: (args: unknown, state: unknown) => Promise<unknown>) => {
        mockHomeyInstance.flow._triggerCardRunListeners[cardId] = listener;
      },
      registerArgumentAutocompleteListener: (arg: string, listener: (query: string) => Promise<unknown>) => {
        if (!mockHomeyInstance.flow._triggerCardAutocompleteListeners[cardId]) {
          mockHomeyInstance.flow._triggerCardAutocompleteListeners[cardId] = {};
        }
        mockHomeyInstance.flow._triggerCardAutocompleteListeners[cardId][arg] = listener;
      },
      trigger: (tokens?: object, state?: object) => {
        if (!mockHomeyInstance.flow._triggerCardTriggers[cardId]) {
          mockHomeyInstance.flow._triggerCardTriggers[cardId] = [];
        }
        mockHomeyInstance.flow._triggerCardTriggers[cardId].push({
          tokens: asTriggerRecord(tokens) ?? {},
          state: asTriggerRecord(state) ?? {},
        });
        return Promise.resolve(true);
      },
    }),
  },
  drivers: {
    getDrivers: (): Record<string, MockDriver> => ({}),
  },
};

/**
 * Configure (or clear) the location returned by the mock Homey Web API. Pass
 * `null`/`undefined` for either coordinate to clear it (normalized to NaN).
 */
export const setMockGeolocation = (
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): void => {
  mockHomeyInstance.location._latitude = latitude ?? Number.NaN;
  mockHomeyInstance.location._longitude = longitude ?? Number.NaN;
};

/**
 * Configure the raw payload the mock `manager/zones/zone` route serves. Pass a
 * zone map (record keyed by zone id, values as raw zone-ish entries) to drive
 * the transport's zone-tree fetch; pass `null` to make the route throw
 * (failed-fetch path). Defaults to `{}` — an empty record, which the transport
 * treats as a failed fetch (a zone-less Homey cannot exist), so unrelated
 * refreshes never commit a tree.
 */
export const setMockZones = (zones: Record<string, unknown> | null): void => {
  mockHomeyInstance.zones._zones = zones;
};

export const setMockDrivers = (drivers: Record<string, MockDriver>) => {
  mockHomeyInstance.drivers.getDrivers = () => drivers;
  if (!autoEnableMockDevices) return;
  const existingControllable = mockHomeyInstance.settings.get('controllable_devices');
  const existingManaged = mockHomeyInstance.settings.get('managed_devices');
  if ((existingControllable && typeof existingControllable === 'object')
    || (existingManaged && typeof existingManaged === 'object')) {
    return;
  }
  const controllable = buildControllableDevices(drivers);
  if (Object.keys(controllable).length > 0) {
    mockHomeyInstance.settings.set('controllable_devices', controllable);
    const managed = { ...controllable };
    mockHomeyInstance.settings.set('managed_devices', managed);
  }
};

export const getLatestPlanSnapshotForTests = () => (
  mockHomeyInstance.app?.planService?.getLatestPlanSnapshot?.() ?? null
);

class MockApp {
  homey = mockHomeyInstance;

  constructor() {
    mockHomeyInstance.app = this;
  }

  log(...args: unknown[]) {
    /* istanbul ignore next */
    console.log(...args);
  }

  error(...args: unknown[]) {
    /* istanbul ignore next */
    console.error(...args);
  }
}

// Set the REST client so production code uses the mock API methods
// instead of trying real HTTP requests during tests.
setRestClient({
  get: (path: string) => mockHomeyInstance.api.get(path),
  put: (path: string, body: unknown) => mockHomeyInstance.api.put(path, body),
});

const homeyModule = {
  App: MockApp,
  __mock: {
    mockHomeyInstance,
    MockDevice,
    MockDriver,
    setMockDrivers,
    setAutoEnableMockDevices,
  },
};

export default homeyModule;
