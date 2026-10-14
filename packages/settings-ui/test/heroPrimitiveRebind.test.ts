import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { renderBudgetOverview, type BudgetOverviewProps } from '../src/ui/views/BudgetOverview.tsx';
import { renderDeadlinesList } from '../src/ui/views/DeadlinesList.tsx';
import {
  renderDeadlinePlan,
  type DeadlinePlanPayload,
  type DeadlinePlanPendingPayload,
} from '../src/ui/views/DeadlinePlan.tsx';
import { deadlineLabels } from '../../shared-domain/src/deadlineLabels.ts';
import { budgetOverviewProps } from './helpers/budgetOverviewProps.ts';

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const mounts: HTMLElement[] = [];

const mountIntoBody = (): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  mounts.push(mount);
  return mount;
};

afterEach(() => {
  // Unmount before deferred chart effects can outlive this jsdom document.
  for (const mount of mounts.splice(0)) render(null, mount);
  document.body.replaceChildren();
});

const expectCanonicalHeroShape = (hero: Element | null): void => {
  expect(hero).not.toBeNull();
  expect(hero?.matches('.plan-hero.pels-hero')).toBe(true);
  const eyebrow = hero?.querySelector('.eyebrow.plan-hero__section-label');
  expect((eyebrow?.textContent ?? '').trim().length).toBeGreaterThan(0);
  const headline = hero?.querySelector('.plan-hero__headline');
  expect((headline?.textContent ?? '').trim().length).toBeGreaterThan(0);
};

describe('static panel headings', () => {
  const mountIndexFragment = (): Document => new DOMParser().parseFromString(INDEX_HTML, 'text/html');

  it('Usage hero rebinds to .plan-hero.pels-hero with canonical eyebrow + headline', () => {
    const doc = mountIndexFragment();
    const usageHero = doc.querySelector('#usage-hero');
    expectCanonicalHeroShape(usageHero);
    expect(usageHero?.getAttribute('data-tone')).not.toBeNull();
    const headline = usageHero?.querySelector('#usage-hero-headline');
    expect(headline?.tagName.toLowerCase()).toBe('h2');
    expect(headline?.classList.contains('plan-hero__headline')).toBe(true);
  });
  it('labels Settings with a hidden heading followed by the dynamic current-mode view', () => {
    const doc = mountIndexFragment();
    expect(doc.querySelector('#settings-panel .plan-hero')).toBeNull();
    const landmark = doc.querySelector('#settings-panel > h2#settings-title');
    expect(landmark).not.toBeNull();
    expect(landmark?.classList.contains('visually-hidden')).toBe(true);
    expect(landmark?.textContent?.trim()).toBe('Settings');
    expect(doc.querySelector('#settings-panel')?.getAttribute('aria-labelledby')).toBe('settings-title');
    expect(landmark?.nextElementSibling?.id).toBe('current-modes-root');
    expect(landmark?.nextElementSibling?.children).toHaveLength(0);
  });
  it('Advanced panel leads with the shared app-bar back+title row instead of a hero card', () => {
    const doc = mountIndexFragment();
    const appbar = doc.querySelector('#advanced-panel > .pels-appbar');
    expect(appbar).not.toBeNull();
    const back = appbar?.querySelector('.pels-appbar__back[data-settings-target="settings"]');
    expect(back).not.toBeNull();
    expect(back?.getAttribute('aria-label')).toBe('Back to Settings');
    const title = appbar?.querySelector('h2.pels-appbar__title');
    expect(title?.textContent?.trim()).toBe('Advanced');
  });
});

const buildBudgetProps = (overrides: Partial<BudgetOverviewProps> = {}): BudgetOverviewProps => budgetOverviewProps({
  localView: 'plan',
  hero: { headlineLabel: null, comparison: 'Daily budget off', split: null },
  budget: { enabled: false, dailyBudgetKWh: 60 },
  weatherInsight: null,
}, overrides);

