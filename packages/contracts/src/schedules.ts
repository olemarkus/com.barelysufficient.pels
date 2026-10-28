import type { SmartTaskCandidateRequest } from './smartTaskEdit.js';

/** Named point-in-time actions. Weekdays use ISO numbering: Monday=1, Sunday=7. */
export type ScheduleRepeat = { type: 'weekly'; days: number[] } | { type: 'once'; date: string };
export type ScheduleModeCondition = { type: 'any' }
  | { type: 'include' | 'exclude'; modes: string[] };
export type ScheduleAction = { type: 'mode'; mode: string }
  | { type: 'task'; task: Omit<SmartTaskCandidateRequest, 'deadlineAtMs'> };
export type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  at: string;
  repeat: ScheduleRepeat;
  condition: ScheduleModeCondition;
  action: ScheduleAction;
};
export type ScheduleControls = { modeChangesEnabled: boolean; disabledTaskDeviceIds: string[] };
/** Resolved display state from the schedule owner; paused keeps the individual enabled preference. */
export type ScheduleEntry = {
  schedule: Schedule;
  /** Valid retained mode names and their current destination; commands keep the stored name. */
  modeReferences: { stored: string; resolved: string }[];
  state: 'on' | 'off' | 'paused' | 'invalid' | 'finished';
  reason: string;
  nextAtMs: number | null;
  nextLabel: string;
  lastResult: string;
};
export type SchedulesSnapshot = {
  timeZone: string; modes: string[]; controls: ScheduleControls; entries: ScheduleEntry[];
};
export type ScheduleCommand = { type: 'save'; schedule: Schedule }
  | { type: 'delete'; id: string }
  | { type: 'set_enabled'; id: string; enabled: boolean }
  | { type: 'set_mode_schedules_enabled'; enabled: boolean }
  | { type: 'set_device_schedules_enabled'; deviceId: string; enabled: boolean };
export type SchedulesResponse = { ok: true; data: SchedulesSnapshot } | { ok: false; error: string };
