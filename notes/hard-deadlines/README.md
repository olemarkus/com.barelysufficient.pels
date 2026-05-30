# Hard Deadlines

Hard-enforcement deadlines for deferred-load objectives. **Not shipped in v1.**
Soft enforcement is the current behavior — see
`notes/deferred-load-objectives/README.md` for the shared objective model and
the shipped soft-temperature slice.

This note is the design contract for the hard slice when we get to it: hard
admission, hard-objective admission headroom, and hard-boost rebalancing. It
also collects the EV-specific hard-enforcement work originally drafted as
`ev-ready-by` §P2.2.

## What "hard" means here

Soft and hard deadlines are the same objective model with different admission
authority. Both may request the minimum required boost, step, or mode needed
to stay on plan.

Deadline authority is separate from per-device Power-limit control. With no
active objective, Power-limit control off means PELS leaves the device alone
for normal capacity, budget, and price work: it should not start, resume,
limit, or step the device just because normal policy has budget or available
power. An active deadline objective is an explicit temporary exception for
the minimum action needed to keep the objective on plan. When that objective
is met, missed, cleared, stale, or invalid, the temporary authority ends.

### Soft (shipped)

Soft objective means budget-aware boost. It may request boost or step-up
behavior, but admission of that request remains inside normal PELS policy. It
must respect:

- effective soft limit
- daily budget soft limit
- device priority
- restore cooldowns
- one-restore-at-a-time behavior
- stepped-load progression
- stale power failsafe
- pending command confirmation and backoff
- existing safety/freshness rules

Soft objective can use existing boost behavior. If that behavior sheds
lower-priority devices to make room for a step-up, the objective may benefit
from it. Soft objective must not shed a higher-priority device solely to meet
the deadline.

### Hard (future)

Hard objective means deadline-first boost. It may request the same minimum
required boost, step, or mode as soft objective, but can use stronger
admission rules when the deadline is at risk. It may bypass:

- daily budget blocking
- effective soft-limit blocking
- normal priority ordering, if a future hard-boost lane explicitly allows
  shedding higher-priority eligible devices

It must still respect:

- hard capacity cap and margin
- live power freshness failsafe
- device availability
- actuator capability
- EV connected/resumable state
- stepped-load progression
- pending-command confirmation and backoff
- stale power failsafe

Hard deadline admission should use margin-adjusted capacity-soft-limit
headroom:

```ts
hardObjectiveAdmissionHeadroomKw = capacitySoftLimitKw - totalKw;
```

not the effective `softLimitKw` when daily budget has lowered it. Do not
confuse this with the existing physical `hardCapHeadroomKw` concept, which is
based on the absolute hard limit rather than the margin-adjusted capacity
soft limit.

Long term, hard objective mode may create hard-cap-safe headroom by
rebalancing flexible devices. That rebalancing must:

- protect only `requestedMinimumStepId`
- preserve hard capacity safety
- prefer keeping devices active where possible
- shed or keep shed eligible flexible devices when needed
- avoid shedding devices protected by equal or higher hard objectives
- drop back once the objective is safe again
- never skip configured stepped-load progression

Hard objective is not a whole-home energy cap. The target remains device
readiness:

```text
device X should reach state Y by time Z
```

The hard-mode difference is that budget and normal priority policy may yield
to the device deadline. The hard capacity cap never yields.

## What's persisted today

The persisted objective schema already accepts hard enforcement so the
runtime can grow into it without a settings migration. From
`packages/contracts/src/deferredObjectiveSettings.ts` via the v1 note:

- `enforcement: 'soft' | 'hard'` is part of the `ev_soc` variant.
- The planner already distinguishes the two in **one** narrow way: hard
  reserves a wider variance buffer (`BUFFER_K_HARD` vs `BUFFER_K_SOFT` in
  `lib/plan/deferredObjectives/profileEnergyResolution.ts`). The **hard
  admission lane** in this note — guaranteed reservation, hard-boost
  rebalancing, mode-override — has not shipped, and the EV flow card
  hardcodes `'soft'` so users cannot create a hard EV deadline yet.
- Temperature objectives are soft-only at the schema level for now. The
  Settings UI must not expose hard temperature deadlines until the runtime
  semantics in this note are explicitly designed and implemented.

When hard enforcement ships, the flow-card surface gains an `enforcement`
arg and the runtime gains the hard admission lane described above.

## Hard-related reason codes (reserved)

These reason codes are reserved for the hard slice and are not emitted by
the shipped diagnostics bridge today:

- `objective_hard_deadline_restore`
- `objective_hard_deadline_step_request`
- `objective_hard_deadline_mode_request`
- `objective_hard_deadline_rebalance`
- `objective_hard_deadline_blocked_hard_cap`

See `notes/deferred-load-objectives/README.md` §"Reason Codes" for the
shipped set.

## EV-specific: hard enforcement headroom math

(Originally drafted as `notes/ev-ready-by/README.md` §P2.2.)

