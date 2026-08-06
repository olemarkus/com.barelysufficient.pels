# Executor Layer

- This folder owns runtime actuation concepts: what PELS is trying to command, whether that command has materialized, and whether execution should issue, retry, wait, or skip.
- Do not add planner decision logic here. Planner modules decide desired state; executor modules consume those decisions and runtime observations.
- **Converging observed state onto desired state is this layer's charter, and it is unconditional.**
  `executorConvergence.ts` answers "does the executor still have work to do?" (and the settle
  question "has what I dispatched materialized?"); `planExecutionDrift.ts` answers it per device.
  Both live here because the planner must not consult them — see `no-plan-to-executor`.
- **There is exactly one actuation path.** There used to be a second, privileged mode
  (`PlanActuationMode = 'plan' | 'reconcile'`) for re-applying a committed plan after drift. It
  bypassed pending-target retry suppression and skipped stamping the restore cooldown, and together
  those let a re-assert outrun the planner's own admission gate and breach the hard cap in
  production (`TODO.md`, inc_26449fb9). Every actuation now respects retry suppression and stamps
  its cooldowns. Do not reintroduce a mode, flag, or `force` parameter that exempts a write from
  either — if a device genuinely needs re-asserting, that is a decision, and decisions are the
  planner's.
- Compatibility reads from legacy plan/snapshot fields are allowed only in small adapter helpers that return executor-facing concepts.
- Keep UI wording, snapshot serialization, and settings contracts out of this layer.
