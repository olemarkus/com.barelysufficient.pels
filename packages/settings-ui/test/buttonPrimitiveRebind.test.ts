import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- *
 * Button primitive rebind regression tests (batch 10 / phase 2 of the broader
 * primitive-unification work).
 *
 * Canonical primitive choice (Option A): MD Web button wrappers
 * (`<md-text-button>`, `<md-filled-button>`, `<md-outlined-button>`) remain
 * the source of truth for MD Web buttons -- they ship M3-correct focus rings,
 * state-layer ripples, ARIA, and the 48 px touch-target floor that
 * reinventing in a custom class would silently lose. Phase 2's value-add is
 * collapsing the per-page native-button shape (`.plan-hero__recourse-button`,
 * scoped + doubled-class hack under `#deadline-plan-panel`) onto one
 * canonical `.pels-button` class that all three recourse CTAs share.
 *
 * The "ghost decoration" classes (`.btn`, `.btn ghost`, `.btn secondary`)
 * that double up on MD Web hosts are intentionally NOT in scope here -- they
 * paint nothing on the MD Web shadow surface, so retiring them is a fan-out
 * cleanup with no visible delta. Routed to the TODO follow-up sub-bullets
 * (see the parent P1 entry in `TODO.md`).
 *
 * Assertions are lightweight DOM / source-text checks so the suite catches
 * accidental regressions (someone resurrects `.plan-hero__recourse-button`
 * or forks a new per-page native button class) without coupling to pixel
 * output (that's the screenshot suite's job).
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const STYLE_CSS = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
const SETTINGS_UI_SRC = path.join(__dirname, '..', 'src');

const collectSourceFiles = (dir: string, acc: string[] = []): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') return;
      collectSourceFiles(path.join(dir, entry.name), acc);
      return;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  });
  return acc;
};

// --- Canonical `.pels-button` primitive contract ---------------------------

// Collect every CSS rule body whose selector list includes a `.pels-button`
// reference. We deliberately ignore which exact selector pinned the rule
// (bare class, doubled class, panel-scoped, hover/focus pseudo) — these
// assertions only care that the canonical primitive ships the visual
// contract, not which selector form happens to declare it. Lets the
// defensive-cascade duplication and shape-on-bare-class refactor stay an
// implementation choice rather than a test-pinned constraint.
const pelsButtonRuleBodies = (): string[] => {
  const bodies: string[] = [];
  const ruleRegex = /([^{}]*)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRegex.exec(STYLE_CSS)) !== null) {
    const selectors = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\bpels-button\b/.test(selectors)) {
      bodies.push(body);
    }
  }
  return bodies;
};

