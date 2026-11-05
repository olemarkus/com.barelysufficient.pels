import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import {
  SetupGoalPicker, SetupJourneyHeader, type SetupJourneyHeaderProps,
} from '../src/ui/views/SetupJourney.tsx';
import type { SetupGoalChoice } from '../src/ui/setupGoals.ts';

type Field = HTMLElement & { value: string; error?: boolean };
type Switch = HTMLElement & { selected: boolean; disabled: boolean };

const mount = (): HTMLElement => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
};

afterEach(() => {
  document.body.replaceChildren();
});

const battery = (overrides: Partial<SetupGoalChoice> = {}): SetupGoalChoice => ({
  id: 'battery',
  name: 'Thuisbatterij',
  price: null,
  smartTask: null,
  solar: null,
  battery: { state: 'ready', enabled: false, capacityKWh: null, simulating: true },
  ...overrides,
});

const renderPicker = (devices: SetupGoalChoice[], onBatteryPlan = vi.fn()) => {
  const root = mount();
  act(() => {
    render(h(() => SetupGoalPicker({
      choices: { state: 'ready', priceSource: null, devices },
      busy: false,
      onPrice: vi.fn(),
      onNewSmartTask: vi.fn(),
      onOpenSmartTask: vi.fn(),
      onBatteryPlan,
      onOpen: vi.fn(),
      onRetry: vi.fn(),
    }), {}), root);
  });
  return { root, onBatteryPlan };
};

describe('Choose what PELS does, battery row', () => {
  it('keeps Plan charging with PELS off until a usable capacity is entered', () => {
    const { root, onBatteryPlan } = renderPicker([battery()]);
    const toggle = root.querySelector<Switch>('md-switch')!;
    const field = root.querySelector<Field>('md-filled-text-field')!;
    expect(root.textContent).toContain('Plan charging with PELS');
    expect(field.value).toBe('');
    expect(toggle.disabled).toBe(true);

    act(() => {
      field.value = '5.12';
      field.dispatchEvent(new Event('input'));
    });
    expect(root.querySelector<Switch>('md-switch')!.disabled).toBe(false);

    act(() => {
      const current = root.querySelector<Switch>('md-switch')!;
      current.selected = true;
      current.dispatchEvent(new Event('change'));
    });
    expect(onBatteryPlan).toHaveBeenCalledWith('battery', true, 5.12);
  });

  it('flags a capacity out of range and keeps the switch off', () => {
    const { root } = renderPicker([battery()]);
    act(() => {
      const field = root.querySelector<Field>('md-filled-text-field')!;
      field.value = '900';
      field.dispatchEvent(new Event('input'));
    });
    expect(root.querySelector<Field>('md-filled-text-field')!.error).toBe(true);
    expect(root.querySelector<Switch>('md-switch')!.disabled).toBe(true);
  });

  it('fills in a saved capacity, and names it once the plan is on', () => {
    const { root } = renderPicker([battery({
      battery: { state: 'ready', enabled: false, capacityKWh: 9.6, simulating: false },
    })]);
    expect(root.querySelector<Field>('md-filled-text-field')!.value).toBe('9.6');

    const on = renderPicker([battery({
      id: 'other',
      battery: { state: 'ready', enabled: true, capacityKWh: 9.6, simulating: true },
    })]);
    expect(on.root.querySelector('md-filled-text-field')).toBeNull();
    expect(on.root.textContent).toContain('Planned for 9.6 kWh usable capacity. The plan runs once you start managing.');
  });

  it('says why PELS cannot plan the battery instead of offering the switch', () => {
    const { root } = renderPicker([battery({
      battery: { state: 'blocked', reason: 'Turn on Power-limit control to let PELS execute the battery plan.' },
    })]);
    expect(root.querySelector('md-switch')).toBeNull();
    expect(root.textContent).toContain('Turn on Power-limit control to let PELS execute the battery plan.');
  });
});

const headerProps = (overrides: Partial<SetupJourneyHeaderProps> = {}): SetupJourneyHeaderProps => ({
  title: 'Choose what PELS does',
  progress: null,
  detail: null,
  busy: false,
  canContinue: true,
  error: null,
  meterHelp: false,
  fluviusHelp: false,
  continueLabel: 'Review setup',
  journeyActions: true,
  onContinue: vi.fn(),
  onCheckMeter: vi.fn(),
  quarterHourAdvice: false,
  onQuarterHour: vi.fn(),
  onDismissQuarterHour: vi.fn(),
  capacityOffAction: false,
  onCapacityOff: vi.fn(),
  ...overrides,
});

describe('setup journey header', () => {
  it('offers Back to setup and the next step while the journey is open', () => {
    const root = mount();
    act(() => { render(h(SetupJourneyHeader, headerProps()), root); });
    expect(root.textContent).toContain('Back to setup');
    expect(root.textContent).toContain('Review setup');
  });

  it('drops them once setup is finished: there is no journey to go back to', () => {
    const root = mount();
    act(() => { render(h(SetupJourneyHeader, headerProps({ journeyActions: false })), root); });
    expect(root.textContent).not.toContain('Back to setup');
    expect(root.textContent).not.toContain('Review setup');
    expect(root.textContent).toContain('Choose what PELS does');
  });
});
