# Internal Notes

This directory is for contributor-facing and agent-facing engineering notes that do not belong in the published user docs.

Current notes:

- `complexity-cleanup/README.md`: phased plan for reducing runtime complexity — backoff
  simplification, reason/decision separation, and the remaining executor/app/service/deviceManager
  cleanup work.
- `logging/README.md`: structured logging policy, current event inventory, ALS context, and
  migration guidance away from prose runtime logs.
- `restore-eagerness/README.md`: the narrowed remaining restore-admission concern after the larger
  restore-stability fixes landed.
- `state-management/README.md`: Homey state-source trust, stale-data risks, reconcile pitfalls, and guidance for pending/observed state work.
- `starvation/README.md`: planned temperature-device starvation detection model, state machine, thresholds, UI, flows, and diagnostics requirements.
- `daily-budget-auto-adjust/README.md`: planned daily-budget auto-adjust policy based on eligible exempted energy from completed days.
