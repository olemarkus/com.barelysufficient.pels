// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import type { ScheduleEntry } from '../../contracts/src/schedules.ts';
import { editScheduleDraft } from '../src/ui/scheduleDraft.ts';
import { scheduleModeOptions } from '../src/ui/scheduleModeReferences.ts';
import type { SchedulesViewSnapshot } from '../src/ui/schedulesTypes.ts';
import { renderSchedules, type SchedulesActions } from '../src/ui/views/Schedules.tsx';

const entry: ScheduleEntry = {
  schedule: {
    id: 'evening', name: 'Evening routine', enabled: true, at: '22:00',
    repeat: { type: 'weekly', days: [1] }, action: { type: 'mode', mode: 'Old Home' },
    condition: { type: 'include', modes: ['Old Night'] },
  },
  modeReferences: [{ stored: 'Old Home', resolved: 'Home' }, { stored: 'Old Night', resolved: 'Night' }],
  state: 'on', reason: '', nextAtMs: 1, nextLabel: 'Tomorrow 22:00', lastResult: '',
};
const actions: SchedulesActions = {
  onRetry: vi.fn(), onNew: vi.fn(), onEdit: vi.fn(), onBack: vi.fn(), onDraftChange: vi.fn(),
  onSelectAction: vi.fn(), onDevice: vi.fn(), onRepeat: vi.fn(), onDay: vi.fn(), onConditionMode: vi.fn(),
  onSave: vi.fn(), onDelete: vi.fn(), onToggle: vi.fn(), onModeGroup: vi.fn(), onDeviceGroup: vi.fn(), onFilter: vi.fn(),
};

const snapshot = (): SchedulesViewSnapshot => ({
  load: 'ready', busy: false, error: '', editor: null, filter: 'all', devices: [],
  read: { timeZone: 'Europe/Oslo', modes: ['Home', 'Night'], entries: [entry],
    controls: { modeChangesEnabled: true, disabledTaskDeviceIds: [] } },
});
const root = document.createElement('div');
afterEach(() => { render(null, root); });

describe('Retained schedule mode labels', () => {
  it('lists the actual destination and condition without rewriting the saved definition', () => {
    renderSchedules(root, snapshot(), actions);
    expect(root.textContent).toContain('Set mode to Home');
    expect(root.textContent).toContain('Only in Night');
    expect(root.textContent).not.toContain('Old Home');
    expect(entry.schedule.action).toEqual({ type: 'mode', mode: 'Old Home' });
  });

  it('labels retained picker and checkbox choices while their values remain stored names', () => {
    const editing = snapshot();
    editing.editor = { kind: 'existing', draft: editScheduleDraft(entry.schedule, '2026-11-02') };
    renderSchedules(root, editing, actions);
    const retained = [...root.querySelectorAll<HTMLElement & { value: string }>('md-select-option')]
      .find((option) => option.value === 'Old Home');
    expect(retained?.textContent).toBe('Home (saved as Old Home)');
    expect(root.querySelector('md-checkbox[aria-label="Night (saved as Old Night)"]')).not.toBeNull();
    expect(editing.editor.draft.mode).toBe('Old Home');
    expect(editing.editor.draft.conditionModes).toEqual(['Old Night']);
  });

  it('does not duplicate a picker value when a retained name also exists in the current catalog', () => {
    expect(scheduleModeOptions(['Home', 'Work'], [{ stored: 'Home', resolved: 'Work' }])).toEqual([
      { value: 'Work', label: 'Work' }, { value: 'Home', label: 'Work (saved as Home)' },
    ]);
  });
});
