import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type Homey from 'homey';
import {
  MODE_TARGET_OWNERSHIP_STATE,
  MODE_TARGET_OWNERSHIP_STATE_INITIALIZED,
} from '../../lib/utils/settingsKeys';
import { HomeModeOwnershipStore } from '../../setup/homeRuntime/homeModeOwnershipStore';
import { mockHomeyInstance } from '../mocks/homey';

const settings = (mockHomeyInstance as unknown as Homey.App['homey']).settings;

describe('HomeModeOwnershipStore', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('distinguishes fresh state from an unavailable empty key list', () => {
    const store = new HomeModeOwnershipStore(settings);

    expect(store.read()).toEqual({ state: 'suspect' });

    settings.set('operating_mode', 'Home');
    expect(store.read()).toEqual({ state: 'unwritten' });
  });

  it('round-trips a validated ownership ledger', () => {
    settings.set('operating_mode', 'Home');
    const store = new HomeModeOwnershipStore(settings);

    expect(store.write(new Map([['heater', 'h_area']]))).toBe(true);
    expect(store.read()).toEqual({
      state: 'present',
      owners: { heater: 'h_area' },
    });
    expect(settings.get(MODE_TARGET_OWNERSHIP_STATE_INITIALIZED)).toEqual({ heater: 'h_area' });
  });

  it('fails closed on malformed durable state', () => {
    settings.set(MODE_TARGET_OWNERSHIP_STATE_INITIALIZED, true);
    settings.set(MODE_TARGET_OWNERSHIP_STATE, { heater: 'invalid:home' });

    expect(new HomeModeOwnershipStore(settings).read()).toEqual({ state: 'suspect' });
  });

  it('recovers a marker-only interrupted first write', () => {
    settings.set(MODE_TARGET_OWNERSHIP_STATE_INITIALIZED, { heater: 'h_area' });

    expect(new HomeModeOwnershipStore(settings).read()).toEqual({
      state: 'present',
      owners: { heater: 'h_area' },
    });
    expect(settings.get(MODE_TARGET_OWNERSHIP_STATE)).toEqual({ heater: 'h_area' });
  });

  it.each([
    ['array', ['h_area']],
    ['class instance', new (class Ledger { heater = 'h_area'; })()],
    ['invalid owner', { heater: 'invalid:home' }],
    ['mixed validity', { heater: 'h_area', broken: 'invalid:home' }],
  ])('rejects a malformed %s ledger as a whole', (_label, value) => {
    settings.set(MODE_TARGET_OWNERSHIP_STATE_INITIALIZED, true);
    settings.set(MODE_TARGET_OWNERSHIP_STATE, value);

    expect(new HomeModeOwnershipStore(settings).read()).toEqual({ state: 'suspect' });
  });

  it('rejects dangerous device keys without salvaging other entries', () => {
    const value = { heater: 'h_area' };
    Object.defineProperty(value, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'main',
    });
    settings.set(MODE_TARGET_OWNERSHIP_STATE_INITIALIZED, true);
    settings.set(MODE_TARGET_OWNERSHIP_STATE, value);

    expect(new HomeModeOwnershipStore(settings).read()).toEqual({ state: 'suspect' });
  });

  it('classifies a thrown value read as suspect', () => {
    settings.set('operating_mode', 'Home');
    const originalGet = settings.get.bind(settings);
    vi.spyOn(settings, 'get').mockImplementation((key) => {
      if (key === MODE_TARGET_OWNERSHIP_STATE) throw new Error('settings unavailable');
      return originalGet(key);
    });

    expect(new HomeModeOwnershipStore(settings).read()).toEqual({ state: 'suspect' });
  });

  it('writes the marker first and fails closed if the value write fails', () => {
    settings.set('operating_mode', 'Home');
    const originalSet = settings.set.bind(settings);
    let failValueWrite = true;
    vi.spyOn(settings, 'set').mockImplementation((key, value) => {
      if (failValueWrite && key === MODE_TARGET_OWNERSHIP_STATE) throw new Error('write failed');
      originalSet(key, value);
    });
    const store = new HomeModeOwnershipStore(settings);

    expect(store.write(new Map([['heater', 'h_area']]))).toBe(false);
    expect(settings.get(MODE_TARGET_OWNERSHIP_STATE_INITIALIZED)).toEqual({ heater: 'h_area' });
    expect(settings.get(MODE_TARGET_OWNERSHIP_STATE)).toBeUndefined();
    failValueWrite = false;
    expect(store.read()).toEqual({
      state: 'present',
      owners: { heater: 'h_area' },
    });
    expect(settings.get(MODE_TARGET_OWNERSHIP_STATE)).toEqual({ heater: 'h_area' });
  });
});
