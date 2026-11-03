/**
 * Main's passive heating observations in the userdata database, beside the
 * device events PELS keeps for problem reports (`deviceEventStore.ts`).
 *
 * One JSON row per immutable observation (an interval, a change, an outdoor
 * point), one per open window and one small header, in the layout
 * `heatingShadowPersistence.ts` defines. A checkpoint writes the rows that
 * changed since the last: the open windows and what closed since, never the
 * retained history around them.
 *
 * Rows that do not reconstruct a state in that layout are the store's own
 * damage: regenerable by ruling, they are deleted together and said once, and
 * collection starts again. Nothing in them reaches billing, learning or
 * control.
 */
import { getLogger } from '../logging/logger';
import { createJsonRowTable } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { heatingShadowRows, restoreHeatingShadowRows } from './heatingShadowPersistence';
import type { HeatingShadowState } from './heatingShadowTypes';

const logger = getLogger('diagnostics/heating-shadow');

export type HeatingShadowStore = {
  /**
   * The stored observations; `null` when the store holds none, including after
   * its rows were quarantined. Throws only on I/O, or while the database is closed.
   */
  load(): HeatingShadowState | null;
  /** Make the store hold `state`, touching only the rows that differ. Throws only on I/O. */
  save(state: HeatingShadowState): void;
};

export const createHeatingShadowStore = (db: UserdataDatabase): HeatingShadowStore => {
  const rows = createJsonRowTable(db, 'heating_shadow_rows', ['key', 'value_json'], (value) => value);
  return {
    load: () => db.transaction(() => {
      const stored = rows.read();
      if (stored.size === 0) return null;
      const state = restoreHeatingShadowRows(stored);
      if (state) return state;
      logger.error({ event: 'heating_shadow_rows_quarantined', rows: stored.size });
      rows.write(new Map());
      return null;
    }),
    save: (state) => db.transaction(() => rows.write(heatingShadowRows(state))),
  };
};

/**
 * The store for a collector built before the userdata database opens: it
 * opens the store on the database the first read or write finds, once per
 * database, so its diff base survives from one checkpoint to the next.
 */
export const createDeferredHeatingShadowStore = (getDatabase: () => UserdataDatabase): HeatingShadowStore => {
  let opened: { db: UserdataDatabase; store: HeatingShadowStore } | undefined;
  const store = (): HeatingShadowStore => {
    const db = getDatabase();
    if (opened?.db !== db) opened = { db, store: createHeatingShadowStore(db) };
    return opened.store;
  };
  return {
    load: () => store().load(),
    save: (state) => store().save(state),
  };
};
