import type {
  ModeOwnershipMove,
  ModeOwnershipTransferResult,
} from './modeOwnershipTransfer';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { HomeMembershipPort } from './membership';
import {
  MAIN_HOME_ID,
  MODE_DEVICE_TARGETS,
  homeScopedSettingsKey,
  type HomeId,
} from '../utils/settingsKeys';
import {
  readPersistedHomeModeCatalog,
  type HomeModeCatalog,
  type HomeModeCatalogSnapshot,
} from './homeModeCatalog';

const DEFAULT_MODE = 'Home';

const readCatalogForTransfer = (
  settings: SettingsPort,
  mainCatalog: HomeModeCatalog,
  getManagedDevices: () => Readonly<Record<string, boolean>>,
  getMembership: () => HomeMembershipPort | undefined,
  homeId: HomeId,
): HomeModeCatalogSnapshot | null => {
  if (homeId === MAIN_HOME_ID) return mainCatalog.getSnapshot();
  const read = readPersistedHomeModeCatalog(settings, homeId, getManagedDevices(), getMembership());
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
  settings: SettingsPort,
  mainCatalog: HomeModeCatalog,
  getManagedDevices: () => Readonly<Record<string, boolean>>,
  getMembership: () => HomeMembershipPort | undefined,
  move: ModeOwnershipMove,
): boolean => {
  try {
    const source = readCatalogForTransfer(settings, mainCatalog, getManagedDevices, getMembership, move.fromHomeId);
    const destination = readCatalogForTransfer(settings, mainCatalog, getManagedDevices, getMembership, move.toHomeId);
    if (!source || !destination) return false;
    const anchor = resolveTransferAnchor(source, move.deviceId);
    // A temperature device can predate mode-target configuration. Its normal
    // destination catalog initialization owns the eventual default.
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
    settings.set(homeScopedSettingsKey(MODE_DEVICE_TARGETS, move.toHomeId), nextTargets);
    if (move.toHomeId === MAIN_HOME_ID) mainCatalog.reload();
    return true;
  } catch {
    return false;
  }
};

/** Carry each device's configured resume target to its new home before rebuilding. */
export const transferModeTargetsForOwnershipMoves = (
  settings: SettingsPort,
  mainCatalog: HomeModeCatalog,
  getManagedDevices: () => Readonly<Record<string, boolean>>,
  getMembership: () => HomeMembershipPort | undefined,
  moves: readonly ModeOwnershipMove[],
): ModeOwnershipTransferResult => moves.reduce<ModeOwnershipTransferResult>((result, move) => {
  const completed = transferModeTargetForOwnershipMove(
    settings, mainCatalog, getManagedDevices, getMembership, move,
  );
  return completed
    ? { ...result, completedDeviceIds: [...result.completedDeviceIds, move.deviceId] }
    : { ...result, failedDeviceIds: [...result.failedDeviceIds, move.deviceId] };
}, { completedDeviceIds: [], failedDeviceIds: [] });