describe('BudgetOverview panel header consumes the shared hero primitive', () => {
  it('renders a .plan-hero.pels-hero shell with canonical eyebrow + headline (no chip rail)', () => {
    const mount = mountIntoBody();
    const onDayChange = vi.fn();
    renderBudgetOverview(mount, buildBudgetProps({ onDayChange }));
    const header = mount.querySelector('header.plan-hero.pels-hero');
    expectCanonicalHeroShape(header);
    expect(header?.querySelector('.plan-hero__chips')).toBeNull();
    expect(header?.querySelector('#budget-redesign-mode-toggle')).not.toBeNull();

    const group = mount.querySelector('.segmented[aria-label="Budget day"]');
    expect(group?.getAttribute('role')).toBe('group');
    const buttons = group?.querySelectorAll<HTMLButtonElement>('button.segmented__option');
    expect(Array.from(buttons ?? [], (button) => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'true', 'false']);
    for (const button of buttons ?? []) expect(button.type).toBe('button');
    buttons?.[2]?.click();
    expect(onDayChange).toHaveBeenCalledWith('tomorrow');
  });

  it('renders the price-level chip and Plan/Adjust toggle inside the shared chip rail', () => {
    const mount = mountIntoBody();
    renderBudgetOverview(mount, buildBudgetProps({
      priceLevelChip: { label: 'Price low', tone: 'info', priceLevel: 'CHEAP' },
    }));
    const header = mount.querySelector('header.plan-hero.pels-hero');
    expectCanonicalHeroShape(header);
    const chipRail = header?.querySelector('.plan-hero__chips .plan-hero__chip-rail');
    expect(chipRail).not.toBeNull();
    expect(chipRail?.querySelector('.plan-chip')?.textContent).toContain('Price low');
    expect(header?.querySelector('.plan-hero__chips #budget-redesign-mode-toggle')).not.toBeNull();
  });
});

