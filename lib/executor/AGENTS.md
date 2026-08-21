# Executor Layer

- This folder owns runtime actuation concepts: what PELS is trying to command, whether that command has materialized, and whether execution should issue, retry, wait, or skip.
- Do not add planner decision logic here. Planner modules decide desired state; executor modules consume those decisions and runtime observations.
- **The planner's shed policy does not reach this folder.** `grep -rn shedAction lib/executor/`
  must stay empty. The planner decides where a shed leaves a device and hands over the END STATE as
  `DevicePlanDevice.plannedShedTargetKind` — `binary_off`, a `step`, or the `target_value` the plan
  already carries as `plannedTarget`, absent when the device is not shed this cycle. Executor code
  reads that kind (pairing it with its own resolved step via `ExecutableShedTarget`) and converges
  onto the destination. Do not reintroduce a read of the policy, not even behind a helper: a
  device's configured shed behaviour is a FLOOR, the deepest the planner may go, not this cycle's
  decision, so re-reading it here can only re-derive a decision this layer was not handed.

  That FLOOR is load-bearing, not a turn of phrase. A `turn_off` device is routinely left RUNNING
  at an intermediate rung — the planner descends its ladder only as far as the deficit requires
  (`lib/plan/shedding/AGENTS.md`) — and such a device arrives here as `plannedShedTargetKind:
  'step'`. Its binary axis is undemanded, `resolveSteppedLoadTransition` does not enter
  `full_shed_to_off`, and `applySteppedLoadShedOff` must not fire. Anything that answers "shed
  behaviour is turn_off, so the device ends up off" cuts the whole load the rung was chosen to keep.
  Same rule for plan devices: project them onto a narrow executor-facing view first
  (`ExecutableConvergenceDevice`, `ExecutableSteppedLoadIntent`, …), never pass the whole plan
  device in.
- **Converging observed state onto desired state is this layer's charter, and it is unconditional.**
  `executorConvergence.ts` answers "does the executor still have work to do?" (and the settle
  question "has what I dispatched materialized?"); `planExecutionDrift.ts` answers it per device.
  Both live here because the planner must not consult them — see `no-plan-to-executor`.

  **The live side of that comparison comes from the OWNERS, never from a plan.** The observation is
  read per device from the observer projection; the in-flight command state comes from this layer's
  own stores (`pendingBinaryCommandStore`, `steppedCommandState`); the ladder is configuration and
  rides the intent. `driftObservedDevice.ts` is the seam that joins them, and `PlanExecutor.driftObservationDeps()`
  is where they are bound. A device the observer has not seen yet is SKIPPED, not assumed to agree.

  **A drift verdict is only valid as of the observation revision the plan was built from.** The
  build awaits, so the observer can accept a write mid-build; `hasExecutionWorkOutstanding` compares
  `getObservationRevision()` against the revision captured before the build's inputs and declines
  when they differ. Acting anyway would apply a plan decided against a world that has since moved —
  an apply-without-decide, which is what `inc_26449fb9` was. The gate is deliberately
  whole-projection and fail-closed: it can only decline, never act on something stale.

  **Exactly one predicate may inform an actuation decision: `hasPlanExecutionDriftAgainstIntent`.**
  It compares planner intent against an OBSERVATION. Its neighbour
  `hasLiveStateDivergedFromSnapshot` compares two `DevicePlan`s positionally, and the live side is
  always `buildLiveStatePlan` output — the old decision seen freshly. It exists solely as the
  precondition of `canRefreshPlanSnapshotFromLiveState`, whose callers only adopt a refreshed
  snapshot and emit `planUpdated`; deciding to actuate from it would be an apply-without-decide
  path under a new name (`inc_26449fb9`). `scripts/check-executor-settle-seam.mjs` keeps every
  reference to it out of runtime code outside `executorConvergence.ts` — if a caller needs the
  answer, it is asking the wrong question.
- **There is exactly one actuation LANE.** There used to be a second, privileged mode
  (`PlanActuationMode = 'plan' | 'reconcile'`) for re-applying a committed plan after drift. It
  bypassed pending-target retry suppression and skipped stamping the restore cooldown, and together
  those let a re-assert outrun the planner's own admission gate and breach the hard cap in
  production (`TODO.md`, inc_26449fb9). Ordinary actuation now respects retry suppression and stamps
  its cooldowns; the one documented exception is the post-activation `force` below, which bypasses
  the pending/back-off skips for a reason grounded in device behaviour rather than in provenance.

  Do not reintroduce a **mode** — a lane-wide flag that exempts a whole class of writes from those
  brakes because of where the write came from. Provenance is not a reason to skip a cooldown.

  This is NOT a ban on every `force`. A narrow, per-call override justified by device physics is
  legitimate and one already exists: `planExecutorDispatch.ts` passes
  `force: stepRestore.wroteBinary` into `applySteppedLoadCommand`, which uses it to bypass the
  redundant-command and pending/backoff skips (`steppedLoadExecutor.ts`). It is load-bearing —
  binary activation can reset the device-side step limit even when the stale observation still
  matches the desired step, so without the reassertion the device runs at its reset, possibly
  HIGHER limit. Deleting it in the name of this rule would be a capacity-safety regression.

  The test is what justifies the exemption: a fact about the device (activation resets its step)
  is fine; a fact about the caller (this write came from the reconcile lane) is not.
- **One field, one meaning — on every construction path.** `ExecutableObservedDeviceState` carries
  `observedBinaryAxis` (the raw on/off handle) and `observedEffectiveOn` (the producer fold: off when
  the binary axis reads off OR the stepped axis is parked at its off step). They were a single
  `observedBinaryState` whose meaning was selected by which path built it, so the same read answered
  differently depending on its caller — the defect at the heart of the drift P0. Actuation asks the
  axis (is the handle already where I would write it?); convergence asks the fold (is this device
  effectively off?). A reader that cannot say which question it is asking is the thing to fix; do not
  merge the fields again.
- Compatibility reads from legacy plan/snapshot fields are allowed only in small adapter helpers that return executor-facing concepts.
- Keep UI wording, snapshot serialization, and settings contracts out of this layer.
