# Notes Layer

- Notes are contributor-facing engineering context. Keep user-facing wording out of this folder unless the note explicitly discusses UI vocabulary.
- `testing-taxonomy.md` is the canonical test classification (unit / integration / e2e), the `test/` folder layout, and the tier commands. Read it before adding or relocating tests.
- For executor boundary work, use this rule: `ExecutablePlan` is intent only, `ExecutableObservedDeviceState` is observer truth, and executor code reconciles the two.
- Do not document planner-derived current state as executor truth. Transitional adapters may use legacy plan fields only for command baselines while public contracts still carry those fields.
- When updating state-management notes, keep the ownership split explicit: planner decides desired state, observer supplies current state, device transport (`lib/device/`) carries reads and writes, executor issues commands and handles pending/materialization.
