import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATING_MODE_SETTING } from '../lib/utils/settingsKeys';
import { captureLogger } from './utils/loggerCapture';

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

  public setCapabilityOptionsCalls: unknown[][] = [];

  async setCapabilityOptions(...args: unknown[]): Promise<void> {
    this.setCapabilityOptionsCalls.push(args);
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

// Drain the macrotask queue so any pending `setImmediate`-coalesced refresh runs.
const flushImmediates = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  // A second tick lets the async refresh body settle before assertions.
  await new Promise<void>((resolve) => setImmediate(resolve));
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

    const capture = captureLogger();
    try {
      device.homey.settings.failOnSet = true;
      await tapMode(device, 'Away');

      // Settings stayed on the previously-committed mode (write was rejected).
      expect(device.homey.settings.get(OPERATING_MODE_SETTING)).toBe('Home');
      // The tile was reverted to the runtime's true mode.
      expect(device.capabilityValues.get('mode_indicator')).toBe('Home');
      // The failure was surfaced as a structured error event.
      expect(capture.findEvents('pels_insights_commit_mode_selection_failed')).toHaveLength(1);
    } finally {
      capture.restore();
    }
  });

  it('does not revert the tile when a newer selection supersedes a failed write', async () => {
    const device = await initDevice('Home');

    const capture = captureLogger();
    try {
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
        capture.findEvents('pels_insights_commit_mode_selection_failed').length,
      ).toBeGreaterThan(0);
    } finally {
      capture.restore();
    }
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

describe('pels_insights mode-options refresh coalescing', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const initDevice = async (committedMode: string): Promise<DeviceUnderTest> => {
    const device = createDevice(committedMode);
    await device.onInit();
    // Drop the onInit baseline so assertions only see post-init SDK calls.
    device.setCapabilityOptionsCalls.length = 0;
    return device;
  };

  // Mutate a mode-source setting to add a new mode, producing a new option set.
  const reorderPriorities = (device: DeviceUnderTest, modes: string[]): void => {
    const priorities = Object.fromEntries(
      modes.map((mode, index) => [mode, { [`device-${index}`]: index + 1 }]),
    );
    device.homey.settings.set('capacity_priorities', priorities);
  };

  it('coalesces a burst of mode-source writes into one setCapabilityOptions call', async () => {
    const device = await initDevice('Home');
    const refreshSpy = vi.spyOn(device as unknown as { refreshModeOptions: () => Promise<void> }, 'refreshModeOptions');

    // Simulate a 10-device priority reorder: many writes in the same tick.
    for (let index = 0; index < 10; index += 1) {
      device.homey.settings.set('capacity_priorities', {
        Home: { 'device-a': index + 1 },
        Away: { 'device-b': index + 1 },
      });
    }

    expect(device.setCapabilityOptionsCalls).toHaveLength(0);
    expect(refreshSpy).not.toHaveBeenCalled();

    await flushImmediates();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(device.setCapabilityOptionsCalls).toHaveLength(1);
  });

  it('skips the SDK roundtrip when the option set is unchanged', async () => {
    const device = await initDevice('Home');

    // Two separate bursts that resolve to the SAME mode set.
    reorderPriorities(device, ['Home', 'Away']);
    await flushImmediates();
    expect(device.setCapabilityOptionsCalls).toHaveLength(1);

    reorderPriorities(device, ['Home', 'Away']);
    await flushImmediates();

    // Options unchanged → no second roundtrip.
    expect(device.setCapabilityOptionsCalls).toHaveLength(1);
  });

  it('applies the final state after a burst (does not drop the last write)', async () => {
    const device = await initDevice('Home');

    reorderPriorities(device, ['Home', 'Away']);
    reorderPriorities(device, ['Home', 'Away', 'Sleep']);
    await flushImmediates();

    expect(device.setCapabilityOptionsCalls).toHaveLength(1);
    const [, options] = device.setCapabilityOptionsCalls[0] as [string, { values: { id: string }[] }];
    const ids = options.values.map((value) => value.id);
    expect(ids).toContain('Sleep');
  });

  it('serializes a write that lands while a refresh is in flight (last state wins)', async () => {
    const device = await initDevice('Home');

    // Gate the first setCapabilityOptions so a second write can land while the
    // first refresh is still awaiting the SDK.
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const realApply = device.setCapabilityOptions.bind(device);
    let applyCalls = 0;
    vi.spyOn(device, 'setCapabilityOptions').mockImplementation(async (...args: unknown[]) => {
      applyCalls += 1;
      if (applyCalls === 1) await firstGate;
      return realApply(...(args as [string, unknown]));
    });

    // Burst A arms the coalesced flush.
    reorderPriorities(device, ['Home', 'Away']);
    // One tick: the device's setImmediate fires and the first refresh blocks on the gate.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A newer write lands mid-flight — it must not race a second overlapping refresh.
    reorderPriorities(device, ['Home', 'Away', 'Sleep']);

    // Release the in-flight write; the in-flight loop re-runs for the pending state.
    releaseFirst?.();
    await flushImmediates();

    // Both writes applied, serialized; the LAST applied option set is the newest.
    expect(device.setCapabilityOptionsCalls).toHaveLength(2);
    const [, lastOptions] = device.setCapabilityOptionsCalls.at(-1) as [
      string,
      { values: { id: string }[] },
    ];
    expect(lastOptions.values.map((value) => value.id)).toContain('Sleep');
  });

  it('does not call setCapabilityOptions after the device is uninited', async () => {
    const device = await initDevice('Home');

    reorderPriorities(device, ['Home', 'Away']);
    await (device as unknown as { onUninit: () => Promise<void> }).onUninit();

    await flushImmediates();

    expect(device.setCapabilityOptionsCalls).toHaveLength(0);
  });
});
