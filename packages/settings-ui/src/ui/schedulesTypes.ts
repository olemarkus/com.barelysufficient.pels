import type { SchedulesSnapshot } from '../../../contracts/src/schedules.ts';
import type { SmartTaskCandidateDevice } from '../../../contracts/src/smartTaskEdit.ts';
import type { ScheduleDraft } from './scheduleDraft.ts';

export type ScheduleEditor = { kind: 'new' | 'existing'; draft: ScheduleDraft };
export type SchedulesViewSnapshot = {
  load: 'loading' | 'ready' | 'error';
  read: SchedulesSnapshot | null;
  devices: readonly SmartTaskCandidateDevice[];
  busy: boolean;
  error: string;
  editor: ScheduleEditor | null;
  filter: 'all' | 'mode' | 'task';
};
