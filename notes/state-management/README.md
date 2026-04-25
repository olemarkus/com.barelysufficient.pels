# State Management Notes

This note is for contributors working on runtime state, drift handling, snapshot refresh, and post-actuation behavior.

The core problem is simple:

- PELS has multiple overlapping views of device state
- those views arrive with different latency and reliability
- Homey can return older data after a newer local write or realtime update
- if PELS treats "requested" state as "observed" state, control becomes dishonest

This document exists to keep those distinctions explicit.

## Main Rule

PELS must keep these concepts separate:

- `planned` state: what the current plan wants
- `commanded` state: what PELS most recently asked Homey/device to do
- `observed` state: what trusted telemetry most recently says the device is doing
- `effective planning` state: what the planner should conservatively assume right now
- `pending` state: requested but not yet confirmed

Most bugs in this area come from collapsing two of those into one.

Planner/device snapshot contributor rule:

- `reason` on a finalized plan device is a structured planner contract, not display prose
- planner/runtime logic may branch on `reason.code`
- UI/log wording must be rendered from that structured reason, not stored as planner state
- finalized plan devices should always carry a `reason.code`; missing reason is a contract bug,
  and legacy snapshot reads should normalize older payloads at the boundary

## Stepped-Load Step Semantics

Stepped loads need the same separation, but for step identity rather than only binary on/off state.

Use these meanings consistently:

- `reportedStepId`: confirmed device feedback only. This is the observed step.
- `targetStepId`: the step PELS currently wants. This is planner/runtime intent.

Internally, stepped-load feedback and intent use synthetic PELS capability IDs:

- `pels_measure_step`: observed stepped-load position, surfaced as `reportedStepId`.
- `pels_target_step`: requested stepped-load position, surfaced as `targetStepId` / `desiredStepId`.

These IDs are internal capability-shaped contracts. They are not Homey-declared device
capabilities unless a future change intentionally exposes them.

Legacy compatibility fields still exist in some snapshots and plans:

- `selectedStepId`: planner-effective current step. This may be reported or inferred.
- `desiredStepId`: legacy alias for the current target step.
- `actualStepId`: legacy best-effort concrete step. Historically this could mean reported or
  heuristic, so do not treat it as confirmed by name alone.
- `assumedStepId`: legacy inferred/fallback step.

Contributor rules:

- overview/UI wording must use `reportedStepId` for confirmed observed step
- if there is no `reportedStepId`, do not infer a step from `measure_power` for human-facing state
- planner logic should reason from actual measured power directly when it needs live load
- do not use `selectedStepId` or `actualStepId` as human-facing observed truth without first
  resolving whether they are actually reported

## Generic Device-State Assumptions

These rules are intentionally generic. They apply across vendors, transports, and device models.

PELS should reason only from formal PELS concepts such as:

- observed binary state
- observed target / selected step
- measured power
- planner intent
- local writes
- pending confirmation windows
- estimated power when telemetry is missing or contradictory

PELS should not let vendor-specific diagnostic fields become a source of truth unless those fields
are explicitly part of the formal device model.

Contributor rule:

- use vendor-specific details to explain weird logs to humans
- do not let vendor-specific capability quirks shape generic planner truth rules unless the
  capability is formally modeled

### Binary confirmation is not full convergence

A device can confirm `onoff=true` or `onoff=false` before the rest of its state has converged.

Keep these separate:

- binary state confirmed
- measured power converged
- final device behavior converged

Do not assume binary confirmation means full convergence.

### Restore success is not defined by power shape

PELS restore intent is established by the write path:

- `onoff=true` for binary restores
- a higher target/step for target-based restores

Power telemetry is still useful after that, but only as advisory evidence for headroom and
diagnostics.

Contributor rules:

- do not treat a later tracked power drop by itself as proof that a restore failed
- use reconcile / observed device-state disagreement for "PELS wanted on, device is not on"
- keep normal device duty cycling out of penalty-bearing restore-failure paths

### Measured power may lag state transitions

