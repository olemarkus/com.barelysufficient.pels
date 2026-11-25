import { createSteppedStores } from '../../setup/appInit/createSteppedStores';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { ShutdownLatch } from '../../lib/utils/shutdownLatch';

const openOnFirstUse = (): (() => UserdataDatabase) => {
  let database: UserdataDatabase | undefined;
  return () => {
    database ??= openUserdataDatabase(IN_MEMORY_DATABASE);
    return database;
  };
};

/**
 * The same command and report stores production wires together, with the
 * contest record they report to; it journals into `getUserdataDatabase`, an
 * in-memory database of its own unless the spec shares one.
 */
export const steppedStoresForTest = (getUserdataDatabase: () => UserdataDatabase = openOnFirstUse()) => {
  const { commandStore, reportedStore, controlContests } = createSteppedStores(getUserdataDatabase, new ShutdownLatch());
  return { store: commandStore, reportedStore, contests: controlContests };
};
