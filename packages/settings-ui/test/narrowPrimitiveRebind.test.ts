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
 *     primitives. After the batch 11 card-primitive consolidation, the
 *     canonical card primitive is `.pels-surface-card`; every per-page
 *     card class (`.plan-card`, `.deadline-list-card`, `.plan-history-
 *     card`, `.detail-diagnostics-card`, `.usage-card`, etc.) chains it
 *     on the host and inherits the `--md-elevation-level: 1` resting
 *     contract from a single declaration site. Per-surface raw
 *     `box-shadow` declarations must either use a shared `var(--shadow-*)`
 *     token (so elevation language stays unified) or be the narrow class
 *     of 1-3 px contrast outlines (focus rings, tick markers, inset
 *     borders) that decorate a single element rather than lift a surface.
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
        expect(source).toMatch(/class="segmented__option hy-nostyle"/);
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

// ─── Phase 5: Ripple ─────────────────────────────────────────────────────────

describe('ripple primitive: `<md-ripple>` is the single source of truth', () => {
    it('exposes `MdRipple` via the shared materialWebJSX wrapper', () => {
        const source = fs.readFileSync(
            path.join(SETTINGS_UI_SRC, 'ui', 'views', 'materialWebJSX.tsx'),
            'utf8',
        );
        expect(source).toMatch(/export const MdRipple\s*=/);
        expect(source).toContain("h('md-ripple'");
    });

    it('every JSX consumer imports MdRipple from materialWebJSX (not re-wraps it)', () => {
        // Allow the wrapper itself to declare MdRipple; every other surface
        // must import it. Catches an accidental local `const MdRipple = …`
        // re-declaration that would silently fork the props contract.
        const offending: string[] = [];
        SOURCE_FILES.forEach((file) => {
            if (file.endsWith('materialWebJSX.tsx')) return;
            const text = fs.readFileSync(file, 'utf8');
            const declarations = text.match(/(?:const|let|function)\s+MdRipple\b/g) ?? [];
            if (declarations.length > 0) {
                offending.push(`${file}: ${declarations.join(', ')}`);
            }
        });
        expect(
            offending,
            `MdRipple re-declared outside materialWebJSX:\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('every MdRipple JSX call site uses only `aria-hidden="true"` (no divergent props)', () => {
        // Audit every `<MdRipple … />` invocation and confirm it carries the
        // canonical `aria-hidden="true"` flag — no surface-specific props
        // (`attached`, custom colour overrides, event handlers) that would
        // fork the consumer contract.
        const offending: string[] = [];
        SOURCE_FILES.forEach((file) => {
            if (file.endsWith('materialWebJSX.tsx')) return;
            const text = fs.readFileSync(file, 'utf8');
            const matches = text.match(/<MdRipple[^/>]*\/?>/g) ?? [];
            matches.forEach((match) => {
                // Strip whitespace then expect exactly: <MdRipple aria-hidden="true" />
                const normalized = match.replace(/\s+/g, ' ').trim();
                if (normalized !== '<MdRipple aria-hidden="true" />') {
                    offending.push(`${file}: ${normalized}`);
                }
            });
        });
        expect(
            offending,
            `MdRipple call sites with divergent props:\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('every raw `<md-ripple>` markup site uses only `aria-hidden="true"` (no divergent attrs)', () => {
        // Mirror the JSX rule for plain HTML — settings/index.html is allowed
        // to use `<md-ripple>` directly (no preact wrapper for the static
        // panels) but must carry the same canonical attribute shape.
        const offending: string[] = [];
        const matches = INDEX_HTML.match(/<md-ripple\b[^/>]*\/?>/g) ?? [];
        matches.forEach((match) => {
            const normalized = match.replace(/\s+/g, ' ').trim();
            // Accept either self-closing or paired tag opener; reject any
            // attribute other than aria-hidden="true".
            const acceptable = /^<md-ripple\s+aria-hidden="true"\s*\/?>$/.test(normalized);
            if (!acceptable) {
                offending.push(`index.html: ${normalized}`);
            }
        });
        expect(
            offending,
            `raw <md-ripple> markup with divergent attrs:\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('does not declare a competing `.ripple` / `.has-ripple` shell in style.css', () => {
        // The state-layer ripple is supplied by `<md-ripple>` (shadow DOM).
        // A bespoke `.ripple` / `.has-ripple` class would mean the primitive
        // has been forked back into a custom CSS-only equivalent — exactly
        // the duplication this consolidation set out to retire.
        const lines = STYLE_CSS.split('\n');
        const offending = lines.filter((line) => /^\s*\.(has-)?ripple(\s*\{|\s*,|\s+[a-z[])/.test(line));
        expect(
            offending,
            `unexpected custom ripple shell(s):\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('shares the ripple-tint tokens on the canonical card shell', () => {
        // The ripple's hover / pressed colour comes from `--md-ripple-*-color`
        // declared on the canonical card surface `.pels-surface-card`. After
        // the batch 11 card-primitive consolidation, the joint
        // `.plan-card, .pels-surface-card { … }` rule was split so the
        // canonical primitive owns the visual contract on its own; every
        // `.plan-card` consumer now chains `.pels-surface-card` on the host
        // and inherits the same ripple-tint tokens through that cascade.
        // Declaring the tint on every per-page card class instead would
        // mean each surface re-picks its ripple colour, drifting over time.
        expect(STYLE_CSS).toMatch(
            /\.pels-surface-card\s*\{[^}]*--md-ripple-hover-color/,
        );
        expect(STYLE_CSS).toMatch(
            /\.pels-surface-card\s*\{[^}]*--md-ripple-pressed-color/,
        );
    });
});

// ─── Phase 6: Elevation ──────────────────────────────────────────────────────

describe('elevation primitive: `<md-elevation>` is the single source of truth', () => {
    it('exposes `MdElevation` via the shared materialWebJSX wrapper', () => {
        const source = fs.readFileSync(
            path.join(SETTINGS_UI_SRC, 'ui', 'views', 'materialWebJSX.tsx'),
            'utf8',
        );
        expect(source).toMatch(/export const MdElevation\s*=/);
        expect(source).toContain("h('md-elevation'");
    });

    it('every JSX consumer imports MdElevation from materialWebJSX (not re-wraps it)', () => {
        const offending: string[] = [];
        SOURCE_FILES.forEach((file) => {
            if (file.endsWith('materialWebJSX.tsx')) return;
            const text = fs.readFileSync(file, 'utf8');
            const declarations = text.match(/(?:const|let|function)\s+MdElevation\b/g) ?? [];
            if (declarations.length > 0) {
                offending.push(`${file}: ${declarations.join(', ')}`);
            }
        });
        expect(
            offending,
            `MdElevation re-declared outside materialWebJSX:\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('every MdElevation JSX call site uses only `aria-hidden="true"`', () => {
        const offending: string[] = [];
        SOURCE_FILES.forEach((file) => {
            if (file.endsWith('materialWebJSX.tsx')) return;
            const text = fs.readFileSync(file, 'utf8');
            const matches = text.match(/<MdElevation[^/>]*\/?>/g) ?? [];
            matches.forEach((match) => {
                const normalized = match.replace(/\s+/g, ' ').trim();
                if (normalized !== '<MdElevation aria-hidden="true" />') {
                    offending.push(`${file}: ${normalized}`);
                }
            });
        });
        expect(
            offending,
            `MdElevation call sites with divergent props:\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('every raw `<md-elevation>` markup site uses only `aria-hidden="true"`', () => {
        const offending: string[] = [];
        const matches = INDEX_HTML.match(/<md-elevation\b[^>]*>/g) ?? [];
        matches.forEach((match) => {
            const normalized = match.replace(/\s+/g, ' ').trim();
            const acceptable = /^<md-elevation\s+aria-hidden="true"\s*>?$/.test(normalized);
            if (!acceptable) {
                offending.push(`index.html: ${normalized}`);
            }
        });
        expect(
            offending,
            `raw <md-elevation> markup with divergent attrs:\n${offending.join('\n')}`,
        ).toHaveLength(0);
    });

    it('canonical card surface drives elevation via `--md-elevation-level` tokens', () => {
        // `.pels-surface-card` is the canonical card primitive after the
        // batch 11 card-primitive consolidation (chip / hero / button
        // pattern: one shell, decorators on top). The resting elevation
        // level is `1`; hover / focus lifts to `3`; active settles at
        // `2`. The cascade flows through both `.plan-card:hover` (legacy
        // device-row alias, still alive because the markup wires
        // `role="button"` + `tabindex` rather than `data-interactive`)
        // and `.pels-surface-card[data-interactive]:hover` (new opt-in
        // for clickable link cards). Verify the cascade is still
        // expressed as token mutations rather than raw `box-shadow`
        // declarations — otherwise the MD elevation language drifts
        // away from the surrounding surfaces.
        expect(STYLE_CSS).toMatch(/\.pels-surface-card\s*\{[^}]*--md-elevation-level:\s*1/);
        expect(STYLE_CSS).toMatch(/\.plan-card:hover[\s\S]*?--md-elevation-level:\s*3/);
        expect(STYLE_CSS).toMatch(/\.plan-card:active[\s\S]*?--md-elevation-level:\s*2/);
    });

    it('every `box-shadow` declaration uses a shared token, `none`, or a small contrast outline', () => {
        // Scan every `box-shadow:` line and bucket it:
        //   1. `var(--shadow-…)`        — token-backed elevation (canonical)
        //   2. `none`                   — explicit reset (allowed)
        //   3. `inset … 1px var(--…)`   — 1 px inset hairline border (allowed)
        //   4. `0 0 0 {1,2,3}px …`      — 1-3 px contrast / focus ring (allowed)
        //   5. `0 0 4px 0 var(--…)`     — chart-tone glow, single-element decoration (allowed)
        //   6. anything else            — RAW elevation that should become a
        //                                 token (fail the assertion)
        //
        // We accept the contrast-outline class because outlines on chart
        // ticks / focus rings genuinely aren't "card elevation" — they're
        // 1-3 px borders implemented via box-shadow so they can sit outside
        // the element's flow. The assertion's job is to catch a fresh
        // `box-shadow: 0 4px 12px rgba(…)` slipping in on a card surface.
        const lines = STYLE_CSS.split('\n');
        const offending: { line: number; text: string }[] = [];
        lines.forEach((line, i) => {
            // Skip @media / comment lines via the leading regex anchor.
            const match = line.match(/^\s*box-shadow:\s*(.+?);?\s*$/);
            if (!match) return;
            const value = (match[1] ?? '').trim();
            if (value === 'none' || value === 'none !important') return;
            if (/^var\(--shadow-[a-z-]+\)/.test(value)) return;
            // Inset 1 px hairline: `inset 0 0 0 1px var(--…)` or
            // `inset 0 1px 0 …` (top-edge highlight).
            if (/^inset\s+0\s+(?:0\s+0\s+)?1px\s+/.test(value)) return;
            // 1-3 px contrast / focus outline: `0 0 0 {Npx} {colour}`.
            if (/^0\s+0\s+0\s+(?:0?\.5|1|2|3)px\s+/.test(value)) return;
            // Chart-tone glow: `0 0 4px 0 var(--pels-chart-hour-tone-glow)`.
            if (/^0\s+0\s+4px\s+0\s+var\(/.test(value)) return;
            offending.push({ line: i + 1, text: line.trim() });
        });
        expect(
            offending,
            `raw box-shadow declarations that should use a token or be tagged contrast-outline:\n${
                offending.map((o) => `  style.css:${o.line}: ${o.text}`).join('\n')
            }`,
        ).toHaveLength(0);
    });
});
