# Planner input production

`lib/planInput/` owns the cross-domain projection from a device's joined
runtime-configuration/observation surfaces to the `PlanInputDevice` contract.
It resolves the producer facts once; `lib/plan/` consumes those facts and owns
the plan decision.
The shared external-off hold projection also lives here because its answer
combines the Observer state with the hold store for both planner and executor.

Two projections here feed runtime consumers other than the planner, because they
read the same owner-resolved device control the planner input does:
`deviceControlProjection.ts` decorates runtime snapshots with the chosen control
axis and command state (planner input, runtime UI reads), and
`lifecycleFallbackDeviceProjection.ts` narrows that decorated carrier into the
executor's `LifecycleFallbackDevice` (the executor may not read `lib/device`
itself). Besides the external-off hold projection above, these are the only
executor-input exceptions; anything that reads the
plan's own output (a planned step, a decision) belongs to `lib/plan` and reaches
the executor through a setup-wired port.

This is a deliberate integration layer above the peer domains, not another
peer. It may read the device, observer, plan, and other domain owners needed to
form the planner's input. Peer domains must never import this layer. Setup may
construct its required `PlanInputProjectionSource` from owner reads and pass it
to the producer, but the producer must not import `AppContext`, `setup/`, or the
Homey SDK, and must not retain mutable state.

The source contract has required operations. Genuine per-device absence stays
in the return types of those reads where the domain already has that state;
do not add optional source operations or nullable fallbacks for wiring
convenience. Keep plan-input fields resolved and required wherever their owner
guarantees them.

The home-specific options on the projection are wiring policy: main-home
defaults and sub-home overrides. They do not authorize home membership,
priority ranking, or runtime mutation here. Those remain with their owners and
their existing setup seams.
