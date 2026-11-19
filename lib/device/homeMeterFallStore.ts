/**
 * The home meter's falls at each device's lone switch-offs, in the userdata
 * database: one row per device, its falls as JSON, oldest first.
 *
 * Learned data, so it lives in the userdata database by ruling
 * (`notes/settings-key-ownership.md` § "Which store a key lives in"): a new fall
 * rewrites that device's row and nothing else. A row that does not read as falls
 * is deleted as read (`lib/store/jsonRowTable.ts`).
 */
import { createJsonRowTable } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

/** One lone switch-off as the home meter saw it. */
export type HomeMeterFall = {
  readonly atMs: number;
  readonly fallKw: number;
};

export type HomeMeterFallsByDeviceId = ReadonlyMap<string, readonly HomeMeterFall[]>;

export type HomeMeterFallRepository = {
  /** What the store holds; no devices when it holds none. Throws only on I/O. */
  read(): HomeMeterFallsByDeviceId;
  /** Persist `falls`, touching only the devices whose falls differ from what the store holds. */
  write(falls: HomeMeterFallsByDeviceId): void;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A stored row as falls: every entry a dated, finite fall, or the row is damage. */
const isFallEntry = (entry: unknown): entry is HomeMeterFall => (
  isUnknownRecord(entry) && isFiniteNumber(entry.atMs) && isFiniteNumber(entry.fallKw)
);

const acceptFallsRow = (value: unknown): readonly HomeMeterFall[] | undefined => {
  if (!Array.isArray(value) || !value.every(isFallEntry)) return undefined;
  return value.map(({ atMs, fallKw }) => ({ atMs, fallKw }));
};

export const createHomeMeterFallRepository = (db: UserdataDatabase): HomeMeterFallRepository => {
  const table = createJsonRowTable(db, 'device_home_meter_falls', ['device_id', 'falls_json'], acceptFallsRow);
  return {
    read: () => db.transaction(() => table.read()),
    write: (falls) => db.transaction(() => table.write(falls)),
  };
};
