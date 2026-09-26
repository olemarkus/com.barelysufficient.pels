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
- **Easee EV charger current** (`no.easee`, charger driver): native stepped
  control writes the EV preset step's whole-amp current to the setable
  `target_charger_current` (0 A for the off step) and reads the step back from
  the same capability, replacing both halves of the bridge Flow. Checked
  against the deployed Easee 2.0.5 build (installed on the SHS; the GitHub
  repo is the archived community 1.9.6): the capability listener and the
  app's "Set dynamic charger current" card (`setDynamicChargerCurrent`) both
  call the same `setDynamicChargerCurrent` → `POST /chargers/<id>/settings
  { dynamicChargerCurrent }`, and the app publishes the cloud's value back on
  `target_charger_current`. Needs the owner's EV 1-phase / 3-phase preset
  (amps only become watts through it). Same opt-in gate and flow-conflict
  auto-enable as Hoiax. The session-start reset to the charger maximum
  arrives as an observed step and is corrected by the ordinary stepped
  mismatch path, as it was with the Flow.

  **The charging switch is translated at the SDK seam, and nowhere else.**
  Everything above `lib/device` treats `evcharger_charging` as this charger's
  switch, like any EV charger's. The Easee app turns `false` into
  `stop_charging`, which ends the session: an RFID-authorised charger then
  needs its card again (community thread 147496, post 159), and every
  restart opens a new session at the 32 A maximum. So
  `resolveEaseeSwitchWrite` (`lib/device/easeeChargingSwitch.ts`, called
  from `transport/deviceWrites.ts`) writes `false` as 0 A, which Easee
  answers with `Paused` (`plugged_in_paused`), the session still open.
  `true` on a charger whose session is open (`plugged_in_paused` or
  `plugged_in_charging`) writes 6 A, the smallest current it charges at;
  `true` on a stopped session (stopped in the Easee app or by the car)
  still goes to the switch and starts a new one: the plan decided the
  charger should run, and no current can restart a session that is gone.
  A paused session gets current, never a start, even while the charger
  holds off: Easee waits about 5 minutes after a current is raised before
  it offers the car current again (production, 2026-09-25: 08:11:26 to
  08:16:27 and 08:50:58 to 08:55:55), longer than PELS waits for the switch
  to confirm, and a start in that window reset the charger to 32 A. The write changes
  only what reaches the SDK: the local-write record and the settle evidence
  stay on `evcharger_charging`, which is also what keeps PELS's own pause
  from reading as an outside turn-off. The current actually written is
  recorded as a local write as well, so its Homey echo is handled like any
  built-in step write's, not taken as an observation of the charger.

  The switch is read back (`withEaseeObservedCharging` on a read,
  `resolveEaseeRealtimeUpdates` on realtime events, both in
  `lib/device/easeeChargingSwitch.ts`) from the plug state and the current,
  never from the app's own `evcharger_charging`: on while the charger is
  `plugged_in_charging`, and while it is `plugged_in_paused` holding 6 A or
  more; off otherwise. The app 2.0.5 derives its switch from the same charger
  mode as the plug state (on only in `Charging`) and publishes the two
  together, switch first, so the switch adds nothing the plug state does not,
  except a value PELS wrote itself: Homey keeps a written switch until the app
  next publishes, which it does only when the charger mode changes. The
  current tells a paused charger PELS switched on from one it switched off.
  After a resume Easee holds the charger in `Awaiting Start`, which the app
  publishes as `plugged_in_paused`, for about 5 minutes before it offers the
  car current, so a charger paused at 6 A is on and waiting, and one paused
  at 0-5 A is off. A realtime current or plug-state report carries the switch
  it implies (the realtime path reads the held current as the reported step,
  which puts 0-5 A on the off step); the app's switch events are dropped, and
  a malformed plug state or current implies nothing. PELS's own write to the
  switch is no observation of it either (`readBackAsWritten` in
  `transport/deviceWrites.ts`): a recorded local write would otherwise win
  over any later read Homey dated before it (`observationMerge`,
  `retained_fresher`), and the app never re-dates a switch it did not
  republish, so a start that never charged would read on for good.

  This is what lets a resume confirm. Reading "never on while paused" (the
  first shipped rule) left every resume unconfirmed for the whole hold: the
  90 s confirmation window expired, the reachability back-off armed, and the
  plan held the charger inactive ("did not respond") with its power
  unreserved, until the charger started unplanned about 5 minutes later
  (production, 2026-09-25, on every resume). Now the current's echo confirms
  within seconds and the plan keeps the charger's power booked through the
  hold. A charger PELS restarts inside a hold reads on too, so a plan that
  wants it off pauses it rather than skipping a charger it read as off.

  A pause confirms later than it writes: a charger still `plugged_in_charging`
  reads on whatever its current, so after PELS's 0 A the switch reads off once
  Easee reports the pause (17-37 s in production), when the charger has
  stopped drawing, not when the current lands. A current of 0-5 A set in the
  Easee app pauses the charger the same way, and the app reports it within
  seconds (4 s in production), so it reads as the switch going off outside
  PELS, which PELS decides about again like any outside turn-off. A charger
  Easee pauses for its own reasons while holding 6 A or more (its load
  balancer, a remote authorisation) reads on and draws nothing, like a car
  that is not taking current.

  **Open:** whether raising the current inside the hold restarts it. While the
  charger reads on, the planner ramps it at its ordinary cadence (6 A to 16 A
  over about 5 minutes when there is room) before it draws anything. The
  production hold was only ever measured from a 0 A to 6 A resume. A second
  6 A write inside it did not restart it (2026-09-25: 12:14:14 resume, 6 A
  again at 12:15:44, charging at 12:19:50; 15:13:06, 15:14:36, 15:18:34), but
  a raise to a higher current is untested. If one restarts it, the ramp
  pushes the start out to about 5 minutes after the last raise. The SDK e2e
  models the hold as timed from the resume.

  A switch-on that is not followed by PELS's own step commands leaves the
  charger at the lowest charging step, where a start used to reset it to its
  maximum. That is the case when PELS lets go of a paused charger, for
  instance when Power-limit control is turned off for it.

  With built-in control off the switch is the app's, read and written as any
  EV charger's, with one exception: a switch-on for a session paused below 6 A
  writes 6 A, because no start command resumes it. That is PELS's own 0 A
  pause when the owner turned built-in control off before PELS resumed it;
  without the exception nothing would raise the current again. The raw
  current comes from the tracked Homey device, since the snapshot has no
  native step for a charger PELS does not step itself.

  Unlike a stopped session, a paused one resumes on any current of 6 A or
  more, so a charging step written while the plan holds the charger off would
  restart charging. The plan does not avoid that by planning the off step: a
  plan holding the charger off still carries its lowest charging step (6 A in
  production). What holds it is the executor. A binary-driven off that has
  settled skips every step command (`isSettledAtPlannedOff`,
  `lib/executor/steppedLoadExecutor.ts`), the step goes out before the
  shed-off in a pass that sheds, and the desired step of a shed device never
  rises above the step the charger reports (`resolveDesiredStepId`,
  `lib/executor/executableSteppedLoadProjection.ts`), which for a paused
  charger is the off step. The SDK e2e
  (`test/e2e/easeeNativeChargerCurrentSdkE2E.test.ts`) holds the mode change
  back past two meter readings and asserts no current is put back on offer.

  **Phase auto-selection excludes IT three-phase.** `resolveChargerPhaseReport`
  never assigns the TN three-phase preset to a reported `IT_3_PHASE` grid, including
  a locked-three-phase report. Locked single-phase remains supported. The existing
  presets assume 230 W/A or 690 W/A; IT three-phase needs about 398 W/A. Calibration
  cannot repair the higher rungs because their actual draw falls below the previous
  rung's nominal calibration band. An unconfigured charger keeps its existing
  binary control path; authored configurations are not migrated or erased. Proper
  IT three-phase stepping requires a topology-aware profile and consistent readback
  conversion before auto-selection can support it.

