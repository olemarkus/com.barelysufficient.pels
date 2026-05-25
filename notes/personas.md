# PELS Personas

Cross-cutting personas for every PELS surface — Overview, Budget, Usage,
Smart tasks (list + detail), Settings/Advanced. Lifted and generalised
from the Smart-tasks UI review (`notes/smart-task-ui/README.md`, where
they were originally scoped to one feature).

The list is ordered by **how well the product serves the persona
today**, best first. The point of the ordering is the asymmetry it
exposes, not the ranking itself.

## Thesis

> PELS today is shaped as a **confirmation receipt for the set-and-
> forget user**. The personas it underserves are the users who arrive
> distressed — pushed by a notification, scanning a failing task, or
> staring at a budget number that doesn't match what they expected.
> The highest-emotional-intensity visitors are the least-served. Every
> surface should be judged against the question *"does this page earn
> its visit for the persona most likely to land on it under stress?"*

The framing applies per-page. The Overview hero, the Budget projection,
the Usage breakdown, the Smart-tasks list, the history detail and
Settings each have a different "stressed visitor" profile, and each
should pay them off differently.

## Personas

### 1. Set-and-forget owner — *served well*

Monthly visitor. Opens the app to confirm nothing is on fire, closes
it. Wants green chips and one sentence per page.

| Surface | What they want |
|---|---|
| Overview | "OK right now" hero, no further action implied. |
| Budget | "On track for today" + projected landing number. |
| Usage | A glance at yesterday's total; no drill-down. |
| Smart tasks | All-green chip column on the list. |
| Settings | Never opens it after onboarding. |

Served well today. Risk: features added for power users must not
displace the one-glance summary this persona depends on.

### 2. First-time user — *served well*

Just installed PELS, or just fired their first Flow card. Needs to
understand what the app *is doing for them* before they trust it.

| Surface | What they want |
|---|---|
| Overview | "Watching N devices, capacity X kW" — proof of life. |
| Budget | "Today's budget Y kWh, Z kWh spent so far" with units explained. |
| Usage | "Yesterday: A kWh across N devices" — first data point. |
| Smart tasks | The `Building plan…` pending hero (currently the strongest copy in PELS — `pendingHeroByReason` external-flow vs managed-prices distinction). |
| Settings | Defaults that read as opinionated, not blank. |

Served well on Smart tasks. The Overview hero and Budget first-glance
need similar "what is this number, and why is it good" framing for
first contact.

### 3. Curious tinkerer — *served adequately*

Daily for the first week, weekly after. Configuring devices, hovering
tooltips, expanding cards. Wants enough internals exposed to *debug
their own setup*, but not so much that the page becomes a dashboard.

| Surface | What they want |
|---|---|
| Overview | Per-device current draw, recent shed/restore events. |
| Budget | The hourly bar chart with planned-vs-actual; tooltip with numbers. |
| Usage | Per-device breakdown; "what did this device cost last week?". |
| Smart tasks | Per-hour tooltips on the chart, expanded inputs card, `Estimating` chip + `Energy per unit 0.59 kWh/°C`. |
| Settings | Visible reasoning ("this defaults to X because Y"). |

Served adequately. Per-surface tooltip depth is uneven — the Smart-
tasks chart leads; Budget and Usage tooltips are thinner than they
should be.

### 4. Skeptical optimiser (EV commuter / heat-tank owner) — *underserved*

Daily, after a charge or a heating cycle. Wants two answers:
**did it pick the cheap hours?** and **what did that cost?** Today
PELS hints at the first via tone-coded price bars and answers the
second nowhere as a single number.

| Surface | What they want |
|---|---|
| Overview | "Today's avg price 0.84 kr/kWh, N kWh shifted to cheap hours." |
| Budget | Projected end-of-day cost in money, not just kWh. |
| Usage | Per-device cost column alongside kWh. |
| Smart tasks | "Picked N of M cheapest hours, avg P kr/kWh vs Q baseline" + "Cost ≈ 4.20 kr · 7.2 kWh delivered". |
| Settings | The price source and currency in one obvious place. |

`Σ priceValue × deviceKwh` is derivable on every surface today; the
gap is renderer-and-copy. This persona is the strongest argument for
a money column in Usage and a money figure on the Smart-task hero.

### 5. Recovering-from-mistake user — *poorly served*

Opens PELS after something went wrong — a missed deadline, a budget
overshoot, a device that didn't shed when expected. Planning the
*next* run. Wants *what changed*, *why*, and *what to do about it*.

| Surface | What they want |
|---|---|
| Overview | Aggregate signal: "3 misses this week" — not just current state. |
| Budget | "You hit the cap at 18:42 because…" — a postmortem line, not just the bar. |
| Usage | "This device drew 2× more than last week" — anomaly hinting. |
| Smart tasks | Miss-streak surfaced on the list; postmortem sentence on detail; CTA to lower daily budget / review device settings. |
| Settings | A path back to the specific setting implicated in the failure. |

Mostly unserved. The data (`cannotMeetDailyBudgetExhausted`,
`dailyBudgetExhaustedBucketCount`, shortfall,
`objective_invalid_session`, abandoned-by-user, plus the daily-budget
exhaustion bucket counts on the Budget side) is captured. The gap is
that none of it composes into a sentence on the surface the user
actually visits.

### 6. Notification-driven panic visitor — *least served*

Pushed via a Homey notification — "Smart task missed", "Budget cap
hit", "Capacity exceeded". Possibly mid-shower with no hot water,
or watching the EV not charge before a morning commute. Most
emotionally invested at point of contact. Has zero patience for
chart navigation.

| Surface | What they want |
|---|---|
| Overview | The notification's reason restated in one line, with context. |
| Budget | If they were notified about a cap hit: when, why, what to change. |
| Usage | Almost never their landing surface — but should not bury the recent failure. |
| Smart tasks | The detail page they're deep-linked to should answer *why* in the first sentence, not just *what* and *when*. |
| Settings | A deep-link from the postmortem CTA, never a hunt. |

This is the persona the reviewer-question "does this page earn its
visit?" applies most sharply to. Today the deep-linked surfaces
mostly restate the notification text and stop.

## The asymmetry

Personas 5 and 6 — the recovering-from-mistake user and the
notification-driven panic visitor — are the *highest emotional
intensity* visitors and the *least served* across every PELS surface.
The single design move worth investing in is **failure paths should
render differently from success paths**, on every page, not just on
Smart tasks. Smart-tasks detail is the existing worked example
(succeeded = receipt, missed = diagnosis + CTA, abandoned = log); the
same shape generalises to Budget overshoot, capacity-exceeded
notifications, and any aggregate failure signal on Overview.

## How to use this document

- When designing a new view: walk the table for the persona most
  likely to land on it under stress, not the median visitor.
- When reviewing copy: ask which persona the sentence is talking to.
  If the answer is only persona 1, it probably needs a second
  sentence for persona 5 or 6.
- When triaging UX findings: P0/P1 weight goes to fixes that move a
  surface for personas 4–6. Persona 1–2 polish is P2/P3.
- The `pels-ux-fit` review agent is the natural consumer of this
  rubric — its page-mission framing (Overview / Budget / Usage /
  Smart-tasks list / Smart-task detail / Settings) already mirrors
  the per-surface columns below. Keep the two aligned when either
  one changes; a follow-up can wire the agent prompt to cite this
  file explicitly.
