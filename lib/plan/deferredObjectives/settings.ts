import type { DeferredObjectiveEnforcement } from './types';

export const DEFERRED_OBJECTIVES_SETTINGS_VERSION = 1;

export type DeferredObjectiveSettingsKind = 'ev_soc';

export type DeferredObjectiveSettingsEntry = {
  enabled: boolean;
  kind: DeferredObjectiveSettingsKind;
  enforcement: DeferredObjectiveEnforcement;
  targetPercent: number;
  deadlineLocalTime: string;
};

export type DeferredObjectiveSettingsV1 = {
  version: typeof DEFERRED_OBJECTIVES_SETTINGS_VERSION;
  objectivesByDeviceId: Record<string, DeferredObjectiveSettingsEntry>;
};

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

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

export const normalizeDeferredObjectiveSettingsEntry = (
  raw: unknown,
): DeferredObjectiveSettingsEntry | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Partial<DeferredObjectiveSettingsEntry>;
  if (typeof entry.enabled !== 'boolean') return null;
  if (entry.kind !== 'ev_soc') return null;
  if (entry.enforcement !== 'soft' && entry.enforcement !== 'hard') return null;
  if (!isValidTargetPercent(entry.targetPercent)) return null;
  if (typeof entry.deadlineLocalTime !== 'string' || !LOCAL_TIME_PATTERN.test(entry.deadlineLocalTime)) return null;
  return {
    enabled: entry.enabled,
    kind: entry.kind,
    enforcement: entry.enforcement,
    targetPercent: entry.targetPercent,
    deadlineLocalTime: entry.deadlineLocalTime,
  };
};

const isValidTargetPercent = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value > 0
  && value <= 100
);
