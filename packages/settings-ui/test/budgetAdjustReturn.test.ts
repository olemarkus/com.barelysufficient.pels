import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderBudgetOverview, type BudgetOverviewProps } from '../src/ui/views/BudgetOverview.tsx';

/* -------------------------------------------------------------------------- *
 * Referrer-aware Done button + two-step discard confirm.
 *
 * The Budget header's mode toggle has three jobs in the Adjust view:
 *   1. return to where the session started — the plan view for header-initiated
 *      sessions, the Settings panel for sessions opened from the Settings tab's
 *      "Daily budget" row (via the injected onReturnToSettings navigator);
 *   2. guard unsaved work — Adjust is the only surface that doesn't save
 *      instantly, so a dirty draft or pending preview arms a two-step
 *      "Tap again to discard" confirm before any exit;
 *   3. stay reachable when the daily budget is disabled and the user arrived
 *      from Settings (returning to Settings is always meaningful even though
 *      the plan view isn't).
 * -------------------------------------------------------------------------- */

const buildProps = (overrides: Partial<BudgetOverviewProps> = {}): BudgetOverviewProps => ({
  localView: 'adjust',
  view: 'today',
  hero: {
    headlineLabel: null,
    comparison: 'Daily budget off',
    delta: null,
    budgetRemainingLine: null,
  estimatedCost: null,
  recourse: null,
    split: null,
    priceTagline: null,
    exportPriceLine: null,
    decision: null,
    heroTone: 'ok',
  },
  chart: null,
  confidence: null,
  adjust: {
    draft: { enabled: true, dailyBudgetKWh: 60, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    active: { enabled: true, dailyBudgetKWh: 60, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    candidate: null,
    activeChart: null,
    candidateChart: null,
    comparisonDayView: 'today',
    comparisonDayLabel: 'Today',
    comparisonShowPrice: false,
    status: 'clean',
    busy: false,
    powerLimitForm: {
      capacityEnabled: true, gridImportEnabled: false, limitKw: 12, marginKw: 1, gridImportLimitKw: null,
    },
    planningCeiling: { limit: 'capacity', kw: 11 },
  },
  allocationWarning: null,
  priceLevelChip: null,
  weatherInsight: null,
  mainHomeScopeLine: null,
  adjustReturnTarget: 'plan',
  onReturnToSettings: () => {},
  onShowUsage: () => {},
  onLocalViewChange: () => {},
  onDayChange: () => {},
  onChartModeChange: () => {},
  onChartUnitChange: () => {},
  onAdjustFieldChange: () => {},
  onPreview: () => {},
  onApply: () => {},
  onDiscard: () => {},
  ...overrides,
});

const withStatus = (
  status: 'clean' | 'dirty' | 'pending',
  overrides: Partial<BudgetOverviewProps> = {},
): BudgetOverviewProps => {
  const base = buildProps(overrides);
  return { ...base, adjust: { ...base.adjust, status } };
};

let mount: HTMLElement;

beforeEach(() => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
});

afterEach(() => {
  document.body.replaceChildren();
});

const getToggle = (): HTMLElement => {
  const toggle = mount.querySelector<HTMLElement>('#budget-redesign-mode-toggle');
  expect(toggle).not.toBeNull();
  return toggle as HTMLElement;
};

// Settings-referred Adjust sessions render the shared `.pels-appbar` back arrow
// as the exit affordance instead of the trailing "Done" toggle; it carries the
// same two-step discard semantics (armed → `.confirming` glyph, second tap
// discards + returns), just reflected as a class + aria-label rather than a
// text label.
const getSettingsBack = (): HTMLElement => {
  const back = mount.querySelector<HTMLElement>('.pels-appbar__back');
  expect(back).not.toBeNull();
  return back as HTMLElement;
};

// Preact assigns `disabled` as a DOM property on the custom element (jsdom has
// no material-web definition to reflect it into an attribute), so read both.
const isDisabled = (el: HTMLElement): boolean => (
  (el as HTMLElement & { disabled?: boolean }).disabled === true || el.hasAttribute('disabled')
);

// Preact batches state-driven re-renders on the microtask queue; flush it so
// assertions after a click observe the re-rendered DOM.
const flushRender = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('plan view trigger', () => {
  it('renders a prominent Adjust trigger with the tune icon', () => {
    renderBudgetOverview(mount, buildProps({ localView: 'plan' }));
    const toggle = getToggle();
    expect(toggle.tagName.toLowerCase()).toBe('md-outlined-button');
    expect(toggle.textContent).toContain('Adjust');
    expect(toggle.querySelector('svg[slot="icon"]')).not.toBeNull();
    expect(toggle.hasAttribute('data-settings-target')).toBe(false);
  });

  it('enters the adjust view on click', () => {
    const onLocalViewChange = vi.fn();
    renderBudgetOverview(mount, buildProps({ localView: 'plan', onLocalViewChange }));
    getToggle().click();
    expect(onLocalViewChange).toHaveBeenCalledWith('adjust');
  });
});

describe('Done with a clean draft', () => {
  it('returns to the plan view for header-initiated sessions (no nav attribute)', () => {
    const onLocalViewChange = vi.fn();
    renderBudgetOverview(mount, withStatus('clean', { onLocalViewChange }));
    const toggle = getToggle();
    expect(toggle.textContent).toContain('Done');
    expect(toggle.hasAttribute('data-settings-target')).toBe(false);
    toggle.click();
    expect(onLocalViewChange).toHaveBeenCalledWith('plan');
  });

  it('returns to Settings via the app-bar back arrow for settings-initiated sessions without flipping the local view', () => {
    const onLocalViewChange = vi.fn();
    const onReturnToSettings = vi.fn();
    renderBudgetOverview(mount, withStatus('clean', {
      adjustReturnTarget: 'settings',
      onLocalViewChange,
      onReturnToSettings,
    }));
    // The settings-referred editor swaps the trailing "Done" toggle for the
    // sibling app-bar back arrow — the boxed hero + toggle no longer render.
    expect(mount.querySelector('#budget-redesign-mode-toggle')).toBeNull();
    getSettingsBack().click();
    expect(onReturnToSettings).toHaveBeenCalledTimes(1);
    // Flipping the view here would flash the plan view before the panel swap.
    expect(onLocalViewChange).not.toHaveBeenCalled();
  });

  it('keeps the back arrow available even when the daily budget is disabled but the session came from Settings', () => {
    const props = withStatus('clean', { adjustReturnTarget: 'settings' });
    props.adjust.active.enabled = false;
    props.adjust.draft.enabled = false;
    renderBudgetOverview(mount, props);
    // Returning to Settings is always meaningful — the back arrow is the
    // always-active exit, never the disabled Done the plan view falls back to.
    expect(isDisabled(getSettingsBack())).toBe(false);
  });

  it('is disabled when the daily budget is disabled and there is no Settings referrer', () => {
    const props = withStatus('clean');
    props.adjust.active.enabled = false;
    props.adjust.draft.enabled = false;
    renderBudgetOverview(mount, props);
    expect(isDisabled(getToggle())).toBe(true);
  });
});

describe.each(['dirty', 'pending'] as const)('Done with unsaved changes (%s)', (status) => {
  it('arms a two-step confirm instead of discarding on the first click', async () => {
    const onLocalViewChange = vi.fn();
    renderBudgetOverview(mount, withStatus(status, { onLocalViewChange }));
    const toggle = getToggle();
    toggle.click();
    await flushRender();
    expect(onLocalViewChange).not.toHaveBeenCalled();
    expect(toggle.textContent).toContain('Tap again to discard');
    expect(toggle.classList.contains('confirming')).toBe(true);
  });

  it('offers a visible "Keep editing" escape while armed, which disarms without discarding', async () => {
    const onLocalViewChange = vi.fn();
    renderBudgetOverview(mount, withStatus(status, { onLocalViewChange }));
    const toggle = getToggle();
    // Unarmed: no escape button rendered.
    expect(mount.querySelector('#budget-redesign-keep-editing')).toBeNull();
    toggle.click();
    await flushRender();
    const keep = mount.querySelector('#budget-redesign-keep-editing') as HTMLElement;
    expect(keep?.textContent).toContain('Keep editing');
    keep.click();
    await flushRender();
    // Disarmed: no navigation, no discard, escape gone, toggle back to Done.
    expect(onLocalViewChange).not.toHaveBeenCalled();
    expect(mount.querySelector('#budget-redesign-keep-editing')).toBeNull();
    expect(getToggle().textContent).toContain('Done');
  });

  it('discards and returns to plan on the confirming click', async () => {
    const onLocalViewChange = vi.fn();
    renderBudgetOverview(mount, withStatus(status, { onLocalViewChange }));
    const toggle = getToggle();
    toggle.click();
    await flushRender();
    toggle.click();
    expect(onLocalViewChange).toHaveBeenCalledWith('plan');
  });

  it('navigates to Settings only on the confirming back-arrow click', async () => {
    const onReturnToSettings = vi.fn();
    renderBudgetOverview(mount, withStatus(status, { adjustReturnTarget: 'settings', onReturnToSettings }));
    // Unarmed: a first tap on the back arrow must not navigate away and
    // silently discard — it arms the confirm (warning-tinted `.confirming`
    // glyph) instead, the icon-only equivalent of "Tap again to discard".
    getSettingsBack().click();
    await flushRender();
    expect(onReturnToSettings).not.toHaveBeenCalled();
    expect(getSettingsBack().classList.contains('confirming')).toBe(true);
    // The armed back-arrow variant offers the same visible non-destructive
    // escape as the trailing-Done variant.
    const keep = mount.querySelector('#budget-redesign-keep-editing') as HTMLElement;
    expect(keep?.textContent).toContain('Keep editing');
    getSettingsBack().click();
    expect(onReturnToSettings).toHaveBeenCalledTimes(1);
  });

  it('disarms when the user resumes editing so new edits are not silently discarded', async () => {
    const onLocalViewChange = vi.fn();
    const props = withStatus(status, { onLocalViewChange });
    renderBudgetOverview(mount, props);
    const toggle = getToggle();
    toggle.click();
    await flushRender();
    expect(toggle.textContent).toContain('Tap again to discard');

    // A field change swaps the draft object in the controller; the armed
    // confirm was given for the OLD draft and must not carry over.
    const edited = {
      ...props,
      adjust: { ...props.adjust, draft: { ...props.adjust.draft, dailyBudgetKWh: 42 } },
    };
    renderBudgetOverview(mount, edited);
    await flushRender();
    expect(getToggle().textContent).toContain('Done');

    // The next click arms again instead of discarding.
    getToggle().click();
    await flushRender();
    expect(onLocalViewChange).not.toHaveBeenCalled();
    expect(getToggle().textContent).toContain('Tap again to discard');
  });

  it('auto-reverts the armed confirm after the timeout', async () => {
    vi.useFakeTimers();
    try {
      renderBudgetOverview(mount, withStatus(status));
      const toggle = getToggle();
      toggle.click();
      await flushRender();
      expect(toggle.textContent).toContain('Tap again to discard');
      vi.advanceTimersByTime(5000);
      await flushRender();
      expect(getToggle().textContent).toContain('Done');
      expect(getToggle().classList.contains('confirming')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

type PowerLimitForm = NonNullable<BudgetOverviewProps['adjust']['powerLimitForm']>;
type PlanningCeiling = BudgetOverviewProps['adjust']['planningCeiling'];
const capacityOnly: PowerLimitForm = {
  capacityEnabled: true, gridImportEnabled: false, limitKw: 12, marginKw: 1, gridImportLimitKw: null,
};
const renderWithLimits = (powerLimitForm: PowerLimitForm | null, planningCeiling: PlanningCeiling = null) => {
  const base = buildProps();
  renderBudgetOverview(mount, { ...base, adjust: { ...base.adjust, powerLimitForm, planningCeiling } });
};

// The recommended maximum is sized from, and names, the planning ceiling: never a
// hard cap that is switched off or that a lower grid import limit undercuts.
describe('recommended daily budget hint', () => {
  const hintText = (): string => [...mount.querySelectorAll('.field__hint-range')]
    .map((node) => node.textContent ?? '').join(' ');

  it('keeps the safe-pace recommendation with only Capacity limit on', () => {
    renderWithLimits(capacityOnly, { limit: 'capacity', kw: 11 });
    expect(hintText()).toContain('Recommended up to 264.0 kWh (safe pace × 24h).');
  });

  it('names the grid import limit when its target sets the ceiling', () => {
    renderWithLimits({ ...capacityOnly, capacityEnabled: false, gridImportEnabled: true, gridImportLimitKw: 7.4 }, {
      limit: 'grid', kw: 7.03,
    });
    expect(hintText()).toContain('Recommended up to 168.7 kWh, what your grid import limit allows in a day.');
    expect(hintText()).not.toMatch(/safe pace|hard cap/i);
  });

  it('recommends no maximum without a planning ceiling', () => {
    renderWithLimits({ ...capacityOnly, capacityEnabled: false }, null);
    expect(hintText()).not.toContain('Recommended up to');
  });
});

// "Current limits" shows only the limits that are switched on: never a hard cap,
// safety margin or safe pace while Capacity limit is off.
const limitsCard = (): HTMLElement => {
  const title = [...mount.querySelectorAll('h3')].find((node) => node.textContent === 'Current limits');
  const section = title?.closest('section');
  expect(section).toBeTruthy();
  return section as HTMLElement;
};
const limitsCardRows = (): string[] => [...limitsCard().querySelectorAll('.budget-setting-row')]
  .map((row) => (row.textContent ?? '').trim());

describe('current limits card', () => {
  it('renders the capacity rows and safe pace with only Capacity limit on', () => {
    renderWithLimits(capacityOnly);
    expect(limitsCard().querySelector('.settings-result__value')?.textContent).toBe('11.0 kW');
    expect(limitsCardRows()).toEqual(['Hard cap12.0 kW', 'Safety margin1.0 kW']);
    expect(limitsCard().textContent).not.toContain('Power limits off');
  });

  it('shows only the grid import limit with Capacity limit off', () => {
    renderWithLimits({ ...capacityOnly, capacityEnabled: false, gridImportEnabled: true, gridImportLimitKw: 7.4 });
    expect(limitsCardRows()).toEqual(['Grid import limit7.4 kW']);
    expect(limitsCard().textContent).not.toMatch(/hard cap|safety margin|safe pace/i);
  });

  it('adds the grid import limit row beside the capacity rows when both are on', () => {
    renderWithLimits({ ...capacityOnly, gridImportEnabled: true, gridImportLimitKw: 17 });
    expect(limitsCardRows()).toEqual(['Hard cap12.0 kW', 'Safety margin1.0 kW', 'Grid import limit17.0 kW']);
  });

  it('states that power limits are off when neither is on', () => {
    renderWithLimits({ ...capacityOnly, capacityEnabled: false });
    expect(limitsCardRows()).toEqual([]);
    expect(limitsCard().querySelector('.pels-card-supporting')?.textContent).toBe('Power limits off');
    expect(limitsCard().textContent).not.toMatch(/hard cap|safety margin|safe pace/i);
  });

  it('keeps the capacity rows with unknown values while the Limits form is not rendered', () => {
    renderWithLimits(null);
    expect(limitsCardRows()).toEqual(['Hard cap-- kW', 'Safety margin-- kW']);
  });
});

// From the Limits form to the card: which rows show comes from the switches, so an
// unreadable value is shown as unknown rather than hiding the limit it belongs to.
describe('current limits card read from the Limits form', () => {
  const LIMITS_FORM = [
    '<md-switch id="settings-capacity-enabled"></md-switch>',
    '<md-switch id="settings-grid-import-enabled"></md-switch>',
    '<md-filled-text-field id="settings-grid-import-limit"></md-filled-text-field>',
    '<md-filled-text-field id="settings-capacity-limit"></md-filled-text-field>',
    '<md-filled-text-field id="settings-capacity-margin"></md-filled-text-field>',
    '<md-filled-select id="settings-capacity-period"></md-filled-select>',
  ].join('');
  type FormField = HTMLElement & { value: string; selected: boolean };
  const field = (id: string): FormField => document.getElementById(id) as FormField;

  it('shows the grid import limit as unknown, and no capacity rows, with Capacity off and Grid on but empty', async () => {
    const form = document.createElement('div');
    // Static template constructed from a literal — no untrusted content.
    form.innerHTML = LIMITS_FORM;
    document.body.appendChild(form);
    field('settings-capacity-enabled').selected = false;
    field('settings-capacity-limit').value = '5';
    field('settings-capacity-margin').value = '0.2';
    field('settings-capacity-period').value = '60';
    // The switch handler leaves this edit pending while the value is empty.
    field('settings-grid-import-enabled').selected = true;
    field('settings-grid-import-limit').value = '';
    vi.resetModules();
    const { readPowerLimitFormSettings, readPowerLimitFormView } = await import('../src/ui/powerLimitControls.ts');

    expect(readPowerLimitFormSettings()).toBeNull();
    renderWithLimits(readPowerLimitFormView(), null);

    expect(limitsCardRows()).toEqual(['Grid import limit-- kW']);
    expect(limitsCard().textContent).not.toMatch(/hard cap|safety margin|safe pace/i);
  });
});
