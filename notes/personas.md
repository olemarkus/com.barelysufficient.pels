# PELS Personas

Cross-cutting personas for every PELS surface — Overview, Budget, Usage,
Smart tasks (list + detail), Settings/Advanced. Lifted and generalised
from the Smart-tasks UI review (`notes/smart-task-ui/README.md`, where
they were originally scoped to one feature).

The list is ordered by **how well the product serves the persona
today**, best first. The point of the ordering is the asymmetry it
exposes, not the ranking itself.

## Two lenses: before and after

These six are **engagement-state** personas — they describe *how someone
uses the running app*. Each also has a **before**: the real-world
problem that sends a Norwegian homeowner searching long before they have
heard of PELS, what they type into Google, where they ask for help, and
the path by which they land on the App Store page. That acquisition lens
— triggers, the actual search queries, the discovery funnel, and
citations to real forum/community threads — lives in its companion note
[`notes/persona-acquisition.md`](persona-acquisition.md). This file
keeps the per-surface *after* rubric that `pels-ux-fit` consumes; each
persona below carries a one-line **Arrives because…** pointer into the
companion.

Two things hold across every persona and are worth stating once:

- **The qualifying gate.** Every PELS user has already outgrown
  Tibber-style smart charging plus their charger's own built-in load
  balancing. Those tools each own one axis — price *or* the fuse, one
  device — and the households they fully satisfy never become PELS
  users. PELS converts the home that has hit the *seam* where those
  tools fail: whole-home capacity **and** price **and** several devices
  **and** a deadline, coordinated together. Read every persona's
  acquisition story as starting *after* that gate.
- **One household, several states.** A single home moves through these
  personas over time, so the personas are moments, not different people.
  Personas 1, 2 and 6 are the same household at three moments —
  onboarding (2), steady state (1), and the exception minute a Homey
  push drags them back (6). Persona 3 is the verify-first branch of 2
  (the builder who pops every hood before relaxing). Persona 4 is the
  priced cut — the same EV / heat-tank owner asking "did it pick the
  cheap hours, and what did it cost?". Persona 5 is persona 6 cooled
  down: same failure, calmer, planning the next run.

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

