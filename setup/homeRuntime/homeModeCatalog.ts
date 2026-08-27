/**
 * Settings-backed mode catalog for one meter area.
 *
 * Main keeps the historical unsuffixed catalog on AppContext. Each meter area
 * owns a coherent suffixed snapshot after `mode_catalog_initialized:<homeId>`
 * is written. The marker is committed last so a partial migration can never be
 * mistaken for an independent catalog. Until then, the area deliberately keeps
 * the legacy Main snapshot as a compatibility fallback.
 */
import type Homey from 'homey';
import type { AppContext } from '../../lib/app/appContext';
import {
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MODE_ALIASES,
  MODE_CATALOG_INITIALIZED,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  homeScopedSettingsKey,
  type HomeId,
} from '../../lib/utils/settingsKeys';
import {
  resolveConfiguredDevicePriority,
  resolveModeName,
} from '../../lib/utils/capacityHelpers';
import {
  isModeDeviceTargets,
  isPrioritySettings,
  isStringMap,
} from '../../lib/utils/appTypeGuards';
import { normalizeModePriorities } from '../../packages/shared-domain/src/modePriorities';

export type HomeModeCatalogSnapshot = {
  operatingMode: string;
  aliases: Record<string, string>;
  priorities: Record<string, Record<string, number>>;
  targets: Record<string, Record<string, number>>;
};

export type HomeModeCatalog = {
  getSnapshot: () => HomeModeCatalogSnapshot;
  isInitialized: () => boolean;
  reload: (allowPendingOwnershipGeneration?: boolean) => void;
};

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

const mainSnapshot = (ctx: AppContext): HomeModeCatalogSnapshot => ({
  operatingMode: ctx.operatingMode,
  aliases: { ...ctx.modeAliases },
  priorities: cloneNestedNumberMap(ctx.capacityPriorities),
  targets: cloneNestedNumberMap(ctx.modeDeviceTargets),
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

const normalizeAliases = (value: Record<string, string>): Record<string, string> => (
  Object.fromEntries(Object.entries(value).map(([key, alias]) => [key.toLowerCase(), alias]))
);

const configuredModes = (snapshot: Omit<HomeModeCatalogSnapshot, 'operatingMode'>): Set<string> => {
  // A mode is safe to activate only when it has a target record. Priorities
  // alone cannot provide the resume anchor a lowered thermostat needs.
  const modes = new Set(Object.keys(snapshot.targets));
  if (modes.size === 0) modes.add(DEFAULT_MODE);
  return modes;
};

const removeModeShadowingAliases = (
  aliases: Record<string, string>,
  snapshot: Omit<HomeModeCatalogSnapshot, 'operatingMode' | 'aliases'>,
): Record<string, string> => {
  const modeByLowerName = new Map(
    [...Object.keys(snapshot.priorities), ...Object.keys(snapshot.targets)]
      .map((mode) => [mode.toLowerCase(), mode]),
  );
  return Object.fromEntries(
    Object.entries(aliases).filter(([alias, target]) => {
      const shadowedMode = modeByLowerName.get(alias.toLowerCase());
      return shadowedMode === undefined
        || shadowedMode.toLowerCase() === target.toLowerCase();
    }),
  );
};

const resolveActiveMode = (
  raw: unknown,
  fallback: string,
  snapshot: Omit<HomeModeCatalogSnapshot, 'operatingMode'>,
): string => {
  const modes = configuredModes(snapshot);
  const candidate = typeof raw === 'string' && raw.trim() ? raw : fallback;
  const resolved = resolveModeName(candidate, snapshot.aliases, modes);
  if (modes.has(resolved)) return resolved;
  if (modes.has(DEFAULT_MODE)) return DEFAULT_MODE;
  return [...modes].sort((left, right) => left.localeCompare(right))[0] ?? DEFAULT_MODE;
};

const readOptionalSetting = (
  settings: Homey.App['homey']['settings'],
  key: string,
): { state: 'resolved'; value: unknown } | { state: 'unavailable' } => {
  const value = settings.get(key) as unknown;
  if (value !== undefined && value !== null) return { state: 'resolved', value };
  const keys = settings.getKeys() as unknown;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((entry) => typeof entry === 'string')) {
    return { state: 'unavailable' };
  }
  if (!keys.includes(key)) return { state: 'resolved', value: undefined };
  // The SDK answers an unwritten setting with null (observed on Homey Pro and
  // Self-Hosted Server); object doubles in specs may answer undefined, so both
  // are classified as absence — see setup/AGENTS.md. The key list is the
  // authority for absence: a present null remains an explicit value for
  // optional pins (and invalid for the boolean initialization marker), while a
  // fulfilled undefined for a present key stays suspect.
  return value === null
    ? { state: 'resolved', value }
    : { state: 'unavailable' };
};

const readInitializationState = (
  settings: Homey.App['homey']['settings'],
  homeId: HomeId,
): 'initialized' | 'legacy' | 'unavailable' => {
  const read = readOptionalSetting(
    settings,
    homeScopedSettingsKey(MODE_CATALOG_INITIALIZED, homeId),
  );
  if (read.state === 'unavailable') return 'unavailable';
  if (read.value === undefined) return 'legacy';
  return read.value === true ? 'initialized' : 'unavailable';
};

const readCatalog = (
  settings: Homey.App['homey']['settings'],
  homeId: HomeId,
): HomeModeCatalogSnapshot | null => {
  const aliasesRaw = settings.get(homeScopedSettingsKey(MODE_ALIASES, homeId)) as unknown;
  const prioritiesRaw = settings.get(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId)) as unknown;
  const targetsRaw = settings.get(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId)) as unknown;
  const modeRead = readOptionalSetting(
    settings,
    homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId),
  );
  if (modeRead.state === 'unavailable') return null;
  if (!isStringMap(aliasesRaw) || !isPrioritySettings(prioritiesRaw) || !isModeDeviceTargets(targetsRaw)) {
    return null;
  }
  const catalog = {
    aliases: normalizeAliases(aliasesRaw),
    priorities: normalizeModePriorities(prioritiesRaw),
    targets: cloneNestedNumberMap(targetsRaw),
  };
  return {
    ...catalog,
    operatingMode: resolveActiveMode(modeRead.value, DEFAULT_MODE, catalog),
  };
};

