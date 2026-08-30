import { createSteppedStores } from '../../setup/appInit/createSteppedStores';

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
