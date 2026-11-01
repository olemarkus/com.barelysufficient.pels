import { describe, expect, it } from 'vitest';
import type { SmartTaskCandidateDevice } from '../../contracts/src/smartTaskEdit.ts';
import {
  buildScheduleFromDraft, createScheduleDraft, daysForRepeat, editScheduleDraft,
  scheduleReadyByDay, scheduleRepeatLabel,
} from '../src/ui/scheduleDraft.ts';

const HEATER: SmartTaskCandidateDevice = {
  deviceId: 'heater', deviceName: 'Water heater', kind: 'temperature', group: 'heating',
  unitSymbol: '°C', goalMin: 30, goalMax: 75, goalStep: 0.5, defaultGoal: 65, currentValue: 40,
  supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [],
};
const EV: SmartTaskCandidateDevice = {
  ...HEATER, deviceId: 'charger', deviceName: 'Charger', kind: 'ev_soc', group: 'ev_charger',
  unitSymbol: '%', goalMin: 1, goalMax: 100, goalStep: 1, defaultGoal: 80,
  otherGoals: [{ kind: 'energy', unitSymbol: 'kWh', goalMin: 0.1, goalMax: 200, goalStep: 0.1 }],
};
const ENERGY: SmartTaskCandidateDevice = {
  ...EV, kind: 'energy', unitSymbol: 'kWh', goalMin: 0.1, goalMax: 200, goalStep: 0.1, defaultGoal: 20,
  otherGoals: [{ kind: 'ev_soc', unitSymbol: '%', goalMin: 1, goalMax: 100, goalStep: 1 }],
};
const MODES = ['Home', 'Away', 'Night'];

