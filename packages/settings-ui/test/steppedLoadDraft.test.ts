import type {
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../contracts/src/types';

const createElement = (tag: string, id?: string): HTMLElement => {
  const el = document.createElement(tag);
  if (id) el.id = id;
  return el;
};

const setupDom = (): void => {
  document.body.replaceChildren();
  const section = createElement('section', 'device-detail-stepped-section');
  section.appendChild(createElement('div', 'device-detail-stepped-steps'));
  section.appendChild(createElement('md-text-button', 'device-detail-stepped-add-step'));
  section.appendChild(createElement('md-text-button', 'device-detail-stepped-reset'));
  section.appendChild(createElement('md-text-button', 'device-detail-stepped-save'));
  document.body.appendChild(section);
  document.body.appendChild(createElement('md-filled-select', 'device-detail-overshoot'));
};

const buildSteppedDevice = (
  id: string,
  steps: SteppedLoadProfile['steps'],
): TargetDeviceSnapshot & SteppedLoadDescriptorProbe => ({ expectedPowerKw: 1, expectedPowerSource: 'default',
  id,
  name: `Stepped Device ${id}`,
  binaryControl: { on: true },
  targets: [],
  // `controlModel: 'stepped_load'` makes getEffectiveControlModel resolve to
  // stepped_load without needing state.deviceControlProfiles wired up.
  controlModel: 'stepped_load',
  steppedLoadProfile: { model: 'stepped_load', steps },
});

const readDraftSteps = (): Array<{ id: string; planningPowerW: number }> => {
  const steps = document.querySelectorAll('#device-detail-stepped-steps [data-step-row="true"]');
  return Array.from(steps).map((row) => {
    const idEl = row.querySelector('[data-step-field="id"]') as (HTMLElement & { value?: string }) | null;
    const powerEl = row.querySelector('[data-step-field="planningPowerW"]') as (HTMLElement & { value?: string }) | null;
    return {
      id: idEl?.value ?? '',
      planningPowerW: Number(powerEl?.value ?? 0),
    };
  });
};

const mutateFirstRowPower = (newPower: number): void => {
  const powerEl = document.querySelector(
    '#device-detail-stepped-steps [data-step-row="true"]:first-of-type [data-step-field="planningPowerW"]',
  ) as (HTMLElement & { value?: string }) | null;
  if (!powerEl) throw new Error('No first row planning power input found');
  powerEl.value = String(newPower);
  // The handlers attach 'change' and 'input' listeners; dispatch both to ensure
  // the draft sync runs in either ordering.
  powerEl.dispatchEvent(new Event('input', { bubbles: true }));
  powerEl.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('steppedLoadDraft per-device draft preservation', () => {
  beforeEach(() => {
    vi.resetModules();
    setupDom();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('preserves device A draft when switching to device B and back', async () => {
    const { renderSteppedLoadDraft } = await import('../src/ui/deviceDetail/steppedLoadDraft.ts');

    const deviceA = buildSteppedDevice('device-A', [
      { id: 'step_1', planningPowerW: 1000 },
      { id: 'step_2', planningPowerW: 2000 },
    ]);
    const deviceB = buildSteppedDevice('device-B', [
      { id: 'step_1', planningPowerW: 500 },
    ]);

    // Open device A and edit step_1's planning power from 1000 -> 1337 (unsaved).
    renderSteppedLoadDraft(deviceA);
    expect(readDraftSteps()).toEqual([
      { id: 'step_1', planningPowerW: 1000 },
      { id: 'step_2', planningPowerW: 2000 },
    ]);
    mutateFirstRowPower(1337);

    // Switch panes to device B (no close in between — switching, not closing).
    renderSteppedLoadDraft(deviceB);
    expect(readDraftSteps()).toEqual([
      { id: 'step_1', planningPowerW: 500 },
    ]);

    // Switch back to device A — the unsaved 1337 edit must survive.
    renderSteppedLoadDraft(deviceA);
    expect(readDraftSteps()).toEqual([
      { id: 'step_1', planningPowerW: 1337 },
      { id: 'step_2', planningPowerW: 2000 },
    ]);
  });

  it('drops only the closing device draft, not other devices', async () => {
    const { renderSteppedLoadDraft, closeSteppedLoadDraft } = await import(
      '../src/ui/deviceDetail/steppedLoadDraft.ts'
    );

    const deviceA = buildSteppedDevice('device-A', [
      { id: 'step_1', planningPowerW: 1000 },
    ]);
    const deviceB = buildSteppedDevice('device-B', [
      { id: 'step_1', planningPowerW: 500 },
    ]);

    // Populate drafts for both devices with unsaved edits.
    renderSteppedLoadDraft(deviceA);
    mutateFirstRowPower(1500);
    renderSteppedLoadDraft(deviceB);
    mutateFirstRowPower(600);

    // Close device B (the currently-open one). Only B's draft should drop.
    closeSteppedLoadDraft('device-B');

    // Reopening B falls back to saved profile (500), confirming its draft was cleared.
    renderSteppedLoadDraft(deviceB);
    expect(readDraftSteps()).toEqual([
      { id: 'step_1', planningPowerW: 500 },
    ]);

    // A's unsaved edit (1500) must still be present.
    renderSteppedLoadDraft(deviceA);
    expect(readDraftSteps()).toEqual([
      { id: 'step_1', planningPowerW: 1500 },
    ]);
  });

  it('ignores empty deviceId when closing draft (defensive)', async () => {
    const { renderSteppedLoadDraft, closeSteppedLoadDraft } = await import(
      '../src/ui/deviceDetail/steppedLoadDraft.ts'
    );

    const deviceA = buildSteppedDevice('device-A', [
      { id: 'step_1', planningPowerW: 1000 },
    ]);
    renderSteppedLoadDraft(deviceA);
    mutateFirstRowPower(1234);

    // Call with empty string — no draft should be wiped.
    closeSteppedLoadDraft('');
    renderSteppedLoadDraft(deviceA);
    expect(readDraftSteps()).toEqual([
      { id: 'step_1', planningPowerW: 1234 },
    ]);
  });

  it('keeps Save and Undo disabled until an edit exists (Add step stays available)', async () => {
    const { renderSteppedLoadDraft } = await import('../src/ui/deviceDetail/steppedLoadDraft.ts');

    renderSteppedLoadDraft(buildSteppedDevice('device-dirty', [
      { id: 'step_1', planningPowerW: 1000 },
    ]));

    const save = document.querySelector('#device-detail-stepped-save') as HTMLElement & { disabled: boolean };
    const undo = document.querySelector('#device-detail-stepped-reset') as HTMLElement & { disabled: boolean };
    const add = document.querySelector('#device-detail-stepped-add-step') as HTMLElement & { disabled: boolean };

    // At rest (draft matches the saved profile), Save/Undo are inert; Add is live.
    expect(save.disabled).toBe(true);
    expect(undo.disabled).toBe(true);
    expect(add.disabled).toBe(false);

    // A real edit makes both Save and Undo actionable.
    mutateFirstRowPower(1500);
    expect(save.disabled).toBe(false);
    expect(undo.disabled).toBe(false);
  });

  it('renders a muted trash icon-button per row instead of a red Remove text link', async () => {
    const { renderSteppedLoadDraft } = await import('../src/ui/deviceDetail/steppedLoadDraft.ts');

    renderSteppedLoadDraft(buildSteppedDevice('device-remove', [
      { id: 'step_1', planningPowerW: 1000 },
      { id: 'step_2', planningPowerW: 2000 },
    ]));

    const removes = document.querySelectorAll('#device-detail-stepped-steps .detail-stepped-remove');
    expect(removes).toHaveLength(2);
    expect(removes[0].tagName.toLowerCase()).toBe('md-icon-button');
    // No destructive "Remove" text link survives in the stepped editor.
    expect(document.querySelector('#device-detail-stepped-steps .md-text-button--destructive')).toBeNull();

    // Per-row field labels are dropped in favour of the shared column headers.
    const idInput = document.querySelector('#device-detail-stepped-steps [data-step-field="id"]');
    expect(idInput?.getAttribute('label')).toBeNull();
  });
});
