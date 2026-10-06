import {
  normalizeModePriorities,
  rankActiveDevicePriorities,
  type ModePriorities,
} from '../modePriorities';

/**
 * Owner of capacity_priorities on both Homey's runtime and the settings bridge.
 * Persisted preferences stay private; every published catalog orders every known
 * device in every mode. Loading and discovery need no owner confirmation.
 */
const isPriorityRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const parseModePriorities = (value: unknown): ModePriorities | null => {
  if (!isPriorityRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, priorities]) => (
    isPriorityRecord(priorities)
    && Object.values(priorities).every((priority) => typeof priority === 'number' && Number.isFinite(priority))
  ))) return null;
  return value as ModePriorities;
};

/** A total order for one explicit device set. */
export type ModePriorityOrder = {
  getPriority: (deviceId: string) => number;
};

const createPriorityOrder = (ranks: Readonly<Record<string, number>>): ModePriorityOrder => ({
  getPriority(deviceId) {
    const rank = ranks[deviceId];
    if (rank === undefined) throw new Error(`Device ${deviceId} is outside the priority order`);
    return rank;
  },
});

/** Membership is already classified by the home owner in either runtime. */
type ModePriorityMembership = {
  getHomeIdForDevice: (deviceId: string) => string;
};

const configurationDeviceIds = (
  managedDevices: Readonly<Record<string, boolean>>,
  targets: ModePriorities,
): string[] => [
  ...Object.keys(managedDevices).filter((deviceId) => managedDevices[deviceId] === true),
  ...Object.values(targets).flatMap(Object.keys),
];

/** Admitted preferences are immutable; every query receives a complete, detached order. */
export class ModePriorityCatalog {
  private readonly preferences: ModePriorities;

  constructor(value: ModePriorities = {}) {
    this.preferences = normalizeModePriorities(value);
  }

  /**
   * Complete catalog, including retained device preferences needed by mode edits.
   * Only the owning home's devices may cross this boundary.
   */
  resolve(
    deviceIds: readonly string[],
    modes: readonly string[],
    ownsDevice: (deviceId: string) => boolean = () => true,
  ): ModePriorities {
    const knownIds = [...new Set([
      ...Object.values(this.preferences).flatMap(Object.keys), ...deviceIds,
    ])].filter(ownsDevice);
    return this.order(knownIds, modes);
  }

  /** Complete the configuration from the maps its two setting owners have admitted. */
  resolveConfiguration(
    managedDevices: Readonly<Record<string, boolean>>,
    targets: ModePriorities,
    activeMode: string,
  ): ModePriorities {
    return this.resolve(configurationDeviceIds(managedDevices, targets), [activeMode, ...Object.keys(targets)]);
  }

  /**
   * The browser and runtime publish the same home-scoped catalog. Before the
   * runtime installs membership, its legacy catalog remains unscoped; ownership
   * readiness separately fences planning/migration during that boot window.
   */
  resolveHomeConfiguration(
    managedDevices: Readonly<Record<string, boolean>>,
    targets: ModePriorities,
    activeMode: string,
    homeId: string,
    membership: ModePriorityMembership | undefined,
  ): ModePriorities {
    return this.resolve(
      configurationDeviceIds(managedDevices, targets), [activeMode, ...Object.keys(targets)],
      (deviceId) => (membership?.getHomeIdForDevice(deviceId) ?? homeId) === homeId,
    );
  }

  modes(): readonly string[] { return Object.keys(this.preferences); }

  /**
   * The preferences with a rank for every device that has none in a mode, or
   * `null` when every device is already ranked in every mode. Ranked devices
   * keep their order. New devices go after them in device-id order, which is
   * the order `rankActiveDevicePriorities` already infers, except that a
   * device `sortsLastWhenUnranked` marks (a home battery) keeps the bottom: new
   * devices go above the batteries at the bottom of a mode, and new batteries
   * go last. A battery the owner moved up is not at the bottom, so new devices
   * go to the true end below it.
   *
   * The bottom is found from the devices that count: a stored rank for a
   * device in neither `deviceIds` nor the batteries (one no longer managed, or
   * removed) does not mark where the batteries end, so new devices still go
   * just after the last counted device above them.
   */
  withMissingRanks(
    deviceIds: readonly string[],
    modes: readonly string[],
    sortsLastWhenUnranked: (deviceId: string) => boolean,
  ): ModePriorities | null {
    const sortedIds = [...new Set(deviceIds)].sort();
    const listed = new Set(sortedIds);
    const anchorsTop = (id: string): boolean => listed.has(id) && !sortsLastWhenUnranked(id);
    const allModes = [...new Set([...Object.keys(this.preferences), ...modes])];
    const filled = allModes.map((mode) => {
      const ranks = this.preferences[mode] ?? {};
      const missing = sortedIds.filter((deviceId) => ranks[deviceId] === undefined);
      const ranked = Object.keys(ranks).sort((a, b) => ((ranks[a] ?? 0) - (ranks[b] ?? 0)) || (a < b ? -1 : 1));
      // Everything after the last counted non-battery device is the bottom,
      // when a battery is there; with none, new devices go to the true end.
      const lastAnchorEnd = ranked.reduce((end, id, index) => (anchorsTop(id) ? index + 1 : end), 0);
      const bottomStart = ranked.slice(lastAnchorEnd).some(sortsLastWhenUnranked) ? lastAnchorEnd : ranked.length;
      const top = ranked.slice(0, bottomStart);
      const bottom = ranked.slice(bottomStart);
      const order = [
        ...top,
        ...missing.filter((id) => !sortsLastWhenUnranked(id)),
        ...bottom,
        ...missing.filter(sortsLastWhenUnranked),
      ];
      const filledRanks = Object.fromEntries(order.map((id, index) => [id, index + 1]));
      return { mode, ranks: filledRanks, missingCount: missing.length };
    });
    if (filled.every(({ missingCount }) => missingCount === 0)) return null;
    return Object.fromEntries(filled.map(({ mode, ranks }) => [mode, ranks]));
  }

  /**
   * `sortsLastWhenUnranked` marks the devices that go after every other
   * unranked device (a home battery): see `rankActiveDevicePriorities`.
   */
  getOrder(
    mode: string,
    deviceIds: readonly string[],
    sortsLastWhenUnranked: (deviceId: string) => boolean,
  ): ModePriorityOrder {
    return createPriorityOrder(rankActiveDevicePriorities(
      deviceIds, (deviceId) => this.preferences[mode]?.[deviceId], sortsLastWhenUnranked,
    ));
  }

  /** Compact relative ranks for the current home/device roster, without stale entries. */
  private order(deviceIds: readonly string[], modes: readonly string[]): ModePriorities {
    const knownModes = new Set([...Object.keys(this.preferences), ...modes]);
    return Object.fromEntries([...knownModes].map((mode) => [
      mode,
      rankActiveDevicePriorities(deviceIds, (deviceId) => this.preferences[mode]?.[deviceId]),
    ]));
  }
}

/** External settings read: callers retain their owning catalog when this is unavailable. */
export const readModePriorityCatalog = (value: unknown): ModePriorityCatalog | null => {
  const priorities = parseModePriorities(value);
  return priorities === null ? null : new ModePriorityCatalog(priorities);
};
