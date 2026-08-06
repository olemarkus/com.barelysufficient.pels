import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

/**
 * Whether a device list contains a role-detected PV device.
 *
 * ONE definition, shared by the two places that must agree: the settings-UI
 * production gate (`hasManagedSolarDevice`, which promises the Usage tab a Solar
 * card) and the flow source's generation poll (`createGenerationPollSource`,
 * which is what fills that card's buckets). They previously carried separate
 * inline copies over different device sets, so the UI could promise a card the
 * poll would never fill — the exact failure the deleted `deliversProductionSignal`
 * gate had existed to prevent.
 *
 * `solarpanel` is the normalized class-key for any role-detected PV
 * (`resolveDeviceClassKey`); see `isSolarPanelDevice` in `managerEnergy.ts` for
 * why class is the identity and an exported-energy capability is not.
 */
export const hasSolarProductionCandidate = (
  devices: readonly Pick<TargetDeviceSnapshot, 'deviceClass'>[],
): boolean => devices.some((device) => device.deviceClass === 'solarpanel');
