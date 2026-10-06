# Device Layer

`lib/device/` owns runtime device configuration, Homey transport, snapshot and realtime ingestion, and device-level power estimates. `lib/observer/` resolves observation truth; `lib/planInput/` projects those facts into planner input. See `notes/state-management/observer-transport-split.md` for the ownership map and `notes/ev-car-link/README.md` for car association.

## Device State Invariants

Keep these concepts separate: **planned** is the desired plan, **commanded** is what PELS asked Homey to do, **observed** is trusted telemetry, **pending** is a command awaiting confirmation, and **effective planning** is the conservative producer-resolved input to the planner. A local write proves a request, not device convergence; a timeout means unknown, not success. Whole-home power is the safety authority when per-device attribution disagrees.

### Source trust order

A newer realtime observation can outrank an older snapshot. Snapshot refresh must not roll back fresher accepted state or a local command without evidence of a newer device value. Accepted observations persist until their owner replaces or invalidates them; a quiet device does not time out. The producer resolves evidence and pending commands before exposing flat `PlanInputDevice` fields; planner consumers do not inspect provenance.

### Hard invariants

- A full device fetch or `device.update` must satisfy `transport/deviceReadContract.ts`: the capability list and every capability PELS reads for that device role have a model-typed value and valid source timestamp. Validate after vendor conversion. A non-conforming read is a no-op, including for a full fetch; do not parse it, merge partial fields, remove the previous device, or treat the omission as a fresh event. Per-capability realtime events have their own narrower arrival-time contract.
- Facts implied by the inventory class are resolved only in this layer, as required flags: `isEvCharger` and `isBatteryOrSolar` on the descriptor, and `starvationSupported` on device configuration. Planner input, executor reads and smart-task eligibility read those flags, never `deviceClass`, which planner input does not carry. Elsewhere, branch on the class only for a choice about that specific class (a battery or panel role, class-keyed defaults, grouping in the device list). A fact a consumer needs is a required field on the producer's type: an optional one lets a carrier that lost it compile and read as "no".
- A stepped identity requires a usable ladder with a step above 0 W (`hasUsableSteppedLoadLadder`). Resolve the identity and ladder together. Consumers should never have to repair an empty or off-only stepped profile.
- Confirmation requires matching telemetry. Binary `onoff` confirmation alone does not prove that final power or stepped behavior has settled. Fallback and estimated power are planning inputs, not measured telemetry. Do not infer binary on/off state from power draw.
- An unobserved binary control resolves `currentOn` to `false`, while `binaryControlObservation` carries the unknown signal. Do not synthesize an on transition from a binary-less update.
- Admit a non-off flow step report even while the binary axis reports off; it is observed step evidence and may be needed to confirm preparation. The binary axis still controls effective on/off, and restore sizing uses the target step.
- EV state of charge is valid by physical charging session, not by elapsed silence. Only a plug-out ends that session. An associated car becoming unavailable suspends its live association and car-sourced level while retaining the session for recovery. A connected sub-state change does not create a new session anchor; a full refresh uses the retained session. Do not add an age cutoff.
- Retained trusted device power survives restart in `retainedPowerStore.ts`; an absent device in one save does not delete its row. The flow-backed state records shared with transport are updated in place so transport keeps the same references.

### Merge and convergence

Realtime observations update the observed view before any convergence decision. Preserve pending command state until confirmation or timeout, and suppress an equivalent pending write unless retry policy permits it. Execution compares a newly decided plan with observer truth through `lib/executor/`; it does not reapply a committed plan directly after a device event. Structured logs should distinguish observed, planned, commanded, and pending values.