describe('button primitive: canonical `.pels-button` is the single native-button shell', () => {
  it('declares the bare `.pels-button` selector so the class works standalone', () => {
    // If only doubled / panel-scoped rules existed, a consumer adopting
    // `.pels-button` on a fresh surface (outside `#deadline-plan-panel`)
    // would inherit none of the visual contract. The bare class MUST carry
    // the shape so the primitive is genuinely reusable.
    expect(STYLE_CSS).toMatch(/^\.pels-button\s*\{/m);
  });

  it('keeps the doubled-class + panel-scoped defensive cascade for Homey-attacked surfaces', () => {
    // The deadline-plan panel's host stylesheet overrides plain `button`
    // selectors; we need a (0,2,1) doubled-class cascade to win without
    // `!important`. Don't lose this guard.
    expect(STYLE_CSS).toMatch(
      /#deadline-plan-panel\s+button\.pels-button\.pels-button\s*\{/,
    );
  });

  it('lands the 48 px touch-target floor on at least one `.pels-button` rule', () => {
    // The recourse CTA is the affordance that lets a user pivot from "I
    // can't finish in time" to "open the budget / overview tab to fix it" --
    // it MUST honour the project-wide `--pels-touch-target-min` floor.
    const bodies = pelsButtonRuleBodies();
    const hasTouchTarget = bodies.some((body) =>
      /min-height:\s*var\(--pels-touch-target-min\)/.test(body),
    );
    expect(hasTouchTarget, 'expected at least one `.pels-button` rule with min-height: var(--pels-touch-target-min)').toBe(true);
  });

  it('routes focus-visible through an outline ring on at least one `.pels-button` rule', () => {
    // Focus ring is accessibility-critical; it must ride the canonical
    // primitive so future consumers inherit it without re-declaring
    // per-page overrides.
    const bodies = pelsButtonRuleBodies();
    const hasFocusOutline = bodies.some((body) =>
      /outline:\s*2px\s+solid\s+var\(--accent\)/.test(body),
    );
    expect(hasFocusOutline, 'expected at least one `.pels-button:focus-visible` rule with outline: 2px solid var(--accent)').toBe(true);
  });

  it('routes disabled state through opacity + cursor on at least one `.pels-button` rule', () => {
    const bodies = pelsButtonRuleBodies();
    const hasDisabledState = bodies.some((body) =>
      /opacity:\s*var\(--opacity-disabled\)/.test(body) && /cursor:\s*not-allowed/.test(body),
    );
    expect(hasDisabledState, 'expected at least one `.pels-button:disabled` rule with opacity + not-allowed cursor').toBe(true);
  });
});

// --- Legacy `.plan-hero__recourse-button` retired --------------------------

describe('button primitive: the per-page `.plan-hero__recourse-button` no longer exists', () => {
  it('does not declare any `.plan-hero__recourse-button` selector in style.css', () => {
    // The selector lived only as a doubled-class scoped block; if anything
    // matches it has been resurrected.
    const lines = STYLE_CSS.split('\n');
    const offending = lines.filter((line) => /\.plan-hero__recourse-button\b/.test(line));
    expect(
      offending,
      `unexpected legacy .plan-hero__recourse-button selector(s):\n${offending.join('\n')}`,
    ).toHaveLength(0);
  });

  it('does not reference `.plan-hero__recourse-button` in any source file', () => {
    // The 3 consumer sites (DeadlineHero ready, PendingHero, history-detail
    // hero) should all carry `.pels-button` now. Allow comments / strings
    // that contain "recourse" but not the legacy class name itself.
    const sourceFiles = collectSourceFiles(SETTINGS_UI_SRC);
    const offending: string[] = [];
    sourceFiles.forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (/plan-hero__recourse-button/.test(line)) {
          offending.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    });
    expect(
      offending,
      `legacy .plan-hero__recourse-button still referenced:\n${offending.join('\n')}`,
    ).toHaveLength(0);
  });
});

// --- Per-surface button rebind ---------------------------------------------

describe('button primitive: every native-button recourse CTA walks the canonical `.pels-button`', () => {
  // DeadlinePlan ready hero + PendingHero + DeadlinePlanHistoryDetail are
  // the three sites that render the native `<button>` recourse CTA. Each
  // must carry the canonical class so the dispatcher in
  // `deadlinePlanMount.ts` (which still keys off `data-deadline-recourse-
  // tab`) sees the same shell on every surface.
  const DEADLINE_PLAN_TSX = path.join(SETTINGS_UI_SRC, 'ui', 'views', 'DeadlinePlan.tsx');
  const DEADLINE_HISTORY_DETAIL_TSX = path.join(
    SETTINGS_UI_SRC,
    'ui',
    'views',
    'DeadlinePlanHistoryDetail.tsx',
  );

  const recourseButtonHits = (filePath: string): string[] => {
    const text = fs.readFileSync(filePath, 'utf8');
    // Collapse whitespace so single-line and multi-line JSX both match.
    const collapsed = text.replace(/\s+/g, ' ');
    const matches: string[] = [];
    const regex = /<button[^>]*\bdata-deadline-recourse-tab\b[^>]*>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(collapsed)) !== null) {
      matches.push(match[0]);
    }
    return matches;
  };

  it('DeadlinePlan ready + pending hero recourse buttons carry `.pels-button`', () => {
    const hits = recourseButtonHits(DEADLINE_PLAN_TSX);
    expect(
      hits,
      'expected two native recourse buttons (DeadlineHero + PendingHero)',
    ).toHaveLength(2);
    hits.forEach((hit) => {
      expect(hit, `recourse button missing .pels-button: ${hit}`).toMatch(
        /class="pels-button"/,
      );
      expect(hit, `recourse button must not retain legacy class: ${hit}`).not.toMatch(
        /plan-hero__recourse-button/,
      );
    });
  });

  it('DeadlinePlanHistoryDetail recourse button carries `.pels-button`', () => {
    const hits = recourseButtonHits(DEADLINE_HISTORY_DETAIL_TSX);
    expect(hits, 'expected one native recourse button (history-detail hero)').toHaveLength(1);
    expect(hits[0]).toMatch(/class="pels-button"/);
    expect(hits[0]).not.toMatch(/plan-hero__recourse-button/);
  });

  // Batch 12 (P2 follow-up): the chart-toggle ghost button on the Succeeded
  // receipt shape was deferred from the batch 10 rebind because an e2e
  // selector pinned the per-page class. It now chains the canonical
  // `.pels-button` primitive + a `.plan-history-detail__chart-toggle`
  // decorator that overrides the ghost-specific visuals (transparent bg,
  // narrower padding, hover/focus tint). Pin both ends of the chain so
  // a future drop of either side fails fast.
  it('DeadlinePlanHistoryDetail chart toggle chains `.pels-button` + decorator', () => {
    const text = fs.readFileSync(DEADLINE_HISTORY_DETAIL_TSX, 'utf8');
    const collapsed = text.replace(/\s+/g, ' ');
    // The toggle is the only `<button>` carrying both classes on the
    // history-detail surface, so a single combined match is sufficient.
    const regex = /<button[^>]*class="pels-button plan-history-detail__chart-toggle"[^>]*>/g;
    const matches = collapsed.match(regex) ?? [];
    expect(
      matches,
      'expected the chart toggle to chain `.pels-button plan-history-detail__chart-toggle`',
    ).toHaveLength(1);
    // Defensive: aria-expanded is part of the toggle contract; if a future
    // edit drops it, the disclosure stops being announced to screen readers.
    expect(matches[0]).toMatch(/aria-expanded=/);
  });
});

