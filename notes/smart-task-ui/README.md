# Smart Tasks UI — Product Review

A product-level review of the Smart tasks surface (landing list, live
plan, history detail) based on a live-Homey walk through Connected 300
real data on 2026-05-16. Captures the design thinking behind the
discrete TODO entries that came out of the pass, so future contributors
can see *why* the punch list is shaped the way it is.

This note is intentionally analysis-shaped, not a checklist. The
per-item TODO entries (mine + the broader polish punch list landed in
`b1e67f31`, "TODO: capture smart-task UI polish punch-list + 9-unit
verification pass") are the executable side.

## Background

The Smart tasks surface has three primary pages:

1. **Landing tab** (`packages/settings-ui/src/ui/views/DeadlinesList.tsx`
   + `views/DeadlinesHistoryList.tsx` + `views/DeadlinePlanHistory.tsx`)
   — list of current tasks at the top, list of past tasks below.
2. **Live plan page** (`views/DeadlinePlan.tsx` +
   `deadlinePlan.ts` + `deadlinePlanHero.ts`) — per-device per-deadline
   hero + price horizon chart + plan inputs card.
3. **History detail page**
   (`views/DeadlinePlanHistoryDetail.tsx`) — outcome hero + plan-vs-plan
   comparison chart.

Each is wired to its own data source: live plan reads from the
active-plan recorder snapshot in
`SettingsUiBootstrap.deferredObjectiveActivePlans`; history reads from
the rolling 30-entry cap in `deferred_objective_plan_history`.

## The lived state at review time

The review walk hit a real-world scenario worth recording, because it
made the asymmetry the most important finding of the review:

- **Active task**: Connected 300, Target 65 °C by Sat 16:00, status
  `Cannot finish`. Hero said `Short by about 29.6 °C`. Chart still
  drew planned green bars in the cheapest remaining hours.
- **Past tasks (six visible)**:
  - Sat 16 May 06:00 — Succeeded with `Backup hours` pill *(future
    scope — the pill itself does not ship today; treat this row as the
    proposed UI shape, not the current one)*
  - Fri 15 May 16:00 — Missed
  - Fri 15 May 06:00 — Missed
  - Thu 14 May 16:00 — Missed
  - Thu 14 May 06:00 — Succeeded
  - Wed 13 May 16:00 — Succeeded, with progress line
    `29.3 °C → 77.7 °C · target 65.0 °C · reached at 11:57`

So this device had a 3-in-4 miss streak followed by a current Cannot
finish, plus an older success that overshot by 12.7 °C. Connected 300
is consistently failing this deadline pattern. The UI surface offers no
aggregate signal of that fact, and no detail-page postmortem to explain
it. The user has to infer from the chip column alone that something is
systematically wrong, and has no path to the cause.

## Thesis

> The Smart tasks UI today is shaped as a confirmation receipt for the
> set-and-forget user. The persona it underserves is the user who comes
> in distressed — pushed by a missed-deadline notification, or scanning
> a failing task. The fix is mostly small renderer-and-copy changes, but
> the framing matters: **failed runs deserve a different page shape than
> succeeded runs.**

The architecture and data are sound. The active-plan recorder, the
history recorder, the diagnostics bridge — all carry enough information
to compose one-sentence postmortems, cost estimates, miss-pattern
aggregates, and confidence explanations. The gaps are rendering and
copy.

## Personas

The six personas this review originally enumerated have been promoted
to a PELS-wide rubric — see [`notes/personas.md`](../personas.md). The
asymmetric-treatment thesis below (personas 5 and 6 are the highest-
emotional-intensity, least-served visitors) is the through-line that
the rest of this review builds on.

## What the data already supports

Most of the gaps are renderer-and-copy because the underlying data is
already captured:

- **Cost** — every hour carries `priceValue` (in display unit) and
  `deviceKwh`; `Σ priceValue × deviceKwh` is one number, derivable on
  both live and history surfaces today.
- **Postmortem for Missed** — the diagnostic stream carries
  `cannotMeetDailyBudgetExhausted`, `dailyBudgetExhaustedBucketCount`,
  shortfall, `objective_invalid_session`, abandoned-by-user. The
  postmortem sentence can be composed from these without a contract
  change. (A future polish adds `deliveredKWh` and `totalCost` to the
  entry to make this round-trip cheaper — see TODO upstream entry.)
- **Overshoot line on Succeeded** — `startProgressC`, `finalProgressC`,
  `targetTemperatureC` already on the entry. `finalProgressC - target
  > 5 °C` is a one-line resolver.
- **Picked-N-of-M caption** — `priceValue` + `planned` flag per hour
  give "PELS picked the N cheapest hours of the next M (avg P kr/kWh
  vs Q baseline)" trivially.
- **Miss-streak aggregate** — pure list aggregation over the past-task
  entries already loaded for the landing page.
- **Confidence chip tooltip** — the chip already exists on the hero;
  a popover with one-line explanation is pure rendering.

What needs *new* data (contract additions, tracked in upstream TODO):

- Per-revision reason list on the history entry (currently only count
  is persisted, not the reasons).
- `deliveredKWh` and `totalCost` aggregated on the history entry (so
  list rows can show them without re-deriving on every render).
