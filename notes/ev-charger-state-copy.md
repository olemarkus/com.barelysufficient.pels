# What an EV charger card is allowed to say

The device card must not assert a cause it cannot observe. This note is the
matrix of record for that: which signals exist, what each combination actually
means, and the copy each one earns.

Governs `resolveSteppedEvExceptionLabel` and `resolveSteppedLevelFact`
(`packages/shared-domain/src/planSteppedCardText.ts`). Vocabulary rules live in
`notes/ui-terminology.md`; the car association itself in `notes/ev-car-link/README.md`.

## Four signals, not three

The two charger capabilities are frequently collapsed into "the charger's state".
They are different things, and a third and fourth signal sit either side of them:

| # | Signal | Source | Means |
|---|---|---|---|
| 1 | Desired state / target step | PELS's plan | What PELS **wants** |
| 2 | `evcharger_charging` | Charger, settable | What the device has been **told** — by PELS *or anyone else* |
| 3 | `evcharger_charging_state` | Charger, read-only | What is **happening** |
| 4 | `ev_charging_state` | The associated car | What the **car** says is happening |

Signal 2 is the charger's *control* capability — the one PELS writes
(`getControlCapabilityId`, `lib/device/managerControl.ts`). Its read-back is
stored as an observation, which makes it easy to mistake for signal 3; it is not.
It is the command state, and a vendor app, a Homey flow, or the charger's own
panel can change it under PELS.

Signal 4 exists only for a charger the user has ticked a car for. Absent it, rows
below marked *unknown* stay unknown — the card says what PELS knows, never what
it guesses.

## What each divergence means

| Divergence | Meaning |
|---|---|
| 1 ≠ 2 | The command was changed by something other than PELS. **This** is external interference; PELS models it with external-off holds. |
| 2 ≠ 3 | The command is not being honoured: the car's own decision, the charger's internal logic, or echo lag. Signal 4 is what separates these. |
| 3 ≠ 4 | The charger and the car disagree about the same physical plug. Always worth a log line; usually a wrong association or a lagging car app. |

**A `true` command with a paused state is not proof of interference.** It is the
common shape of "the car stopped by itself", and it is also documented benign
behaviour: an Easee leaves `evcharger_charging` at `true` across a pause
(`lib/device/AGENTS.md`). PELS already resolves that pair by treating the state enum as authoritative
over the boolean (`resolveEvCurrentOn`, `lib/device/managerControl.ts`). The card should
do the same: **trust signal 3 over signal 2 for what is happening, and signal 1
over signal 2 for what PELS wants.**

## The matrix

Charger-only rows — everything PELS could say before the car association:

| Charger state | Command | Meaning | Copy |
|---|---|---|---|
| `plugged_out` | any | Nothing connected | **Unplugged** |
| `plugged_in_charging` | `true` | Drawing | *no reason line* — the fact line carries `Charging · level 6 A` |
| `plugged_in_charging` | `false` | Drawing while told not to | **Charging** — state wins; log the divergence |
| `plugged_in_paused` | any | Halted | **Paused** |
| `plugged_in` | `true` | Told to deliver, no current — **the car is the holdout** | **Waiting for car** |
| `plugged_in` | `false` | Switched off; nothing is on offer | **Not charging** |
| `plugged_in_discharging` | any | V2G export | **Discharging** |

Rows 5 and 6 are the ones that have caused trouble. "Waiting for car" was
originally asserted from PELS's *intent* alone, which blamed the car for a
charger PELS had left idle; #1973 narrowed that to "PELS commanded a powered
step", and 2026-08 replaced it outright with signal 2. Intent was never the
right question — twice over:

- It is an inference about the car from PELS's own state, not an observation.
- It is wrong whenever PELS is not the one in control. For a device with
  Power-limit control off, the planner's keep path still fills `targetStepId`
  with a powered step (`resolveSteppedKeepDesiredStepId`), so an idle,
  switched-off charger read as a charge command PELS never sent. Prod
  2026-08-04, `Elbillader`: control off, charger `false`, both charger and car
  plugged in and idle — the card said **Waiting for car**.

Signal 2 answers it directly and needs no car: current can only flow when the
charger has been told to deliver it, so a `true` command with no current *is*
the car declining, whoever set the command. What the association adds is not the
claim but the two contradiction rows the charger alone can never produce.