describe('DeadlinesList header consumes the shared hero primitive', () => {
  it('loading-state baseline header walks the canonical eyebrow + headline contract', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, { status: 'loading' }, { onNewTask: () => {} });
    const hero = mount.querySelector('.plan-hero.pels-hero');
    expectCanonicalHeroShape(hero);
  });

  it('populated-state hero walks the same canonical contract', () => {
    const mount = mountIntoBody();
    const T0 = Date.UTC(2026, 4, 16, 6, 50, 0);
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [{
        deviceId: 'dev_water_heater',
        deviceName: 'Connected 300',
        kind: 'temperature',
        progressDirection: 'increasing',
        targetValue: 65,
        firstActionAtMs: T0,
        deadlineAtMs: T0 + 6 * 3_600_000,
        href: './?page=deadline-plan&deviceId=dev_water_heater',
        statusId: 'on_track',
        confidence: null,
        learning: false,
        extraPermissionsValue: null,
        currentValueLine: null,
        liveCauseLine: null,
      }],
    }, { onNewTask: () => {} });
    const hero = mount.querySelector('.plan-hero.pels-hero.deadlines-list-hero');
    expectCanonicalHeroShape(hero);
    const card = mount.querySelector('a.pels-surface-card.deadline-list-card[data-interactive]');
    expect(card).not.toBeNull();
    for (const tag of ['md-ripple', 'md-elevation']) {
      expect(card?.querySelector(`:scope > ${tag}`)?.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

const buildReadyPayload = (): DeadlinePlanPayload => ({
  kind: 'temperature',
  labels: deadlineLabels('temperature'),
  priceUnitLabel: 'kr/kWh',
  hero: {
    chips: [{ text: 'Building plan…', tone: 'info' }],
    tone: 'good',
    headline: 'On track — finishes by 06:30',
    headlineReason: null,
    subline: 'Connected 300 → 65 °C',
    stats: [{ label: 'Needs', value: '12.5 kWh' }],
    metaLine: null,
    deliveredSoFarLine: null,
    recourse: { label: 'Open Budget', targetTab: 'budget' },
  },
  timeline: {
    ariaLabel: 'Plan timeline',
    hours: [],
    nowIndex: 0,
    nowAxisX: -0.5,
    deadlineAxisX: 0.5,
    deadlineMarkLabel: 'deadline Mon 06:00',
    cheapestHoursCaption: null,
    planningPriceNote: null,
  },
  trajectory: {
    cardTitle: 'Will it reach 65.0 °C in time?',
    ariaLabel: 'Smart task progress trajectory for Connected 300',
    measuredPoints: [[0, 51]],
    nowPoint: [0, 51],
    plannedPoints: [[0, 51], [3_600_000, 65]],
    runBands: [],
    targetValue: 65,
    targetLabel: 'Target 65.0 °C',
    deadlineAtMs: 7_200_000,
    deadlineMarkLabel: 'deadline',
    deadlineDanger: false,
    xMinMs: 0,
    xMaxMs: 9_000_000,
    yMin: 48,
    yMax: 67,
    yFloorLabel: '48.0 °C',
    stateline: {
      emphasis: '51.0 °C now',
      rest: 'on track — projected ready ≈ Mon 05:00, 1 hour before the deadline',
      tone: 'ok',
      verdict: { label: 'On track', supporting: 'projected ready ≈ Mon 05:00, 1 hour before the deadline' },
    },
    shortfall: null,
  },
  planInputs: {
    perUnitRateLabel: null,
    perUnitRateNote: null,
    maxPowerLabel: null,
    maxPowerNote: null,
    measuredPowerLabel: null,
    priorityLabel: null,
    priorityNote: null,
    extraPermissionsValue: null,
    provenanceRows: [],
  },
  revisionLog: [], revisionSummary: { text: null, count: 0, shouldShowPanel: false },
});

const buildPendingPayload = (): DeadlinePlanPendingPayload => ({
  kind: 'temperature',
  actionMode: 'edit_and_clear',
  labels: deadlineLabels('temperature'),
  hero: {
    chips: [{ text: 'Building plan…', tone: 'info' }],
    sectionLabel: 'Heating smart task',
    headline: 'Waiting for prices',
    headlineReason: null,
    subline: 'Connected 300',
    metaLine: 'Will start when the next-day price drop publishes.',
    recourse: { label: 'Check prices', targetTab: 'electricity-prices' },
  },
});

describe('DeadlinePlan hero consumes the shared hero primitive', () => {
  it('ready-state hero walks the canonical .plan-hero shell + headline, no eyebrow', () => {
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'ready', payload: buildReadyPayload() });
    const hero = mount.querySelector('section.plan-hero.pels-hero');
    expect(hero).not.toBeNull();
    expect(hero?.getAttribute('data-tone')).toBe('good');
    const headline = hero?.querySelector('.plan-hero__headline');
    expect(headline?.tagName.toLowerCase()).toBe('h2');
    expect((headline?.textContent ?? '').trim().length).toBeGreaterThan(0);
    expect(hero?.querySelector('.eyebrow.plan-hero__section-label')).toBeNull();
    expect(hero?.querySelector('button.pels-button[data-deadline-recourse-tab="budget"]')).not.toBeNull();
  });

  it('pending-state hero walks the canonical eyebrow + headline contract', () => {
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'pending', pending: buildPendingPayload() });
    const hero = mount.querySelector('section.plan-hero.pels-hero');
    expectCanonicalHeroShape(hero);
    expect(hero?.getAttribute('data-tone')).toBe('info');
    const headline = hero?.querySelector('.plan-hero__headline');
    expect(headline?.tagName.toLowerCase()).toBe('h2');
    const eyebrow = hero?.querySelector('.eyebrow.plan-hero__section-label');
    expect(eyebrow?.tagName.toLowerCase()).toBe('p');
    expect(hero?.querySelector('button.pels-button[data-deadline-recourse-tab="electricity-prices"]')).not.toBeNull();
  });
});
