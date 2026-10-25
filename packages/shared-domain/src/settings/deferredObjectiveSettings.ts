import type {
  DeferredObjectiveEnergyGoal,
  DeferredObjectiveEvSocGoal,
  DeferredObjectiveGoal,
  DeferredObjectiveRescueMode,
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveRoster,
  DeferredObjectiveTemperatureGoal,
} from '../../../contracts/src/deferredObjectiveSettings';
import { isUnknownRecord } from '../recordGuards';

export const createEmptyDeferredObjectiveRoster = (): DeferredObjectiveRoster => ({
  objectivesByDeviceId: {},
});

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
  if (!isUnknownRecord(raw)) return null;
  const entry = raw;
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
  if (!isUnknownRecord(raw)) return undefined;
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
 * Whether a stored Smart task is still OPEN on its device: enabled, or paused
 * with its ready-by still ahead. A disabled past entry is a finished run kept
 * for history. A device with an open task gets no second one: creation
 * surfaces offer to edit or view the open task instead of replacing it.
 */
export const isSmartTaskOpen = (
  entry: Pick<DeferredObjectiveSettingsEntry, 'enabled' | 'deadlineAtMs'>,
  nowMs: number,
): boolean => entry.enabled || entry.deadlineAtMs > nowMs;

/**
 * One device's {@link isSmartTaskInProgress} answer as read from storage.
 * `unavailable` is a read that could not tell, which a caller deciding whether
 * to allow a change must treat as a refusal, never as `none`.
 */
export type SmartTaskInProgressRead = 'in_progress' | 'none' | 'unavailable';
