# Executor Layer

- This folder owns runtime actuation concepts: what PELS is trying to command, whether that command has materialized, and whether execution should issue, retry, wait, or skip.
- Do not add planner decision logic here. Planner modules decide desired state; executor modules consume those decisions and runtime observations.
- **Converging observed state onto desired state is this layer's charter, and it is unconditional.**
  `executorConvergence.ts` answers "does the executor still have work to do?" (and the settle
  question "has what I dispatched materialized?"); `planExecutionDrift.ts` answers it per device.
  Both live here because the planner must not consult them — see `no-plan-to-executor`.
- **There is exactly one actuation LANE.** There used to be a second, privileged mode
  (`PlanActuationMode = 'plan' | 'reconcile'`) for re-applying a committed plan after drift. It
  bypassed pending-target retry suppression and skipped stamping the restore cooldown, and together
  those let a re-assert outrun the planner's own admission gate and breach the hard cap in
  production (`TODO.md`, inc_26449fb9). Every actuation now respects retry suppression and stamps
  its cooldowns.

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
