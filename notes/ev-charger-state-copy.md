# What an EV charger card is allowed to say

The device card must not assert a cause it cannot observe. This note is the
matrix of record for that: which signals exist, what each combination actually
means, and the copy each one earns.

Governs `resolveSteppedEvExceptionLabel`
(`packages/shared-domain/src/evChargingStateLabel.ts`, where raw plug states are read)
and `resolveSteppedLevelFact` (`lib/plan/planSteppedCardText.ts`). Vocabulary rules live in
`notes/ui-terminology.md`; the car association itself in `notes/ev-car-link/README.md`.

## Session states

Signal 3 below is carried as PELS's own session vocabulary (`EvChargingState`,
`packages/contracts/src/types.ts`). It holds Homey's five
`evcharger_charging_state` values and three more that an integration resolves
from its app's own states. Each state says what the session is doing and whose
move it is, and so admits one answer to a wish to charge
(`resolveEvChargeAction`, `packages/shared-domain/src/evPlugState.ts`):

| State | Meaning | Whose move | A wish to charge |
|---|---|---|---|
| `plugged_out` | No car | nobody | blocked |
| `plugged_in` | A car is connected and nothing more is known | unknown | `start`: PELS tries one |
| `plugged_in_awaiting_start` | No session is open; a start command opens one | PELS | `start` |
| `plugged_in_paused` | An open session the charger holds off | PELS | `resume` |
| `plugged_in_waiting_for_charger` | The charger has not started the session: it waits for authorisation, its schedule or its load balancing | the charger | `wait`: PELS sends nothing |
| `plugged_in_finished` | The car has stopped asking for power | the car | `offer`: PELS keeps current on offer and never starts a new session |
| `plugged_in_charging` | Delivering | PELS | `keep`: pause it or set its current |
| `plugged_in_discharging` | Exporting | nobody | blocked |

`blocked` and `wait` states take no command (`isEvPlugStateCommandable`), and
each has its reason line (`EV_BLOCK_REASONS`). How a `start`, `resume` or
`offer` is carried out is the integration's: an Easee under built-in control
resumes and offers by current and starts by its switch.

An integration maps what its app can tell apart, and no more:

| Integration | App state | Session state |
|---|---|---|
| Easee | `Car connected`, `Awaiting Authentication`, `Deauthenticating` | `plugged_in_awaiting_start` |
| Easee | `Paused` | `plugged_in_paused` |
| Easee | `Completed` | `plugged_in_finished` |
| Easee | `Standby`, `Offline`, `Error` | `plugged_out` |
| Zaptec | `plugged_in` (connected, session not started) | `plugged_in_waiting_for_charger` |
| Zaptec | `plugged_in_paused` (paused, or ended by the car: one value for both) | `plugged_in_paused` |
| Tesla | `Complete` | `plugged_in_finished` |
| Tesla | `Stopped`, `Starting` | `plugged_in_paused` |
| go-e | `car_finished`, switch on | `plugged_in_finished` |
| go-e | `station_waiting`, switch on | `plugged_in` |
| go-e | switch off | `plugged_in_paused` |

An app that publishes only Homey's values, or whose states do not separate a
finished session from an idle one (amina, Smappee, Wallbox, a Flow-reported
charger), keeps `plugged_in` for a connected car that takes no power.

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

### Vehicle sessions that PELS cannot control

The vehicle adapter resolves session status independently of its control
permission. A physically available Tesla reporting `Disconnected` or
`Complete` reads **Idle** with `Unplugged` or `Not charging`. This terminal
presentation overrides a retained off state, hold, or starvation reason;
simulation uses the same factual state. It does not grant charging permission.
The known battery level may accompany the fact, without a retained level rail
or expected charging power.

A Tesla PELS does not control always says why (owner, 2026-11-14).
**Unavailable is Homey's word, not PELS's**: only a battery device Homey reports
unavailable (`Homey reports this device unavailable`), or one with no accepted
reading since a trust gap (`Waiting for Homey to report this device`), reads
**Unavailable**. Otherwise:

| Session | State | Reason line |
|---|---|---|
| `Disconnected` | **Idle** · `Unplugged` | none: the fact says it |
| `Complete` | **Idle** · `Not charging` | `The car finished charging` |
| `NoPower` | **Idle** | `The charger is not supplying power` |
| Control charging through this car is off | **Manual** | `Turn on “Control charging through this car” to let PELS control charging` |
| Unresolved charging state | **Idle** | `The car has not reported its charging state`, or `The car is preparing to charge` for `Calibrating` |
| No AC cable | **Idle** · plug state | `No AC charging cable is connected` |
| DC charging | **Manual** | `The car is on a DC charger` |
| Car asleep or offline | **Idle** · plug state | `The car is asleep or offline` |
| Car driving / not in Park | **Idle** · plug state | `The car is driving` / `The car is not in Park` |
| Coordinates away from home | **Manual** | `The car is not at home` |
| Homey's location not set | **Manual** | `Set your Homey’s location so PELS can tell when the car is home` |

**Idle** means the car is not charging; **Manual** means it may be charging
where PELS cannot control it. A car whose battery still reports `Charging` is
never **Idle**, whichever check failed. **Manual** keeps the plug fact, so the
battery level stays on the card. Pairing gaps read **Manual** and name the device
involved: `Add this car’s Car device from the
Tesla app`, `More than one Car device matches this car`, `More than one Location
device matches this car`, `Homey reports the car’s Car device unavailable`,
`Homey reports the car’s Location device unavailable`, `The car has not
reported its location`, `The car’s location has no time` and `The car’s
location has a time in the future`. Before Homey's first full device list,
`Waiting for Homey to list the car’s devices`. Source:
`NOT_HOME_REASONS` in `lib/device/tesla/session.ts`. None of these grant charging
permission; the known battery level may accompany the fact, without a retained
level rail or expected charging power.

