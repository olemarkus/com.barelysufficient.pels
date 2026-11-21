import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import type { ScheduleEntry } from '../../../../contracts/src/schedules.ts';
import { resolveSmartTaskCandidateGoal } from '../../../../shared-domain/src/smartTaskCandidateGoal.ts';
import { formatSmartTaskGoalRangeHint } from '../../../../shared-domain/src/smartTaskCopy/createEditCopy.ts';
import {
  formatGrantedRescuePermissionsLine,
  SMART_TASK_EXTRA_PERMISSION_HINTS,
  SMART_TASK_EXTRA_PERMISSION_LABELS,
  SMART_TASK_EXTRA_PERMISSIONS_TITLE,
} from '../../../../shared-domain/src/smartTaskCopy/permissionsCopy.ts';
import { scheduleActionDeviceId } from '../../../../shared-domain/src/settings/schedules.ts';
import type { ScheduleActionType, ScheduleDraft, ScheduleRepeatChoice } from '../scheduleDraft.ts';
import { scheduleModeLabel, scheduleModeOptions } from '../scheduleModeReferences.ts';
import {
  SCHEDULE_DAYS, scheduleOverrideDevices, scheduleOverrideEnd, scheduleReadyByDay, scheduleRepeatLabel,
  scheduleTaskUnit,
} from '../scheduleDraft.ts';
import type { SchedulesViewSnapshot } from '../schedulesTypes.ts';
import { SegmentedControl } from './SegmentedControl.tsx';
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
  onSelectAction(type: ScheduleActionType): void;
  onDevice(deviceId: string): void;
  onRepeat(repeat: ScheduleRepeatChoice): void;
  onDay(day: number): void;
  onConditionMode(mode: string): void;
  onSave(): void;
  onDelete(): void;
  onToggle(id: string, enabled: boolean): void;
  onModeGroup(enabled: boolean): void;
  onDeviceGroup(deviceId: string, enabled: boolean): void;
  onFilter(filter: 'all' | 'mode' | 'task' | 'override'): void;
};
type View = { snapshot: SchedulesViewSnapshot; actions: SchedulesActions };
const inputValue = (event: Event): string => (event.currentTarget as HTMLInputElement).value;
/** A schedule whose device PELS no longer manages: what is wrong, and the two ways out. */
export const SCHEDULE_UNMANAGED_REASON = 'PELS does not manage this device, so this schedule cannot run. '
  + 'Turn on Managed for the device, or delete the schedule.';
