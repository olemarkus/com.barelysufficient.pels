# WARP compatibility

`lib/device/warp/` owns the WARP Charger app (`com.glumpf.warp`, local HTTP,
`wallbox` driver). Behaviour as of version 1.1.0.

**Start and stop.** A write to the app's `evcharger_charging` starts or stops
charging. The app publishes the switch as on only while current flows, so a
released session waiting for a full car reads off. Its
`evcharger_charging_state` tells these apart:

- `plugged_in` and `plugged_in_charging` are a session PELS lets run.
- `plugged_in_paused` is one that waits for its release.
- `plugged_in` with `alarm_generic` on is a charger in error with a car connected: the adapter reads its switch as off.

The adapter reads the switch from the state and drops the app's own switch
events. The charger keeps its external current limit across a stop, so the
planned current goes out before the switch (`current_before_start`).

**Charging current.** The app's `wb_set_current` card sets the charger's
external current limit (6-32 A). The app's poll, every 5 s by default,
publishes that limit on `warp_current_limit`, or as a string on the
`warp_current_limit_pick` picker. The owner chooses in the app which rows a
device shows, so either capability can be absent. The adapter offers the card
as built-in current control through the owner's Homey API key, scoped to this
charger, only while the device has one of the two, and reads an integer
6-32 A value from it as the charger's current, dated by the capability. The
app refuses the card for a read-only device, a locked control, or a charger
whose external control is off; the refusal fails the command.

The app reports the active phases only on a row hidden by default, so the
owner picks the EV phase model.

`test/e2e/warpChargerSdkE2E.test.ts` drives PELS against a model of the app's
poll, start, stop and card in two cases:

- a stop, then a confirmed start for a car that finished meanwhile;
- whole-amp reductions through `wb_set_current` with an API key.