A device may expose a new binary state quickly while measured power or final behavior still lags.

Do not assume fresh power simply because the command or binary state already changed.

### Local writes are provisional, not proof

Local writes are strong evidence that PELS requested a change.
They are not proof that the device has already converged.

Treat a local write as:

- requested state change
- provisional transition
- awaiting observed confirmation

Activation-backoff rule:

- do not treat tracked power shape by itself as proof that a restore succeeded or failed
- do not treat planner-driven sheds as failed activations
- use explicit device-state contradiction for settlement, drift detection, actuator retry, and
  reconcile
- only tight recent-restore overshoot attribution should create restore-blocking setback state

### Observation paths can disagree temporarily

Different observation paths may briefly disagree:

- one path says on, another still says off
- measured power is non-zero while another state field still looks stale
- state looks updated while power lags
- power looks updated while state lags

Assume this can happen for any managed device, not just one vendor or model.

### Fallback estimates are planning inputs, not measured truth

Fallback estimates are necessary for planning when telemetry is missing or contradictory.

Keep the distinction explicit:

- measured power is telemetry
- estimated power is a planning assumption

### Fresh observed state should eventually win

Even with laggy or contradictory telemetry, fresher trusted observations must eventually replace
older local-write assumptions, older snapshot assumptions, and older fallback estimates.

### Reconciliation-only tracked transitions are not restore proof

Tracked power transitions seen during startup, snapshot refresh, or other reconciliation are useful
diagnostics, but they are not by themselves proof that PELS restored a device.

Contributor rule:

- do not let reconciliation-only or inferred tracked rises open penalty-bearing activation attempts
- restore-blocking backoff must start from trusted restore actuation, not from snapshot churn

## Data Sources

### 1. Local command/write path

Examples:

- `setCapabilityValue(...)`
- pending binary/target/step command state
- local "just wrote this" timestamps

Use it for:

- recording intent
- suppressing immediate false drift after our own command
- tracking pending confirmation windows
- retry/backoff decisions

Do not use it as:

- proof that the device has already changed
- proof that Homey's next full snapshot is fresh
- proof that power draw has already changed

Reliability:

- very reliable for "PELS requested X"
- not reliable for "device is now X"

Known failure mode:

- optimistic local writes make devices appear restored before telemetry confirms them

### 2. Realtime device updates

Examples:

- `device.update`
- capability change payloads from Homey

Use it for:

- freshest observed state for the changed capability
- fast drift detection
- clearing pending state when the update is trustworthy and matches the requested result

Do not assume:

- the event includes every relevant capability
- unchanged fields in the event are fresh
- event ordering is perfect relative to local writes and snapshot refreshes

Reliability:

- usually the freshest source for the specific capability that changed
- only partial, and can still race with local writes or later stale refreshes

Known failure modes:

- partial updates leave other capability fields stale
- a later snapshot refresh can overwrite fresher realtime state
- cloud/laggy devices may emit confirmation much later than local devices

### 3. Full snapshot refresh

Examples:

- device list refresh
- refresh of `latestTargetSnapshot`

Use it for:

- broad state reconstruction
- capabilities not covered by a recent realtime event
- availability, metadata, and full-device shape

Do not assume:

- a full fetch is newer than a recent local write
- a full fetch is newer than a recent realtime event for every field

Reliability:

- broadest coverage
- not necessarily freshest per field

Known failure modes:

- stale Homey snapshot overwrites a fresher local write or realtime observation
- planner starts reasoning from rolled-back state

### 4. Measured power telemetry

Examples:

- `measure_power`
- `meter_power`
- Homey live energy `values.W`
- whole-home power samples

Use it for:

- actual load attribution
- headroom safety
- detecting whether a supposedly restored device is probably already drawing load

Do not use it as:

- direct proof of binary/onoff state
- direct proof of selected stepped-load state

Reliability:

- strongest source for "power is being drawn"
- weaker for "which exact device state caused it"

Known failure modes:

