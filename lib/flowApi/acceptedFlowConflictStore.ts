/**
 * What the last accepted Flow scan found, kept across restarts for the two
 * built-in controls that hold back while a Flow writes the same setting
 * (`lib/device/builtInControlFlowGate.ts`).
 *
 * Both owners keep their accepted conflicts in memory, and the first scan
 * after a boot runs only after the snapshot warm-up gate. Without these
 * stores, an owner's built-in choice would run over a known conflict from boot
 * until that scan, or for as long as the Flow list stayed unreadable. Seeded
 * from here, a boot starts from the last accepted answer, the same answer an
 * unreadable scan keeps while running.
 *
 * One table per owner, one row per device, each written only by its owner:
 * - `native_flow_conflicts`: the conflicts native wiring applied (Hoiax,
 *   Easee), as the device notice shows them (`NativeFlowConflictState`, held by
 *   `BuiltInControlFlowConflicts`);
 * - `charging_current_flow_writes`: for each charger or car with built-in
 *   current control, the Flows that set its current (`ChargingCurrentControl`).
 *
 * A cache by ruling (`notes/settings-key-ownership.md` § "Which store"): a row
 * that does not parse is the store's own damage, deleted as read, and the next
 * accepted scan rewrites it.
 */
import { createJsonRowTable } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';
import type { FlowCapabilityWrites } from './userFlows';

/** One device's native-wiring conflict, as native wiring applies it. */
export type NativeFlowConflict = { conflictingCapabilities: readonly string[]; flowName?: string };
export type NativeFlowConflicts = Record<string, NativeFlowConflict>;

/** One owner's saved state. Both throw only on I/O. */
export type AcceptedFlowConflictSlice<T> = {
  read(): T;
  write(value: T): void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
);

const acceptNativeConflict = (value: unknown): NativeFlowConflict | undefined => {
  if (!isRecord(value) || !isStringArray(value.conflictingCapabilities)) return undefined;
  if (value.flowName === undefined) return { conflictingCapabilities: value.conflictingCapabilities };
  return typeof value.flowName === 'string'
    ? { conflictingCapabilities: value.conflictingCapabilities, flowName: value.flowName }
    : undefined;
};

// A device's writes as stored: capability → Flow id → Flow name.
type StoredDeviceWrites = Record<string, Record<string, string>>;

const acceptDeviceWrites = (value: unknown): StoredDeviceWrites | undefined => {
  if (!isRecord(value)) return undefined;
  const flowsValid = Object.values(value).every((flows) => (
    isRecord(flows) && Object.values(flows).every((name) => typeof name === 'string')
  ));
  return flowsValid ? value as StoredDeviceWrites : undefined;
};

export const createNativeFlowConflictStore = (
  db: UserdataDatabase,
): AcceptedFlowConflictSlice<NativeFlowConflicts> => {
  const table = createJsonRowTable(db, 'native_flow_conflicts', ['device_id', 'conflict_json'], acceptNativeConflict);
  return {
    read: () => Object.fromEntries(db.transaction(() => table.read())),
    write: (conflicts) => db.transaction(() => table.write(new Map(Object.entries(conflicts)))),
  };
};

export const createChargingFlowWritesStore = (
  db: UserdataDatabase,
): AcceptedFlowConflictSlice<FlowCapabilityWrites> => {
  const table = createJsonRowTable(
    db, 'charging_current_flow_writes', ['device_id', 'writes_json'], acceptDeviceWrites,
  );
  return {
    read: () => new Map([...db.transaction(() => table.read())].map(([deviceId, writes]) => [
      deviceId,
      new Map(Object.entries(writes).map(([capability, flows]) => [capability, new Map(Object.entries(flows))])),
    ])),
    write: (writes) => db.transaction(() => table.write(new Map([...writes].map(([deviceId, capabilities]) => [
      deviceId,
      Object.fromEntries([...capabilities].map(([capability, flows]) => [capability, Object.fromEntries(flows)])),
    ])))),
  };
};

/**
 * A slice bound to the userdata database while it is open. A read while it is
 * not open throws, which each owner logs; a save after it closed (teardown) is
 * dropped, as nothing will read it before the next boot's restore.
 */
export const whileDatabaseOpen = <T>(
  current: () => AcceptedFlowConflictSlice<T> | undefined,
): AcceptedFlowConflictSlice<T> => ({
  read: () => {
    const slice = current();
    if (slice === undefined) throw new Error('the userdata database is not open');
    return slice.read();
  },
  write: (value) => { current()?.write(value); },
});
