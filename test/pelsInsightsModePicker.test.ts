import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATING_MODE_SETTING } from '../lib/utils/settingsKeys';

// The shared `homey` alias mock (test/mocks/homey.ts) only exposes `App`, not a
// `Device` base class, so the insights device cannot extend it under that
// alias. Provide a minimal `Device` base that mirrors the SDK surface the
// driver actually uses, capturing capability listeners and capability values so
// we can drive the mode-picker listener directly.

type CapabilityListener = (value: unknown) => Promise<void> | void;

class FakeSettings {
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

class FakeDeviceBase {
  public homey = {
    settings: new FakeSettings(),
    images: undefined,
  };

  public capabilityValues = new Map<string, unknown>();

  public capabilityListeners = new Map<string, CapabilityListener>();

  public errorCalls: unknown[][] = [];

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

  async setCapabilityOptions(): Promise<void> {
    /* no-op for tests */
  }

  registerCapabilityListener(capabilityId: string, listener: CapabilityListener): void {
    this.capabilityListeners.set(capabilityId, listener);
  }

  log(): void {
    /* no-op for tests */
  }

  error(...args: unknown[]): void {
    this.errorCalls.push(args);
  }
}

vi.mock('homey', () => ({
  default: { Device: FakeDeviceBase },
}));

// `vi.mock` is hoisted above imports, so the dynamic import below picks up the
// mocked `homey` and the driver extends FakeDeviceBase. The driver uses
// `export =`, which surfaces as the module's default export under esbuild.
const driverModule = await import('../drivers/pels_insights/device');
const PelsInsightsDevice = (driverModule as { default: unknown }).default as new () => FakeDeviceBase;

type DeviceUnderTest = InstanceType<typeof PelsInsightsDevice> & FakeDeviceBase;

const createDevice = (committedMode: string): DeviceUnderTest => {
  const device = new PelsInsightsDevice() as DeviceUnderTest;
  device.homey.settings.set(OPERATING_MODE_SETTING, committedMode);
  return device;
};

const tapMode = async (device: DeviceUnderTest, value: unknown): Promise<void> => {
  const listener = device.capabilityListeners.get('mode_indicator');
  expect(listener).toBeDefined();
  await listener?.(value);
};

describe('pels_insights mode-picker listener', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const initDevice = async (committedMode: string): Promise<DeviceUnderTest> => {
    const device = createDevice(committedMode);
    await device.onInit();
    // Reset the recorded mode tile written by onInit so assertions only see
    // the effect of the tapped value.
    device.capabilityValues.delete('mode_indicator');
    return device;
  };

  it('commits the tapped mode to settings on success', async () => {
    const device = await initDevice('Home');

    await tapMode(device, 'Away');

    expect(device.homey.settings.get(OPERATING_MODE_SETTING)).toBe('Away');
    expect(device.errorCalls).toHaveLength(0);
  });

  it('reverts the tile and logs an error when the settings write is rejected', async () => {
    const device = await initDevice('Home');

    device.homey.settings.failOnSet = true;
    await tapMode(device, 'Away');

    // Settings stayed on the previously-committed mode (write was rejected).
    expect(device.homey.settings.get(OPERATING_MODE_SETTING)).toBe('Home');
    // The tile was reverted to the runtime's true mode.
    expect(device.capabilityValues.get('mode_indicator')).toBe('Home');
    // The failure was surfaced via this.error.
    expect(device.errorCalls).toHaveLength(1);
    expect(device.errorCalls[0]?.[0]).toContain('Failed to commit mode selection');
  });

  it('does not revert the tile when a newer selection supersedes a failed write', async () => {
    const device = await initDevice('Home');

    // 'Away' will reject asynchronously; start it but don't await yet.
    device.homey.settings.asyncFailValue = 'Away';
    const failingTap = tapMode(device, 'Away');

    // A newer tap lands and succeeds synchronously, bumping the selection seq.
    await tapMode(device, 'Sleep');

    // Now let the stale 'Away' write settle and run its catch/revert branch.
    await failingTap;

    // The newer selection stands; the stale failure did NOT revert the tile
    // back to the original committed mode.
    expect(device.homey.settings.get(OPERATING_MODE_SETTING)).toBe('Sleep');
    expect(device.capabilityValues.get('mode_indicator')).not.toBe('Home');
    expect(
      device.errorCalls.some((c) => String(c[0]).includes('Failed to commit mode selection')),
    ).toBe(true);
  });

  it('ignores blank or non-string mode selections without touching settings', async () => {
    const device = await initDevice('Home');

    await tapMode(device, '   ');
    await tapMode(device, 42);

    expect(device.homey.settings.get(OPERATING_MODE_SETTING)).toBe('Home');
    expect(device.capabilityValues.has('mode_indicator')).toBe(false);
    expect(device.errorCalls).toHaveLength(0);
  });
});
