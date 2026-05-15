# Planning Horizon and Milestones

Energy-based milestones and the priority-adjusted horizon-planning model are
**deferred from v1**. What ships today is summarised briefly in
`notes/deferred-load-objectives/README.md`: the horizon planner allocates
buckets from `now → deadline`, prefers cheap windows that fit the daily-budget
headroom, and resolves status from required-vs-allocated energy with a
deadline-reserve margin. This note is the longer-form design for the
milestone-and-priority-aware horizon that v1 did not implement.

## Why milestones

Within the planning horizon, PELS should try to place the required useful
energy in the best available windows while preserving enough margin to meet
the deadline.

For soft objectives, "best" means normal PELS policy: daily budget state,
expected price/budget pressure, device priority, and existing boost rules.
Price is not a separate primitive here; it enters through the budget/price
policy PELS already uses to decide when spending energy is acceptable. Soft
objective should prefer cheap or budget-friendly windows when that does not
create deadline risk.

For hard objectives (see `notes/hard-deadlines/README.md`), the same horizon
exists, but deadline feasibility outranks budget and normal priority policy.
Hard objective should still prefer cheaper or budget-friendly windows when
there is enough margin, but it should not miss the deadline merely because
the remaining feasible window is expensive.

## Priority-adjusted horizon

Priority should affect horizon planning through admission risk, not by
directly rewriting price ordering. A lower-priority device may be blocked by
higher-priority managed devices during otherwise cheap windows, so those
windows should count as less dependable for soft objectives. The planner can
model that by reducing usable bucket capacity, increasing deadline reserve,
or widening the number of candidate hours before the deadline. A
higher-priority device can use more of its configured step capacity as
dependable energy, while a lower-priority device should need more time or
more margin to be considered on track.

This risk adjustment is still a planning estimate. Actual admission remains a
runtime decision made by normal PELS policy for soft objectives and by the
hard-objective admission lane for hard objectives. If the current bucket's
requested minimum step is blocked, the next evaluations should consume
deadline margin, replan remaining energy, and eventually move the objective
toward `at_risk` or `cannot_be_met`.

## Energy-based milestones

The horizon plan should produce derived milestones. Milestones should be
energy-based where possible, not arbitrary wall-clock percentages:

```text
by 01:00: planned useful energy added >= 0.5 kWh
by 03:00: planned useful energy added >= 1.0 kWh
by 05:00: planned useful energy added >= 4.5 kWh
by 07:00: planned useful energy added >= 6.0 kWh
```

This allows soft mode to intentionally wait through expensive periods
without being falsely marked behind, while still detecting when the plan has
fallen behind enough to request a higher step.

## Conservative v1 scheduler (the design that informed shipped v1)

The original design proposed a conservative-and-simple horizon scheduler:

1. Build coarse time buckets from now to the deadline.
2. Estimate useful energy available per bucket for each configured step.
3. Prefer buckets that normal policy already considers cheap or
   budget-friendly.
4. Keep a confidence margin or fallback reserve near the end.
5. Output the requested minimum step for the current bucket.
6. Recompute on every relevant plan cycle.

Required-average kW remains useful as a diagnostic, but horizon scheduling
is the mechanism that makes soft objectives budget-aware instead of just
"boost immediately."

Shipped v1 implements steps 1, 2, 3, 4 (via the deadline-reserve concept),
5, and 6, but does **not** produce or evaluate energy milestones — see the
relationship section below.

## Relationship to shipped v1

Shipped v1 has the horizon planner, the bucket allocator, and a
deadline-reserve mechanism. Status resolution uses the planner result codes
`planned_with_margin`, `planned_using_deadline_reserve`, and
`planned_using_policy_avoid` to express the "we can wait through expensive
hours" intent that milestones would otherwise express. That gives
approximately the same user-visible behavior (a soft objective in an
expensive window does not flip to `at_risk` just because no energy has
landed yet) without computing explicit milestones.

Open question for when this work resumes: are milestones additive on top of
reason-code precision (e.g. to drive logging and trigger tokens with a
trustable "planned by-now kWh" number), or do they replace it? The answer
affects whether the implementation is a logging surface or a planner
refactor.

## Planned log event

Reserved log event name for when milestones ship:

- `deferred_objective_milestone_status` — emitted on every cycle with
  `plannedEnergyByNowKwh`, `actualEnergyByNowKwh`,
  `plannedEnergyAtDeadlineKwh`, and per-milestone status.

See `notes/deferred-load-objectives/README.md` §"Logging and Diagnostics"
for the shipped event list.

## Acceptance criteria

When this work resumes, additional acceptance items beyond what shipped v1
already satisfies:

- horizon plan prefers budget-friendly buckets while maintaining deadline
  margin (the priority-adjusted version, not just the price-tone version
  shipped)
- horizon milestones allow intentional delay without marking the objective
  behind
- milestone status drives trustable trigger tokens and log events for "by-now
  delivered vs planned" reporting
