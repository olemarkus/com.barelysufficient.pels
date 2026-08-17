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
  Same rule for plan devices: project them onto a narrow executor-facing view first
  (`ExecutableConvergenceDevice`, `ExecutableSteppedLoadIntent`, …), never pass the whole plan
  device in.
- **Converging observed state onto desired state is this layer's charter, and it is unconditional.**
  `executorConvergence.ts` answers "does the executor still have work to do?" (and the settle
  question "has what I dispatched materialized?"); `planExecutionDrift.ts` answers it per device.
  Both live here because the planner must not consult them — see `no-plan-to-executor`.
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
- Compatibility reads from legacy plan/snapshot fields are allowed only in small adapter helpers that return executor-facing concepts.
- Keep UI wording, snapshot serialization, and settings contracts out of this layer.
