import { createSteppedStores } from '../../setup/appInit/createSteppedStores';
import { decorateSnapshotWithDeviceControl } from '../../setup/appDeviceControlHelpers';
import { syncSteppedCommands } from '../../lib/executor/syncSteppedCommands';
import { buildSteppedSettleSnapshot } from '../../lib/observer/steppedSettleSnapshot';

/**
 * The two stepped-load stores, wired by the SAME factory production uses, so a
 * test can never wire the executor against a different observation than the app
 * does. Spread into an `AppDeviceControlHelpers` dep bag
 * (`...steppedStoresForTest()`), or destructure when asserting on one of them.
 */
export const steppedStoresForTest = () => {
  const { commandStore, reportedStore } = createSteppedStores();
  return { store: commandStore, reportedStore };
};

/**
 * Decorate a device and then run the settle pass over it — the production
 * sequence in miniature: `decorateSnapshotWithDeviceControl` resolves the
 * ladder onto the device (a pure projection), and `syncSteppedCommands`
 * advances the command lifecycle from what that device now says.
 *
 * Tests that assert on command state after decoration need this, because
 * decoration alone no longer settles anything — which is the point of the
 * change it was written for.
 */
export const decorateAndSettle = (
  params: Parameters<typeof decorateSnapshotWithDeviceControl>[0],
): ReturnType<typeof decorateSnapshotWithDeviceControl> => {
  const projection = decorateSnapshotWithDeviceControl(params);
  syncSteppedCommands({
    store: params.store,
    reportedStore: params.reportedStore,
    devices: buildSteppedSettleSnapshot([projection]),
    nowMs: params.nowMs,
  });
  // Re-project so the caller reads command state as of the settle. Production
  // does exactly this: `latestTargetSnapshot` is a getter, so the settle pass
  // decorates to get its evidence and the plan build decorates again to read
  // the result.
  return decorateSnapshotWithDeviceControl(params);
};
