# amina compatibility

`lib/device/amina/` owns the amina app (`com.aminacharging`, `amina-s`
driver, Zigbee). Behaviour as of version 2.6.2.

**Start and stop.** The app declares neither `evcharger_charging` nor
`evcharger_charging_state`. Its `onoff` enables or disables charging, and the charger keeps its level
across a stop. The adapter reads and writes the switch on `onoff`, publishes
it as `evcharger_charging`, and sends the planned current before the switch
(`current_before_start`), so an old 32 A level cannot start the session.

**Plug state.** The charger's EV status arrives as separate booleans, at most
every 10 s. The adapter derives the plug state from them and the switch:

- `ev_connected` false: `plugged_out`.
- `power_delivered` true: `plugged_in_charging`.
- `onoff` false or `charging_paused` true: `plugged_in_paused`.
- Otherwise: `plugged_in`, a car that takes nothing.

A missing or malformed reading leaves the state unread. The derived state is
dated by the newest reading it stands on.

**Charging current.** The app has no current capability. Its app card
`set_charging_current` moves the charger's level (6 A to the charger's
maximum) and then saves the same value to the `maxCurrent` setting, which the
app also reads from the charger at startup. The adapter offers the card as
built-in current control through the owner's Homey API key, scoped to this
charger, like Futurehome and Wallbox. It reads `maxCurrent` as the charger's
current reading, dated by `settingCurrentLimitSession.ts`: the limit Homey
last sent and the charger accepted, not proof the car draws it.

**Phases.** The `singlePhase` setting reports a one-phase charger. Three
phases are not reported, because a Norwegian IT grid draws sqrt(3) * 230 W/A,
which the three-phase preset does not model. The per-phase currents
(`measure_current.phase_a` to `phase_c`) feed the charger's phase reading.

`test/e2e/aminaChargerSdkE2E.test.ts` drives PELS against a model of the app's switch,
status reports and card in two cases:

- a stop under pressure through `onoff`, then a start when there is room;
- whole-amp reductions through `set_charging_current` with an API key.
