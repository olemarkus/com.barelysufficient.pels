import type { HeatingShadowState } from './heatingShadowTypes';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import {
  isHeatingShadowState, isHeatingShadowInterval, isHeatingShadowReading,
  isHeatingShadowWindow, isHeatingShadowOutdoorPoint,
} from './heatingShadowState';

const HEADER_KEY = 'header';
const rowKey = (...parts: (string | number)[]): string => (
  parts.map((part) => encodeURIComponent(String(part))).join('/')
);

/** Persist immutable observations separately; each checkpoint changes only small open-window rows. */
export function heatingShadowRows(state: HeatingShadowState): Map<string, unknown> {
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
  return new Map<string, unknown>([[HEADER_KEY, { layoutVersion: 1, header }], ...rows]);
}

function pointRows<T>(
  rows: ReadonlyMap<string, unknown>, prefix: string, accepts: (value: unknown) => value is T,
  order: (a: T, b: T) => number,
): T[] | undefined {
  const values = [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
  return values.every(accepts) ? [...values].sort(order) : undefined;
}

/**
 * Reconstruct at the persisted boundary: the state the rows hold, or
 * `undefined` when they do not make one in the canonical layout.
 */
export function restoreHeatingShadowRows(rows: ReadonlyMap<string, unknown>): HeatingShadowState | undefined {
  const root = rows.get(HEADER_KEY);
  if (!isUnknownRecord(root) || root.layoutVersion !== 1 || !isHeatingShadowState(root.header)) return undefined;
  const restored = { ...root.header, days: root.header.days.map((day) => ({ ...day,
    outdoor: pointRows(rows, rowKey(day.dateKey, 'outdoor') + '/', isHeatingShadowOutdoorPoint,
      (a, b) => a.atMs - b.atMs),
    devices: Object.fromEntries(Object.entries(day.devices).map(([id, device]) => {
      const window = rows.get(rowKey(day.dateKey, 'device', id, 'window'));
      return [id, { ...device,
        intervals: pointRows(rows, rowKey(day.dateKey, 'device', id, 'interval') + '/', isHeatingShadowInterval,
          (a, b) => a.startMs - b.startMs),
        changes: pointRows(rows, rowKey(day.dateKey, 'device', id, 'change') + '/', isHeatingShadowReading,
          (a, b) => a.atMs - b.atMs),
        ...(window === undefined ? {} : { window: isHeatingShadowWindow(window) ? window : null }),
      }];
    })),
  })) };
  if (!isHeatingShadowState(restored)) return undefined;
  const canonical = heatingShadowRows(restored);
  if (rows.size !== canonical.size || [...rows.keys()].some((key) => !canonical.has(key))) return undefined;
  return restored;
}
