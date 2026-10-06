# Smart-task delivery evidence and attribution

Smart tasks preserve the requested target. A car stopping at a lower charge
limit, or a relay heater's mechanical thermostat cutting out, leaves its task
unmet. Energy tasks require the requested metered kWh; temperature tasks may
accept the observer's existing near-target tolerance when the classified
setpoint covers the task target. Broad internal-cap classifications are not
completion evidence. A trusted exit from accepted thermal completion reopens
the task.

## Ownership

The planner projects its published restriction reason and the executor's live
convergence state into `TaskDeliveryControl`. Commands awaiting confirmation
are pending; a commanded on state alone is not settled delivery. A restore-admission
hold on an already-on device with no pending control axis preserves permitted
delivery: a house-level cooldown is not an in-flight command for that device. The observer
owns measured draw trust. Objectives combine those facts with the resolved
current-hour claim, progress and device constraint on the lifecycle clock.
`deliveryEvidence.ts` owns the device-neutral transition rules, and the
plan-history recorder owns each run's evidence alongside its measured energy.
Setup injects these read ports; it makes no delivery decisions.

Active plans carry required `liveCompletion` facts separately from immutable
allocation revisions. List, detail, widgets and Flow consumers use that live
verdict. Fresh trusted temperature or draw can withdraw observer acceptance
between meter plans without sampling another idle hold or rewriting a schedule.

A claimed task with permitted, settled control and less than 0.001 kWh of
sustained useful draw per 15-minute window confirms device non-delivery after
15 minutes. Its live status reports risk, while its requested target and
schedule remain intact. Only this confirmed device-side non-delivery suppresses
its priority reservation. Capacity restrictions and pending restoration retain
reservations. Resumed draw clears the blocker and suppression; lower tasks
receive the released allocation at the ordinary settle. A released hour
cannot start this timer. A claimed hour can, also one booked at 0 kWh:
permitted and not drawing is a device-side stop either way, and a hour the
planner holds back reads as restricted, not permitted.

Once confirmed, the stop is latched for the status (`stopped`, then
`rechecking`, in `taskDeliveryState.ts`) until the device draws again, the
task is met, or its plan goes inactive (an unplugged car names itself). A
tick PELS holds the device back, or an hour the plan does not book, keeps the
latch but not the suppression: the next claimed, permitted window re-tests
the device for 15 minutes with its reservation held before freeing it again,
so a device the plan cannot run is never starved of the window that would
show it drawing. Consecutive permitted hours stay one window, as before the
latch. A restart restores a stop as `stopped` (no observation spans the
downtime), and the persisted form writes the latched kinds as `confirmed`,
which builds before the latch can still read. While latched, the reported
cause is the last device-side one recorded, so a car waiting on its own
schedule keeps that copy through PELS's holds. Without the latch those ticks
reset the cause, and the status flipped back to on track and fired the status
Flow on each re-confirmation.

## Live status overlay

`reportTaskDeliveryStatus` lets only confirmed device-side causes downgrade a
healthy live status, each with its own reason code and copy:
`device_not_accepting` (the 15-minute non-delivery confirmation above, or a
confirmed car self-stop), `device_limit` (the car at its qualified own charge
limit) and `device_schedule` (a confirmed car schedule hold). The horizon plan
cannot see these. Everything else is recorded as evidence only:

- Capacity, budget and priority limiting are PELS's own per-cycle decisions,
  which the committed plan already prices in. Overlaying them flipped the status,
  and fired the status Flow trigger, on every shed/settle cycle (production: an
  EV task three hours from its deadline, shed in its claimed hour).
- `control_pending` is a settle in progress.
- `control_failed` is a per-tick executor fact with no hold. A failure that
  persists costs progress, which the next settle re-plans against.
- `uncontrolled` is a hold the plan owns: a PELS policy hold, or the owner's
  "Leave off until turned on again" outside a booked hour. A booked hour ends
  that hold, so it is never a risk to the task.

The surfaces read the codes from the active plan through
`resolveEffectivePlanStatus` and explain them through `resolveSmartTaskLiveCause`
(`notes/ui-terminology.md`, "Live causes on an at-risk or cannot-finish task").
The same status rule also reads a known car charge limit below the target, reached
or not, as at risk: the requested target stays the target and the car will stop
short of it. A car unplugged before it reached that limit is just unplugged
(`resolveReportedCarChargeLimit`). Durable exclusions (separate meter, not
managed) and a pending plan outrank every overlay.

v3.9.3 also persisted `objective_delivery_restricted` for capacity, budget and
priority limiting, and earlier builds persisted `objective_device_left_off` for
the hold. The active-plan loader drops both (`activePlanSettings.ts`), and the
resolvers ignore them if a browser reads a stored plan first.

## Recorded explanations

The recorder stores the final active blocker, earlier contributing causes and
coalesced time intervals. The interval list keeps the newest
`MAX_DELIVERY_INTERVALS` (120): every flip between causes appends one, and the
evidence is persisted every tick and copied into history. Contributors keep
every cause ever seen, so the bound drops only old durations; older, longer
persisted rows stay valid and are trimmed on their next append. The recorder
also answers which finalized misses were caused by the daily budget alone
(`budgetOnlyMiss.ts`), which reads that window and treats a full list as
possibly truncated; the daily-budget correction consumes that answer
(`notes/starvation/README.md`). The past-task
sentence names the final blocker, then at most one earlier contributor, the one
with the most blocked time within that window, never a momentary
`control_pending` settle. A run the car held back (`device_limit`,
`device_schedule`) gets no "Review device" button: no PELS setting changes the
car. Cleared restrictions remain earlier contributors;
they do not describe the current blocker. A missed task with permitted delivery
and no recorded blocker states that its target was not reached during that
permitted delivery. Physical/time feasibility and uncertain estimates are
separate planner facts. No delivered-versus-estimated ratio implies capacity
pressure, and energy tasks never remap an estimate cause into capacity.

History v6 requires a typed explanation. Reads of v3-v5 preserve measurements,
costs, progress, outcomes and old completion reasons, marking causal evidence
`legacy_unrecorded`. Older in-progress rows retain metered delivery and carry
that evidence gap into later contributors. Runtime and browser formatting read
the same recorded explanation. Migration never rewrites an earlier outcome or
fabricates capacity attribution.

Restart restores evidence and accumulated energy, then reanchors observation
and non-delivery timers. It does not credit energy or continuous observation
across downtime. Structured events record blocker transitions and thermal
completion acceptance/reopening with the evidence and target consumed.

## Clocks and control

Meter readings still trigger ordinary planning and actuation. The lifecycle
clock records delivery, publishes live overlays and commits allocations. The requested target alone defines the work and completion obligation. Car-limit
changes update reporting without invalidating the commitment; ordinary allocation
changes retain the existing settle clock. There is no observation-triggered reconciliation or new write seam.

## Operational facts and reporting

Task admission, reservations, completion and commitment hours consume the required
`TaskEvaluation`, not diagnostic reason codes, optional UI fields or device-specific
limits. The allocation boundary resolves progress, policy and control inputs. Missing
initial inputs leave planning inactive; transient gaps retain an established allocation.
The non-delivery hold consumes claimed delivery, settled control and observed draw.
Only its confirmed state suppresses reservations; a reporting cause cannot do so.
