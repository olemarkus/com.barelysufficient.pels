import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- *
 * Narrow primitive rebind regression tests (batch 11 / phases 4-6 of the
 * broader primitive-unification work).
 *
 * Three narrow primitive surfaces share a single regression suite because
 * each phase is small enough that a dedicated file per primitive would be
 * mostly setup boilerplate:
 *
 *   - Phase 4 — Segmented control. `.segmented` is the single canonical
 *     small-set, mutually-exclusive view-filter shell (Plan/Adjust,
 *     Yesterday/Today/Tomorrow, Progress/Hourly plan, 7d/14d,
 *     All/Weekday/Weekend, Current/History plan, device-detail When-limiting).
 *     The DOM contract (a `.segmented` container with `role="group"` or
 *     `role="radiogroup"`, button children carrying `.segmented__option` and
 *     `aria-pressed` or `aria-checked`) must stay byte-identical across the
 *     imperative `createToggleGroup` builder (`components.ts`) and the
 *     preact `ToggleGroup` (`BudgetOverview.tsx`) so a future refactor
 *     cannot silently fork the two renderers.
 *
 *   - Phase 5 — Ripple. `MdRipple` (Material Web `<md-ripple>`) is the
 *     single source of truth for the state-layer ripple. Every consumer
 *     mounts it with the exact same props (`aria-hidden="true"`, no other
 *     attributes) so the ripple stays consistently decorative — no
 *     surface should declare its own `.ripple` / `.has-ripple` class or
 *     pass divergent props (`attached`, custom colour) that would fork
 *     the visual contract.
 *
 *   - Phase 6 — Elevation. `MdElevation` (Material Web `<md-elevation>`)
 *     is the single source of truth for surface elevation on card-like
 *     primitives (`.plan-card`, `.pels-surface-card`, `.deadline-list-card`,
 *     `.usage-card`). Per-surface raw `box-shadow` declarations must
 *     either use a shared `var(--shadow-*)` token (so elevation language
 *     stays unified) or be the narrow class of 1-3 px contrast outlines
 *     (focus rings, tick markers, inset borders) that decorate a single
 *     element rather than lift a surface.
 *
 * These assertions are intentionally lightweight DOM / source-text checks
 * so the suite catches accidental regressions (someone forks a per-page
 * segmented modifier, passes a one-off MdRipple prop, or hardcodes a card
 * box-shadow) without coupling to pixel output (that's the screenshot
 * suite's job).
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const STYLE_CSS = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
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

const SOURCE_FILES = collectSourceFiles(SETTINGS_UI_SRC);

// ─── Phase 4: Segmented control ──────────────────────────────────────────────

describe('segmented primitive: canonical `.segmented` is the single source of truth', () => {
    it('declares the canonical `.segmented` shell selector', () => {
        // Sanity check the canonical primitive selector still exists. Catches
        // an accidental rename to `.pels-segmented` / `.toggle-group` that
        // would silently break every existing consumer.
        expect(STYLE_CSS).toMatch(/^\.segmented\s*\{/m);
    });

    it('declares the canonical `.segmented__option` button shell', () => {
        // The option-button child is the load-bearing element (it's where the
        // base / hover / focus-visible / disabled / selected states paint).
        // If it ever moves to a per-page class the cascade falls apart.
        expect(STYLE_CSS).toMatch(/\.segmented\s+button\.segmented__option/);
    });

    it('does not declare per-page `.segmented--{panel}` tonal modifiers', () => {
        // Layout overrides on top of `.segmented` (max-width, grid-template-
        // columns) live under the page scope (`#device-detail-panel .segmented`,
        // `.budget-chart-card .budget-card-header .segmented`,
        // `.budget-setting-row--stacked > .segmented`) and don't fork the
        // primitive. A `.segmented--{panel}` modifier would though — it would
        // mean the primitive itself carries a per-page variant, which is the
        // shape this consolidation set out to retire. Audit the file for any
        // `.segmented--…` selector and fail if one slips back in.
        const lines = STYLE_CSS.split('\n');
        const offending = lines.filter((line) => /^\s*\.segmented--[a-z]/.test(line));
        expect(
            offending,
            `unexpected per-page segmented modifier(s):\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('does not reference a `segmented--{panel}` className in any source file', () => {
        // Mirror the CSS rule above on the JSX / imperative-DOM side: ban any
        // `segmented--…` token inside a className-style string literal. The
        // `.segmented` base + `.segmented__option` BEM child are the only
        // canonical names; per-page layout overrides should scope on the
        // panel's own id / wrapping class instead of forking the primitive.
        const offending: string[] = [];
        SOURCE_FILES.forEach((file) => {
            const text = fs.readFileSync(file, 'utf8');
            const lines = text.split('\n');
            lines.forEach((line, i) => {
                const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
                if (/['"`][^'"`]*\bsegmented--[a-z][^'"`]*['"`]/.test(stripped)) {
                    offending.push(`${file}:${i + 1}: ${line.trim()}`);
                }
            });
        });
        expect(
            offending,
            `per-page segmented modifier className still referenced:\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('imperative `createToggleGroup` builds the canonical `.segmented` DOM shape', async () => {
        const { createToggleGroup } = await import('../src/ui/components.ts');
        const result = createToggleGroup<'a' | 'b'>(
            [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
            ],
            'Test toggle',
            () => {},
        );
        expect(result.element.classList.contains('segmented')).toBe(true);
        expect(result.element.getAttribute('role')).toBe('group');
        expect(result.element.getAttribute('aria-label')).toBe('Test toggle');
        const buttons = result.element.querySelectorAll('button.segmented__option');
        expect(buttons.length).toBe(2);
        buttons.forEach((btn) => {
            expect(btn.getAttribute('type')).toBe('button');
            expect(btn.getAttribute('aria-pressed')).toBe('false');
        });
        result.setActive('b');
        const second = buttons[1];
        expect(second?.getAttribute('aria-pressed')).toBe('true');
    });

    it('preact `ToggleGroup` in BudgetOverview renders the canonical `.segmented` DOM shape', () => {
        // The preact `ToggleGroup` lives in `BudgetOverview.tsx` as a small
        // local helper so the surface can stay declarative; it must produce
        // the same DOM the imperative builder does. Verify via source text
        // rather than mounting the entire BudgetOverview, since the chip-rebind
        // suite already does the full mount and the shape check is the only
        // thing this assertion cares about.
        const source = fs.readFileSync(
            path.join(SETTINGS_UI_SRC, 'ui', 'views', 'BudgetOverview.tsx'),
            'utf8',
        );
        // `<div class="segmented" role="group" …>` is the canonical container.
        expect(source).toMatch(/<div\s+class="segmented"\s+role="group"/);
        // Buttons carry `.segmented__option` + `aria-pressed`.
        expect(source).toMatch(/class="segmented__option"/);
        expect(source).toMatch(/aria-pressed=\{value === opt\.value\}/);
    });

    it('device-detail overshoot segmented carries `.segmented` only (no panel modifier)', () => {
        const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
        const segmented = doc.querySelector('#device-detail-overshoot-segmented');
        expect(segmented).not.toBeNull();
        expect(segmented?.classList.contains('segmented')).toBe(true);
        // No `.segmented--…` modifier should ride along — the per-panel grid
        // layout lives on `#device-detail-panel .segmented` instead.
        segmented?.classList.forEach((cls) => {
            expect(cls.startsWith('segmented--')).toBe(false);
        });
        expect(segmented?.getAttribute('role')).toBe('radiogroup');
    });
});
