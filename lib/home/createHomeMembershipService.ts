import type { SettingsPort } from '../ports/homeyRuntime';
import { createMainMeterSelectionReader } from './mainMeterSelection';
import {
  migrateLegacyMultiHomeActivation,
  readLegacyMultiHomeEnabled,
} from './homeConfigActivation';
import { createDeviceHomeAssignmentsStore, createHomesStore } from './homeRegistryStore';
import {
  HomeMembershipService,
  type HomeMembershipServiceDeps,
} from './homeMembershipService';

export type HomeMembershipFactoryDeps = Omit<
  HomeMembershipServiceDeps,
  'homesStore' | 'assignmentsStore' | 'getMainMeterSelection' | 'legacyMultiHomeEnabled'
> & {
  settings: SettingsPort;
};

/** Construct home-owned settings readers, stores, and their membership service. */
export const createHomeMembershipService = (
  params: HomeMembershipFactoryDeps,
): HomeMembershipService => {
  const { settings, ...serviceDeps } = params;
  const migration = migrateLegacyMultiHomeActivation(settings);
  if (migration === 'applied') {
    params.getLogger()?.info({
      event: 'boot_migration_applied',
      migration: 'mark legacy-enabled homes_config active for multi-home GA',
    });
  }
  const mainMeterSelection = createMainMeterSelectionReader(settings, () => Date.now());
  return new HomeMembershipService({
    ...serviceDeps,
    homesStore: createHomesStore(settings),
    assignmentsStore: createDeviceHomeAssignmentsStore(settings),
    getMainMeterSelection: () => mainMeterSelection.read(),
    legacyMultiHomeEnabled: readLegacyMultiHomeEnabled(settings),
  });
};
