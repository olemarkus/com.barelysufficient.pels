import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { PlanDeviceSnapshot } from '../src/ui/planTypes.ts';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi.ts';
import type { SteppedLoadProfile } from '../../contracts/src/types.ts';
import { PLAN_REASON_CODES } from '../../shared-domain/src/planReasonSemanticsCore.ts';
import { PLAN_STATE_HELD_FALLBACK_STATUS } from '../../shared-domain/src/planStateLabels.ts';
import { STARVATION_RESCUE_WIDGET_COPY } from '../../shared-domain/src/planStarvation.ts';
import { SMART_TASK_EXTRA_PERMISSION_LABELS } from '../../shared-domain/src/deadlineLabels.ts';

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

const heldBackStarvation = (
  overrides: Partial<SettingsUiPlanDeviceStarvation> = {},
): SettingsUiPlanDeviceStarvation => ({
  isStarved: true,
  accumulatedMs: 5 * 60_000,
  ...overrides,
});

const buildDevice = (overrides: Partial<PlanDeviceSnapshot> = {}): PlanDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Termostat Synne',
  reason: { code: PLAN_REASON_CODES.keep, detail: null },
  starvation: heldBackStarvation(),
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

  // The chip used to be withheld from a device whose momentary cause bucket read
  // `capacity`. It is offered on both axes now: the rescue pauses and limits
  // lower-priority load up to — never above — the hard cap, so it clears room for
  // a capacity-held device without touching the cap.
  it('renders for a device held on the capacity ceiling', () => {
    const dev = buildDevice({ reason: { code: PLAN_REASON_CODES.capacity } });
    expect(renderChip(dev).querySelector('button')).not.toBeNull();
  });

  // A standing budget exemption no longer suppresses the chip: the device can
  // still be held back on the capacity axis, and the rescue clears room from
  // lower-priority load rather than lifting a budget it is already exempt from.
  // The rescue widget never suppressed it either, so keeping the term had the
  // same device offering the action on the dashboard and not on its own card.
  it('still renders when the device is already budget exempt', () => {
    expect(renderChip(buildDevice({ budgetExempt: true })).querySelector('button')).not.toBeNull();
  });

  it('renders nothing when the device is not held back', () => {
    const dev = buildDevice({ starvation: heldBackStarvation({ isStarved: false }) });
    expect(renderChip(dev).querySelector('button')).toBeNull();
  });

  it('renders nothing when the device is NOT in the server-resolved rescuable set', () => {
    // Mirrors getStarvedRescueDevices: a device with its own smart task, or no
    // known target, is held back but NOT rescuable — so it offers no chip, and a
    // create call that the server would reject is not offered in the first place.
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

    // First tap arms — no create yet, label flips to the confirm verb once the
    // preview has landed (Confirm is not committable before the disclosure).
    await act(async () => { button.click(); });
    await act(async () => { await Promise.resolve(); });
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

  it('drops back to idle — never to a committable confirm — when the preview is rejected', async () => {
    // The preview is what resolves the GATED permission set the card must
    // disclose. Without it the rescue would persist grants (including the
    // startup reservation that holds other devices back) the user never saw, so
    // a rejected preview must not leave a committable Confirm behind. The chip
    // returns to idle and the rescue stays re-armable.
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) return Promise.resolve({ ok: false, reason: 'previewUnavailable' });
      return Promise.resolve({});
    });
    const mount = renderChip(buildDevice());
    const button = mount.querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(button.classList.contains('confirming')).toBe(false);
    expect(mount.querySelector('.plan-card__rescue-caption')).toBeNull();
    expect(mount.querySelector('.plan-card__rescue-perms')).toBeNull();

    // A second tap re-arms; it must never fall through to a create.
    await act(async () => { button.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(callApi.mock.calls.filter((c) => String(c[1]).includes('create'))).toHaveLength(0);
  });

  it('does not commit while the preview is still in flight', async () => {
    // Between the first tap and the preview landing the disclosure has not
    // rendered, so Confirm must be inert — a fast double-tap cannot authorise an
    // undisclosed grant.
    let resolvePreview: (value: unknown) => void = () => undefined;
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) return new Promise((resolve) => { resolvePreview = resolve; });
      return Promise.resolve({});
    });
    const mount = renderChip(buildDevice());
    const button = mount.querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { button.click(); });
    expect(callApi.mock.calls.filter((c) => String(c[1]).includes('create'))).toHaveLength(0);

    await act(async () => {
      resolvePreview({ ok: true, deadlineAtMs: 1_000, deadlineLabel: 'Today 17:00', estimate: { scheduledHours: [] } });
      await Promise.resolve();
    });
    expect(button.classList.contains('confirming')).toBe(true);
  });

  it('renders no consequence caption while idle (only once armed)', () => {
    const mount = renderChip(buildDevice());
    expect(mount.querySelector('.plan-card__rescue-caption')).toBeNull();
  });

  it('lists ONLY the permissions the gate actually granted', async () => {
    // The rescue requests all three, but the server drops any that would be
    // inert on this device. The card must list the GATED set: claiming a
    // permission the write won't persist is a false promise, and hiding one it
    // WILL persist (pause holds other devices off) is an undisclosed grant the
    // user is being asked to authorise.
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) {
        return Promise.resolve({
          ok: true,
          deadlineAtMs: 1_000,
          deadlineLabel: 'Today 17:00',
          estimate: {
            scheduledHours: [],
            grantedRescuePermissions: {
              exemptFromBudget: true,
              limitLowerPriorityDevices: false,
              pauseLowerPriorityDevices: true,
            },
          },
        });
      }
      return Promise.resolve({});
    });
    const mount = renderChip(buildDevice());
    const button = mount.querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { await Promise.resolve(); });

    const perms = mount.querySelector('.plan-card__rescue-perms');
    expect(perms).not.toBeNull();
    expect(perms?.textContent).toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget);
    expect(perms?.textContent).toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.pauseLowerPriorityDevices);
    // Withheld by the gate → must not be claimed.
    expect(perms?.textContent).not.toContain(SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices);
  });

  it('renders no permissions line when the preview reports no granted permissions', async () => {
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) {
        return Promise.resolve({
          ok: true, deadlineAtMs: 1_000, deadlineLabel: 'Today 17:00', estimate: { scheduledHours: [] },
        });
      }
      return Promise.resolve({});
    });
    const mount = renderChip(buildDevice());
    const button = mount.querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(mount.querySelector('.plan-card__rescue-perms')).toBeNull();
  });

  it('echoes the previewed deadline into the create call', async () => {
    callApi.mockImplementation((method: string, uri: string) => {
      if (uri.includes('preview')) return Promise.resolve({ ok: true, deadlineAtMs: 42_000, deadlineLabel: 'x', estimate: { scheduledHours: [] } });
      if (uri.includes('create')) return Promise.resolve({ ok: true, runsCurrentHour: false });
      return Promise.resolve({});
    });
    const button = renderChip(buildDevice()).querySelector('button') as HTMLButtonElement;
    await act(async () => { button.click(); });
    // Settle the preview so the chip reaches the committable armed state.
    await act(async () => { await Promise.resolve(); });
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

// The reason line is where the contradictions have kept slipping through: first
// a budget-held card showing the "Limited by the hard cap" fallback, then (until
// 2026-08-04) every starved card showing "Limited to stay within today's budget"
// — a house-level ceiling the hero already states, in place of the shortfall the
// runtime had already computed. A starved card now states its own two facts: how
// long it has been held, and what it needs. These render the FULL card so the
// reason line is actually exercised.
describe('held-card reason line states what the device needs', () => {
  const renderCard = (dev: PlanDeviceSnapshot): HTMLDivElement => {
    const mount = document.createElement('div');
    act(() => {
      render(
        h(PlanGenericCard, { dev, plan: null, dryRun: false, renderedAtMs: 1_000, nowMs: 1_000 }),
        mount,
      );
    });
    return mount;
  };

  it('states the hold duration and the shortfall, not a ceiling', () => {
    const dev = buildDevice({
      reason: { code: PLAN_REASON_CODES.dailyBudget, shortfallKw: 0.8 },
    });
    const reason = renderCard(dev).querySelector('.plan-card__reason')?.textContent ?? '';
    expect(reason).toContain('0.8 kW more needed');
    expect(reason).toContain('Held 5');
    // None of the retired ceiling-naming lines.
    expect(reason).not.toBe("Limited to stay within today's budget");
    expect(reason).not.toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
    expect(reason.toLowerCase()).not.toContain('hard cap');
  });

  it('reads identically whichever ceiling is binding', () => {
    const lineFor = (code: typeof PLAN_REASON_CODES.capacity | typeof PLAN_REASON_CODES.dailyBudget): string => (
      renderCard(buildDevice({
        reason: { code, shortfallKw: 0.8 },
      })).querySelector('.plan-card__reason')?.textContent ?? ''
    );
    expect(lineFor(PLAN_REASON_CODES.capacity)).toBe(lineFor(PLAN_REASON_CODES.dailyBudget));
  });

  it('offers the rescue chip on a capacity-held card too', () => {
    const dev = buildDevice({ reason: { code: PLAN_REASON_CODES.capacity } });
    expect(renderCard(dev).querySelector('button')).not.toBeNull();
  });
});

// The devices users actually own render PlanTemperatureCard (thermostats) and
// PlanSteppedCard (water heaters). All three card variants share one ladder
// (`resolveHeldCardReasonLine`), so these render the FULL real card to prove the
// starved grammar reaches them through resolveTemperatureReasonLine /
// resolveSteppedStatusLine too — the three used to disagree with each other.

describe('PlanTemperatureCard reason line states what the device needs', () => {
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
    // Production-shaped: `postReserveMargin = available − need − 0.25`, so the
    // gap the card states is `minimumRequired − postReserveMargin` = 2.5 kW.
    reason: {
      code: PLAN_REASON_CODES.insufficientHeadroom,
      needKw: 2,
      availableKw: 0,
      postReserveMarginKw: -2.25,
      minimumRequiredPostReserveMarginKw: 0.25,
    },
    starvation: heldBackStarvation(),
    ...overrides,
  } as PlanDeviceSnapshot);

  const renderTemperatureCard = (dev: PlanDeviceSnapshot): HTMLDivElement => {
    const mount = document.createElement('div');
    act(() => {
      render(
        h(PlanTemperatureCard, { dev, plan: null, dryRun: false, renderedAtMs: 1_000, nowMs: 1_000 }),
        mount,
      );
    });
    return mount;
  };

  it('states the hold duration and the shortfall, not a ceiling', () => {
    const reason = renderTemperatureCard(buildTemperatureDevice())
      .querySelector('.plan-card__temp-reason')?.textContent ?? '';
    expect(reason).toContain('Held 5');
    expect(reason).toContain('kW more needed');
    expect(reason).not.toBe("Limited to stay within today's budget");
    expect(reason).not.toBe('Waiting for available power');
    expect(reason).not.toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
    expect(reason.toLowerCase()).not.toContain('hard cap');
  });

  it('offers the rescue chip alongside that line', () => {
    expect(renderTemperatureCard(buildTemperatureDevice()).querySelector('button')).not.toBeNull();
  });

  it('keeps a benign near-target idle classification out of the exception line', () => {
    const card = renderTemperatureCard(buildTemperatureDevice({
      plannedState: 'keep',
      currentTemperature: 18,
      currentTarget: 10,
      plannedTarget: 10,
      currentDrawKw: 0,
      idleClassification: 'near_target_idle',
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
      starvation: undefined,
    }));

    expect(card.querySelector('.plan-card__temp-line')?.textContent).toBe('18.0 °C · target 10 °C');
    expect(card.querySelector('.plan-card__temp-reason')).toBeNull();
    expect(card.textContent).not.toContain('Holding near setpoint');
  });
});

