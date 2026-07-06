# Overview Hero Spec

## Purpose

The hero answers three questions at a glance:

1. Are we on track?
2. How much power is being used right now?
3. Is this hour heading toward the hourly energy limit?

Mental model: **kW is speed. kWh is distance.**

Do not present both as identical `x / y` progress bars. The power bar is a threshold gauge; the energy bar is a progress bar.

---

## Card structure

One elevated Material 3 card with tonal background that shifts with state.

```
┌──────────────────────────────────────────────┐
│ [On track]                                ⓘ  │
│                                              │
│ Power now                                    │
│ 7.0 kW                                      │
│ Safe pace now 12.0 kW                       │
│                                              │
│ [managed][other][free.................]      │
│                  ↑ pace            ↑ cap    │
│ ▮ Safe pace now 12.0 kW ▮ Hard cap 15.0 kW  │
│ Managed 3.2 kW · Background 3.8 kW          │
│                                              │
│ Energy this hour                             │
│ 1.0 of 5.0 kWh used · projected 4.4 kWh    │
│ 38 min left                                  │
│ [====used====|projected|...............]     │
│                                              │
│ No action needed — this hour is on track.   │
└──────────────────────────────────────────────┘
```

---

## Chip row

The hero answers "am I OK right now?". The chip rail carries only signals that
change that answer: status, plus freshness when the underlying data is stale.

Why: owner walk 2026-05-17. The mode chip and price-level chip were demoted
out of the hero in PR9. Mode is a stable filter (page chrome), not a status
signal — restating it on the hero adds noise without changing the user's
"am I OK now" answer. Price level is a Budget-page concern; the Budget page
still surfaces it. The hero keeps status (because that *is* the answer) and
freshness (because stale readings invalidate the answer).

### Status chip

| Condition | Label | Tone |
|---|---|---|
| Power below safe pace, projected hour below budget | `On track` | success |
| Power above safe pace | `Above safe pace` | warning |
| Projected hour above budget (but not past the cap) | `Above budget` | warning |
| Projected hour above the hard cap's kWh | `Above hard cap` | error |
| Simulation mode enabled and PELS would act | `Simulation mode` | warning |
| Power data stale or fail-closed | `No data` | error |

`Above hard cap` is a **trajectory** judgement (projection tone `critical`),
never instantaneous kW vs the cap: the cap is an hourly-average tariff-step
ceiling, a momentary excursion above it is not a breach, and the dynamic safe
pace legitimately exceeds the cap late in an under-used hour (see
`notes/ui-terminology.md` § "Hard cap is an hourly ceiling").

### Freshness chip

Show only when not `fresh`. Hide when live data is current.

### Mode (page chrome, not hero chip)

The current operating mode is surfaced on the Settings page as the `Current
mode` selector and in the modes editor, not on the Overview hero. The selected
option is the untranslated user-authored mode name; do not append `mode` to it.

### Info button

Small Material icon button (`info`) at top-right. Tooltip / dialog:

```
Power now is measured in kW — how fast electricity is being used right now.
Energy this hour is measured in kWh — how much has been used so far this hour.
Safe pace is the highest power rate that keeps this hour on track for the energy budget.
The hard cap is your grid tariff step — an hourly average, so short bursts above it are fine while the hour's energy stays under it.
kW is speed. kWh is distance.
```

---

## Section 1: Power now

### Text

Normal / on track:
```
Power now
7.0 kW
Safe pace now 12.0 kW
```

Above safe pace:
```
Power now
13.5 kW
1.5 kW above safe pace (12.0 kW)
```

These are the only two sublines. There is deliberately NO above-hard-cap
subline: instantaneous kW above the cap is not a breach, so the subline only
ever compares against the safe pace PELS reacts to. The safe-pace numeric is
therefore visible in every hero state.

"Safe pace now" is intentionally dynamic phrasing — it changes as the hour progresses and energy accumulates. Do not say "OK up to X kW for the rest of this hour", which implies stability.

### Solar now subline (solar homes only)

Directly under the Power now subline, a muted one-liner shows where live
production is going (`packages/shared-domain/src/solar/solarNow.ts`, gates:
fresh sample within 60 s, production ≥ 50 W):

```
Solar now 3.2 kW — 1.1 kW at home, 2.1 kW exported
```

or, when export is under 50 W:

```
Solar now 3.2 kW — all used at home
```

One line, terse noun phrases (never verb-y clauses that wrap mid-thought).
The line is structurally absent in non-solar homes, on stale samples, and
while panels produce under 50 W — the hero never explains why it's missing.
Note: while a home exports, "Power now" (net grid power) is legitimately
negative — the subline is what makes that reading make sense.
Vocabulary registered in `notes/ui-terminology.md` § Solar.

### Power bar

