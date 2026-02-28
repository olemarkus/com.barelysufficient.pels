import { EventEmitter } from 'events';

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

  private capabilityValues = new Map<string, any>();
  private settings: Record<string, any> = {};

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
    this.capabilityValues.set(capabilityId, value);
  }

  getSetCapabilityValue(capabilityId: string) {
    return this.capabilityValues.get(capabilityId);
  }

  async getSettings(): Promise<Record<string, any>> {
    return this.settings;
  }

  setSettings(settings: Record<string, any>): void {
    this.settings = settings;
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

export const setAutoEnableMockDevices = (enabled: boolean): void => {
  autoEnableMockDevices = enabled;
};

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
      if (path === 'manager/devices' || path === 'devices') {
        const drivers = mockHomeyInstance.drivers.getDrivers();
        const devices: Record<string, any> = {};
        for (const driver of Object.values(drivers)) {
          for (const device of driver.getDevices()) {
            const caps = device.getCapabilities();
            const capabilitiesObj: Record<string, any> = {};
            for (const cap of caps) {
              capabilitiesObj[cap] = { id: cap, value: await device.getCapabilityValue(cap) };
            }
            devices[device.idValue] = {
              id: device.idValue,
              name: device.getName(),
              class: device.getDeviceClass(),
              capabilities: caps,
              capabilitiesObj,
              settings: await device.getSettings(),
            };
          }
        }
        return devices;
      }
      throw new Error('not implemented');
    },
    devices: {
      setCapabilityValue: async ({ deviceId, capabilityId, value }: { deviceId: string; capabilityId: string; value: any }) => {
        const device = findMockDeviceById(deviceId);
        if (device) {
          await device.setCapabilityValue(capabilityId, value);
        }
      },
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

// Mock for homey-api module - HomeyAPI.createAppAPI
export const mockHomeyApiInstance = {
  energy: {
    fetchDynamicElectricityPrices: async () => ([]),
    getCurrency: async () => ({ currency: 'NOK' }),
  },
  devices: {
    // Mirror Homey's device API using the in-memory mock drivers
    getDevices: async () => {
      const drivers = mockHomeyInstance.drivers.getDrivers();
      const devices: Record<string, any> = {};
        for (const driver of Object.values(drivers)) {
          for (const device of driver.getDevices()) {
            const caps = device.getCapabilities();
            const capabilitiesObj: Record<string, any> = {};
          for (const cap of caps) {
            capabilitiesObj[cap] = { id: cap, value: await device.getCapabilityValue(cap) };
          }
          devices[device.idValue] = {
            id: device.idValue,
            name: device.getName(),
            class: device.getDeviceClass(),
            capabilities: caps,
            capabilitiesObj,
            settings: await device.getSettings(),
          };
        }
      }
      return devices;
    },
    setCapabilityValue: async ({ deviceId, capabilityId, value }: { deviceId: string; capabilityId: string; value: any }) => {
      const device = findMockDeviceById(deviceId);
      if (device) {
        await device.setCapabilityValue(capabilityId, value);
      }
    },
  },
};

export default homeyModule;
