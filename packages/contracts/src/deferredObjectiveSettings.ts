export const DEFERRED_OBJECTIVES_SETTINGS_VERSION = 1;

export type DeferredObjectiveEnforcement = 'soft' | 'hard';

/**
 * Per-smart-task rescue permissions. Each permission carries a mode: `'always'`
 * applies it to the whole plan from the start (the device is "emancipated" up
 * front); `'at_risk'` applies it only when the task would otherwise miss its
 * deadline. Absent = off (current behaviour). Mirrored in
 * `lib/objectives/deferredObjectives/settings.ts` — keep both in sync.
 */
export type DeferredObjectiveRescueMode = 'always' | 'at_risk';

export type DeferredObjectiveRescuePermissions = {
  exemptFromBudget?: DeferredObjectiveRescueMode;
  limitLowerPriorityDevices?: DeferredObjectiveRescueMode;
};

export type DeferredObjectiveSettingsKind = 'ev_soc' | 'temperature';

type DeferredObjectiveSettingsEntryBase = {
  enabled: boolean;
  kind: DeferredObjectiveSettingsKind;
  deadlineAtMs: number;
  rescue?: DeferredObjectiveRescuePermissions;
};

export type DeferredObjectiveEvSocSettingsEntry = DeferredObjectiveSettingsEntryBase & {
  kind: 'ev_soc';
  enforcement: DeferredObjectiveEnforcement;
  targetPercent: number;
};

export type DeferredObjectiveTemperatureSettingsEntry = DeferredObjectiveSettingsEntryBase & {
  kind: 'temperature';
  enforcement: 'soft';
  targetTemperatureC: number;
};

export type DeferredObjectiveSettingsEntry =
  | DeferredObjectiveEvSocSettingsEntry
  | DeferredObjectiveTemperatureSettingsEntry;

export type DeferredObjectiveSettingsV1 = {
  version: typeof DEFERRED_OBJECTIVES_SETTINGS_VERSION;
  objectivesByDeviceId: Record<string, DeferredObjectiveSettingsEntry>;
};

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

const normalizeEntryBase = (raw: unknown): DeferredObjectiveSettingsEntry | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Partial<DeferredObjectiveSettingsEntry>;
  if (typeof entry.enabled !== 'boolean') return null;
  if (!isValidDeadlineAtMs(entry.deadlineAtMs)) return null;

  if (entry.kind === 'ev_soc') {
    if (entry.enforcement !== 'soft' && entry.enforcement !== 'hard') return null;
    if (!isValidTargetPercent(entry.targetPercent)) return null;
    return {
      enabled: entry.enabled,
      kind: entry.kind,
      enforcement: entry.enforcement,
      targetPercent: entry.targetPercent,
      deadlineAtMs: entry.deadlineAtMs,
    };
  }

  if (entry.kind === 'temperature') {
    if (entry.enforcement !== 'soft') return null;
    if (!isValidTargetTemperature(entry.targetTemperatureC)) return null;
    return {
      enabled: entry.enabled,
      kind: entry.kind,
      enforcement: 'soft',
      targetTemperatureC: entry.targetTemperatureC,
      deadlineAtMs: entry.deadlineAtMs,
    };
  }

  return null;
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
  if (!exemptFromBudget && !limitLowerPriorityDevices) return undefined;
  return {
    ...(exemptFromBudget ? { exemptFromBudget } : {}),
    ...(limitLowerPriorityDevices ? { limitLowerPriorityDevices } : {}),
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