const writeInitialCatalog = (
  ctx: AppContext,
  homeId: HomeId,
  allowPendingOwnershipGeneration: boolean,
): HomeModeCatalogSnapshot | null => {
  const membership = ctx.homeMembership;
  if (
    membership
    && (
      !membership.isOwnershipReady()
      || (!allowPendingOwnershipGeneration && membership.hasPendingOwnershipGeneration())
    )
  ) return null;
  const main = mainSnapshot(ctx);
  const ownsDevice = (deviceId: string): boolean => (
    membership ? membership.getHomeIdForDevice(deviceId) === homeId : true
  );
  const priorities = normalizeModePriorities(ensureDefaultMode(
      filterDeviceEntries(main.priorities, ownsDevice),
  ));
  const targets = ensureDefaultMode(filterDeviceEntries(main.targets, ownsDevice));
  const catalog = {
    aliases: removeModeShadowingAliases(main.aliases, { priorities, targets }),
    priorities,
    targets,
  };
  const existingMode = readOptionalSetting(
    ctx.homey.settings,
    homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId),
  );
  if (existingMode.state === 'unavailable') return null;
  // A new meter area starts in its own Home mode. Preserve an explicit
  // pre-migration area selection, but never inherit Main's current mode:
  // independently controlled areas must not unexpectedly begin in Away,
  // Sleep, or another load-changing Main state.
  const operatingMode = resolveActiveMode(existingMode.value, DEFAULT_MODE, catalog);
  ctx.homey.settings.set(homeScopedSettingsKey(MODE_ALIASES, homeId), catalog.aliases);
  ctx.homey.settings.set(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId), catalog.priorities);
  ctx.homey.settings.set(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId), catalog.targets);
  ctx.homey.settings.set(homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId), operatingMode);
  ctx.homey.settings.set(homeScopedSettingsKey(MODE_CATALOG_INITIALIZED, homeId), true);
  return { ...catalog, operatingMode };
};

export const createHomeModeCatalog = (ctx: AppContext, homeId: HomeId): HomeModeCatalog => {
  let lastGood = mainSnapshot(ctx);
  let lastLoggedMode = lastGood.operatingMode;
  let initializing = false;
  let initialized = false;
  let unavailable = false;
  const logFailure = (error?: unknown): void => {
    if (unavailable) return;
    unavailable = true;
    ctx.getStructuredLogger('homes')?.warn({
      event: 'home_mode_catalog_unavailable',
      homeId,
      err: error,
    });
  };
  const reload = (allowPendingOwnershipGeneration = false): void => {
    if (initializing) return;
    try {
      const initializationState = readInitializationState(ctx.homey.settings, homeId);
      if (initializationState === 'unavailable') {
        logFailure();
        return;
      }
      initialized = initializationState === 'initialized';
      if (!initialized) {
        initializing = true;
        try {
          const initializedCatalog = writeInitialCatalog(
            ctx,
            homeId,
            allowPendingOwnershipGeneration,
          );
          initialized = initializedCatalog !== null;
          if (initializedCatalog !== null) unavailable = false;
          lastGood = initializedCatalog ?? mainSnapshot(ctx);
        } finally {
          initializing = false;
        }
        return;
      }
      const next = readCatalog(ctx.homey.settings, homeId);
      if (next === null) {
        logFailure();
        return;
      }
      unavailable = false;
      lastGood = next;
    } catch (error) {
      logFailure(error);
    }
    if (lastGood.operatingMode !== lastLoggedMode) {
      ctx.getStructuredLogger('homes')?.info({
        event: 'home_operating_mode_changed',
        homeId,
        mode: lastGood.operatingMode,
        previousMode: lastLoggedMode,
        source: 'per_home',
      });
      lastLoggedMode = lastGood.operatingMode;
    }
  };
  // Read an already-initialized catalog immediately. An unwritten catalog is
  // initialized only after its bundle is registered, via `reload`.
  try {
    if (readInitializationState(ctx.homey.settings, homeId) === 'initialized') {
      initialized = true;
      lastGood = readCatalog(ctx.homey.settings, homeId) ?? lastGood;
    }
  } catch {
    // The legacy Main snapshot remains the safe compatibility fallback.
  }
  return {
    getSnapshot: () => lastGood,
    isInitialized: () => initialized,
    reload,
  };
};

