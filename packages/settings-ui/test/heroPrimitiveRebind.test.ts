import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderBudgetOverview, type BudgetOverviewProps } from '../src/ui/views/BudgetOverview.tsx';
import { renderDeadlinesList } from '../src/ui/views/DeadlinesList.tsx';
import {
  renderDeadlinePlan,
  type DeadlinePlanPayload,
  type DeadlinePlanPendingPayload,
} from '../src/ui/views/DeadlinePlan.tsx';
import { deadlineLabels } from '../../shared-domain/src/deadlineLabels.ts';

/* -------------------------------------------------------------------------- *
 * Hero primitive rebind regression tests.
 *
 * The shared hero primitive `.pels-hero` / `.plan-hero` carries the single
 * source of truth for:
 *   - the eyebrow text element (`.eyebrow` font-size / letter-spacing / colour)
 *   - the headline element (`.plan-hero__headline` weight / size / line-height)
 *   - the per-tone radial-gradient surface (`data-tone="good|warn|alert|info"`)
 *
 * Every panel header (Overview, Budget, Usage, Smart tasks, Settings, Advanced)
 * plus the deadline-plan hero must rebind to the same primitive — otherwise we
 * end up with subtle per-page typography drift the user reads as five-plus
 * near-duplicate components. These assertions are intentionally lightweight DOM
 * shape checks so the suite catches accidental regressions (someone reverts a
 * surface to a one-off `<h2>` or drops the `.eyebrow` class) without coupling
 * to pixel output (that's the screenshot suite's job).
 * -------------------------------------------------------------------------- */

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

const mountIntoBody = (): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
};

afterEach(() => {
  document.body.replaceChildren();
});

// Asserts the canonical hero shape: a `.plan-hero.pels-hero` shell with an
// eyebrow (`.eyebrow.plan-hero__section-label`) and headline (`<h2>` or `<div>`
// carrying `.plan-hero__headline`) inside a `.plan-hero__section` wrapper.
// Used to verify every rebound surface walks the same DOM contract.
const expectCanonicalHeroShape = (hero: Element | null): void => {
  expect(hero).not.toBeNull();
  expect(hero?.classList.contains('plan-hero')).toBe(true);
  expect(hero?.classList.contains('pels-hero')).toBe(true);
  const eyebrow = hero?.querySelector('.eyebrow.plan-hero__section-label');
  expect(eyebrow, 'eyebrow must carry both .eyebrow and .plan-hero__section-label').not.toBeNull();
  expect((eyebrow?.textContent ?? '').trim().length).toBeGreaterThan(0);
  const headline = hero?.querySelector('.plan-hero__headline');
  expect(headline, 'headline must carry .plan-hero__headline').not.toBeNull();
  expect((headline?.textContent ?? '').trim().length).toBeGreaterThan(0);
};

// ─── index.html panel headers (Usage, Settings, Advanced) ────────────────────

