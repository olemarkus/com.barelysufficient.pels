import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleEntry } from '../../contracts/src/schedules.ts';
import type { SmartTaskCandidateDevice } from '../../contracts/src/smartTaskEdit.ts';
import { editScheduleDraft } from '../src/ui/scheduleDraft.ts';
import type { SchedulesViewSnapshot } from '../src/ui/schedulesTypes.ts';
import { renderSchedules, type SchedulesActions } from '../src/ui/views/Schedules.tsx';
import { SMART_TASK_EXTRA_PERMISSION_LABELS } from '../../shared-domain/src/smartTaskCopy/permissionsCopy.ts';

const HEATER: SmartTaskCandidateDevice = {
  deviceId: 'heater', deviceName: 'Water heater', kind: 'temperature', group: 'heating',
  unitSymbol: '°C', goalMin: 30, goalMax: 75, goalStep: 0.5, defaultGoal: 65, currentValue: 40,
  supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [],
};
const actions: SchedulesActions = {
  onRetry: vi.fn(), onNew: vi.fn(), onEdit: vi.fn(), onBack: vi.fn(), onDraftChange: vi.fn(),
  onSelectAction: vi.fn(), onDevice: vi.fn(), onRepeat: vi.fn(), onDay: vi.fn(), onConditionMode: vi.fn(),
  onSave: vi.fn(), onDelete: vi.fn(), onToggle: vi.fn(), onModeGroup: vi.fn(), onDeviceGroup: vi.fn(), onFilter: vi.fn(),
};
const savedEntry = (): ScheduleEntry => ({
  schedule: {
    id: 'water', name: 'Overnight water', enabled: true, at: '21:00',
    repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] }, condition: { type: 'any' },
    action: { type: 'task', task: {
      deviceId: 'heater', kind: 'temperature', target: 65, readyByLocalTime: '07:00',
      exemptFromBudget: true, limitLowerPriorityDevices: true, pauseLowerPriorityDevices: false,
    } },
  },
  modeReferences: [], state: 'on', reason: '', nextAtMs: 1, nextLabel: 'Tomorrow 21:00', lastResult: '', lastLabel: '',
});
const snapshotFor = (entry: ScheduleEntry): SchedulesViewSnapshot => ({
  load: 'ready', busy: false, error: '', filter: 'all', devices: [HEATER],
  read: {
    timeZone: 'Europe/Oslo', modes: ['Home'],
    controls: { modeChangesEnabled: true, disabledTaskDeviceIds: [] }, entries: [entry],
  },
  editor: { kind: 'existing', draft: editScheduleDraft(entry.schedule, '2026-11-02'), timeConflict: false, nameSet: true, timeSet: true },
});
const mounts: HTMLElement[] = [];
const paint = (mount: HTMLElement, snapshot: SchedulesViewSnapshot): void => {
  act(() => renderSchedules(mount, snapshot, actions));
};
const mountView = (snapshot: SchedulesViewSnapshot): HTMLElement => {
  const mount = document.createElement('div');
  document.body.append(mount);
  mounts.push(mount);
  paint(mount, snapshot);
  return mount;
};

afterEach(() => {
  act(() => { for (const mount of mounts.splice(0)) render(null, mount); });
  document.body.replaceChildren();
});

