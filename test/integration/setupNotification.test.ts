import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifySetupOnce } from '../../lib/app/setupNotification';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES } from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

describe('setup notification delivery', () => {
  let settings: MockSettings;
  let capture: LoggerCapture;
  const notifications = { createNotification: vi.fn(async (_options: { excerpt: string }) => undefined) };
  const handledKey = 'setup_notification_handled';

  beforeEach(() => {
    settings = new MockSettings();
    // The notification runs after startup has written its migration markers.
    settings.set('boot_migrations_v2_unusable_stepped_config_repaired', true);
    notifications.createNotification.mockReset();
    capture = captureLogger();
  });

  afterEach(() => capture.restore());

  it('records successful delivery and stays quiet on subsequent starts', async () => {
    await notifySetupOnce(settings, notifications);
    await notifySetupOnce(settings, notifications);

    expect(notifications.createNotification).toHaveBeenCalledExactlyOnceWith({
      excerpt: expect.stringContaining('Homey > More > Apps > PELS > Settings'),
    });
    expect(settings.getKeys()).toContain(handledKey);
  });

  it.each([MANAGED_DEVICES, CONTROLLABLE_DEVICES])('skips an installation with saved %s', async (key) => {
    // Even explicitly choosing no devices counts as having found setup.
    settings.set(key, {});
    await notifySetupOnce(settings, notifications);
    settings.unset(key);
    await notifySetupOnce(settings, notifications);

    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(settings.getKeys()).toContain(handledKey);
  });

  it('does not resend when a listed delivery marker has an unreadable value', async () => {
    settings.set(handledKey, null);
    await notifySetupOnce(settings, notifications);

    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('reminds an installation whose store holds no keys at all', async () => {
    const empty = new MockSettings();
    await notifySetupOnce(empty, notifications);

    expect(notifications.createNotification).toHaveBeenCalledOnce();
    expect(empty.getKeys()).toEqual([handledKey]);
  });

  it('contains a settings read failure without marking delivery', async () => {
    const keyRead = vi.spyOn(settings, 'getKeys').mockImplementationOnce(() => { throw new Error('unavailable'); });
    await expect(notifySetupOnce(settings, notifications)).resolves.toBeUndefined();
    keyRead.mockRestore();

    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(settings.getKeys()).not.toContain(handledKey);
    expect(capture.findEvent('setup_notification_failed')).toBeDefined();
  });

  it('retries a rejected notification on a later startup', async () => {
    notifications.createNotification.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(notifySetupOnce(settings, notifications)).resolves.toBeUndefined();
    expect(settings.getKeys()).not.toContain(handledKey);

    await notifySetupOnce(settings, notifications);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    expect(settings.getKeys()).toContain(handledKey);
  });
});