// jsdom only sees the markup we feed it; index.html is the source of truth
// for the three panels whose header is plain HTML (no preact root). Mount the
// fragment and walk the same DOM contract the rendered surfaces use.
describe('index.html panel headers consume the shared hero primitive', () => {
  const mountIndexFragment = (): Document => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    return doc;
  };

  it('Usage hero rebinds to .plan-hero.pels-hero with canonical eyebrow + headline', () => {
    const doc = mountIndexFragment();
    const usageHero = doc.querySelector('#usage-hero');
    expectCanonicalHeroShape(usageHero);
    // Tone binding stays on the same primitive — no per-surface tonal markup.
    expect(usageHero?.getAttribute('data-tone')).not.toBeNull();
    // The headline is the live `#usage-hero-headline` element; the rebind
    // promoted it from `<div>` to `<h2>` so it matches the canonical heading
    // semantics every sibling hero uses.
    const headline = usageHero?.querySelector('#usage-hero-headline');
    expect(headline?.tagName.toLowerCase()).toBe('h2');
    expect(headline?.classList.contains('plan-hero__headline')).toBe(true);
  });

  it('Settings panel header rebinds to .plan-hero.pels-hero', () => {
    const doc = mountIndexFragment();
    const settingsHero = doc.querySelector('#settings-panel > header');
    expectCanonicalHeroShape(settingsHero);
    const headline = settingsHero?.querySelector('#settings-title');
    expect(headline?.tagName.toLowerCase()).toBe('h2');
    expect(headline?.classList.contains('plan-hero__headline')).toBe(true);
  });

  // The active-mode card sits between the `h2 "Configure PELS"` hero and the
  // nav-card list; without an h3 rung the screen-reader heading nav jumps
  // straight from h2 to navigation. The label is promoted to an h3 so the
  // hierarchy stays h2 -> h3 within the Settings landing page.
  it('Settings active-mode card carries an h3 heading rung under the Settings h2', () => {
    const doc = mountIndexFragment();
    const heading = doc.querySelector('#settings-active-mode-summary');
    expect(heading, 'active-mode heading must exist').not.toBeNull();
    expect(heading?.tagName.toLowerCase()).toBe('h3');
    expect(heading?.textContent?.trim()).toBe('Current mode');
    expect(heading?.classList.contains('field__label')).toBe(true);
    // Same id used to label both the surrounding section and the select.
    const section = doc.querySelector('#settings-panel .settings-current-mode');
    expect(section?.getAttribute('aria-labelledby')).toBe('settings-active-mode-summary');
    const select = doc.querySelector('#active-mode-select');
    expect(select?.getAttribute('aria-labelledby')).toBe('settings-active-mode-summary');
  });

  it('Advanced panel header rebinds to .plan-hero.pels-hero', () => {
    const doc = mountIndexFragment();
    const advancedHero = doc.querySelector('#advanced-panel > header');
    expectCanonicalHeroShape(advancedHero);
  });
});

// ─── BudgetOverview header (preact-mounted) ──────────────────────────────────

// Minimal stub props for `renderBudgetOverview` — only the header shape is
// asserted; the chart, adjust view, and chip rendering paths are exercised
// elsewhere. Building a focused stub keeps this regression narrow and stable.
const buildBudgetProps = (overrides: Partial<BudgetOverviewProps> = {}): BudgetOverviewProps => ({
  localView: 'plan',
  view: 'today',
  hero: {
    headlineLabel: null,
    comparison: 'Daily budget off',
    delta: null,
    budgetRemainingLine: null,
    splitLine: null,
    priceTagline: null,
    decision: null,
    heroTone: 'ok',
  },
  chart: null,
  confidence: null,
  adjust: {
    draft: { enabled: false, dailyBudgetKWh: 60, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    active: { enabled: false, dailyBudgetKWh: 60, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    candidate: null,
    activeChart: null,
    candidateChart: null,
    comparisonDayView: 'today',
    comparisonDayLabel: 'Today',
    comparisonShowPrice: false,
    status: 'clean',
    busy: false,
    hardCapKw: 12,
    safetyMarginKw: 1,
  },
  allocationWarning: null,
  priceLevelChip: null,
  onLocalViewChange: () => {},
  onDayChange: () => {},
  onChartModeChange: () => {},
  onAdjustFieldChange: () => {},
  onPreview: () => {},
  onApply: () => {},
  onDiscard: () => {},
  ...overrides,
});

describe('BudgetOverview panel header consumes the shared hero primitive', () => {
  it('renders a .plan-hero.pels-hero shell with canonical eyebrow + headline (no chip rail)', () => {
    const mount = mountIntoBody();
    renderBudgetOverview(mount, buildBudgetProps());
    const header = mount.querySelector('header.plan-hero.pels-hero');
    expectCanonicalHeroShape(header);
    // No chip-row rendered when there is no priceLevelChip — the Plan/Adjust
    // toggle lands inside the headline row so the header stays a single tier
    // tall in the most common case.
    expect(header?.querySelector('.plan-hero__chips')).toBeNull();
    expect(header?.querySelector('#budget-redesign-mode-toggle')).not.toBeNull();
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
    // Toggle moves up to the chip row when the chip is present, mirroring the
    // Overview hero's info-button slot.
    expect(header?.querySelector('.plan-hero__chips #budget-redesign-mode-toggle')).not.toBeNull();
  });
});

// ─── Smart tasks (DeadlinesList) baseline header ─────────────────────────────

describe('DeadlinesList header consumes the shared hero primitive', () => {
  it('loading-state baseline header walks the canonical eyebrow + headline contract', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, { status: 'loading' });
    // BaselineHeader is rendered as a `<header>` rather than a `<section>`;
    // walk by class to stay tolerant.
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
        targetTemperatureC: 65,
        targetPercent: null,
        createdAtMs: T0 - 3_600_000,
        firstActionAtMs: T0,
        deadlineAtMs: T0 + 6 * 3_600_000,
        href: './?page=deadline-plan&deviceId=dev_water_heater',
        statusId: 'on_track',
        confidence: null,
        learning: false,
        extraPermissionsValue: null,
        currentValueLine: null,
      }],
    });
    const hero = mount.querySelector('.plan-hero.pels-hero.deadlines-list-hero');
    expectCanonicalHeroShape(hero);
  });
});

