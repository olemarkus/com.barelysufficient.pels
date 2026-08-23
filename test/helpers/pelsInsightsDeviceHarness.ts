/**
 * Shared fake `Homey.Device` base for the `pels_insights` driver specs.
 *
 * The shared `homey` alias mock (test/mocks/homey.ts) only exposes `App`, not a
 * `Device` base class, so the insights device cannot extend it under that
 * alias. This is the SDK surface the driver actually uses — every method here
 * has a call site in drivers/pels_insights/device.ts — capturing capability
 * listeners, capability values and option writes so a spec can drive `onInit`
 * and the registered listeners directly.
 *
 * A spec installs it with
 * `vi.mock('homey', async () => ({ default: { Device: FakeInsightsDeviceBase } }))`
 * — resolved through a dynamic import inside the factory, because `vi.mock` is
 * hoisted above this module's own imports.
 */
import { createMockImagesManager, type MockImagesManager } from '../mocks/homeyImages';

export type CapabilityListener = (value: unknown) => Promise<void> | void;

export class FakeInsightsSettings {
  private store = new Map<string, unknown>();

  private listeners = new Map<string, Set<(key: string) => void>>();

  // When set, `set` throws to simulate a rejected settings write.
  public failOnSet = false;

  // A value whose write rejects *asynchronously* (returns a rejected promise
  // without storing) to model an in-flight write that fails after a later tap
  // has already started.
  public asyncFailValue: string | null = null;

  get(key: string): unknown {
    return this.store.get(key);
  }

  set(key: string, value: unknown): void | Promise<void> {
    if (this.asyncFailValue !== null && value === this.asyncFailValue) {
      return Promise.reject(new Error('settings write rejected (async)'));
    }
    if (this.failOnSet) {
      throw new Error('settings write rejected');
    }
    this.store.set(key, value);
    for (const listener of this.listeners.get('set') ?? []) listener(key);
    return undefined;
  }

  on(event: string, listener: (key: string) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
}

export class FakeInsightsDeviceBase {
  // Every Homey has an images manager, so every fake device gets one. It starts
  // with an empty registry — the steady state on an install whose retired plan
  // images are already gone. A spec seeds `images.registeredImageIds` to model
  // one that still holds them.
  public homey: {
    settings: FakeInsightsSettings;
    images: MockImagesManager;
  } = {
    settings: new FakeInsightsSettings(),
    images: createMockImagesManager(),
  };

  public capabilityValues = new Map<string, unknown>();

  public capabilityListeners = new Map<string, CapabilityListener>();

  // The driver must log structurally (`getLogger`), never through the SDK's
  // prose logger. Nothing should ever land here; a spec asserting the array is
  // empty is pinning that, not checking for an error.
  public errorCalls: unknown[][] = [];

  public setCapabilityOptionsCalls: unknown[][] = [];

  hasCapability(): boolean {
    return true;
  }

  async addCapability(): Promise<void> {
    /* no-op for tests */
  }

  async removeCapability(): Promise<void> {
    /* no-op for tests */
  }

  async setCapabilityValue(capabilityId: string, value: unknown): Promise<void> {
    this.capabilityValues.set(capabilityId, value);
  }

  async setCapabilityOptions(...args: unknown[]): Promise<void> {
    this.setCapabilityOptionsCalls.push(args);
  }

  registerCapabilityListener(capabilityId: string, listener: CapabilityListener): void {
    this.capabilityListeners.set(capabilityId, listener);
  }

  // The driver overrides these at runtime; declared on the fake so the
  // `new () => FakeInsightsDeviceBase`-typed instance exposes the surface the
  // tests drive.
  async onInit(): Promise<void> {
    /* overridden by the real driver */
  }

  error(...args: unknown[]): void {
    this.errorCalls.push(args);
  }
}

/**
 * The driver's own type once it is mounted on the fake base: `export =` plus the
 * `homey` alias mock means a spec cannot name the class, so this states the
 * members a spec drives. Loaded dynamically because the class body evaluates
 * `Homey.Device`, which only exists once `vi.mock('homey')` has run.
 */
export type PelsInsightsDeviceUnderTest = FakeInsightsDeviceBase & {
  onUninit: () => Promise<void>;
  refreshModeOptions: () => Promise<void>;
};

export const loadPelsInsightsDeviceClass = async (): Promise<
  new () => PelsInsightsDeviceUnderTest
> => {
  // The `.js` extension is required under nodenext module resolution.
  const driverModule = await import('../../drivers/pels_insights/device.js');
  return (driverModule as { default: unknown }).default as new () => PelsInsightsDeviceUnderTest;
};
