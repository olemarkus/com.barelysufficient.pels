import { EventEmitter } from 'events';
import { setRestClient } from '../../lib/core/deviceManagerHomeyApi';

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
  private store = new Map<string, any>();

  get(key: string) {
    return this.store.get(key);
  }

  set(key: string, value: any) {
    this.store.set(key, value);
    this.emit('set', key);
  }

  clear() {
    this.store.clear();
  }
}

export class MockDevice {
  private capabilityValues = new Map<string, any>();
  private actualCapabilityValues = new Map<string, any>();
  private lastRequestedCapabilityValues = new Map<string, any>();
  private capabilityUpdatedAt = new Map<string, string>();
  private actualCapabilityUpdatedAt = new Map<string, string>();
  private settings: Record<string, any> = {};
  private settingsObject: any[] | null = null;
  private behaviorByCapability = new Map<string, MockCapabilityBehaviorConfig>();
  private capabilityListeners = new Map<string, Set<(value: unknown) => void>>();

  constructor(
    private id: string,
    private name: string,
    private capabilities: string[],
    private deviceClass: string = 'heater',
  ) { }

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

  getData() {
    return { id: this.id };
  }

  async getCapabilityValue(capabilityId: string): Promise<any> {
    return this.capabilityValues.get(capabilityId);
  }