// ─── DeadlinePlan hero ───────────────────────────────────────────────────────

// `DeadlinePlan.tsx` already used `.pels-hero` before this rebind; the
// regression test pins the canonical eyebrow + headline + tone contract so a
// future refactor can't silently revert to a one-off heading.
const buildReadyPayload = (): DeadlinePlanPayload => ({
  kind: 'temperature',
  labels: deadlineLabels('temperature'),
  priceUnitLabel: 'kr/kWh',
  hero: {
    chips: [{ text: 'Building plan…', tone: 'info' }],
    tone: 'good',
    sectionLabel: 'Heating smart task',
    headline: 'On track — finishes by 06:30',
    headlineReason: null,
    subline: 'Connected 300 → 65 °C',
    metaLine: 'Needs 12.5 kWh · 3.0 kW · 4 h',
    costMetaLine: null,
    deliveredSoFarLine: null,
    recourse: null,
  },
  timeline: {
    ariaLabel: 'Plan timeline',
    progressFloor: 50,
    progressCeilingValue: 65,
    progressCeilingLabel: '65 °C',
    deadlineLabel: 'By 06:30',
    hours: [],
  },
  planInputs: {
    perUnitRateLabel: null,
    perUnitRateNote: null,
    maxPowerLabel: null,
    maxPowerNote: null,
    extraPermissionsValue: null,
    provenanceRows: [],
  },
  revisionLog: [], revisionSummary: { text: null, count: 0, shouldShowPanel: false },
});

const buildPendingPayload = (): DeadlinePlanPendingPayload => ({
  kind: 'temperature',
  labels: deadlineLabels('temperature'),
  hero: {
    chips: [{ text: 'Building plan…', tone: 'info' }],
    sectionLabel: 'Heating smart task',
    headline: 'Waiting for prices',
    headlineReason: null,
    subline: 'Connected 300',
    metaLine: 'Will start when the next-day price drop publishes.',
    recourse: null,
  },
});

describe('DeadlinePlan hero consumes the shared hero primitive', () => {
  it('ready-state hero walks the canonical eyebrow + headline contract', () => {
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'ready', payload: buildReadyPayload() });
    const hero = mount.querySelector('section.plan-hero.pels-hero');
    expectCanonicalHeroShape(hero);
    // Tone binding flows from the producer through `data-tone` — same
    // attribute every other hero uses.
    expect(hero?.getAttribute('data-tone')).toBe('good');
    // The headline is an `<h2>` (matching the four sibling panels) so
    // screen readers see the same heading structure across surfaces. The
    // eyebrow is a `<p>` so the canonical typography cascade (`<p>` margins
    // reset via `.eyebrow`) lands the same way every other hero renders.
    const headline = hero?.querySelector('.plan-hero__headline');
    expect(headline?.tagName.toLowerCase()).toBe('h2');
    const eyebrow = hero?.querySelector('.eyebrow.plan-hero__section-label');
    expect(eyebrow?.tagName.toLowerCase()).toBe('p');
  });

  it('pending-state hero walks the canonical eyebrow + headline contract', () => {
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'pending', pending: buildPendingPayload() });
    const hero = mount.querySelector('section.plan-hero.pels-hero');
    expectCanonicalHeroShape(hero);
    expect(hero?.getAttribute('data-tone')).toBe('info');
    // Same shell shape as the ready hero — the pending variant must not
    // silently revert to a `<div>` headline / `<span>` eyebrow.
    const headline = hero?.querySelector('.plan-hero__headline');
    expect(headline?.tagName.toLowerCase()).toBe('h2');
    const eyebrow = hero?.querySelector('.eyebrow.plan-hero__section-label');
    expect(eyebrow?.tagName.toLowerCase()).toBe('p');
  });
});
