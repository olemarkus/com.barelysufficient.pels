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
│ Safe pace now: 12.0 kW                      │
│                                              │
│ [managed][other][free.................]      │
│                  ↑ 12.0            ↑ Hard   │
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
| Power above safe pace, hard cap not breached | `Above safe pace` | warning |
| Power above hard cap | `Above hard cap` | error |
| Simulation mode enabled and PELS would act | `Simulation mode` | warning |
| Power data stale or fail-closed | `No data` | error |

### Freshness chip

Show only when not `fresh`. Hide when live data is current.

### Mode (page chrome, not hero chip)

The current operating mode is surfaced on the Settings page (under "Mode:") and
in the modes editor, not on the Overview hero. Settings rendering uses
`formatModeSummary` from `packages/settings-ui/src/ui/modeLabels.ts`, which
emits the English structural prefix `Mode:` before the user-authored mode
name (e.g. `Mode: Hjemme`) to avoid the mid-phrase code-switch that
`{name} mode` produced at non-English locales.

### Info button

Small Material icon button (`info`) at top-right. Tooltip / dialog:

```
Power now is measured in kW — how fast electricity is being used right now.
Energy this hour is measured in kWh — how much has been used so far this hour.
Safe pace is the highest power rate that keeps this hour on track for the energy budget.
kW is speed. kWh is distance.
```

---

## Section 1: Power now

### Text

Normal / on track:
```
Power now
7.0 kW
Safe pace now: 12.0 kW
```

Above safe pace:
```
Power now
13.5 kW
1.5 kW above safe pace
```

Above hard cap:
```
Power now
13.5 kW
0.5 kW above hard cap (5.0 kW)
```

"Safe pace now" is intentionally dynamic phrasing — it changes as the hour progresses and energy accumulates. Do not say "OK up to X kW for the rest of this hour", which implies stability.

### Power bar

Threshold gauge, not a progress bar. Scale anchored to hard cap or a rounded max above it — never to the dynamic safe pace.

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
| Overflow | Amount above safe pace or hard cap (error tone) |

Marker labels: show inline where space allows; collapse to info tooltip on narrow screens.

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
Cheapest hour ahead: 02:00, 18 øre/kWh.
```

Projected over budget:
```
Energy used this hour
1.0 of 5.0 kWh used
projected 5.4 kWh         (warn tone on the subline)
[ bar with projection marker in warn tone ]
```

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
  `Cheapest hour ahead: 02:00, 18 øre/kWh.`. It is suppressed when no
  upcoming price data exists or when the payload is stale (latest entry
  more than 6h in the past). The helper
  (`formatCheapestUpcomingHour`) lives in shared-domain so the runtime
  logger can emit the same line.

Projection formula: `projectedKWh = usedKWh + (currentKw × minutesRemaining / 60)`

### Energy bar

Standard Material linear progress bar with a projected-end marker.

```
[ used ====== ][ remaining budget ........ ]
                ↑ projected end
```

- Filled = kWh used
- Empty = remaining budget
- Projected marker: warning tone if beyond budget

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
2. Above hard cap: `Over the hard cap right now. Easing devices off.`
3. Simulation mode would act: `2 devices would be limited if simulation mode were off.`
4. Actively limiting: `Holding back 2 devices so the house stays under 12.0 kW.`
   The safe-pace clause is dropped when the value is unavailable
   (`Holding back 2 devices.`).
5. Restoring: `Bringing 1 device back online. Power has stayed under the safe pace.`
6. Projected over budget: `On pace to overshoot this hour’s energy budget.`
   Fires when no devices are being limited or resumed but the projected hour
   energy already trips the `warning` / `critical` projection tone, so the
   conclusion stays consistent with the `Above budget` status chip surfaced
   by `resolveHeroStatus`.
7. On track: `Quiet hour. Nothing to do.`

Simulation mode wording must be hypothetical throughout. The subject is the
device count, not PELS:
- `2 devices would be limited if simulation mode were off.`
- Not: `Limiting 2 devices` (implies PELS acted when it did not).

---

## Device summary card (separate from hero)

Cooldown details and per-device status belong in a separate summary card below the hero, not in the hero itself. The hero only shows aggregate counts in the decision sentence.

Summary card shows counts: running · limited · resuming · starved · boosted.

Individual device cards show cooldown timers, reason text, and step details.

### Device card state styling (M3 tonal containers)

Device cards encode state with a tonal-container background plus the leading state chip — no colored left-edge stripe (that pattern is M2 / iOS / Bootstrap-alert, not M3). State rules bind directly to flat `--color-state-*-bg` / `-border` tokens (the deprecated `--pels-status-*-surface` shims are kept only until the chart-token P0 in `TODO.md` migrates the chart consumers off them):

- `held` → warning tone: `--color-state-warning-bg` / `-border`. (Held is an intentional power-shedding state, not a failure — warn, not danger.)
- `resuming` → positive tone: `--color-state-positive-bg` / `-border`. (Recovering toward normal — distinct from `held` so it never reads as still-stuck.)
- `unavailable` → danger tone: `--color-state-negative-bg` / `-border` plus 0.78 opacity.
- `unknown` → no tint, but 0.6 opacity so missing-state cards visibly recede.
- `active` → default outlined surface (`--color-surface-1`).
- `idle`, `manual` → default outlined surface plus `.plan-card--dim` (0.74 opacity).

For most card types (`PlanGenericCard`, `PlanSteppedCard`) state is also conveyed by the leading `.plan-state-chip` so colour never carries meaning alone. `PlanTemperatureCard` is an exception: it does not render a state chip, so the dim opacity + the `On`/`Off` readout carry the signal. Idle/manual temperature cards mute the `Off` readout to `--text-secondary` with regular weight so the running siblings' bold `On` reads as the foreground state.

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