const scheduleDeviceName = (snapshot: SchedulesViewSnapshot, deviceId: string): string => (
  snapshot.devices.find((candidate) => candidate.deviceId === deviceId)?.deviceName
    ?? snapshot.unmanagedDeviceNames[deviceId] ?? 'Unavailable device'
);
// The schedule owner only knows the device is not one a task can run on. The
// settings UI knows why when the owner turned Managed off, and says that.
const scheduleReason = (entry: ScheduleEntry, snapshot: SchedulesViewSnapshot): string => {
  const deviceId = scheduleActionDeviceId(entry.schedule.action);
  const unmanaged = entry.state === 'invalid' && deviceId !== null
    && snapshot.unmanagedDeviceNames[deviceId] !== undefined;
  return unmanaged ? SCHEDULE_UNMANAGED_REASON : entry.reason;
};
const STATE_LABELS = { on: 'On', off: 'Off', paused: 'Paused', invalid: 'Needs attention', finished: 'Finished' } as const;
const PERMISSION_KEYS = ['exemptFromBudget', 'limitLowerPriorityDevices', 'pauseLowerPriorityDevices'] as const;
const TASK_TARGET_NAMES = { temperature: 'temperature', ev_soc: 'battery', energy: 'energy' } as const;
const REPEATS: { value: ScheduleRepeatChoice; label: string }[] = [
  { value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Mon–Fri' },
  { value: 'weekends', label: 'Sat–Sun' }, { value: 'custom', label: 'Choose days' },
  { value: 'once', label: 'Once, on a date' },
];
const ACTION_TIME_LABELS: Record<ScheduleActionType, string> = {
  task: 'Create task at', mode: 'Change mode at', override: 'Start override at',
};
const ACTION_CONFLICTS: Record<ScheduleActionType, string> = {
  task: 'creates a task for this device', mode: 'changes mode', override: 'starts an override for this device',
};
const Choice = ({ value, children }: { value: string; children: ComponentChildren }) => (
  <MdSelectOption value={value}><span slot="headline">{children}</span></MdSelectOption>
);
const actionSummary = (entry: ScheduleEntry, snapshot: SchedulesViewSnapshot): string => {
  const { schedule } = entry;
  if (schedule.action.type === 'mode') {
    const mode = scheduleModeLabel(schedule.action.mode, entry.modeReferences);
    return `Set mode to ${mode}${schedule.action.prepare ? ' · Prepare devices' : ''}`;
  }
  const name = scheduleDeviceName(snapshot, scheduleActionDeviceId(schedule.action) ?? '');
  if (schedule.action.type === 'override') {
    const { setting, minutes } = schedule.action;
    return `${name} · Override ${setting.targetC} °C until ${scheduleOverrideEnd(schedule.at, minutes)}`;
  }
  const { task } = schedule.action;
  const unit = scheduleTaskUnit(task.kind);
  return `${name} · ${task.target} ${unit} · Ready by ${task.readyByLocalTime}`;
};

const ScheduleRow = ({ entry, view }: { entry: ScheduleEntry; view: View }) => {
  const { schedule } = entry;
  const disabled = view.snapshot.busy || view.snapshot.load !== 'ready';
  const reason = scheduleReason(entry, view.snapshot);
  const grantedLine = schedule.action.type === 'task'
    ? formatGrantedRescuePermissionsLine({
      exemptFromBudget: schedule.action.task.exemptFromBudget === true,
      limitLowerPriorityDevices: schedule.action.task.limitLowerPriorityDevices === true,
      pauseLowerPriorityDevices: schedule.action.task.pauseLowerPriorityDevices === true,
    }) : null;
  return (
    <article class="schedule-row" data-state={entry.state} data-schedule-id={schedule.id}>
      <div class="schedule-row__main">
        <button type="button" class="hy-nostyle schedule-row__open" disabled={view.snapshot.busy}
          onClick={() => view.actions.onEdit(schedule.id)}>
          <h4 class="pels-text-card-title">{schedule.name}</h4>
          <p class="pels-card-supporting">{scheduleRepeatLabel(schedule.repeat)} at {schedule.at}</p>
          <p>{actionSummary(entry, view.snapshot)}</p>
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
        {reason && <p>{reason}</p>}
        {entry.nextAtMs !== null && <p>Next: {entry.nextLabel}</p>}
        {entry.lastResult && <p class="pels-card-supporting">
          Last: {entry.lastLabel ? `${entry.lastLabel} · ` : ''}{entry.lastResult}
        </p>}
        {grantedLine !== null && <p class="pels-card-supporting">
          {SMART_TASK_EXTRA_PERMISSIONS_TITLE}: {grantedLine}
        </p>}
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
  const deviceName = scheduleDeviceName(view.snapshot, id);
  const name = modeGroup ? 'Mode changes' : deviceName;
  return (
    <section class="pels-surface-card schedule-group" aria-label={`${name} schedules`}>
      <div class="schedule-group__bar">
        <div><h3 class="pels-text-section-headline">{name}</h3>
          <p class="pels-card-supporting">{entries.length} {groupKind(entries)}schedule{entries.length === 1 ? '' : 's'}</p>
        </div>
        <div class="schedule-group__switch">
          <span>{on ? 'On' : 'Off'}</span>
          <MdSwitch key={`${id}:${on}:${view.snapshot.busy}`} selected={on}
            disabled={view.snapshot.busy || view.snapshot.load !== 'ready'}
            aria-label={modeGroup ? 'Scheduled mode changes' : `Schedules for ${deviceName}`}
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
    const key = scheduleActionDeviceId(entry.schedule.action) ?? 'mode';
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
      <p class="pels-card-supporting">Create Smart tasks, start overrides and change mode at the times you choose.</p>
      <div class="schedules-toolbar">
        <MdFilledButton disabled={snapshot.load !== 'ready' || snapshot.busy} onClick={actions.onNew}>New schedule</MdFilledButton>
        <MdTextButton disabled={snapshot.busy} onClick={actions.onRetry}>Refresh</MdTextButton>
      </div>
      {snapshot.read && <p class="pels-card-supporting">Main home · Times in {snapshot.read.timeZone}</p>}
      {next && <section class="pels-surface-card schedules-next" aria-label="Next scheduled action">
        <p class="pels-text-settings-label">Next: {next.nextLabel}</p><p>{next.schedule.name}</p>
      </section>}
      <SegmentedControl contentSized value={snapshot.filter} ariaLabel="Schedule type"
        options={([
          ['all', 'All'], ['task', 'Smart tasks'], ['override', 'Overrides'], ['mode', 'Modes'],
        ] as const).map(([value, label]) => ({
          value, label, disabled: snapshot.busy,
        }))} onChange={actions.onFilter} />
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
  const goal = device && resolveSmartTaskCandidateGoal(device, draft.taskKind);
  const unit = scheduleTaskUnit(draft.taskKind);
  const disabled = snapshot.busy || snapshot.load !== 'ready';
  return (
    <>
      <label class="field"><span class="field__label pels-text-settings-label">Target ({unit})</span>
        <MdFilledTextField key={`${draft.deviceId}:${draft.taskKind}:${Boolean(goal)}`}
          type="number" value={draft.target} min={goal?.goalMin.toString()}
          max={goal?.goalMax.toString()} step={goal?.goalStep.toString()}
          disabled={disabled || !goal} aria-label={`Target (${unit})`}
          onInput={(event: Event) => actions.onDraftChange({ target: inputValue(event) })} />
        {goal && <small class="field__hint">
          {formatSmartTaskGoalRangeHint(goal.goalMin, goal.goalMax, unit)}
        </small>}
      </label>
      {device && device.kind !== draft.taskKind && <div class="pels-notice-info">
        <p>This schedule keeps its {TASK_TARGET_NAMES[draft.taskKind]} target.</p>
        {!goal && <p>This target is currently unavailable.</p>}
        <MdTextButton type="button" disabled={disabled} onClick={() => actions.onDevice(device.deviceId)}>
          Use {TASK_TARGET_NAMES[device.kind]} target
        </MdTextButton>
      </div>}
    </>
  );
};
// What a group's schedules are, when they are all of one kind.
const GROUP_KINDS = { mode: 'mode ', task: 'task ', override: 'override ' } as const;
const groupKind = (entries: readonly ScheduleEntry[]): string => {
  const types = new Set(entries.map((entry) => entry.schedule.action.type));
  const [only] = types;
  return types.size === 1 && only ? GROUP_KINDS[only] : '';
};
/** When a scheduled override ends, under its start time; nothing for the other actions. */
const OverrideEndField = ({ draft, view }: { draft: ScheduleDraft; view: View }) => {
  if (draft.actionType !== 'override') return null;
  const disabled = view.snapshot.busy || view.snapshot.load !== 'ready';
  const onChange = view.actions.onDraftChange;
  const endsNextDay = draft.overrideUntil !== '' && draft.overrideUntil <= draft.at;
  return (
    <label class="field">
      <span class="field__label pels-text-settings-label">End override at</span>
      <input type="time" class="smart-task-edit__time-input" value={draft.overrideUntil} disabled={disabled}
        data-schedule-field="override-until" onInput={(event) => onChange({ overrideUntil: inputValue(event) })} />
      {endsNextDay && <small class="field__hint">Ends the following day.</small>}
    </label>
  );
};
const OverrideFields = ({ draft, view }: { draft: ScheduleDraft; view: View }) => {
  const { snapshot, actions } = view;
  const devices = scheduleOverrideDevices(snapshot.devices);
  const device = devices.find((candidate) => candidate.deviceId === draft.deviceId);
  const goal = device && resolveSmartTaskCandidateGoal(device, 'temperature');
  const disabled = snapshot.busy || snapshot.load !== 'ready';
  return (
    <>
      <div class="field"><span class="field__label pels-text-settings-label">Device</span>
        <MdFilledSelect value={draft.deviceId} aria-label="Override device" disabled={disabled}
          onChange={(event: Event) => actions.onDevice(inputValue(event))}>
          {!device && <Choice value={draft.deviceId}>Choose an available device</Choice>}
          {devices.map((candidate) => (
            <Choice key={candidate.deviceId} value={candidate.deviceId}>{candidate.deviceName}</Choice>
          ))}
        </MdFilledSelect>
      </div>
      <label class="field"><span class="field__label pels-text-settings-label">Temperature (°C)</span>
        <MdFilledTextField key={`${draft.deviceId}:${Boolean(goal)}`} type="number" value={draft.overrideTarget}
          min={goal?.goalMin.toString()} max={goal?.goalMax.toString()} step={goal?.goalStep.toString()}
          disabled={disabled || !goal} aria-label="Temperature (°C)"
          onInput={(event: Event) => actions.onDraftChange({ overrideTarget: inputValue(event) })} />
        {goal && <small class="field__hint">{formatSmartTaskGoalRangeHint(goal.goalMin, goal.goalMax, '°C')}</small>}
        <small class="field__hint">
          Prices and mode changes do not move the temperature meanwhile; power limits still apply.
        </small>
      </label>
    </>
  );
};
const TaskFields = ({ draft, view }: { draft: ScheduleDraft; view: View }) => {
  const { snapshot, actions } = view;
  const device = snapshot.devices.find((candidate) => candidate.deviceId === draft.deviceId);
  const supportsLimit = device && draft.taskKind !== null
    && resolveSmartTaskCandidateGoal(device, draft.taskKind) !== undefined && device.supportsLimitLowerPriority;
  const disabled = snapshot.busy || snapshot.load !== 'ready';
  const savedAction = snapshot.read?.entries.find((entry) => entry.schedule.id === draft.id)?.schedule.action;
  const savedTask = savedAction?.type === 'task' ? savedAction.task : undefined;
  const initiallyOpen = savedTask?.exemptFromBudget === true
    || savedTask?.limitLowerPriorityDevices === true || savedTask?.pauseLowerPriorityDevices === true;
  const grantedLine = formatGrantedRescuePermissionsLine(draft.permissions);
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
        <div class="smart-task-edit__permissions-block">
          <details class="smart-task-edit__permissions" {...(initiallyOpen ? { open: true } : {})}>
            <summary class="smart-task-edit__permissions-summary"><span class="plan-card__title">{SMART_TASK_EXTRA_PERMISSIONS_TITLE}</span>
              <ExpandMoreIcon class="disclosure-chevron" /></summary>
            <p class="section-hint">Saved for each new task this schedule creates.</p>
            {PERMISSION_KEYS.filter((key) => key !== 'limitLowerPriorityDevices' || supportsLimit
              || savedTask?.limitLowerPriorityDevices === true || draft.permissions[key])
              .map((key) => <SmartTaskPermissionRow key={key} label={SMART_TASK_EXTRA_PERMISSION_LABELS[key]}
                hint={SMART_TASK_EXTRA_PERMISSION_HINTS[key]} selected={draft.permissions[key]}
                disabled={disabled || (key === 'limitLowerPriorityDevices' && !supportsLimit && !draft.permissions[key])}
                onToggle={(selected) => actions.onDraftChange({ permissions: { ...draft.permissions, [key]: selected } })} />)}
          </details>
          {grantedLine !== null && <p class="smart-task-edit__permissions-granted">{grantedLine}</p>}
        </div>
      </>}
    </>
  );
};
const ModePreparationSwitch = ({ draft, view }: { draft: ScheduleDraft; view: View }) => {
  const disabled = view.snapshot.busy || view.snapshot.load !== 'ready';
  return (
    <div class="schedule-editor__enabled">
      <div><span class="pels-text-settings-label">Have devices ready by then</span>
        <p class="pels-card-supporting">Start heating eligible devices early toward their new mode temperatures.</p></div>
      <MdSwitch key={`prepare:${draft.prepareMode}:${disabled}`} aria-label="Have devices ready by then"
        selected={draft.prepareMode} disabled={disabled}
        onChange={(event: Event) => view.actions.onDraftChange({ prepareMode: readSwitchSelected(event) })} />
    </div>
  );
};

const Editor = (view: View) => {
  const { snapshot, actions } = view;
  if (!snapshot.editor || !snapshot.read) return null;
  const { draft, kind, timeConflict } = snapshot.editor;
  const disabled = snapshot.busy || snapshot.load !== 'ready';
  const editedEntry = snapshot.read.entries.find((entry) => entry.schedule.id === draft.id);
  const references = kind === 'existing' && editedEntry ? editedEntry.modeReferences : [];
  const modeOptions = scheduleModeOptions(snapshot.read.modes, references);
  const unavailableConditions = draft.conditionModes.filter((mode) => (
    !modeOptions.some((option) => option.value === mode)
  ));
  return (
    <>
      <div class="pels-appbar"><MdIconButton disabled={snapshot.busy} onClick={actions.onBack} aria-label="Back to schedules"><ArrowBackIcon /></MdIconButton>
        <h2 class="pels-appbar__title" id="schedule-editor-heading" tabIndex={-1}>{kind === 'new' ? 'New schedule' : 'Edit schedule'}</h2></div>
      {editedEntry && <section class={editedEntry.state === 'invalid' ? 'pels-notice-warning' : 'pels-notice-info'}
        aria-label="Saved schedule status">
        <p class="pels-text-settings-label">Saved schedule: {STATE_LABELS[editedEntry.state]}</p>
        {scheduleReason(editedEntry, snapshot) && <p>{scheduleReason(editedEntry, snapshot)}</p>}
        {editedEntry.nextAtMs !== null && <p>Next: {editedEntry.nextLabel}</p>}
      </section>}
      <div class="pels-surface-card schedule-editor__enabled">
        <div><h3 class="pels-text-settings-label">Enabled</h3>
          <p class="pels-card-supporting">Save to apply changes.</p></div>
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
          <SegmentedControl contentSized value={draft.actionType} ariaLabel="Scheduled action"
            options={[
              { value: 'task', label: 'Smart task', disabled },
              { value: 'override', label: 'Override', disabled },
              { value: 'mode', label: 'Mode', disabled },
            ]} onChange={actions.onSelectAction} />
          {draft.actionType === 'override' && <OverrideFields draft={draft} view={view} />}
          {draft.actionType === 'task' && <TaskFields draft={draft} view={view} />}
          {draft.actionType === 'mode' && <>
            <div class="field"><span class="field__label pels-text-settings-label">Set mode to</span>
              <MdFilledSelect value={draft.mode} aria-label="Set mode to" disabled={disabled}
                onChange={(event: Event) => actions.onDraftChange({ mode: inputValue(event) })}>
                {!modeOptions.some((option) => option.value === draft.mode)
                  && <Choice value={draft.mode}>Choose an available mode</Choice>}
                {modeOptions.map((option) => <Choice key={option.value} value={option.value}>{option.label}</Choice>)}
              </MdFilledSelect>
            </div>
            <ModePreparationSwitch draft={draft} view={view} />
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
          <label class="field"><span class="field__label pels-text-settings-label">{ACTION_TIME_LABELS[draft.actionType]}</span>
            <input type="time" class="smart-task-edit__time-input" value={draft.at} disabled={disabled}
              data-schedule-field="time" aria-invalid={timeConflict} aria-describedby={timeConflict ? 'schedule-time-conflict' : undefined}
              onInput={(event) => actions.onDraftChange({ at: inputValue(event) })} />
            {timeConflict
              ? <small class="field__hint smart-task-edit__error" id="schedule-time-conflict" role="alert">
                Another schedule {ACTION_CONFLICTS[draft.actionType]} at this time. Choose another time or day.
              </small>
              : draft.actionType === 'task' && draft.repeat !== 'once' && <small class="field__hint">
                The repeat days count from this time, even when the task is ready the following day.
              </small>}
          </label>
          <OverrideEndField draft={draft} view={view} />
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
