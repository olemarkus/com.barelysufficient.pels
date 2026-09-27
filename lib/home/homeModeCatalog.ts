/**
 * Settings-backed mode catalog for one meter area.
 *
 * Main keeps the historical unsuffixed catalog in this owner. Each meter area
 * owns a coherent suffixed snapshot after `mode_catalog_initialized:<homeId>`
 * is written. The marker is committed last so a partial migration can never be
 * mistaken for an independent catalog. Until then, the area deliberately keeps
 * the legacy Main snapshot as a compatibility fallback.
 */
import type { SettingsPort } from '../ports/homeyRuntime';
import type { Logger as PinoLogger } from '../logging/logger';
import type { HomeMembershipPort } from './membership';
import {
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MODE_ALIASES,
  MODE_CATALOG_INITIALIZED,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  homeScopedSettingsKey,
  type HomeId,
} from '../utils/settingsKeys';
import { resolveModeName, getAllModes } from '../utils/capacityHelpers';
import {
  ModePriorityCatalog, readModePriorityCatalog, type ModePriorityOrder,
} from '../../packages/shared-domain/src/settings/modePriorities';
import { sanitizeModeDeviceTargets } from '../../packages/shared-domain/src/settings/modeDeviceTargets';
import { readModeAliases } from '../../packages/shared-domain/src/settings/modeAliases';
import { readHomeModeSetting } from './homeModeSettingsRead';
import { HomeModeDeviceResolver, type DeviceOperatingModeOutcome } from './homeModeDeviceRead';

/** Persisted mode settings that the active mode is resolved against. */
export type HomeModeCatalogConfiguration = {
  aliases: Record<string, string>;
  priorities: Record<string, Record<string, number>>;
  modePriorityCatalog: ModePriorityCatalog;
  targets: Record<string, Record<string, number>>;
};

/** One accepted generation of mode settings for a single home. */
export type HomeModeCatalogSnapshot = HomeModeCatalogConfiguration & { operatingMode: string };

/** Read and write surface for a home-owned mode catalog. */
export type HomeModeCatalog = {
  getSnapshot: () => HomeModeCatalogSnapshot;
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPrioritiesForDevices: (deviceIds: readonly string[]) => ModePriorityOrder;
  resolveModeName: (name: string) => string;
  getAllModes: () => Set<string>;
  resolveOperatingModeForDevice: (
    deviceId: string,
    membershipOverride?: HomeMembershipPort,
    allowPendingOwnershipGeneration?: boolean,
  ) => DeviceOperatingModeOutcome;
  setOperatingMode: (mode: string) => { previous: string; resolved: string };
  isInitialized: () => boolean;
  reload: (allowPendingOwnershipGeneration?: boolean) => void;
};

/** Stateless read result for a catalog whose owning bundle may not be live. */
export type PersistedHomeModeCatalogRead =
  | { state: 'resolved'; snapshot: HomeModeCatalogSnapshot }
  | { state: 'legacy' }
  | { state: 'unavailable' };

const DEFAULT_MODE = 'Home';

