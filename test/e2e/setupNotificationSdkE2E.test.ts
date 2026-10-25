import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_DEVICES } from '../../lib/utils/settingsKeys';
import { mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';

describe('setup reminder at the Homey SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate',
      ],
    });
    resetMockHomey();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.useRealTimers();
  });

  it('shows the setup path on a fresh install and does not repeat after a restart', async () => {
    const first = createApp({ withoutPowerMeasurement: true });
    await first.onInit();

    expect(mockHomeyInstance.notifications._notifications).toEqual([{
      excerpt: 'Open Homey > More > Apps > PELS > Settings to finish setup. '
        + 'Choose your devices and see what PELS is doing there.',
    }]);

    await first.onUninit();
    const restarted = createApp({ withoutPowerMeasurement: true });
    await restarted.onInit();
    expect(mockHomeyInstance.notifications._notifications).toHaveLength(1);
  });

  it('keeps an existing configured installation quiet', async () => {
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { heater: true });
    const app = createApp({ withoutPowerMeasurement: true });
    await app.onInit();

    expect(mockHomeyInstance.notifications._notifications).toEqual([]);
  });
});
