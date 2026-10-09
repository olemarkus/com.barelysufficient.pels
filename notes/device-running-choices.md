# Device running choices

**Proposal, 2026-09-28. Nothing here is implemented.** Quoted answer labels are
drafts; once settled they move to `notes/ui-terminology.md`. Every behavioural
claim below was checked against `origin/main` at `8b60a3703`; cite the code, not
this note, when the two disagree.

## Why

The device page asks owners to set mechanisms: Managed by PELS, Power-limit
control, Only PELS starts this device, Leave off until turned on again, Budget
exempt, and one of three solar switches. Owners arrive with a goal for a device,
and no switch is named after a goal. Common answers in the community thread
([PELS thread](https://community.homey.app/t/app-pro-pels-energy-manager-power-control-and-cheaper-hour-scheduling-for-ev-charging-heating-and-hot-water/147496))
require a recipe of two or three switches:

| Post | Owner's goal | Answer given |
|---|---|---|
| #7, #67 | Keep a device off after I, or my automation, turn it off | Disable capacity control with a Flow, then turn the device off. Later: Leave off until turned on again |
| #27, #47 | My Flows heat the water heater in cheap hours; PELS should only protect the cap | Managed, and Flows that enable and disable capacity control |
| #128 | A change on the heat pump's remote should stick | When the temperature changes outside PELS → Save as current mode target |
| #162–163 | Run a relay-switched water heater in the cheapest hours | Flows today; an energy-amount smart task is proposed. Price-based control is for temperature devices only |
| #167 | Which devices wait for cheaper hours? | Only devices with a smart task; "Use cheaper hours" under daily budget is something else |
| #170 | Don't let the charger start before its smart task | Power-limit control **off**, Only PELS starts this device on, "PELS still keeps it under your hard cap" |
| #123 | Charge the car on solar surplus only | Charge on solar surplus |

#170 shows the failure most clearly: to give PELS more control, the owner turns off
the switch named Power-limit control, and then has to be told the power limit
still holds.

The fix is to ask the owner the questions they arrive with, as the existing
**When the temperature changes outside PELS** control already does, and derive
the answer from the settings that exist today.

## Constraints

1. **Storage does not change.** Every answer is a predicate over existing keys,
   and choosing an answer is a write set over those keys. Flow cards keep
   writing the same keys, so existing Flows keep working.
2. **The page shows what the current settings produce.** There is no separately
   stored preference to show instead: `enable_device_capacity_control` and
   `disable_device_capacity_control` write `controllable_devices` itself
   (`flowCards/deviceSettingsCards.ts`, `registerDeviceCapacityControlCards`). Adding a standing preference
   beside Flow overrides would be a larger product change and is out of scope.
3. **Opening the page writes nothing.** A stored combination that matches no
   answer is described in plain words, and the owner replaces it explicitly.
4. **Every answer states what it sets, clears and keeps**, including settings
   that are stored but not in force (see the two halves below).
5. **The temperature question stays as it is.** Its three options are exact
   behaviours, not wordings (see Temperature devices).
6. **Allowing beyond the daily budget is its own choice**, not part of a running
   answer.
7. **Labels name outcomes**, and the terms in `AGENTS.md` § "Terms that stay
   internal" stay internal.

## What the stored settings actually encode

Terms used below (code names in brackets):

- **Managed** `managed_devices[id] === true`. Absent means unmanaged
  (`setup/appHostApi.ts`, `AppHostApi.resolveManagedState`).
- **Limit** Power-limit control, `controllable_devices[id] === true`.
- **Solar** `surplusWilling` in the device's `price_optimization_settings` entry.
  **One stored bit behind three switches**: a temperature device gets the
  setpoint lift (Use solar surplus), a plain on/off device gets solar-only running
  (Run on solar surplus), a stepped load or EV charger gets tracking (Match or
  Charge on solar surplus). The device's shape picks which
  (`lib/planInput/planInputDeviceHelpers.ts`, `resolveSurplusPostureForDevice`,
  `lib/plan/planSurplusAbsorb.ts`, `resolveSurplusOnlyPosture` / `resolveSurplusTrackingPosture`), so a control-model change moves
  the opt-in to a different behaviour without the owner touching it.
- **Start policy** `device_start_policies[id]`, `unrestricted` (absent) or
  `pels_only`.
- **Hold opt-in** Leave off until turned on again,
  `respect_external_off_devices[id] === true`. The hold itself is separate
  per-device state (`external_off_hold.<id>`).
- **Exempt** `budget_exempt_devices[id] === true`.

**Standing command authority**, the right to switch an ordinary controllable
device, is `Managed && (Limit || pels_only) && the device has a control axis &&
it has a measured power reading`. The Limit grant already includes Managed in
`AppHostApi.isCapacityControlEnabled`; `resolveDeviceControlPosture` adds the
start-policy grant. Observe-only devices are excluded. A smart task can lend
authority separately; setpoint writes do not require this power-control grant.

### Two halves, one switch between them

For non-temperature devices eligible for solar running or tracking, Limit
selects which of two stored behaviours is in force, and the settings for the
other half stay stored. A thermostat's Solar bit changes its target instead;
its separate mapping below preserves that preference.

| | Limit on | Limit off |
|---|---|---|
| Deciding setting | Solar: keeps running (off) or solar only (on) | Start policy: doesn't start it (`unrestricted`) or only for smart tasks (`pels_only`) |
| Paused setting | Start policy (`resolveStartPolicyInForce`, ruling 2026-09-25) | Solar has no authority under `unrestricted`. Under `pels_only` it has authority, but the start policy wins (`lib/plan/planBuilderSurplus.ts`, `runStandingPostureHolds`, ruling 2026-09-10) |

This is what the Flow cheap-hour recipe relies on: a Flow switches Limit on for
the window and off after it, and the stored settings on each side decide what
the device does in each half. It is also how a hidden rule arises: an owner who
set Only PELS starts this device once, then turned Limit on, still has it stored,
and the next Flow or tap that turns Limit off brings it back.

The page therefore shows **the half in force** as the answer and, when the other
half is not its default or a Flow can switch Limit (below), one line for the
other half: "If power limiting is turned off: runs only for smart tasks."

### Who can change these settings besides the page

| Writer | Changes |
|---|---|
| `enable_device_capacity_control` / `disable_device_capacity_control` | Limit (`flowCards/deviceSettingsCards.ts`, `registerDeviceCapacityControlCards`) |
| `add_budget_exemption` / `remove_budget_exemption` | Exempt. The card writes `false` where the page deletes the entry |
| `allow_smart_task_rescue` | A smart task's own budget and priority permissions, not Exempt |
| Boot migration, every start (`setup/appManagedDeviceMigration.ts`) | Managed becomes `true` for any device with Limit `true` or price enabled and no Managed entry; Limit becomes `true` for a Managed device with neither |
| Turning Managed on in the UI (`deviceDetail/managedOptInLimit.ts`) | Also turns Limit on when the device has a power reading |

No Flow card writes Managed, Solar, the start policy, the hold opt-in, the
temperature policy or the limiting choice. So on the running question a Flow can
only move a device between the two halves.

**Naming the Flows.** `lib/flowApi` already reads the owner's Flows and
recognises one PELS action card with a device argument (the EV battery report,
`lib/flowApi/userFlows.ts`, `parseEvSocReportTarget`). Recognising the capacity-control and
budget-exemption cards the same way lets the page say "The Flow 'Night water'
switches power limiting for this device". That says which Flow can change it,
never when it did, so it needs no new stored state.

This needs a new fact from the Flow adapter and a UI contract; it is not already
available to the page. A failed inventory read cannot prove that no Flow can
switch Limit. Preserve settings regardless of inventory availability, and avoid
claiming a particular Flow ran without event evidence.

## The questions

### 1. When should this device normally run?

The table below covers non-temperature on/off devices, stepped loads and EV
chargers that PELS can control and that have a power reading. Thermostats use
the separate mapping under Temperature devices. Each choice preserves the
independent hold and budget settings; its write set changes only the keys named.

Offer B only where the runtime can produce a solar-running/tracking posture:
the device is eligible, its home's surplus pool is reachable, and the home
supports surplus control. A stored Solar bit alone is insufficient (see
`resolveSurplusPostureForDevice` in `lib/planInput/planInputDeviceHelpers.ts`).
If these prerequisites cease to hold, describe the actual ordinary running
behavior and the inactive saved solar preference. Never call that state
"Only on solar surplus".

Offer C only for a device with a supported smart-task type, as resolved by
`resolveSmartTaskDeviceKind` in `packages/shared-domain/src/smartTaskDeviceKind.ts`,
and a control that can hold it off. An existing `pels_only` choice on a device
without a supported task type is described as held off with no supported task
to start it, with an explicit replacement choice. Opening the page preserves it.

| Answer (draft label) | In force when | Choosing it sets | Clears | Keeps |
|---|---|---|---|---|
| A. "PELS keeps it running and pauses it when power is short" | Managed, Limit, Solar off | Managed, Limit, Solar off | nothing | Start policy (the other half) |
| B. "Only on solar surplus" (on/off) / "Follows the solar surplus" (stepped, EV) | Managed, Limit, Solar on, effective solar-running/tracking posture available | Managed, Limit, Solar on | nothing | Start policy |
| C. "Only when a smart task starts it" | Managed, Limit off, `pels_only` | Managed, Limit off, `pels_only` | nothing | Solar (the other half) |
| D. "When you, a Flow or a smart task starts it" (PELS limits it only while a smart task runs it) | Managed, Limit off, `unrestricted` | Managed, Limit off, `unrestricted` | nothing | Solar |
| E. "Not managed by PELS" | Not Managed | Managed off | nothing | Everything, as today (turning Managed off writes only `managed_devices`) |

For D on a device with no supported task type, omit the smart-task clause:
"When you or a Flow start it". The write set is unchanged.

Choosing an answer must apply its write set as one coordinated change. Reusing
the Managed switch's existing handler would also turn Limit on, contradicting
C or D. The implementation must preserve unrelated devices' entries, handle
partial-save failures honestly, and avoid an intermediate combination starting
a device that the selected answer is meant to hold off. Opening or rendering
an answer must never perform those writes.

C is more than a start rule: `pels_only` grants command authority, so while a
smart task runs the device PELS also limits it under the hard cap like any other
candidate (`lib/plan/shedding/candidates.ts`, `collectSheddingCandidates`). The answer's wording must not
suggest otherwise. Question 4 applies under C; question 5 records the unresolved
budget-exemption mismatch. C needs a power reading
to act at all (`lib/device/temperatureControlPosture.ts`, `resolveDeviceControlPosture`); the page offers the start
policy today to an unmetered device with an on/off switch, where it cannot act.

E and D can differ for a device PELS has turned off. Losing authority can undo
a recorded capacity shed of a non-stepped binary device, if no external-off
hold blocks it (`applyUncontrolledBinaryRestore` in `lib/executor/binaryExecutor.ts`).
It does not undo every off: `ShedDecisions.recordPlannedShed` excludes stepped
devices, solar-only and start-policy holds, and task-lent authority from that
release record. A→C retains authority; B→D does not restart a device held off
for solar; C→D does not restart a device held off by the start policy. Turning
Managed off drops the device from the plan, so it stays off. Recommendation:
choosing E should leave its state alone and explain that an off device stays
off; starting it needs a separate explicit action.

Open decision: whether choosing an answer should also reset the other half to
its default when no Flow can switch Limit. Resetting removes the hidden rule for
owners without Flows; keeping it preserves a Flow recipe the owner may add
later. The recommendation is to keep it and always show the other-half line when
it is not the default, so nothing stays hidden.

What each answer does, verified in code. Except where a row introduces a task
or hold, these are ordinary operation with no active task or external-off hold,
and with admitted readings and device writes available. Task rows apply only
to supported task types.

| Event | A | B | C | D |
|---|---|---|---|---|
| Steady state | PELS starts it when there is room and pauses it when power is short (`lib/plan/restore/devices.ts`, `needsRestoreAdmission`) | Binary loads wait for enough surplus; trackers adjust their level to allocated surplus. Both use settle/dwell rules, with sustained hard-off able to bypass minimum dwell. Tracking stops to the configured limiting action, which may still draw. Boost can override a tracker's solar restriction; see the B exceptions below | Held off (`lib/plan/shedding/startPolicyHold.ts`, `isStartPolicyHeldDevice`) | PELS does not routinely switch it; releasing a recorded capacity shed can produce one final turn-on (`lib/plan/planDevicesBase.ts`, `resolvePlannedState`, `applyUncontrolledBinaryRestore`) |
| Someone turns it off (no hold) | If the previous plan kept it with authority and no new constraint blocks it, the next reading can decide to turn it back on without fresh start admission (`lib/plan/shedDecisions.ts`, `ShedDecisions.lastPlannedKeptIds`) | Same, subject to its solar/tracking and boost rules | Stays off | Stays off |
| Someone turns it on | Re-decided like any change; may be paused | Subject to the solar rules, including settle/dwell, tracking floor and boost exceptions below | Turned off at the next reading | Left alone, counted as background usage |
| A Flow turns Limit off | Moves to C or D per the start policy. A→C retains authority. A→D can release only a recorded capacity shed as described above | Moves to C or D; no unconditional restart, including for a solar-held binary load | n/a | n/a |
| A Flow turns Limit on | n/a | n/a | Start policy pauses (not cleared); moves to A or B | Moves to A or B |
| Smart task, booked hour | Normal admission | The task wins over solar (`lib/plan/planBuilderSurplus.ts`, `resolvePostureExcludeIds` / `runStandingPostureHolds`); in an unclaimed hour the device falls back to its solar/tracking rules (`lib/objectives/deferredObjectives/decorationController.ts`, `resolveAdmittedDeviceIds`) | Hold lifted for booked and unclaimed hours, never for deferred ones (`lib/objectives/deferredObjectives/admission.ts`, `resolveHourClaims`) | The task lends authority (`lib/objectives/deferredObjectives/admission.ts`, `contributesCommandAuthority`) |
| Smart task, deferred hour | Held off (ruling 2026-09-25: the task decides during an active task) | Held off | Held off | Held off |
| Smart task satisfied or deadline passed | Back to A | Back to solar-only | Limiting action re-applied until the device reports it, then held off (`setup/appInit/deferredObjectiveLifecycle.ts`, `handleDeferredTerminalFallback`) | Limiting action re-applied until the device reports it |
| Smart task cleared | Back to A | Back to solar-only | Held off | Left as it is; a running device stays on (the fallback is abandoned with no final command, `lib/objectives/deferredObjectives/statusTransitions.ts`, `emitDeferredObjectiveLifecycleTransitions`, `setup/appInit/deferredObjectiveLifecycle.ts`, `createDeferredObjectiveLifecycleEmitter`) |
| App restart | Shed memory is lost; an off device goes through start admission (`lib/plan/shedDecisions.ts`, `ShedDecisions`) | Surplus eligibility is rebuilt through the normal settle rules; a tracker's boost can still override the solar restriction | Hold re-derived from the stored policy | Unchanged when Managed and Limit are explicitly stored; boot migration can change legacy missing entries |

**B exceptions belong in the visible explanation.** Fixed on/off solar loads
and tracking loads do not share one release threshold: `syncSurplusEligibilityState`
in `lib/plan/admission/surplusAbsorb.ts` applies settle/dwell rules, while the
tracking allocator in `lib/plan/planSurplusAbsorb.ts` supplies its own hard-off
condition from the allocated pool. A boosted tracker bypasses the solar hold
(`isTrackingStopped` in `lib/plan/shedding/surplusHold.ts`). Keep charge boost
beside the tracking choice and explain that it can use grid power. The answer
must not promise exclusive solar operation while a configured boost or a smart
task can override it. Numerical thresholds remain with their owning code.

In every answer the smart task still respects the hard cap. It respects the
daily budget unless the task's own "go over today's budget" permission applies
in a booked hour (`lib/objectives/deferredObjectives/admission.ts`, `resolveDecision` / `resolveHourClaims`) or the device is exempt.

On task-capable devices, each answer A–D needs one line about smart tasks, because that is the transition
owners do not predict (#167, #168): "A smart task on this device decides when it
runs until the task ends."

### 2. When someone turns it off

"Follow the running choice" (default) / "Leave it off until turned on again".
Explain the default using the answer above: under A it may resume normally;
under C only its task can start it; under D it does not gain ordinary restart
authority. Do not promise automatic resumption under every answer. Only for
devices with an on/off switch: the hold is binary-only, so
step-only stepped loads and EV chargers without on/off cannot use it
(`setup/externalOffHoldDetection.ts`, `syncExternalOffHoldForDevice`).

The page today disables this switch while Limit is off, but **the runtime honours
the hold under every answer** (`lib/plan/restore/devices.ts`, `isRestoreLiveEligibleDevice`,
`lib/executor/binaryRestoreHelpers.ts`, `applyBinaryRestoreWithSnapshot`, `lib/executor/binaryExecutor.ts`, `applyUncontrolledBinaryRestore`,
`lib/plan/planBuilderSurplus.ts`, `resolvePostureExcludeIds`, `lib/objectives/deferredObjectives/admission.ts`, `rescueBlockedByExternalOffHold` / `resolveHourClaims`), and detection has
no Limit gate (`setup/externalOffHoldDetection.ts`, `shouldStartHold`). Under C and D it matters:
a held device cannot be started by its smart task until someone turns it on. So
the question belongs beside every answer A–D, with that consequence stated under
C and D.

Transitions: any observed ON clears the hold (`setup/externalOffHoldDetection.ts`, `syncExternalOffHoldForDevice`).
The hold survives a restart; an OFF that happens while the app is down is not
detected (`releaseExternalOffHoldsForObservedOn` in the same module). Leave off beats solar-only (ruling 2026-09-19,
`lib/plan/planBuilderSurplus.ts`, `resolvePostureExcludeIds`) and beats a smart task (`lib/objectives/deferredObjectives/admission.ts`, `rescueBlockedByExternalOffHold`).

**The Flow trap stays stated on the page.** A Flow that turns the device off arms
the hold, and a later Flow that only turns Limit on does not start it again
(`notes/ui-terminology.md` § Leave off until turned on again). When a Flow can
switch Limit on a device with the hold on, the page says so.

### 3. When the temperature changes outside PELS (unchanged)

Kept word for word; its options are exact behaviours:

- **Return to mode target**: PELS writes the mode target plus price, solar and
  smart-task adjustments, and the limit while limiting by temperature. An outside
  change is reverted at the next reading.
- **Keep the new temperature**: PELS never writes the setpoint, including on a
  mode change; the planner sees an on/off device
  (`lib/planInput/temperatureControlDenial.ts`, `projectTemperatureDeniedDevice`), and a limit by
  temperature falls back to turning off or the lowest step. A device PELS can
  only control by temperature cannot be limited at all.
- **Save as current mode target**: an outside change becomes the active mode's
  target (`lib/home/observedTemperatureModeUpdates.ts`, `ObservedTemperatureModeUpdates.update`), **except a change
  made while PELS is limiting the device by temperature**, which is treated as
  drift (ruling 2026-09-14). Price and solar adjustments are off, and a heating
  smart task cannot be created (`packages/shared-domain/src/smartTaskDeviceKind.ts`, `resolveSmartTaskDeviceKind`).
  Open PR #2508 turns price adjustments back on here, with an outside change
  cancelling the current price shift until the price level changes.

A heating smart task exists only under Return to mode target, and an active task
blocks switching away from it (`packages/settings-ui/src/ui/deviceDetail/temperatureControlDisabled.ts`, `syncTemperatureControlDisabledRow`).

### 4. What PELS does when limiting this device (unchanged)

Shown under A and B, and under C and D for a device a smart task can run. It is hidden
today whenever Limit is off, but with Limit off a smart task's end still drives
the device to the configured limiting action (`setup/appInit/deferredObjectiveLifecycle.ts`, `handleDeferredTerminalFallback`),
so under C and D it still has an effect the page does not show.

### 5. Allow beyond the daily budget

"Allow beyond the daily budget (still kept under the hard cap)". Exempt frees a
device from daily-budget limiting only; hard-cap limiting still applies
(`lib/plan/shedding/candidates.ts`, `collectSheddingCandidates`, `notes/safe-pace-two-constraints.md`).
It has an effect only where PELS may command the device: under D without task-lent
authority its draw is not
added back to the daily threshold (`lib/plan/planBuilder.ts`, `PlanBuilder.computeDailySoftLimit`) nor counted
as exempt (`lib/power/sampleIngest.ts`, `recordPowerSampleForApp`). Show it under A and B. Under C the
planner treats the device as exempt (the start policy gives it authority) but the
measured energy does not, because `recordPowerSampleForApp` in `lib/power/sampleIngest.ts` reads Limit, not
authority; that asymmetry needs a ruling before C shows it.

## Temperature devices

A temperature device leads with question 3. Its running choices have separate
predicates and writes: Managed + Limit means normal operation with power
limiting, regardless of Solar; choosing it sets Managed and Limit and keeps
Solar and Start policy. Managed + Limit off + unrestricted means no routine
power limiting; choosing it sets those values and keeps Solar. C and E use the
same writes as above and preserve Solar. **A thermostat never maps to B** just
because its solar target lift is enabled.

Use wording appropriate to the temperature policy and heating/cooling mode.
"PELS heats it to the target" is unsuitable when Keep the new temperature
denies setpoint writes, or when the device cools. Recommendation: retain the
task-only choice only for devices with a supported temperature task, an on/off
switch, a power reading and Return to mode target. Explain that PELS still sets
its temperature while holding it off; the choice governs running. Unsupported
stored combinations remain visible as descriptions with replacement choices.
Price and solar adjustments sit under **Return to mode target**, where they
apply, instead of in separate cards with "Turn on … in Setup" hints.

Limit off alone does not deny mode, price and solar setpoint writes; their
temperature-policy and power prerequisites still apply
(`lib/executor/planExecutorDispatch.ts`, `applyUncontrolledDeviceIntent`, `notes/temperature-ownership.md`).
The start policy or a task may still grant switching/limiting authority. Without
a power reading, offer management for the applicable temperature behavior and
Not managed, with no promise of power limiting or task-only switching (ruling
2026-09-23). The hold's setpoint caveat stays: while held
off, PELS keeps writing the setpoint unless Keep the new temperature is chosen.

A stepped water heater with a temperature (Høiax Connected) is a temperature
device on the page (`packages/settings-ui/src/ui/deviceKind.ts`, `resolveDeviceDetailKind`). Its
Solar bit means the setpoint lift, never tracking or solar-only.

## Device setup

Control model, Use built-in device control and Power when running move into one
collapsed **Device setup** card at the bottom. The EV charging-control readout
and the Setup select are one setting shown twice today; it appears once.

## Stored combinations needing explanation

Opening the page must not rewrite these. Where a combination matches an answer,
show that answer with the relevant qualification. Otherwise describe what the
device does now and offer the answers as replacements.

| Combination | Reachable by | What the device does | Description on the page |
|---|---|---|---|
| Limit on, Managed off | Turning Managed off (it writes only `managed_devices`), or `enable_device_capacity_control` on a device with a `false` Managed entry | Nothing: authority needs Managed. Today the page renders this as a disabled switch in the on position | Not managed. Turning Managed on again turns Limit on anyway (`managedOptInLimit.ts`), so the stored value never matters |
| Limit off, `pels_only`, Solar on | Solar set while Limit was on, then Limit off and Only PELS starts on | Held off; solar never starts it | C, with the solar opt-in shown as the other half |
| Hold opt-in on, Limit off | Opted in while Limit was on, then Limit off | Hold honoured, blocks smart-task starts | C or D plus question 2 answered |
| Exempt, Managed off | Budget exempt is always enabled on the page | Nothing | Not managed |
| Managed, no power reading, Limit stored on | Stored Limit from earlier configuration or a Flow before a valid reading | Applicable setpoints only (thermostats) or nothing | "Can't limit this device without a power reading" |
| Managed, Limit on, Solar on, but solar posture unavailable | Move an opted-in device to a meter area; retain a legacy opt-in without a reachable surplus pool | Ordinary capacity operation; stored Solar does not hold it off | Describe normal running and why the saved solar preference is inactive |
| Managed, Limit off, `pels_only`, no supported smart-task type | Existing start-policy switch offered on a plain relay | Held off, with no supported task to start it | Explain that no supported task can start it and offer a replacement; do not offer C as a new choice |

The table is the starting set, not a proof of completeness; the implementation
enumerates the product of the keys above per device kind and gives every
reachable row a description.

## Acceptance cases

Each supported goal should have a directly named choice on the device page,
with related overrides beside it. An unsupported goal must be identified
honestly. The page must also explain what happens after a manual off, a Flow
change, and a smart task starting and ending.

1. **Keep it off after I turn it off** (#7, #67). A + "Leave it off". Manual on
   returns it to A. A smart task cannot start it while held. A Flow turning
   Limit off moves it to the other half; the hold stays.
2. **My Flows book the cheap hours** (#27, #47). The Flows switch Limit, so the
   page shows the half in force, the other half, and names the Flows. With the
   hold on, it warns about the Flow trap.
3. **Remote changes should stick** (#128). Question 3, Save as current mode
   target, including the while-limited exception and that heating smart tasks
   are unavailable.
4. **Relay water heater in the cheapest hours** (#162). No good answer today:
   a relay-only heater has no supported task type, even for a one-off task.
   Energy-amount tasks do not exist on the audited main revision (development
   branch `feat/energy-smart-task`); recurrence is a further question. Do not
   offer C as a solution until a supported task can start that device.
5. **Which devices wait for cheaper hours** (#167). Answered by the smart-task
   line under each answer, and by C being an explicit choice.
6. **Charger must not start before its task** (#170). C. A plug-in session or an
   app start is turned off at the next reading (a short spike remains for a
   charger that starts without authorisation). A Flow turning Limit on pauses
   the start policy and moves it to A or B.
7. **Charge on solar only** (#123). B. Stops to the limiting action when surplus
   runs out; a lowest-step limit keeps drawing. Charge boost can use grid power,
   and a smart task takes over in its booked and deferred hours. Explain those
   exceptions and the actual stopping action before describing this as solar
   only; after restart surplus eligibility is rebuilt, subject to the same
   boost/task exceptions.

## Open decisions

- Reset or keep the other half when choosing an answer (recommendation: keep,
  and show it).
- Choosing "Not managed" for a device PELS has turned off: release it first, or
  say it stays off (recommendation: leave it off; handing back control must not
  implicitly start a device).
- Exempt under C (the planner/measurement asymmetry). Recommendation: reconcile
  the runtime classification before offering a new exemption here. Meanwhile
  describe any stored exemption and preserve an explicit way to remove it.
- Whether thermostats keep "Only when a smart task heats it" as an answer or
  only as a description of a stored combination (recommendation: offer it only
  for the supported devices/policy described above, with the setpoint caveat).
- The Devices list's three switch columns (Managed / Limit / Price) name
  mechanisms too; showing the answer there instead is a separate change.
- The rules in `notes/ui-terminology.md` that this design would amend (see
  Existing notes below).

## Existing notes, docs and docblocks

Audited 2026-09-28 against the main revision named above, treating the referenced
notes, docs and docblocks as claims. The checked owner rulings include those of
2026-09-14, 09-19, 09-23, 09-24 and 09-25. The Leave-off and Flow caveat, the
dump-load reconcile copy and the temperature policies also match the code. The
remaining discrepancies and design conflicts fall into four groups.

### Wrong about current behaviour, corrected with this note

- `notes/ui-terminology.md` § Who may start a device listed the switch with no
  condition. It applies only while Limit is off, and the page shows it only then
  or when already set (ruling 2026-09-25). Its "a smart task and nothing else"
  wording predates 2026-09-24, when unclaimed task hours started lifting the hold.
- `notes/ui-terminology.md` § Solar surplus said the dump-load and tracking gates
  mirror "managed AND power-limit-controllable". The runtime gate is command
  authority (`lib/plan/planSurplusAbsorb.ts`, `resolveSurplusOnlyPosture` / `resolveSurplusTrackingPosture`), which Only PELS
  starts this device also grants with Limit off; that is why the start policy's
  precedence over solar exists at all.
- `notes/ui-terminology.md` § Leave off until turned on again said the setting
  "has no effect" while Limit is off. The runtime honours the hold under every
  running choice and it blocks a smart task from starting the device
  (`lib/objectives/deferredObjectives/admission.ts`, `rescueBlockedByExternalOffHold` / `resolveHourClaims`); only the
  page gates the switch on Limit.
- `notes/temperature-ownership.md` said seed candidacy covers
  "implicitly-managed" devices. No such device reaches the planner: Managed is
  resolved `=== true` (`setup/appHostApi.ts`, `AppHostApi.resolveManagedState`, wired at
  `setup/appInit/buildDeviceParseProviders.ts`, `buildDeviceParseProviders`). The seed pass filters the
  raw map with `!== false` instead (`setup/appDeviceSupport.ts`, `persistFilledModeTargets`), so it
  also writes targets for devices that were never managed.

### True, but working against this design

These describe the page accurately or state a rule, and they are what produced
the switch list. They change only when the owner accepts this design.

- **The suppressed-control rule** (`notes/ui-terminology.md` § Device-page
  limiting statements, last paragraph): an applicable-but-unavailable control
  stays visible and disabled with a hint naming the real switch; never vanish
  one the user could re-enable. It is the source of every "Turn on … in Setup"
  hint and of the greyed paragraphs, and the page follows it only in the price
  and solar sections anyway: Limit, Price and Leave off are disabled with no hint
  when unmanaged, and Run/Match on solar surplus disappear. Under this design the
  unit the owner re-enables is the answer to a question shown directly above its
  details, so the rule becomes: details show under the answer they belong to,
  and a cross-section "turn on X elsewhere" hint does not exist.
- **The EV control readout with a Change button** (§ Device-page limiting
  statements): one setting shown in two places on purpose ("top visibility,
  Setup-grade friction").
- **The section-order rationale** in
  `packages/settings-ui/src/ui/deviceDetail/sectionLayout.ts`: Setup as
  "management, control model and wiring", collapsed, with binary devices having
  "almost nothing to configure". A binary device has Limit, the start policy,
  Leave off, solar, Budget exempt and Power when running, all of them in Setup.

Not in this group: "one toggle is the whole control" (§ Solar surplus) argues
against asking the same question twice and agrees with this design, and the
dump-load water-heater warning stays. A water heater on a relay is a `socket`,
so the warning cannot be limited to devices of class water heater.

### Owner docs that are wrong now

Not changed here; they mislead owners today and need their own change.

- `docs/smart-tasks.md` (§ Power-limit control and tasks, § EV setup) recommends
  Limit off for an EV charger "to prevent ordinary run-when-power-is-available
  behavior". With Limit off and no start policy, a charger that starts a session
  on plug-in runs with no hard-cap protection. The setting for that goal is Only
  PELS starts this device (forum #170), which no owner doc mentions.
  `docs/ev-charger.md` says to turn Limit on for the same charger.
- `docs/configuration.md` § Leave off: the comparison table says Limit off means
  PELS may not limit the device and hands it "to another automation entirely".
  A smart task and the start policy both still act on it.
- `docs/configuration.md` § Settings > Devices: the Solar surplus section holds
  only the temperature boost (the switches are in Setup); "Disable temperature
  control" no longer exists; the Setup list misses Only PELS starts this device
  and the solar switches; the Charging statement is the one for chargers without
  a current preset.
- `docs/solar.md`: when the solar switch appears (export seen once, or the
  curtailment estimator), and that the setpoint lift needs a power reading and
  Return to mode target.
- Flow card hints: `set_expected_power_usage` is deprecated and its hint is
  wrong on both counts; `enable_device_capacity_control` describes Limit as
  hard-cap only.
- Names drift for one control: "capacity control" / "Power-limit control" /
  "Limit"; "EV control mode" / "Control model" / "Charging control".

### Docblocks that describe gates this design replaces

Wrong today, and rewritten when the page is: `deviceDetail/solarSurplus.ts` and
`solarSurplusTracking.ts` (runtime gate, and "the opt-out stays reachable": a
disabled switch cannot be turned off), `respectExternalOff.ts` (module docblock) and
`startPolicy.ts` (module docblock) (Leave off "needs Power-limit control on to mean
anything"; `pels_only` "may never command"), `shedBehavior.ts` ("PELS will not
limit this device" with Limit off, while a smart task still applies the
limiting action), `managedOptInLimit.ts` (`resolveManagedOptInLimit` docblock) (cites `applyFalseOverrides`,
removed in `ca992108f`), `flowCards/deviceSettingsCards.ts` (`recordsForUntrackedDevice` comment) (disabling
capacity control "hands a device back", while a stored `pels_only` holds it off),
`lib/plan/shedding/startPolicyHold.ts` (`isStartPolicyHeldDevice` docblock) (authority also needs a power
reading) and `setup/appDeviceSupport.ts` (`plannedFromManagedFlag` docblock) (implicitly-managed devices).

### Runtime findings for separate changes

- **A Flow can adopt a never-managed device on the next restart.**
  `mayGrantCapacityControl` and `setDeviceBooleanSetting` in
  `flowCards/deviceSettingsCards.ts` allow an eligible device with no Managed
  entry to receive Limit on. `migrateManagedDevices` in
  `setup/appManagedDeviceMigration.ts` then creates its Managed entry at boot.
  An explicit Managed false prevents adoption. A fix must distinguish legacy
  migration from new Flow writes; the completion case is that enabling Limit
  for a never-managed device does not start managing it after restart while
  genuine legacy installs still migrate correctly.
- **One malformed stored map entry can make a Flow overwrite all other entries.**
  `getBooleanSettingsRecord` in `flowCards/deviceSettingsCards.ts` returns an
  empty map when any value is invalid; `setDeviceBooleanSetting` then persists
  only the selected device's flag. This applies to capacity control and budget
  exemption. No production writer of such malformed entries was established
  in this review, so this is a conditional boundary-handling defect, not an
  observed data-loss incident. A separate fix must preserve the last good map
  or decline the write on an unavailable/malformed read rather than replace it.
