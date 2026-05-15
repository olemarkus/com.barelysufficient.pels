# Internal Notes

This directory is for contributor-facing and agent-facing engineering notes that do not belong in the published user docs.

Current notes:

- `complexity-cleanup/README.md`: current runtime simplification map after the major executor,
  device-manager, app-helper, timer, context, and rebuild-scheduler slices landed.
- `complexity-cleanup/god-file-policy.md`: proposal for replacing blanket `max-lines` waivers
  with explicit shrink targets or documented config-level ceilings.
- `logging/README.md`: structured logging policy, current event inventory, ALS context, and
  migration guidance away from prose runtime logs.
- `settings-ui-reorganization.md`: target product/navigation ownership model for reorganizing the
  Settings UI around Overview, Budget, Usage, Smart tasks, and Settings while preserving canonical
  owners for limits, devices, modes, price, simulation mode, and advanced diagnostics.
- `ui-terminology.md`: canonical user-facing vocabulary for UI labels, status strings, tab names,
  and help text.
- `restore-eagerness/README.md`: the narrowed remaining restore-admission concern after the larger
  restore-stability fixes landed.
- `state-management/README.md`: Homey state-source trust, stale-data risks, reconcile pitfalls, and guidance for pending/observed state work.
- `starvation/README.md`: intended temperature-device starvation model and the remaining rollout
  work; core diagnostics/service pieces now exist, but flows/insights are still the main gap.
- `daily-budget-auto-adjust/README.md`: planned daily-budget auto-adjust policy based on eligible exempted energy from completed days.
- `deferred-load-objectives/README.md`: deadline-aware objective model for loads that need to
  reach a ready state; the soft temperature runtime slice has shipped, while richer EV admission,
  step-change history, and contention handling remain future work in this note. Hard deadlines
  and energy-based milestones are deferred and moved to dedicated notes (see below).
- `ev-ready-by/README.md`: product framing, release-readiness analysis, and prioritized task
  plan for the user-facing EV charging deadline feature built on the deferred-load-objectives
  model.
- `hard-deadlines/README.md`: deferred-from-v1 design for hard-enforcement deadlines, the
  hard-objective admission lane, hard-boost rebalancing, and the temperature-side mode-override
  subsystem. Soft enforcement is what ships today.
- `planning-horizon-milestones/README.md`: deferred-from-v1 design for energy-based milestones
  and the priority-adjusted horizon-scheduling model. The shipped horizon planner covers the
  same intent via deadline-reserve and `planned_using_policy_avoid` reasons.
- `smart-task-flow-cards/README.md`: redesign proposal for the smart-task trigger cards —
  drop dropdown filtering args, expose stable-id tokens as public-API contract, add numeric
  tokens and a composed `notification_text` token. Tracked as P0 in `TODO.md`.
- `status-hysteresis/README.md`: deferred-from-v1 design for hysteresis on smart-task status
  transitions and confidence-scaled deadline margins. Trigger to revisit is real telemetry
  showing user-observable flapping; a target-boundary deadband is the smaller alternative
  fix for the only edge case the shipped flow-trigger dedup doesn't already cover.
- `ev-soc-layering.md`: decision record for keeping SoC source-of-evidence metadata inside the
  observation layer.
- `overview-hero-spec.md`: current Overview hero and device-card design reference.
- `persisted-settings-state.md`: design note for a shared persisted-settings state helper.
- `units.md`: unit conventions for runtime and UI surfaces.
