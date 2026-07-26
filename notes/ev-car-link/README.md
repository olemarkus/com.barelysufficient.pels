# EV car ↔ charger link — detection probe

**Status: log-only probe.** Nothing in this subsystem reaches planning, admission, or
actuation. It exists to answer one question before any behaviour depends on the answer:
*can PELS work out which car is on which charger, and notice when the car stops charging
for its own reasons?*

## Why

PELS models the **charger**, never the **car**. A car has its own charge limit, its own
departure schedule, and its own smart-charging logic. When it stops for one of those
reasons the charger frequently still reports a live session, so PELS keeps booking hours
and keeps resuming. A smart task whose target sits above the car's own limit pins
`remainingUnits` forever and lands `missed` with nothing the user can act on
(`lib/objectives/deferredObjectives/diagnosticProgress.ts`).

The only existing path from car to PELS is the `report_evcharger_battery_level` flow card,
which the user must wire by hand and which hard-rejects any non-`evcharger` device. Class
`car` devices are dropped outright at `SUPPORTED_DEVICE_CLASSES`
(`lib/device/transport/managerHelpers.ts`).

## Capability contract

**Official Homey capabilities only.** No vendor-, app-, or driver-specific capability id
appears anywhere in this feature, and there is no `driverId` branching.

| Side | Reads |
|---|---|
| Car (`class: 'car'`) | `ev_charging_state`, `measure_battery` |
| Charger | PELS's already-resolved `evChargingState` + measured power, off the parsed snapshot |

Two consequences follow, and both are deliberate:

- **The car's charge limit is not readable.** No Homey capability carries an EV target
  SoC. It is inferred from where `measure_battery` repeatedly stops (`stopSocPct`), which
  is the only sanctioned route. Vendor capabilities that do expose it (e.g. the Polestar
  app's `target_polestarChargeLimit`) are off-limits.
- **A car app that does not publish those two capabilities is invisible here.** No
  per-vendor fallback is added.

The charger side reads PELS's *resolved* `evChargingState` rather than a raw capability.
Some chargers only have their plug state derived at the device boundary (the Zaptec
overlay in `lib/device/nativeEvWiring.ts` synthesises it), so consuming the resolved value
is both layering-correct and what keeps vendor knowledge in the one adapter that owns it.

## Map

| File | Role |
|---|---|
| `lib/device/evCarLink.ts` | Pure correlation: edges, matching, link resolution, self-stop classification |
| `lib/device/evCarLinkObservation.ts` | Device-payload boundary: resolves a car reading, drops unknowns |
| `lib/device/evCarLinkSnapshot.ts` | Persisted shape: normalise, vote, sample, prune, summarise |
| `lib/device/evCarLinkProducer.ts` | The producer: ingests cars, diffs chargers, emits events |
| `lib/device/evCarLinkWiring.ts` | Charger-view narrowing + producer construction |
| `lib/device/evCarLinkStore.ts` | Debounce / load-grace persistence |
| `lib/device/observationProducers.ts` | Builds this alongside the battery and solar producers |
| `setup/evCarLinkStoreWiring.ts` | Store lifecycle (lazy load, flush) |

## Correlation rules

**Link on plug edges only.** PELS itself commands chargers on and off, so a charger's
*charging*-state transitions are frequently PELS-caused and correlate with nothing about
the car. Connect/disconnect is a physical event both devices observe independently, which
makes it the only self-correlation-free signal available. Charging transitions are
deliberately not used as link evidence.

**Decide only once the window has closed.** A charger edge is matched only after a full
coincidence window (90 s) has elapsed. Deciding eagerly would vote for the first car to
plug in and could not retract that vote when a second car connects moments later at the
same charger. The cost is that a link resolves ~90 s after plug-in; nothing downstream is
time-critical.

**Three outcomes, and the distinction is the point:**

- exactly one car matches a charger edge, *and* that car matches no other charger edge → a
  coincidence, worth one vote;
- two or more cars match a charger, **or** the one matching car would equally fit another
  charger → `ev_car_link_ambiguous`, **no vote** for anyone. A car is on exactly one
  charger, so an edge that fits two identifies neither;
- a car edge matches no charger edge → `ev_car_session_elsewhere`. It carries **no vote in
  either direction** — an away session is silent evidence, not counter-evidence, so it
  must never decrement the affinity prior.

**An away verdict waits two windows, not one.** A charger edge that could still explain a
car edge at time T lies within [T−W, T+W], and the latest of those does not itself settle
until (T+W)+W. Reporting at one window would call an away session on a pair that links
moments later, purely from ordinary event-ordering jitter.

**The affinity prior only breaks ties.** A live coincidence always wins. The persisted map
is consulted only when a charger's connect edge matched no car edge **at all** — never for an
*ambiguous* edge, whose live candidates the matcher deliberately refused to choose between;
letting history pick one there would emit a confident link contradicting the ambiguity — its update was
missed, or its first observation after a restart was already connected — and then only when
exactly one candidate has cleared the vote threshold *and* every other candidate has zero.
A prior that merely leads is not enough, so a second household car can never inherit the
first car's history.

**An older observation never rolls a car's state backward, and an unreadable one never
overwrites.** A device fetch can start before a realtime update and land after it, so a
fetched payload may be staler than what is already held. Applying it would manufacture a
disconnect edge and then a reconnect edge from the next fresh update — two phantom plug
events and a corrupted vote (`lib/device/AGENTS.md`). Two rules follow:

- Plug state and charge are timestamped **independently**, from their own capability
  `lastUpdated`. Gating both on the plug timestamp would let an older fetched charge value
  through for the whole of a session, since the plug state does not change while charging.
- An absent or malformed capability is an **absent observation**, not a new value: the read is
  skipped and the previous value kept. Storing `undefined` would erase the last trusted plug
  state, and the next genuine transition would then be compared against it and yield no edge —
  the session could neither link nor clear.
- **No unknown crosses the boundary at all.** A car with no readable plug state is not tracked;
  resolved observations carry a required `EvChargingState`, and absent charge/power are omitted
  rather than nulled. The correlation domain takes only resolved values, so there is no
  "unknown" arm anywhere downstream to get wrong — and no fabricated `0 W`, which would read as
  idle and manufacture a self-stop.

Where a device supplies no capability timestamp, arrival time stands in and cannot separate
those cases. That is the honest limit of the data, not a guarantee.

**A full refresh is authoritative on membership.** A car removed from Homey is dropped, so the
affinity fallback cannot resolve a live session to a device that no longer exists and its id
stops being re-requested. Narrowing is gated on a non-empty list, and a targeted read (which
re-reads only known ids) never narrows.

**A car is linked to at most one charger.** A missed disconnect would otherwise leave the
old charger's link in place while the car links to a new one — charge readings credited
twice and self-stop reported against a charger the car has left. Committing a link clears
any other link held for the same car.

**A session is never created for a currently-unplugged charger.** Edges are matched only
after they settle, so a short session's connect edge can be processed *after* its
disconnect already cleared the session. Without that guard the link would be resurrected
for an unplugged car and later charge readings attributed to it.

**Self-stop** requires all of: the car reports connected-but-not-charging, the charger
still believes it is delivering, measured draw is at or below the idle threshold, and the
condition has held continuously for the dwell window (2 min). An unreadable power
measurement is not evidence of idleness.

## Known limits (read these before trusting a log)

- **`plugged_in` is lossy.** The Polestar app maps both `CHARGING_STATUS_DONE` and
  `CHARGING_STATUS_IDLE` to `plugged_in`, and `SCHEDULED` / `SMART_CHARGING*` to
  `plugged_in_paused`. So `car_not_charging` genuinely cannot distinguish "finished at the
  car's limit" from "idle" from "charging fault". That is why the sub-reason is named
  vaguely and why `stopSocPct` carries the real signal.
- **Resolution depends on the live feed.** Car updates arrive at realtime cadence only via
  the `homey:manager:devices` subscription. The targeted snapshot refresh also re-reads
  known car ids, so a feed outage is not a blackout — the SDK-boundary e2e drives that path
  exclusively — but it runs at :25 and :55. On that path both sides' edges get stamped in
  the same refresh tick, so "coincidence" degrades to "same refresh", which is much weaker
  evidence. Treat links formed during a feed outage with suspicion.

  This is also why the probe observes **after** the snapshot commit rather than alongside
  the battery/solar producers: it resolves charger state from the committed snapshot, and
  observing pre-parse would pair a car transition read in one refresh against charger state
  from the previous one — putting the two halves of a genuine session in different
  refreshes and, at that cadence, outside the window entirely.
- **The first session after a restart contributes no connect edge.** A first observation is
  not a plug event; treating it as one would hand out a vote on every boot. Its disconnect
  edge still counts.
- **One stop proves nothing.** `summarizeEvCarObservedLimit` returns `null` below two
  samples and always reports spread alongside the median. A tight cluster over many
  sessions is a charge limit; a wide spread is just a user unplugging at varying levels.

## Bounds

Homey's RSS ceiling is 160 MB with roughly 30 MB of headroom, so every structure that could
grow with time or traffic is capped: ≤20 edges per side, ≤20 stop samples per car, ≤200
dedupe keys, and pairs pruned at 90 days. The persisted stop-sample table additionally caps
at 8 cars (`EV_CAR_LINK_MAX_TRACKED_CARS`).

Pruning runs **on load**, not on a timer: pair records only accumulate through device churn
across restarts, so boot is exactly when stale ones appear and the cheapest moment to drop
them.

The producer's in-memory observation map is deliberately **not** capped: it holds one small
entry per class `car` device present in the home, which is a fixed, user-controlled number
rather than something that grows over time. Capping it would silently make a legitimate car
invisible, which is worse than the handful of bytes it costs.

## Validating on SHS

Unit and integration tiers model the producer's inputs; they cannot tell you whether those
inputs ever arrive. They did not: the probe was originally wired only to `device.update`,
which carries device-level changes, while capability VALUE changes arrive on the
per-capability seam — so on hardware the probe saw nothing between fetches and could never
link. Two things were needed: the probe's cars must be in the live feed's per-device
subscription set (they are never in the managed snapshot, so nothing else adds them), and
the probe must be called from the capability path.

`tmp/shs-recipes/ev-car-link.sh` (local-only, gitignored) drives the mock `tesla_car` and
mock chargers on SHS through the transitions that matter:
`baseline | link | two-cars | two-chargers | move | selfstop`. Both chargers must be
**managed** in PELS or the probe has no charger views to correlate against.

Verified there (2026-07-27), reading `ev_car_*` out of the app log:

| Scenario | Result |
|---|---|
| clean 1:1 | `ev_car_link_resolved` with `source: 'coincidence'`, edges 3.5 s apart |
| one car, two chargers | both chargers `ev_car_link_ambiguous`, **no vote**, and the affinity prior did not overturn it |
| two cars, one charger | `ev_car_link_ambiguous` carrying both car ids, **no vote** |

## Known evidence limits

The probe is log-only, so every gap below costs EVIDENCE QUALITY, never correct PELS
behaviour — nothing reads these events. Read the logs with these in mind:

- **A car can be invisible rather than mis-read.** A car whose plug state is unreadable on the
  first fetch, one whose by-id reads flake three times, and one whose app is installed after
  startup are all untracked until a full refresh or restart. "No events for that car" therefore
  does not mean "detection failed" — check the car was tracked at all. Tracked in `TODO.md`.
- **Coincidence quality depends on the live feed.** With it, edges are timestamped when they
  happened. Without it, both sides land in the same :25/:55 refresh tick and "coincidence"
  degrades to "same refresh" — much weaker. Links formed during a feed outage deserve suspicion.
- **`plugged_in` is lossy on the car side**, so `car_not_charging` cannot distinguish "finished at
  the car's limit" from "idle" from "charging fault". The `stopSocPct` cluster is the real signal.
- **Absent is never zero.** Unknown power, charge, and plug state are omitted rather than
  defaulted, so a missing field means "not observed", not "observed as nothing".

## Reviewing a production log

Read `/tmp/pels` with the `pels-log-review` skill and check, in order:

1. `ev_car_link_resolved` — did it pick the right pair, and after how many sessions?
   `source: 'coincidence'` is strong; `affinity_prior` means it fell back to history.
2. `ev_car_link_ambiguous` — should be absent in a one-car home. Its presence means two
   devices are edging together and the probe is right to refuse.
3. `ev_car_session_elsewhere` — should appear when charging away from home, and should
   *not* appear for home sessions.
4. `ev_car_self_stopped` — does `stoppedAtSocPct` cluster? Compare `observedLimitPct` and
   `observedLimitSpreadPct` against the limit actually set in the car.
5. `ev_car_link_soc_shadow` — `deltaPct` against whatever the flow card reports is the
   accuracy measure for any future adoption.

## Out of scope for this slice

- Adopting the car's charge into the snapshot, or any planning/actuation effect.
- Suspending smart-task accounting on self-stop. The producer lives in `lib/device`, a peer
  that may not reach `lib/objectives`, so tying `ev_car_self_stopped` to a running smart
  task is a log-review exercise for now. Tracked in `TODO.md`.
- Any settings UI.