export const getConfiguredPriorityFromHomeModeCatalog = (
  catalog: HomeModeCatalogSnapshot,
  deviceId: string,
): number | undefined => resolveConfiguredDevicePriority(catalog.priorities, catalog.operatingMode, deviceId);

export type ModeOwnershipMove = {
  deviceId: string;
  fromHomeId: HomeId;
  toHomeId: HomeId;
};
type ModeOwnershipTransferResult = {
  completedDeviceIds: string[];
  failedDeviceIds: string[];
};

const readCatalogForTransfer = (
  ctx: AppContext,
  homeId: HomeId,
): HomeModeCatalogSnapshot | null => {
  if (homeId === MAIN_HOME_ID) return mainSnapshot(ctx);
  const read = readPersistedHomeModeCatalog(ctx, homeId);
  return read.state === 'resolved' ? read.snapshot : null;
};

const resolveTransferAnchor = (
  catalog: HomeModeCatalogSnapshot,
  deviceId: string,
): number | null => {
  const candidates = [
    catalog.targets[catalog.operatingMode]?.[deviceId],
    catalog.targets[DEFAULT_MODE]?.[deviceId],
    ...Object.values(catalog.targets).map((targets) => targets[deviceId]),
  ];
  return candidates.find((value) => typeof value === 'number' && Number.isFinite(value)) ?? null;
};

const transferModeTargetForOwnershipMove = (
  ctx: AppContext,
  move: ModeOwnershipMove,
): boolean => {
  try {
    const source = readCatalogForTransfer(ctx, move.fromHomeId);
    const destination = readCatalogForTransfer(ctx, move.toHomeId);
    if (!source || !destination) return false;
    const anchor = resolveTransferAnchor(source, move.deviceId);
    // A temperature device can legitimately predate mode-target configuration.
    // There is then no persisted control value to carry; the destination's
    // normal catalog initialization owns its eventual default.
    if (anchor === null) return true;
    const destinationTargets = Object.keys(destination.targets).length === 0
      ? { [DEFAULT_MODE]: {} }
      : destination.targets;
    const changed = Object.keys(destination.targets).length === 0
      || Object.values(destination.targets).some((targets) => targets[move.deviceId] === undefined);
    if (!changed) return true;
    const nextTargets = Object.fromEntries(
      Object.entries(destinationTargets).map(([mode, targets]) => [
        mode,
        { ...targets, [move.deviceId]: targets[move.deviceId] ?? anchor },
      ]),
    );
    ctx.homey.settings.set(
      homeScopedSettingsKey(MODE_DEVICE_TARGETS, move.toHomeId),
      nextTargets,
    );
    if (move.toHomeId === MAIN_HOME_ID) ctx.loadCapacitySettings();
    return true;
  } catch {
    return false;
  }
};

/**
 * Carry the last configured target anchor with a device before its new owner
 * rebuilds. Reusing a persisted source target is essential: the live setpoint
 * may currently be the lowered control value and must never become the new
 * area's permanent resume target.
 */
export const transferModeTargetsForOwnershipMoves = (
  ctx: AppContext,
  moves: readonly ModeOwnershipMove[],
): ModeOwnershipTransferResult => {
  return moves.reduce<ModeOwnershipTransferResult>((result, move) => {
    const completed = transferModeTargetForOwnershipMove(ctx, move);
    return completed
      ? { ...result, completedDeviceIds: [...result.completedDeviceIds, move.deviceId] }
      : { ...result, failedDeviceIds: [...result.failedDeviceIds, move.deviceId] };
  }, { completedDeviceIds: [], failedDeviceIds: [] });
};

/**
 * Stateless device-support read. Unlike a bundle it has no last-good snapshot
 * to hold, so any malformed/failed initialized read is explicitly unavailable.
 */
export const readPersistedHomeModeCatalog = (
  ctx: AppContext,
  homeId: HomeId,
): PersistedHomeModeCatalogRead => {
  try {
    const initializationState = readInitializationState(ctx.homey.settings, homeId);
    if (initializationState === 'unavailable') return { state: 'unavailable' };
    if (initializationState === 'legacy') return { state: 'legacy' };
    const snapshot = readCatalog(ctx.homey.settings, homeId);
    return snapshot === null ? { state: 'unavailable' } : { state: 'resolved', snapshot };
  } catch {
    return { state: 'unavailable' };
  }
};
