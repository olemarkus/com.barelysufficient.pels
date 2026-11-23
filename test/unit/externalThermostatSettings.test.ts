import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceExternalThermostatSettings } from '../../lib/device/externalThermostatSettings';
import { DEVICE_EXTERNAL_THERMOSTATS, MANAGED_DEVICES } from '../../lib/utils/settingsKeys';
import { readExternalThermostats } from '../../packages/shared-domain/src/settings/externalThermostats';

function settingsHarness() {
  const values = new Map<string, unknown>([[MANAGED_DEVICES, { load: true }]]);
  return {
    assignments: values,
    owner: new DeviceExternalThermostatSettings({
      get: (key) => values.get(key),
      getKeys: () => [...values.keys()],
      set: (key, value) => { values.set(key, value); },
    }),
  };
}

describe('external thermostat settings authority', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects shared sources, chains and a null association without a hold', () => {
    expect(readExternalThermostats({ a: { thermostatId: 'b' }, c: { thermostatId: 'b' } })).toBeUndefined();
    expect(readExternalThermostats({ a: { thermostatId: 'b' }, b: { thermostatId: 'c' } })).toBeUndefined();
    expect(readExternalThermostats({ a: { thermostatId: null } })).toBeUndefined();
  });

  it('fences the link between the settings write and snapshot refresh and reserves the source', () => {
    const { assignments, owner } = settingsHarness();
    owner.reload();
    expect(owner.allowsBinaryWrite('load', true)).toBe(true);
    assignments.set(DEVICE_EXTERNAL_THERMOSTATS, { load: { thermostatId: 'source' } });
    expect(owner.allowsBinaryWrite('load', true)).toBe(false);
    expect(owner.allowsBinaryWrite('source', true)).toBe(false);
    expect(owner.isTemperatureWriteCurrent('load')).toBe(false);
    owner.reload();
    expect(owner.isTemperatureWriteCurrent('load')).toBe(true);
    assignments.set(MANAGED_DEVICES, { load: true, source: true });
    expect(owner.isTemperatureWriteCurrent('load')).toBe(false);
  });

  it('keeps unrelated native controls available when a saved association is malformed', () => {
    const { assignments, owner } = settingsHarness();
    assignments.set(DEVICE_EXTERNAL_THERMOSTATS, { load: { thermostatId: 'source' } });
    owner.reload();
    assignments.set(DEVICE_EXTERNAL_THERMOSTATS, {
      load: { thermostatId: 'source' }, other: { thermostatId: 'new-source' }, broken: false,
    });
    expect(owner.allowsBinaryWrite('untouched', false)).toBe(true);
    expect(owner.isWriteCurrent('untouched')).toBe(true);
    expect(owner.isTemperatureWriteCurrent('load')).toBe(false);
    expect(owner.allowsBinaryWrite('source', true)).toBe(false);
    expect(owner.allowsBinaryWrite('new-source', false)).toBe(false);
  });

  it('clears an unlinked start guard only after a newer observed ON', () => {
    vi.useFakeTimers({ now: 2000 });
    const { assignments, owner } = settingsHarness();
    assignments.set(DEVICE_EXTERNAL_THERMOSTATS, { load: { thermostatId: null, waitForManualOn: true } });
    owner.reload();
    owner.acceptManualStart('load', 1999);
    expect(owner.allowsBinaryWrite('load', true)).toBe(false);
    owner.acceptManualStart('load', 2001);
    expect(owner.allowsBinaryWrite('load', true)).toBe(false);
    owner.reload();
    expect(owner.allowsBinaryWrite('load', true)).toBe(true);
  });
});
