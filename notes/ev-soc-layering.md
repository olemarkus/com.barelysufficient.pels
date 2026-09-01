# EV state of charge — layer boundaries

## Source-of-evidence metadata stays in the observation layer

The observation layer (`lib/device/transport/stateOfCharge.ts`,
`lib/device/transport/managerObservation.ts`,
`lib/device/transport/flowReportedCapabilities.ts`) is responsible for resolving a
device's SoC from whichever inputs are available — native capability values,
flow-reported synthetic values, session timestamps. Downstream layers
(plan / executor / contracts / UI) read `level` off the resolved
`DeviceStateOfChargeSnapshot` and act on that alone:

```ts
level: { kind: 'known'; percent } | { kind: 'unavailable'; reasonCode }
```

**The producer publishes no staleness, freshness, or currency signal, and no
consumer may invent one.** A battery level is reported on change and can only
change while a car is attached, so the SESSION decides whether PELS has a level —
never a clock. A 40-minute age gate (`EV_SOC_STALE_MS`) used to live here and was
deleted on 2026-08-08: it marked a reading stale the instant a longer pause
ended, and resurrected an aged-out one at the next idle observation. The four-arm
`status` flag it fed went with it, along with the five different policies its
consumers had each invented over it.

`percent` remains on the snapshot for the observation layer's own bookkeeping
(carry-forward across a refresh, change detection). It is not the device's level
and must not be read as one.

Source-of-evidence metadata — "did this value come from a native capability
or a flow-reported synthetic input?" — does **not** belong on the public
snapshot. It is observation-layer detail that consumers never need in order
to make a decision: `level` already tells you whether PELS has a battery level
for this charger, and `observedAtMs` already tells you when the reading was
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

## Amendment (2026-08-03): `source: 'car'` is a different question

`DeviceStateOfChargeSnapshot` now carries `source?: 'car'` and `sourceDeviceId?`
(PR #1975). That is not a reversal of the decision above, and the distinction is
worth stating so neither rule gets applied to the other case.

The removed field asked *which charger-side input produced this* — native
capability or flow-reported synthetic. Both describe the same device, and no
consumer ever needed to tell them apart, which is exactly why it went.

`'car'` says the value came from a **different device**: the associated car,
adopted because the user ticked it for this charger
(`notes/ev-car-link/README.md`). It has real consumers, and each of them would be
wrong without it:

- `lib/device/flowBackedDeviceState.ts` — a flow report must not wake the planner for, or
  refresh the freshness of, a level the flow card no longer supplies.
- `retainedCarCandidate` (`lib/device/transport/stateOfCharge.ts`) — parse carries
  a car reading across refreshes and must not promote a charger-owned one.
- `clearCarStateOfCharge` — an ended association drops only what the car supplied.
- `buildEvCarLinkChargerViews` — the accuracy shadow must not compare a car
  reading against itself.

The original rule still holds for everything it covered: charger-side provenance
stays in the observation layer, and `level` is the complete answer to "does PELS
have a battery level here". `source` answers "whose reading is it", which no
other field does.

Revisit if:

- Deadline / objective planning needs to discount synthetic SoC readings
  relative to native (different trust levels in scheduling decisions).
- Diagnostics surfaces want to render "value from flow" badges to the user.
- A future SoC contract carries multi-source consensus (e.g. native vs
  flow disagreement) and the planner has to act on the divergence.

When that happens, the right move is to introduce a typed source field
again (or a richer per-source snapshot) — not to retrofit a `source` flag
into the existing single-value contract.
