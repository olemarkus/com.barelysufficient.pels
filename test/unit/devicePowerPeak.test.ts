import {
  PEAK_WINDOW_MS,
  adoptPersistedLearnedPeaks,
  classifyExpectedPowerOverridesSetting,
  classifyLearnedPeaksSetting,
  nextLearnedPeak,
  parseExpectedPowerOverrides,
  parseLearnedPeaks,
  pruneExpiredLearnedPeaks,
  resolveLearnedPeakKw,
} from '../../lib/device/devicePowerPeak';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const withinWindow = { kw: 2, observedAtMs: NOW - PEAK_WINDOW_MS + 1 };
const expired = { kw: 2, observedAtMs: NOW - PEAK_WINDOW_MS - 1 };

describe('resolveLearnedPeakKw', () => {
  it('answers the peak while its window is open', () => {
    expect(resolveLearnedPeakKw(withinWindow, NOW)).toBe(2);
  });

  it('answers null once the window has closed, so the ladder falls through', () => {
    // Absence, not a stale figure: the estimator's next rung (Homey Energy, then
    // the default) is a better answer than a peak nothing has matched in a month.
    expect(resolveLearnedPeakKw(expired, NOW)).toBeNull();
  });

  it('answers null for a missing or non-positive entry', () => {
    expect(resolveLearnedPeakKw(undefined, NOW)).toBeNull();
    expect(resolveLearnedPeakKw({ kw: 0, observedAtMs: NOW }, NOW)).toBeNull();
  });
});

describe('nextLearnedPeak', () => {
  it('anchors the first reading', () => {
    expect(nextLearnedPeak(undefined, 1.4, NOW)).toEqual({ kw: 1.4, observedAtMs: NOW });
  });

  it('raises the peak and re-anchors the window', () => {
    expect(nextLearnedPeak(withinWindow, 3, NOW)).toEqual({ kw: 3, observedAtMs: NOW });
  });

  it('re-anchors the window when the reading MATCHES the peak', () => {
    // A device that keeps reaching its peak must never expire for holding
    // steady — this is the arm that keeps a healthy device's estimate alive.
    expect(nextLearnedPeak(withinWindow, 2, NOW)).toEqual({ kw: 2, observedAtMs: NOW });
  });

  it('ignores a lower reading while the window is open', () => {
    // A duty cycle dipping is not evidence the device got smaller.
    expect(nextLearnedPeak(withinWindow, 0.5, NOW)).toBeNull();
  });

  it('lets a lower reading re-anchor once the window has closed', () => {
    // How an unrepeated spike ages out: a heat gun on the water heater's socket
    // once no longer pins the estimate at its draw for the life of the install.
    expect(nextLearnedPeak(expired, 0.5, NOW)).toEqual({ kw: 0.5, observedAtMs: NOW });
  });

  it('ignores a non-positive reading', () => {
    expect(nextLearnedPeak(undefined, 0, NOW)).toBeNull();
    expect(nextLearnedPeak(undefined, Number.NaN, NOW)).toBeNull();
  });
});

describe('pruneExpiredLearnedPeaks', () => {
  it('keeps live entries and drops closed ones', () => {
    expect(pruneExpiredLearnedPeaks({ live: withinWindow, dead: expired }, NOW))
      .toEqual({ live: withinWindow });
  });
});

describe('parseLearnedPeaks', () => {
  it('rejects entry-wise rather than all-or-nothing', () => {
    // One corrupt device must not discard the learning for every other device.
    expect(parseLearnedPeaks({
      good: { kw: 2, observedAtMs: NOW },
      negative: { kw: -1, observedAtMs: NOW },
      infinite: { kw: Number.POSITIVE_INFINITY, observedAtMs: NOW },
      noTimestamp: { kw: 2 },
      notAnObject: 2,
    })).toEqual({ good: { kw: 2, observedAtMs: NOW } });
  });

  it('answers an empty record for a missing or malformed setting', () => {
    expect(parseLearnedPeaks(undefined)).toEqual({});
    expect(parseLearnedPeaks(null)).toEqual({});
    expect(parseLearnedPeaks('nonsense')).toEqual({});
    expect(parseLearnedPeaks([{ kw: 2, observedAtMs: NOW }])).toEqual({});
  });

  it('rejects an entry keyed on the empty device id', () => {
    // No Homey device has one, so `''` is corruption: the entry could never be
    // looked up, and the prune could only ever drop it by expiry.
    expect(parseLearnedPeaks({ '': { kw: 2, observedAtMs: NOW } })).toEqual({});
  });
});

describe('parseExpectedPowerOverrides', () => {
  it('rejects entry-wise, keeping the owner-entered figures that are intact', () => {
    expect(parseExpectedPowerOverrides({
      good: { kw: 2.4, ts: NOW },
      zero: { kw: 0, ts: NOW },
      noTs: { kw: 2.4 },
    })).toEqual({ good: { kw: 2.4, ts: NOW } });
  });

  it('rejects an entry keyed on the empty device id', () => {
    expect(parseExpectedPowerOverrides({ '': { kw: 2.4, ts: NOW } })).toEqual({});
  });
});

