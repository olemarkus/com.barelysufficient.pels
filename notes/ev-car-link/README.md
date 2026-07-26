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

- exactly one car matches a charger edge → a coincidence, worth one vote;
- two or more cars match → `ev_car_link_ambiguous`, **no vote** for anyone;
- a car edge matches no charger edge → `ev_car_session_elsewhere`. It carries **no vote in
  either direction** — an away session is silent evidence, not counter-evidence, so it
  must never decrement the affinity prior.

**The affinity prior only breaks ties.** A live coincidence always wins. The persisted map
is consulted only when exactly one candidate has cleared the vote threshold *and* every
other candidate has zero — a prior that merely leads is not enough, so a second household
car can never inherit the first car's history.

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
  known car ids (so a feed outage is not a total blackout), but it runs at :25 and :55 —
  far coarser than the 90 s window. On that path both sides' edges get stamped in the same
  refresh tick, so "coincidence" degrades to "same refresh", which is much weaker evidence.
  Treat links formed during a feed outage with suspicion.
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

The producer's in-memory observation map is deliberately **not** capped: it holds one small
entry per class `car` device present in the home, which is a fixed, user-controlled number
rather than something that grows over time. Capping it would silently make a legitimate car
invisible, which is worse than the handful of bytes it costs.

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
