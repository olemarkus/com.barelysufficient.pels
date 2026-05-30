# Settings-UI Design-System Unification

Charter for the multi-PR train that kills design fragmentation in `packages/settings-ui`.
Driven via the PR-lifecycle workflow. Status lives in `TODO.md`; this doc is the *why* and the *target shape*.

## The problem

Every page invents its own cards and its own typography because there is nothing shared to
reuse. Measured on `public/style.css` (2026-05-30):

- 274 BEM blocks / 641 class names for a single ≤480 px webview.
- **18 distinct card blocks**, 6 hero blocks, 3 chip families, 3 button families.
- **119 raw `font-size:` + 75 raw `font-weight:`** hand-rolled declarations — half the typography
  ignores the semantic `--pels-text-*` token layer that already exists (used only 75×).
- The same surface colour is written three ways for one value:
  `--color-surface-2` ≡ `--panel` ≡ `--pels-surface-container-low`.

Two things keep regenerating the divergence:

1. **Rendering** — Preact JSX views (the target) coexist with **12 imperative
   `document.createElement` builders**, which are where bespoke cards/fields get hand-rolled.
   Material Web (`md-*`) is a *sanctioned* third surface for interactive primitives per
   `AGENTS.md`; it stays. The fix is migrating the imperative builders to JSX, not removing MW.
2. **Tokens** — components reach past the semantic layer (`--pels-*`, `--color-role-*`,
   `--color-state-*`) into **base primitives** (`--color-base-*`, `--color-surface-N`). (The
   **41 `--pels-md-*`** aliases that theme Material Web through our tokens are *not* leakage —
   they are the required token bridge and stay.)
3. **Components** — none shared, so cards/heroes/type get reinvented per page.

## Target end-state

**One system:** Preact components backed by semantic tokens and a small set of canonical
classes; no imperative DOM; no base-token leakage. Material Web **stays** for interactive
primitives (buttons, ripples, elevation, switches, segmented, dialogs) per the settings-UI
`AGENTS.md` — styled through PELS tokens via the `--pels-md-*` shim, which is therefore *kept*,
not removed. Only the specific `md-outlined-*` form fields that render poorly in the dark theme
are swapped for native `<input>/<select>` + `.field` (already sanctioned guidance).

### Canonical card (18 → 1 base + ~4 modifiers)

`.pels-surface-card` is the single base (surface, border, radius, padding). State is a tonal
modifier, not a new block:

```html
<article class="pels-surface-card pels-surface-card--warning">
  <h3 class="pels-text-card-title">Budget at risk</h3>
  <p class="pels-text-supporting">Likely to exceed by 2.4 kWh</p>
</article>
```

Modifiers reuse the existing `color.state.*` vocabulary — `--positive`, `--warning`,
`--negative`, `--info` → mapped to `--color-state-*` bg/border/text (no new tonal vocabulary).
Page blocks (`plan-card`, `usage-card`, …) stop redefining surface/border/radius/type; they keep
only layout-specific internals, and ideally disappear in favour of the base + a component.

### Canonical typography (utility classes over the existing token bundles)

The `--pels-text-*` token bundles (card-title, body, caption, section-headline, supporting,
answer, …) already carry colour + size + weight + line-height. Expose them as thin utility
classes (`.pels-text-card-title`, `.pels-text-body`, …). Pages apply the class instead of
hand-setting `font-size` + `font-weight`. Delete the duplicated combos (e.g. `size:sm` +
`weight:semibold` is hand-rolled 63 + 51×).

### Delivered as Preact components

Canonical look ships as components (`<SurfaceCard variant>`, `<CardTitle>`, …), not loose
classes — JSX is the reuse and enforcement mechanism. Converting the 12 imperative
`createElement` builders to JSX is part of the consolidation, not a separate effort.

### Tokens: semantic only

Components must not reference base primitives directly. Surface ladder maps cleanly to M3:

| base (do not use directly) | semantic |
|---|---|
| `--color-surface-1` | `--pels-surface-container-lowest` |
| `--color-surface-2` | `--pels-surface-container-low` |
| `--color-surface-3` | `--pels-surface-container` |
| `--color-surface-4` | `--pels-surface-container-high` |
| `--color-surface-5` | `--pels-surface-container-highest` |
| `--color-surface-elevated` | `--pels-surface-elevated` *(to add)* |

`--color-base-*` colours map to `--color-role-*` / `--color-state-*-text` / the semantic aliases.

## Constraints

- **Maintained rulesets only — no hand-written lint rules.** The JSX-only / no-`createElement`
  ban *is* expressible with maintained tooling: ESLint's core `no-restricted-properties` /
  `no-restricted-syntax` (configured, not hand-written) can forbid `document.createElement` and
  other imperative-DOM calls. views/`AGENTS.md` already forbids imperative DOM there, so the lint
  can lock `src/ui/views/**/*.tsx` first (the exception in that doc — `useRef`/`useLayoutEffect`
  for Material Web property interop — is preserved). But the builders the charter is retiring live
  *outside* views/ (`src/ui/devices.ts`, `components.ts`, `deviceDetail/*.ts`, …), so the scope
  must **extend** to those files as each migrates to JSX, ending at all of `src/ui/**` except the
  sanctioned non-Preact orchestrators (e.g. `planRedesign.ts`). Each file joins the lint when its
  builder is migrated, so the rule lands green per step rather than warn-only.
- Visual migration PRs go through the screenshot / `pels-m3-critic` gate. Token/lint PRs do not.

## Plan

**Track A — Enforcement (maintained tooling, mechanical):**

1. ✅ `stylelint-value-no-unknown-custom-properties` — every `var(--x)` must exist
   (found + fixed 17 broken refs; shipped at error).
2. stylelint core `declaration-property-value-disallowed-list` — ban `var(--color-base-*)` and
   `var(--color-surface-N)` in colour/background/border (lands with B1+B2).
3. `stylelint-declaration-strict-value` — raw hex/px must be a token (warn-only baseline first).
4. `eslint-plugin-no-unsanitized` — kill `innerHTML` sinks.
5. `knip` — dead exports/files/deps.
6. `@projectwallace/css-analyzer` — CI metric baseline (unique colours / font-sizes / specificity)
   as a ratchet.

`lint:css` reads the committed `settings/tokens.css` (the shipped Style Dictionary output of
`tokens/*.json`) via `__dirname`, so the allow-list needs no build step and resolves from any CWD.

**Track B — Consolidation (refactor, per-PR screenshot gate):**

1. ✅ Surfaces pass: 74 `--color-surface-N` → `--pels-surface-container-*` (+ added `-lowest`).
   Value-preserving, no visual change. *(merged)*
2. Base-colours pass: 38 `--color-base-*` → role/state tokens; also map `--color-surface-elevated`.
3. Canonical `.pels-surface-card` + `--positive/--warning/--negative/--info` modifiers and
   `.pels-text-*` utility classes, delivered as Preact components (additive; no migration yet).
4. Migrate page-by-page (plan / usage / budget / deadlines / prices / devices / settings),
   deleting bespoke card/text CSS and converting imperative builders to JSX; extend the
   no-imperative-DOM lint to each migrated file (`views/**` first, then the converted
   `src/ui/*.ts` builders), ending at `src/ui/**` minus sanctioned orchestrators.
5. Swap the dark-theme-broken `md-outlined-*` form fields for native `<input>/<select>` + `.field`.
   Material Web otherwise **stays** for interactive primitives per `AGENTS.md`; the `--pels-md-*`
   token shim is kept (it is how Material Web is themed through PELS tokens).
