# go-e compatibility

`lib/device/goe/` owns the go-e Charger app (`com.go-e.charger`, local HTTP
API, drivers `go-eCharger_V1` to `go-eCharger_V4`, `go-eCharger_CORE` and
`go-eCharger_PRO`). Checked against the live 2.11.1 package.

**Start and stop.** The app declares neither `evcharger_charging` nor
`evcharger_charging_state`. Its `is_allowed` is setable. On V3, V4, CORE and
PRO a write sets the charger's force state: false forces charging off (`frc`
1), true returns it to the charger's own logic (`frc` 0, with an anonymous
transaction when the charger waits for authentication). On V1 and V2 it sets
`alw`. The app's 5 s poll publishes the charger's own `alw` on `is_allowed`, so
the reading is the charger's answer, not an echo. The adapter reads and writes
the switch on `is_allowed` and publishes it as `evcharger_charging`. The
charger keeps its current across a stop, so the planned current goes out
before the switch (`current_before_start`).

**Plug state.** The poll maps the charger's `car` state to `status`:

- `station_idle`: `plugged_out`.
- `car_charging`: `plugged_in_charging`.
- `station_waiting` or `car_finished` with `is_allowed` false:
  `plugged_in_paused`.
- `station_waiting` or `car_finished` with `is_allowed` true: `plugged_in`,
  a car that takes nothing.
- `station_error`, `unknown` or a missing switch: unread.

The derived state is dated by `status`.

**Charging current.** `current_limit` is the charger's `amp`, declared
read-only. The app's `change_current` card writes `amp` (6-32 A, clamped by
the app to the cable's coding and the charger's maximum) and the next poll
publishes it back. The adapter offers the card as built-in current control
through the owner's Homey API key, scoped to this charger, and reads an
integer 6-32 A `current_limit` as the charger's current, dated by the
capability.

**Phases.** `num_phases` reads 1 only while the charger is forced onto one
phase; otherwise it holds the app's default of 3. Only the one-phase reading
is reported, because a Norwegian IT grid draws sqrt(3) * 230 W/A, which the
three-phase preset does not model.

`test/e2e/goeChargerSdkE2E.test.ts` drives PELS against the shipped switch,
poll and card:

- a stop under pressure through `is_allowed`, then a start when there is
  room;
- whole-amp reductions through `change_current` with an API key.