- power arrives later than the command
- whole-home power is authoritative for safety, but not for exact per-device attribution

### 5. Static config / estimated power

Examples:

- `settings.load`
- expected power override
- stepped-load planning power

Use it for:

- restore planning
- conservative budgeting
- candidate ordering when measured power is absent

Do not use it as:

- observed live power
- proof that a command has taken effect

Reliability:

- useful for planning
- not telemetry

## Trust Order By Question

### "What did PELS ask for?"

Trust:

1. local command state
2. pending command records

### "What is the freshest observed capability value?"

Trust:

1. recent realtime capability update
2. recent full snapshot
3. otherwise unknown/stale

Local write intent does not answer this question.

### "What should the planner assume right now?"

Trust depends on direction and risk:

- for restore/upward movement, pending state may justify "requested, unconfirmed"
- for shed/downward movement, use the conservative still-high/still-on assumption until confirmation unless there is stronger evidence
- for hard-cap safety, trust whole-home power over device attribution

### "Did the command succeed?"

Trust:

1. confirming telemetry
2. timeout expiry means "unknown/failed to confirm", not "confirmed"

Local write alone is not success.

## Observed Homey Challenges

These are the recurring patterns behind the current TODO items.

### Homey can be stale in both directions

- A device may already have changed, while Homey still reports the old state
- A later full refresh may also be older than a recent local write or realtime event

This is why "just compare live vs plan" is too naive.

### Realtime is fresh but partial

A realtime `onoff` update may be newer than the snapshot for `onoff`, while the target temperature or power field is still only known from the last full fetch.

### Snapshot refresh is broad but can roll state backward

A full fetch can improve coverage while still being older for one or two important fields.

### Power is authoritative for safety, not attribution

Whole-home metering protects against hard-cap overshoot even if PELS misattributes which device changed.
That lowers the severity of some attribution bugs, but it does not make them harmless for restore order, drift reasoning, or user-visible diagnostics.

### Slow/cloud devices need longer confirmation windows

A device can take tens of seconds before trusted telemetry reflects a command.
During that window, PELS should:

- remember the request
- avoid claiming confirmation early
- avoid declaring drift too early
- avoid retry loops caused by a too-short pending timeout

## Practical Rules For Reconcile Work

When changing reconcile logic, prefer these rules:

1. Drift should compare observed state against intended plan state, not only against the last stored snapshot value.
2. Realtime updates should update the observed view before drift evaluation uses that field.
3. Reapply should target the plan state, not the observed transition direction.
4. Logs should distinguish:
   - observed transition
   - planned target
   - commanded/pending target
5. If an equivalent command is already pending, suppress duplicate reapply unless retry policy explicitly allows it.

## Practical Rules For Refresh Merging

When merging snapshot refreshes with local/runtime state:

1. Never let an older full fetch erase a fresher local or realtime observation without evidence it is newer.
2. Preserve pending command state until confirmation or timeout.
3. Treat "no confirmation yet" as pending/unknown, not success.
4. Keep `measure_power`-derived observations separate from estimated/planning power.

## Flow-Reported Observations

Flow-backed reports are observed state, not commanded state.

Rules:

1. Store flow-backed values under the real canonical capability ids such as `onoff`,
   `measure_power`, `evcharger_charging`, and `evcharger_charging_state`.
2. Apply flow-backed values as an overlay during parse/snapshot building; do not introduce a
   parallel device model.
3. Treat flow-backed values as freshness-bearing observed state for snapshot admission and live
   status, but not as proof that PELS issued a command.
4. Do not infer binary or EV charging state from flow-reported power alone.

## Open Problem Areas

This note does not solve the implementation by itself. The active backlog still includes:

- binary pending confirmation semantics
- stale-observation handling / freshness thresholds
- communication-model-aware confirmation windows
- conservative downward stepped-load semantics
- provisional post-command state for laggy devices
- binary drift/reconcile consistency
- explicit source-of-truth logging for stepped devices

See `TODO.md` for the executable backlog.
