import { describe, expect, it } from 'vitest';
import {
  MAX_ENTRIES_PER_KIND,
  TIMING_WINDOW_MS,
  keepMeterResponseEntries,
  summarizeMeterResponseTimings,
} from '../../lib/device/meterResponseTimings';
import type { MeterResponseEntry } from '../../lib/device/meterResponseTimingStore';

const NOW = 1_800_000_000_000;
const DEVICE = { id: 'heater', name: 'Hall heater' };

const timed = (responseMs: number, index: number, direction: 'on' | 'off' = 'on'): MeterResponseEntry => ({
  outcome: 'timed', atMs: NOW - (index + 1) * 3_600_000, direction, responseMs, acceptedAfterMs: 700,
  resolutionMs: 10_000, changeKw: 2,
});

describe('summarizeMeterResponseTimings', () => {
  it('trusts a direction once five times agree, within 15 % and one meter interval', () => {
    const entries = [12_000, 20_000, 18_000, 25_000, 15_000, 90_000].map((ms, index) => timed(ms, index));
    expect(summarizeMeterResponseTimings(DEVICE, entries, NOW)).toEqual([{
      deviceId: 'heater', deviceName: 'Hall heater', direction: 'on',
      samples: 6, medianResponseMs: 19_000, agreeing: 5, agreedResponseMs: 18_000, trusted: true,
      noChange: 0, medianResolutionMs: 10_000, medianAcceptedAfterMs: 700,
    }]);
  });

  it('does not trust four agreeing times, and counts no-change commands apart', () => {
    const entries: MeterResponseEntry[] = [
      ...[20_000, 21_000, 22_000, 23_000].map((ms, index) => timed(ms, index, 'off')),
      { outcome: 'no_change', atMs: NOW - 1_000, direction: 'off' },
    ];
    expect(summarizeMeterResponseTimings(DEVICE, entries, NOW)).toEqual([expect.objectContaining({
      direction: 'off', samples: 4, agreeing: 4, trusted: false, noChange: 1,
    })]);
  });

  it('leaves out entries older than the window', () => {
    const old: MeterResponseEntry = { ...timed(20_000, 0), atMs: NOW - TIMING_WINDOW_MS };
    expect(summarizeMeterResponseTimings(DEVICE, [old], NOW)).toEqual([]);
  });
});

describe('keepMeterResponseEntries', () => {
  it('keeps the newest entries of each direction and outcome, oldest first', () => {
    const kept = [
      ...Array.from({ length: MAX_ENTRIES_PER_KIND }, (_, index) => timed(20_000 + index, 40 - index)),
      ...Array.from({ length: 3 }, (_, index) => timed(30_000, 60 - index, 'off')),
    ];
    const next = keepMeterResponseEntries(kept, { ...timed(21_000, 0), atMs: NOW });
    expect(next).toHaveLength(MAX_ENTRIES_PER_KIND + 3);
    expect(next.filter((entry) => entry.direction === 'on').map((entry) => entry.atMs))
      .toEqual([...kept.slice(1, MAX_ENTRIES_PER_KIND).map((entry) => entry.atMs), NOW]);
  });
});
