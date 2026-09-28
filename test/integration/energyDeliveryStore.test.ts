import { createEnergyDeliveryStore } from '../../lib/objectives/deferredObjectives/energyDeliveryStore';
import type { EnergyDeliveryRun } from '../../lib/objectives/deferredObjectives/energyDelivery';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createEnergyDeliveryStore(db) };
};

const run = (overrides: Partial<EnergyDeliveryRun> = {}): EnergyDeliveryRun => ({
  deviceId: 'heater',
  deadlineAtMs: 10_000,
  startedAtMs: 1_000,
  deliveredKWh: 1.5,
  ...overrides,
});

const totalChanges = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

describe('energyDeliveryStore', () => {
  it('reads back what it wrote, and nothing when empty', () => {
    const { db, store } = open();
    expect(store.read()).toEqual([]);
    store.write([run(), run({ deviceId: 'relay', deliveredKWh: 3 })]);
    expect(createEnergyDeliveryStore(db).read()).toEqual([
      run(),
      run({ deviceId: 'relay', deliveredKWh: 3 }),
    ]);
  });

  it('rewrites only the rows that changed, and removes the ones dropped', () => {
    const { db, store } = open();
    store.write([run(), run({ deviceId: 'relay' })]);
    const before = totalChanges(db);
    store.write([run({ deliveredKWh: 2 }), run({ deviceId: 'relay' })]);
    expect(totalChanges(db) - before).toBe(1);

    store.write([run({ deliveredKWh: 2 })]);
    expect(createEnergyDeliveryStore(db).read()).toEqual([run({ deliveredKWh: 2 })]);
  });

  it('deletes a row that does not parse or disagrees with its key, keeping the rest', () => {
    const { db, store } = open();
    store.write([run()]);
    const insert = db.prepare('INSERT INTO deferred_objective_energy_delivery (run_key, state_json) VALUES (?, ?)');
    insert.run('broken|1', '{not json');
    insert.run('relay|20000', JSON.stringify(run({ deviceId: 'relay', deadlineAtMs: 30_000 })));
    insert.run('negative|10000', JSON.stringify(run({ deviceId: 'negative', deliveredKWh: -1 })));

    expect(createEnergyDeliveryStore(db).read()).toEqual([run()]);
    const remaining = db.prepare('SELECT run_key FROM deferred_objective_energy_delivery').all();
    expect(remaining).toEqual([{ run_key: 'heater|10000' }]);
  });
});
