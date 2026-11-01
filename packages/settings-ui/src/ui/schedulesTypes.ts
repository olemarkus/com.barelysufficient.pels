import type { SchedulesSnapshot } from '../../../contracts/src/schedules.ts';
import type { SmartTaskCandidateDevice } from '../../../contracts/src/smartTaskEdit.ts';
import type { ScheduleDraft } from './scheduleDraft.ts';

export type ScheduleEditor = {
  kind: 'new' | 'existing';
  draft: ScheduleDraft;
  /** Another schedule performs this action at the draft's time; cleared by the next edit. */
  timeConflict: boolean;
  /**
   * Whether the owner has set the name or the action time. Until then a new
   * schedule's name and time follow its action, device and mode.
   */
  nameSet: boolean;
  timeSet: boolean;
};
export type SchedulesViewSnapshot = {
  load: 'loading' | 'ready' | 'error';
  read: SchedulesSnapshot | null;
  devices: readonly SmartTaskCandidateDevice[];
  busy: boolean;
  error: string;
  editor: ScheduleEditor | null;
  filter: 'all' | 'mode' | 'task';
};
