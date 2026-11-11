# NIBE myUplink compatibility

`lib/device/nibe/` owns the official NIBE myUplink app (`com.nibe.myuplink`,
drivers `heatpump` and `s-series`). Checked against the live 1.9.2 package.

Both drivers keep the room setpoint in `target_temperature.room` and the room
reading in `measure_temperature.room`; neither declares a plain
`target_temperature` / `measure_temperature` pair.

- **F-series (`heatpump`)**: `target_temperature.room` is parameter 47398
  (room sensor setpoint, climate system 1), or 47015 on an F730, which the app
  picks from what the pump reports. A write queues a myUplink parameter update
  and publishes the value only after it succeeds; a failure on both parameters
  throws, so the write reports as failed. `measure_temperature.room` is
  parameter 40033, the BT50 room sensor. The app adds each capability the
  first time myUplink returns its parameter (`fetchAndSetDataPoints`). The
  pump uses the setpoint through its room sensor, so a pump runs on its own
  heat curve when no BT50 is fitted.
- **S-series (`s-series`)**: both capabilities come from the first myUplink
  smart-home zone that is not command-only. A write sets every controllable
  zone to the value and publishes it. A failed write is logged and the app
  republishes the zone's setpoint on its next refresh rather than throwing,
  so PELS sees the failure as the pump's own report of the old value. The app
  removes both capabilities when the system has no controllable zone.

The adapter accepts a read that declares both room capabilities and no plain
pair as `target_temperature` / `measure_temperature` (`projectRead`, one view,
applied at the read contract before validation, so merges, the accepted read
and parsing see only the standard names), names live room reports the same way
(`routeReport`), and writes `target_temperature` back to
`target_temperature.room` (`capabilityWrite`). A pump without a room reading is
left as Homey reports it, and PELS does not treat it as a temperature device.

The app declares no range for `target_temperature.room`, so PELS reads Homey's
default target range.

`test/integration/nibeMyUplinkRoomSetpoint.test.ts` covers both drivers, live
reports, the write and its echo, and a full read Homey dated before PELS's write.
