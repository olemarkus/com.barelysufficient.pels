# Native wiring — flow-conflict detection

Engineering note for the initiative that lets PELS default native device
control ON while refusing that default where a user's own Homey Flow already
writes the same capability PELS would take over.

## Background

"Native wiring" = PELS controlling a device directly through Homey
capabilities instead of round-tripping through user-authored Flow cards.

- **Zaptec EV** (shipped, PR #1195): native EV control is now unconditional.
  PELS writes `charging_button` for start/stop and exposes synthetic
  `evcharger_charging` / `evcharger_charging_state`. The toggle was retired.
  Stepped charge current still rides a *separate* capability
  (`installation_current_control`) driven by the user's bridge Flow, so
  Zaptec has no native-vs-flow write conflict.
- **Hoiax water heaters / generic `target_power` steppers**: native stepped
  control writes the step capability *directly*
  (`max_power_3000` / `max_power_2000` / `max_power`, plus `onoff` for the off
  step; or `target_power` for the generic case). This is still gated by an
  opt-in toggle (the misnamed `NATIVE_EV_WIRING_DEVICES` setting). These are
  the devices that motivate this initiative: we want native stepped control
  ON by default, but a user who already built a Flow writing `max_power_*`
  would then have two writers racing the same capability.

## The conflict rule

> A device has a flow conflict when some user Flow **action** writes a
> capability that PELS would **own** under native wiring for that device.

Observation flows (reading the device, or PELS *report* cards that push state
*into* PELS) are never conflicts — only writes to PELS' own control
capability fight PELS.

Per-device-class native-write capability sets (the right-hand side of the
intersection, consumed by the conflict classifier in a later PR):

| Device class | PELS native-write capabilities |
|---|---|
| Zaptec EV | `charging_button` |
| Hoiax stepped | `max_power_3000`, `max_power_2000`, `max_power`, `onoff` (off step) |
| Generic `target_power` stepped | `target_power` |

A bridge Flow (PELS `desired_stepped_load_changed` trigger → vendor action)
is **not** detected via the PELS card. It surfaces through the vendor
capability its action writes — which is captured as an ordinary
device-capability write. For Zaptec that write is `installation_current_control`
(not in the native-write set → no conflict, correctly). For a Hoiax bridge it
would be `max_power_*` (in the set → conflict, correctly).

## Web API shapes

Read via the owner token (`homey.api.getOwnerApiToken()` +
`getLocalUrl()`), the same auth the device transport already uses. Two
endpoints, two shapes:

### `GET /api/manager/flow/flow/` — standard flows

```jsonc
{
  "<flowId>": {
    "trigger":    { "uri": "...", "id": "...", "args": {} },
    "conditions": [ { "uri": "...", "id": "...", "args": {} } ],
    "actions":    [ { "uri": "...", "id": "...", "args": {} } ]
  }
}
```

### `GET /api/manager/flow/advancedflow/` — advanced (card-graph) flows

```jsonc
{
  "<flowId>": {
    "name": "Zaptec stepped load",
    "cards": {
      "<cardId>": {
        "ownerUri": "homey:device:<deviceId>",
        "id":       "homey:device:<deviceId>:<capabilityId>",
        "args":     { ... },
        "type":     "trigger" | "condition" | "action"
      }
    }
  }
}
```

Advanced flows were the easy thing to miss: the early spike only hit
`/flow/flow/` and saw `{}` on a Homey whose Flows were all advanced. **Both
endpoints must be read.**

### Card id → device-capability write

In both shapes a direct device-capability card carries:

```
id === "homey:device:<deviceId>:<capabilityId>"
```

`deviceId` is a UUID (no colons); `capabilityId` may contain dots
(`alarm_generic.car_connected`) but never colons. Parse: strip the
`homey:device:` prefix, split the remainder on the first `:`.

PELS-app cards (`homey:app:com.barelysufficient.pels:*`) and manager cards
(`homey:manager:*`) do not match the prefix and are ignored.

`args.device` differs between shapes (bare string id in flat flows, `{ id,
name }` object in advanced flows) — irrelevant here because we key off the
card `id`, not `args`.

## Fail-closed contract

The reader returns a typed three-state, never a bare boolean:

```ts
type FlowReadResult =
  | { status: 'ok';      writes: Map<deviceId, Set<capabilityId>> }
  | { status: 'unknown'; reason: string };
```

- `ok` with an empty map = read succeeded, genuinely no writes.
- `unknown` = a read threw, returned a non-object, or otherwise can't be
  trusted. If **either** endpoint is unreadable the whole result is
  `unknown` — we cannot prove the absence of a conflicting Flow in an
  endpoint we never saw.

This distinction is load-bearing: a later auto-enable step must treat
`unknown` as "do not auto-flip", so a transient Web API failure can never
silently enable native wiring over a real conflict. Mirrors the
"never delete persisted state on one bad SDK read" rule used elsewhere.

The HTTP capability is **injected** (`get`) so `lib/flowApi/` stays pure and
free of any cross-peer dependency on the device transport. Wiring supplies a
`get` backed by the transport's REST client (`getRawFromHomeyApi`).

## PR decomposition

1. **PR1 (shipped):** `lib/flowApi/` defensive reader + pure normalizer →
   `Map<deviceId, Set<capabilityId>>`, fail-closed three-state, plus a
   fire-and-forget startup telemetry probe (`setup/flowConflictProbe.ts`)
   that structured-logs read outcome + write counts. No behaviour change.
2. **PR2 (shipped):** pure conflict classifier (`lib/flowApi/flowConflict.ts`)
   — intersects the write map with each device's owned native-write
   capabilities and returns the conflicting capability ids. Deliberately
   **class-agnostic**: the caller passes already-resolved owned capabilities,
   so `lib/flowApi` keeps no per-class capability constants and no cross-peer
   dependency on `lib/device`. Resolving each device's owned native-write set
   (`charging_button`; `max_power_3000`/`max_power_2000`/`max_power`/`onoff`;
   `target_power`) is PR3's job, at the entry layer where importing
   `lib/device` is allowed. No wiring/behaviour change yet.
3. **PR3:** default native stepped wiring ON for Hoiax / `target_power`
   unless a flow conflict is found; resolve each device's owned native-write
   capabilities and feed them + the PR1 read into the PR2 classifier; persist
   a per-device `autoDecisionMade` marker so a user's explicit toggle is never
   auto-reverted on a later upgrade; re-query cadence (startup + settings
   open). Treat a `status: 'unknown'` read as "do not auto-flip".
4. **PR4:** device-detail conflict banner naming the conflicting Flow /
   capability (uses the classifier's returned capability ids); copy in
   `packages/shared-domain/`.

## Validation reference

Real fixtures for tests come from the SHS test Homey advanced flows
`Zaptec stepped load` and `Easee stepped load` (see
`test/flowApiUserFlows.test.ts`). The in-app token was confirmed able to read
both endpoints during the PR1 spike.
