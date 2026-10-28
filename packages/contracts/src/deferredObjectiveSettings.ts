// Smart-task shapes. Each device's task is stored under its own settings key,
// `deferred_objective.<deviceId>`, as one `DeferredObjectiveSettingsEntry`;
// `lib/objectives/deferredObjectives/objectiveStore.ts` owns those keys and is
// their only writer. `DeferredObjectiveRoster` is the in-memory map the store
// assembles from them and the settings UI receives; it is never persisted.
// Outside PELS (the settings UI, widgets, scripts, a lab), tasks are created
// and ended through the smart-task routes, never by writing settings keys.
//
// The entry parse boundary (`normalizeDeferredObjectiveSettingsEntry`) lives in
// `packages/shared-domain/src/settings/deferredObjectiveSettings.ts`; the
// settings UI parses the roster it receives in
// `packages/settings-ui/src/ui/deferredObjectiveRoster.ts`.
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

/**
 * The quantity a smart task drives toward its target: a charger's battery level
 * (`ev_soc`), a device's measured temperature (`temperature`), or an amount of
 * energy fed to the device (`energy`). The kind is the task's unit carrier; the
 * allocator below the progress read never branches on it.
 */
export type DeferredObjectiveSettingsKind = 'ev_soc' | 'temperature' | 'energy';

/** The unit a task's values are in: °C for temperature, % for EV SoC, kWh for energy. */
export type DeferredObjectiveUnit = '°C' | '%' | 'kWh';

/** The saved schedule that created this run, with its name captured at creation. */
export type DeferredObjectiveScheduleSource = {
  id: string;
  name: string;
};

type DeferredObjectiveSettingsEntryBase = {
  enabled: boolean;
  deadlineAtMs: number;
  rescue?: DeferredObjectiveRescuePermissions;
  scheduleSource?: DeferredObjectiveScheduleSource;
};

/**
 * What a task asks for: its kind, enforcement and target in the kind's own unit.
 * One member per kind, so the kind picks the target column and a target of the
 * wrong unit does not type.
 */
export type DeferredObjectiveEvSocGoal = {
  kind: 'ev_soc';
  enforcement: DeferredObjectiveEnforcement;
  targetPercent: number;
};

export type DeferredObjectiveTemperatureGoal = {
  kind: 'temperature';
  enforcement: 'soft';
  targetTemperatureC: number;
};

/**
 * "Feed this device `targetEnergyKWh` by the deadline." Progress is the energy
 * the device has taken since the task started, so the task needs no level of the
 * device's own — the one this kind exists for is a relay-switched water heater,
 * which has neither a temperature nor a battery level to read.
 */
export type DeferredObjectiveEnergyGoal = {
  kind: 'energy';
  enforcement: 'soft';
  targetEnergyKWh: number;
};

export type DeferredObjectiveGoal =
  | DeferredObjectiveEvSocGoal
  | DeferredObjectiveTemperatureGoal
  | DeferredObjectiveEnergyGoal;

export type DeferredObjectiveEvSocSettingsEntry = DeferredObjectiveSettingsEntryBase & DeferredObjectiveEvSocGoal;

export type DeferredObjectiveTemperatureSettingsEntry = DeferredObjectiveSettingsEntryBase
  & DeferredObjectiveTemperatureGoal;

export type DeferredObjectiveEnergySettingsEntry = DeferredObjectiveSettingsEntryBase & DeferredObjectiveEnergyGoal;

export type DeferredObjectiveSettingsEntry =
  | DeferredObjectiveEvSocSettingsEntry
  | DeferredObjectiveTemperatureSettingsEntry
  | DeferredObjectiveEnergySettingsEntry;

export type DeferredObjectiveRoster = {
  objectivesByDeviceId: Record<string, DeferredObjectiveSettingsEntry>;
};
