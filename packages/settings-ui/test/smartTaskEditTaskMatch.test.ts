import type { SmartTaskEditContext, SmartTaskEditSnapshot } from '../src/ui/smartTaskEdit.ts';
import { snapshotMatchesTask } from '../src/ui/deadlinePlanMount.ts';

const NO_PERMISSIONS = {
  exemptFromBudget: false,
  limitLowerPriorityDevices: false,
  pauseLowerPriorityDevices: false,
};

const CONTEXT: SmartTaskEditContext = {
  deviceId: 'dev_water_heater',
  deviceName: 'Water heater',
  kind: 'temperature',
  unit: '°C',
  min: 30,
  max: 75,
  step: 0.5,
  baselineReadyBy: '07:00',
  baselineTarget: 65,
  baselineDeadlineAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
  baselinePermissions: NO_PERMISSIONS,
  supportsLimitLowerPriority: true,
};

const openedOn = (
  context: SmartTaskEditContext,
  busy: SmartTaskEditSnapshot['busy'] = 'idle',
): SmartTaskEditSnapshot => ({
  context,
  draft: { readyBy: '08:00', target: '70', permissions: NO_PERMISSIONS },
  dirty: true,
  valid: true,
  busy,
  preview: null,
  errorLine: null,
  clearArmed: false,
  clearOnly: false,
});

describe('snapshotMatchesTask', () => {
  it('keeps the open editor while the live task is the one it opened on', () => {
    expect(snapshotMatchesTask(openedOn(CONTEXT), CONTEXT)).toBe(true);
  });

  it('closes an editor whose task was replaced on the same device', () => {
    const editor = openedOn(CONTEXT);
    expect(snapshotMatchesTask(editor, { ...CONTEXT, baselineTarget: 55 })).toBe(false);
    expect(snapshotMatchesTask(editor, { ...CONTEXT, baselineDeadlineAtMs: CONTEXT.baselineDeadlineAtMs + 86_400_000 }))
      .toBe(false);
    expect(snapshotMatchesTask(editor, { ...CONTEXT, kind: 'energy' })).toBe(false);
  });

  it('never carries an editor across devices, even mid-save', () => {
    expect(snapshotMatchesTask(openedOn(CONTEXT, 'saving'), { ...CONTEXT, deviceId: 'dev_other' })).toBe(false);
  });

  it('keeps the editor through a permission change and through its own save', () => {
    const granted = { ...NO_PERMISSIONS, exemptFromBudget: true };
    expect(snapshotMatchesTask(openedOn(CONTEXT), { ...CONTEXT, baselinePermissions: granted })).toBe(true);
    expect(snapshotMatchesTask(openedOn(CONTEXT, 'saving'), { ...CONTEXT, baselineTarget: 70 })).toBe(true);
  });
});