const cloneNestedNumberMap = (
  value: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> => (
  Object.fromEntries(Object.entries(value).map(([mode, entries]) => [mode, { ...entries }]))
);

const defaultSnapshot = (): HomeModeCatalogSnapshot => ({
  operatingMode: DEFAULT_MODE,
  aliases: {},
  priorities: {},
  modePriorityCatalog: new ModePriorityCatalog(),
  targets: {},
});

const filterDeviceEntries = (
  value: Record<string, Record<string, number>>,
  ownsDevice: (deviceId: string) => boolean,
): Record<string, Record<string, number>> => (
  Object.fromEntries(Object.entries(value).map(([mode, entries]) => [
    mode,
    Object.fromEntries(Object.entries(entries).filter(([deviceId]) => ownsDevice(deviceId))),
  ]))
);

const ensureDefaultMode = (
  value: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> => (
  Object.hasOwn(value, DEFAULT_MODE)
    ? value
    : { ...value, [DEFAULT_MODE]: {} }
);

const configuredModes = (snapshot: HomeModeCatalogConfiguration): Set<string> => {
  // A mode is safe to activate only when it has a target record. Priorities
  // alone cannot provide the resume anchor a lowered thermostat needs.
  const modes = new Set(Object.keys(snapshot.targets));
  if (modes.size === 0) modes.add(DEFAULT_MODE);
  return modes;
};

const removeModeShadowingAliases = (
  snapshot: HomeModeCatalogConfiguration,
): HomeModeCatalogConfiguration => {
  const modeByLowerName = new Map(
    [...Object.keys(snapshot.priorities), ...Object.keys(snapshot.targets)]
      .map((mode) => [mode.toLowerCase(), mode]),
  );
  return {
    ...snapshot,
    aliases: Object.fromEntries(
      Object.entries(snapshot.aliases).filter(([alias, target]) => {
        const shadowedMode = modeByLowerName.get(alias.toLowerCase());
        return shadowedMode === undefined
          || shadowedMode.toLowerCase() === target.toLowerCase();
      }),
    ),
  };
};

const resolveActiveMode = (
  raw: unknown,
  fallback: string,
  snapshot: HomeModeCatalogConfiguration,
): string => {
  const modes = configuredModes(snapshot);
  const candidate = typeof raw === 'string' && raw.trim() ? raw : fallback;
  const resolved = resolveModeName(candidate, snapshot.aliases, modes);
  if (modes.has(resolved)) return resolved;
  if (modes.has(DEFAULT_MODE)) return DEFAULT_MODE;
  return [...modes].sort((left, right) => left.localeCompare(right))[0] ?? DEFAULT_MODE;
};

const readInitializationState = (
  settings: SettingsPort,
  homeId: HomeId,
): 'initialized' | 'legacy' | 'unavailable' => {
  const read = readHomeModeSetting(
    settings,
    homeScopedSettingsKey(MODE_CATALOG_INITIALIZED, homeId),
  );
  if (read.state === 'unavailable') return 'unavailable';
  if (read.value === undefined) return 'legacy';
  return read.value === true ? 'initialized' : 'unavailable';
};

const readCatalog = (
  settings: SettingsPort,
  homeId: HomeId,
): HomeModeCatalogSnapshot | null => {
  const aliasesRead = readHomeModeSetting(settings, homeScopedSettingsKey(MODE_ALIASES, homeId));
  const prioritiesRead = readHomeModeSetting(settings, homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId));
  const targetsRead = readHomeModeSetting(settings, homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId));
  const modeRead = readHomeModeSetting(
    settings,
    homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId),
  );
  if (
    aliasesRead.state === 'unavailable'
    || prioritiesRead.state === 'unavailable'
    || targetsRead.state === 'unavailable'
    || modeRead.state === 'unavailable'
  ) {
    return null;
  }
  // The initialized marker commits only after all catalog keys. A later
  // missing key is a damaged/incomplete read, not an empty preference; retain
  // the last good generation instead of silently dropping modes or targets.
  if (aliasesRead.value === undefined || prioritiesRead.value === undefined || targetsRead.value === undefined) {
    return null;
  }
  const aliases = readModeAliases(aliasesRead.value);
  const priorities = readModePriorityCatalog(prioritiesRead.value);
  const targets = sanitizeModeDeviceTargets(targetsRead.value);
  if (aliases === null || priorities === null || targets === null) return null;
  const catalog = {
    aliases,
    priorities: priorities.resolve([], []),
    modePriorityCatalog: priorities,
    // Already sanitized by the owner of this key, so the clone copies rather than repairs.
    targets: cloneNestedNumberMap(targets),
  };
  const operatingMode = resolveActiveMode(modeRead.value, DEFAULT_MODE, catalog);
  return {
    ...catalog,
    operatingMode,
    priorities: priorities.resolveConfiguration({}, targets, operatingMode),
  };
};

const readMainCatalog = (settings: SettingsPort, previous: HomeModeCatalogSnapshot): HomeModeCatalogSnapshot => {
  const aliasesRead = readHomeModeSetting(settings, MODE_ALIASES);
  const prioritiesRead = readHomeModeSetting(settings, CAPACITY_PRIORITIES);
  const targetsRead = readHomeModeSetting(settings, MODE_DEVICE_TARGETS);
  const modeRead = readHomeModeSetting(settings, OPERATING_MODE_SETTING);
  const aliases = aliasesRead.state === 'resolved' && aliasesRead.value !== undefined
    ? readModeAliases(aliasesRead.value) ?? previous.aliases
    : previous.aliases;
  const priorityCatalog = prioritiesRead.state === 'resolved' && prioritiesRead.value !== undefined
    ? readModePriorityCatalog(prioritiesRead.value) ?? previous.modePriorityCatalog
    : previous.modePriorityCatalog;
  const targets = targetsRead.state === 'resolved' && targetsRead.value !== undefined
    ? sanitizeModeDeviceTargets(targetsRead.value) ?? previous.targets
    : previous.targets;
  const catalog = {
    aliases,
    priorities: priorityCatalog.resolve([], []),
    modePriorityCatalog: priorityCatalog,
    targets: cloneNestedNumberMap(targets),
  };
  const activeMode = modeRead.state === 'resolved'
    && typeof modeRead.value === 'string' && modeRead.value.trim()
    ? modeRead.value
    : previous.operatingMode;
  const operatingMode = resolveModeName(
    activeMode,
    aliases,
    getAllModes('', priorityCatalog.resolve([], []), targets),
  );
  return {
    ...catalog,
    operatingMode,
    priorities: priorityCatalog.resolveConfiguration({}, targets, operatingMode),
  };
};