// --- Chart-toggle decorator beats the panel-scoped `.pels-button` cascade --

describe('button primitive: `.plan-history-detail__chart-toggle` decorator preserves the ghost visual', () => {
  // The chain (`.pels-button .plan-history-detail__chart-toggle`) only works
  // if the decorator's rules can actually beat the panel-scoped doubled-class
  // `.pels-button` cascade that paints the filled-CTA visuals. The decorator
  // must therefore carry its own doubled-class rule (outside the panel scope)
  // AND a panel-scoped doubled-class rule (inside `#deadline-plan-panel`) to
  // win specificity on both surfaces. Pin both forms so a future edit can't
  // accidentally collapse them into a single bare-class rule that silently
  // shifts the toggle from ghost to filled.
  it('declares a doubled-class decorator rule so the bare selector wins (0,2,0)', () => {
    expect(STYLE_CSS).toMatch(
      /^\.plan-history-detail__chart-toggle\.plan-history-detail__chart-toggle\s*\{/m,
    );
  });

  it('declares a panel-scoped doubled-class rule so the decorator wins inside `#deadline-plan-panel`', () => {
    expect(STYLE_CSS).toMatch(
      /#deadline-plan-panel\s+button\.plan-history-detail__chart-toggle\.plan-history-detail__chart-toggle\s*\{/,
    );
  });

  it('keeps the ghost background (transparent) on the decorator', () => {
    // Filled `.pels-button` paints `background: var(--pels-surface-container-high)`;
    // the ghost decorator must override with `transparent`. If a future
    // edit drops the override, the toggle silently becomes a filled CTA
    // that visually competes with the H2 it sits beside.
    expect(STYLE_CSS).toMatch(
      /\.plan-history-detail__chart-toggle\.plan-history-detail__chart-toggle\s*\{[^}]*background:\s*transparent/,
    );
  });

  it('positions the panel-scoped decorator AFTER the panel-scoped `.pels-button` block (source-order tie-break)', () => {
    // Inside `#deadline-plan-panel`, both the canonical `.pels-button`
    // doubled-class block and the chart-toggle doubled-class decorator
    // carry specificity `(1,2,1)`. When specificity ties, the *later*
    // rule wins. If a future cleanup re-orders the file and moves the
    // decorator above the canonical block, the toggle silently shifts
    // to filled — exactly the regression the e2e selector and the
    // visual-contract assertions above are meant to catch, but those
    // signal too late (test failure / pixel shift). Pin the ordering
    // explicitly so the wrong move fails at source-grep time.
    const pelsButtonScoped = STYLE_CSS.indexOf(
      '#deadline-plan-panel button.pels-button.pels-button {',
    );
    const chartToggleScoped = STYLE_CSS.indexOf(
      '#deadline-plan-panel button.plan-history-detail__chart-toggle.plan-history-detail__chart-toggle {',
    );
    expect(pelsButtonScoped).toBeGreaterThan(-1);
    expect(chartToggleScoped).toBeGreaterThan(-1);
    expect(
      chartToggleScoped,
      'chart-toggle panel-scoped decorator must appear after the panel-scoped `.pels-button` block so source-order tie-break favours the ghost decorator',
    ).toBeGreaterThan(pelsButtonScoped);
  });
});
