# Smappee EV Wall compatibility

`lib/device/smappee/` owns the Smappee app's EV Wall charger (`com.smappee`,
`ev-wall` driver, Smappee cloud and MQTT). Behaviour as of version 1.3.4 and
version 1.4.1 (test channel); the adapter reads both generations.

| | 1.3.x | 1.4.x |
|---|---|---|
| Homey class | `other` | `evcharger` |
| Connector is charging now | custom `charging` | the app's own `evcharger_charging` |
| Plug state | none | the app's own `evcharger_charging_state`: `plugged_out`, `plugged_in`, `plugged_in_charging` |
| Control | setable `charging_mode` | setable `charging_mode` |
| Cable | `cable_connected` | `cable_connected` |

On 1.4.x the update removes `charging` from paired devices. The app updates
`evcharger_charging` with the charger's realtime state, and a write to it
does nothing. It never reports
`plugged_in_paused`. `dim` is the charger LED's brightness, not a charging
control. PELS writes neither `evcharger_charging` nor `dim`.

**Identity.** The adapter gives the EV Wall the charger identity on both
generations, as Tesla's charging device gets one.

**Start and stop.** The only control is the setable `charging_mode`
(`normal`, `smart`, `paused`). A write sends the connector's mode to the
Smappee cloud and sets the capability once the cloud accepts it; the
charger's MQTT charging state then publishes the mode again. The adapter
reads the switch as "the mode is not `paused`", so a session in Smappee's own
smart mode counts as running, and a car that has finished in `normal` stays
switched on. A stop writes `paused` and a start writes `normal`, standard
charging. The app's own set is no observation of the charger, so a switch
write is not read back as written.

On 1.4.x the app's own `evcharger_charging` and `evcharger_charging_state`
are never the switch or the plug state, on a full read, a device update or a
single capability report. The app's `evcharger_charging` is read only as the
connector reading below, and the app's plug state is replaced by the derived
one. With an unreadable mode the switch is unread on both generations.

**Plug state.** The connector reading is `charging` when the device has it,
otherwise the 1.4 app's `evcharger_charging`. With `cable_connected`:

- `cable_connected` false: `plugged_out`.
- Connector charging: `plugged_in_charging`.
- `charging_mode` `paused`: `plugged_in_paused`.
- Otherwise: `plugged_in`, a car that takes nothing.

A missing reading or an unknown mode leaves the state unread. The derived
state is dated by the newest reading it stands on. The adapted reading keeps
the connector reading under `charging`, so reading an already adapted reading
again gives the same state.

**Charging current.** The app has no current capability and no current
card. PELS starts and stops this charger; it cannot step its current.

`test/unit/smappeeEvWallCompatibility.test.ts` reads both capability sets,
including a realtime `evcharger_charging` false while the mode is `normal`.
`test/e2e/smappeeEvWallSdkE2E.test.ts` drives PELS against models of both
apps' mode switch: a pause under pressure, then a resume in standard charging
when there is room, and on 1.4.x a finished car that stays switched on.