  async setCapabilityValue(capabilityId: string, value: any): Promise<void> {
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

  async getSettings(): Promise<Record<string, any>> {
    return this.settings;
  }

  setSettings(settings: Record<string, any>): void {
    this.settings = settings;
  }

  async getSettingsObject(): Promise<any[] | null> {
    return this.settingsObject;
  }

  setSettingsObject(settingsObject: any[] | null): void {
    this.settingsObject = settingsObject;
  }

  getActualCapabilityValue(capabilityId: string): any {
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

  toHomeyApiDevice(): Record<string, any> {
    const caps = this.getCapabilities();
    const capabilitiesObj: Record<string, any> = {};
    for (const cap of caps) {
      const nextValue = this.capabilityValues.get(cap);
      const entry: Record<string, any> = { id: cap, value: nextValue };
      const lastUpdated = this.capabilityUpdatedAt.get(cap);
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
      available: true,
      ready: true,
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

export const emitMockSdkDeviceUpdate = (device: Record<string, any>): void => {
  mockSdkDevicesApiEmitter.emit('realtime', 'device.update', device);
};

export const clearMockSdkDeviceListeners = (): void => {
  mockSdkDevicesApiEmitter.removeAllListeners();
};

// Legacy aliases
export const emitMockHomeyApiDeviceUpdate = emitMockSdkDeviceUpdate;
export const clearMockHomeyApiDeviceListeners = clearMockSdkDeviceListeners;

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

export const getMockDeviceById = (deviceId: string): MockDevice | null => findMockDeviceById(deviceId);

export const mockHomeyInstance = {
  on(event: string, listener: (...args: any[]) => void) {
    mockHomeyEmitter.on(event, listener);
    return mockHomeyInstance;
  },
  off(event: string, listener: (...args: any[]) => void) {
    mockHomeyEmitter.off(event, listener);
    return mockHomeyInstance;
  },
  removeListener(event: string, listener: (...args: any[]) => void) {
    mockHomeyEmitter.removeListener(event, listener);
    return mockHomeyInstance;
  },
  emit(event: string, ...args: any[]) {
    return mockHomeyEmitter.emit(event, ...args);
  },
  removeAllListeners(event?: string) {
    mockHomeyEmitter.removeAllListeners(event);
    return mockHomeyInstance;
  },
  settings: new MockSettings(),
  platform: 'local',
  platformVersion: 2,
  version: '1.0.0',
  clock: {
    getTimezone: () => 'Europe/Oslo',
    getTimezoneOffset: () => -60, // CET in winter
  },
  images: {
    createImage: async () => ({
      setStream: (_handler: (stream: NodeJS.WritableStream) => void) => {},
      update: async () => {},
      unregister: async () => {},
    }),
    unregisterImage: async () => {},
    getImage: () => {
      throw new Error('not implemented');
    },
  },
  cloud: {
    getHomeyId: async () => 'mock-homey-id',
  },
  notifications: {
    _notifications: [] as Array<{ excerpt: string }>,
    createNotification: async ({ excerpt }: { excerpt: string }) => {
      mockHomeyInstance.notifications._notifications.push({ excerpt });
    },
    clearNotifications: () => {
      mockHomeyInstance.notifications._notifications = [];
    },
  },
  api: {
    getOwnerApiToken: async () => 'mock-token',
    getLocalUrl: async () => 'http://localhost',
    energy: {
      fetchDynamicElectricityPrices: async () => ([]),
      getCurrency: async () => ({ currency: 'NOK' }),
    },
    _realtimeEvents: [] as Array<{ event: string; data: any }>,
    realtime: async (event: string, data: any) => {
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
        const devices: Record<string, any> = {};
        for (const driver of Object.values(drivers)) {
          for (const device of driver.getDevices()) {
            devices[device.idValue] = device.toHomeyApiDevice();
          }
        }
        return devices;
      }
      throw new Error(`Mock API GET not implemented for: ${path}`);
    },
    put: async (path: string, body?: any) => {
      // Handle capability value setting: manager/devices/device/{id}/capability/{capId}
      const capMatch = path.match(/^manager\/devices\/device\/(.+?)\/capability\/(.+)$/);
      if (capMatch) {
        const [, deviceId, capabilityId] = capMatch;
        const device = findMockDeviceById(deviceId);
        if (device) {
          await device.setCapabilityValue(capabilityId, body?.value);
        }
        return;
      }
      throw new Error(`Mock API PUT not implemented for: ${path}`);
    },
    getApi: (uri: string) => {
      if (uri === 'homey:manager:devices') {
        return mockSdkDevicesApiEmitter;
      }
      throw new Error(`Mock getApi not implemented for: ${uri}`);
    },
  },
  flow: {
    _tokens: {} as Record<string, { value: any }>,
    _actionCardListeners: {} as Record<string, (args: any) => Promise<any>>,
    _conditionCardListeners: {} as Record<string, (args: any) => Promise<any>>,
    _triggerCardRunListeners: {} as Record<string, (args: any, state: any) => Promise<any>>,
    _triggerCardTriggers: {} as Record<string, Array<{ tokens: any; state: any }>>,
    _actionCardAutocompleteListeners: {} as Record<string, Record<string, (query: string) => Promise<any>>>,
    _conditionCardAutocompleteListeners: {} as Record<string, Record<string, (query: string) => Promise<any>>>,
    _triggerCardAutocompleteListeners: {} as Record<string, Record<string, (query: string) => Promise<any>>>,
    createToken: async (id: string, { value }: { value: any }) => {
      mockHomeyInstance.flow._tokens[id] = { value };
      return {
        setValue: async (nextValue: any) => {
          mockHomeyInstance.flow._tokens[id].value = nextValue;
        },
      };
    },
    getActionCard: (cardId: string) => ({
      registerRunListener: (listener: (args: any) => Promise<any>) => {
        mockHomeyInstance.flow._actionCardListeners[cardId] = listener;
      },
      registerArgumentAutocompleteListener: (arg: string, listener: (query: string) => Promise<any>) => {
        if (!mockHomeyInstance.flow._actionCardAutocompleteListeners[cardId]) {
          mockHomeyInstance.flow._actionCardAutocompleteListeners[cardId] = {};
        }
        mockHomeyInstance.flow._actionCardAutocompleteListeners[cardId][arg] = listener;
      },
    }),
    getConditionCard: (cardId: string) => ({
      registerRunListener: (listener: (args: any) => Promise<any>) => {
        mockHomeyInstance.flow._conditionCardListeners[cardId] = listener;
      },
      registerArgumentAutocompleteListener: (arg: string, listener: (query: string) => Promise<any>) => {
        if (!mockHomeyInstance.flow._conditionCardAutocompleteListeners[cardId]) {
          mockHomeyInstance.flow._conditionCardAutocompleteListeners[cardId] = {};
        }
        mockHomeyInstance.flow._conditionCardAutocompleteListeners[cardId][arg] = listener;
      },
    }),
    getTriggerCard: (cardId: string) => ({
      registerRunListener: (listener: (args: any, state: any) => Promise<any>) => {
        mockHomeyInstance.flow._triggerCardRunListeners[cardId] = listener;
      },
      registerArgumentAutocompleteListener: (arg: string, listener: (query: string) => Promise<any>) => {
        if (!mockHomeyInstance.flow._triggerCardAutocompleteListeners[cardId]) {
          mockHomeyInstance.flow._triggerCardAutocompleteListeners[cardId] = {};
        }
        mockHomeyInstance.flow._triggerCardAutocompleteListeners[cardId][arg] = listener;
      },
      trigger: (tokens?: any, state?: any) => {
        if (!mockHomeyInstance.flow._triggerCardTriggers[cardId]) {
          mockHomeyInstance.flow._triggerCardTriggers[cardId] = [];
        }
        mockHomeyInstance.flow._triggerCardTriggers[cardId].push({
          tokens: tokens || {},
          state: state || {},
        });
        return Promise.resolve(true);
      },
    }),
  },
  drivers: {
    getDrivers: (): Record<string, MockDriver> => ({}),
  },
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

class MockApp {
  homey = mockHomeyInstance;

  log(...args: any[]) {
    /* istanbul ignore next */
    console.log(...args);
  }

  error(...args: any[]) {
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