describe('classifyLearnedPeaksSetting', () => {
  const absent = { keyPresent: false, keyListEmpty: false };

  it('resolves an EMPTY record when a healthy key list confirms the key was never written', () => {
    // The distinction the whole fix turns on: nothing learned yet is a real
    // answer, and folding it into `unavailable` would fence the write-back off
    // for the life of an install that has simply never observed a peak.
    expect(classifyLearnedPeaksSetting({ raw: null, ...absent }))
      .toEqual({ state: 'resolved', peaks: {} });
    expect(classifyLearnedPeaksSetting({ raw: undefined, ...absent }))
      .toEqual({ state: 'resolved', peaks: {} });
  });

  it('resolves a stored record, still rejecting entry-wise', () => {
    expect(classifyLearnedPeaksSetting({
      raw: { good: withinWindow, bad: { kw: 'x' } },
      ...absent,
    })).toEqual({ state: 'resolved', peaks: { good: withinWindow } });
  });

  it('is unavailable when the key list vouches for a key that reads empty', () => {
    expect(classifyLearnedPeaksSetting({
      raw: null,
      keyPresent: true,
      keyListEmpty: false,
    })).toEqual({ state: 'unavailable' });
  });

  it('is unavailable when the key list itself reads empty', () => {
    // An empty key list is the SDK saying nothing at all, not "this home has no
    // settings".
    expect(classifyLearnedPeaksSetting({
      raw: null,
      keyPresent: false,
      keyListEmpty: true,
    })).toEqual({ state: 'unavailable' });
  });

  it('is unavailable for a value that is not a record', () => {
    // Not absence, so answering "no peaks" would license overwriting it.
    expect(classifyLearnedPeaksSetting({ raw: 'nonsense', ...absent })).toEqual({ state: 'unavailable' });
    expect(classifyLearnedPeaksSetting({ raw: [withinWindow], ...absent })).toEqual({ state: 'unavailable' });
  });

  it('resolves a record stored with no entries at all, because that is a real clear', () => {
    // `{}` is what reaches disk when the last peak is dropped. It has to stay
    // observable, or a home in that state could never write back again.
    expect(classifyLearnedPeaksSetting({ raw: {}, ...absent }))
      .toEqual({ state: 'resolved', peaks: {} });
  });

  it('is unavailable for a record whose entries ALL fail validation', () => {
    // Keys were stored and not one survived: that is a value PELS did not
    // write, so it gets the same refusal as a string or an array — not the
    // "resolved, nothing here" that would license overwriting it.
    expect(classifyLearnedPeaksSetting({
      raw: { a: 'nonsense', b: { kw: -1, observedAtMs: NOW } },
      ...absent,
    })).toEqual({ state: 'unavailable' });
  });
});

describe('classifyExpectedPowerOverridesSetting', () => {
  const absent = { keyPresent: false, keyListEmpty: false };

  it('separates a resolved-empty record from an unreadable key', () => {
    expect(classifyExpectedPowerOverridesSetting({
      raw: null,
      keyPresent: false,
      keyListEmpty: false,
    })).toEqual({ state: 'resolved', overrides: {} });
    expect(classifyExpectedPowerOverridesSetting({
      raw: null,
      keyPresent: true,
      keyListEmpty: false,
    })).toEqual({ state: 'unavailable' });
  });

  it('resolves a record stored with no entries at all, because that is a real clear', () => {
    // The owner deleting their last manual figure persists exactly this.
    expect(classifyExpectedPowerOverridesSetting({ raw: {}, ...absent }))
      .toEqual({ state: 'resolved', overrides: {} });
  });

  it('resolves the survivors when only SOME entries fail, keeping rejection entry-wise', () => {
    expect(classifyExpectedPowerOverridesSetting({
      raw: { good: { kw: 2.4, ts: NOW }, bad: { kw: 'x', ts: NOW } },
      ...absent,
    })).toEqual({ state: 'resolved', overrides: { good: { kw: 2.4, ts: NOW } } });
  });

  it('is unavailable for a record whose entries ALL fail validation', () => {
    expect(classifyExpectedPowerOverridesSetting({
      raw: { a: { kw: 'x', ts: NOW }, b: 7 },
      ...absent,
    })).toEqual({ state: 'unavailable' });
  });
});

describe('adoptPersistedLearnedPeaks', () => {
  it('keeps the higher figure per device, from either side', () => {
    // The late read has to reconcile: the persisted side carries devices this
    // run has not seen draw power, the held side what it just measured.
    expect(adoptPersistedLearnedPeaks(
      { onlyStored: withinWindow, both: { kw: 3, observedAtMs: NOW - 1000 } },
      { onlyHeld: { kw: 1, observedAtMs: NOW }, both: { kw: 1, observedAtMs: NOW } },
    )).toEqual({
      onlyStored: withinWindow,
      onlyHeld: { kw: 1, observedAtMs: NOW },
      both: { kw: 3, observedAtMs: NOW - 1000 },
    });
  });

  it('lets a held reading re-anchor a persisted entry whose window has closed', () => {
    expect(adoptPersistedLearnedPeaks(
      { aged: expired },
      { aged: { kw: 0.5, observedAtMs: NOW } },
    )).toEqual({ aged: { kw: 0.5, observedAtMs: NOW } });
  });
});
