# Charging-phase control

Physical phase control is separate from the saved EV control model. The saved
model remains the owner's configuration; a requested setting is not a physical
observation.

## Ownership

- `lib/device/peblar/` interprets public capabilities and translates semantic
  commands. Common device transport performs the SDK calls.
- `lib/phaseFootprint/` resolves each envelope's house-phase footprint.
  `three_L1`, `three_L2` and `three_L3` describe the installation and the house
  phase used for single-phase charging, in `device_phase_connections`.
- `lib/chargingPhases/` owns the original setting, durable claim, pending
  operation, timing, connection failure lock and hand-back through injected ports.
- `lib/plan/chargingPhasePlanning.ts` evaluates envelopes at the existing surplus
  and restore priority turns. The neutral execution contract carries the selected
  operation; a dedicated executor lane converges it through the actuator.
- Objectives read permitted future delivery separately from the observed ladder.
  One-phase operation does not erase permitted three-phase delivery from a task.

Dependency rules keep the phase owner a leaf and prevent runtime peers from
reaching its concrete implementation. Setup constructs it for Main and injects
its port. Meter areas share only its execution fence and device queue, without phase
planning or another owner for the same durable claims. Completing a hand-back
and lifting that shared fence depend on Main receiving another meter reading.

## Observation and admission

The phase setting acknowledges a request. Independent per-phase watts, checked
against total charger power, resolve the observed envelope. Idle retains the
last accepted envelope. Planning uses the permitted phase ceiling: unrestricted
charging retains the installation geometry even when a car draws on one phase.
A forced-single setting uses one-phase geometry only with admitted independent
one-phase evidence. Before drawing evidence exists, the installation supplies
conservative planning geometry.

A transition reserves the greatest still-possible source and target load on each
phase and in aggregate. Moving load between phases can require incoming capacity
without increasing total kW. An idle dip does not release this reservation.

A high-current session first receives current-only preparation. Its claim and
reservation are persisted before lowering current. A later meter decision
rechecks admission before requesting the phase change at the current floor.
Firmware performs the physical transition. Reductions and off commands remain
available; ordinary starts and increases cannot race the operation. Generations
fence queued commands and each subsequent SDK call.

## Lifecycle

`charging_phase_control` is opt-in configuration with one shared runtime/browser
codec. `charging_phase_claim.*` belongs exclusively to the runtime owner and
preserves the pre-PELS force-single setting across restart.

Unmanage, disabled control, simulation, unsuccessful transitions and restart
recovery produce explicit hand-back work. Returning to a setting that permits
more phases first pauses charging. Completion invalidates old single-phase
planning geometry before ordinary control resumes. A failed hand-back retains
its durable obligation.

Device reports update observations; they do not trigger a plan or advance an old
decision. Progress and timeouts are considered on meter-decided cycles. A failed
transition suppresses further automatic attempts for the same physical connection.

The SDK model separates optimistic settings from delayed physical power,
including an idle dip, ignored commands, per-phase pressure and recovery.