- Per-hour `deliveredKWh` on the history entry (so planned-vs-delivered
  overlay bars replace today's binary observation scatter).

## Asymmetric treatment of failure

The single design move worth investing in: **failed tasks should render
a different page shape than succeeded tasks**.

| Section | Succeeded | Missed | Abandoned |
|---|---|---|---|
| Hero tone | ok (green) | warn (amber) | muted (grey) |
| H1 | `Connected 300 — Succeeded` | `Connected 300 — Missed` | `Connected 300 — Cleared` |
| Lead line | `Hit 65 °C at 11:57, 4h 03m before 16:00.` | `Reached 38 °C at 16:00 (target 65 °C, 27 °C short).` | `You cleared this at 04:12.` |
| Secondary | `Cost ≈ 4.20 kr · 7.2 kWh delivered.` | `Why: {reason}. Cost ≈ 3.10 kr partial.` | `2 of 4 planned kWh delivered by then.` |
| Plan chart | collapsed by default, "View plan" toggle | always expanded | collapsed |
| Next-step CTA | none | `Lower daily budget` / `Review device` (composed from reason) | none |
| Notable extras | overshoot line if delivered > target by > 5 °C / 10 % | revisions timeline if `revisionCount > 1` | — |

Pattern: succeeded = receipt; missed = diagnosis + CTA; abandoned =
log + minimal context. The diagnosis side is what the punch list builds
toward — postmortem sentence, cost, revisions log, and the recourse
path that already shipped as a P1 in upstream.

## Plan-change visibility is the weakest narrative

PELS *is* doing interesting work (re-planning when Nordpool publishes,
adjusting for learned rates) and the user *cannot see it happening*.

- Live page: changed hours render with a 1-px border on the device bar;
  revision reason text shows only in the per-hour tooltip — easy to
  miss, impossible on touch.
- History page: `Schedule updated N times.` line when `revisionCount > 1`
  and nothing else.
- Flow trigger: `deadline_plan_changed` fires when planned-hours count
  changes; no `reason_id` token.

The upstream commit adds "Show a real revision log on the History
detail page" which is the right move. Pair it with the same chip on the
live hero so the same trust signal lands in both surfaces.

## Cross-surface: vs Usage / Insights

Real overlap, no spelled-out relationship. Working boundary:

- **Usage / Insights** owns "how much energy did each device draw,
  broken down by time-of-use" (aggregate, time-window-based).
- **Smart tasks** owns "did each intent succeed, and at what cost"
  (per-objective, per-deadline).

The asymmetric link worth adding: from a Smart-task history detail to
the *same-day Usage chart for that device*. A user investigating "why
did this run miss?" benefits from seeing the device's whole-day
context. The reverse (Usage → Smart tasks) is noise — users on Usage
aren't asking task-shaped questions.

## Live vs history page parity

Two parities pull in different directions:

1. **Information parity** (history reaches back to match live). Today
   history is a subset; the existing TODO entry "Bring the smart-task
   history detail view to full live-plan chart parity" closes this.
   Worth noting: parity in *what is shown* should not mean parity in
   *what is emphasized*. Live = "what's next". History = "what
   happened." Same chart, different hero shape.
2. **Live-during-run history**. A user with an active task wants
   "what's been delivered so far?", not only "what's planned next?".
   The dotted "Measured Heating" line is the only acknowledgement and
   easy to miss. A "delivered so far" strip in the live hero closes
   this without re-shaping the chart.
3. **End-of-run transition**. The live → completed → history flow
   today is a hard jump (the `completed` short-circuit renders a thin
   "Smart task finished — See History" card). The cleaner shape is to
   *become* the history-detail page in place rather than redirecting.

## Why a v1 vs vNext split exists

Two release dynamics make a v1 vs vNext distinction matter for this
surface:

- The redesigned Settings UI is many users' first exposure to the new
  direction. P0 first-impression coherence is more valuable than P0
  feature completeness — a calm, coherent surface earns trust, a
  crowded one with new copy/charts/cost numbers risks confusion.
- The history detail's failure-investigation gap is real but mostly
  affects users who already trust PELS enough to investigate a miss.
  v1 users seeing a clean surface for the first time are less affected
  by it.

The v1 work therefore focuses on **data integrity** and **honesty**
(don't render a chart titled "Scheduled vs observed" when there are no
observations; don't render `Cannot finish` next to an `On track` chip).
The vNext work focuses on **trust signals** (cost, postmortem, picked-
N-of-M) that turn a fine surface into a trusted one.

See `TODO.md` for the discrete entries. The split (loosely):

- **v1 / next patch**: items that fix misleading current state — recorder
  null-progress regression; `Cannot finish` meta line restoring energy
  context; honest chart titles. Mostly already P1 in upstream.
- **vNext**: trust-signal additions — postmortem resolver, cost line,
  picked-N-of-M caption, delivered-so-far strip, miss-streak aggregate,
  cross-link to Usage. Mostly P1/P2.
- **Future**: design rethinks — fold detail into list, live→history
  in-place transition. P3.

## Related work

- `notes/deferred-load-objectives/README.md` — shared objective model,
  reason codes, status semantics.
- `notes/smart-task-flow-cards/README.md` — flow card design. Rule 4
  keeps notification-text composition in the user's flow; PELS does not
  emit a `notification_text` token on any trigger.
- `notes/ev-ready-by/README.md` — EV-specific UX slice, references this
  surface.
- `TODO.md` P0/P1 entries from commit `b1e67f31` cover the polish punch
  list (~50 items) that this review overlaps with substantially. The
  new entries this review adds are the ones whose framing depends on
  the personas/asymmetric-treatment thesis above.
