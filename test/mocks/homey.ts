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

export const mockHomeyInstance = {
  settings: new MockSettings(),
  api: {
    get: async () => {
      throw new Error('not implemented');
    },
  },
  flow: {
    getActionCard: () => ({
      registerRunListener: () => {},
    }),
    getConditionCard: () => ({
      registerRunListener: () => {},
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

export default homeyModule;
