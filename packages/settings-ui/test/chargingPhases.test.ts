import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ChargingPhasesView, chargingPhaseStatusText } from '../src/ui/views/ChargingPhases.tsx';
import type { ChargingPhaseRead } from '../../contracts/src/chargingPhases.ts';

const read: Extract<ChargingPhaseRead, { kind: 'supported' }> = {
  kind: 'supported', deviceId: 'garage', mode: 'charger', installationConfirmed: false,
  status: { kind: 'charger' },
};

beforeEach(() => { document.body.innerHTML = '<div id="phases"></div>'; });
afterEach(() => { render(null, document.getElementById('phases')!); });

const saveButton = () => document.querySelector<HTMLElement>('md-outlined-button')!;
const choose = async (label: string, value: string) => act(async () => {
  const field = [...document.querySelectorAll<HTMLElement & { value: string; label: string }>('md-filled-select')]
    .find((element) => element.label === label)!;
  field.value = value;
  field.dispatchEvent(new Event('change'));
});

test('requires an explicit house phase and installation confirmation before enabling physical control', async () => {
  const onSave = vi.fn(async () => true);
  act(() => render(h(ChargingPhasesView, { read, singlePhase: 'unselected', onSave }), document.getElementById('phases')!));
  await choose('Charging phases', 'automatic');
  expect(saveButton().hasAttribute('disabled')).toBe(true);
  await choose('House phase', 'L2');
  expect(saveButton().hasAttribute('disabled')).toBe(true);
  await act(async () => {
    const confirmation = document.querySelector<HTMLElement & { selected: boolean }>('md-switch')!;
    confirmation.selected = true;
    confirmation.dispatchEvent(new Event('change'));
  });
  expect(saveButton().hasAttribute('disabled')).toBe(false);
  await act(async () => saveButton().click());
  expect(onSave).toHaveBeenCalledWith('automatic', 'L2');
});

test('allows returning control to the charger without confirming an installation', async () => {
  const onSave = vi.fn(async () => true);
  act(() => render(h(ChargingPhasesView, { read, singlePhase: 'unselected', onSave }), document.getElementById('phases')!));
  expect(saveButton().hasAttribute('disabled')).toBe(false);
  await act(async () => saveButton().click());
  expect(onSave).toHaveBeenCalledWith('charger', 'unselected');
});

test('keeps the chosen setting visible when saving fails', async () => {
  const onSave = vi.fn(async () => false);
  act(() => render(h(ChargingPhasesView, { read, singlePhase: 'L1', onSave }), document.getElementById('phases')!));
  await act(async () => saveButton().click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be saved');
  expect(document.querySelector<HTMLElement & { value: string }>('md-filled-select')?.value).toBe('charger');
});

test('describes a pending request as a transition rather than completed charging', () => {
  expect(chargingPhaseStatusText({ kind: 'switching', from: 3, to: 1 })).toBe('Changing to one phase…');
  expect(chargingPhaseStatusText({ kind: 'releasing' })).toContain('Returning phase control');
});

test('uses a house phase changed by another control before saving the selected mode', async () => {
  const onSave = vi.fn(async () => true);
  const root = document.getElementById('phases')!;
  const configured = { ...read, mode: 'automatic' as const, installationConfirmed: true };
  await act(async () => render(h(ChargingPhasesView, { read: configured, singlePhase: 'L1', onSave }), root));
  await choose('Charging phases', 'single');
  await act(async () => render(h(ChargingPhasesView, { read: configured, singlePhase: 'L2', onSave }), root));
  await act(async () => saveButton().click());
  expect(onSave).toHaveBeenCalledWith('single', 'L2');
});