Threshold gauge, not a progress bar. Scale tracks
`max(safe pace × 1.2, hard cap, draw × 1.05)` so both ticks stay on-scale —
the safe pace legitimately rises above the cap late in an under-used hour,
and the cap tick must remain visible in exactly that state.

```
[ managed ][ background ][ free ........... ]
                          ↑ safe pace      ↑ hard cap
```

Segments:

| Segment | Meaning |
|---|---|
| Managed | Load PELS controls |
| Background | Household load PELS cannot control |
| Free | Remaining room before safe pace |
| Overflow | Amount above safe pace (warn tone) |

There is no instantaneous over-hard-cap segment tone: the error story is the
trajectory chip plus the energy bar's projection marker, never the power bar.

Both ticks always render (the cap tick even when safe pace ≥ cap). Marker
values live in the legend row below the bar — `Safe pace now 12.0 kW` /
`Hard cap 15.0 kW` — because tippy tooltips are not discoverable on touch;
the tooltip adds the source explanation on hover.

Supporting text:
```
Managed 3.2 kW · Background 3.8 kW
```

The supporting line is hidden entirely when PELS controls no load
(`controlledKw === 0`) — printing "No managed load active" reads as
stage-direction copy and adds noise on the happy path. Background-only
households see the gauge segments without an underline.

Motion (v2.7.3): the managed segment of the power bar carries a single live
moment while PELS is actively limiting — a 3.5s opacity oscillation
(0.85 ↔ 1.0). Accent green at rest, no hue shift, no scale change. The
animation honours `prefers-reduced-motion: reduce`. Driven by a
`data-limiting` attribute on `.pels-meter-segments__seg--managed`.

---

## Section 2: Energy this hour

### Text

Normal:
```
Energy used this hour
1.0 of 5.0 kWh used
projected 4.4 kWh
[ bar ]
Cheapest hour ahead: 02:00, 0.18 kr/kWh.
```

Projected over budget:
```
Energy used this hour
1.0 of 5.0 kWh used
projected 5.4 kWh         (warn tone on the subline)
[ bar with projection marker in warn tone ]
```

Projection tones: `warning` = projected past the hourly budget (usually cap −
safety margin, but the tighter daily-pacing allocation when that binds — the
budget exists to absorb exactly this); `critical` = projected past the hard
cap's kWh via the shared `isProjectedOverHardCap` predicate (checked before
the warn tolerance, same verdict as the `pels_status` producer flag; never
fires when no cap is known). Critical is what drives the `Above hard cap`
chip and decision-sentence rule 2. The subline keeps a single warn rung
(critical falls through to neutral text) so the red story stays one voice:
chip + projection marker + cap tick.

When the projection pushes the bar's scale up to the cap, the energy bar
renders a warning-toned cap tick at `hardCapKWh` with the value-carrying
legend label `Hard cap this hour N kWh` — the threshold that turned the
projection red, printed in kWh on the bar where the judgement lives. In calm
hours the scale stops at the budget, so the tick stays off-screen and the bar
stays quiet.

No projection available:
```
Energy used this hour
1.0 of 5.0 kWh used
[ bar ]
```

Subtractions (v2.7.3 loveable batch):
- The ⚠ glyph on the projected-overshoot subline was removed. The
  projection marker on the bar plus the `Above budget` chip already carry
  the tone — the glyph read as a Windows-toolbar artifact.
- The `38 min left` subline was removed. The projection marker on the bar
  implies the time axis already; the line was tautological.

Additions (v2.7.3 loveable batch):
- An *anticipation subline* renders beneath the energy bar surfacing the
  cheapest upcoming hour from the price horizon, e.g.
  `Cheapest hour ahead: 02:00, 0.18 kr/kWh.`. The magnitude is rendered via the
  shared `CostDisplay` divisor (øre → kr, ÷100), matching the smart-task and
  Budget surfaces so the same price never reads as øre on one tab and kr on the
  next. It is suppressed when no
  upcoming price data exists or when the payload is stale (latest entry
  more than 6h in the past). The helper
  (`formatCheapestUpcomingHour`) lives in shared-domain so the runtime
  logger can emit the same line.

Projection formula: `projectedKWh = usedKWh + (currentKw × minutesRemaining / 60)`

### Energy bar

Standard Material linear progress bar with a projected-end marker.

```
                ↓ projected end
[ used ====== ][ remaining budget ........ ]
```

- Filled = kWh used
- Empty = remaining budget
- Projected marker: warning tone if beyond budget
- The projected-end label sits *above* the bar so the eye reads "projection
  → bar" top-down, matching the Normal/Projected-over-budget text sketches
  in § "Section 2: Energy this hour" (`projected 4.4 kWh` above `[ bar ]`).

---

## Decision sentence

Required. One plain-language conclusion at the bottom of the card.

