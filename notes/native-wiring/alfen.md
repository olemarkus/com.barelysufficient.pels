# Alfen compatibility

Two Homey apps drive Alfen chargers. Each has its own adapter, and everything
Alfen-specific stays inside it.

## Official app (`com.alfen`, `chargepoint` driver)

`lib/device/alfen/` owns it. Checked against the live 2.1.1 package.

The app's `target_power` is the charger's OCPP external charging limit
(`ChargingStationExternalConstraints`). A write is converted to amps per phase
as `round(round(W / 230, 0.1) / phases, 0.1)` and sent to the station. The next
read publishes `ampsPerPhase × phases × 230` back. The app reads the phase
count from `measure_voltage.l2` and `measure_voltage.l3`: either one above 50 V
means three phases.

The app declares `target_power` on every station as
`{ min: 0, max: limit × phases × 230, step: 230, excludeMin: 0, excludeMax: 1380 }`.
On three phases a 230 W step is a third of an amp, and the 1380 W floor is 2 A
per phase, which no car charges at. The adapter's `overlay` rebuilds the ladder
in the station's own whole amps: steps of `phases × 230` W from 6 A to at most
32 A, bounded by the declared maximum. It uses the same phase rule as the app.

The app's `evcharger_charging` is not a switch. Writing it replaces the same
limit: `true` sets the station maximum (32 A), `false` sets 0 W. The app
publishes it as "is charging now", which a full car or a car waiting to start
never is. So PELS neither writes nor reads it:

- **on** writes the ladder's lowest charging level (6 A per phase). PELS sets
  its planned level from there with ordinary step commands.
- **off** writes 0 W.
- The switch is read from the limit: on at 6 A per phase or more. On a full
  read it is dated by the limit (`finalizeObservation`). Realtime limit reports
  carry the switch they imply, and the app's own switch events are dropped
  (`normalize`).

The app refreshes the device after every write, so Homey's echo of PELS's
write confirms the command within seconds.

`test/e2e/alfenChargerSdkE2E.test.ts` drives PELS against this app's shipped
behaviour on one and three phases. It covers:

- the ladder;
- whole-amp reductions;
- a pause and a resume that never use the app's full-power switch;
- a stopped session started at a safe current;
- a stopped session kept off when 6 A does not fit.

Without the adapter, PELS steps a three-phase station in thirds of an amp and
starts it at 32 A through the app's switch.

## Community Pro-line/ACE app (`Alfen.ProlineSingle`, `alfen-ace` driver)

`lib/device/alfenProline/` owns it. Checked against the live 1.3.7 package. It
is a Modbus TCP driver for Pro-line and ACE stations.

`max_current` is the socket's Modbus charging current (register 1210), in
whole amps from 1 A to the cable limit setting. The app:

- writes it and reads it back;
- lifts its own pause on any write;
- rewrites the last written current every 30 s, so the charger's 60 s setpoint
  validity never lapses;
- clamps that keep-alive to at least 6 A while not paused.

The app's `evcharger_charging = false` pauses the charger at 5 A, held by the
same keep-alive. `true` restores the current from before the pause, which may
be more than the house affords by then. The app publishes the switch as
"charging now" (Mode 3 `C2`/`D2`).

The adapter is built with `createCurrentSwitchChargerAdapter`
(`lib/device/currentSwitchCharger.ts`):

- `max_current` is a native current control, and Automatic builds whole-amp
  levels from 6 A to the declared maximum.
- **on** writes 6 A, which also lifts the pause; it never uses the app's resume.
- **off** uses the app's pause.
- The switch is read from the current: on at 6 A or more.

Phases come from the charger's own phase register (`charge_phases`), else from
the `grid_phases` setting.

`test/e2e/alfenProlineChargerSdkE2E.test.ts` drives PELS against this app's
shipped pause, resume, keep-alive and read-back. It covers the ladder,
reductions, a pause followed by a safe resume (never the pre-pause current),
and staying paused when 6 A does not fit.
