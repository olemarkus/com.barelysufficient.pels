import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { PlanDeviceSnapshot } from '../src/ui/planTypes.ts';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi.ts';
import type { SteppedLoadProfile } from '../../contracts/src/types.ts';
import { PLAN_REASON_CODES } from '../../shared-domain/src/planReasonSemanticsCore.ts';
import { PLAN_STATE_HELD_FALLBACK_STATUS } from '../../shared-domain/src/planStateLabels.ts';
import { STARVATION_RESCUE_WIDGET_COPY } from '../../shared-domain/src/planStarvation.ts';

// The chip calls the rescue controller, which talks to the API over `callApi`
// and surfaces toasts. Mock the network/toast seam so the REAL chip → REAL
// controller path runs against a controllable boundary. `isStarvationRescuable`
// in the controller reads `state.starvationRescuableDeviceIds`, which the tests
// set directly — so the gate is exercised for real, not stubbed.
const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  invalidateApiCache: vi.fn(),
}));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/planRedesign.ts', () => ({ bumpPlanSurface: vi.fn() }));

const { BudgetExemptChip, PlanGenericCard, PlanTemperatureCard } = await import('../src/ui/views/PlanDeviceCards.tsx');
const { PlanSteppedCard } = await import('../src/ui/views/PlanSteppedCard.tsx');
const { state } = await import('../src/ui/state.ts');

const budgetStarvation = (
  overrides: Partial<SettingsUiPlanDeviceStarvation> = {},
): SettingsUiPlanDeviceStarvation => ({
  isStarved: true,
  accumulatedMs: 5 * 60_000,
  cause: 'budget',
  startedAtMs: 0,
  ...overrides,
});

const buildDevice = (overrides: Partial<PlanDeviceSnapshot> = {}): PlanDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Termostat Synne',
  reason: { code: PLAN_REASON_CODES.none },
  starvation: budgetStarvation(),
  ...overrides,
} as PlanDeviceSnapshot);

const renderChip = (dev: PlanDeviceSnapshot): HTMLDivElement => {
  const mount = document.createElement('div');
  act(() => {
    render(h(BudgetExemptChip, { dev }), mount);
  });
  return mount;
};

beforeEach(() => {
  callApi.mockReset();
  // Default: the device IS rescuable (the common case the chip renders for).
  state.starvationRescuableDeviceIds = new Set(['heater-1', 'heater-2']);
});

afterEach(() => {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  state.starvationRescuableDeviceIds = new Set();
});