## The conflict rule

> A device has a flow conflict when some user Flow **action** writes a
> capability that PELS would **own** under native wiring for that device.

Observation flows (reading the device, or PELS *report* cards that push state
*into* PELS) are never conflicts — only writes to PELS' own control
capability fight PELS.

The same Flow inventory also exposes one separate UI fact: enabled
**Report battery level for charger** actions, normalized by target charger.
That action is not a native-control conflict. It becomes redundant only when
the owner selects a car for the same charger, because selected-car mode ignores
Flow and charger-native battery reports.

Per-device-class native-write capability sets (the right-hand side of the
intersection, consumed by the conflict classifier in a later PR):

| Device class | PELS native-write capabilities |
|---|---|
| Zaptec EV | `charging_button` |
| Hoiax stepped | `max_power_3000`, `max_power_2000`, `max_power`, `onoff` (off step) |
| Generic `target_power` stepped | `target_power` |
| Easee EV charger | `target_charger_current`, plus the `setDynamicChargerCurrent` card id |

The Easee card id is not a capability, but a user Flow's device action card is
recorded under the same `homey:device:<deviceId>:<suffix>` key as a capability
write, so listing the card that performs the same write makes the classifier
catch the bridge Flow owners actually build (prod "Elbillader" uses the card,
not the capability).

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

