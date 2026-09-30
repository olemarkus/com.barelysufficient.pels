import { createSteppedStores } from '../../setup/appInit/createSteppedStores';

/** The same command and report stores production wires together. */
export const steppedStoresForTest = () => {
  const { commandStore, reportedStore } = createSteppedStores();
  return { store: commandStore, reportedStore };
};
