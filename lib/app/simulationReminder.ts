import { getLogger } from '../logging/logger';
import type { NotificationsPort, SettingsPort } from '../ports/homeyRuntime';
import { normalizeError } from '../utils/errorUtils';
import { MAIN_HOME_ID, type HomeId } from '../utils/settingsKeys';

// Both keys belong to this module. The first holds when a managed device was
// first seen under Simulation mode; the second records that the reminder is
// settled for this install: sent, or unnecessary because the owner started
// managing.
const SIMULATION_REMINDER_SINCE_MS = 'simulation_reminder_since_ms';
const SIMULATION_REMINDER_HANDLED = 'simulation_reminder_handled';

export const SIMULATION_REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;
export const SIMULATION_REMINDER_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const SIMULATION_REMINDER_FIRST_CHECK_DELAY_MS = 5 * 60 * 1000;

const logger = getLogger('app/simulation-reminder');

/** What the reminder needs to know about the home, read fresh at each check. */
export type SimulationReminderHome = {
  isSimulationOn(): boolean;
  hasManagedDevice(): boolean;
};

/**
 * Whether the owner manages a device in the Main home. Simulation mode is the
 * Main home's switch, so a device in a meter area, which may be live, does not
 * start the reminder's day.
 */
export const hasManagedMainHomeDevice = (
  managed: Readonly<Record<string, boolean>>,
  getHomeIdForDevice: (deviceId: string) => HomeId,
): boolean => Object.entries(managed).some(([deviceId, isManaged]) => (
  isManaged === true && getHomeIdForDevice(deviceId) === MAIN_HOME_ID
));

const readSinceMs = (settings: SettingsPort): number | null => {
  const stored: unknown = settings.get(SIMULATION_REMINDER_SINCE_MS);
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : null;
};

/**
 * Remind an owner once that PELS is still only simulating. An owner who chose
 * devices and never pressed Start managing sees the banner only while the
 * settings page is open, so a day later Homey's timeline says it too. The clock
 * starts when a managed device is first seen under Simulation mode; an owner who
 * starts managing settles it without a message. A failed delivery leaves it
 * unsettled so the next check tries again.
 */
export const checkSimulationReminder = async (
  settings: SettingsPort,
  notifications: NotificationsPort,
  home: SimulationReminderHome,
  nowMs: number,
): Promise<void> => {
  try {
    if (settings.getKeys().includes(SIMULATION_REMINDER_HANDLED)) return;
    if (!home.isSimulationOn()) {
      settings.set(SIMULATION_REMINDER_HANDLED, true);
      return;
    }
    if (!home.hasManagedDevice()) return;
    const sinceMs = readSinceMs(settings);
    // A clock set ahead of now (a corrected system time) restarts the day.
    if (sinceMs === null || sinceMs > nowMs) {
      settings.set(SIMULATION_REMINDER_SINCE_MS, nowMs);
      return;
    }
    if (nowMs - sinceMs < SIMULATION_REMINDER_AFTER_MS) return;
    await notifications.createNotification({
      excerpt: 'PELS is still in Simulation mode, so your devices stay as they are. '
        + 'Open Homey > More > Apps > PELS > Settings and choose Start managing to let PELS control them.',
    });
    settings.set(SIMULATION_REMINDER_HANDLED, true);
    logger.info({ event: 'simulation_reminder_sent', simulatedForMs: nowMs - sinceMs });
  } catch (error) {
    logger.warn({ event: 'simulation_reminder_failed', err: normalizeError(error) });
  }
};
