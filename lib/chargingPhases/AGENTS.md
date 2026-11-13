# Charging phases

This leaf owns physical charging-phase control: durable ownership, transition
qualification, confirmation, the connection failure lock, and hand-back. It reads
admitted device facts and phase envelopes through ports. It never imports device
transport, planner, objectives, executor, or setup modules.

The requested phase setting is not physical evidence. Only independent per-phase
power can establish which envelope the vehicle uses. Idle retains the last
accepted envelope. Firmware handles physical transitions; PELS adds no stop/start
sequence to a phase request. Pending reservations survive the transition's idle
dip, and an unconfirmed switch never frees its outgoing phase load.

The planner owns admission and emits decisions; this owner executes only those
decisions through the actuator port. Observation can update facts but cannot issue
commands. All ordinary device writes and phase changes share the per-device queue;
phase changes fence increases and starts, never safety reductions or pauses.

Main owns phase planning and durable claims. Meter areas share only its execution
fence and per-device queue through `ExecutionOnlyChargingPhases`; their empty
phase axis cannot cancel Main's work or publish Main's phase contests. Hand-back
confirmation and lifting its fence depend on Main's next meter-driven plan.
