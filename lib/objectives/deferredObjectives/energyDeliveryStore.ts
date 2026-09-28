/**
 * The energy-task delivery runs' rows in the userdata database, behind the
 * load/save seam `EnergyTaskDeliveryTracker` persists through.
 *
 * One row per open run, keyed like the tracker keys it (device and deadline).
 * Writes are diffed against what the store holds, so a tick that booked energy
 * for one task rewrites that one row. A row re-entering from disk is a persisted
 * blob and is validated here; a row that does not parse, or disagrees with its
 * own key, is the store's own damage and is deleted as read, costing only that
 * run's count (the task then re-counts from 0 — it asks for more energy, never
 * less than it needs).
 */
import { getLogger } from '../../logging/logger';
import type { UserdataDatabase } from '../../store/userdataDatabase';
import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';
import type { EnergyDeliveryRun, EnergyDeliveryStore } from './energyDelivery';

const storeLogger = getLogger('deferred-objectives/energy-delivery-store');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deferred_objective_energy_delivery (
  run_key TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL
) WITHOUT ROWID;
`;

const keyOf = (run: EnergyDeliveryRun): string => (
  `${run.deviceId}|${run.deadlineAtMs}`
);

const parseRow = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
};

const isEnergyDeliveryRun = (value: unknown): value is EnergyDeliveryRun => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.deviceId === 'string'
    && candidate.deviceId.length > 0
    && isFiniteNumber(candidate.deadlineAtMs)
    && isFiniteNumber(candidate.startedAtMs)
    && isFiniteNumber(candidate.deliveredKWh)
    && candidate.deliveredKWh >= 0;
};

const sameRun = (a: EnergyDeliveryRun, b: EnergyDeliveryRun): boolean => (
  a.startedAtMs === b.startedAtMs && a.deliveredKWh === b.deliveredKWh
);

export const createEnergyDeliveryStore = (db: UserdataDatabase): EnergyDeliveryStore => {
  db.exec(SCHEMA);
  const upsert = db.prepare(
    'INSERT INTO deferred_objective_energy_delivery (run_key, state_json) VALUES (?, ?) '
      + 'ON CONFLICT (run_key) DO UPDATE SET state_json = excluded.state_json',
  );
  const remove = db.prepare('DELETE FROM deferred_objective_energy_delivery WHERE run_key = ?');
  const load = db.prepare('SELECT run_key, state_json FROM deferred_objective_energy_delivery ORDER BY run_key');
  let held: Map<string, EnergyDeliveryRun> | null = null;

  const loadRuns = (): EnergyDeliveryRun[] => {
    const rows = load.all() as Array<{ run_key: string; state_json: string }>;
    return rows.flatMap((row) => {
      const parsed = parseRow(row.state_json);
      if (isEnergyDeliveryRun(parsed) && keyOf(parsed) === row.run_key) return [parsed];
      storeLogger.error({ event: 'energy_task_delivery_row_quarantined', key: row.run_key });
      remove.run(row.run_key);
      return [];
    });
  };

  const heldOf = (runs: readonly EnergyDeliveryRun[]): Map<string, EnergyDeliveryRun> => (
    new Map(runs.map((run) => [keyOf(run), run]))
  );

  return {
    read: () => db.transaction(() => {
      const runs = loadRuns();
      held = heldOf(runs);
      return runs;
    }),
    write: (runs) => {
      const next = heldOf(runs);
      db.transaction(() => {
        const previous = held ?? heldOf(loadRuns());
        for (const [key, run] of next) {
          const before = previous.get(key);
          if (before === undefined || !sameRun(before, run)) upsert.run(key, JSON.stringify(run));
        }
        for (const key of previous.keys()) {
          if (!next.has(key)) remove.run(key);
        }
      });
      held = next;
    },
  };
};
