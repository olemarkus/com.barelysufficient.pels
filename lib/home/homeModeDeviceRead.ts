import type { SettingsPort } from '../ports/homeyRuntime';
import type { HomeId } from '../utils/settingsKeys';
import {
  resolveHomeOperatingMode,
  type HomeOperatingModeResolution,
} from '../utils/capacityHelpers';
import {
  MAIN_HOME_ID,
  OPERATING_MODE_SETTING,
  homeScopedSettingsKey,
} from '../utils/settingsKeys';
import { readMainOperatingMode } from './mainOperatingModeRead';
import type { HomeModeCatalog, HomeModeCatalogSnapshot, PersistedHomeModeCatalogRead } from './homeModeCatalog';
import { readHomeModeSetting } from './homeModeSettingsRead';
import type { HomeMembershipPort } from './membership';

/** Device mode truth or an unavailable read that must not seed a default. */
export type DeviceOperatingModeOutcome =
  | { state: 'resolved'; mode: string | null; homeId: HomeId; catalogHomeId: HomeId }
  | { state: 'unavailable' };

/**
 * The catalog a device's mode targets live in, with the mode that governs the
 * device now. `catalogHomeId` names the stored catalog, which for a meter area
 * that still follows Main is Main's, while `activeMode` is the device's own
 * home's mode.
 */
export type DeviceModeCatalogOutcome =
  | {
    state: 'resolved';
    catalogHomeId: HomeId;
    activeMode: string | null;
    catalog: HomeModeCatalogSnapshot;
  }
  | { state: 'unavailable' };

/** Committed ownership attribution for the device-keyed temperature seed. */
export const resolveHomeIdForModeCatalogSeed = (
  membership: HomeMembershipPort | undefined,
  deviceId: string,
): HomeId | null => {
  if (!membership) return MAIN_HOME_ID;
  return membership.isOwnershipReady() && !membership.hasPendingOwnershipGeneration()
    ? membership.getHomeIdForDevice(deviceId)
    : null;
};

const ownershipIsUnavailable = (
  membership: HomeMembershipPort | undefined,
  allowPendingOwnershipGeneration: boolean,
): boolean => Boolean(
  membership
  && (
    !membership.isOwnershipReady()
    || (!allowPendingOwnershipGeneration && membership.hasPendingOwnershipGeneration())
  ),
);

const resolveLegacyHomeMode = (
  settings: SettingsPort,
  homeId: HomeId,
  mainCatalog: HomeModeCatalog,
): { state: 'resolved'; resolution: HomeOperatingModeResolution } | { state: 'unavailable' } => {
  const modeRead = readHomeModeSetting(settings, homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId));
  if (modeRead.state === 'unavailable') return { state: 'unavailable' };
  const main = mainCatalog.getSnapshot();
  return {
    state: 'resolved',
    resolution: resolveHomeOperatingMode({
      perHomeModeRaw: modeRead.value,
      globalMode: main.operatingMode,
      resolveAlias: (name) => mainCatalog.resolveModeName(name),
      modeDeviceTargets: main.targets,
    }),
  };
};

/**
 * Resolves one device's governing mode from committed ownership and its home
 * catalog. Uncertain reads are unavailable so consumers cannot persist a
 * default under Main's mode for a sub-home device.
 */
export class HomeModeDeviceResolver {
  constructor(
    private readonly settings: SettingsPort,
    private readonly mainCatalog: HomeModeCatalog,
    private readonly getManagedDevices: () => Readonly<Record<string, boolean>>,
    private readonly getMembership: () => HomeMembershipPort | undefined,
    private readonly readCatalog: (
      settings: SettingsPort,
      homeId: HomeId,
      managedDevices: Readonly<Record<string, boolean>>,
      membership: HomeMembershipPort | undefined,
    ) => PersistedHomeModeCatalogRead,
  ) {}

  resolve = (
    deviceId: string,
    membershipOverride?: HomeMembershipPort,
    allowPendingOwnershipGeneration = false,
  ): DeviceOperatingModeOutcome => {
    const governing = this.resolveGoverning(deviceId, membershipOverride, allowPendingOwnershipGeneration);
    if (governing.state === 'unavailable') return governing;
    const { mode, homeId, catalogHomeId } = governing;
    return { state: 'resolved', mode, homeId, catalogHomeId };
  };

  /** The catalog an edit to this device's mode targets must go to. See {@link DeviceModeCatalogOutcome}. */
  resolveCatalog = (deviceId: string): DeviceModeCatalogOutcome => {
    const governing = this.resolveGoverning(deviceId);
    if (governing.state === 'unavailable') return governing;
    return {
      state: 'resolved',
      catalogHomeId: governing.catalogHomeId,
      activeMode: governing.mode,
      catalog: governing.areaCatalog ?? this.mainCatalog.getSnapshot(),
    };
  };

  /**
   * The governing mode, plus the area catalog when it was read on the way: an
   * initialized meter area's snapshot is what decided its mode, so a caller
   * that also needs the catalog gets the same read rather than a second one.
   * `null` means the catalog is Main's.
   */
  private resolveGoverning = (
    deviceId: string,
    membershipOverride?: HomeMembershipPort,
    allowPendingOwnershipGeneration = false,
  ):
    | {
      state: 'resolved';
      mode: string | null;
      homeId: HomeId;
      catalogHomeId: HomeId;
      areaCatalog: HomeModeCatalogSnapshot | null;
    }
    | { state: 'unavailable' } => {
    const membership = this.getMembership();
    const effectiveMembership = membershipOverride ?? membership;
    if (ownershipIsUnavailable(effectiveMembership, allowPendingOwnershipGeneration)) {
      return { state: 'unavailable' };
    }
    const homeId = effectiveMembership?.getHomeIdForDevice(deviceId) ?? MAIN_HOME_ID;
    if (homeId === MAIN_HOME_ID) {
      const mainMode = this.mainCatalog.getOperatingMode();
      const read = readMainOperatingMode(this.settings, this.mainCatalog.resolveModeName, mainMode);
      return read.state === 'resolved' ? { ...read, areaCatalog: null } : { state: 'unavailable' };
    }
    const catalog = this.readCatalog(
      this.settings, homeId, this.getManagedDevices(), membership,
    );
    if (catalog.state === 'unavailable') return { state: 'unavailable' };
    if (catalog.state === 'resolved') {
      return {
        state: 'resolved',
        mode: catalog.snapshot.operatingMode,
        homeId,
        catalogHomeId: homeId,
        areaCatalog: catalog.snapshot,
      };
    }
    const legacy = resolveLegacyHomeMode(this.settings, homeId, this.mainCatalog);
    if (legacy.state === 'unavailable' || legacy.resolution.fault !== null) {
      return { state: 'unavailable' };
    }
    const { mode } = legacy.resolution;
    return {
      state: 'resolved',
      mode: mode.trim() ? mode : null,
      homeId,
      catalogHomeId: MAIN_HOME_ID,
      areaCatalog: null,
    };
  };
}