const writeInitialCatalog = (
  settings: SettingsPort,
  managedDevices: Readonly<Record<string, boolean>>,
  membership: HomeMembershipPort | undefined,
  main: HomeModeCatalogSnapshot,
  homeId: HomeId,
  allowPendingOwnershipGeneration: boolean,
): HomeModeCatalogSnapshot | null => {
  if (
    membership
    && (
      !membership.isOwnershipReady()
      || (!allowPendingOwnershipGeneration && membership.hasPendingOwnershipGeneration())
    )
  ) return null;
  const ownsDevice = (deviceId: string): boolean => (
    membership ? membership.getHomeIdForDevice(deviceId) === homeId : true
  );
  const priorities = new ModePriorityCatalog(filterDeviceEntries(main.priorities, ownsDevice)).resolveHomeConfiguration(
    managedDevices, main.targets, DEFAULT_MODE, homeId, membership,
  );
  const targets = ensureDefaultMode(filterDeviceEntries(main.targets, ownsDevice));
  const catalog = removeModeShadowingAliases({
    aliases: main.aliases,
    priorities,
    modePriorityCatalog: new ModePriorityCatalog(priorities),
    targets,
  });
  const existingMode = readHomeModeSetting(
    settings,
    homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId),
  );
  if (existingMode.state === 'unavailable') return null;
  // A new meter area starts in its own Home mode. Preserve an explicit
  // pre-migration area selection, but never inherit Main's current mode:
  // independently controlled areas must not unexpectedly begin in Away,
  // Sleep, or another load-changing Main state.
  const operatingMode = resolveActiveMode(existingMode.value, DEFAULT_MODE, catalog);
  settings.set(homeScopedSettingsKey(MODE_ALIASES, homeId), catalog.aliases);
  settings.set(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId), catalog.priorities);
  settings.set(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId), catalog.targets);
  settings.set(homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId), operatingMode);
  settings.set(homeScopedSettingsKey(MODE_CATALOG_INITIALIZED, homeId), true);
  return { ...catalog, operatingMode };
};

/** The live mode catalog for one home. It owns the accepted snapshot and its unavailable policy. */
export class HomeModeCatalogOwner implements HomeModeCatalog {
  private lastGood: HomeModeCatalogSnapshot;
  private lastLoggedMode: string;
  private initializing = false;
  private initialized = false;
  private unavailable = false;
  private readonly deviceModeResolver: HomeModeDeviceResolver;

  constructor(
    private readonly homeId: HomeId,
    private readonly settings: SettingsPort,
    private readonly getMainSnapshot: () => HomeModeCatalogSnapshot,
    private readonly getManagedDevices: () => Readonly<Record<string, boolean>>,
    private readonly getMembership: () => HomeMembershipPort | undefined,
    private readonly getLogger: () => PinoLogger | undefined,
  ) {
    this.lastGood = homeId === MAIN_HOME_ID ? defaultSnapshot() : getMainSnapshot();
    this.lastLoggedMode = this.lastGood.operatingMode;
    this.deviceModeResolver = new HomeModeDeviceResolver(
      settings, this, getManagedDevices, getMembership, readPersistedHomeModeCatalog,
    );
  }

  getSnapshot = (): HomeModeCatalogSnapshot => ({
    ...this.lastGood,
    priorities: this.lastGood.modePriorityCatalog.resolveHomeConfiguration(
      this.getManagedDevices(),
      this.lastGood.targets,
      this.lastGood.operatingMode,
      this.homeId,
      this.getMembership(),
    ),
  });

  getOperatingMode = (): string => this.lastGood.operatingMode;

  getModeDeviceTargets = (): Record<string, Record<string, number>> => this.lastGood.targets;

  getPrioritiesForDevices = (deviceIds: readonly string[]): ModePriorityOrder => (
    this.lastGood.modePriorityCatalog.getOrder(this.lastGood.operatingMode, deviceIds)
  );

  resolveModeName = (name: string): string => {
    const snapshot = this.getSnapshot();
    return resolveModeName(name, snapshot.aliases, getAllModes('', snapshot.priorities, snapshot.targets));
  };

  getAllModes = (): Set<string> => {
    const snapshot = this.getSnapshot();
    return getAllModes(snapshot.operatingMode, snapshot.priorities, snapshot.targets);
  };

  resolveOperatingModeForDevice = (
    deviceId: string,
    membershipOverride?: HomeMembershipPort,
    allowPendingOwnershipGeneration = false,
  ): DeviceOperatingModeOutcome => this.deviceModeResolver.resolve(
    deviceId, membershipOverride, allowPendingOwnershipGeneration,
  );