describe('Schedule editor state', () => {
  it.each([
    { state: 'invalid' as const, label: 'Needs attention', reason: 'This mode is no longer available. Edit the schedule.' },
    { state: 'finished' as const, label: 'Finished', reason: 'No future triggers' },
    { state: 'paused' as const, label: 'Paused', reason: 'Scheduled tasks for this device are off.' },
  ])('shows the saved $state state while the enabled draft is edited', ({ state, label, reason }) => {
    const entry = { ...savedEntry(), state, reason, nextAtMs: null, nextLabel: '' };
    const snapshot = snapshotFor(entry);
    const mount = mountView(snapshot);
    const status = mount.querySelector('[aria-label="Saved schedule status"]');
    expect(status?.textContent).toContain(`Saved schedule: ${label}`);
    expect(status?.textContent).toContain(reason);
    expect(mount.textContent).not.toContain('Runs at the times below.');
    expect(mount.textContent).not.toContain('Schedule on');
    if (!snapshot.editor) throw new Error('Missing editor');
    snapshot.editor.draft.at = '20:00';
    snapshot.editor.draft.enabled = false;
    paint(mount, snapshot);
    expect(status?.textContent).toContain(`Saved schedule: ${label}`);
    expect(mount.querySelector('.schedule-editor__enabled')?.textContent).toContain('Save to apply changes.');
  });

  it('does not claim a new draft is already saved or running', () => {
    const snapshot = snapshotFor(savedEntry());
    if (!snapshot.editor || !snapshot.read) throw new Error('Missing editor');
    snapshot.editor.kind = 'new';
    snapshot.read.entries = [];
    const mount = mountView(snapshot);
    expect(mount.querySelector('[aria-label="Saved schedule status"]')).toBeNull();
    expect(mount.querySelector('.schedule-editor__enabled')?.textContent).toContain('Enabled');
    expect(mount.textContent).not.toContain('Runs at the times below.');
    expect(mount.textContent).not.toContain('Saved, with no future actions.');
  });
});

describe('Scheduled task permissions', () => {
  it('shows saved grants on list rows before the editor is opened', () => {
    const snapshot = snapshotFor(savedEntry());
    snapshot.editor = null;
    const mount = mountView(snapshot);
    const row = mount.querySelector('[data-schedule-id="water"]');
    expect(row?.textContent).toContain(`Extra permissions: ${SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget}`);
    expect(row?.textContent).toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices);
    expect(row?.textContent).not.toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.pauseLowerPriorityDevices);
  });

  it('opens saved grants initially and keeps their summary visible after manual collapse and draft changes', () => {
    const snapshot = snapshotFor(savedEntry());
    const mount = mountView(snapshot);
    const disclosure = mount.querySelector<HTMLDetailsElement>('details.smart-task-edit__permissions');
    const summary = mount.querySelector('.smart-task-edit__permissions-granted');
    expect(disclosure?.open).toBe(true);
    expect(disclosure?.contains(summary)).toBe(false);
    expect(summary?.textContent).toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget);
    if (!disclosure || !snapshot.editor) throw new Error('Missing permissions editor');
    disclosure.open = false;
    snapshot.editor.draft.permissions.exemptFromBudget = false;
    paint(mount, snapshot);
    expect(disclosure.open).toBe(false);
    expect(summary?.textContent).not.toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget);
    expect(summary?.textContent).toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices);
  });

  it('does not reopen a new draft disclosure when its grants change', () => {
    const snapshot = snapshotFor(savedEntry());
    if (!snapshot.editor || !snapshot.read) throw new Error('Missing editor');
    snapshot.editor.kind = 'new';
    snapshot.read.entries = [];
    const mount = mountView(snapshot);
    const disclosure = mount.querySelector<HTMLDetailsElement>('details.smart-task-edit__permissions');
    expect(disclosure?.open).toBe(false);
    snapshot.editor.draft.permissions.pauseLowerPriorityDevices = true;
    paint(mount, snapshot);
    expect(disclosure?.open).toBe(false);
    expect(mount.querySelector('.smart-task-edit__permissions-granted')?.textContent)
      .toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.pauseLowerPriorityDevices);
  });

  it('keeps a standing limit grant visible for revocation when the device no longer supports a new grant', () => {
    const snapshot = snapshotFor(savedEntry());
    const mount = mountView(snapshot);
    const limitSwitch = mount.querySelector<HTMLElement & { selected: boolean }>(
      'md-switch[aria-label="May limit lower-priority devices"]',
    );
    expect(limitSwitch?.hasAttribute('disabled')).toBe(false);
    if (!limitSwitch || !snapshot.editor) throw new Error('Missing limit permission');
    limitSwitch.selected = false;
    limitSwitch.dispatchEvent(new Event('change', { bubbles: true }));
    expect(actions.onDraftChange).toHaveBeenCalledWith({ permissions: {
      exemptFromBudget: true, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false,
    } });
    snapshot.editor.draft.permissions.limitLowerPriorityDevices = false;
    paint(mount, snapshot);
    expect(mount.querySelector('md-switch[aria-label="May limit lower-priority devices"]')).toBe(limitSwitch);
    expect(limitSwitch.hasAttribute('disabled')).toBe(true);
  });
});
