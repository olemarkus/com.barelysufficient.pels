import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSimulationReminder, hasManagedMainHomeDevice, SIMULATION_REMINDER_AFTER_MS,
} from '../../lib/app/simulationReminder';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

describe('simulation reminder', () => {
  let settings: MockSettings;
  let capture: LoggerCapture;
  const notifications = { createNotification: vi.fn(async (_options: { excerpt: string }) => undefined) };
  const handledKey = 'simulation_reminder_handled';
  const home = { simulation: true, managed: true };
  const reads = { isSimulationOn: () => home.simulation, hasManagedDevice: () => home.managed };
  const START_MS = 1_800_000_000_000;
  const check = (nowMs: number) => checkSimulationReminder(settings, notifications, reads, nowMs);

  beforeEach(() => {
    settings = new MockSettings();
    home.simulation = true;
    home.managed = true;
    notifications.createNotification.mockReset();
    capture = captureLogger();
  });

  afterEach(() => capture.restore());

  it('reminds once after a day in simulation with a managed device', async () => {
    await check(START_MS);
    await check(START_MS + SIMULATION_REMINDER_AFTER_MS - 1);
    expect(notifications.createNotification).not.toHaveBeenCalled();

    await check(START_MS + SIMULATION_REMINDER_AFTER_MS);
    await check(START_MS + 2 * SIMULATION_REMINDER_AFTER_MS);

    expect(notifications.createNotification).toHaveBeenCalledExactlyOnceWith({
      excerpt: expect.stringContaining('Start managing'),
    });
    expect(capture.findEvent('simulation_reminder_sent')).toBeDefined();
  });

  it('starts the day only when a device is managed', async () => {
    home.managed = false;
    await check(START_MS);
    await check(START_MS + SIMULATION_REMINDER_AFTER_MS);
    home.managed = true;
    await check(START_MS + SIMULATION_REMINDER_AFTER_MS + 1);
    await check(START_MS + 2 * SIMULATION_REMINDER_AFTER_MS);
    expect(notifications.createNotification).not.toHaveBeenCalled();

    await check(START_MS + 2 * SIMULATION_REMINDER_AFTER_MS + 1);
    expect(notifications.createNotification).toHaveBeenCalledOnce();
  });

  it('restarts the day when a device is managed again after a time with none', async () => {
    await check(START_MS);
    expect(settings.get('simulation_reminder_since_ms')).toBe(START_MS);
    home.managed = false;
    await check(START_MS + 1);
    expect(settings.getKeys()).not.toContain('simulation_reminder_since_ms');

    // Weeks later: the next check starts a new day instead of reminding at once.
    const laterMs = START_MS + 30 * SIMULATION_REMINDER_AFTER_MS;
    home.managed = true;
    await check(laterMs);
    await check(laterMs + SIMULATION_REMINDER_AFTER_MS - 1);
    expect(notifications.createNotification).not.toHaveBeenCalled();

    await check(laterMs + SIMULATION_REMINDER_AFTER_MS);
    expect(notifications.createNotification).toHaveBeenCalledExactlyOnceWith({
      excerpt: 'PELS is still in Simulation mode, so your devices stay as they are. '
        + 'Open Homey > More > Apps > PELS > Settings, open the setup review from the banner at the top, '
        + 'and choose Start managing to let PELS control them.',
    });
  });

  it('never reminds an owner who started managing, also after simulation is turned on again', async () => {
    await check(START_MS);
    home.simulation = false;
    await check(START_MS + 1);
    home.simulation = true;
    await check(START_MS + 3 * SIMULATION_REMINDER_AFTER_MS);

    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(settings.getKeys()).toContain(handledKey);
  });

  it('restarts the day when the stored start is unreadable or ahead of the clock', async () => {
    settings.set('simulation_reminder_since_ms', 'yesterday');
    await check(START_MS);
    settings.set('simulation_reminder_since_ms', START_MS + 10 * SIMULATION_REMINDER_AFTER_MS);
    await check(START_MS + SIMULATION_REMINDER_AFTER_MS);
    expect(notifications.createNotification).not.toHaveBeenCalled();

    await check(START_MS + 2 * SIMULATION_REMINDER_AFTER_MS);
    expect(notifications.createNotification).toHaveBeenCalledOnce();
  });

  it('retries a rejected notification at the next check', async () => {
    notifications.createNotification.mockRejectedValueOnce(new Error('notification unavailable'));
    await check(START_MS);
    await expect(check(START_MS + SIMULATION_REMINDER_AFTER_MS)).resolves.toBeUndefined();
    expect(settings.getKeys()).not.toContain(handledKey);
    expect(capture.findEvent('simulation_reminder_failed')).toBeDefined();

    await check(START_MS + SIMULATION_REMINDER_AFTER_MS + 1);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    expect(settings.getKeys()).toContain(handledKey);
  });

  it('counts only managed devices in the Main home', () => {
    const homeOf = (deviceId: string) => (deviceId === 'garage-charger' ? 'garage' : MAIN_HOME_ID);
    expect(hasManagedMainHomeDevice({ 'garage-charger': true, heater: false }, homeOf)).toBe(false);
    expect(hasManagedMainHomeDevice({ 'garage-charger': true, heater: true }, homeOf)).toBe(true);
    expect(hasManagedMainHomeDevice({}, homeOf)).toBe(false);
  });
});