### Charger and associated-car observations

Charger-only rows — everything PELS could say before the car association:

| Charger state | Command | Meaning | Copy |
|---|---|---|---|
| `plugged_out` | any | Nothing connected | **Unplugged** |
| `plugged_in_charging` | `true` | Drawing | *no reason line* — the fact line carries `Charging · level 6 A` |
| `plugged_in_charging` | `false` | Drawing while told not to | **Charging** — state wins; log the divergence |
| `plugged_in_paused` | any | Halted | **Paused** |
| `plugged_in` | `true` | Told to deliver, no current — **the car is the holdout** | **Waiting for car** |
| `plugged_in` | `false` | Switched off; nothing is on offer | **Not charging** |
| `plugged_in_awaiting_start` | `true` / `false` | As `plugged_in`: no session runs yet | **Waiting for car** / **Not charging** |
| `plugged_in_finished` | any | The car has stopped asking for power | **Charging finished** |
| `plugged_in_waiting_for_charger` | any | The charger has not started the session | **Waiting for charger** |
| `plugged_in_discharging` | any | V2G export | **Discharging** |

Rows 5 and 6 are the ones that have caused trouble. "Waiting for car" was
originally asserted from PELS's *intent* alone, which blamed the car for a
charger PELS had left idle; #1973 narrowed that to "PELS commanded a powered
step", and 2026-08 replaced it outright with signal 2. Intent was never the
right question — twice over:

- It is an inference about the car from PELS's own state, not an observation.
- It is wrong whenever PELS is not the one in control. For a device with
  Power-limit control off, the planner's keep path still fills `desiredStepId`
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

Car rows refine only the cells the charger leaves ambiguous. **Current on
offer** is the observer-resolved `currentState`: `off` when the binary command
is off or the reported step is 0 W.

| Charger state | Current on offer | Car says | Reading | Copy |
|---|---|---|---|---|
| `plugged_in` | `on` | *no association* | The charger was told to charge and no current flows | **Waiting for car** |
| `plugged_in` | `on` | `plugged_in` / `plugged_in_paused` | The car is declining to draw — confirmed by the car | **Waiting for car** |
| `plugged_in` | `on` | `plugged_in_charging` | Charger sees nothing, car thinks it is charging | **Car and charger disagree** |
| `plugged_in` | `on` | `plugged_out` | The car says it is not plugged in at all | **Not charging** + the association is suspect; drop it |
| `plugged_in` | `off` | any, incl. `plugged_in_charging` | Switched off; a car still reporting charge is lagging the off command, not contradicting it | **Not charging** |
| `plugged_in_paused` | `on` | `plugged_in_charging` | Charger halted while offering current, car thinks it is charging | **Car and charger disagree** |
| `plugged_in_paused` | `off` | `plugged_in_charging` | Current is switched off; the car is lagging the pause | **Paused** |
| `plugged_in_paused` | any | `plugged_in_paused` | Both agree the car paused itself | **Paused by the car** |
| `plugged_in_paused` | any | `plugged_in` | Charger halted, car merely idle | **Paused** |

The `off` rows deliberately withhold the contradiction label: right after an
off command a car app that still says `plugged_in_charging` is the expected lag,
and reporting it would print "Car and charger disagree" on every pause until the
car catches up. This applies to both idle and paused charger states. An Easee
can leave its boolean command `true` across a pause, but the observer still
resolves `off` at a 0 W step.

Nothing here depends on PELS controlling the device. An unmanaged charger can be
charging or idling exactly as a managed one can; it simply is not PELS's
decision, and the card's bold state word already reads **Manual** to say so.

## Stopped, versus never started

The rows above treat "the car is not drawing" as one state. The charger separates
it into two, and PELS already makes the distinction in
`classifyEvCarSelfStop` (`lib/device/evCarLink.ts`):

| Charger evidence | Car | Meaning | Copy |
|---|---|---|---|
| delivered this session, now draws ≤ idle, not paused by PELS or holding `plugged_in_paused` | `plugged_in` | It was going and the car stopped — `car_not_charging` | **Car stopped charging** |
| the same | `plugged_in_paused` | The car's own schedule or smart-charging — `car_schedule_hold` | **Paused by the car** |
| never delivered this session, or PELS told it to stop | not charging | Nothing is on offer | **Not charging** |

"Waiting" and "stopped" are different claims and the session history is what tells
them apart: a charger that was delivering, and that nobody told to stop, has been
refused by the car. That is the strongest statement available — and it is as far
as it goes, because *why* the car refused is exactly what the car cannot report.

**The card cannot make the waiting/stopped distinction, and does not try.**
Separating them needs the session history `classifyEvCarSelfStop` keeps (did
current ever flow this session, and did PELS stop it?); the card sees one instant, so a commanded-on
charger drawing nothing reads **Waiting for car** whether or not a session
started earlier. `Car stopped charging` is the self-stop producer's vocabulary
and is not card copy today.

## Rules

1. **Never name a cause PELS cannot observe.** A charger commanded off is
   `Not charging` and nothing more — whatever PELS intended, and whatever the
   car reports. On a card whose state word is already `Off`, the fact line
   leaves it out, because it would only restate that word; under `Manual` it
   stays.
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