describe('PlanSteppedCard status line states what the device needs', () => {
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
    // Production-shaped: `postReserveMargin = available − need − 0.25`, so the
    // gap the card states is `minimumRequired − postReserveMargin` = 2.5 kW.
    reason: {
      code: PLAN_REASON_CODES.insufficientHeadroom,
      needKw: 2,
      availableKw: 0,
      postReserveMarginKw: -2.25,
      minimumRequiredPostReserveMarginKw: 0.25,
    },
    starvation: heldBackStarvation(),
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
        h(PlanSteppedCard, { dev, plan: null, dryRun: false, renderedAtMs: 1_000, nowMs: 1_000 }),
        mount,
      );
    });
    return mount;
  };

  it('states the hold duration and the shortfall, not a ceiling', () => {
    const status = renderSteppedCard(buildSteppedDevice())
      .querySelector('.plan-card__status-line')?.textContent ?? '';
    expect(status).toContain('Held 5');
    expect(status).not.toBe("Limited to stay within today's budget");
    expect(status).not.toBe('Waiting for available power');
    expect(status.toLowerCase()).not.toContain('hard cap');
  });

  it('offers the rescue chip alongside that line', () => {
    expect(renderSteppedCard(buildSteppedDevice()).querySelector('button')).not.toBeNull();
  });

  it('renders the step rail as a non-interactive level indicator: track + fill, no draggable stop dots', () => {
    const mount = renderSteppedCard(buildSteppedDevice());
    // The track and current-step fill remain...
    expect(mount.querySelector('.plan-card__step-track')).toBeTruthy();
    expect(mount.querySelector('.plan-card__step-filled')).toBeTruthy();
    // ...but the per-step thumb/stop dots (which read as a slider) are gone.
    expect(mount.querySelectorAll('.plan-card__step-stop')).toHaveLength(0);
    // Only the two endpoint labels render, at every width.
    expect(mount.querySelector('.plan-card__step-label--start')?.textContent).toBe('Off');
    expect(mount.querySelector('.plan-card__step-label--end')).toBeTruthy();
    expect(mount.querySelectorAll('.plan-card__step-label')).toHaveLength(2);
  });
});