**Arrives because…** the nettleie bill crept up a capacity tier (the
"tre-timers-regelen", reported as far as ~4 500 kr/year) or the main
fuse tripped mid-evening with the EV charging while dinner cooked — and
they want it handled *for* them, "the way Tibber does," with zero
appetite for a project. See
[acquisition § 1](persona-acquisition.md#1-set-and-forget-owner-the-just-make-it-work-buyer).

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
displace the one-glance summary this persona depends on — and the
chart-overhaul depth (per-hour tooltips, cost narratives, postmortems)
added for personas 3–6 is exactly the kind of density that must stay
behind expand/detail, never on the first-glance hero.

### 2. First-time user — *served well*

**Arrives because…** they either burned out hand-building a Homey Flow
that sums device wattage and gates the charger (and gave up when the
price window crossed midnight and the loads flapped), or they own
Tibber + Easee balancing and learned it only protects one charger
against the fuse, not the whole-home tier. They have decided to stop
coding and install a dedicated app — but do **not** trust it yet. See
[acquisition § 2](persona-acquisition.md#2-first-time-user-the-flow-burnout-graduate).

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
first contact. The finished-run receipt (`≈ 3.10 kr · 0.52 kr/kWh on
average · 6.0 kWh delivered`) is this persona's proof-of-value moment —
it is what converts a first-time user who has just escaped a fiddly DIY
flow into the set-and-forget owner.

### 3. Curious tinkerer — *served adequately*

**Arrives because…** they are the frustrated Homey Flow-builder whose
hand-rolled capacity rule ballooned into "litt strevsomt å teste /
vedlikeholde / endre" — the unmaintainable state machine of summed
power, hysteresis, priority shedding and a midnight-crossing price
window the standard cards can't hold. They want the engine handed to
them, but will still pop every hood. See
[acquisition § 3](persona-acquisition.md#3-curious-tinkerer-the-frustrated-flow-builder).

Daily for the first week, weekly after. Configuring devices, hovering
tooltips, expanding cards. Wants enough internals exposed to *debug
their own setup*, but not so much that the page becomes a dashboard.

| Surface | What they want |
|---|---|
| Overview | Per-device current draw, recent limit/resume activity. |
| Budget | The hourly bar chart with planned-vs-actual; tooltip with numbers. |
| Usage | Per-device breakdown; "what did this device cost last week?". |
| Smart tasks | Per-hour tooltips on the chart, expanded inputs card, `Estimating` chip + the `Energy needed per °C` learned-rate row. |
| Settings | Visible reasoning ("this defaults to X because Y"). |

Served adequately. Per-surface tooltip depth is uneven — the Smart-
tasks chart leads; Budget and Usage tooltips are thinner than they
should be. (Two corrections vs the earlier draft of this table: the
learned-rate row ships as `Energy needed per °C` / `Energy needed per
%`, not the old `Energy per unit 0.59 kWh/°C` example; and the
Overview want reads `recent limit/resume activity`, never the
user-facing-banned `shed/restore`.)

### 4. Skeptical optimiser (EV commuter / heat-tank owner) — *underserved on aggregate surfaces*

**Arrives because…** a single-axis tool betrayed them — scheduled
charging silently didn't fire and the car was empty before the commute,
or the water heater left the last person a cold shower, or the bill
"snublet opp ett trinn" from EV-plus-cooking. They've been lied to by a
schedule before, so they demand to *verify*: did it pick the cheap
hours, and what did it cost? See
[acquisition § 4](persona-acquisition.md#4-skeptical-optimiser-the-burned-single-axis-veteran).

Daily, after a charge or a heating cycle. Wants two answers:
**did it pick the cheap hours?** and **what did that cost?**

| Surface | What they want |
|---|---|
| Overview | "Today's avg price 0.84 kr/kWh, N kWh shifted to cheap hours." — **unbuilt.** |
| Budget | Projected end-of-day cost in money, not just kWh — **unbuilt.** |
| Usage | Per-device cost column alongside kWh — **unbuilt; the strongest open ask.** |
| Smart tasks | "Picked N of the M hours it can use · avg P kr/kWh" + a money figure on the hero/receipt — **shipped.** |
| Settings | The price source and currency in one obvious place. |

Re-rated per-surface (it was blanket *underserved*). The
chart-overhaul + history-detail receipt train shipped a single-number
cost answer exactly where this persona looks first — a smart-task run:
the live hero renders `Cost ≈ X.XX kr`, the schedule trust caption
renders `Picked N of the M hours it can use · avg P kr/kWh` (no `vs
baseline` comparison — the window-average compare was deliberately
dropped with the two-chart split; the muted unplanned bars carry the
baseline visually), and the finalized receipt renders `≈ 3.10 kr · 0.52
kr/kWh on average · 6.0 kWh delivered`. So the old anchoring premise —
"answers cost nowhere as a single number" — is now **false on
smart-task surfaces** and must not be repeated. What stays genuinely
underserved is the **aggregate** view: Overview has no avg-price /
kWh-shifted line, and Usage has no per-device cost column. This persona
is the strongest argument for that **money column in Usage** and an
**avg-price line on Overview** — but no longer for a money figure on the
Smart-task hero, which now exists.

### 5. Recovering-from-mistake user — *poorly served on aggregate surfaces*

**Arrives because…** a trusted automation failed in a way the household
felt — cold shower from a VVB relay that stayed off, an uncharged car at
07:00, a capacity-tier jump because two big loads coincided. They are
doing damage control, not optimising, and the 24-hour data lag means
"skaden har allerede skjedd" by the time they see it. See
[acquisition § 5](persona-acquisition.md#5-recovering-from-mistake-user-the-burned-automator).

Opens PELS after something went wrong — a missed deadline, a budget
overshoot, a device that didn't ease off when expected. Planning the
*next* run. Wants *what changed*, *why*, and *what to do about it*.

| Surface | What they want |
|---|---|
| Overview | Aggregate signal: "3 misses this week" — not just current state. **Unbuilt.** |
| Budget | "You hit the cap at 18:42 because…" — a postmortem line, not just the bar. **Unbuilt.** |
| Usage | "This device drew 2× more than last week" — anomaly hinting. **Unbuilt.** |
| Smart tasks | Miss-streak on the list; postmortem sentence on detail; CTA to lower daily budget / review device. **Shipped.** |
| Settings | A path back to the specific setting implicated in the failure. (Partial — via the Smart-tasks `Review device` deep-link.) |

Re-rated per-surface (it was blanket *poorly served*). The Smart-tasks
column is now served: the past-tasks list leads with the rolling 7-day
hit-rate strip and per-device miss-streak badges, and the missed
history-detail hero renders a postmortem `Why:` sentence, a muted
shortfall chip, and a one-tap recourse button (`Lower daily budget` /
`Review device`) — exactly the wants this row used to list as unserved.
The data behind the *aggregate* gaps (`cannotMeetDailyBudgetExhausted`,
`dailyBudgetExhaustedBucketCount`, shortfall, `objective_invalid_session`,
abandoned-by-user, plus the daily-budget exhaustion bucket counts on the
Budget side) is still captured — but on **Overview / Budget / Usage** it
does not yet compose into a sentence on the surface the user actually
visits. That is the live frontier for this persona.

### 6. Notification-driven panic visitor — *least served on aggregate surfaces*

**Arrives because…** they are mid-incident — pushed by a Homey
notification while the EV sits uncharged before work, or the last person
gets a cold shower, or the fuse just tripped with kids in a cold flat.
Maximum emotion, zero patience, and they blame the tool they trusted. As
an acquisition story this overlaps personas 2 and 4 almost entirely; as
an engagement state it is reached through the notification deep-link.
See [acquisition § 6](persona-acquisition.md#6-notification-driven-panic-visitor-the-mid-incident-victim).

Pushed via a Homey notification — "Smart task missed", "Budget cap
hit", "Capacity exceeded". Possibly mid-shower with no hot water,
or watching the EV not charge before a morning commute. Most
emotionally invested at point of contact. Has zero patience for
chart navigation.

| Surface | What they want |
|---|---|
| Overview | The notification's reason restated in one line, with context. **Unbuilt for capacity/budget pushes.** |
| Budget | If notified about a cap hit: when, why, what to change. **Unbuilt.** |
| Usage | Almost never their landing surface — but should not bury the recent failure. |
| Smart tasks | The deep-linked detail answers *why* in the first sentence, not just *what* and *when*. **Shipped.** |
| Settings | A deep-link from the postmortem CTA, never a hunt. (Shipped on the Smart-tasks recourse; absent from Overview/Budget.) |

Re-rated per-surface (it was blanket *least served*). For a missed
Smart task — the most common deep-link target — the history-detail hero
now answers *why* in its first line (`Why:` sentence + shortfall chip +
recourse CTA), so the panic visitor gets diagnosis + next action without
touching a chart. The "restate the notification text and stop" verdict
now holds only for the **capacity-exceeded** and **budget-cap** pushes,
which still deep-link to Overview / Budget aggregate surfaces that don't
compose a failure sentence. This is the persona the reviewer-question
"does this page earn its visit?" applies most sharply to, and the
Smart-tasks failure path is the proof it can be earned.

## The asymmetry

Personas 5 and 6 — the recovering-from-mistake user and the
notification-driven panic visitor — are the *highest emotional
intensity* visitors and the *least served* across the aggregate
surfaces. The single design move worth investing in is **failure paths
should render differently from success paths**, on every page, not just
on Smart tasks. Smart-tasks detail is no longer the *aspirational*
worked example — it is the **shipped** one (succeeded = receipt; missed
= diagnosis + CTA; abandoned = log), via the chart-overhaul +
history-detail receipt train (#1677–#1681). The open frontier is
generalising that same shape to **Budget overshoot**,
**capacity-exceeded** notifications, and any **aggregate** failure
signal on Overview — the surfaces where personas 5 and 6 still land on a
page that only restates the current state.

The before/after framing sharpens why: the acquisition wound that
*creates* personas 5 and 6 (a single-axis tool that silently failed) is
the same family of event PELS then risks reproducing if its own failures
render as silently as a green success. Winning persona 4's trust with a
verifiable receipt is the cheapest insurance against the worst-served
states downstream — they are the same household, a few bad runs apart.

## How to use this document

- When designing a new view: walk the table for the persona most
  likely to land on it under stress, not the median visitor.
- When reviewing copy: ask which persona the sentence is talking to.
  If the answer is only persona 1, it probably needs a second
  sentence for persona 5 or 6.
- When triaging UX findings: P0/P1 weight goes to fixes that move a
  surface for personas 4–6. With the Smart-tasks failure path now
  shipped, that weight shifts to the still-unserved **aggregate**
  surfaces — the Usage money column, the Overview avg-price and
  aggregate-failure lines, and the Budget postmortem line. Persona 1–2
  polish is P2/P3.
- When positioning, writing docs, or shaping onboarding: walk the
  **before** angle in [`persona-acquisition.md`](persona-acquisition.md)
  — the trigger, the search query, and the discovery funnel are what a
  new user has just lived through when they first open a PELS surface.
- The `pels-ux-fit` review agent is the natural consumer of this
  rubric — its page-mission framing (Overview / Budget / Usage /
  Smart-tasks list / Smart-task detail / Settings) already mirrors
  the per-surface columns above. Keep the two aligned when either
  one changes; a follow-up can wire the agent prompt to cite this
  file explicitly.
