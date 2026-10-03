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
receive the released allocation at the ordinary settle. An unclaimed or
released hour cannot start this timer.

## Recorded explanations

The recorder stores the final active blocker, earlier contributing causes and
coalesced time intervals. Cleared restrictions remain earlier contributors;
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
