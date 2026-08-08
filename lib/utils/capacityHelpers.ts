import type { ShedAction, ShedBehavior } from '../plan/planTypes';

/**
 * Resolve a retained mode name through rename aliases.
 *
 * Alias targets that still name a configured mode are terminal. That rule is
 * load-bearing for swaps: with `{ home: 'Work', away: 'Home' }` and both
 * `Work` and `Home` configured, old `Away` must stop at the current `Home`
 * mode instead of following `home` onward to `Work`. A non-terminal target is
 * a rename-chain hop (`Cooler → Chill → Cold` after `Chill` was removed).
 * Cycles fall back to the originally requested name so malformed persisted
 * aliases cannot loop or choose an arbitrary intermediate mode.
 */
export function resolveModeName(
  name: string,
  modeAliases: Record<string, string>,
  configuredModes: ReadonlySet<string>,
): string {
  const requested = name.trim();
  let current = requested;
  const visited = new Set<string>();
  while (current) {
    const aliasKey = current.toLowerCase();
    if (visited.has(aliasKey)) return requested;
    visited.add(aliasKey);
    if (!Object.hasOwn(modeAliases, aliasKey)) return current;
    const mappedRaw = modeAliases[aliasKey];
    if (typeof mappedRaw !== 'string') return current;
    const mapped = mappedRaw.trim();
    if (!mapped) return current;
    if (configuredModes.has(mapped)) return mapped;
    current = mapped;
  }
  return requested;
}

export function getAllModes(
  operatingMode: string,
  capacityPriorities: Record<string, Record<string, number>>,
  modeDeviceTargets: Record<string, Record<string, number>>,
): Set<string> {
  const modes = new Set<string>();
  if (operatingMode) modes.add(operatingMode);
  Object.keys(capacityPriorities || {}).forEach((mode) => {
    if (mode && mode.trim()) modes.add(mode);
  });
  Object.keys(modeDeviceTargets || {}).forEach((mode) => {
    if (mode && mode.trim()) modes.add(mode);
  });
  return modes;
}

/**
 * Why a per-home pin could not be honored: `unconfigured_mode` is a pinned
 * name with no `mode_device_targets` record; `malformed_pin` is a persisted
 * value that is not even a string (corrupt settings input — an explicit
 * semantic result per the boundary rules, never conflated with absence).
 */
export type HomeOperatingModeFault =
  | { reason: 'unconfigured_mode'; requestedMode: string }
  | { reason: 'malformed_pin'; valueType: string };

/**
 * One home's effective operating mode. `source` says whether the home is on
 * its own pinned mode or following the global (main) mode; `fault` is set only
 * when a pinned mode had to be refused (see `resolveHomeOperatingMode`).
 */
export type HomeOperatingModeResolution = {
  mode: string;
  source: 'per_home' | 'global';
  fault: HomeOperatingModeFault | null;
};

const describePinValueType = (value: unknown): string => (
  Array.isArray(value) ? 'array' : typeof value
);

/**
 * Resolve one sub-home's effective operating mode (multi-home).
 *
 * Resolution chain, boundary-validated here so every downstream consumer
 * (planner, executor, priority resolver) can index the global
 * `mode_device_targets` blob without re-validating:
 *
 * 1. `perHomeModeRaw` (the untrusted `operating_mode:<homeId>` read) that is
 *    `undefined`, `null`, or a blank string is genuine absence: the home
 *    follows `globalMode`. Any OTHER non-string value is malformed persisted
 *    input — the home still fails safe onto `globalMode`, but with a distinct
 *    `malformed_pin` fault so the corruption is surfaced instead of read as an
 *    intentional unpin (AGENTS.md: malformed persisted input must become an
 *    explicit semantic result, never the same value as genuine absence).
 * 2. A pinned mode is alias-resolved, then constrained to the mode-targets
 *    blob's own key set. That constraint is what keeps the planner's
 *    `modeDeviceTargets[mode] || {}` fallthrough unreachable for a pinned
 *    mode — an unknown mode name must NOT silently become "no targets"
 *    (empty targets re-open the stuck-cold restore bug PR #1886 fixed).
 * 3. A pinned mode outside that key set falls back to `globalMode` and is
 *    surfaced as a fault — unless it already names the global mode, in which
 *    case honoring it and falling back are the same thing (main-parity
 *    behaviour, no fault).
 */
