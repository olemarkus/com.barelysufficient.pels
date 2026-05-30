# EV state of charge — layer boundaries

## Source-of-evidence metadata stays in the observation layer

The observation layer (`lib/device/transport/stateOfCharge.ts`,
`lib/device/transport/managerObservation.ts`,
`lib/device/transport/flowReportedCapabilities.ts`) is responsible for resolving a
device's SoC from whichever inputs are available — native capability values,
flow-reported synthetic values, freshness timestamps. Downstream layers
(plan / executor / contracts / UI) read the resolved `DeviceStateOfChargeSnapshot`
and act on `{ percent, status, observedAtMs, sessionStartedAtMs,
invalidatedAtMs }`.

Source-of-evidence metadata — "did this value come from a native capability
or a flow-reported synthetic input?" — does **not** belong on the public
snapshot. It is observation-layer detail that consumers never need in order
to make a decision: `status` already tells you whether the reading is fresh,
stale, unknown, or invalid; `observedAtMs` already tells you when it was
captured.

`capabilityId` stays on the snapshot because the observation layer itself
reuses it to route realtime updates and to detect snapshot-diff dirtiness
(`lib/device/transport/managerObservation.ts`,
`lib/device/transport/managerRealtimeHandlers.ts`). It is consumed
within the same layer that emits it.

## Synthetic SoC and capability naming

Flow-reported SoC currently writes to native Homey capability ids
(`measure_battery`, `measure_soc_usable`, `measure_soc_level`). The
alternative is a `pels_state_of_charge` capability that marks the synthetic
origin at the capability level.

Decision (2026-05-13): **stay on native ids** until a concrete behavioral
need forces a split. Reasons:

- Homey's native EV UI surfaces (battery indicator, charge progress) consume
  `measure_battery` directly. A `pels_`-prefixed capability would lose that
  UX and require parallel handling.
- The only consumer that ever distinguishes synthetic from native is the
  observation layer itself, which can do so via `flowReportedCapabilities`
  bookkeeping — no contract-level marker is needed.
- The `source: 'capability' | 'flow'` field on the public contract added no
  consumer-visible behavior and has been removed.

Revisit if:

- Deadline / objective planning needs to discount synthetic SoC readings
  relative to native (different trust levels in scheduling decisions).
- Diagnostics surfaces want to render "value from flow" badges to the user.
- A future SoC contract carries multi-source consensus (e.g. native vs
  flow disagreement) and the planner has to act on the divergence.

When that happens, the right move is to introduce a typed source field
again (or a richer per-source snapshot) — not to retrofit a `source` flag
into the existing single-value contract.
