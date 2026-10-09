import type { SettingsUiPlanDeviceSnapshot } from '../../packages/contracts/src/settingsUiApi';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import {
  buildSettingsOverviewReadModel,
  type SettingsOverviewReadModelDeps,
} from '../../lib/plan/settingsOverviewReadModel';
import { buildPlanMeta } from './planTestUtils';

type OverviewReadModelWiring = Pick<SettingsOverviewReadModelDeps,
  | 'getOverviewStarvation'
  | 'getIdleClassification'
  | 'getAssociatedCarChargingState'
  | 'getSteppedLoadProfileById'>;

/**
 * The read-model deps the plan service always wires, for a spec that is not
 * about them: no starvation, no idle classification, no associated car, no
 * stepped profiles. A spec about one of them overrides it.
 */
export const overviewReadModelWiring = (): OverviewReadModelWiring => ({
  getOverviewStarvation: () => undefined,
  getIdleClassification: () => undefined,
  getAssociatedCarChargingState: () => undefined,
  getSteppedLoadProfileById: () => new Map(),
});

/**
 * One device's overview card, built the way production builds it: through the
 * whole-plan read model, from a plan holding only that device. The plan's
 * `generatedAtMs` is 0, so 0 is the reason anchor.
 */
export const buildOverviewDeviceCard = (
  device: DevicePlanDevice,
  deps: SettingsOverviewReadModelDeps,
  steppedLoadProfile?: SteppedLoadProfile,
): SettingsUiPlanDeviceSnapshot => {
  const overview = buildSettingsOverviewReadModel(
    { generatedAtMs: 0, meta: buildPlanMeta(), devices: [device], storageReleases: [] },
    steppedLoadProfile
      ? { ...deps, getSteppedLoadProfileById: () => new Map([[device.id, steppedLoadProfile]]) }
      : deps,
  );
  const card = overview?.devices?.[0];
  if (!card) throw new Error(`no overview card for ${device.id}`);
  return card;
};
