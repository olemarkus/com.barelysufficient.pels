/**
 * How long each device's lone switch-ons and switch-offs took to show on the
 * home meter, in the userdata database: one row per device, its entries as
 * JSON, oldest first.
 *
 * Learned data, so it lives in the userdata database by ruling
 * (`notes/settings-key-ownership.md` § "Which store a key lives in"): a new
 * entry rewrites that device's row and nothing else. A row that does not read
 * as entries is deleted as read (`lib/store/jsonRowTable.ts`).
 */
import { createJsonRowTable } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { MeterResponseDirection } from './meterResponseCapture';

/** One watched command that the home meter answered, or did not, as kept. */
export type MeterResponseEntry =
  | {
    readonly outcome: 'timed';
    /** When the command was dispatched. */
    readonly atMs: number;
    readonly direction: MeterResponseDirection;
    /** From dispatch to the first meter reading past half of the change. */
    readonly responseMs: number;
    /** From dispatch to Homey's acceptance of the write, when it accepted. */
    readonly acceptedAfterMs?: number;
    readonly resolutionMs: number;
    readonly changeKw: number;
  }
  | {
    readonly outcome: 'no_change';
    readonly atMs: number;
    readonly direction: MeterResponseDirection;
  };

export type MeterResponseEntriesByDeviceId = ReadonlyMap<string, readonly MeterResponseEntry[]>;

export type MeterResponseTimingRepository = {
  /** What the store holds; no devices when it holds none. Throws only on I/O. */
  read(): MeterResponseEntriesByDeviceId;
  /** Persist `entries`, touching only the devices whose entries differ from what the store holds. */
  write(entries: MeterResponseEntriesByDeviceId): void;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isDirection = (value: unknown): value is MeterResponseDirection => value === 'on' || value === 'off';

const acceptEntry = (entry: unknown): MeterResponseEntry | undefined => {
  if (!isUnknownRecord(entry) || !isFiniteNumber(entry.atMs) || !isDirection(entry.direction)) return undefined;
  const { atMs, direction } = entry;
  if (entry.outcome === 'no_change') return { outcome: 'no_change', atMs, direction };
  if (entry.outcome !== 'timed') return undefined;
  const { responseMs, acceptedAfterMs, resolutionMs, changeKw } = entry;
  if (!isFiniteNumber(responseMs) || !isFiniteNumber(resolutionMs) || !isFiniteNumber(changeKw)) return undefined;
  if (acceptedAfterMs !== undefined && !isFiniteNumber(acceptedAfterMs)) return undefined;
  return {
    outcome: 'timed', atMs, direction, responseMs, resolutionMs, changeKw,
    ...(acceptedAfterMs === undefined ? {} : { acceptedAfterMs }),
  };
};

/** A stored row as entries: every entry whole, or the row is damage. */
const acceptEntriesRow = (value: unknown): readonly MeterResponseEntry[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map(acceptEntry);
  return entries.every((entry) => entry !== undefined) ? entries : undefined;
};

export const createMeterResponseTimingRepository = (db: UserdataDatabase): MeterResponseTimingRepository => {
  const table = createJsonRowTable(
    db, 'device_meter_response_timings', ['device_id', 'entries_json'], acceptEntriesRow,
  );
  return {
    read: () => db.transaction(() => table.read()),
    write: (entries) => db.transaction(() => table.write(entries)),
  };
};
