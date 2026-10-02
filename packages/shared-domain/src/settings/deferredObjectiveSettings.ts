import type {
  DeferredObjectiveEnergyGoal,
  DeferredObjectiveEvSocGoal,
  DeferredObjectiveGoal,
  DeferredObjectiveRescueMode,
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
  DeferredObjectiveTemperatureGoal,
} from '../../../contracts/src/deferredObjectiveSettings';

const DEFERRED_OBJECTIVES_SETTINGS_VERSION: DeferredObjectiveSettingsV1['version'] = 1;

export const createEmptyDeferredObjectiveSettings = (): DeferredObjectiveSettingsV1 => ({
  version: DEFERRED_OBJECTIVES_SETTINGS_VERSION,
  objectivesByDeviceId: {},
});

export const normalizeDeferredObjectiveSettings = (raw: unknown): DeferredObjectiveSettingsV1 => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createEmptyDeferredObjectiveSettings();
  const candidate = raw as Partial<DeferredObjectiveSettingsV1>;
  if (candidate.version !== DEFERRED_OBJECTIVES_SETTINGS_VERSION) return createEmptyDeferredObjectiveSettings();
  const entries = candidate.objectivesByDeviceId;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return createEmptyDeferredObjectiveSettings();

  return {
    version: DEFERRED_OBJECTIVES_SETTINGS_VERSION,
    objectivesByDeviceId: Object.fromEntries(
      Object.entries(entries).flatMap(([deviceId, entry]) => {
        const normalizedDeviceId = deviceId.trim();
        const normalized = normalizeDeferredObjectiveSettingsEntry(entry);
        return normalizedDeviceId && normalized ? [[normalizedDeviceId, normalized]] : [];
      }),
    ),
  };
};

// One goal normalizer per kind: each checks its own enforcement and target and
// rebuilds the goal from those fields only, so nothing unexpected survives.
const normalizeEvSocGoal = (entry: Record<string, unknown>): DeferredObjectiveEvSocGoal | null => {
  if (entry.enforcement !== 'soft' && entry.enforcement !== 'hard') return null;
  if (!isValidTargetPercent(entry.targetPercent)) return null;
  return { kind: 'ev_soc', enforcement: entry.enforcement, targetPercent: entry.targetPercent };
};

const normalizeTemperatureGoal = (entry: Record<string, unknown>): DeferredObjectiveTemperatureGoal | null => {
  if (entry.enforcement !== 'soft') return null;
  if (!isValidTargetTemperature(entry.targetTemperatureC)) return null;
  return { kind: 'temperature', enforcement: 'soft', targetTemperatureC: entry.targetTemperatureC };
};

const normalizeEnergyGoal = (entry: Record<string, unknown>): DeferredObjectiveEnergyGoal | null => {
  if (entry.enforcement !== 'soft') return null;
  if (!isValidTargetEnergyKWh(entry.targetEnergyKWh)) return null;
  return { kind: 'energy', enforcement: 'soft', targetEnergyKWh: entry.targetEnergyKWh };
};

const normalizeGoal = (entry: Record<string, unknown>): DeferredObjectiveGoal | null => {
  switch (entry.kind) {
    case 'ev_soc': return normalizeEvSocGoal(entry);
    case 'temperature': return normalizeTemperatureGoal(entry);
    case 'energy': return normalizeEnergyGoal(entry);
    default: return null;
  }
};

const normalizeEntryBase = (raw: unknown): DeferredObjectiveSettingsEntry | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.enabled !== 'boolean') return null;
  if (!isValidDeadlineAtMs(entry.deadlineAtMs)) return null;
  const goal = normalizeGoal(entry);
  return goal && { enabled: entry.enabled, ...goal, deadlineAtMs: entry.deadlineAtMs };
};

export const normalizeDeferredObjectiveSettingsEntry = (
  raw: unknown,
): DeferredObjectiveSettingsEntry | null => {
  const base = normalizeEntryBase(raw);
  if (!base) return null;
  const rescue = normalizeRescuePermissions((raw as { rescue?: unknown }).rescue);
  return rescue ? { ...base, rescue } : base;
};

const isRescueMode = (value: unknown): value is DeferredObjectiveRescueMode => (
  value === 'always' || value === 'at_risk'
);

const normalizeRescuePermissions = (
  raw: unknown,
): DeferredObjectiveRescuePermissions | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Partial<Record<keyof DeferredObjectiveRescuePermissions, unknown>>;
  const exemptFromBudget = isRescueMode(value.exemptFromBudget) ? value.exemptFromBudget : undefined;
  const limitLowerPriorityDevices = isRescueMode(value.limitLowerPriorityDevices)
    ? value.limitLowerPriorityDevices
    : undefined;
  const pauseLowerPriorityDevices = isRescueMode(value.pauseLowerPriorityDevices)
    ? value.pauseLowerPriorityDevices
    : undefined;
  if (!exemptFromBudget && !limitLowerPriorityDevices && !pauseLowerPriorityDevices) return undefined;
  return {
    ...(exemptFromBudget ? { exemptFromBudget } : {}),
    ...(limitLowerPriorityDevices ? { limitLowerPriorityDevices } : {}),
    ...(pauseLowerPriorityDevices ? { pauseLowerPriorityDevices } : {}),
  };
};

const isValidDeadlineAtMs = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value > 0
);

const isValidTargetPercent = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value > 0
  && value <= 100
);

const isValidTargetTemperature = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= -50
  && value <= 100
);

/**
 * The energy a task may ask for. The ceiling is the Flow card's: well above a
 * night's water heating or a full car battery, and low enough that a typo in the
 * kWh field is refused rather than planned as days of load.
 */
export const MIN_TARGET_ENERGY_KWH = 0.1;
export const MAX_TARGET_ENERGY_KWH = 200;

export const isValidTargetEnergyKWh = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= MIN_TARGET_ENERGY_KWH
  && value <= MAX_TARGET_ENERGY_KWH
);

/**
 * Whether a stored Smart task is in progress: enabled, with its ready-by still
 * ahead. While one is, the device's "When the temperature changes outside
 * PELS" choice stays at Return to mode target, because a temperature Smart task
 * needs PELS to set the temperature. The settings UI and the runtime both ask
 * here, so the two never disagree about which tasks hold the choice.
 */
export const isSmartTaskInProgress = (
  entry: Pick<DeferredObjectiveSettingsEntry, 'enabled' | 'deadlineAtMs'>,
  nowMs: number,
): boolean => entry.enabled && Number.isFinite(entry.deadlineAtMs) && entry.deadlineAtMs > nowMs;

/**
 * One device's {@link isSmartTaskInProgress} answer as read from storage.
 * `unavailable` is a read that could not tell, which a caller deciding whether
 * to allow a change must treat as a refusal, never as `none`.
 */
export type SmartTaskInProgressRead = 'in_progress' | 'none' | 'unavailable';