export function resolveHomeOperatingMode(params: {
  perHomeModeRaw: unknown;
  globalMode: string;
  resolveAlias: (name: string) => string;
  modeDeviceTargets: Record<string, Record<string, number>>;
}): HomeOperatingModeResolution {
  const { perHomeModeRaw, globalMode, resolveAlias, modeDeviceTargets } = params;
  if (perHomeModeRaw === undefined || perHomeModeRaw === null
    || (typeof perHomeModeRaw === 'string' && !perHomeModeRaw.trim())) {
    return { mode: globalMode, source: 'global', fault: null };
  }
  if (typeof perHomeModeRaw !== 'string') {
    return {
      mode: globalMode,
      source: 'global',
      fault: { reason: 'malformed_pin', valueType: describePinValueType(perHomeModeRaw) },
    };
  }
  const requested = resolveAlias(perHomeModeRaw.trim());
  // Own-key check (never the prototype chain): a stored '__proto__' or
  // 'constructor' must not resolve through Object.prototype.
  if (Object.hasOwn(modeDeviceTargets, requested)) {
    return { mode: requested, source: 'per_home', fault: null };
  }
  if (requested === globalMode) {
    return { mode: globalMode, source: 'global', fault: null };
  }
  return {
    mode: globalMode,
    source: 'global',
    fault: { requestedMode: requested, reason: 'unconfigured_mode' },
  };
}

/**
 * The single definition of "a device's priority under a mode": the mode's
 * priority record (empty mode falls into the historical 'Home' bucket), with
 * 100 (lowest importance tier) for a device the mode does not rank. The main
 * home resolves this against the global mode (`PelsApp.getPriorityForDevice`);
 * a sub-home scope resolves it against its OWN effective mode.
 */
export function resolveDevicePriority(
  capacityPriorities: Record<string, Record<string, number>>,
  operatingMode: string,
  deviceId: string,
): number {
  return resolveConfiguredDevicePriority(capacityPriorities, operatingMode, deviceId) ?? 100;
}

/**
 * Read the stored priority without applying the legacy default tier.
 *
 * Active-set rankers need to distinguish an explicitly saved rank `100` from
 * a device that has no catalog entry at all. Concrete planner-policy reads keep
 * using `resolveDevicePriority`, which preserves the historical `100` fallback.
 */
export function resolveConfiguredDevicePriority(
  capacityPriorities: Record<string, Record<string, number>>,
  operatingMode: string,
  deviceId: string,
): number | undefined {
  return capacityPriorities[operatingMode || 'Home']?.[deviceId];
}

export function normalizeShedBehaviors(input: unknown): Record<string, ShedBehavior> {
  if (!isRecord(input)) return {};
  const entries = Object.entries(input).flatMap(([deviceId, raw]) => {
    if (!raw || typeof raw !== 'object') return [];
    const candidate = raw as { action?: unknown; temperature?: unknown; stepId?: unknown };
    let action: ShedAction = 'turn_off';
    if (candidate.action === 'set_temperature') {
      action = 'set_temperature';
    } else if (candidate.action === 'set_step') {
      action = 'set_step';
    }
    const tempRaw = candidate.temperature;
    const temperature = typeof tempRaw === 'number' && Number.isFinite(tempRaw)
      ? Math.max(-50, Math.min(50, tempRaw))
      : undefined;
    let behavior: ShedBehavior = { action: 'turn_off' };
    if (action === 'set_temperature' && typeof temperature === 'number') {
      behavior = { action, temperature };
    } else if (action === 'set_step') {
      behavior = { action };
    }
    return [[deviceId, behavior]];
  });
  return Object.fromEntries(entries);
}

export function getShedBehavior(
  deviceId: string,
  shedBehaviors: Record<string, ShedBehavior>,
): { action: ShedAction; temperature: number | null; stepId: string | null } {
  const behavior = shedBehaviors[deviceId];
  let action: ShedAction = 'turn_off';
  if (behavior?.action === 'set_temperature') {
    action = 'set_temperature';
  } else if (behavior?.action === 'set_step') {
    action = 'set_step';
  }
  const temp = behavior?.temperature;
  const temperature = Number.isFinite(temp) ? Math.max(-50, Math.min(50, Number(temp))) : null;
  const stepId = typeof behavior?.stepId === 'string' && behavior.stepId.trim() ? behavior.stepId.trim() : null;
  return { action, temperature, stepId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