  setOperatingMode = (mode: string): { previous: string; resolved: string } => {
    const previous = this.lastGood.operatingMode;
    const resolved = this.resolveModeName(mode);
    this.settings.set(homeScopedSettingsKey(OPERATING_MODE_SETTING, this.homeId), resolved);
    this.reload();
    return { previous, resolved };
  };

  isInitialized = (): boolean => this.initialized;

  reload = (allowPendingOwnershipGeneration = false): void => {
    if (this.initializing) return;
    try {
      if (this.homeId === MAIN_HOME_ID) {
        this.lastGood = readMainCatalog(this.settings, this.lastGood);
        this.initialized = true;
      } else if (!this.reloadSubHome(allowPendingOwnershipGeneration)) {
        return;
      }
      this.unavailable = false;
      this.logModeChange();
    } catch (error) {
      this.logFailure(error);
    }
  };

  private reloadSubHome(allowPendingOwnershipGeneration: boolean): boolean {
    const initializationState = readInitializationState(this.settings, this.homeId);
    if (initializationState === 'unavailable') {
      this.logFailure();
      return false;
    }
    this.initialized = initializationState === 'initialized';
    if (this.initialized) {
      const next = readCatalog(this.settings, this.homeId);
      if (next === null) {
        this.logFailure();
        return false;
      }
      this.lastGood = next;
      return true;
    }

    this.initializing = true;
    try {
      const initializedCatalog = writeInitialCatalog(
        this.settings,
        this.getManagedDevices(),
        this.getMembership(),
        this.getMainSnapshot(),
        this.homeId,
        allowPendingOwnershipGeneration,
      );
      this.initialized = initializedCatalog !== null;
      if (initializedCatalog === null) {
        this.lastGood = this.getMainSnapshot();
        return false;
      }
      this.lastGood = initializedCatalog;
      // This home's first mode is its baseline, not a transition from the
      // Main home's mode used to seed the initial catalog.
      this.lastLoggedMode = initializedCatalog.operatingMode;
      return true;
    } finally {
      this.initializing = false;
    }
  }

  private logFailure(error?: unknown): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.getLogger()?.warn({
      event: 'home_mode_catalog_unavailable',
      homeId: this.homeId,
      err: error,
    });
  }

  private logModeChange(): void {
    // Main mode changes use the global settings path; this edge event records
    // transitions between independently controlled per-home catalogs only.
    if (this.homeId === MAIN_HOME_ID || this.lastGood.operatingMode === this.lastLoggedMode) return;
    this.getLogger()?.info({
      event: 'home_operating_mode_changed',
      homeId: this.homeId,
      mode: this.lastGood.operatingMode,
      previousMode: this.lastLoggedMode,
      source: 'per_home',
    });
    this.lastLoggedMode = this.lastGood.operatingMode;
  }
}

export const createHomeModeCatalog = (
  homeId: HomeId,
  settings: SettingsPort,
  getMainSnapshot: () => HomeModeCatalogSnapshot,
  getManagedDevices: () => Readonly<Record<string, boolean>>,
  getMembership: () => HomeMembershipPort | undefined,
  getLogger: () => PinoLogger | undefined,
): HomeModeCatalog => {
  const catalog = new HomeModeCatalogOwner(
    homeId, settings, getMainSnapshot, getManagedDevices, getMembership, getLogger,
  );
  // Main has no registry insertion barrier. A sub-home is reloaded only after
  // HomeRuntimeRegistry has published its bundle, so marker-last writes cannot
  // synchronously re-enter reconciliation while that bundle is being built.
  if (homeId === MAIN_HOME_ID) catalog.reload();
  return catalog;
};

/**
 * Stateless device-support read. Unlike a bundle it has no last-good snapshot
 * to hold, so any malformed/failed initialized read is explicitly unavailable.
 */
export const readPersistedHomeModeCatalog = (
  settings: SettingsPort,
  homeId: HomeId,
  managedDevices: Readonly<Record<string, boolean>>,
  membership: HomeMembershipPort | undefined,
): PersistedHomeModeCatalogRead => {
  try {
    const initializationState = readInitializationState(settings, homeId);
    if (initializationState === 'unavailable') return { state: 'unavailable' };
    if (initializationState === 'legacy') return { state: 'legacy' };
    const snapshot = readCatalog(settings, homeId);
    return snapshot === null ? { state: 'unavailable' } : {
      state: 'resolved',
      snapshot: {
        ...snapshot,
        priorities: snapshot.modePriorityCatalog.resolveHomeConfiguration(
          managedDevices, snapshot.targets, snapshot.operatingMode, homeId, membership,
        ),
      },
    };
  } catch {
    return { state: 'unavailable' };
  }
};
