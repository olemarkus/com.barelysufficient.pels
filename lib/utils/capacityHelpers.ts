import type { ShedAction } from '../plan/planTypes';
import { COOLING_SHED_DEFAULT_C } from '../../packages/shared-domain/src/utils/airtreatmentConstants';

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
 * Read the stored priority for a device under a mode (empty mode falls into the
 * historical 'Home' bucket). `undefined` means the owner has never ranked it —
 * NOT a low rank.
 *
 * This is a stored-state read, not an answer: priority is a property of a SET,
 * so the rank a consumer acts on comes from the mode catalog owner
 * (`packages/shared-domain/src/modeCatalogResolution.ts`), which ranks the whole
 * set strictly. There used to be a `resolveDevicePriority` here that applied a
 * `?? 100` default tier so a caller could ask about one device in isolation;
 * every device nobody had ranked then shared rank 100, which is the tie the
 * owner exists to make impossible.
 */
export function resolveConfiguredDevicePriority(
  capacityPriorities: Record<string, Record<string, number>>,
  operatingMode: string,
  deviceId: string,
): number | undefined {
  return capacityPriorities[operatingMode || 'Home']?.[deviceId];
}

/**
 * The owner's CONFIGURED shed behaviour, as persisted — distinct from the
 * runtime `ShedBehavior` the planner and executor read.
 *
 * The `set_temperature` arm carries one limit per direction the device can
 * move demand in: `temperature` is the limit while heating (a floor the device
 * may fall to), `coolingTemperature` the limit while cooling (a ceiling it may
 * rise to). Both are always present: a device with no mode axis is a heater
 * and never reads the second, and an entry persisted before the second existed
 * resolves to `COOLING_SHED_DEFAULT_C` here, at the read — so nothing inward of
 * this seam asks whether a limit is configured.
 *
 * Resolved into a single-limit `ShedBehavior` ONCE, at the seam that knows the
 * device's direction (`AppHostApi.getShedBehavior`); nothing downstream sees
 * both numbers.
 */
export type ConfiguredShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_step' }
  | { action: 'set_temperature'; temperature: number; coolingTemperature: number };

const clampShedTemperature = (raw: unknown): number | undefined => (
  typeof raw === 'number' && Number.isFinite(raw) ? Math.max(-50, Math.min(50, raw)) : undefined
);

const resolveCoolingShedTemperature = (raw: unknown): number => {
  const clamped = clampShedTemperature(raw);
  return clamped === undefined ? COOLING_SHED_DEFAULT_C : clamped;
};

export function normalizeShedBehaviors(input: unknown): Record<string, ConfiguredShedBehavior> {
  if (!isRecord(input)) return {};
  const entries = Object.entries(input).flatMap(([deviceId, raw]) => {
    if (!raw || typeof raw !== 'object') return [];
    const candidate = raw as {
      action?: unknown; temperature?: unknown; coolingTemperature?: unknown; stepId?: unknown;
    };
    let action: ShedAction = 'turn_off';
    if (candidate.action === 'set_temperature') {
      action = 'set_temperature';
    } else if (candidate.action === 'set_step') {
      action = 'set_step';
    }
    const temperature = clampShedTemperature(candidate.temperature);
    let behavior: ConfiguredShedBehavior = { action: 'turn_off' };
    if (action === 'set_temperature' && typeof temperature === 'number') {
      behavior = {
        action, temperature, coolingTemperature: resolveCoolingShedTemperature(candidate.coolingTemperature),
      };
    } else if (action === 'set_step') {
      behavior = { action };
    }
    return [[deviceId, behavior]];
  });
  return Object.fromEntries(entries);
}

/**
 * The configured shed behaviour for one device, or `turn_off` for a device the
 * owner never configured.
 *
 * A plain lookup on purpose: `normalizeShedBehaviors` is the only writer of the
 * map, and it resolves every entry into one inhabited member — so there is
 * nothing left here to re-derive, re-clamp, or fall back from. This used to
 * flatten the union into `{ action, temperature: number | null, stepId: string
 * | null }` and re-run the ±50 clamp the producer had already applied.
 */
export function getShedBehavior(
  deviceId: string,
  shedBehaviors: Record<string, ConfiguredShedBehavior>,
): ConfiguredShedBehavior {
  return shedBehaviors[deviceId] ?? { action: 'turn_off' };
}

/**
 * Every setpoint the owner has configured as a limit for this device, in
 * either direction. For the write fence under "Save as current mode target":
 * a limit write is legitimate there, and the fence does not know which
 * direction the device is in, so it admits either owner-chosen limit.
 */
export function configuredShedTemperatures(
  deviceId: string,
  shedBehaviors: Record<string, ConfiguredShedBehavior>,
): number[] {
  const behavior = getShedBehavior(deviceId, shedBehaviors);
  return behavior.action === 'set_temperature' ? [behavior.temperature, behavior.coolingTemperature] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
