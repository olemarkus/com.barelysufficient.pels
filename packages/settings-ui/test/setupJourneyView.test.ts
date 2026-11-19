import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import {
  REVIEW_DEVICE_NO_JOB, resolveReviewNoJobNote, SetupDevicePicker, SetupGoalPicker, SetupJourneyHeader, SetupReview,
  type SetupJourneyHeaderProps,
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
  battery: { state: 'ready', enabled: false, capacityKWh: null, simulating: true, othersPlanned: false },
  ...overrides,
});

const renderPicker = (devices: SetupGoalChoice[], onBatteryPlan = vi.fn(async () => {})) => {
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

  it.each([
    ['Waiting for electricity prices.', 'Waiting for electricity prices.'],
    ['', 'Battery plan could not be saved. Try again.'],
  ])('restores the accepted switch and keeps the save error and price action visible (%s)', async (message, expected) => {
    const onBatteryPlan = vi.fn(async () => { throw new Error(message); });
    const { root } = renderPicker([battery({
      battery: { state: 'ready', enabled: false, capacityKWh: 10, simulating: true, othersPlanned: false },
    })], onBatteryPlan);
    await act(async () => {
      const toggle = root.querySelector<Switch>('md-switch')!;
      toggle.selected = true;
      toggle.dispatchEvent(new Event('change'));
    });
    expect(root.querySelector<Switch>('md-switch')!.selected).toBe(false);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(expected);
    const prices = Array.from(root.querySelectorAll<HTMLElement>('md-text-button'))
      .find((button) => button.textContent === 'Electricity prices')!;
    expect(prices.dataset.settingsTarget).toBe('electricity-prices');
    expect(prices.dataset.setupJourney).toBe('prices');
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
      battery: { state: 'ready', enabled: false, capacityKWh: 9.6, simulating: false, othersPlanned: false },
    })]);
    expect(root.querySelector<Field>('md-filled-text-field')!.value).toBe('9.6');

    const on = renderPicker([battery({
      id: 'other',
      battery: { state: 'ready', enabled: true, capacityKWh: 9.6, simulating: true, othersPlanned: false },
    })]);
    expect(on.root.querySelector('md-filled-text-field')).toBeNull();
    expect(on.root.textContent).toContain('Planned for 9.6 kWh usable capacity. The plan runs once you start managing.');
  });

  it('says batteries plan together in priority order only while another battery also plans', () => {
    const alone = renderPicker([battery({
      battery: { state: 'ready', enabled: true, capacityKWh: 9.6, simulating: false, othersPlanned: false },
    })]);
    expect(alone.root.textContent).not.toContain('in priority order');
    const together = renderPicker([battery({
      id: 'other',
      battery: { state: 'ready', enabled: true, capacityKWh: 9.6, simulating: false, othersPlanned: true },
    })]);
    expect(together.root.textContent).toContain('PELS plans your batteries together, in priority order');
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
  simulationExitStep: null,
  onOpenSimulation: vi.fn(),
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

  it('keeps the way out of simulation away from guided setup', () => {
    const root = mount();
    act(() => { render(h(SetupJourneyHeader, headerProps()), root); });
    expect(root.textContent).not.toContain('Open Simulation mode');
  });

  it('names the open step and offers Simulation mode when the banner sent someone here', () => {
    const root = mount();
    const onOpenSimulation = vi.fn();
    act(() => { render(h(SetupJourneyHeader, headerProps({ simulationExitStep: 'Limits', onOpenSimulation })), root); });
    expect(root.textContent).toContain('Continue setup with Limits before you start managing, or turn off simulation now.');
    const button = [...root.querySelectorAll('md-text-button')].find((el) => el.textContent === 'Open Simulation mode');
    act(() => { (button as HTMLElement).click(); });
    expect(onOpenSimulation).toHaveBeenCalledOnce();
  });
});


describe('Setup device picker', () => {
  it('shows identifying metadata beside each device', () => {
    const root = mount();
    act(() => render(h(SetupDevicePicker, {
      choices: { state: 'ready', devices: [{
        id: 'heater', name: 'Mill', detail: 'Heater · Living room · 0 kW',
        managed: false, disabled: false, hint: 'PELS may lower or pause this device.',
      }] },
      onManaged: vi.fn(), onOpen: vi.fn(), onRetry: vi.fn(),
    }), root));
    expect(root.textContent).toContain('Heater · Living room · 0 kW');
    expect(root.querySelector('md-switch')?.getAttribute('aria-label')).toBe('Manage Mill');
  });
});

describe('setup review', () => {
  const device = (id: string, control: string | null) => ({ id, name: id, control, status: null, configuration: [] });
  const idle = [device('charger', REVIEW_DEVICE_NO_JOB), device('heater', REVIEW_DEVICE_NO_JOB)];

  it('says when no managed device has a job, and where to give one', () => {
    expect(resolveReviewNoJobNote(idle, true)).toContain('Choose what PELS does to give one a job.');
    expect(resolveReviewNoJobNote(idle, false)).toContain('Turn on a power limit');
  });

  it('says nothing once a device has a job, with no managed device, or for a meter-area read', () => {
    expect(resolveReviewNoJobNote([idle[0]!, device('heater', 'Price-based control on')], true)).toBeNull();
    expect(resolveReviewNoJobNote([], true)).toBeNull();
    expect(resolveReviewNoJobNote([device('heater', null)], true)).toBeNull();
  });

  it('offers the remaining charging setup at the exact device control', () => {
    const root = mount();
    const onOpenDevice = vi.fn();
    act(() => render(h(SetupReview, {
      path: { steps: [], doneCount: 0, offersEvCharger: false, lede: '', simulating: true },
      activeMode: null, meterSummary: null, busy: false, error: null, solarNote: null,
      devices: [{
        ...device('car', REVIEW_DEVICE_NO_JOB),
        setupAction: { label: 'Finish charging setup', focus: 'charging-control',
          hint: 'Turn on “Control charging through this car” in Setup.' },
      }],
      onStart: vi.fn(), onContinue: vi.fn(), onChooseGoals: null, onOpenDevice,
    }), root));
    expect(root.textContent).toContain('Turn on “Control charging through this car” in Setup.');
    expect(root.querySelector('[data-setup-review="no-job"]')?.textContent)
      .toContain('No device has a job PELS can act on yet.');
    const action = [...root.querySelectorAll<HTMLElement>('md-text-button')]
      .find((element) => element.textContent === 'Finish charging setup');
    expect(action).toBeDefined();
    act(() => action!.click());
    expect(onOpenDevice).toHaveBeenCalledWith('car', 'charging-control');
  });
});
