# Smart-task delivery evidence and attribution

Smart tasks preserve the requested target. An energy task reaches its target
when the metered kWh reach the requested amount. A metered binary energy task
with a known expected draw can be tentatively met while the device is idle
during permitted delivery. Temperature tasks accept the observer's near-target
tolerance when the classified setpoint covers the task target. A trusted
change in the evidence reopens an accepted task.

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
15 minutes. For thermal and EV tasks the confirmed stop reports risk and
suppresses the priority reservation. A claimed hour can start this timer
even when it promises 0 kWh. A released hour adds no idle evidence.

For an eligible binary energy task, confirmed idle also removes task rescue
claims from live admission. During the planned run windows the device can
still take available power. Admission accounts for the expected draw of an
energized relay and lets it yield to committed demand. The task's normal
planning turn clears future positive bookings. The recorder retains the
elapsed intervals. Other tasks can use the released room at their own turns.

An intentional hold with trusted zero draw preserves earlier evidence.
When the draw becomes unobserved, idle acceptance becomes uncertain and the
device continues on available power while it is rechecked. Resumed draw
reopens the task once another drawing tick shows at least 0.001 kWh of new
metered energy. The next normal planning turn can make fresh commitments
around the bookings already held by other tasks. If the meter reaches the
target, the ordinary success path takes precedence. After a restart a
tentative task resumes in the uncertain state until fresh evidence arrives.

For tasks outside available-power operation, a confirmed stop stays in the
generic risk status through holds (`stopped` and `rechecking` in
`taskDeliveryState.ts`). The next claimed, permitted window re-tests the
device for 15 minutes with its reservation held. Consecutive permitted hours
form one window. A restart restores a stop as `stopped`, so the downtime
adds no evidence. The persisted form writes the latched kinds as
`confirmed`, which builds before the latch can still read. The latest
device-side cause stays visible while held, so a car waiting for its own
schedule keeps that explanation.

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

For an eligible energy task, the live completion verdict presents confirmed
device idle as **Tentatively met**. The surfaces read the active plan through
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

At expiry, the recorder can conclude **Device idle** when the last trusted
evidence still supports idle and measured opportunities account for the
energy shortfall. This keeps the delivered kWh, target and evidence
available to the owner. A material competing blocker or insufficient
evidence uses the ordinary terminal classification.

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
