import { describe, expect, it } from 'vitest';
import { readSettingsUiBootstrapSettings } from '../../lib/app/settingsUiBootstrapSettings';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import { DEVICE_POWER_CONTROL_MODES, EV_CHARGING_SESSION_SMOOTHING } from '../../lib/utils/settingsKeys';
import { partialDouble } from '../helpers/partialDouble';

const read = (value: unknown, keys: unknown) => readSettingsUiBootstrapSettings(partialDouble<SettingsPort>({
  get: (key) => key === DEVICE_POWER_CONTROL_MODES ? value : null,
  getKeys: () => keys as string[],
}));

describe('bootstrap power-control mode authority', () => {
  it('serves a resolved mode map', () => {
    const modes = { charger: 'manual' };
    expect(read(modes, [DEVICE_POWER_CONTROL_MODES])[DEVICE_POWER_CONTROL_MODES]).toEqual(modes);
  });

  it('serves an empty map only when key absence is confirmed', () => {
    expect(read(null, [])[DEVICE_POWER_CONTROL_MODES]).toEqual({});
  });

  it.each([
    [null, [DEVICE_POWER_CONTROL_MODES]],
    [undefined, null],
    [{ charger: 'invalid' }, [DEVICE_POWER_CONTROL_MODES]],
  ])('omits an unresolved map %j with key list %j', (value, keys) => {
    expect(Object.hasOwn(read(value, keys), DEVICE_POWER_CONTROL_MODES)).toBe(false);
  });
});

describe('bootstrap EV charging continuity authority', () => {
  const readSmoothing = (raw: unknown, keys: string[]) => readSettingsUiBootstrapSettings(partialDouble<SettingsPort>({
    get: (key) => key === EV_CHARGING_SESSION_SMOOTHING ? raw : null,
    getKeys: () => keys,
  }));

  it('proves absence without replacing an unavailable existing map', () => {
    expect(readSmoothing(null, [])[EV_CHARGING_SESSION_SMOOTHING]).toEqual({});
    expect(readSmoothing(null, [EV_CHARGING_SESSION_SMOOTHING])[EV_CHARGING_SESSION_SMOOTHING]).toBeNull();
  });

  it('preserves raw complete-map evidence so the browser can reject malformed siblings', () => {
    const raw = { hidden: true, malformed: 'true' };
    expect(readSmoothing(raw, [EV_CHARGING_SESSION_SMOOTHING])[EV_CHARGING_SESSION_SMOOTHING]).toEqual(raw);
  });
});
