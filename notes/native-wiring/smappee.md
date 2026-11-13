# Smappee EV Wall compatibility

`lib/device/smappee/` owns the Smappee app's EV Wall charger (`com.smappee`,
`ev-wall` driver, Smappee cloud and MQTT). Behaviour as of version 1.3.4.

**Identity.** The app files the EV Wall under Homey's `other` class. The
adapter gives it the charger identity, as Tesla's charging device gets one.

**Start and stop.** The app declares neither `evcharger_charging` nor
`evcharger_charging_state`. Its only control is the setable `charging_mode`
(`normal`, `smart`, `paused`). A write sends the connector's mode to the
Smappee cloud and sets the capability once the cloud accepts it; the
charger's MQTT charging state then publishes the mode again. The adapter
reads the switch as "the mode is not `paused`", so a session in Smappee's own
smart mode counts as running. A stop writes `paused` and a start writes
`normal`, standard charging. The app's own set is no observation of the
charger, so a switch write is not read back as written.

**Plug state.** The MQTT charging state publishes the IEC status as
`cable_connected` and `charging`:

- `cable_connected` false: `plugged_out`.
- `charging` true: `plugged_in_charging`.
- `charging_mode` `paused`: `plugged_in_paused`.
- Otherwise: `plugged_in`, a car that takes nothing.

A missing reading or an unknown mode leaves the state unread. The derived
state is dated by the newest reading it stands on.

**Charging current.** The app has no current capability and no current
card. PELS starts and stops this charger; it cannot step its current.

`test/e2e/smappeeEvWallSdkE2E.test.ts` drives PELS against a model of the app's mode
switch: a pause under pressure, then a resume in standard charging when there
is room.
