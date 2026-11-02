import { describe, expect, it } from 'vitest';
import { createBatteryEfficiencyStoreForApp } from '../../setup/appInit/batteryMeterLearning';
import { BatteryEfficiencyLearner } from '../../lib/battery/batteryEfficiencyLearner';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';

const createBatteryEfficiencyStore = (db: UserdataDatabase) => createBatteryEfficiencyStoreForApp({ getUserdataDatabase: () => db });

describe('battery efficiency store', () => {
  it('round-trips each battery’s cycles, and a restarted learner suggests from them', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = createBatteryEfficiencyStore(db);
    store.write(new Map([['battery', [0.86, 0.88, 0.87]], ['other', [0.9]]]));

    const restarted = createBatteryEfficiencyStore(db);
    expect(restarted.read()).toEqual(new Map([['battery', [0.86, 0.88, 0.87]], ['other', [0.9]]]));
    const learner = new BatteryEfficiencyLearner(restarted, () => []);
    expect(learner.read('battery')).toEqual({ status: 'measured', roundTripEfficiency: 0.87, cycles: 3 });
    expect(learner.read('other')).toEqual({ status: 'measuring', cycles: 1, cyclesNeeded: 3 });
  });

  it('drops a row the learner could not have written and keeps the others', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    createBatteryEfficiencyStore(db).write(new Map([['battery', [0.86]]]));
    db.prepare('INSERT INTO battery_efficiency_cycles (device_id, cycles_json) VALUES (?, ?)')
      .run('broken', JSON.stringify([1.4]));
    expect(createBatteryEfficiencyStore(db).read()).toEqual(new Map([['battery', [0.86]]]));
  });
});
