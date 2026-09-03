# Smart Tasks UI — Product Review

A product-level review of the Smart tasks surface (landing list, live
plan, history detail) based on a live-Homey walk through Connected 300
real data on 2026-05-16. Captures the design thinking behind the changes
that came out of the pass, so future contributors can see *why* the punch
list is shaped the way it is.

This note is intentionally analysis-shaped, not a checklist. It describes
the work; when each piece ships is not stated here. The broader polish
punch list from the same pass (~50 items, plus a 9-unit verification
pass) landed in commit `b1e67f31`.

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

The personas this review originally enumerated have been promoted
to a PELS-wide rubric — now four personas (Set-and-forget owner,
Orchestrator, Optimiser, Prosumer) plus cross-cutting scenarios
(Onboarding / Steady / Verifying / Failing) — see
[`notes/personas.md`](../personas.md). The asymmetric-treatment thesis
below (the Failing scenario — the panic deep-link and the recovering
visitor — is the highest-emotional-intensity, least-served case) is the
through-line that the rest of this review builds on.

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
  entry to make this round-trip cheaper.)
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

What needs *new* data (contract additions, none of them made yet):

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
   history is a subset; closing the gap means bringing the history detail
   view to full live-plan chart parity.
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

The work splits (loosely):

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
- The polish punch list (~50 items) filed from commit `b1e67f31` overlaps
  substantially with this review. What this review adds beyond it are the
  items whose framing depends on the personas/asymmetric-treatment thesis
  above.

## Addendum — 2026-07-26: creation and immediate intent

The Smart tasks destination in the settings UI is the aggregate place to
understand active and past tasks, but it cannot create one. Its first-run state
sends the user to a Flow action or the separate New smart task dashboard
widget. That split is no longer the target product shape: the Smart tasks page
should be a complete route for creating, inspecting, editing, and cancelling a
task.

Reuse the existing candidate-device, goal-bound, preview, and device-scoped
write paths. Do not introduce a page-specific persistence lane. After choosing
a temperature device or EV charger, the creation surface should distinguish two
user intents:

1. **Start now** — begin making progress in the current hour whenever the
   device is commandable and the hard cap permits it.
2. **Ready by** — retain the existing price-aware target-and-deadline planner.

`Start now` is one generic Smart-task intent with kind-specific presentation,
not separate heating and charging subsystems. Temperature devices may seed the
goal from the current mode target; an EV must show an explicit target percent
because there is no universally correct implicit full-charge target. The first
slice remains limited to the two objective kinds the planner already supports;
generic binary loads have no trustworthy progress target and must not be
promised the same behaviour.

Unlike `Ready by`, `Start now` is price-neutral. Its preview and runtime path
must construct a non-price horizon with a current-hour bucket when price-aware
planning is disabled or prices are unavailable; those states must not become
`objective_price_feature_disabled` or `objective_missing_price_horizon`.

The immediate intent applies all three existing objective-scoped permissions as
`always`: `exemptFromBudget`, `limitLowerPriorityDevices`, and
`pauseLowerPriorityDevices`. That lets the task exceed the soft daily budget
and make room from lower-priority managed devices without weakening the hard
cap. These permissions are necessary but not sufficient: the current hour has
to be included whenever it is physically and operationally available, and the
immediate-intent discriminator must suppress both the `priceDeferralEligible`
and `coldStartReleaseEligible` per-cycle release paths. Otherwise admission can
still idle a booked current bucket in favor of a later hour.

The preview resolves one finite absolute deadline and create echoes that exact
value: `now + max(3 h, estimated duration + 1 h)`. Refuse `Start now` when the
duration estimate is unavailable/non-finite or the result exceeds the existing
36 h candidate horizon. Show the resolved end before confirmation. Reaching
the target finalizes the task as `Succeeded`; reaching the deadline without the
target finalizes it as `Missed`; user cancellation finalizes it as `Abandoned`.
This gives a disconnected or unavailable device a bounded wait without treating
one transient observation as a terminal failure.

Immediate tasks also:

- stay inside the hard cap and stale-power safety posture;
- expose the target and resolved end condition before confirmation;
- pause actuation when a device temporarily cannot continue. An EV disconnect
  invalidates session progress and requires a fresh sample after reconnect; it
  must not silently clear the task on one transient observation;
- **stop the device on success before finalizing.** Reaching the target must
  actuate, not merely record. The lifecycle-clock-triggered executor fallback is gated to
  `controllable === false` devices; terminal admission emits no plan-path release
  intent. A cap-on charger therefore stays on the planner's normal managed lane,
  and `handleDeferredDeadlineReached` disarms it without actuation. An 80 % task
  on a power-limit-controlled charger would therefore keep charging past its target.
  The immediate-success path must pause a binary charger and settle or retry
  that command before it removes the diagnostic and records `Succeeded`;
- resolve conflicts with an existing task explicitly rather than silently
  replacing it.

The dashboard New smart task widget and the Smart tasks page should share this
engine and vocabulary. The Held-back devices widget and the contextual Overview
action remain useful recovery surfaces, but their current temperature-only,
daily-budget-caused rescue is not the generic immediate intent: it appears only
after a device is held back and its short task can still be scheduled in a
later hour. Do not add permanent action chips to every quiet Overview card;
keep proactive creation in Smart tasks and reserve Overview actions for a live
condition the user can act on.

## Addendum — 2026-06-11: chart-overhaul train closures

The chart-overhaul train (PRs #1677–#1681) closed three of the findings
this review tracks. Recorded here so the sections above read as the
review-time state, not open gaps:

- **Plan-change visibility on touch** (§ "Plan-change visibility is the
  weakest narrative"): the live page's 1-px changed-hour border and
  tooltip-only revision reason are gone — changed hours render a dot
  marker and the pinned scrub readout surfaces the canonical revision
  sentence on touch (#1679); the history detail gained a
  "Plan changed HH:MM" marker, a compare-with-initial-plan toggle, and
  per-hour skip attribution (#1681).
- **Postmortem cost absence**: progress/delivery samples are recorded at
  15-minute resolution (#1678), and the history detail's hourly strip
  pays its cost question per hour
  (`23:00 · 1.1 kWh · 0.48 kr/kWh ≈ 0.53 kr`), with the Succeeded cost
  narrative regaining the per-kWh average + delivered fragments (#1681).
- **Chart comprehension**: the live dual-pane "Price horizon" chart
  split into two single-question cards with a pinned tap readout
  (#1679); the widget trajectory gained scheduled-run bands and a
  smoothed measured line (#1680); the history detail is receipt-first
  with a kind-aware question title ("Did it heat up as planned?") and a
  compact DOM legend (#1681). The widget charts moved onto the calm
  semantic chart-token palette (#1677).

The asymmetric-treatment thesis above remains the design-of-record; the
chart collapse policy (which now also gates the hourly strip) lives in
`notes/v2-7-2/postmortem-chart-policy.md`.