`set_ev_charge_deadline.json` does not currently expose an `enforcement`
arg, so `hard` is internal-only today. This slice surfaces `hard` to users
and makes it behaviorally distinct from `soft`. `lib/plan/planBuilder.ts:258`
uses `min(capacitySoftLimit, dailySoftLimit)` uniformly; plumb a "hard
objective active" signal from admission into the soft-limit selector and
apply only to EV chargers admitted under `enforcement: 'hard'`. Hard EV
bypasses the daily-tightened soft limit while still respecting the hard
cap. Add the `enforcement` dropdown to the flow-card JSON in the same
change so the surface and the behavior land together.

Files: `lib/plan/planBuilder.ts`, `lib/plan/admission/deferredObjective.ts`,
`flowCards/deadlineObjectiveCards.ts`,
`.homeycompose/flow/actions/set_ev_charge_deadline.json`, headroom and
admission tests.

## Mode override (water heaters and similar)

Mode override is the temperature-side counterpart to hard enforcement. The
shipped runtime has no mode-change path; everything below is design for a
future slice. It lives here because mode override and hard enforcement are
the two halves of "temperature smart tasks under hard authority": hard
enforcement gives the planner the headroom; mode override gives it the
device-side capability to actually reach the target.

### Mode-dependent capacity

For water heaters, mode can change the maximum allowed temperature, the
usable capacity, and sometimes the charge rate. Capacity is therefore not
a fixed device constant unless the mode is fixed.

Model usable capacity against the active or requested mode:

```ts
usableCapacityKwh = energyBetween(baselineTemperatureC, modeMaxTemperatureC);
```

Target feasibility must account for mode:

- If the current mode can reach `targetTemperatureC`, no mode change is
  required.
- If the current mode cannot reach the target and deadline control is not
  allowed to change mode, the objective is `cannot_be_met`.
- If mode override is allowed, request the lowest mode that can safely
  reach the target.
- If a higher mode is needed only for rate/deadline reasons, request it
  only when the objective is hard/urgent enough.

### Override rules

Mode override should exist only in a native adapter that understands the
device. Generic flow-backed devices should not receive automatic mode
changes unless their flow integration implements them explicitly.

Rules:

- Soft deadlines should not override user/device mode by default.
- Hard deadlines may request a mode change if the current mode cannot
  meet the target.
- Override must be minimal: choose the lowest mode that can satisfy the
  target and deadline.
- Never exceed configured safety or user maximum temperature.
- Restore the previous mode after the target is met or the deadline
  window expires, unless the user changed the mode manually.
- Manual user mode changes should win unless the user explicitly enabled
  deadline mode control.

Mode request is part of objective evaluation:

```ts
requestedModeId?: string;
requestedModeReasonCode?: ObjectiveReasonCode;
```

The reserved reason codes `objective_mode_cannot_reach_target` and
`objective_mode_override_disabled` belong to this slice (see also
§"Hard-related reason codes" above which extends the family for the
hard-admission lane).

## Implementation shape

Two slices, in order:

1. **Hard admission lane**: plumb hard-vs-soft through admission, switch the
   soft-limit selector on the hard signal, expose `enforcement` on the EV
   flow card. Acceptance test below.
2. **Hard-boost rebalancing**: optional follow-up that may shed flexible
   devices to create hard-cap-safe headroom for the protected minimum step.
   Touches limit planning deeply and should land as its own design pass
   after the hard admission lane is stable.

## Acceptance criteria

- Soft objective does not bypass effective soft limit.
- Soft objective does not bypass daily budget soft limit.
- Hard objective bypasses effective soft limit when hard-cap safe.
- Hard objective uses `capacitySoftLimitKw` rather than daily-budget-lowered
  `softLimitKw`.
- Hard objective is blocked when hard objective admission headroom cannot be
  made safe.
- Hard objective may keep or shed a lower-priority device to allow requested
  storage step.
- Hard objective can use hard-boost policy to shed a higher-priority
  eligible device when explicitly allowed.
- Objective urgency protects only `requestedMinimumStepId`.
- Higher-than-requested step remains opportunistic.
- Hard deadline never bypasses hard-cap safety.

## Test plan

- soft objective does not bypass effective soft limit
- soft objective does not bypass daily budget soft limit
- hard objective bypasses effective soft limit when hard-cap safe
- hard objective uses `capacitySoftLimitKw` rather than daily-budget-lowered
  `softLimitKw`
- hard objective is blocked when hard objective admission headroom cannot be
  made safe
- hard objective may keep or shed a lower-priority device to allow requested
  storage step
- hard objective can use hard-boost policy to shed a higher-priority
  eligible device when explicitly allowed
- objective urgency protects only `requestedMinimumStepId`
- higher-than-requested step remains opportunistic

## Out of scope

- Multi-objective contention across hard deadlines. Out of scope until the
  single-hard-deadline path is stable.
