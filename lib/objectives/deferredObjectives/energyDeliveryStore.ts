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
import { createJsonRowTable } from '../../store/jsonRowTable';
import type { UserdataDatabase } from '../../store/userdataDatabase';
import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';
import type { EnergyDeliveryRun, EnergyDeliveryStore } from './energyDelivery';

const keyOf = (run: EnergyDeliveryRun): string => (
  `${run.deviceId}|${run.deadlineAtMs}`
);

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

export const createEnergyDeliveryStore = (db: UserdataDatabase): EnergyDeliveryStore => {
  const runs = createJsonRowTable(db, 'deferred_objective_energy_delivery', ['run_key', 'state_json'], (value, key) => (
    isEnergyDeliveryRun(value) && keyOf(value) === key ? value : undefined
  ));
  return {
    read: () => db.transaction(() => [...runs.read().values()]),
    write: (next) => db.transaction(() => runs.write(new Map(next.map((run) => [keyOf(run), run])))),
  };
};
