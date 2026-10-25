import { getLogger } from '../logging/logger';
import type { NotificationsPort, SettingsPort } from '../ports/homeyRuntime';
import { normalizeError } from '../utils/errorUtils';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES } from '../utils/settingsKeys';

// Set membership is enough: delivered, or unnecessary because device setup was
// already saved. A listed key with an unreadable value must never send again.
const SETUP_NOTIFICATION_HANDLED = 'setup_notification_handled';
const logger = getLogger('app/setup-notification');

/**
 * Run after startup migrations have populated settings. Remind owners who have
 * never saved device setup, including an older install left unconfigured.
 * Delivery failures leave the marker absent so the next startup can retry.
 */
export const notifySetupOnce = async (settings: SettingsPort, notifications: NotificationsPort): Promise<void> => {
  try {
    const keys = settings.getKeys();
    if (keys.length === 0) {
      // Startup has already written keys. An empty list here is an SDK read
      // failure, not evidence of a new installation.
      logger.warn({ event: 'setup_notification_deferred', reason: 'settings_unavailable' });
      return;
    }
    if (keys.includes(SETUP_NOTIFICATION_HANDLED)) return;
    const hasDeviceSetup = keys.includes(MANAGED_DEVICES) || keys.includes(CONTROLLABLE_DEVICES);
    if (!hasDeviceSetup) {
      await notifications.createNotification({
        excerpt: 'Open Homey > More > Apps > PELS > Settings to finish setup. '
          + 'Choose your devices and see what PELS is doing there.',
      });
    }
    settings.set(SETUP_NOTIFICATION_HANDLED, true);
  } catch (error) {
    // A welcome message must never prevent the app's services from starting.
    logger.warn({ event: 'setup_notification_failed', err: normalizeError(error) });
  }
};