describe('BudgetExemptChip', () => {
  it('renders a tappable rescue chip for a budget-held, rescuable, not-exempt device', () => {
    const button = renderChip(buildDevice()).querySelector('button');
    expect(button).not.toBeNull();
    // Canonical rescue verb — the SAME label as the held-back widget's
    // "Let it run now", so the two surfaces speak one language.
    expect(button?.textContent).toBe('Let it run now');
    expect(button?.classList.contains('plan-chip--link')).toBe(true);
    expect(button?.classList.contains('plan-chip--info')).toBe(true);
    // hy-nostyle keeps Homey's host button stylesheet from bleeding light chrome.
    expect(button?.classList.contains('hy-nostyle')).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe('Let Termostat Synne run now');
  });

  it('carries a leading icon so it reads as an action, not a status badge', () => {
    const button = renderChip(buildDevice()).querySelector('button');
    expect(button?.classList.contains('plan-chip--leading-icon')).toBe(true);
    expect(button?.querySelector('svg.plan-chip__icon')).not.toBeNull();
  });

  it('renders nothing for a capacity-held device (the hard cap is physical)', () => {
    const dev = buildDevice({ starvation: budgetStarvation({ cause: 'capacity' }) });
    expect(renderChip(dev).querySelector('button')).toBeNull();
  });

  it('renders nothing when the device is already budget exempt', () => {
    expect(renderChip(buildDevice({ budgetExempt: true })).querySelector('button')).toBeNull();
  });

  it('renders nothing when the device is not held back', () => {
    const dev = buildDevice({ starvation: budgetStarvation({ isStarved: false }) });
    expect(renderChip(dev).querySelector('button')).toBeNull();
  });

  it('renders nothing when the device is NOT in the server-resolved rescuable set', () => {
    // Mirrors getStarvedRescueDevices: a device with its own smart task, or no
    // known target, is budget-held but NOT rescuable — so it offers no chip and
    // a create call can never be rejected for a shown chip.
    state.starvationRescuableDeviceIds = new Set(['some-other-device']);
    expect(renderChip(buildDevice()).querySelector('button')).toBeNull();
  });

  it('arms a confirm on the first tap and only commits the rescue on the second', async () => {
    // Preview enriches the armed state; create commits it.
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) return Promise.resolve({ ok: true, deadlineAtMs: 1_000, deadlineLabel: 'x', estimate: { scheduledHours: [] } });
      if (uri.includes('create')) return Promise.resolve({ ok: true, runsCurrentHour: true });
      return Promise.resolve({});
    });
    const mount = renderChip(buildDevice());
    const button = mount.querySelector('button') as HTMLButtonElement;

    // First tap arms — no create yet, label flips to the confirm verb.
    await act(async () => { button.click(); });
    expect(button.classList.contains('confirming')).toBe(true);
    expect(button.textContent).toContain('Confirm');
    const createCallsAfterArm = callApi.mock.calls.filter((c) => String(c[1]).includes('create'));
    expect(createCallsAfterArm).toHaveLength(0);

    // Second tap commits — the create endpoint is hit with the device id.
    await act(async () => { button.click(); });
    const createCall = callApi.mock.calls.find((c) => String(c[1]).includes('create'));
    expect(createCall).toBeDefined();
    expect(createCall?.[0]).toBe('POST');
    expect((createCall?.[2] as { deviceId?: string })?.deviceId).toBe('heater-1');
  });

  it('renders the money-action consequence AND the bounded "By {time}" horizon IN THE DOM when armed', async () => {
    // The consequence + bound must be visible at the card on Homey's touch
    // WebView — a hover tooltip is unreachable there. The preview resolves the
    // bounded window; the caption pairs the shared consequence copy with the
    // widget's "By {deadlineLabel}" formatting.
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) return Promise.resolve({ ok: true, deadlineAtMs: 1_000, deadlineLabel: 'Today 17:00', estimate: { scheduledHours: [] } });
      return Promise.resolve({});
    });
    const mount = renderChip(buildDevice());
    const button = mount.querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });
    // Let the best-effort preview microtask settle so the bound lands.
    await act(async () => { await Promise.resolve(); });

    const caption = mount.querySelector('.plan-card__rescue-caption');
    expect(caption).not.toBeNull();
    // The full money-action consequence (NOT only the tooltip attribute).
    expect(caption?.textContent).toContain(STARVATION_RESCUE_WIDGET_COPY.rescueConsequence);
    // The bounded horizon, using the shared "By" lead + server-formatted label.
    expect(caption?.textContent).toContain(`${STARVATION_RESCUE_WIDGET_COPY.byLabel} Today 17:00`);
  });

  it('falls back to the consequence-only caption when the preview is unavailable', async () => {
    // No preview window resolves (failed/unavailable) → the caption still names
    // the consequence, which already states the bound ("…until it reaches its
    // normal target."). No "By {time}" segment without a real deadline.
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) return Promise.resolve({ ok: false, reason: 'previewUnavailable' });
      return Promise.resolve({});
    });
    const mount = renderChip(buildDevice());
    const button = mount.querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { await Promise.resolve(); });

    const caption = mount.querySelector('.plan-card__rescue-caption');
    expect(caption).not.toBeNull();
    expect(caption?.textContent).toBe(STARVATION_RESCUE_WIDGET_COPY.rescueConsequence);
    // No bound segment when the preview yielded no deadline.
    expect(caption?.textContent).not.toContain(STARVATION_RESCUE_WIDGET_COPY.byLabel);
  });

  it('renders no consequence caption while idle (only once armed)', () => {
    const mount = renderChip(buildDevice());
    expect(mount.querySelector('.plan-card__rescue-caption')).toBeNull();
  });

  it('echoes the previewed deadline into the create call', async () => {
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) return Promise.resolve({ ok: true, deadlineAtMs: 42_000, deadlineLabel: 'x', estimate: { scheduledHours: [] } });
      if (uri.includes('create')) return Promise.resolve({ ok: true, runsCurrentHour: false });
      return Promise.resolve({});
    });
    const button = renderChip(buildDevice()).querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { button.click(); });
    const createCall = callApi.mock.calls.find((c) => String(c[1]).includes('create'));
    expect((createCall?.[2] as { deadlineAtMs?: number })?.deadlineAtMs).toBe(42_000);
  });

  it('stops click propagation so the surrounding card does not also open', () => {
    const card = document.createElement('article');
    const cardClicks = { count: 0 };
    card.addEventListener('click', () => { cardClicks.count += 1; });
    const inner = document.createElement('div');
    card.appendChild(inner);
    document.body.appendChild(card);
    callApi.mockResolvedValue({ ok: true, deadlineAtMs: 1, deadlineLabel: 'x', estimate: { scheduledHours: [] } });
    act(() => { render(h(BudgetExemptChip, { dev: buildDevice() }), inner); });
    const button = card.querySelector('button') as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(cardClicks.count).toBe(0);
  });

  it('stops Enter keydown propagation so the parent card does not also activate', () => {
    const card = document.createElement('article');
    const cardKeys = { count: 0 };
    card.addEventListener('keydown', () => { cardKeys.count += 1; });
    const inner = document.createElement('div');
    card.appendChild(inner);
    document.body.appendChild(card);
    act(() => { render(h(BudgetExemptChip, { dev: buildDevice() }), inner); });
    const button = card.querySelector('button') as HTMLButtonElement;
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(cardKeys.count).toBe(0);
  });
});