Every device this copy applies to has signal 2. The transport recognizes the
charger's SDK binding and exposes only normalized binary observation inward, so
the observer always resolves a concrete `on`/`off`, never `not_applicable`.
There is no step-only-charger case needing a fallback.

Car rows — these refine only the cells the charger leaves ambiguous, and all of
them require signal 2 `true`:

| Charger state | Command | Car says | Reading | Copy |
|---|---|---|---|---|
| `plugged_in` | `true` | *no association* | The charger was told to charge and no current flows | **Waiting for car** |
| `plugged_in` | `true` | `plugged_in` / `plugged_in_paused` | The car is declining to draw — confirmed by the car | **Waiting for car** |
| `plugged_in` | `true` | `plugged_in_charging` | Charger sees nothing, car thinks it is charging | **Car and charger disagree** |
| `plugged_in` | `true` | `plugged_out` | The car says it is not plugged in at all | **Not charging** + the association is suspect; drop it |
| `plugged_in` | `false` | any, incl. `plugged_in_charging` | Switched off; a car still reporting charge is lagging the off command, not contradicting it | **Not charging** |
| `plugged_in_paused` | any | `plugged_in_paused` | Both agree the car paused itself | **Paused by the car** |
| `plugged_in_paused` | any | `plugged_in` | Charger halted, car merely idle | **Paused** |

The `false` row deliberately withholds the contradiction label: right after an
off command a car app that still says `plugged_in_charging` is the expected lag,
and reporting it would print "Car and charger disagree" on every shed until the
car catches up. The paused rows do not consult the command at all — they
discriminate signal 3 against signal 4, and an Easee leaves the boolean `true`
across a pause anyway.

Nothing here depends on PELS controlling the device. An unmanaged charger can be
charging or idling exactly as a managed one can; it simply is not PELS's
decision, and the card's bold state word already reads **Manual** to say so.

## Stopped, versus never started

The rows above treat "the car is not drawing" as one state. The charger separates
it into two, and PELS already makes the distinction in
`classifyEvCarSelfStop` (`lib/device/evCarLink.ts`):

| Charger evidence | Car | Meaning | Copy |
|---|---|---|---|
| believes it is delivering (`plugged_in_charging`, or commanded on) **and** draw ≤ idle | `plugged_in` | It was going and the car stopped — `car_not_charging` | **Car stopped charging** |
| believes it is delivering **and** draw ≤ idle | `plugged_in_paused` | The car's own schedule or smart-charging — `car_schedule_hold` | **Paused by the car** |
| not asserting delivery (commanded off) | not charging | Nothing is on offer | **Not charging** |

"Waiting" and "stopped" are different claims and the charger is what tells them
apart: a charger that believes current is flowing while nothing is drawn has been
refused by the car. That is the strongest statement available — and it is as far
as it goes, because *why* the car refused is exactly what the car cannot report.

**The card cannot make the waiting/stopped distinction, and does not try.**
Separating them needs the session history `classifyEvCarSelfStop` keeps (did
current ever flow this session?); the card sees one instant, so a commanded-on
charger drawing nothing reads **Waiting for car** whether or not a session
started earlier. `Car stopped charging` is the self-stop producer's vocabulary
and is not card copy today.

## Rules

1. **Never name a cause PELS cannot observe.** A charger commanded off is
   `Not charging` and nothing more — whatever PELS intended, and whatever the
   car reports.
2. **Signal 2 answers "is anything on offer", and it is the gate for every
   car-holdout claim.** PELS's own intent (signal 1) answers nothing here: it is
   not a command, and for an unmanaged device it is not even PELS's to have.
3. **Signal 3 answers "what is happening", not signal 2.**
4. **Contradictions are reported, not smoothed** — once the charger is actually
   delivering. Rows 3 and 4 of the car table are states PELS previously could not
   see; they mean something is wrong, and quietly picking one side hides it. A
   car lagging behind an off command is not one of them.
5. **Never say `Car is full`.** There is no such observation, and no fixed value
   behind it: a charge limit is a user setting that changes, and the car side
   cannot see it at all. The Polestar app maps both `CHARGING_STATUS_DONE` and
   `CHARGING_STATUS_IDLE` to the same `plugged_in`, so "finished at the limit",
   "idle", and "charging fault" are one indistinguishable state
   (`notes/ev-car-link/README.md`). The honest ceiling is what was observed:
   **the car stopped accepting charge**.
