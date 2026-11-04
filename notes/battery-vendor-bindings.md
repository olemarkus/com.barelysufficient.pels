# Home battery vendor bindings

A home battery's **binding** says how PELS drives it through its Homey app. It
belongs to the battery's integration adapter (`DeviceAdapter.homeBatteryBinding`,
`lib/device/deviceAdapter.ts`); common code reads it and names no app. The
standard binding (`lib/device/homeBatteryBinding.ts`) is Homey's own: a
writable signed `target_power` (positive charges) taken over through
`target_power_mode` set to `homey`. A battery whose app follows Homey's
conventions needs no adapter.

A `capability` binding states:

- **claims**: the capabilities that hand the battery to Homey, in preference
  order, each with its Homey value and what a rejected write means
  (`unanswered`, or `app_refuses_control` for an app that refuses PELS in its
  current setup). The first one the battery declares setable with that value
  is its claim.
- **setpointSign**: `1` when a positive `target_power` charges, `-1` when the
  app reads it as discharge. PELS keeps its own sign (positive charges) above
  the transport. The declared range is flipped into it at parse
  (`resolveBatteryControlSurface`) and each setpoint back out at write
  (`toBatterySetpointCapabilityValue`). `measure_power` is Homey's sign
  (positive charging) in every app below, so it is never flipped and the
  executor's sign check compares like with like.
- **rangeDefaults**: the `target_power` edges for a driver that declares none.
- **zeroSetpointW**: what PELS writes for a 0 W setpoint, `0` unless the app
  reads an exact 0 as one of its own modes. A hand-back always writes an exact 0.

The transport resolves the control surface from the binding at parse
(`lib/device/transport/homeBatteryObservation.ts`) and the storage writes at
write time (`requestStoragePower`, `releaseStorageControl` in
`lib/device/transport/deviceWrites.ts`). Planner, executor and UI read only the
resolved `HomeBatteryControlSurface`, in PELS's sign.

## Batteries and their bindings

Read from the shipped app packages.

| Battery and Homey app | Binding | Adapter |
|---|---|---|
| Marstek Venus (`com.kaoh.marstek`), AlphaESS (`com.alphaess`), SOLARWATT (`com.solarwatt`), SolarEdge (`com.solaredge`, `battery_modbus`) | standard | none |
| Sessy (`nl.sessy`) | claim `control_strategy` = `POWER_STRATEGY_API`, rejection = `app_refuses_control`; range defaults -1800/+2200 W | `lib/device/sessy/` |
| Anker SOLIX (`com.anker.solix` 1.1.0, driver `battery`) | standard claim; `setpointSign` -1 | `lib/device/anker/` |
| Zinvolt (`com.zinvolt` 1.1.0, drivers `base`, `power`) | standard claim; `zeroSetpointW` 10 | `lib/device/zinvolt/` |

## What each adapter does and why

**Sessy.** Sessy declares no `target_power_mode`. Its `target_power` acts only
under the `POWER_STRATEGY_API` control strategy, and the app refuses to set a
strategy unless the battery uses its local login, so a rejected claim means its
app refuses control (the battery is watch-only for a while). Its driver
declares no range, so the edges are the app's own charge and discharge presets
rather than Homey's ±25 kW.

**Anker SOLIX.** The app's own `target_power` is titled "On-Grid Port Output
Power (+) / Grid-to-Battery Charge Power (-)" and goes unchanged into the
battery's setpoint register: positive discharges. Without the flip PELS would
discharge when it meant to charge, and the executor's sign check would
eventually mark the battery sign-inverted and stop driving it.

**Zinvolt.** The app maps an exact 0 W `target_power` onto its own `INACTIVE`
mode, and polls then report `target_power_mode` = `INACTIVE`, which PELS
reads as the owner taking the battery back. The binding writes the app's
smallest charge step, 10 W, for a 0 W hold, so `INACTIVE` keeps one meaning:
someone other than PELS chose it. Counting `INACTIVE` as engaged instead would
hide an owner who picks Inactive while PELS holds the battery, and would make
PELS refuse a battery left Inactive. The cost is a 10 W trickle charge during a
0 W hold.