// The reason line is where the original contradiction slipped through: a
// budget-held card kept showing the `PLAN_STATE_HELD_FALLBACK_STATUS =
// "Limited by the hard cap"` fallback even though the binding constraint was
// the daily budget (the hard cap is physical — feedback_hard_cap_is_physical).
// These render the FULL card so the reason line is actually exercised.
describe('held-card reason line names the real binding constraint', () => {
  const renderCard = (dev: PlanDeviceSnapshot): HTMLDivElement => {
    const mount = document.createElement('div');
    act(() => {
      render(
        h(PlanGenericCard, { dev, plan: null, renderedAtMs: 1_000, nowMs: 1_000 }),
        mount,
      );
    });
    return mount;
  };

  it('a budget-held card reads the budget attribution, NOT "Limited by the hard cap"', () => {
    const reason = renderCard(buildDevice()).querySelector('.plan-card__reason');
    expect(reason?.textContent).toBe("Limited to stay within today's budget");
    expect(reason?.textContent).not.toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
  });

  it('a capacity-held card still reads its capacity reason and offers NO rescue chip', () => {
    const dev = buildDevice({ starvation: budgetStarvation({ cause: 'capacity' }) });
    const mount = renderCard(dev);
    expect(mount.querySelector('.plan-card__reason')?.textContent).toBe('Waiting for available power');
    // Capacity is physical — the rescue action never appears.
    expect(mount.querySelector('button')).toBeNull();
  });
});

// The devices users actually own render PlanTemperatureCard (thermostats) and
// PlanSteppedCard (water heaters), whose reason/status lines key on
// `reason.code`, NOT `starvation.cause`. Before the fix, a budget-held
// thermostat/water-heater showed the "Budget limited" badge + rescue chip but a
// reason line of "Waiting for available power" / "Waiting to resume — N kW
// more needed" (insufficient_headroom path) or "Limited by the hard cap" (held
// fallback) — capacity/hard-cap framing that contradicts the budget chip + badge
// (the hard cap is physical — feedback_hard_cap_is_physical). These render the
// FULL real card so the reason/status line is actually exercised through
// resolveTemperatureReasonLine / resolveSteppedStatusLine.

