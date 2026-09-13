import { describe, expect, it, vi } from 'vitest';
import {
  createMainMeterSelectionReader,
  readMainMeterSelection,
} from '../../lib/home/mainMeterSelection';

const KEY = 'homey_energy_meter_device_id';
/** A healthy key list that vouches for the store and lists the meter key. */
const listed = { getKeys: () => ['power_source', KEY] };
/** A healthy key list that proves the meter key was never written. */
const unlisted = { getKeys: () => ['power_source'] };

describe('Main meter settings boundary', () => {
  it('normalizes an explicit id', () => {
    expect(readMainMeterSelection({
      ...listed,
      get: () => '  meter-main  ',
    })).toEqual({ state: 'resolved', meterDeviceId: 'meter-main' });
  });

  it('proves "nothing chosen" only from a healthy list that omits the key', () => {
    // Homey answers an UNSET key with `null` (setup/AGENTS.md), so an unset
    // meter is `null` + unlisted. This is the one state a retry cannot change:
    // re-reading will not make an owner pick a meter, so it must never arm the
    // authority recovery loop.
    expect(readMainMeterSelection({ ...unlisted, get: () => null }).state).toBe('unconfigured');
    expect(readMainMeterSelection({ ...unlisted, get: () => undefined }).state).toBe('unconfigured');
  });

  it('keeps a listed-but-empty key unavailable — that is the observed miss shape', () => {
    // A key the list vouches for that still reads empty is a transient SDK
    // miss, or the legacy stored-null Automatic selection. The value cannot
    // tell them apart, and reading either as "nothing chosen" is what the
    // sole-meter adoption's grace window exists to avoid getting wrong.
    expect(readMainMeterSelection({ ...listed, get: () => undefined }).state).toBe('unavailable');
    expect(readMainMeterSelection({ ...listed, get: () => null }).state).toBe('unavailable');
  });

  it('cannot prove absence from an empty key list', () => {
    expect(readMainMeterSelection({ getKeys: () => [], get: () => undefined }).state).toBe('unavailable');
  });

  it('classifies anything else stored as unavailable — never as nothing chosen', () => {
    expect(readMainMeterSelection({ ...unlisted, get: () => 42 }).state).toBe('unavailable');
    expect(readMainMeterSelection({ ...listed, get: () => 'automatic' }).state).toBe('unavailable');
    expect(readMainMeterSelection({ ...listed, get: () => 'meter-main|areas:active' }).state).toBe('unavailable');
    expect(readMainMeterSelection({ ...listed, get: () => '   ' }).state).toBe('unavailable');
  });

  it('contains read failures as semantic unavailable authority', () => {
    const settings = {
      getKeys: () => [KEY],
      get: vi.fn(() => {
        throw new Error('settings unavailable');
      }),
    };
    expect(readMainMeterSelection(settings)).toEqual({ state: 'unavailable' });
  });

  it('contains a throwing key list too', () => {
    expect(readMainMeterSelection({
      get: () => undefined,
      getKeys: () => { throw new Error('key list unavailable'); },
    })).toEqual({ state: 'unavailable' });
  });

  describe('the graced reader settles what one read cannot', () => {
    // A LISTED key answering empty is either a transient miss or the legacy
    // stored-null Automatic selection. One read must not call it "nothing
    // chosen" — but never calling it that is how an upgraded install ends up
    // re-reading the setting on a backoff for the life of the app.
    const GRACE_MS = 90_000;

    it('holds a listed-empty key retryable through the grace, then settles it', () => {
      let now = 1_000_000;
      const reader = createMainMeterSelectionReader(
        { ...listed, get: () => null },
        () => now,
      );

      expect(reader.read().state).toBe('unavailable');
      now += GRACE_MS - 1;
      expect(reader.read().state).toBe('unavailable');
      now += 1;
      expect(reader.read().state).toBe('unconfigured');
    });

    it('restarts the grace when an explicit id surfaces mid-window', () => {
      let now = 1_000_000;
      let raw: unknown = null;
      const reader = createMainMeterSelectionReader(
        { ...listed, get: () => raw },
        () => now,
      );

      expect(reader.read().state).toBe('unavailable');
      now += GRACE_MS - 1;
      // The miss was transient after all: the id is there.
      raw = 'meter-main';
      expect(reader.read()).toEqual({ state: 'resolved', meterDeviceId: 'meter-main' });

      // It goes missing again — the window starts over rather than settling
      // instantly on the credit of the earlier one.
      raw = null;
      now += 1;
      expect(reader.read().state).toBe('unavailable');
      now += GRACE_MS - 1;
      expect(reader.read().state).toBe('unavailable');
      now += 1;
      expect(reader.read().state).toBe('unconfigured');
    });

    it('passes every unambiguous answer straight through', () => {
      let now = 1_000_000;
      const of = (settings: Parameters<typeof readMainMeterSelection>[0]) =>
        createMainMeterSelectionReader(settings, () => now).read();

      expect(of({ ...unlisted, get: () => null }).state).toBe('unconfigured');
      expect(of({ ...listed, get: () => 'meter-main' })).toEqual({ state: 'resolved', meterDeviceId: 'meter-main' });
      expect(of({ ...listed, get: () => 42 }).state).toBe('unavailable');
      expect(of({ getKeys: () => [], get: () => null }).state).toBe('unavailable');
      now += GRACE_MS * 10;
      // Time alone never turns an untrustworthy read into "nothing chosen".
      expect(of({ ...listed, get: () => 42 }).state).toBe('unavailable');
    });
  });
});
