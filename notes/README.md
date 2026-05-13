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
  reach a ready state; the soft temperature runtime slice has shipped, while hard deadlines,
  richer EV admission, step-change history, and contention handling remain future work.
- `ev-ready-by/README.md`: product framing, release-readiness analysis, and prioritized task
  plan for the user-facing EV charging deadline feature built on the deferred-load-objectives
  model.
- `ev-soc-layering.md`: decision record for keeping SoC source-of-evidence metadata inside the
  observation layer.
- `overview-hero-spec.md`: current Overview hero and device-card design reference.
- `persisted-settings-state.md`: design note for a shared persisted-settings state helper.
- `units.md`: unit conventions for runtime and UI surfaces.
