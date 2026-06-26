# PELS Personas

Cross-cutting personas for every PELS surface — Overview, Budget, Usage,
Smart-tasks (list + plan detail + history detail), Settings/Advanced.

This model is **motivation- and disposition-first**, not engagement-state-first
(it replaces the older "six engagement-state personas ordered by how well we
serve them" structure — see [§ Old → new mapping](#old--new-mapping)). The
governing rule:

> **The persona's need is the spec. "What ships today" is a gap/roadmap layer,
> never a reason to trim a need.** We adapt the product to the personas, not the
> personas to the backlog.

Companion note: the **before** angle (who each persona is *before* they have
heard of PELS — triggers, search queries, communities, arrival channel) lives in
[`notes/persona-acquisition.md`](persona-acquisition.md). This file is the
**after** angle — the per-surface UX rubric that `pels-ux-fit` consumes. The two
map 1:1 by persona.

---

## How to read this in one screen

PELS personas are built from three layers, in order of importance:

1. **Foundation (shared by everyone).** Every PELS user wants the same primary
   job done — **Safety/Reliability**: never feel a breach (no tripped fuse, no
   cold shower, no uncharged EV, no surprise capacity-tier jump). And everyone
   needs the same evidence layer — **Trust/Verification**: proof it did what it
   claimed, and a different rendering when it fails. These are *universal*, so
   they don't differentiate personas — they define the product.
   See [§ The foundation](#the-foundation-safety-trust-and-the-qualifying-gate).

2. **Personas (what actually varies).** Households differ on **disposition**
   (how hands-on they want to be — Control ↔ Convenience) and on their
   **dominant secondary job** (save money? self-consume solar?). That gives four
   personas (one still emerging). See [§ The personas](#the-personas).

3. **Scenarios (the moment they're in).** Every persona passes through
   **Onboarding → Steady → Verifying → Failing**. These are *scenarios layered
   over each persona*, not personas in their own right. The **Failing** scenario
   carries the emotional-intensity asymmetry and the "failure renders
   differently from success" mandate. See [§ Scenarios](#scenarios-cross-cutting).

Plus three guardrails: a **Negative persona** (who we deliberately don't serve),
**region as market-config** (re-weight the same jobs per market, never a separate
persona set), and an **evidence tier** on every need (these are proto-personas —
treat unvalidated needs as untrimmable *hypotheses*, not proven requirements).

**Evidence tier (read before treating any need as spec).** These personas are
**qualitative / proto** — grounded in forum + search-trigger research (see the
acquisition note's sourcing caveat), *not* in interviews, analytics, or churn
data. So: a **validated** need is an untrimmable spec; a **proto** need is an
untrimmable *hypothesis* that still gates features but is itself flagged for
validation. Until we run primary research, treat every need below as proto unless
marked otherwise. **Validation trigger:** real user interviews / support-ticket
coding / churn analysis — and refresh on each new-market launch (NL/DE/SE) and
when solar ships.

---

## The foundation: Safety, Trust, and the qualifying gate

**The qualifying gate.** Every PELS user has already outgrown the two things most
Norwegian homes reach for first — **price-only smart charging** and their
**charger's own built-in load balancing**. Each owns one axis (price *or* the
fuse, one device). The households those tools fully satisfy never become PELS
users. PELS converts the home at the **seam** where one-axis tools fail:
whole-home capacity **and** price **and** several devices **and** a deadline,
coordinated together. Read every persona as starting *after* this gate.

**Safety/Reliability is the universal job.** It is *why the product exists*, not a
segment: nobody installs a capacity controller to feel a breach. The **hard cap
is physical** — a breaker/tariff boundary, not a money knob — so copy must never
suggest raising it (recommend lowering the daily budget instead). Because every
persona shares this job, it cannot differentiate them; it is the floor under all
four.

**Trust/Verification is the universal evidence need.** A burned single-axis
veteran believes a tool only when it shows its work — hour by hour, krone by
krone — and renders failure *differently* from success. This need is strongest
for the Optimiser and most acute in the Verifying and Failing scenarios, but
every persona carries it. It is baked in, not a persona of its own.

---

## Negative persona — deliberately out of scope

**The single-axis-satisfied household.** A home whose whole problem is *one*
axis: only the EV charger vs the fuse, or only price-shifting one device.
Price-only smart charging, a charger's own built-in load balancing, or a
smart-plug timer already satisfies them, and they never hit the coordination seam. We do **not** design for them,
and we do not bloat the product to court them. This is the cheapest scope-control
device we have: when a request is justified only by "but the price-only / fuse-only
user would want it," the answer is that they are the Negative persona.

---

## The personas

Each persona below is one *disposition + dominant job*, with a one-line
**signature** (managed-device profile + comfort tolerance — the levers PELS
actually negotiates), and a per-surface table. The table's **Need** column is the
spec (needs-first); the **Today** column is the gap/roadmap layer (✅ shipped ·
◐ partial · ○ gap) and never reorders or trims the persona.

The four sit on the **disposition spectrum**, which is also the **maturity arc** —
households tend to move Control → Convenience as trust is earned:

```
 hands-on  ◀───────────────────────────────────────────────▶  hands-off
 Orchestrator        Optimiser              Set-and-forget owner
 (own the policy)    (prove the savings)    (delegate it all)
                Prosumer (emerging) sits across the middle,
                differentiated by ASSET (solar), not disposition.
```

---

### 1. Set-and-forget owner — *Convenience*

**Disposition:** hands-off. Wants it to disappear: install, set the cap, walk
away. The purest expression of delegation; the family household lives here too
(it must "just work" for everyone — no fiddling, no cold showers, no surprises).
**Dominant job:** Safety, fully delegated. Cost matters but only as a background
win they never manage.
**Signature:** EV + water heater + a couple of thermostats; *low* comfort
tolerance for intrusion (a cold shower is a veto, not an inconvenience); low
appetite for any controllable-load tuning.
**Absorbs:** old #1 (set-and-forget) + the relax-into-delegation half of old #2
(first-time).

| Surface | Need (the spec) | Today |
|---|---|---|
| Overview | "OK right now" hero — one glance, no action implied. | ✅ |
| Budget | "On track for today" + projected landing, stated as a verdict. | ◐ (number shown; verdict wording weak) |
| Usage | Yesterday's total at a glance; no drill-down. | ✅ |
| Smart-tasks list | All-green chip column. | ✅ |
| Smart-task detail (plan) | "It's handled, lands on time" — reassurance, not internals. | ✅ |
| Smart-task history detail | "It worked" receipt; only surfaces if they look. | ✅ |
| Settings | Opinionated defaults; rarely reopened after onboarding. | ✅ |
| *(family)* | modes / guest / comfort-floor presets ("morning/away/night") so the household never feels a shed. | ○ **gap** — no turnkey mode presets ship; modes are user-wired. |

> The one-glance summary is **sacred**: density added for the Orchestrator/Optimiser
> (per-hour tooltips, cost narratives, postmortems) must stay behind expand/detail,
> never on this persona's first-glance hero.

---

### 2. Orchestrator — *Control*

**Disposition:** hands-on. Wants the engine handed over but still pops every
hood; owns the policy — per-mode priority order, the managed/exempt device set,
capacity/margin tuning, Flow-card composition, manual overrides, the "Get power
now" rescue lane. Distrusts a black box "taking over" a device.
**Dominant job:** the single differentiating job is **control/authorship of the
safety+cost policy** — Cost and Climate are levers exercised *through* that
control, not co-equal jobs. Climate rides here as a weak frugality lever (lean the
budget down, find what to turn off) — see [§ Climate](#climate--a-facet-not-a-persona).
**Signature:** richest device set (EV, water heater, panel heaters, heat pump);
*high* tolerance for intrusion if they authored the rule; wants legible levers,
not magic.
**Absorbs:** the configure-and-compose half of old #3 (tinkerer) + the
build-my-first-Flow-card half of old #2.

| Surface | Need (the spec) | Today |
|---|---|---|
| Overview | Per-device current draw + recent limit/resume activity. | ◐ |
| Budget | Hourly bar chart, planned-vs-actual, numbers in the tooltip. | ✅ |
| Budget / Settings *(Climate facet)* | Lean the daily budget down to the weather forecast; frugality / "use less". | ✅ (weather energy-signature + daily budget ship) |
| Usage | Per-device kWh breakdown — *which device, and what can I turn off?* | ○ **gap** — only managed/background aggregate ships. |
| Smart-tasks list | Status legible at a glance; composable from Flow. | ✅ |
| Smart-task detail (plan) | "Why these hours?" + the permission matrix (go-over-budget / limit-lower-priority, scoped). | ✅ |
| Smart-task history detail | Learned-rate row (`Energy needed per °C / %`), per-hour tooltips. | ✅ |
| Settings | Visible reasoning ("defaults to X because Y"); a consolidated manual-control surface. | ◐ (reasoning thin; overrides scattered across Flow/Settings/widget) |

---

### 3. Optimiser — *Cost, verification-first*

**Disposition:** middle — will touch settings to chase a win, but wants the
system to do the work and then **prove it**. A burned single-axis veteran (EV
commuter / heat-tank owner) who has been lied to by a schedule before.
**Dominant job:** **Cost** — shift load to the cheap hours and *see* the saving.
The Optimiser is differentiated by **Cost, not by Trust**: Trust is universal
(foundation), the Optimiser merely lives in the **Verifying** scenario most often
and gates belief earliest. "Verification-first" is an *intensity* marker, not a
claim that Trust belongs to this persona.
**Signature:** EV (smart charger) + relay-controlled water heater; *medium* comfort
tolerance; cares about øre/kWh and the capacity-tier penalty equally.
**Absorbs:** old #4 (skeptical optimiser) + the verify-your-own-setup half of old
#3.

| Surface | Need (the spec) | Today |
|---|---|---|
| Overview | "Today's avg price X kr/kWh · N kWh moved to cheap hours." | ○ **gap** |
| Budget | Projected end-of-day cost in **money**, not just kWh. | ○ **gap** |
| Usage | Per-device **cost** column alongside kWh. | ○ **gap — strongest open ask** |
| Smart-tasks list | Per-task cost recap on the card. | ✅ |
| Smart-task detail (plan) | The schedule-trust caption (`Picked N of M hours · avg P kr/kWh`) + live `Cost ≈ X.XX kr`. | ✅ |
| Smart-task history detail | Receipt: `≈ 3.10 kr · 0.52 kr/kWh on average · 6.0 kWh delivered`. | ✅ |
| Settings | Price source + currency in one obvious place. | ◐ |
| *(counterfactual)* | "≈ X kr saved vs not using PELS" — the credibility holy grail. | ○ **gap** — no vs-baseline number exists anywhere (the ingredients do). |

> **Do not repeat the stale premise** "cost is answered nowhere as a single
> number" — it is **false on smart-task surfaces** now. The live frontier is the
> **aggregate** view (Usage money column, Overview avg-price line, Budget money
> projection) and the **vs-no-PELS counterfactual**.

---

### 4. Prosumer — *Autonomy* *(emerging — gate on solar shipping)*

**Disposition:** varies; **differentiated by ASSET, not disposition.** Owns (or is
adding) solar PV and wants to *self-consume* their own production rather than
export it for little money.
**Dominant job:** maximize self-consumption — a genuinely *distinct* goal (PV
flips the objective from "minimize grid draw under a cap" to "soak up my own
surplus"), which is why it earns its own persona once solar lands rather than
folding into Cost/Climate. Until then it is a **named placeholder**, not a
shipped target.
**Signature:** PV (no battery in v1), EV + heat pump + VVB as surplus sinks; cares
about self-consumption rate as the headline KPI.
> *Update:* read-only home-battery awareness now lands at the runtime seam
> (home-battery SoC + signed power observed and logged as `battery_state_observed`,
> never feeding the hard-cap import path). PELS does not yet *control* the battery
> or surface it in the UI — it's the sensor foundation for later cap-relief /
> surplus-routing. The Overview battery subline is the next UI step (see TODO.md).
**Absorbs:** new — the market signal behind the solar direction. Strongest in
NL (net-metering phase-out) and DE; nascent in NO.

| Surface | Need (the spec) | Today |
|---|---|---|
| Overview | Self-consumption rate + "surplus going to the EV/tank now." | ○ **gap** — PELS is surplus-blind today (clamps net to ≥0). |
| Budget | Solar-aware budget (own production isn't "spend"). | ○ **gap** |
| Usage | kWh self-consumed vs exported. | ○ **gap** |
| Smart tasks | "Charge from your own surplus by deadline." | ○ **gap** |
| Settings | PV/inverter source + self-consume-vs-price honesty when they conflict. | ○ **gap** |

> Keep this persona in the doc as the **goal** the solar work serves, but do not
> let `pels-ux-fit` grade surfaces against it until the feature ships. Its needs
> are the spec for solar; its "Today" is uniformly a gap by design.

---

## Climate — a facet, not a persona

There is **no climate/green persona**, deliberately. The reduce-total-kWh motive
is real but a **weak lever** in PELS's home market and not a distinct goal:

- **Value-action gap:** large majorities express green concern but don't act on it
  when offered (the documented ~30% concerned-but-inactive; a majority of "green"
  clusters are still primarily price-driven).
- **Clean grid:** Norway's ~99% low-carbon (hydro/wind) grid genuinely guts the
  kWh-for-CO₂ argument; consumption drops there track *price*, not carbon, and
  subsidies dampen the saving urge.

So Climate is a **frugality / anti-waste facet of Cost** — hunt standby/"always-on"
wasters, lean the daily budget to the weather forecast — owned by the Orchestrator's
table (it must be a *served* row there, since weather/daily-budget genuinely ships,
not an orphan). Surface it with **honest numbers, never a CO₂ badge**, and never let
green framing lead. *(Market caveat: this calibration is NO-specific; revisit
whether Climate re-weights up enough to promote in DE/NL — see
[§ Region](#region--market-config).)*

---

## Scenarios (cross-cutting)

Every persona passes through these four moments. They are **scenarios, not
personas** — the same household at different minutes. Each persona's per-surface
needs above are the *Steady* baseline; the other three re-shape what a surface
must do.

| Scenario | What it is | What every surface owes |
|---|---|---|
| **Onboarding** | First contact; does not trust the app yet. The trust-establishment window — high-stakes, not P2/P3 polish. | "What is this number, and why is it good?" framing; proof-of-life ("Watching N devices, capacity X kW"); the `Building plan…` pending hero (currently the strongest copy in PELS). |
| **Steady** | The monthly green-chip glance. | The persona's baseline table above. |
| **Verifying** | "Did it pick the cheap hours? what did it cost?" | The Trust/receipt rubric: schedule-trust caption, `Cost ≈ X.XX kr`, the finished-run receipt. |
| **Failing** | Pushed mid-incident, or recovering and planning the next run. | See the rubric below — this is the load-bearing one. |

### The Failing scenario — where the asymmetry lives

This is the single most actionable property in the whole model, and it replaces
the old "personas 5 & 6." The principle:

> **Failure must render differently from success — on every page, in the first
> sentence, with a one-tap recourse — never the current state merely restated.**

It has **two landing profiles**, which need *different* things (do not let one
absorb the other):

- **Acute (push deep-link):** arrives mid-incident via a Homey notification, zero
  patience. Needs the failure reason **in sentence one on the exact surface the
  deep-link lands on**, plus the single thing to change.
- **Recovering (self-navigating, later):** calmer, planning the next run. Needs an
  **aggregate** postmortem signal ("3 misses this week", "hit the cap at 18:42
  because…").

**Shipped worked example:** Smart-tasks (succeeded = receipt; missed = `Why:`
diagnosis + shortfall chip + `Lower daily budget` / `Review device` recourse;
abandoned = log), via the chart-overhaul + history-detail receipt train
(#1677–#1681). **Open frontier:** generalise that shape to Budget overshoot,
capacity-exceeded pushes, and aggregate-failure lines on Overview — the data
(`cannotMeetDailyBudgetExhausted`, exhaustion bucket counts, shortfall,
`objective_invalid_session`) is captured but composes into no on-surface sentence.

**Review rule (wire into `pels-ux-fit`):** evaluate each surface for its **single
primary persona**, in **both** its Steady and Failing scenarios — a surface passes
only if it serves the primary in both. The Failing scenario always carries the
P0/P1 weight.

---

## The gap & roadmap layer (the asymmetry, made pointable)

This is where "served / unserved" lives — a prioritization map, **not** the
persona ordering. P0/P1 weight goes to the highest-emotion, least-served cells
(the Failing scenario on aggregate surfaces). Current frontier, roughly ranked:

1. **Aggregate failure rendering** (Failing × Overview/Budget) — capacity-exceeded
   and budget-cap pushes still land on surfaces that only restate current state. *P0.*
2. **Usage per-device cost column** (Optimiser) + **per-device kWh** (Orchestrator/Climate)
   — one build serves both; answers "what cost me / what to turn off". *P1.*
3. **Overview avg-price / kWh-moved line** + **Budget money projection** (Optimiser). *P1.*
4. **vs-no-PELS counterfactual** (Optimiser) — the credibility grail; ingredients exist. *P1/P2.*
5. **Family modes / comfort-floor presets** (Set-and-forget). *P2.*
6. **Solar self-consumption** (Prosumer) — the whole table; tracked by the solar direction. *roadmap.*

---

## Per-surface primary persona

Cooper's axiom is "design each interface for a single primary persona." Each PELS
surface is its own interface, so each names **one** primary persona — and the
Failing *scenario* it must most withstand (a scenario, not a second persona):

| Surface | Primary persona | Failure-state priority scenario |
|---|---|---|
| Overview | Set-and-forget owner | Failing (acute) |
| Budget | Optimiser | Failing (acute) |
| Usage | Optimiser | Failing (recovering) |
| Smart-tasks list | Set-and-forget owner | Failing (recovering) |
| Smart-task detail (plan) | Orchestrator | Failing (acute) |
| Smart-task history detail | Optimiser | Failing (both) |
| Settings | Orchestrator | Failing (recovering, via recourse deep-link) |

*Prosumer is intentionally absent: it becomes a candidate primary for
solar-specific surfaces once solar ships (see [§ persona 4](#4-prosumer--autonomy-emerging--gate-on-solar-shipping)).*

---

## Region — market-config

Region is **not** a persona axis. The same jobs recur in every market; what
changes is their *ranking* and the *mechanism* they attach to — a market-config
layer that re-weights the same personas, never a parallel persona set.

- **Norway / Sweden** — two-axis cost (spot price **+** effekttariff/effektabonnemang
  peak-shaving); Climate weak (clean grid); Orchestrator + Set-and-forget dominate.
- **Netherlands** — the net-metering (salderingsregeling) phase-out flips
  **self-consumption/autonomy** to the front and makes the surplus-blind framing a
  poor fit; the Prosumer persona is most urgent here.
- **Germany** — §14a dimmable-loads mechanism; higher grid carbon means **Climate
  may re-weight up** enough to revisit its facet status (open question).

Region drives copy emphasis, default feature set, and which persona a surface
leads with — not the persona list.

---

## How to use this document

- **Designing a view:** find the surface's primary in [§ Per-surface primary](#per-surface-primary-persona),
  design for it, then run the Failing check. One primary per surface.
- **Reviewing copy:** ask which persona and which scenario the sentence serves. If
  it only serves Set-and-forget/Steady, it likely needs a Failing-scenario sentence.
- **Triaging UX findings:** P0/P1 weight follows the [gap & roadmap layer](#the-gap--roadmap-layer-the-asymmetry-made-pointable) —
  highest-emotion least-served cells first. Never let "what ships today" trim a
  need; file the gap instead.
- **Treating a need as spec:** check its evidence tier. Proto needs gate features
  as hypotheses but are themselves flagged for validation; never size a feature on
  surveyed/forum-stated willingness (it runs well above realised behaviour).
- **Positioning / onboarding:** walk the **before** angle in
  [`persona-acquisition.md`](persona-acquisition.md).
- **`pels-ux-fit`:** this file is its rubric. Keep the two aligned; the per-surface
  primary table + the Failing rule are the parts it executes most directly.

---

## Old → new mapping

For updating cross-references (`TODO.md`, `notes/smart-task-ui/README.md`,
`notes/widget-review.md` cite the old `#1`–`#6`):

| Old engagement-state persona | New home |
|---|---|
| #1 Set-and-forget owner | **Set-and-forget owner** (primary inhabitant) |
| #2 First-time user | **Scenario: Onboarding** (cross-cutting) — relax-half → Set-and-forget; build-half → Orchestrator |
| #3 Curious tinkerer | split: configure-half → **Orchestrator**; verify-half → **Optimiser** |
| #4 Skeptical optimiser | **Optimiser** (primary inhabitant) |
| #5 Recovering-from-mistake | **Scenario: Failing (recovering)** (cross-cutting) |
| #6 Notification-driven panic | **Scenario: Failing (acute)** (cross-cutting) |

Key structural changes from the old model: motivation/disposition replaces
engagement-state as the spine; engagement-states #2/#5/#6 become **scenarios**;
Safety + Trust move to the **foundation** (universal, not personas); the
served-rating that used to *order* personas moves to the **gap & roadmap layer**;
**Prosumer** is added as an emerging persona; a **Negative persona** and **evidence
tiers** are introduced.
