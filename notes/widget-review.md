# Widget review (dashboard widgets) — 2026-05-30

Review of the five shipped dashboard widgets against: (1) intuitive/headers,
(2) persona fit, (3) visual appeal/consistency, (4) Homey widget best practice.
Sources: a dark-mode dashboard screenshot of all five stacked, the widget
configs/CSS, [Homey widget styling guidelines](https://apps.developer.homey.app/the-basics/widgets/styling),
`notes/personas.md`, `notes/ui-terminology.md`. **Reconciled with pels-m3-critic
+ pels-ux-fit + pels-copy-and-terminology** (they corrected two findings in the
first inline pass — noted inline below).

Widgets (compose `name`): `create_smart_task` → **New smart task**; `headroom` →
**Available power**; `plan_budget` → **Budget and Price**; `smart_tasks` →
**Smart tasks**; `starvation_rescue` → **Get power now** (renamed → **Held-back devices**).

> **Status: SHIPPED (widget-polish train, 2026-05-30).** All five findings areas
> were addressed across PRs #1313–#1317 (enforcement #1305). See
> [§ Shipped](#shipped-widget-polish-train-2026-05-30) at the foot of this doc for
> the finding → PR mapping and what was deliberately deferred. The body below is
> the original review, kept as the record.

## Verdict

Cohesive, honest, dark-mode-clean, and shippable — every widget has a real job
and the names are truthful. But "refinements, not breakage" (the first pass) was
too generous for a desirability train that named personas 4/5/6 as the target:
two of the five quietly underserve the persona they were built for, two passive
widgets break the UI-text-matches-logs contract, and the densest widget (the
budget chart) is the hardest to read. None block, but they're more than polish.

## Findings (reconciled, by priority)

### P1 — Budget & Price serves the tinkerer, not the optimiser (persona 4) — and is the hardest tile to read
- **Persona miss** (ux-fit): the payload (`planPriceWidgetTypes.ts`) carries
  `plannedKwh`/`actualKwh`/`priceSeries` but **no cost, no projected total, no
  kr figure, no avg price**. Persona 4's two questions ("did it pick cheap hours
  / what will it cost") are answerable only by integrating a red line over green
  bars across 24 buckets; glance personas (1/2) get no "where will I land." A
  budget widget that shows *no money* is the single biggest miss in the set.
  → Add a one-line summary above the chart: projected kWh + projected **kr** +
  on-track/over tone. `Σ priceSeries[i] × plannedKwh[i]` is already in the payload
  (renderer+copy, no new plumbing).
- **Chart density** (m3-critic): at 320–360 px the ~24 plan bars are edge-to-edge
  with no gap → reads as one solid green wall; the blue actual-dots are low
  contrast against it; the red price line competes in the same band. The core
  comparison the widget exists for is the hardest thing to see. → Thin to ~12
  bars or add a hairline gap; lift actual-dot contrast. Also label the dual
  y-axes (right axis "73–86" is a mystery number — likely øre/kWh).

### P1 — Available power: the unlabeled `2.6 / 4.9 kW` pair (and DON'T call 4.9 "Hard cap")
The two numbers carry no labels, so the user can't tell which is which. **Correction
to the first pass:** the right number is `hourlyLimitKw` = **Safe pace now**, NOT
**Hard cap** (the fixed user ceiling `hardLimitKw` is a *different* value — see
`notes/ui-terminology.md`, which keeps Safe pace / Hard cap / Safety margin
distinct). Labeling 4.9 as "Hard cap" would misrepresent a dynamic pacing limit
as the breaker/tariff ceiling.
→ Label the pair with the canonical hero words: **Power now 2.6 kW · Safe pace
4.9 kW**, `2.3 kW available` as the gap; fix the aria-label too ("Current draw …
of …" → "Power now … / Safe pace …").

### P1 — Passive widgets bypass the shared-domain copy contract (UI text must match logs)
`smart_tasks`, `starvation_rescue`, `create_smart_task` correctly source copy
from `packages/shared-domain/**` (so UI strings match runtime logs —
`feedback_ui_text_shared_with_logs`). The two read-out widgets **hardcode** theirs:
- `headroom` (`render.ts`): `cheap/normal/expensive`, `N kW available`, `N paused`, `No data yet`, the aria summary.
- `plan_budget` (`chart.ts`): `Budget and Price`, `No plan data available`, `Price data missing`, legend `Plan/Actual/Price`, aria-label.
→ Lift into `HEADROOM_WIDGET_COPY` / `PLAN_PRICE_WIDGET_COPY` shared-domain consts
(or reuse existing price-level helpers), like the other three.

### P2 — "Starved · N min" chip uses internal jargon
`packages/shared-domain/src/planStarvation.ts:79` renders **`Starved`** on the
row chip — contradicting the same widget's user-facing empty state ("No device is
being **held back**"). "Starved" isn't in the vocabulary guide. → `Held back` /
`Waiting`. Caveat: it's in shared-domain (doubles as a log breadcrumb), so rename
the helper + check log-parity expectations before changing.

### P2 — "Get power now" header vs its (healthy) empty state
Action-promising header over a passive `No device is being held back right now`,
in a **fixed 240 px** card that reserves a tall slab for one muted line. The empty
copy is good (calm, persona-6-appropriate) — keep it. → State-neutral header
("Held-back devices") with "Get power now" as the CTA only when a device IS
starved; make the healthy state compact (Homey widgets can be height-adaptive).

### P2 — Inconsistent `--homey` fallback values across widgets (the real "best-practice" defect)
**Correction to the first pass:** the hex are all `var(--homey-*, #fallback)`
fallbacks (zero naked hex), so light/dark IS handled by Homey's tokens at runtime
— the blanket "hardcoded hex won't adapt" concern was wrong. The real defect:
`--homey-text-color-success` falls back to `#2f8f47` in create_smart_task +
smart_tasks but `#58c56a` (the *fill* green, low-contrast as text) in headroom +
the smart_tasks chip. If a token ever resolves empty, "success" renders two
different greens. → Pick one fallback per semantic; use the darker text value for
text-on-tint. (Files: `headroom/public/index.css:100`, `smart_tasks:153` vs the
`#2f8f47` group.)

### P2/P3 — Smaller items
- **Get power now + Smart tasks bottom dead space** (P2, m3-critic): fixed 240 px,
  single-row content → two tiles read bottom-heavy. Height-adaptive would help.
- **EV picker row shows a bare `%`** (P3, ux-fit): `Elbillader` shows `%` with no
  value while temp rows show `Now 54.3 °C`. Reads as a glitch — say `SoC unknown`.
- **"Plan / Actual" legend opacity** (P3, copy): not a terminology violation
  ("plan" is the correct planning-layer word, not a deadline feature), but `Plan`
  next to `Actual` is opaque — consider `Budget` / `Used` to match hero vocab.
- **`plan_budget` token-namespace divergence** (P3, m3-critic): defines its own
  `--pels-*` layer + a hardcoded `.homey-dark-mode` block while the other four
  consume `--homey-*` directly — two theming strategies in one set.
- **`--homey-su` vs `--homey-su-1` typo** (P3, m3-critic): `headroom/index.css:24`
  uses `var(--homey-su, 4px)` (no `-1`); verify `--homey-su` is a real token.

## Best-practice enforcement (lint) — SHIPPED (PR #1305)
`stylelint-declaration-strict-value` with a `widgets/**` override (`ignoreFunctions:
false`): requires `var()` on `color`/`*-color`/`fill`/`stroke`/`background`; bans
bare `#hex`/`rgb()`/`hsl()`; allows `var(--homey-*, #fallback)` and `color-mix()`
ONLY when it contains a `var()` (regex `/color-mix\(.*var\(/`). (A blanket
`color-no-hex` was wrong — it'd flag the legitimate fallbacks.) Known limits, both
tracked as follow-ups: `border`/`outline` *shorthands* can't be linted (the plugin
flags their `1px`/`solid` tokens — use longhand `border-color`/`outline-color`,
which IS enforced); literal-colour *custom-property aliases* (`--pels-x: #fff`) aren't
checked (all current `--pels-*` aliases are token-backed, so theoretical — codex
F3K_S). The inconsistent-fallback-value defect (P2) is a separate manual fix.

## Fresh render — at-limit / empty / expanded states (2026-05-30, m3-critic + ux-fit)
A second screenshot in different data states (Available power AT LIMIT 6.3/6.3, full
red bar; create widget EMPTY "No eligible devices"; Smart task EXPANDED with the
`≈3h 34m · 1.3 kW · ≈3.9–4.5 kWh` recap line) confirmed the open items and surfaced new ones:

- **P0 (escalated from P1) — Budget chart reads as a solid green wall / broken render.**
  In the populated 24-bucket state the bars (`barWidth = stepWidth*0.72`) collapse to one
  green block; blue actual-dots invisible inside it; red price line draws as a floating
  rectangle with no scale anchor. It's the tile that makes a glancing user think the
  widget is malfunctioning — and it sits directly under the at-limit red bar (two unrelated
  reds stacked). Fix first: ~12 buckets / wider gap; outline the actual dots; tame + label
  the price line.
- **P1 (new) — At-limit red bar reads as an error, not "pacing at the ceiling."** Full-width
  flat red + red "0 kW available" + no state label → looks like a fault when the system is
  working correctly. Add an explicit "At the limit / pacing at ceiling" label; consider
  amber for "at-limit-but-managed", reserve red for above-hard-cap; make the danger red
  distinct from the chart's price red.
- **P1 (new) — Surface is flat/joyless with no focal point + empty-tile dead space.** Five
  near-identical dark cards; the only colour energy comes from the two error-looking
  elements. Make healthy/empty states height-adaptive; give one tile a deliberate focal
  treatment.
- **P2 (new) — `← Connected 300` back-arrow on the Smart-tasks tile** reads as leaked
  navigation chrome — a dashboard tile isn't a nav stack, the arrow has no target. Drop it
  on the dashboard surface (or make it an explicit affordance).
- **P1/P2 (new) — Dense recap line `≈3h 34m · 1.3 kW · ≈3.9–4.5 kWh`** is the densest + dimmest
  copy in the set (3 unit systems, 2 `≈`, a range, at metadata contrast). The banded range
  is intentional (keep), but split power/energy to the detail view or lift contrast + label.
- **P2 (new) — Empty states don't share one language**: create centers a heading+sub;
  rescue left-aligns one muted line. Unify the empty-state pattern.
- **P2 (new) — create empty-state inverted hierarchy**: "No eligible devices" is largest,
  the actually-useful instruction ("Add a thermostat…") is dimmest/smallest. Promote the
  instruction. (Otherwise this is the best empty state — clear, non-error.)
- Re-confirmed live: unlabeled `6.3/6.3 kW` pair (→ Power now / Safe pace), unlabeled dual
  y-axes (left kWh, right øre/kWh), no money figure in Budget, shared-domain copy gap,
  success-fallback inconsistency.

## Owner direction (2026-05-30) — highest signal
The product owner reviewing the render, in their words + the code reality:
- **Budget chart: "too cluttered, needs a refresh" + labels.** Confirms P0. Not just
  de-densify — a genuine viz rethink (fewer/aggregated bars or a different form),
  labeled axes (kWh + øre/kWh), and the money/projected summary.
- **"Get power now" — the OWNER doesn't understand it** ("magically conjure more power
  to the whole house?"). This is the key finding: the NAME creates the wrong mental
  model. The widget (`starvation_rescue`) does NOT get/create power — PELS can't (the
  hard cap is physical). It RELEASES one device that PELS has been holding back due to
  the daily BUDGET, by exempting that device from the budget so it runs now. So the name
  overpromises twice (house-level + "get power"). → Rename to a device-scoped, honest
  frame: **"Held-back devices"** (matches the empty copy) with a per-device "Let it run
  now / Release" action only when something is held back. P0/P1 (owner-confirmed
  comprehension failure).
- **"New smart task" shows only some devices, "seemingly random order."** Reality:
  (1) Subset = `latestTargetSnapshot.filter(isRuntimePlannedDevice)` → PELS-MANAGED
  devices only (a smart task is a deadline on a managed device) — correct, but NOT
  explained in the UI, so the user can't tell why these and not their other Homey
  devices. Add a one-line "managed devices" framing/eligibility hint. (2) Order =
  `createSmartTaskWidgetPayload.ts:51` `localeCompare(deviceName)` → alphabetical by
  name. Not random, but feels random across heterogeneous names (model numbers/brands).
  → Order by device TYPE (group thermostats / water heaters / EV) or by room/zone, and
  show a type icon, so the list reads intentionally.

## What's already good (keep)
- `--homey-*` tokens + `.homey-*` classes throughout + both preview images.
- Consistent dark cards, green accent, 48 px touch rows; honest naming.
- `Smart tasks` "On track · Ready by 16:00" with whyLabel/planMeta deliberately
  deferred to the interactive detail (correct progressive disclosure).
- `Get power now` never suggests raising the hard cap (`feedback_hard_cap_is_physical`).
- Numbers reconcile (Available power: 4.9 − 2.3 = 2.6 exact).

## Shipped (widget-polish train — 2026-05-30)

Five PRs, one per surface. Each ran the relevant `pels-*` lens + Codex review;
bot findings (incl. several genuine bugs, noted below) were fixed in-PR.

| PR | Surface | Shipped |
|----|---------|---------|
| #1313 | `starvation_rescue` → **Held-back devices** | Owner-confirmed rename (the old "Get power now" implied conjuring house power; the widget only releases one budget-held device). Per-device **Let it run now**. Codex caught that the `Held back · N min` chip was stamped on every cause; made it cause-specific (**Held back** = budget/releasable, **Waiting** = capacity/external/physical, **On hold** = manual) so it never overclaims against the hard-cap-is-physical rule. |
| #1314 | `smart_tasks` tile | Dropped the leaked `←` back-arrow nav chrome; recap line led with an **Estimate** label + lifted to full contrast (label sourced from `deadlineLabels.ts`, not inlined). |
| #1316 | `plan_budget` **Budget and Price** (the P0) | Interactive **AM/PM tabs** (≈12 bars/view) kill the green-wall render; labeled dual axes (kWh + the scheme's rate unit); **projected kWh + kr + on-track/over** summary; de-cluttered bars + haloed actual-dots + tamed price line. Codex/bot fixes: projection now uses **actual-to-date + planned-remainder** (no more "On track" after the budget is already blown); AM/PM split by **local hour** (DST 23/25-hour-safe); partial-price-horizon **cost suppression**; rate-suffix strip so a total reads `kr` not `kr/kWh` (spaced `NOK / kWh` too); controller `destroyed` guard against late async renders. |
| #1317 | `headroom` **Available power** | Labeled the pair **Power now / Safe pace now** (canonical; the right number is the dynamic hourly threshold, *not* the fixed hard cap); amber **At safe pace** state for at-limit-but-managed, red reserved for **Over hard cap**; lifted all strings into `headroomWidgetCopy.ts`; unified the `--homey-text-color-success` fallback; `--homey-su-1` typo fix. Codex caught a **production-breaking** missing `bundleApi: true` (the API couldn't load the shared-domain value import — MODULE_NOT_FOUND) — fixed. |
| #1315 | `create_smart_task` picker | Grouped by device family with type icons + a **managed-devices eligibility** caption; promoted the empty-state instruction. **Owner decision:** the runtime normalizes every device class into a fixed set with no water-heater class (a Høiax water heater arrives as `heater`), so water heaters can't be distinguished from thermostats — collapsed to **Heating + EV chargers** (kind-based, always correct) rather than ship a never-populated water-heater group. |
| #1305 | lint enforcement | `stylelint-declaration-strict-value` + `widgets/**` override (shipped ahead of the train). |

### Deliberately deferred (tracked in `TODO.md`)
- **EV picker row bare `%`** (P3) — show `SoC unknown` when no value.
- **`plan_budget` `--pels-*` namespace divergence** (P3) — ~~it defines its own token layer + a `.homey-dark-mode` block while the other four consume `--homey-*` directly.~~ RESOLVED 2026-05-31 (widget token-strategy train): all five widgets now share `widgets/_shared/widget-tokens.css` (`--pw-*`, composed only from Homey base tokens); plan_budget's local layer + dark-mode block retired onto the sibling translucent-tint recipe, enforced by a stylelint font-token guard.
- **Flat-surface / height-adaptive / one focal tile** (P1-new from the fresh render) — the chart refresh + amber at-limit added some colour energy, but the five-near-identical-dark-cards gestalt and the fixed-240 px dead space on passive tiles were not tackled.
- **Device-detail diagnostics still says "Starved"** — `notes/ui-terminology.md` records this as a deliberate advanced-surface fork vs the widget's "Held back"; decide explicitly later (own TODO item).
- **`settings.test.ts` full-suite flake** — "renders devices with target temperature capabilities" fails intermittently under full-suite load (passes in isolation); cost three pre-push retries this train. Own TODO item.
