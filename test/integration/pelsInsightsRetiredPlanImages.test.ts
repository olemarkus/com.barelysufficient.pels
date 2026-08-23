import { beforeAll, describe, expect, it, vi } from 'vitest';
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

// Plan images older app versions registered and this one no longer publishes.
// The driver's list is module-private (the file uses `export =`), so it is
// mirrored here. The mirror is the expectation, and it is pinned in both
// directions: a lost entry fails the first case, an added one fails the third.
const RETIRED_PLAN_IMAGE_IDS = ['plan_budget', 'plan_budget_tomorrow'];

let PelsInsightsDevice: new () => PelsInsightsDeviceUnderTest;
beforeAll(async () => {
  const { loadPelsInsightsDeviceClass } = await import('../helpers/pelsInsightsDeviceHarness.js');
  PelsInsightsDevice = await loadPelsInsightsDeviceClass();
});

// Each device owns its images manager, so a case's registry cannot reach the
// next one.
const createDeviceHolding = (registeredImageIds: readonly string[]): PelsInsightsDeviceUnderTest => {
  const device = new PelsInsightsDevice();
  for (const imageId of registeredImageIds) device.homey.images.registeredImageIds.add(imageId);
  return device;
};

// `onInit` is the driver's only caller of the retired-image cleanup, so the
// cleanup is driven the way production reaches it.
const initDevice = async (device: PelsInsightsDeviceUnderTest): Promise<ReturnType<typeof captureLogger>> => {
  const capture = captureLogger();
  try {
    await device.onInit();
  } finally {
    capture.restore();
  }
  return capture;
};

describe('pels_insights retired plan-image cleanup', () => {
  it('unregisters retired plan images that are still registered', async () => {
    const device = createDeviceHolding(RETIRED_PLAN_IMAGE_IDS);

    const capture = await initDevice(device);

    expect(device.homey.images.unregisteredImageIds).toEqual(RETIRED_PLAN_IMAGE_IDS);
    expect(device.homey.images.registeredImageIds.size).toBe(0);
    expect(capture.findEvents('pels_insights_remove_retired_plan_image_failed')).toHaveLength(0);
  });

  it('skips a retired plan image that is already gone, without logging a failure', async () => {
    // Only the first id is still registered; the second models an install that
    // already dropped it, where `getImage` throws the SDK's missing-image error.
    // That is the expected steady state, not a failure worth reporting.
    const device = createDeviceHolding([RETIRED_PLAN_IMAGE_IDS[0]]);

    const capture = await initDevice(device);

    expect(device.homey.images.unregisteredImageIds).toEqual([RETIRED_PLAN_IMAGE_IDS[0]]);
    expect(capture.findEvents('pels_insights_remove_retired_plan_image_failed')).toHaveLength(0);
  });

  it('reports an unregister failure that is not a missing image', async () => {
    // Without this case the one above could pass for the wrong reason — by the
    // driver swallowing every error rather than only the missing-image one.
    // `getImage` succeeds for every id here, so the registry is bypassed and
    // the assertion below also pins the driver's private list from the other
    // side: an id it gained would show up as a third failure event.
    const device = createDeviceHolding([]);
    device.homey.images.getImage = () => ({
      unregister: async (): Promise<void> => {
        throw new Error('image store unavailable');
      },
    });

    const capture = await initDevice(device);

    expect(device.homey.images.unregisteredImageIds).toEqual([]);
    expect(
      capture.findEvents('pels_insights_remove_retired_plan_image_failed').map((event) => event.imageId),
    ).toEqual(RETIRED_PLAN_IMAGE_IDS);
  });
});
