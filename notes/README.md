# Internal Notes

This directory is for contributor-facing and agent-facing engineering notes that do not belong in the published user docs.

Current notes:

- `complexity-cleanup/README.md`: phased plan for reducing runtime complexity — backoff
  simplification and several executor/device-manager/app helper extractions have already landed;
  the note now mainly tracks the remaining app/service/rebuild-scheduler cleanup work. Some LOC
  figures in that folder are historical review snapshots and should be remeasured before acting
  on them.
- `logging/README.md`: structured logging policy, current event inventory, ALS context, and
  migration guidance away from prose runtime logs.
- `restore-eagerness/README.md`: the narrowed remaining restore-admission concern after the larger
  restore-stability fixes landed.
- `state-management/README.md`: Homey state-source trust, stale-data risks, reconcile pitfalls, and guidance for pending/observed state work.
- `starvation/README.md`: intended temperature-device starvation model and the remaining rollout
  work; core diagnostics/service pieces now exist, but flows/insights are still the main gap.
- `daily-budget-auto-adjust/README.md`: planned daily-budget auto-adjust policy based on eligible exempted energy from completed days.