describe('PlanTemperatureCard reason line names the real binding constraint', () => {
  const buildTemperatureDevice = (
    overrides: Partial<PlanDeviceSnapshot> = {},
  ): PlanDeviceSnapshot => ({
    id: 'heater-1',
    name: 'Termostat Synne',
    controlModel: 'temperature_target',
    plannedState: 'shed',
    currentState: 'on',
    currentTemperature: 19.4,
    plannedTarget: 22,
    reason: { code: PLAN_REASON_CODES.insufficientHeadroom, needKw: 2, effectiveAvailableKw: 0 },
    starvation: budgetStarvation(),
    ...overrides,
  } as PlanDeviceSnapshot);

  const renderTemperatureCard = (dev: PlanDeviceSnapshot): HTMLDivElement => {
    const mount = document.createElement('div');
    act(() => {
      render(
        h(PlanTemperatureCard, { dev, plan: null, renderedAtMs: 1_000, nowMs: 1_000 }),
        mount,
      );
    });
    return mount;
  };

  it('a budget-held thermostat reads the budget attribution, NOT a capacity/hard-cap line', () => {
    const reason = renderTemperatureCard(buildTemperatureDevice()).querySelector('.plan-card__temp-reason');
    expect(reason?.textContent).toBe("Limited to stay within today's budget");
    expect(reason?.textContent).not.toBe('Waiting for available power');
    expect(reason?.textContent).not.toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
    expect(reason?.textContent).not.toContain('hard cap');
  });

  it('a capacity-held thermostat keeps its capacity waiting copy and offers NO rescue chip', () => {
    const dev = buildTemperatureDevice({ starvation: budgetStarvation({ cause: 'capacity' }) });
    const mount = renderTemperatureCard(dev);
    const reason = mount.querySelector('.plan-card__temp-reason')?.textContent;
    expect(reason).toContain('Waiting to resume');
    expect(reason).not.toBe("Limited to stay within today's budget");
    expect(mount.querySelector('button')).toBeNull();
  });
});

describe('PlanSteppedCard status line names the real binding constraint', () => {
  const steppedProfile = (): SteppedLoadProfile => ({
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: '1', planningPowerW: 2000 },
    ],
  });

  const buildSteppedDevice = (
    overrides: Partial<PlanDeviceSnapshot> = {},
  ): PlanDeviceSnapshot => ({
    id: 'heater-2',
    name: 'Varmtvannsbereder',
    controlModel: 'stepped_load',
    plannedState: 'shed',
    currentState: 'off',
    reason: { code: PLAN_REASON_CODES.insufficientHeadroom, needKw: 2, effectiveAvailableKw: 0 },
    starvation: budgetStarvation(),
    steppedLoad: {
      profile: steppedProfile(),
      reportedStepId: 'off',
      targetStepId: '1',
      commandPending: false,
    },
    ...overrides,
  } as PlanDeviceSnapshot);

  const renderSteppedCard = (dev: PlanDeviceSnapshot): HTMLDivElement => {
    const mount = document.createElement('div');
    act(() => {
      render(
        h(PlanSteppedCard, { dev, plan: null, renderedAtMs: 1_000, nowMs: 1_000 }),
        mount,
      );
    });
    return mount;
  };

  it('a budget-held water heater reads the budget attribution, NOT a waiting/hard-cap line', () => {
    const status = renderSteppedCard(buildSteppedDevice()).querySelector('.plan-card__status-line');
    expect(status?.textContent).toBe("Limited to stay within today's budget");
    expect(status?.textContent).not.toBe('Waiting for available power');
    expect(status?.textContent).not.toContain('Waiting to resume');
    expect(status?.textContent).not.toContain('hard cap');
  });

  it('a capacity-held water heater still reads its waiting copy and offers NO rescue chip', () => {
    const dev = buildSteppedDevice({ starvation: budgetStarvation({ cause: 'capacity' }) });
    const mount = renderSteppedCard(dev);
    expect(mount.querySelector('.plan-card__status-line')?.textContent).toContain('Waiting to resume');
    expect(mount.querySelector('button')).toBeNull();
  });
});
