import type { PowerTrackerState } from '../../lib/power/trackerTypes';

export const buildHourlyInsightsHistory = () => {
  const nowMs = Date.parse('2026-11-18T16:30:00.000Z');
  const current = Date.parse('2026-11-18T16:00:00.000Z');
  const ownerUri = 'homey:device:meter-a';
  const powerId = `${ownerUri}:energy_power`;
  const exportId = `${ownerUri}:meter_power.exported`;
  const wattsAt = (hour: number): number => 1500 + ((hour / 3_600_000) % 7) * 600;
  const values = Array.from({ length: 168 }, (_, i) => {
    const hour = current - (168 - i) * 3_600_000;
    return { t: new Date(hour).toISOString(), v: wattsAt(hour) };
  });
  const buckets = Object.fromEntries(Array.from({ length: 36 }, (_, i) => {
    const hour = current - (35 - i) * 3_600_000;
    return [new Date(hour).toISOString(), wattsAt(hour) / 1000];
  }));
  const tracker: PowerTrackerState = {
    buckets, lastTimestamp: nowMs, lastPowerW: wattsAt(current),
    controlledBuckets: { [new Date(current).toISOString()]: 0.2 },
  };
  return {
    nowMs, tracker,
    metadata: {
      power: { id: powerId, uri: `homey:log:${powerId}`, type: 'number', units: 'W' },
      exported: { id: exportId, uri: `homey:log:${exportId}`, type: 'number', units: 'kWh' },
    },
    power: { uri: ownerUri, id: powerId, step: 3_600_000, values },
    exported: { uri: ownerUri, id: exportId, step: 3_600_000, values: values.map(({ t }) => ({ t, v: 0 })) },
  };
};
