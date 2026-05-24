import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { renderDeadlinesList } from '../src/ui/views/DeadlinesList.tsx';
import { DeadlinePlanHistory } from '../src/ui/views/DeadlinePlanHistory.tsx';
import type { DeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';

/* -------------------------------------------------------------------------- *
 * Card primitive rebind regression tests (batch 11 / phase 3 of the broader
 * primitive-unification work — chip shipped in batch 9, button in batch 10).
 *
 * `.pels-surface-card` is the single canonical card primitive across every
 * settings-UI surface — Budget redesign cards, Usage cards, Smart-task list
 * cards, Past-plan history cards, Deadline-plan layout cards, Device-row
 * plan cards (`.plan-card`), Device-group cards (`.pels-device-card`),
 * device-detail diagnostics cards (`.detail-diagnostics-card`). The canonical
 * primitive carries the bg / border / radius / padding / gap / overflow /
 * isolation / M3 elevation contract that EVERY card surface inherits. Per-
 * page classes are layout / role decorators ONLY — they do NOT redeclare the
 * visual contract.
 *
 * Tonal state lives in either the canonical data attribute
 * (`data-tone="good|warn|alert|info|muted"`, shared with `.plan-hero` and
 * `.plan-chip`) or the legacy `.plan-card[data-state-kind="held|resuming|
 * unavailable"]` aliases the device-row card still uses. Both resolve onto
 * the same `--color-state-*-bg/-border` cascade so new consumers can pick
 * the data-tone form without forcing a mass migration. Interactive cards
 * (clickable list / link cards) opt into the canonical hover-elevation +
 * focus-outline contract via `data-interactive` on the host.
 *
 * The forked per-page surface rules (`.plan-history-card`, `.deadline-list-
 * card`, `.detail-diagnostics-card`) that previously redeclared bg / border /
 * radius / padding are retired in this rebind — only the canonical primitive
 * declares them. Dead `.summary-card` + `.usage-summary` + `.summary-label` +
 * `.summary-value` rules (v1 layout, no longer emitted in markup) drop with
 * the pass.
 *
 * Assertions are lightweight DOM / source-text checks so the suite catches
 * accidental regressions (someone resurrects the per-page surface fork or
 * spawns a new per-page card class without rebinding) without coupling to
 * pixel output (that is the screenshot suite's job).
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const STYLE_CSS = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
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

// Strip CSS comments before splitting the file into rules — multi-line `/* … */`
// blocks frequently sit BETWEEN a previous `}` and the next `{`, which would
// otherwise inflate the "selectors" portion of the next rule with comment prose
// and break a bare-selector match.
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Collect every CSS rule body whose selector list includes a `.pels-surface-card`
// reference. The canonical primitive's visual contract is asserted across rule
// bodies (not coupled to a single declaration site) so the cascade can stay an
// implementation choice rather than a test-pinned shape.
const pelsSurfaceCardRuleBodies = (): { selectors: string; body: string }[] => {
  const out: { selectors: string; body: string }[] = [];
  const ruleRegex = /([^{}]*)\{([^}]*)\}/g;
  const stripped = stripCssComments(STYLE_CSS);
  let match: RegExpExecArray | null;
  while ((match = ruleRegex.exec(stripped)) !== null) {
    const selectors = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\bpels-surface-card\b/.test(selectors)) {
      out.push({ selectors, body });
    }
  }
  return out;
};

// --- Canonical `.pels-surface-card` primitive contract ---------------------

describe('card primitive: canonical `.pels-surface-card` carries the visual contract', () => {
  it('declares the bare `.pels-surface-card` selector with the surface shape', () => {
    // The bare class must declare padding / gap / border / radius / bg so a
    // consumer adopting `.pels-surface-card` on a fresh surface inherits the
    // full contract without composing with a per-page decorator.
    const bodies = pelsSurfaceCardRuleBodies();
    const bareRule = bodies.find(({ selectors }) =>
      /^\s*\.pels-surface-card\s*$/.test(selectors.trim()),
    );
    expect(bareRule, 'expected a bare `.pels-surface-card` selector in style.css').not.toBeUndefined();
    expect(bareRule?.body).toMatch(/padding:\s*var\(--pels-card-padding\)/);
    expect(bareRule?.body).toMatch(/gap:\s*var\(--pels-card-gap\)/);
    expect(bareRule?.body).toMatch(/border:\s*1px\s+solid\s+var\(--pels-surface-outline\)/);
    expect(bareRule?.body).toMatch(/border-radius:\s*var\(--pels-card-radius\)/);
    expect(bareRule?.body).toMatch(/background:\s*var\(--color-surface-1\)/);
    expect(bareRule?.body).toMatch(/--md-elevation-level:\s*1/);
  });

  it('declares the canonical `data-tone="…"` API (good / warn / alert / info / muted)', () => {
    // Mirrors the chip-primitive pattern: a single source of truth for tone on
    // the canonical primitive so future consumers can pick the data-attribute
    // form without forcing a mass migration of the existing
    // `.plan-card[data-state-kind="…"]` aliases.
    const expectedTones = ['good', 'warn', 'alert', 'info', 'muted'];
    expectedTones.forEach((tone) => {
      const selector = `.pels-surface-card[data-tone="${tone}"]`;
      expect(STYLE_CSS, `expected ${selector} selector in style.css`).toContain(selector);
    });
  });

  it('routes interactive hover + focus elevation through `data-interactive` on the canonical primitive', () => {
    // Clickable cards (deadline-list link, past-plan history link) opt into
    // the canonical hover-elevation + focus-outline contract via
    // `data-interactive` on the host. Previously each per-page class
    // redeclared its own `:hover` / `:focus-visible` rules; the canonical
    // primitive now owns them.
    expect(STYLE_CSS).toMatch(
      /\.pels-surface-card\[data-interactive\]:hover[\s\S]*?--md-elevation-level:\s*3/,
    );
    expect(STYLE_CSS).toMatch(
      /\.pels-surface-card\[data-interactive\]:focus-visible[\s\S]*?outline:\s*2px\s+solid\s+var\(--color-focus-ring\)/,
    );
  });
});

// --- Per-surface forked rules retired --------------------------------------

describe('card primitive: per-page forked surface rules are retired', () => {
  it('does not redeclare bg / border / radius / padding on `.plan-history-card` base', () => {
    // The legacy `.plan-history-card { background: var(--pels-surface-
    // container-low); border: 1px solid var(--pels-surface-outline);
    // border-radius: var(--radius-md); padding: var(--spacing-3); }` block
    // forked the canonical surface (different surface tier, tighter radius).
    // Rebound onto `.pels-surface-card`; only layout (display / flex /
    // flex-direction / gap) survives.
    const ruleRegex = /(?:^|\n)\.plan-history-card\s*\{([^}]*)\}/m;
    const match = STYLE_CSS.match(ruleRegex);
    expect(match, 'expected a `.plan-history-card` rule in style.css').not.toBeNull();
    const body = match?.[1] ?? '';
    expect(body, 'plan-history-card base must NOT redeclare background').not.toMatch(/background\s*:/);
    expect(body, 'plan-history-card base must NOT redeclare border').not.toMatch(/border\s*:/);
    expect(body, 'plan-history-card base must NOT redeclare border-radius').not.toMatch(/border-radius\s*:/);
    expect(body, 'plan-history-card base must NOT redeclare padding').not.toMatch(/padding\s*:/);
  });

  it('does not redeclare bg / border / radius / padding / box-shadow on `.deadline-list-card` base', () => {
    // The legacy `.deadline-list-card` rule forked padding / border-radius /
    // bg surface tier / box-shadow. Rebound onto `.pels-surface-card`; only
    // layout (grid-template-columns / gap / align-items) + the link-anchor
    // reset survives.
    const ruleRegex = /(?:^|\n)\.deadline-list-card\s*\{([^}]*)\}/m;
    const match = STYLE_CSS.match(ruleRegex);
    expect(match, 'expected a `.deadline-list-card` rule in style.css').not.toBeNull();
    const body = match?.[1] ?? '';
    expect(body, 'deadline-list-card base must NOT redeclare background').not.toMatch(/background\s*:/);
    expect(body, 'deadline-list-card base must NOT redeclare border:').not.toMatch(/(?:^|\s)border\s*:/);
    expect(body, 'deadline-list-card base must NOT redeclare border-radius').not.toMatch(/border-radius\s*:/);
    expect(body, 'deadline-list-card base must NOT redeclare padding').not.toMatch(/(?:^|\s)padding\s*:/);
    expect(body, 'deadline-list-card base must NOT redeclare box-shadow').not.toMatch(/box-shadow\s*:/);
  });

  it('does not redeclare `background:` on `.deadline-list-card:hover, :focus-visible`', () => {
    // The hover/focus state previously swapped `background: var(--color-
    // surface-3)` on top of the M3 elevation lift the canonical
    // `.pels-surface-card[data-interactive]:hover` already provides — that
    // duplicated the elevation contract. The decorator now only carries the
    // accent border swap; the elevation lift owns the surface tier change.
    const ruleRegex =
      /\.deadline-list-card:hover\s*,\s*\.deadline-list-card:focus-visible\s*\{([^}]*)\}/m;
    const match = STYLE_CSS.match(ruleRegex);
    expect(
      match,
      'expected a `.deadline-list-card:hover, :focus-visible` rule in style.css',
    ).not.toBeNull();
    const body = match?.[1] ?? '';
    expect(
      body,
      'deadline-list-card hover/focus must NOT redeclare background (canonical elevation lift owns the surface tier change)',
    ).not.toMatch(/background\s*:/);
  });

  it('does not declare a `.detail-diagnostics-card` base rule (hardcoded radius + literal padding retired)', () => {
    // The legacy `.detail-diagnostics-card { background: var(--panel);
    // border: 1px solid var(--panel-border); border-radius: 10px; padding:
    // 12px; }` block forked the canonical surface AND bypassed the token
    // system (hardcoded `10px` radius + literal `12px` padding). Rebound
    // onto `.pels-surface-card`; only sub-element typography (e.g.
    // `.detail-diagnostics-card h4`) survives.
    const lines = STYLE_CSS.split('\n');
    const offending = lines.filter((line) => /^\s*\.detail-diagnostics-card\s*\{/.test(line));
    expect(
      offending,
      `unexpected legacy .detail-diagnostics-card { … } base rule:\n${offending.join('\n')}`,
    ).toHaveLength(0);
  });

  it('does not declare the dead `.summary-card` / `.usage-summary` / `.summary-label` / `.summary-value` rules', () => {
    // These were v1 "summary cards" carry-overs — no markup site has emitted
    // them since the budget-redesign migration. The canonical card primitive
    // consolidation drops them on the same pass; only `.summary-value--empty`
    // (still toggled by `power.ts` + `usageDayView.ts`) survives.
    const deadSelectors = [
      /^\s*\.summary-card\s*\{/m,
      /^\s*\.usage-summary\s*\{/m,
      /^\s*\.summary-label\s*\{/m,
      /^\s*\.summary-value\s*\{/m,
    ];
    deadSelectors.forEach((pattern) => {
      expect(STYLE_CSS, `unexpected dead selector matching ${pattern}`).not.toMatch(pattern);
    });
    // The live `.summary-value--empty` marker MUST stay — runtime depends on it.
    expect(STYLE_CSS).toMatch(/^\s*\.summary-value--empty\s*\{/m);
  });
});

// --- Per-surface card rebind -----------------------------------------------

describe('card primitive: every surface walks the canonical `.pels-surface-card`', () => {
  it('Smart-task list cards mount through `.pels-surface-card.deadline-list-card` with `data-interactive`', () => {
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
    const card = mount.querySelector('a.deadline-list-card');
    expect(card, 'expected a .deadline-list-card link').not.toBeNull();
    expect(card?.classList.contains('pels-surface-card')).toBe(true);
    expect(card?.hasAttribute('data-interactive')).toBe(true);
  });

  it('Past-plan history cards mount through `.pels-surface-card.plan-history-card` with `data-interactive`', () => {
    const entry: DeferredObjectivePlanHistoryEntry = {
      id: 'entry-card-rebind-1',
      originalPlan: null,
      finalPlan: null,
      deviceId: 'dev_water_heater',
      deviceName: 'Connected 300',
      objectiveKind: 'temperature',
      targetTemperatureC: 65,
      targetPercent: null,
      deadlineAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
      startedAtMs: Date.UTC(2026, 4, 6, 0, 0, 0),
      finalizedAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
      startProgressC: 50,
      startProgressPercent: null,
      finalProgressC: 65,
      finalProgressPercent: null,
      initialEnergyNeededKWh: 22.5,
      outcome: 'met',
      metAtMs: Date.UTC(2026, 4, 6, 4, 42, 0),
      usedDeadlineReserve: false,
      usedPolicyAvoid: false,
      observedIntervals: [{
        fromMs: Date.UTC(2026, 4, 6, 0, 0, 0),
        toMs: Date.UTC(2026, 4, 6, 6, 0, 0),
      }],
      discoveredFrom: 'observation',
    };
    const mount = document.createElement('div');
    render(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }), mount);
    const card = mount.querySelector('a.plan-history-card');
    expect(card, 'expected a .plan-history-card link').not.toBeNull();
    expect(card?.classList.contains('pels-surface-card')).toBe(true);
    expect(card?.hasAttribute('data-interactive')).toBe(true);
  });

  it('device-row plan-card JSX consumers chain `pels-surface-card` (PlanDeviceCards / PlanSteppedCard)', () => {
    // We scan source for the exact class-string template each consumer uses.
    // The four producers (PlanDeviceCards binary, PlanDeviceCards temperature,
    // PlanSteppedCard, devices.ts imperative device-group card) MUST all
    // chain `pels-surface-card` on the host so the device-row card lights
    // up the canonical surface.
    const PLAN_DEVICE_CARDS = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'ui', 'views', 'PlanDeviceCards.tsx'),
      'utf8',
    );
    const PLAN_STEPPED_CARD = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'ui', 'views', 'PlanSteppedCard.tsx'),
      'utf8',
    );
    const DEVICES_TS = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'ui', 'devices.ts'),
      'utf8',
    );

    // PlanDeviceCards has two plan-card hosts (binary + temperature variants).
    expect(PLAN_DEVICE_CARDS.match(/['"]pels-surface-card[^'"]*plan-card[^'"]*['"]/g) ?? [])
      .toHaveLength(2);
    expect(PLAN_STEPPED_CARD.match(/['"]pels-surface-card[^'"]*plan-card[^'"]*['"]/g) ?? [])
      .toHaveLength(1);
    expect(DEVICES_TS.match(/['"]pels-surface-card\s+plan-card[^'"]*['"]/g) ?? [])
      .toHaveLength(1);
  });

  it('device-detail diagnostics cards chain `pels-surface-card` (vanilla DOM consumer)', () => {
    const DIAGNOSTICS_TS = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'ui', 'deviceDetail', 'diagnostics.ts'),
      'utf8',
    );
    // Two imperative diagnostics-card hosts (per-window summary + starvation
    // detail) — both must chain `pels-surface-card`.
    const hits = DIAGNOSTICS_TS.match(/\.className\s*=\s*['"]pels-surface-card\s+detail-diagnostics-card['"]/g) ?? [];
    expect(hits).toHaveLength(2);
    // The legacy bare-class form (without `pels-surface-card`) should NOT
    // appear; resurrecting it would re-fork the canonical surface.
    expect(DIAGNOSTICS_TS).not.toMatch(/\.className\s*=\s*['"]detail-diagnostics-card['"]/);
  });

  it('index.html usage-card consumers carry both `pels-surface-card` and `usage-card`', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const usageCards = doc.querySelectorAll('.usage-card');
    expect(usageCards.length).toBeGreaterThan(0);
    usageCards.forEach((card) => {
      expect(
        card.classList.contains('pels-surface-card'),
        `usage-card host missing canonical .pels-surface-card: ${card.outerHTML.slice(0, 120)}`,
      ).toBe(true);
    });
  });

  it('index.html budget-redesign-card consumers carry both `pels-surface-card` and `budget-redesign-card`', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const budgetCards = doc.querySelectorAll('.budget-redesign-card');
    expect(budgetCards.length).toBeGreaterThan(0);
    budgetCards.forEach((card) => {
      expect(
        card.classList.contains('pels-surface-card'),
        `budget-redesign-card host missing canonical .pels-surface-card: ${card.outerHTML.slice(0, 120)}`,
      ).toBe(true);
    });
  });
});
