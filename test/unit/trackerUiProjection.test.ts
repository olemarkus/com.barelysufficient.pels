import { describe, expect, it } from 'vitest';
import { projectPowerTrackerForUi, SETTINGS_UI_RECENT_HOURS } from '../../lib/power/trackerUiProjection';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 9, 7, 12, 30);
const hourKey = (hoursAgo: number): string => new Date(NOW_MS - hoursAgo * HOUR_MS - (30 * 60 * 1000)).toISOString();

const hourly = (hoursAgoList: number[]): Record<string, number> => Object.fromEntries(
  hoursAgoList.map((hoursAgo) => [hourKey(hoursAgo), hoursAgo + 0.5]),
);

const OLD = SETTINGS_UI_RECENT_HOURS + 10;
const RECENT = SETTINGS_UI_RECENT_HOURS - 10;

const tracker: PowerTrackerState = {
  meterIdentity: { powerSource: 'homey_energy', meterDeviceId: 'meter' },
  lastPowerW: 1200,
  lastControlledPowerW: 300,
  lastGenerationW: 50,
  lastTimestamp: NOW_MS - 1000,
  buckets: hourly([OLD, RECENT, 0]),
  hourlySampleCounts: hourly([OLD, RECENT, 0]),
  hourlyBudgets: hourly([OLD, 0]),
  dailyBudgetCaps: { '2026-10-07': 9 },
  dailyTotals: { '2026-09-01': 12, '2026-10-07': 4 },
  hourlyAverages: { weekday_10: { sum: 3, count: 2 } },
  controlledBuckets: hourly([OLD, RECENT, 0]),
  uncontrolledBuckets: hourly([OLD, RECENT, 0]),
  exemptBuckets: hourly([OLD, 0]),
  controlledDailyTotals: { '2026-10-07': 1 },
  controlledHourlyAverages: { weekday_10: { sum: 1, count: 1 } },
  deviceBuckets: {
    heater: hourly([OLD, RECENT, 0]),
    charger: hourly([OLD]),
  },
  lastDevicePowerWById: { heater: 800 },
  generationBuckets: hourly([OLD, 0]),
  exportBuckets: hourly([OLD]),
  generationDailyTotals: { '2026-10-07': 2 },
  exportDailyTotals: { '2026-10-07': 0.5 },
  unreliablePeriods: [{ start: NOW_MS - 5 * HOUR_MS, end: NOW_MS - 4 * HOUR_MS }],
  objectiveProfiles: {
    heater: {
      updatedAtMs: NOW_MS,
      lastSample: { observedAtMs: NOW_MS, value: 1 },
      kwhPerUnit: { sampleCount: 4, mean: 0.8, m2: 0.1, min: 0.6, max: 1, confidence: 'medium', lastUpdatedMs: NOW_MS },
      acceptedSamples: 4,
      rejectedSamples: 1,
      samples: [{ observedAtMs: NOW_MS, inputValue: 1, kwhPerUnit: 0.8 }],
    },
    charger: { updatedAtMs: NOW_MS, lastSample: { observedAtMs: NOW_MS, value: 1 }, acceptedSamples: 0, rejectedSamples: 0 },
  },
};

describe('projectPowerTrackerForUi', () => {
  const projected = projectPowerTrackerForUi(tracker, NOW_MS);

  it('passes the families the page reads whole, by reference, and drops the rest', () => {
    expect(projected.buckets).toBe(tracker.buckets);
    expect(projected.hourlySampleCounts).toBe(tracker.hourlySampleCounts);
    expect(projected.dailyTotals).toBe(tracker.dailyTotals);
    expect(projected.hourlyAverages).toBe(tracker.hourlyAverages);
    expect(projected.generationBuckets).toBe(tracker.generationBuckets);
    expect(projected.exportBuckets).toBe(tracker.exportBuckets);
    expect(projected.exportDailyTotals).toBe(tracker.exportDailyTotals);
    expect(projected.unreliablePeriods).toBe(tracker.unreliablePeriods);
    expect(projected).toMatchObject({ lastPowerW: 1200, lastGenerationW: 50, lastTimestamp: NOW_MS - 1000 });
    expect(Object.keys(projected).sort()).toEqual([
      'buckets', 'controlledBuckets', 'dailyTotals', 'deviceBuckets', 'exportBuckets', 'exportDailyTotals',
      'generationBuckets', 'hourlyAverages', 'hourlySampleCounts', 'lastGenerationW', 'lastPowerW',
      'lastTimestamp', 'objectiveProfiles', 'uncontrolledBuckets', 'unreliablePeriods',
    ]);
  });

  it('cuts the split and per-device hourly families to the recent window', () => {
    expect(Object.keys(projected.controlledBuckets ?? {})).toEqual([hourKey(RECENT), hourKey(0)]);
    expect(Object.keys(projected.uncontrolledBuckets ?? {})).toEqual([hourKey(RECENT), hourKey(0)]);
    expect(projected.deviceBuckets).toEqual({
      heater: { [hourKey(RECENT)]: RECENT + 0.5, [hourKey(0)]: 0.5 },
      charger: {},
    });
  });

  it('keeps only the energy-per-unit mean and confidence of a learned profile', () => {
    expect(projected.objectiveProfiles).toEqual({
      heater: { kwhPerUnit: { mean: 0.8, confidence: 'medium' } },
      charger: {},
    });
  });

  it('leaves absent families absent', () => {
    const empty = projectPowerTrackerForUi({}, NOW_MS);
    expect(JSON.stringify(empty)).toBe('{}');
  });
});
