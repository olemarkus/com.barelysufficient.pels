import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import type { ScheduleEntry } from '../../../../contracts/src/schedules.ts';
import type { SmartTaskCandidateDevice } from '../../../../contracts/src/smartTaskEdit.ts';
import { formatSmartTaskGoalRangeHint } from '../../../../shared-domain/src/smartTaskCopy/createEditCopy.ts';
import {
  SMART_TASK_EXTRA_PERMISSION_HINTS,
  SMART_TASK_EXTRA_PERMISSION_LABELS,
  SMART_TASK_EXTRA_PERMISSIONS_TITLE,
} from '../../../../shared-domain/src/smartTaskCopy/permissionsCopy.ts';
import type { ScheduleDraft, ScheduleRepeatChoice } from '../scheduleDraft.ts';
import { scheduleModeLabel, scheduleModeOptions } from '../scheduleModeReferences.ts';
import { SCHEDULE_DAYS, scheduleReadyByDay, scheduleRepeatLabel, scheduleTaskUnit } from '../scheduleDraft.ts';
import type { SchedulesViewSnapshot } from '../schedulesTypes.ts';
import { SmartTaskPermissionRow } from './DeadlinePlan.tsx';
import { ArrowBackIcon, ExpandMoreIcon } from './icons.tsx';
import {
  MdCheckbox, MdFilledButton, MdFilledSelect, MdFilledTextField, MdIconButton,
  MdOutlinedButton, MdSelectOption, MdSwitch, MdTextButton, readSwitchSelected,
} from './materialWebJSX.tsx';

