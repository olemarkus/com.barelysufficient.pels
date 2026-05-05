# planContract

- This package holds neutral plan decision contracts shared across planner, executor, diagnostics, and logging.
- Keep this package pure: no Homey SDK, device manager, planner state, executor command, snapshot, or runtime side-effect imports.
- Put planner-owned selection, budgeting, and restore admission logic in `lib/plan/`.
- Put executor-owned command materialization, retries, confirmation, and device I/O logic in `lib/executor/`.
- Shared predicates here should describe the meaning of an already-produced plan decision, not decide what to shed, resume, or command.
