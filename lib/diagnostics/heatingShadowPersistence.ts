import type { HeatingShadowState } from '../../packages/contracts/src/heatingShadow';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import {
  isHeatingShadowState, isHeatingShadowInterval, isHeatingShadowReading,
  isHeatingShadowWindow, isHeatingShadowOutdoorPoint,
} from './heatingShadowState';

export const HEATING_SHADOW_ROW_PREFIX = 'heatingShadow/';
const rowKey = (...parts: (string | number)[]): string => (
  HEATING_SHADOW_ROW_PREFIX + parts.map((part) => encodeURIComponent(String(part))).join('/')
);

/** Persist immutable observations separately; each ingest changes only small open-window rows. */
export function heatingShadowRows(state: HeatingShadowState): Record<string, unknown> {
  const rows = state.days.flatMap((day) => [
    ...day.outdoor.map((point) => [rowKey(day.dateKey, 'outdoor', point.atMs), point] as const),
    ...Object.entries(day.devices).flatMap(([id, device]) => [
      ...device.intervals.map((interval) => [
        rowKey(day.dateKey, 'device', id, 'interval', interval.startMs), interval,
      ] as const),
      ...device.changes.map((change) => [rowKey(day.dateKey, 'device', id, 'change', change.atMs), change] as const),
      ...(device.window ? [[rowKey(day.dateKey, 'device', id, 'window'), device.window] as const] : []),
    ]),
  ]);
  const header: HeatingShadowState = { ...state, days: state.days.map((day) => ({ ...day, outdoor: [],
    devices: Object.fromEntries(Object.entries(day.devices).map(([id, device]) => {
      const { window: _window, ...closed } = device;
      return [id, { ...closed, intervals: [], changes: [] }];
    })),
  })) };
  return Object.fromEntries([['heatingShadow', { layoutVersion: 1, header }], ...rows]);
}

function pointRows<T>(
  rows: Record<string, unknown>, prefix: string, accepts: (value: unknown) => value is T,
  order: (a: T, b: T) => number,
): T[] | undefined {
  const values = Object.entries(rows).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
  return values.every(accepts) ? [...values].sort(order) : undefined;
}

/** Reconstruct at the persisted boundary; malformed evidence is quarantined separately from billing. */
export function restoreHeatingShadowRows(rows: Record<string, unknown>): unknown {
  const root = rows.heatingShadow;
  if (!isUnknownRecord(root) || root.layoutVersion !== 1 || !isHeatingShadowState(root.header)) {
    return { malformedHeatingShadow: true };
  }
  const restored = { ...root.header, days: root.header.days.map((day) => ({ ...day,
    outdoor: pointRows(rows, rowKey(day.dateKey, 'outdoor') + '/', isHeatingShadowOutdoorPoint,
      (a, b) => a.atMs - b.atMs),
    devices: Object.fromEntries(Object.entries(day.devices).map(([id, device]) => {
      const window = rows[rowKey(day.dateKey, 'device', id, 'window')];
      return [id, { ...device,
        intervals: pointRows(rows, rowKey(day.dateKey, 'device', id, 'interval') + '/', isHeatingShadowInterval,
          (a, b) => a.startMs - b.startMs),
        changes: pointRows(rows, rowKey(day.dateKey, 'device', id, 'change') + '/', isHeatingShadowReading,
          (a, b) => a.atMs - b.atMs),
        ...(window === undefined ? {} : { window: isHeatingShadowWindow(window) ? window : null }),
      }];
    })),
  })) };
  if (isHeatingShadowState(restored)) {
    const canonical = heatingShadowRows(restored);
    const keys = Object.keys(rows);
    if (keys.length !== Object.keys(canonical).length || keys.some((key) => !Object.hasOwn(canonical, key))) {
      return { malformedHeatingShadow: true };
    }
  }
  return restored;
}
