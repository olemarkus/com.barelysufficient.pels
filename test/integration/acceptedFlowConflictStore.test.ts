import { NativeFlowConflictState } from '../../lib/device/nativeFlowConflictState';
import {
  createChargingFlowWritesStore,
  createNativeFlowConflictStore,
} from '../../lib/flowApi/acceptedFlowConflictStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

describe('accepted Flow conflict stores', () => {
  it('keeps native conflicts across a reopen, one row per device', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const state = new NativeFlowConflictState(createNativeFlowConflictStore(db));
    state.accept({
      easee: { conflictingCapabilities: ['setDynamicChargerCurrent'], flowName: 'PELS BEV' },
      hoiax: { conflictingCapabilities: ['max_power_3000'] },
    });

    // A restart: a new owner on the same database seeds what was accepted.
    const restarted = new NativeFlowConflictState(createNativeFlowConflictStore(db));
    expect(restarted.all).toEqual({});
    restarted.restoreSaved();
    expect(restarted.get('easee')).toEqual({ conflictingCapabilities: ['setDynamicChargerCurrent'], flowName: 'PELS BEV' });

    // A scan that cleared a conflict drops that device's row.
    restarted.accept({ hoiax: { conflictingCapabilities: ['max_power_3000'] } });
    expect(createNativeFlowConflictStore(db).read()).toEqual({ hoiax: { conflictingCapabilities: ['max_power_3000'] } });
  });

  it('keeps charging-current Flow writes across a reopen', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const writes = new Map([['tesla', new Map([['set_current', new Map([['f1', 'Night charge']])]])]]);
    createChargingFlowWritesStore(db).write(writes);
    expect(createChargingFlowWritesStore(db).read()).toEqual(writes);
  });

  it('reads nothing from an empty store, drops a row that holds no conflict, and survives an unreadable one', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    expect(createNativeFlowConflictStore(db).read()).toEqual({});
    expect(createChargingFlowWritesStore(db).read()).toEqual(new Map());

    db.exec(`INSERT INTO native_flow_conflicts (device_id, conflict_json) VALUES ('bad', '{"conflictingCapabilities":7}')`);
    expect(createNativeFlowConflictStore(db).read()).toEqual({});

    const failing = new NativeFlowConflictState({
      read: () => { throw new Error('disk'); },
      write: () => { throw new Error('disk'); },
    });
    failing.restoreSaved();
    failing.accept({ easee: { conflictingCapabilities: ['setDynamicChargerCurrent'] } });
    expect(failing.get('easee')).toEqual({ conflictingCapabilities: ['setDynamicChargerCurrent'] });
  });
});
