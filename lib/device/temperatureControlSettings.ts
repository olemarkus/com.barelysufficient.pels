import { TEMPERATURE_CONTROL_DISABLED_DEVICES, TEMPERATURE_CONTROL_MODES } from '../utils/settingsKeys';
import { isBooleanMap } from '../utils/appTypeGuards';
import {
  readTemperatureControlModes, temperatureControlDisabledDevices,
} from '../../packages/shared-domain/src/settings/temperatureControl';

/**
 * The two reads this classification needs, typed as the untrusted boundary they
 * are. `ManagerSettings` is assignable; so is a plain object double, so specs
 * pin the branches without an `as unknown as` cast that would let a
 * structurally wrong double throw into the `catch` and assert nothing.
 */
type TemperatureControlSettingsPort = {
  get(key: string): unknown;
  getKeys(): unknown;
};

/**
 * Resolve the persisted temperature-command policy at the settings boundary.
 * A malformed transient read retains the last-good in-memory policy.
 *
 * `ManagerSettings.get` answers an unset key with `null`, not `undefined`, so
 * absence must be classified on BOTH — gating only on `undefined` left the
 * key-list cross-check unreachable on a real Homey and pinned the policy at
 * `unavailable`, which fails closed over every temperature device (an install
 * that never touched the toggle lost all setpoint control). The cross-check
 * still separates a genuinely absent key from a transient miss: a listed key
 * that reads empty, an empty key list, a malformed value, or a throw all stay
 * `unavailable`. `undefined` stays in the disjunction for object doubles and
 * any runtime that answers that way; the SDK itself only produces `null`.
 */
export function readTemperatureControlDisabledDevicesSetting(params: {
  settings: TemperatureControlSettingsPort;
  current: {
    devices: Record<string, boolean>;
    state: 'unavailable' | 'resolved';
  };
}): {
  devices: Record<string, boolean>;
  state: 'unavailable' | 'resolved';
} {
  try {
    const raw = params.settings.get(TEMPERATURE_CONTROL_DISABLED_DEVICES);
    const modesRaw = params.settings.get(TEMPERATURE_CONTROL_MODES);
    const modes = readTemperatureControlModes(modesRaw);
    if (!modes && !isAbsent(params.settings, TEMPERATURE_CONTROL_MODES, modesRaw)) {
      return params.current;
    }
    if (isBooleanMap(raw)) return {
      devices: temperatureControlDisabledDevices(modes ?? {}, raw), state: 'resolved',
    };
    if (raw === undefined || raw === null) {
      const keys = params.settings.getKeys();
      if (
        Array.isArray(keys)
        && keys.length > 0
        && keys.every((key): key is string => typeof key === 'string')
        && !keys.includes(TEMPERATURE_CONTROL_DISABLED_DEVICES)
      ) {
        return { devices: temperatureControlDisabledDevices(modes ?? {}, {}), state: 'resolved' };
      }
    }
  } catch {
    // The semantic unavailable state below retains a previously resolved value.
  }
  return params.current.state === 'resolved'
    ? params.current
    : { devices: {}, state: 'unavailable' };
}

function isAbsent(settings: TemperatureControlSettingsPort, key: string, raw: unknown): boolean {
  if (raw !== null && raw !== undefined) return false;
  const keys = settings.getKeys();
  return Array.isArray(keys) && keys.length > 0
    && keys.every((entry) => typeof entry === 'string') && !keys.includes(key);
}