describe('Schedule composition', () => {
  it('keeps selected action days separate from an overnight ready-by time', () => {
    const draft = createScheduleDraft(HEATER, 'Home', '2026-11-02', []);
    draft.repeat = 'custom';
    draft.days = [1, 3];
    draft.at = '21:00';
    draft.readyBy = '06:00';
    const result = buildScheduleFromDraft(draft, [HEATER], MODES, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.repeat).toEqual({ type: 'weekly', days: [1, 3] });
    expect(result.schedule.action).toMatchObject({ type: 'task', task: { readyByLocalTime: '06:00' } });
    expect(scheduleReadyByDay(draft.at, draft.readyBy)).toBe('the following day');
    expect(scheduleRepeatLabel(result.schedule.repeat)).toBe('Mon, Wed');
  });

  it('presets use explicit calendar days, with no holiday policy', () => {
    expect(daysForRepeat('weekdays')).toEqual([1, 2, 3, 4, 5]);
    expect(daysForRepeat('weekends')).toEqual([6, 7]);
  });

  it('requires selected modes for a condition and retains the exact include/exclude choice', () => {
    const draft = createScheduleDraft(undefined, 'Home', '2026-11-02', []);
    draft.conditionType = 'exclude';
    expect(buildScheduleFromDraft(draft, [HEATER], MODES, [])).toEqual({ ok: false, error: 'Choose the modes this condition should use.' });
    draft.conditionModes = ['Away'];
    const result = buildScheduleFromDraft(draft, [HEATER], MODES, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schedule.condition).toEqual({ type: 'exclude', modes: ['Away'] });
  });

  it('keeps a stable schedule identity and permission snapshots across edits', () => {
    const draft = createScheduleDraft(HEATER, 'Home', '2026-11-02', []);
    draft.permissions.exemptFromBudget = true;
    const result = buildScheduleFromDraft(draft, [HEATER], MODES, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edited = editScheduleDraft(result.schedule, '2026-11-03');
    edited.name = 'Morning water';
    edited.permissions.limitLowerPriorityDevices = true;
    edited.permissions.exemptFromBudget = false;
    expect(edited.id).toBe(draft.id);
    const rebuilt = buildScheduleFromDraft(edited, [HEATER], MODES, []);
    expect(rebuilt.ok && rebuilt.schedule.action).toMatchObject({
      type: 'task', task: { limitLowerPriorityDevices: true },
    });
    expect(result.schedule.action).toMatchObject({ type: 'task', task: { exemptFromBudget: true } });
  });

  it('rejects unavailable devices and out-of-range targets without inventing defaults', () => {
    const draft = createScheduleDraft(HEATER, 'Home', '2026-11-02', []);
    expect(buildScheduleFromDraft(draft, [], MODES, []).ok).toBe(false);
    draft.target = '76';
    expect(buildScheduleFromDraft(draft, [HEATER], MODES, []).ok).toBe(false);
  });

  it.each([{ original: EV, offered: ENERGY }, { original: ENERGY, offered: EV }])(
    'keeps a supported target kind when a charger defaults to another task kind', ({ original, offered }) => {
      const draft = createScheduleDraft(original, 'Home', '2026-11-02', []);
      const saved = buildScheduleFromDraft(draft, [original], MODES, []);
      if (!saved.ok) throw new Error(saved.error);
      const edited = editScheduleDraft(saved.schedule, '2026-11-03');
      edited.name = 'Renamed schedule';
      expect(edited.taskKind).toBe(original.kind);
      const changedDefault = buildScheduleFromDraft(edited, [offered], MODES, []);
      expect(changedDefault.ok && changedDefault.schedule.action).toMatchObject({
        type: 'task', task: { kind: original.kind, target: original.defaultGoal },
      });
      const restored = buildScheduleFromDraft(edited, [original], MODES, []);
      expect(restored.ok && restored.schedule.action).toMatchObject({
        type: 'task', task: { kind: original.kind, target: original.defaultGoal },
      });
    },
  );

  it('uses the retained energy target bounds rather than the default battery bounds', () => {
    const draft = createScheduleDraft(ENERGY, 'Home', '2026-11-02', []);
    draft.target = '150';
    const supported = buildScheduleFromDraft(draft, [EV], MODES, []);
    expect(supported.ok && supported.schedule.action).toMatchObject({
      type: 'task', task: { kind: 'energy', target: 150 },
    });
    draft.target = '201';
    expect(buildScheduleFromDraft(draft, [EV], MODES, [])).toEqual({
      ok: false, error: 'Choose a target between 0.1 and 200 kWh.',
    });
  });

  it('rejects a retained energy goal when live power no longer supports it', () => {
    const draft = createScheduleDraft(ENERGY, 'Home', '2026-11-02', []);
    expect(buildScheduleFromDraft(draft, [{ ...EV, otherGoals: [] }], MODES, [])).toEqual({
      ok: false, error: 'This target is not available for this device. Choose another target or device.',
    });
  });

  it.each(['include', 'exclude'] as const)('requires removing unavailable %s condition values', (conditionType) => {
    const draft = createScheduleDraft(undefined, 'Home', '2026-11-02', []);
    draft.conditionType = conditionType;
    draft.conditionModes = ['Removed', 'Home'];
    expect(buildScheduleFromDraft(draft, [], MODES, []).ok).toBe(false);
    draft.conditionModes = ['Home'];
    const repaired = buildScheduleFromDraft(draft, [], MODES, []);
    expect(repaired.ok && repaired.schedule.condition).toEqual({ type: conditionType, modes: ['Home'] });
  });
  it('preserves retained names only when the owner resolves those references', () => {
    const draft = createScheduleDraft(undefined, 'Old Home', '2026-11-02', []);
    draft.conditionType = 'include';
    draft.conditionModes = ['Old Night'];
    const references = [{ stored: 'Old Home', resolved: 'Home' }, { stored: 'Old Night', resolved: 'Night' }];
    const result = buildScheduleFromDraft(draft, [], MODES, references);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.action).toEqual({ type: 'mode', mode: 'Old Home' });
      expect(result.schedule.condition).toEqual({ type: 'include', modes: ['Old Night'] });
    }
    expect(buildScheduleFromDraft(draft, [], MODES, []).ok).toBe(false);
  });

});
