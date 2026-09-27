import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsetRetiredSettingsKeys } from '../../lib/store/retiredSettingsKeys';
import { mockHomeyInstance } from '../mocks/homey';

// Keys nothing reads or writes any more ride along on every settings write,
// which ships the whole settings object to Homey. They are unset at boot, only
// while the settings still list them, and a transient leaves them for the next
// boot rather than failing it.
describe('unsetRetiredSettingsKeys', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    vi.restoreAllMocks();
  });

  it('unsets every retired key present, and nothing else', () => {
    mockHomeyInstance.settings.set('target_devices_snapshot', [{ id: 'heater' }]);
    mockHomeyInstance.settings.set('device_plan_snapshot', { devices: [] });
    mockHomeyInstance.settings.set('device_action_log_by_device', { heater: [] });
    mockHomeyInstance.settings.set('app_heartbeat', 1777966855026);
    mockHomeyInstance.settings.set('learned_thermostat_deadband_c', { heater: 0.5 });
    mockHomeyInstance.settings.set('overview_redesign_enabled', true);
    mockHomeyInstance.settings.set('daily_budget_breakdown_enabled', true);
    mockHomeyInstance.settings.set('managed_devices', { heater: true });

    unsetRetiredSettingsKeys(mockHomeyInstance.settings);

    expect(mockHomeyInstance.settings.getKeys()).toEqual(['managed_devices']);
  });

  it('writes nothing once the retired keys are gone', () => {
    mockHomeyInstance.settings.set('managed_devices', { heater: true });
    const unset = vi.spyOn(mockHomeyInstance.settings, 'unset');

    unsetRetiredSettingsKeys(mockHomeyInstance.settings);

    expect(unset).not.toHaveBeenCalled();
  });

  it('touches nothing when the key list cannot be read', () => {
    mockHomeyInstance.settings.set('target_devices_snapshot', [{ id: 'heater' }]);
    vi.spyOn(mockHomeyInstance.settings, 'getKeys').mockImplementation(() => { throw new Error('settings unavailable'); });
    const unset = vi.spyOn(mockHomeyInstance.settings, 'unset');

    unsetRetiredSettingsKeys(mockHomeyInstance.settings);

    expect(unset).not.toHaveBeenCalled();
  });

  it('leaves the keys for the next boot when an unset is rejected', () => {
    mockHomeyInstance.settings.set('target_devices_snapshot', [{ id: 'heater' }]);
    vi.spyOn(mockHomeyInstance.settings, 'unset').mockImplementation(() => { throw new Error('settings unavailable'); });

    expect(() => unsetRetiredSettingsKeys(mockHomeyInstance.settings)).not.toThrow();
    expect(mockHomeyInstance.settings.getKeys()).toEqual(['target_devices_snapshot']);
  });
});
