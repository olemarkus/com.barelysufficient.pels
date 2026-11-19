import {
  PEAK_REANCHOR_INTERVAL_MS,
  PEAK_WINDOW_MS,
  adoptPersistedLearnedPeaks,
  classifyExpectedPowerOverridesSetting,
  nextLearnedPeak,
  parseExpectedPowerOverrides,
  parseLearnedPeaks,
  pruneExpiredLearnedPeaks,
  rankedPeakLevelKw,
  recordPeakReading,
  resolvePeakLevelKw,
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

  it('leaves a match alone until the anchor is a re-anchor interval old', () => {
    // A device at its rated power matches its peak on every reading; moving the
    // anchor each time rewrote the persisted record once a minute for nothing.
    const fresh = { kw: 2, observedAtMs: NOW - PEAK_REANCHOR_INTERVAL_MS + 1 };
    expect(nextLearnedPeak(fresh, 2, NOW)).toBeNull();
    const due = { kw: 2, observedAtMs: NOW - PEAK_REANCHOR_INTERVAL_MS };
    expect(nextLearnedPeak(due, 2, NOW)).toEqual({ kw: 2, observedAtMs: NOW });
  });

  it('raises the peak at once however fresh the anchor', () => {
    const fresh = { kw: 2, observedAtMs: NOW - 1000 };
    expect(nextLearnedPeak(fresh, 2.1, NOW)).toEqual({ kw: 2.1, observedAtMs: NOW });
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

describe('recordPeakReading and rankedPeakLevelKw', () => {
  const samplesAfter = (...kws: number[]) => kws.reduce<ReturnType<typeof recordPeakReading> | undefined>(
    (readings, kw) => recordPeakReading(readings, kw),
    undefined,
  )?.samplesKw ?? [];

  it('names no level until a device has three readings', () => {
    expect(rankedPeakLevelKw(samplesAfter())).toBeNull();
    expect(rankedPeakLevelKw(samplesAfter(1.4, 1.38))).toBeNull();
    expect(rankedPeakLevelKw(samplesAfter(1.4, 1.38, 1.41))).toBe(1.38);
  });

  it('keeps one corrupt reading out of the level', () => {
    // The reported case: a 0.4 kW floor thermostat sent one far higher frame.
    expect(rankedPeakLevelKw(samplesAfter(0.4, 0.41, 20, 0.4, 0.42))).toBe(0.41);
  });

  it('keeps two corrupt readings out of the level, alike or not', () => {
    expect(rankedPeakLevelKw(samplesAfter(0.4, 20, 0.41, 20, 0.4))).toBe(0.41);
    expect(rankedPeakLevelKw(samplesAfter(0.4, 20, 0.41, 19, 0.4))).toBe(0.41);
  });

  it('counts a reading once however often and under whatever date it is read', () => {
    // One report reaches PELS from the live event and again from each full read.
    expect(samplesAfter(0.4, 20, 20, 20, 0.4, 19, 19)).toEqual([0.4, 20, 0.4, 19]);
    expect(rankedPeakLevelKw(samplesAfter(0.4, 20, 20, 20, 0.4, 19, 19))).toBe(0.4);
  });

  it('takes a sample each time a device that reports one fixed draw runs', () => {
    // 0 W is no sample, but it sets the next 2 kW apart from the last.
    expect(samplesAfter(2, 0, 2, 0, 0, 2)).toEqual([2, 2, 2]);
    expect(samplesAfter(2, 0.003, 2)).toEqual([2, 2]);
  });

  it('follows a device that steps up once three readings reach the new level', () => {
    expect(rankedPeakLevelKw(samplesAfter(1.4, 1.41, 1.4, 7.2, 7.21))).toBe(1.41);
    expect(rankedPeakLevelKw(samplesAfter(1.4, 1.41, 1.4, 7.2, 7.21, 7.1))).toBe(7.1);
  });

  it('reads the level from the last ten readings only', () => {
    const samplesKw = samplesAfter(3, 3.1, 3.2, ...Array.from({ length: 10 }, (_, index) => 1 + index / 100));
    expect(samplesKw).toHaveLength(10);
    expect(rankedPeakLevelKw(samplesKw)).toBe(1.07);
  });
});

describe('resolvePeakLevelKw', () => {
  it('passes a reading at or below the standing peak straight through', () => {
    // A steady device re-read after a restart has one reading and must still
    // keep its window open by matching the peak.
    expect(resolvePeakLevelKw(2, [2], 2)).toBe(2);
    expect(resolvePeakLevelKw(2, [2, 0.5], 0.5)).toBe(0.5);
  });

  it('goes by rank above the standing peak and when there is none', () => {
    expect(resolvePeakLevelKw(0.41, [20], 20)).toBeNull();
    expect(resolvePeakLevelKw(null, [20], 20)).toBeNull();
    expect(resolvePeakLevelKw(0.41, [3, 3.01, 3.02], 3.02)).toBe(3);
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

  it('drops a stored peak no device can reach and keeps the rest', () => {
    expect(parseLearnedPeaks({
      ceiling: { kw: 25, observedAtMs: NOW },
      // A stored 88 kW peak held a 0.4 kW floor thermostat off: it goes at the
      // next start, with no new reading needed from the device.
      spike: { kw: 88, observedAtMs: NOW },
      corrupt: { kw: 524.288, observedAtMs: NOW },
    })).toEqual({ ceiling: { kw: 25, observedAtMs: NOW } });
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
    })).toEqual({ good: { kw: 2.4, ts: NOW, origin: 'settings' } });
  });

  it('keeps the writer a figure was stored with, and reads any other as typed on the device page', () => {
    expect(parseExpectedPowerOverrides({
      byFlow: { kw: 2.4, ts: NOW, origin: 'flow' },
      odd: { kw: 1, ts: NOW, origin: 'elsewhere' },
    })).toEqual({
      byFlow: { kw: 2.4, ts: NOW, origin: 'flow' },
      odd: { kw: 1, ts: NOW, origin: 'settings' },
    });
  });

  it('rejects an entry keyed on the empty device id', () => {
    expect(parseExpectedPowerOverrides({ '': { kw: 2.4, ts: NOW } })).toEqual({});
  });
});

describe('classifyExpectedPowerOverridesSetting', () => {
  const absent = { keyPresent: false };

  it('separates a resolved-empty record from an unreadable key', () => {
    expect(classifyExpectedPowerOverridesSetting({
      raw: null,
      keyPresent: false,
    })).toEqual({ state: 'resolved', overrides: {} });
    expect(classifyExpectedPowerOverridesSetting({
      raw: null,
      keyPresent: true,
    })).toEqual({ state: 'unavailable' });
  });

  it('is unavailable for a value that is not a record', () => {
    // Not absence, so answering "no figures" would license overwriting it.
    expect(classifyExpectedPowerOverridesSetting({ raw: 'nonsense', ...absent })).toEqual({ state: 'unavailable' });
    expect(classifyExpectedPowerOverridesSetting({ raw: [{ kw: 2.4, ts: NOW }], ...absent }))
      .toEqual({ state: 'unavailable' });
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
    })).toEqual({ state: 'resolved', overrides: { good: { kw: 2.4, ts: NOW, origin: 'settings' } } });
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

  it('keeps the persisted anchor when a held match is older or less than a day newer', () => {
    // Each side matched the same figure; the merge never moves an anchor backward,
    // and moves it forward only as far as the ingest path itself would have.
    const persisted = { kw: 2, observedAtMs: NOW - 1000 };
    expect(adoptPersistedLearnedPeaks(
      { older: persisted, newer: persisted },
      { older: { kw: 2, observedAtMs: NOW - 5000 }, newer: { kw: 2, observedAtMs: NOW } },
    )).toEqual({ older: persisted, newer: persisted });
  });

  it('lets a held reading re-anchor a persisted entry whose window has closed', () => {
    expect(adoptPersistedLearnedPeaks(
      { aged: expired },
      { aged: { kw: 0.5, observedAtMs: NOW } },
    )).toEqual({ aged: { kw: 0.5, observedAtMs: NOW } });
  });
});
