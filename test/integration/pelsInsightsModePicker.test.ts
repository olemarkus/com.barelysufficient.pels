import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OPERATING_MODE_SETTING } from '../../lib/utils/settingsKeys';
import { captureLogger } from '../utils/loggerCapture';
import type { PelsInsightsDeviceUnderTest } from '../helpers/pelsInsightsDeviceHarness';

// The insights device extends `Homey.Device`, which the shared `homey` alias
// mock does not provide; `FakeInsightsDeviceBase` is that base. It is resolved
// by a dynamic import inside the factory because `vi.mock` is hoisted above the
// static imports.
vi.mock('homey', async () => {
  const { FakeInsightsDeviceBase: Device } = await import('../helpers/pelsInsightsDeviceHarness.js');
  return { default: { Device } };
});

type DeviceUnderTest = PelsInsightsDeviceUnderTest;

// Resolved in `beforeAll` rather than at top level because this file compiles
// as a CommonJS module (no top-level `await`), and because the driver's class
// body needs the hoisted `vi.mock('homey')` to have run.
let PelsInsightsDevice: new () => PelsInsightsDeviceUnderTest;
beforeAll(async () => {
  const { loadPelsInsightsDeviceClass } = await import('../helpers/pelsInsightsDeviceHarness.js');
  PelsInsightsDevice = await loadPelsInsightsDeviceClass();
});

const createDevice = (committedMode: string): DeviceUnderTest => {
  const device = new PelsInsightsDevice();
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
    const refreshSpy = vi.spyOn(device, 'refreshModeOptions');

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
    // The Promise executor runs synchronously, so `releaseFirst` is assigned by now;
    // assert it to defeat the control-flow narrowing to `null`.
    releaseFirst!();
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
    await device.onUninit();

    await flushImmediates();

    expect(device.setCapabilityOptionsCalls).toHaveLength(0);
  });
});