export type SchedulesActions = {
  onRetry(): void;
  onNew(): void;
  onEdit(id: string): void;
  onBack(): void;
  onDraftChange(patch: Partial<ScheduleDraft>): void;
  onSelectAction(type: 'mode' | 'task'): void;
  onDevice(deviceId: string): void;
  onRepeat(repeat: ScheduleRepeatChoice): void;
  onDay(day: number): void;
  onConditionMode(mode: string): void;
  onSave(): void;
  onDelete(): void;
  onToggle(id: string, enabled: boolean): void;
  onModeGroup(enabled: boolean): void;
  onDeviceGroup(deviceId: string, enabled: boolean): void;
  onFilter(filter: 'all' | 'mode' | 'task'): void;
};
type View = { snapshot: SchedulesViewSnapshot; actions: SchedulesActions };
const inputValue = (event: Event): string => (event.currentTarget as HTMLInputElement).value;
const STATE_LABELS = { on: 'On', off: 'Off', paused: 'Paused', invalid: 'Needs attention', finished: 'Finished' } as const;
const PERMISSION_KEYS = ['exemptFromBudget', 'limitLowerPriorityDevices', 'pauseLowerPriorityDevices'] as const;
const TASK_TARGET_NAMES = { temperature: 'temperature', ev_soc: 'battery', energy: 'energy' } as const;
const REPEATS: { value: ScheduleRepeatChoice; label: string }[] = [
  { value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Mon–Fri' },
  { value: 'weekends', label: 'Sat–Sun' }, { value: 'custom', label: 'Choose days' },
  { value: 'once', label: 'Once, on a date' },
];
const Choice = ({ value, children }: { value: string; children: ComponentChildren }) => (
  <MdSelectOption value={value}><span slot="headline">{children}</span></MdSelectOption>
);
const actionSummary = (entry: ScheduleEntry, devices: readonly SmartTaskCandidateDevice[]): string => {
  const { schedule } = entry;
  if (schedule.action.type === 'mode') {
    return `Set mode to ${scheduleModeLabel(schedule.action.mode, entry.modeReferences)}`;
  }
  const { task } = schedule.action;
  const device = devices.find((candidate) => candidate.deviceId === task.deviceId);
  const unit = scheduleTaskUnit(task.kind);
  return `${device?.deviceName ?? 'Unavailable device'} · ${task.target} ${unit} · Ready by ${task.readyByLocalTime}`;
};

const ScheduleRow = ({ entry, view }: { entry: ScheduleEntry; view: View }) => {
  const { schedule } = entry;
  const disabled = view.snapshot.busy || view.snapshot.load !== 'ready';
  return (
    <article class="pels-surface-card schedule-row" data-state={entry.state} data-schedule-id={schedule.id}>
      <div class="schedule-row__main">
        <button type="button" class="hy-nostyle schedule-row__open" disabled={view.snapshot.busy}
          onClick={() => view.actions.onEdit(schedule.id)}>
          <h3 class="pels-text-card-title">{schedule.name}</h3>
          <p class="pels-card-supporting">{scheduleRepeatLabel(schedule.repeat)} at {schedule.at}</p>
          <p>{actionSummary(entry, view.snapshot.devices)}</p>
          {schedule.condition.type !== 'any' && <p class="pels-card-supporting">
            {schedule.condition.type === 'include' ? 'Only in' : 'Except'}{' '}
            {schedule.condition.modes.map((mode) => scheduleModeLabel(mode, entry.modeReferences)).join(', ')}
          </p>}
        </button>
        <div class="schedule-row__switch">
          <MdSwitch key={`${schedule.id}:${schedule.enabled}:${disabled}`}
            aria-label={`${schedule.name} schedule`} aria-describedby={`schedule-status-${schedule.id}`}
            selected={schedule.enabled} disabled={disabled}
            onChange={(event: Event) => view.actions.onToggle(schedule.id, readSwitchSelected(event))} />
          <span class="schedule-row__state">{STATE_LABELS[entry.state]}</span>
        </div>
      </div>
      <div class="schedule-row__footer" id={`schedule-status-${schedule.id}`}>
        {entry.reason && <p>{entry.reason}</p>}
        {entry.nextAtMs !== null && <p>Next: {entry.nextLabel}</p>}
        {entry.lastResult && <p class="pels-card-supporting">Last: {entry.lastResult}</p>}
        <MdTextButton disabled={view.snapshot.busy} onClick={() => view.actions.onEdit(schedule.id)}>Edit</MdTextButton>
      </div>
    </article>
  );
};
type ScheduleGroup = readonly [id: string, entries: ScheduleEntry[]];
const Group = ({ group, view }: { group: ScheduleGroup; view: View }) => {
  const [id, entries] = group;
  const { read } = view.snapshot;
  if (!read) return null;
  const modeGroup = id === 'mode';
  const on = modeGroup ? read.controls.modeChangesEnabled : !read.controls.disabledTaskDeviceIds.includes(id);
  const deviceName = view.snapshot.devices.find((device) => device.deviceId === id)?.deviceName ?? 'Unavailable device';
  const name = modeGroup ? 'Mode changes' : deviceName;
  return (
    <section class="schedule-group" aria-label={`${name} schedules`}>
      <div class="schedule-group__bar">
        <div><h3 class="pels-text-card-title">{name}</h3>
          <p class="pels-card-supporting">{entries.length} {modeGroup ? 'mode' : 'task'} schedule{entries.length === 1 ? '' : 's'}</p>
        </div>
        <div class="schedule-group__switch">
          <span>{on ? 'On' : 'Off'}</span>
          <MdSwitch key={`${id}:${on}:${view.snapshot.busy}`} selected={on}
            disabled={view.snapshot.busy || view.snapshot.load !== 'ready'}
            aria-label={modeGroup ? 'Scheduled mode changes' : `Scheduled tasks for ${deviceName}`}
            onChange={(event: Event) => modeGroup
              ? view.actions.onModeGroup(readSwitchSelected(event))
              : view.actions.onDeviceGroup(id, readSwitchSelected(event))} />
        </div>
      </div>
      {!on && <p class="schedule-group__paused">Schedules below are paused. Their individual On/Off settings are kept.</p>}
      {entries.map((entry) => <ScheduleRow key={entry.schedule.id} entry={entry} view={view} />)}
    </section>
  );
};
const List = (view: View) => {
  const { snapshot, actions } = view;
  const entries = snapshot.read?.entries ?? [];
  const shown = entries.filter((entry) => snapshot.filter === 'all' || entry.schedule.action.type === snapshot.filter);
  const groups = new Map<string, ScheduleEntry[]>();
  shown.forEach((entry) => {
    const key = entry.schedule.action.type === 'mode' ? 'mode' : entry.schedule.action.task.deviceId;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  });
  const next = shown.filter((entry) => entry.state === 'on' && entry.nextAtMs !== null)
    .sort((a, b) => (a.nextAtMs as number) - (b.nextAtMs as number))[0];
  return (
    <>
      <div class="pels-appbar"><MdIconButton class="pels-appbar__back" data-settings-target="settings" aria-label="Back to Settings"><ArrowBackIcon /></MdIconButton>
        <h2 class="pels-appbar__title" id="schedules-title">Schedules</h2></div>
      <p class="pels-card-supporting">Create Smart tasks and change mode at the times you choose.</p>
      <div class="schedules-toolbar">
        <MdFilledButton disabled={snapshot.load !== 'ready' || snapshot.busy} onClick={actions.onNew}>New schedule</MdFilledButton>
        <MdTextButton disabled={snapshot.busy} onClick={actions.onRetry}>Refresh</MdTextButton>
      </div>
      {snapshot.read && <p class="pels-card-supporting">Main home · Times in {snapshot.read.timeZone}</p>}
      {next && <section class="pels-surface-card schedules-next" aria-label="Next scheduled action">
        <p class="pels-text-settings-label">Next: {next.nextLabel}</p><p>{next.schedule.name}</p>
      </section>}
      <div class="schedules-filters" role="group" aria-label="Schedule type">
        {([['all', 'All'], ['task', 'Smart tasks'], ['mode', 'Modes']] as const).map(([filter, label]) => (
          <MdOutlinedButton key={filter} aria-pressed={snapshot.filter === filter} disabled={snapshot.busy}
            onClick={() => actions.onFilter(filter)}>{label}</MdOutlinedButton>
        ))}
      </div>
      {snapshot.load === 'loading' && <p role="status">Loading schedules…</p>}
      {snapshot.load === 'ready' && shown.length === 0 && <section class="pels-surface-card schedules-empty">
        <h3 class="pels-text-card-title">No schedules yet</h3>
        <p class="pels-card-supporting">Choose when to create a task or change mode.</p>
      </section>}
      {Array.from(groups, (group) => <Group key={group[0]} group={group} view={view} />)}
      {snapshot.read && <p class="section-hint">Each scheduled action runs once. Switching schedules off stops future actions; existing tasks and the current mode are unchanged.</p>}
    </>
  );
};
const TaskTargetFields = ({ draft, view }: { draft: ScheduleDraft; view: View }) => {
  if (draft.taskKind === null) return null;
  const { snapshot, actions } = view;
  const device = snapshot.devices.find((candidate) => candidate.deviceId === draft.deviceId);
  const compatibleDevice = device?.kind === draft.taskKind ? device : undefined;
  const unit = scheduleTaskUnit(draft.taskKind);
  const disabled = snapshot.busy || snapshot.load !== 'ready';
  return (
    <>
      <label class="field"><span class="field__label pels-text-settings-label">Target ({unit})</span>
        <MdFilledTextField key={`${draft.deviceId}:${draft.taskKind}:${Boolean(compatibleDevice)}`}
          type="number" value={draft.target} min={compatibleDevice?.goalMin.toString()}
          max={compatibleDevice?.goalMax.toString()} step={compatibleDevice?.goalStep.toString()}
          disabled={disabled || !compatibleDevice} aria-label={`Target (${unit})`}
          onInput={(event: Event) => actions.onDraftChange({ target: inputValue(event) })} />
        {compatibleDevice && <small class="field__hint">
          {formatSmartTaskGoalRangeHint(compatibleDevice.goalMin, compatibleDevice.goalMax, unit)}
        </small>}
      </label>
      {device && !compatibleDevice && <div class="pels-notice-info">
        <p>This schedule keeps its {TASK_TARGET_NAMES[draft.taskKind]} target.
          {' '}This device currently offers {TASK_TARGET_NAMES[device.kind]} targets.</p>
        <MdTextButton type="button" disabled={disabled} onClick={() => actions.onDevice(device.deviceId)}>
          Use {TASK_TARGET_NAMES[device.kind]} target
        </MdTextButton>
      </div>}
    </>
  );
};
const TaskFields = ({ draft, view }: { draft: ScheduleDraft; view: View }) => {
  const { snapshot, actions } = view;
  const device = snapshot.devices.find((candidate) => candidate.deviceId === draft.deviceId);
  const supportsLimit = device?.kind === draft.taskKind && device.supportsLimitLowerPriority;
  const disabled = snapshot.busy || snapshot.load !== 'ready';
  return (
    <>
      <div class="field"><span class="field__label pels-text-settings-label">Device</span>
        <MdFilledSelect value={draft.deviceId} aria-label="Task device" disabled={disabled}
          onChange={(event: Event) => actions.onDevice(inputValue(event))}>
          {!device && <Choice value={draft.deviceId}>Choose an available device</Choice>}
          {snapshot.devices.map((candidate) => <Choice key={candidate.deviceId} value={candidate.deviceId}>{candidate.deviceName}</Choice>)}
        </MdFilledSelect>
      </div>
      {draft.taskKind !== null && <>
        <TaskTargetFields draft={draft} view={view} />
        <label class="field"><span class="field__label pels-text-settings-label">Ready by</span>
          <input type="time" class="smart-task-edit__time-input" value={draft.readyBy} disabled={disabled}
            onInput={(event) => actions.onDraftChange({ readyBy: inputValue(event) })} />
        </label>
        <p class="pels-card-supporting">The task is created at {draft.at}, ready by {draft.readyBy} {scheduleReadyByDay(draft.at, draft.readyBy)}. PELS chooses when the device runs.</p>
        <details class="smart-task-edit__permissions">
          <summary class="smart-task-edit__permissions-summary"><span class="plan-card__title">{SMART_TASK_EXTRA_PERMISSIONS_TITLE}</span>
            <ExpandMoreIcon class="disclosure-chevron" /></summary>
          <p class="section-hint">Saved for each new task this schedule creates.</p>
          {PERMISSION_KEYS.filter((key) => key !== 'limitLowerPriorityDevices' || supportsLimit || draft.permissions[key])
            .map((key) => <SmartTaskPermissionRow key={key} label={SMART_TASK_EXTRA_PERMISSION_LABELS[key]}
              hint={SMART_TASK_EXTRA_PERMISSION_HINTS[key]} selected={draft.permissions[key]} disabled={disabled}
              onToggle={(selected) => actions.onDraftChange({ permissions: { ...draft.permissions, [key]: selected } })} />)}
        </details>
      </>}
    </>
  );
};
const Editor = (view: View) => {
  const { snapshot, actions } = view;
  if (!snapshot.editor || !snapshot.read) return null;
  const { draft, kind } = snapshot.editor;
  const disabled = snapshot.busy || snapshot.load !== 'ready';
  const editedEntry = snapshot.read.entries.find((entry) => entry.schedule.id === draft.id);
  const references = kind === 'existing' && editedEntry ? editedEntry.modeReferences : [];
  const modeOptions = scheduleModeOptions(snapshot.read.modes, references);
  const unavailableConditions = draft.conditionModes.filter((mode) => (
    !modeOptions.some((option) => option.value === mode)
  ));
  const groupOff = draft.actionType === 'mode' ? !snapshot.read.controls.modeChangesEnabled
    : snapshot.read.controls.disabledTaskDeviceIds.includes(draft.deviceId);
  const pausedReason = draft.actionType === 'mode' ? 'Scheduled mode changes are off.' : 'Scheduled tasks for this device are off.';
  return (
    <>
      <div class="pels-appbar"><MdIconButton disabled={snapshot.busy} onClick={actions.onBack} aria-label="Back to schedules"><ArrowBackIcon /></MdIconButton>
        <h2 class="pels-appbar__title" id="schedule-editor-heading" tabIndex={-1}>{kind === 'new' ? 'New schedule' : 'Edit schedule'}</h2></div>
      <div class="pels-surface-card schedule-editor__enabled">
        <div><h3 class="pels-text-settings-label">Schedule {draft.enabled ? groupOff ? 'paused' : 'on' : 'off'}</h3>
          <p class="pels-card-supporting">{!draft.enabled ? 'Saved, with no future actions.' : groupOff ? pausedReason : 'Runs at the times below.'}</p></div>
        <MdSwitch key={`${draft.enabled}:${disabled}`} aria-label="Schedule enabled" selected={draft.enabled} disabled={disabled}
          onChange={(event: Event) => actions.onDraftChange({ enabled: readSwitchSelected(event) })} />
      </div>
      <form class="schedules-form" onSubmit={(event) => { event.preventDefault(); actions.onSave(); }}>
        <section class="pels-surface-card schedules-form__section">
          <h3 class="pels-text-card-title">What should happen?</h3>
          <label class="field"><span class="field__label pels-text-settings-label">Schedule name</span>
            <MdFilledTextField aria-label="Schedule name" value={draft.name} maxlength="60" required disabled={disabled}
              onInput={(event: Event) => actions.onDraftChange({ name: inputValue(event) })} />
          </label>
          <div class="schedules-action-choice" role="group" aria-label="Scheduled action">
            <MdOutlinedButton type="button" disabled={disabled} aria-pressed={draft.actionType === 'task'}
              onClick={() => actions.onSelectAction('task')}>Create Smart task</MdOutlinedButton>
            <MdOutlinedButton type="button" disabled={disabled} aria-pressed={draft.actionType === 'mode'}
              onClick={() => actions.onSelectAction('mode')}>Change mode</MdOutlinedButton>
          </div>
          {draft.actionType === 'task' ? <TaskFields draft={draft} view={view} /> : <>
            <div class="field"><span class="field__label pels-text-settings-label">Set mode to</span>
              <MdFilledSelect value={draft.mode} aria-label="Set mode to" disabled={disabled}
                onChange={(event: Event) => actions.onDraftChange({ mode: inputValue(event) })}>
                {!modeOptions.some((option) => option.value === draft.mode)
                  && <Choice value={draft.mode}>Choose an available mode</Choice>}
                {modeOptions.map((option) => <Choice key={option.value} value={option.value}>{option.label}</Choice>)}
              </MdFilledSelect>
            </div><p class="pels-card-supporting">The mode changes once. Later manual or Flow changes take effect normally.</p>
          </>}
        </section>
        <section class="pels-surface-card schedules-form__section">
          <h3 class="pels-text-card-title">When?</h3>
          <div class="field"><span class="field__label pels-text-settings-label">Repeat</span>
            <MdFilledSelect value={draft.repeat} aria-label="Repeat" disabled={disabled}
              onChange={(event: Event) => actions.onRepeat(inputValue(event) as ScheduleRepeatChoice)}>
              {REPEATS.map((repeat) => <Choice key={repeat.value} value={repeat.value}>{repeat.label}</Choice>)}
            </MdFilledSelect>
          </div>
          {draft.repeat === 'custom' && <div class="schedule-days" role="group" aria-label="Days of week">
            {SCHEDULE_DAYS.map((day) => <MdOutlinedButton type="button" key={day.value} aria-pressed={draft.days.includes(day.value)}
              disabled={disabled} onClick={() => actions.onDay(day.value)}>{day.label}</MdOutlinedButton>)}
          </div>}
          {draft.repeat === 'once' && <label class="field"><span class="field__label pels-text-settings-label">Date</span>
            <input type="date" class="smart-task-edit__time-input" value={draft.date} disabled={disabled}
              onInput={(event) => actions.onDraftChange({ date: inputValue(event) })} /></label>}
          <label class="field"><span class="field__label pels-text-settings-label">{draft.actionType === 'task' ? 'Create task at' : 'Change mode at'}</span>
            <input type="time" class="smart-task-edit__time-input" value={draft.at} disabled={disabled}
              onInput={(event) => actions.onDraftChange({ at: inputValue(event) })} />
            <small class="field__hint">Days above refer to this action time{draft.actionType === 'task' ? ', even when the task is ready the following day' : ''}.</small>
          </label>
        </section>
        <section class="pels-surface-card schedules-form__section">
          <h3 class="pels-text-card-title">Only in selected modes?</h3>
          <div class="field"><span class="field__label pels-text-settings-label">Check mode when the schedule fires</span>
            <MdFilledSelect aria-label="Mode condition" value={draft.conditionType} disabled={disabled}
              onChange={(event: Event) => actions.onDraftChange({ conditionType: inputValue(event) as ScheduleDraft['conditionType'] })}>
              <Choice value="any">Any mode</Choice><Choice value="include">Only these modes</Choice><Choice value="exclude">Except these modes</Choice>
            </MdFilledSelect>
          </div>
          {draft.conditionType !== 'any' && <div class="schedule-mode-choices">
            {unavailableConditions.map((mode) => <label class="schedule-mode-choice" key={mode}>
              <MdCheckbox checked disabled={disabled} aria-label={`${mode} (unavailable)`}
                onChange={() => actions.onConditionMode(mode)} />
              <span>{mode} (unavailable)</span></label>)}
            {modeOptions.map((option) => <label class="schedule-mode-choice" key={option.value}>
              <MdCheckbox checked={draft.conditionModes.includes(option.value)} disabled={disabled}
                aria-label={option.label} onChange={() => actions.onConditionMode(option.value)} />
              <span>{option.label}</span></label>)}
          </div>}
          <p class="section-hint">If the condition does not match at that time, this occurrence is skipped.</p>
        </section>
        <div class="schedules-form__actions">
          <MdFilledButton type="submit" disabled={disabled} onClick={(event: Event) => { event.preventDefault(); actions.onSave(); }}>Save schedule</MdFilledButton>
          <MdTextButton type="button" disabled={snapshot.busy} onClick={actions.onBack}>Cancel</MdTextButton>
        </div>
      </form>
      {kind === 'existing' && <details class="schedule-delete"><summary>Delete schedule</summary>
        <p class="pels-card-supporting">This stops future actions. Existing tasks and the current mode are unchanged.</p>
        <MdTextButton class="md-text-button--destructive" disabled={disabled} onClick={actions.onDelete}>Delete this schedule</MdTextButton>
      </details>}
    </>
  );
};
export const Schedules = (view: View) => (
  <div class="schedules">
    {view.snapshot.editor ? <Editor {...view} /> : <List {...view} />}
    <div class="schedules-feedback" aria-live="polite">
      {view.snapshot.busy && <p role="status">Saving changes…</p>}
      {view.snapshot.error && <p class="smart-task-edit__error" role="alert">{view.snapshot.error}</p>}
      {view.snapshot.error && <MdTextButton disabled={view.snapshot.busy} onClick={view.actions.onRetry}>Refresh schedules</MdTextButton>}
    </div>
  </div>
);
export const renderSchedules = (root: HTMLElement, snapshot: SchedulesViewSnapshot, actions: SchedulesActions): void => {
  render(<Schedules snapshot={snapshot} actions={actions} />, root);
};
