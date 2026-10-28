# Internal Notes

Contributor- and agent-facing engineering notes that do not belong in the published user docs.
Notes are either **design-of-record** (why a shipped subsystem is shaped the way it is) or
**deferred-design** (a parked plan with a clear revisit trigger). Some files contain both
shipped decisions and forward design. Read the file's status and section headings before
treating a proposal as current behavior; the absence of a file-level status does not mean
the whole note is forward design.

Agent-context invariant digests live next to the code they protect, in per-module `AGENTS.md`
files (`lib/device/AGENTS.md` for state management, `lib/observer/AGENTS.md` for observation
quiescence, `lib/diagnostics/AGENTS.md` for starvation). The notes here are the
design-of-record behind those digests.

## Conventions & references

- `AGENTS.md` — executable-plan intent rules for contributors/agents.
- `personas.md` — who each surface serves; the PELS-wide product rubric (`pels-ux-fit` lens).
- `persona-acquisition.md` — the "before" companion to `personas.md`: each persona's trigger,
  search and channel before they install PELS.
- `ui-terminology.md` — canonical user-facing vocabulary for labels, status strings, tab names.
- `units.md` — unit conventions for runtime and UI surfaces (and the in-flight kW→W quantization).
- `overview-hero-spec.md` — Overview hero and device-card design reference.
- `browser-stub.md` — settings-UI test harness / audit-scenario reference.
- `testing-taxonomy.md` — the three test tiers (unit / integration / e2e) and where a new test lands.
- `settings-key-ownership.md` — one settings key, one reader/writer; owners of keys both sides read.
- `knip-migration-triage.md` — knip dead-code config shape and the entry-point traps to avoid.

## Architecture decision records

- `ev-soc-layering.md` — source-of-evidence SoC metadata stays in the observation layer.
- `persisted-settings-state.md` — cut shared persisted-settings helper proposal; rationale for keeping
  recorder persistence feature-specific.
- `objective-profile-bands.md` — learned-profile banding + display-confidence resolution model.
- `desktop-light-mobile-dark.md` — *(shipped)* light-canvas-on-desktop / dark-on-mobile theme model.
- `v2-7-2/postmortem-chart-policy.md` — active-vs-historic chart asymmetry policy.
- `temperature-ownership.md` — *(shipped)* PELS owns a managed thermostat's setpoint; the three
  "When the temperature changes outside PELS" policies.
- `price-periods.md` — *(shipped)* the price level follows the 15-minute quarter when the zone
  publishes quarter prices.
- `capacity-periods.md` — *(shipped)* hourly and quarter-hour capacity periods per home.

## Runtime complexity & wiring

- `complexity-cleanup/README.md` — current runtime simplification map.
- `complexity-cleanup/god-file-policy.md` — `max-lines` policy + Bucket-B documented exceptions.
- `logging/README.md` — structured-logging policy, event inventory, ALS context.
- `logging/diagnostics-report-deviation-gating.md` — *(partially shipped)* deviation-gated logging
  so a Homey diagnostics report keeps the evidence lines.
- `support-reports.md` — problem reports, the opt-in daily and event reports, and their size limits.
- `power-tracker-allocations.md` — power-tracker sample allocations under the immutable snapshot
  contract.
- `native-wiring/README.md` — native stepped-load flow-conflict detection + device banner (shipped).
- `persisted-settings-state.md` — see Architecture decision records above.

## State management

- `state-management/README.md` — state-source trust, stale-data risks, reconcile pitfalls.
- `state-management/observer-transport-split.md` — *(shipped)* observer/transport split
  design-of-record; the layering rationale that runtime code + `.dependency-cruiser.cjs` point to.
- `state-management/deferred-objective-lifecycle-carveout.md` — *(shipped)* smart-task
  controller inversion and lifecycle release; remaining follow-ups are marked in the note.
- `state-management/actuator-write-seam.md` — *(partially shipped)* the actuator as the single
  device write seam; the snapshot-store move is deferred and the tightening PR outstanding.
- `state-management/actuation-clocks-and-settle.md` — settle (executor) vs cooldown (planner)
  ownership and the restore pacing policy.
- `state-management/snapshot-decomposition.md` — *(shipped)* finishing the observer/transport
  split: narrow device configuration joined with Observer records.

## Settings UI

- `settings-ui-reorganization.md` — *(partially shipped)* Overview/Budget/Usage/Smart-tasks/Settings
  ownership model.
- `web-app.md` — *(partially shipped)* the settings UI outside Homey: API-key access, one build
  per PELS version behind a launcher for several Homeys, measured load time.
- `settings-ui-semantic-map.md` — canonical role/naming map every settings page composes.
- `widget-review.md` — *(shipped)* 2026-05-30 review of the dashboard widgets and the polish train.

## Deferred-load objectives & deadlines

- `deferred-load-objectives/README.md` — the cluster ADR for the deadline-aware objective model
  (soft temperature, horizon planning, EV pause/resume admission, and priority-ordered
  multi-objective contention shipped; richer step escalation deferred).
- `deferred-load-objectives/budget-bound-false-cannot-meet.md` — closed investigation: false
  `cannot_meet` under daily-budget binding.
- `deferred-load-objectives/feasibility-confidence.md` — *(shipped)* learned-rate confidence fix
  (sub-interval energy, within-band residual, `mean + k·SE` verdict margin).
- `deferred-load-objectives/feasibility-floor-vs-climbed-band.md` — floor-vs-climbed-band feasibility
  (both slices shipped).
- `deferred-load-objectives/execution-adaptation.md` — *(shipped)* trajectory rebase and
  mid-execution price deferral.
- `deferred-load-objectives/preemptive-power-reservation.md` — the "pause lower-priority devices"
  permission: reserving a contiguous power block ahead of a large-step start.
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

- `starvation/README.md` — temperature-device and EV-charger starvation model; detection + rescue widget shipped,
  flow cards / insights still the gap.
- `starvation/surplus-absorb-safety.md` — why the solar surplus lift can never cause or mask
  starvation.
- `restore-eagerness/README.md` — narrowed remaining restore-admission concern (late-ramp overshoot).
- `safe-pace-two-constraints.md` — safe pace as capacity and daily-budget constraints; naming
  table and shipped rebase are design-of-record, the split model is forward design.
- `end-of-hour-mode.md` — capacity-period boundary drain of the sustainable rate.
- `budget-feedback-replay.md` — daily-budget feedback correction and its historical replay script.
- `budget-diagnostics-api.md` — the two app API reads for daily-budget history and decisions.
- `weather-insight-spec.md` — Weather insight UI copy and state spec.
- `multi-home-model.md` — design-of-record for Multiple meters (generally available).
- `multi-home-complement.md` — Main as the membership complement of its meter areas.
- `charging-control/README.md` — vehicle and charger current control: start/stop, current
  capability, built-in action with an API key, or a Flow.
- `ev-car-link/README.md` — car-to-charger link probe and its adoption for charge level and limit.
- `ev-charger-state-copy.md` — what an EV charger card may say, given the four charger and car
  signals.
