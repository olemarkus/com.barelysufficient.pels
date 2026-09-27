// The persisted `deferred_objectives` setting's shape. Its parse boundary
// (`normalizeDeferredObjectiveSettings`) lives in
// `packages/shared-domain/src/settings/deferredObjectiveSettings.ts`, which the
// runtime and the settings UI both read it through.
export type DeferredObjectiveEnforcement = 'soft' | 'hard';

/**
 * Per-smart-task rescue permissions. Each permission carries a mode: `'always'`
 * applies it to the whole plan from the start (the device is "emancipated" up
 * front); `'at_risk'` applies it only when the task would otherwise miss its
 * deadline. Absent = off (current behaviour).
 */
export type DeferredObjectiveRescueMode = 'always' | 'at_risk';

export type DeferredObjectiveRescuePermissions = {
  exemptFromBudget?: DeferredObjectiveRescueMode;
  limitLowerPriorityDevices?: DeferredObjectiveRescueMode;
  // Proactive priority-hold. While the reserved smart-task device is in a
  // plannable state and not yet active, lower-priority managed devices are held
  // off (up to — never above — the hard cap) so it can start. Distinct from
  // `limitLowerPriorityDevices`: this does NOT boost the device (no
  // `forceBoostActive`); it only clears room, and the device runs at its own /
  // lowest step.
  pauseLowerPriorityDevices?: DeferredObjectiveRescueMode;
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
  version: 1;
  objectivesByDeviceId: Record<string, DeferredObjectiveSettingsEntry>;
};
