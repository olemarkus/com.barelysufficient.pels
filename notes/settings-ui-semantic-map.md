# Settings-UI Semantic Map (consolidation foundation)

The canonical role/naming map every page composes. Approved 2026-05-30.

## North-star principles (CSS *and* JSX)

1. **Consistency across pages beats preserving any page's current styling.** Migrating a surface
   means stripping its divergent overrides onto the canonical role; small look changes are expected.
2. **Divergence is a smell — consider WHY.** Prefer a structural fix (split a crowded card into
   several canonical cards) over bespoke styling.
3. **Reuse shared classes AND shared Preact components; never invent bespoke per-page ones.**
4. **Semantic naming, not page-based.** `.entity-name`, `<Card>`, `<Hero>` — never
   `.price-aware-grid__name`, `PlanHero`-only markup. The ~274 page-scoped BEM blocks
   (`plan-*`, `usage-*`, `budget-*`, `deadline-*`) are the anti-pattern to unwind.
5. A given *kind* of element resolves to **one** app-wide role/component, decided once here and
   applied everywhere — not guessed per surface.

## Text atoms → canonical role → shared class

Each maps onto a merged `.pels-text-*` role (PR #1312). The shared semantic class applies the role
class; page blocks keep only structural props (layout/padding/border), and their bespoke
font/colour/transform is deleted.

| Element kind | Canonical role | Shared class |
|---|---|---|
| entity / device name | `answer` (md + semibold + primary — a prominent identifier) | `.entity-name` |
| card / surface title | `card-title` | `.pels-text-card-title` |
| section header / heading / headline | `section-headline` | `.pels-text-section-headline` |
| metric value / stat / target value | `answer` (large readings: `display`) | `.pels-text-answer` / `.pels-text-display` |
| field / metric / step / cell label | `caption` | `.metric-label` |
| summary text | `body` (or `supporting` when secondary) | `.pels-text-body` |
| status line | `status-line` | `.pels-text-status-line` |
| hint | `caption` | `.pels-text-caption` |
| subline | `supporting` | `.pels-text-supporting` |
| settings row label | `settings-label` | `.pels-text-settings-label` |
| settings row trailing value | `settings-trailing` | `.pels-text-settings-trailing` |

The "Shared class" column is the **live, defined** selector for each atom.
`.entity-name` and `.metric-label` are the two dedicated semantic aliases that
exist today (each composes its `--pels-text-{role}` token bundle); the rest apply
the `.pels-text-{role}` role utility directly until a dedicated alias is added.
Refine as surfaces hit edge cases; record the decision here so it stays
one-per-kind.

## Structural components → shared Preact component

Page-based card/hero/row markup collapses onto shared components that bake in the canonical
surface + composition. JSX views import these; bespoke per-page structure is deleted.

| Structure | Shared component | Built on |
|---|---|---|
| any card-shaped surface | `<Card tone? interactive?>` | `.pels-surface-card` + `data-tone` (exists) |
| page hero / summary banner | `<Hero>` | canonical hero primitive |
| labelled metric / stat | `<Metric label value>` | `.metric-label` + `.pels-text-answer` / `.pels-text-display` |
| device / entity row | `<DeviceRow>` | converge the imperative `buildRedesignDeviceRow` (`devices.ts`) + the Preact `DeviceRow` (`PriceAwareDevicesView.tsx`) |
| chip | `<Chip tone>` | `.plan-chip` tonal primitive |
| segmented / toggle-group filter | `<SegmentedControl>` | `.segmented` primitive |

## Execution

- One surface (or one shared primitive) per PR, screenshot-gated (render-gate harness, real mobile
  dark theme) judged on convergence + consistency, **not** pixel-identity.
- Land the shared class/component, migrate its consumers, delete the page-based block + bespoke CSS.
- Retire imperative `createElement` builders to JSX as their surfaces migrate; then extend the
  no-imperative-DOM lint (see consolidation charter).
- Naming: introduce the semantic class/component name; the page-based block name is removed once
  its last bespoke prop is gone.