The `cards` map also holds `start`, `delay`, `any`, `all`, and `note` blocks.
They have no device-write card id and must not invalidate the inventory.
Production verification on 2026-09-16 found `start`, `delay`, `any`, and `note`
in unrelated Flows; rejecting them hid the valid `Elbillader` Easee conflict.
The boundary accepts these known non-action types, while malformed actions,
missing types, and unrecognized types still fail closed. Only action cards
contribute device writes.

### Card id → device-capability write

In both shapes a direct device-capability card carries:

```
id === "homey:device:<deviceId>:<capabilityId>"
```

`deviceId` is a UUID (no colons); `capabilityId` may contain dots
(`alarm_generic.car_connected`) but never colons. Parse: strip the
`homey:device:` prefix, split the remainder on the first `:`.

PELS-app cards (`homey:app:com.barelysufficient.pels:*`) and manager cards
(`homey:manager:*`) do not match the prefix and are not device-capability
writes. The battery-report card is additionally recognized as the separate
charger-reporting fact described above.

`args.device` differs between shapes (bare string id in flat flows, `{ id,
name }` object in advanced flows, with a legacy `{ data: { id } }` form also
accepted). Native-control writes key off the card `id`; the battery-report fact
uses this normalized target argument.

## Fail-closed contract

The reader returns a typed two-arm result, never a bare boolean:

```ts
type FlowReadResult =
  | { status: 'ok';      facts: {
                            writes: FlowCapabilityWrites;
                            evSocReporters: EvSocFlowReporter[]
                          } }
  | { status: 'unknown'; reason: string };
```

- `ok` with an empty map = read succeeded, genuinely no writes.
- `unknown` = a read threw, returned a non-object, contained an active Flow
  whose action/card topology could not be trusted, or otherwise can't be
  trusted. If **either** endpoint is unreadable the whole result is
  `unknown` — we cannot prove the absence of a conflicting Flow in an
  endpoint we never saw.

This distinction is load-bearing: a later auto-enable step must treat
`unknown` as "do not auto-flip", so a transient Web API failure can never
silently enable native wiring over a real conflict. Mirrors the
"never delete persisted state on one bad SDK read" rule used elsewhere.

The topology check lives at the Homey API boundary. `unknown` never becomes a
business-logic input: the conflict probe emits no auto-enable decision, so the
previous control choice carries forward unchanged.

The HTTP capability is **injected** (`get`) so `lib/flowApi/` stays pure and
free of any cross-peer dependency on the device transport. Wiring supplies a
`get` backed by the transport's REST client (`getRawFromHomeyApi`).

## PR decomposition

1. **PR1 (shipped):** `lib/flowApi/` defensive reader + pure normalizer →
   `Map<deviceId, Set<capabilityId>>`, fail-closed two-arm result, plus a
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
3. **PR3 (shipped):** resolve each native stepped-load device's owned
   native-write capabilities (`resolveNativeSteppedLoadWriteCapabilities` in
   `lib/device/nativeSteppedLoadWiring.ts`) and run the PR2 classifier against
   the PR1 read inside the startup probe, structured-logging the per-device
   conflict verdict (`candidateCount` / `conflictCount` / `conflicts`).
   **Telemetry only — no default flip.** Validates the full detection pipeline
   on real Homeys before any behaviour changes. The candidate enumeration +
   owned-cap resolution it adds is reused by PR4.