Source of truth in code: `packages/shared-domain/src/planHeroSummary.ts`
(`buildDecisionSentence`). The settings-UI hero (`PlanHero.tsx`) is a thin
adapter that maps device arrays + projection tone to the helper's counts and
booleans. Keep this ladder in sync — the code comment cross-links back to
this section.

Voice (v2.7.3): named-subject declarative copy. The *house* is the subject;
PELS is never first-person. No em-dash diagnostic shape ("Doing X — because
Y"). No exclamation marks (Nordic register). Action first, then the
constraint that motivates it. The runtime logger imports this helper so log
lines mirror the on-screen wording verbatim (see
`feedback_ui_text_shared_with_logs.md`).

Priority order (first matching condition wins):

1. No data: `Power readings have dropped. Devices stay limited until data returns.`
2. Above hard cap (trajectory — projected hour past the cap's kWh):
   `On pace to exceed the hard cap this hour. Easing devices off.`
   The action clause renders only while a controllable managed device is
   still drawing — the trajectory alone does not imply PELS has load left to
   act on (an hour that already banked the energy with everything settled off
   drops to the bare `On pace to exceed the hard cap this hour.`). Under
   Simulation mode the action clause is likewise dropped, because PELS is not
   acting (rule 3's hypothetical-voice principle applies here too).
   When the managed shed cascade is exhausted (no controllable managed device
   is still running to ease off) and the remaining breach is attributed to a
   device with Power-limit control turned off, the copy stops promising
   mitigation PELS has finished and names the user's recourse instead:
   `Managed devices are already eased off. The remaining draw is from a device
   that has Power-limit control turned off. Turn its Power-limit control back
   on so PELS can ease it off.` The recourse pluralises when several
   control-off devices breach; the hard cap is never offered as a remedy
   (see `notes/ui-terminology.md` § "Hard cap is an hourly ceiling").
3. Simulation mode would act: `2 devices would be limited right now.`
   The slim simulation banner and the `Simulation mode` status chip already
   name simulation on the Overview, so this conclusion drops the redundant
   "if simulation mode were off" tail — simulation is stated at most twice on
   the first viewport. It stays hypothetical (`would`), never implying PELS
   acted.
4. Actively limiting: `Holding back 2 devices so the house stays under 12.0 kW.`
   The safe-pace clause is dropped when the value is unavailable
   (`Holding back 2 devices.`).
5. Restoring: `Bringing 1 device back online. Power has stayed under the safe pace.`
6. Projected over budget: `On pace to overshoot this hour’s energy budget.`
   Fires when no devices are being limited or resumed but the projected hour
   energy trips the `warning` projection tone (the `critical` tone — past the
   cap — is rule 2), so the conclusion stays consistent with the
   `Above budget` status chip surfaced by `resolveHeroStatus`.
7. On track: `Quiet hour. Nothing to do.`

Simulation mode wording must be hypothetical throughout. The subject is the
device count, not PELS:
- `2 devices would be limited right now.`
- Not: `Limiting 2 devices` (implies PELS acted when it did not).
- Not: `… if simulation mode were off.` — a third naming of simulation on a
  viewport that already carries the banner + status chip (signal-diet: state
  simulation at most twice).

---

## Smart-task row (between the hero and the device cards)

One slim tappable pointer row (tap → the Smart tasks tab via the shell's
`[data-settings-target]` delegate). The failing-recovering visitor lands on
Overview, so the persona P0 (failure renders differently, first sentence,
one-tap recourse) needs a smart-task signal here. Ladder + copy live in
`packages/shared-domain/src/overviewSmartTaskRow.ts`; at most ONE row ever:

1. live `Cannot finish` (`{Device} — Cannot finish · Due HH:MM`, alert) — a
   failure the owner can still prevent outranks post-hoc diagnosis;
2. recent-miss rollup (`{Device} — 3 of last 4 runs missed`, alert — the
   Smart-tasks archive's `formatMissStreakAggregateLine` verbatim);
3. live `At risk` (`{Device} — At risk · Ready by HH:MM`, warn);
4. paused (compressed widget words `Unplugged` / `Can’t resume`, warn);
5. steady: `N smart tasks · on track` (muted), counting only genuinely
   on-track tasks (`on_track`/`queued`) — the row is a fixture, not an
   apparition: rendering only in crisis would make the owner meet an
   unfamiliar element for the first time under stress;
6. nothing at all when no on-track tasks and no recent misses (a set that is
   only building-plan or satisfied renders nothing — claiming "on track"
   there would overclaim).

The leading status dot reinforces the tone but never carries it alone; the
device name ellipsizes at 320 px, the status text never truncates. Statuses
derive from the SAME `resolveSmartTaskListStatus` the Smart-tasks list uses
(the Overview active-plans pick was widened to carry `pending`/
`pendingReason`), so the two surfaces can never disagree.

## Device cards (separate from hero)

Cooldown details and per-device status belong in the per-device cards below the hero, not in the hero itself. The hero only shows aggregate counts in the decision sentence.

### Device card grammar (2026-07 legibility pass)

One anatomy for all three card variants (`PlanTemperatureCard`, `PlanSteppedCard`, `PlanGenericCard`); the shared resolvers live in `packages/shared-domain/src/planCardGrammar.ts`:

1. **Title row + at most ONE status chip** (ladder: "Let it run now" rescue action → starvation badge `Budget limited` (info) / `Low power` (warn), only while the card reads held → `Boost` → `Always on`). The **Smart task** badge is an identity/route badge, not a status — it may coexist with the one status chip. The generic card's cooldown countdown ring still anchors on a transient state chip while a countdown runs.
2. **State row**: the bold canonical state word (`Running` / `Idle` / `Limited` / `Resuming` / `Manual` / `Unavailable` / `Unknown` — the `notes/ui-terminology.md` device vocabulary) + the right-aligned power fact (`1.2 kW`, `≈ 1.0 kW when active`, `Reported 2.1 kW`). The temperature card's old bare `On`/`Off` slot and the stepped card's `Level: 6 A`/`Off now` bold slot are retired.
   - A hold/wait reason **upgrades `idle` to `held` for display** — `Idle` beside a "waiting to resume" reason would contradict the canon (Idle = PELS is not holding it back).
   - **Simulation renders the factual device state**: `held`/`resuming` are PELS-acted claims, so under simulation the bold word shows what the device is actually doing and the hypothetical action lives only in the reason line ("Would be limited …"). The rescue action chip is suppressed under simulation (nothing to release).
3. **One modality fact line**: temperature `20.3 °C · target 22 °C` (arrow `→` reserved for a target *change*, e.g. a solar/boost lift); stepped `Charging · level 6 A` or `Level 6 A` plus the step rail; generic none.
4. **At most ONE reason line**, exception-only: plan reason → EV smart-task state line (generic) / exceptional EV state (stepped) / idle-classification status (temperature). Quiet states (Running normally, Idle) render no reason — the old "Maintaining level" filler and the duplicated unresponsive chip+line are gone.

### Device card state styling (plain neutral surface)

Device cards are plain neutral surfaces — **no tonal-container background, no left state-rail, no per-state leading chip** (an earlier tonal-container model was tried and reverted; see the `.plan-card` comments in `packages/settings-ui/public/style.css`). State reads through:

- the bold state word (text carries the meaning),
- role-toned status text — the state word and the reason line take `--color-state-warning-text` (held) / `--color-state-positive-text` (resuming) / `--color-state-negative-text` (unavailable),
- opacity fades: `unavailable` 0.78, `unknown` 0.6, `idle`/`manual` `.plan-card--dim` 0.74.

Colour never carries meaning alone: the toned text IS the meaning-bearing word.

---

## Data requirements

All live state must come through API endpoints, not settings reads. Settings are only for persisting user configuration.

Values needed for the hero:

```
currentPowerKw          meta.totalKw
managedPowerKw          meta.controlledKw
backgroundPowerKw       meta.uncontrolledKw
safePaceKw              meta.softLimitKw
softLimitSource         meta.softLimitSource  (capacity | daily | both)
hardCapKw               meta.hardCapLimitKw
hourUsedKWh             meta.usedKWh
hourBudgetKWh           meta.budgetKWh
minutesRemaining        meta.minutesRemaining
projectedHourKWh        computed: usedKWh + (currentKw × minutesRemaining / 60)
freshnessState          powerStatus.powerFreshnessState
dryRunEnabled           bootstrap setting `capacity_dry_run`; show as `Simulation mode` in UI copy
limitedDeviceCount      count plan devices where currentState=shed
restoringDeviceCount    count plan devices where plannedState=restore
wouldLimitCount         simulation mode only: count where plannedState=shed and currentState≠shed
```

---

## Debug logging

The overview redesign should have its own debug topic (e.g. `overview2`) separate from any existing overview topic. This enables viewing the history of hero, device summary, and device card changes independently without noise from other subsystems.

Log on every render cycle: hero inputs, computed values (projected kWh, safe pace source), decision sentence chosen, device counts.

---

## Design principles (apply to all overview work)

1. **API endpoints only** for frontend–backend communication. Never read a setting to display live state. Settings are for persisting user configuration; API responses carry live state.
2. **One card, one question.** Hero = are we on track? Summary card = what is each device doing?
3. **Simulation mode is hypothetical.** If PELS did not send a command, the UI must not imply it did.
4. **Colour never carries meaning alone.** Chip label and decision sentence must be readable without colour context.
5. **Safe pace is dynamic.** Never phrase it as a fixed allowance for the rest of the hour.
