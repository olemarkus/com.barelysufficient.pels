# Internal Notes

Contributor- and agent-facing engineering notes that do not belong in the published user docs.
Notes are either **design-of-record** (why a shipped subsystem is shaped the way it is) or
**deferred-design** (a parked plan with a clear revisit trigger). Where a note describes shipped
work it carries a status line; treat anything without one as still-forward design.

Per-directory `CLAUDE.md` files (`state-management/`, `starvation/`, `daily-budget-auto-adjust/`)
are agent-context invariant digests, not notes — they are loaded automatically and are not listed
below.

## Conventions & references

- `AGENTS.md` — executable-plan intent rules for contributors/agents.
- `personas.md` — who each surface serves; the PELS-wide product rubric (`pels-ux-fit` lens).
- `ui-terminology.md` — canonical user-facing vocabulary for labels, status strings, tab names.
- `units.md` — unit conventions for runtime and UI surfaces (and the in-flight kW→W quantization).
- `overview-hero-spec.md` — Overview hero and device-card design reference.
- `browser-stub.md` — settings-UI test harness / audit-scenario reference.

## Architecture decision records

- `ev-soc-layering.md` — source-of-evidence SoC metadata stays in the observation layer.
- `persisted-settings-state.md` — proposed shared persisted-settings/recorder state helper (open).
- `objective-profile-bands.md` — learned-profile banding + display-confidence resolution model.
- `desktop-light-mobile-dark.md` — *(shipped)* light-canvas-on-desktop / dark-on-mobile theme model.
- `v2-7-2/postmortem-chart-policy.md` — active-vs-historic chart asymmetry policy.

## Runtime complexity & wiring

- `complexity-cleanup/README.md` — current runtime simplification map.
- `complexity-cleanup/god-file-policy.md` — `max-lines` policy + Bucket-B documented exceptions.
- `logging/README.md` — structured-logging policy, event inventory, ALS context.
- `native-wiring/README.md` — native stepped-load flow-conflict detection + device banner (shipped).
- `persisted-settings-state.md` — see Architecture decision records above.

## State management

- `state-management/README.md` — state-source trust, stale-data risks, reconcile pitfalls.
- `state-management/observer-transport-split.md` — *(shipped)* observer/transport split
  design-of-record; the layering rationale that runtime code + `.dependency-cruiser.cjs` point to.
- `state-management/deferred-objective-lifecycle-carveout.md` — lifecycle-release off the capacity
  shed lane (increment 1 shipped; north-star relocation still pending).

## Settings UI

- `settings-ui-reorganization.md` — *(partially shipped)* Overview/Budget/Usage/Smart-tasks/Settings
  ownership model.

## Deferred-load objectives & deadlines

- `deferred-load-objectives/README.md` — the cluster ADR for the deadline-aware objective model
  (soft temperature + horizon planner shipped; richer EV admission, contention handling deferred).
- `deferred-load-objectives/budget-bound-false-cannot-meet.md` — closed investigation: false
  `cannot_meet` under daily-budget binding.
- `deferred-load-objectives/feasibility-confidence.md` — *(shipped)* learned-rate confidence fix
  (sub-interval energy, within-band residual, `mean + k·SE` verdict margin).
- `deferred-load-objectives/feasibility-floor-vs-climbed-band.md` — floor-vs-climbed-band feasibility
  (both slices shipped).
- `ev-ready-by/README.md` — EV charging deadline feature (admission + trust surfaces shipped; kWh
  target mode + expanded observability deferred).
- `planning-horizon-milestones/README.md` — deferred energy-milestone / horizon-scheduling design.
- `status-hysteresis/README.md` — deferred extra status-transition hysteresis after the saved
  active-plan status gate.

## Smart tasks

- `smart-tasks-surface-spec.md` — governing reference for the Smart tasks settings surface
  (active list + Past tasks history): the value-contract and look, decided once.
- `smart-task-flow-cards/README.md` — smart-task trigger-card design (stable-id tokens; shipped).
- `smart-task-ui/README.md` — smart-task UI product-review / design rationale.
- `smart-task-miss-attribution.md` — *(shipped)* plan-time miss-attribution on finalized runs.
- `idle-classification.md` — *(shipped)* near_target_idle / unresponsive / capped_idle device states.

## Other features

- `starvation/README.md` — temperature-device starvation model; detection + rescue widget shipped,
  flow cards / insights still the gap.
- `daily-budget-auto-adjust/README.md` — planned daily-budget auto-adjust policy (unimplemented).
- `restore-eagerness/README.md` — narrowed remaining restore-admission concern (late-ramp overshoot).