4. **PR4 (shipped):** native stepped wiring defaults ON for supported Hoiax
   (`max_power_*`) and Easee (`target_charger_current`) devices unless a Flow
   conflict is found.
   - **Runtime default, not a settings write.** `getNativeEvWiringEnabled`
     resolves: an explicit user entry in `NATIVE_EV_WIRING_DEVICES` (true or
     false) always wins; an untouched device falls back to an in-memory,
     conflict-gated auto-decision (`app.autoNativeWiringDecisions`). Nothing is
     persisted, so there is no migration and no risk of corrupting user state,
     and an explicit opt-out is never auto-reverted.
   - **Gating:** `detectNativeWiringConflicts` (`setup/flowConflictProbe.ts`)
     auto-enables supported candidates with no conflicting Flow; an `unknown` read
     yields no decisions (fail-closed). It runs once after the snapshot
     warm-up gate, then re-parses the snapshot + rebuilds the plan so the
     decision takes effect.
   - **Scope:** `target_power` steppers are already default-ON (via the
     `targetPowerSteppedCandidate` branch in `managerNativeEv.ts`) and are left
     untouched. Detection runs each startup, so a restart picks up
     newly-added conflicting Flows.
   - **Accepted limitation:** detection runs once after the warm-up gate, with
     a bounded retry while the snapshot is still empty. If the startup snapshot
     refresh fails outright (gate releases via timeout) and stays broken past
     the retries, a conflict-free Hoiax is not auto-enabled until the next
     periodic snapshot refresh or a restart. The window is time-bounded and
     capacity control is otherwise unaffected, so this is accepted rather than
     given a dedicated recovery path; the re-query follow-up below closes it.
5. **PR5 (shipped):** device-detail conflict banner. The per-device verdict is
   surfaced on the snapshot as `flowConflict.conflictingCapabilities` (app
   stores `flowConflictsByDevice`, exposed via the `getFlowConflict` parse
   provider, attached in `resolveParsedDeviceSettings`); the settings-UI
   `syncFlowConflictNotice` shows a non-interactive banner when it is set.
   Browser-only copy lives beside its consumer in
   `packages/settings-ui/src/ui/deviceDetail/nativeWiringCopy.ts`. It names a
   single conflicting Flow when the producer can resolve one, but never exposes
   raw capability ids (`max_power_3000` would be jargon). The banner ties itself
   to the visible built-in-control switch and describes the safe handoff: keep
   the Flow, turn off only its conflicting device-control action, then enable
   built-in control. `flowConflict` is display-only and does not affect the
   control gate.

   The two notices answer separate questions. **Setup & recommendations**
   recommends available built-in control while it is off, even without Flow
   metadata; in that case its advice is conditional and never claims a Flow
   was detected. A detected conflict adds the safe migration instructions and
   Flow name. The device-detail Flow notice remains visible after built-in
   control is enabled, with different copy explaining that the two writers may
   override each other. Missing required activation retains its own setup
   notice; a supported legacy Flow setup is not labelled unusable.

   There is one built-in-control switch, which saves the owner's choice
   directly. There is no "only device controller" confirmation: PELS cannot
   guarantee exclusive control or disable another app or Flow. Detected Flow
   conflicts are explained by the separate notice.

   *Follow-ups:*
   - **Shipped:** a user-triggered **Check again** action on the
     device-detail warning and setup recommendation. It runs the same
     fail-closed conflict detection immediately, then refreshes the existing
     device read model so a fixed Flow no longer leaves the warning visible
     until the 30-minute background re-query.
   - ~~Re-run conflict detection after snapshot refreshes so a Flow added after
     startup is reflected without a restart and a degraded empty-snapshot startup
     recovers automatically.~~ **Shipped** (`0dd6dafe`): periodic conflict
     re-query every 30 min, closing the accepted limitation noted in PR4.
   - ~~Plumb the conflicting Flow's name through the conflict reader so the
     banner can name which Flow to edit.~~ **Shipped** (`d9513dd7`):
     `resolveConflictFlowName` in `lib/flowApi/flowConflict.ts` sets `flowName`
     when a single named Flow is responsible, and the banner copy
     (`packages/settings-ui/src/ui/deviceDetail/nativeWiringCopy.ts`) names it.

## Validation reference

Real fixtures for tests come from the SHS test Homey advanced flows
`Zaptec stepped load` and `Easee stepped load` (see
`test/unit/flowApiUserFlows.test.ts`). The in-app token was confirmed able to read
both endpoints during the PR1 spike.
