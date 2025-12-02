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
  ) {}

  private capabilityValues = new Map<string, any>();
  private settings: Record<string, any> = {};

  get idValue() {
    return this.id;
  }

  async ready(): Promise<void> {
    return;
  }

  getCapabilities(): string[] {
    return this.capabilities;
  }

  getName(): string {
    return this.name;
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
  ) {}

  async ready(): Promise<void> {
    return;
  }

  getDevices(): MockDevice[] {
    return this.devices;
  }
}

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
  settings: new MockSettings(),
  api: {
    getOwnerApiToken: async () => 'mock-token',
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
              capabilitiesObj[cap] = { value: await device.getCapabilityValue(cap) };
            }
            devices[device.idValue] = {
              id: device.idValue,
              name: device.getName(),
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
    _actionCardListeners: {} as Record<string, (args: any) => Promise<any>>,
    _conditionCardListeners: {} as Record<string, (args: any) => Promise<any>>,
    getActionCard: (cardId: string) => ({
      registerRunListener: (listener: (args: any) => Promise<any>) => {
        mockHomeyInstance.flow._actionCardListeners[cardId] = listener;
      },
      registerArgumentAutocompleteListener: () => {},
    }),
    getConditionCard: (cardId: string) => ({
      registerRunListener: (listener: (args: any) => Promise<any>) => {
        mockHomeyInstance.flow._conditionCardListeners[cardId] = listener;
      },
    }),
    getTriggerCard: () => ({
      trigger: () => {},
    }),
  },
  drivers: {
    getDrivers: (): Record<string, MockDriver> => ({}),
  },
};

export const setMockDrivers = (drivers: Record<string, MockDriver>) => {
  mockHomeyInstance.drivers.getDrivers = () => drivers;
};

class MockApp {
  homey = mockHomeyInstance;

  log(...args: any[]) {
    /* istanbul ignore next */
    // eslint-disable-next-line no-console
    console.log(...args);
  }

  error(...args: any[]) {
    /* istanbul ignore next */
    // eslint-disable-next-line no-console
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
  },
};

// Mock for homey-api module - HomeyAPI.createAppAPI
export const mockHomeyApiInstance = {
  devices: {
    setCapabilityValue: async ({ deviceId, capabilityId, value }: { deviceId: string; capabilityId: string; value: any }) => {
      const device = findMockDeviceById(deviceId);
      if (device) {
        await device.setCapabilityValue(capabilityId, value);
      }
    },
  },
};

export default homeyModule;
