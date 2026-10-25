import type { SettingsPort } from '../ports/homeyRuntime';
import { createMainMeterSelectionReader } from './mainMeterSelection';
import { createDeviceHomeAssignmentsStore, createHomesStore } from './homeRegistryStore';
import {
  HomeMembershipService,
  type HomeMembershipServiceDeps,
} from './homeMembershipService';

export type HomeMembershipFactoryDeps = Omit<
  HomeMembershipServiceDeps,
  'homesStore' | 'assignmentsStore' | 'getMainMeterSelection'
> & {
  settings: SettingsPort;
};

/** Construct home-owned settings readers, stores, and their membership service. */
export const createHomeMembershipService = (
  params: HomeMembershipFactoryDeps,
): HomeMembershipService => {
  const { settings, ...serviceDeps } = params;
  const mainMeterSelection = createMainMeterSelectionReader(settings, () => Date.now());
  return new HomeMembershipService({
    ...serviceDeps,
    homesStore: createHomesStore(settings),
    assignmentsStore: createDeviceHomeAssignmentsStore(settings),
    getMainMeterSelection: () => mainMeterSelection.read(),
  });
};
